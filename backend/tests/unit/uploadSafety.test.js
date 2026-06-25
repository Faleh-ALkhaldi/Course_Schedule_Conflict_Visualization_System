/**
 * NEW-FU-662 — pre-parse upload safety gate: magic-byte verification, ZIP structure /
 * entry-count / size caps, macro (active-content) rejection, and the parse timeout.
 */
const JSZip = require('jszip');
const {
  assertSafeUpload, assertNoActiveContent, inspectZip,
  withParseTimeout, MAX_ZIP_ENTRIES,
} = require('../../src/domain/uploadSafety');

// Build a structurally-valid OOXML-ish zip (passes the structure check) with extra files.
async function ooxmlZip(extra = {}) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file('xl/workbook.xml', '<workbook/>');
  for (const [k, v] of Object.entries(extra)) z.file(k, v);
  return z.generateAsync({ type: 'nodebuffer' });
}
const expectReject = (fn) => { try { fn(); return null; } catch (e) { return e; } };

describe('uploadSafety (FU-662) — magic bytes / structure', () => {
  test('a structurally-valid xlsx zip is accepted', async () => {
    expect(assertSafeUpload(await ooxmlZip(), 'xlsx').kind).toBe('ooxml');
  });
  test('text renamed .xlsx is rejected (415)', () => {
    const e = expectReject(() => assertSafeUpload(Buffer.from('not a zip, just text'), 'xlsx'));
    expect(e).not.toBeNull(); expect(e.status).toBe(415);
  });
  test('empty file is rejected (400)', () => {
    expect(expectReject(() => assertSafeUpload(Buffer.alloc(0), 'xlsx')).status).toBe(400);
  });
  test('a ZIP signature with garbage body is rejected', () => {
    const buf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage'.repeat(4))]);
    expect(expectReject(() => assertSafeUpload(buf, 'xlsx'))).not.toBeNull();
  });
  test('a valid zip lacking OOXML parts is rejected', async () => {
    const z = new JSZip(); z.file('hello.txt', 'hi');
    const buf = await z.generateAsync({ type: 'nodebuffer' });
    expect(expectReject(() => assertSafeUpload(buf, 'xlsx'))).not.toBeNull();
  });
  test('an xlsx zip missing xl/ is rejected as not-a-workbook', async () => {
    const z = new JSZip(); z.file('[Content_Types].xml', '<x/>'); z.file('word/document.xml', '<x/>');
    const buf = await z.generateAsync({ type: 'nodebuffer' });
    const e = expectReject(() => assertSafeUpload(buf, 'xlsx'));
    expect(e.message).toMatch(/Excel workbook/);
  });
  test('PDF magic is required', () => {
    expect(assertSafeUpload(Buffer.from('%PDF-1.7\n...'), 'pdf').kind).toBe('pdf');
    expect(expectReject(() => assertSafeUpload(Buffer.from('GIF89a'), 'pdf')).status).toBe(415);
  });
});

describe('uploadSafety (FU-662) — macros & caps', () => {
  test('vbaProject.bin (macros) is rejected', () => {
    expect(expectReject(() => assertNoActiveContent(['[Content_Types].xml', 'xl/vbaProject.bin'])).status).toBe(400);
  });
  test('a clean part list passes', () => {
    expect(assertNoActiveContent(['[Content_Types].xml', 'xl/worksheets/sheet1.xml'])).toBeUndefined();
  });
  test('a macro-bearing OOXML zip is rejected end-to-end', async () => {
    const buf = await ooxmlZip({ 'xl/vbaProject.bin': 'MZ' });
    expect(expectReject(() => assertSafeUpload(buf, 'xlsx')).message).toMatch(/macros|active content/);
  });
  test('too many ZIP entries is rejected', async () => {
    const extra = {};
    for (let i = 0; i < MAX_ZIP_ENTRIES + 50; i++) extra['p' + i] = 'x';
    const buf = await ooxmlZip(extra);
    expect(expectReject(() => assertSafeUpload(buf, 'xlsx')).status).toBe(400);
  });
  test('a patched oversized uncompressed size (zip bomb) is rejected', async () => {
    const buf = await ooxmlZip();
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));   // first central-dir header
    expect(cd).toBeGreaterThan(0);
    buf.writeUInt32LE(0x7fffffff, cd + 24);   // uncompressed size → ~2 GB
    expect(expectReject(() => assertSafeUpload(buf, 'xlsx')).status).toBe(400);
  });
  test('inspectZip returns the part names of a real-shaped zip', async () => {
    const { names } = inspectZip(await ooxmlZip());
    expect(names).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml']));
  });
});

describe('uploadSafety (FU-662) — parse timeout', () => {
  test('a fast promise resolves through', async () => {
    await expect(withParseTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });
  test('a hung promise is rejected with status 400', async () => {
    const never = new Promise(() => {});
    await expect(withParseTimeout(never, 20)).rejects.toMatchObject({ status: 400 });
  });
});

// NEW-FU-663 — close the two residual risks: a size-LYING zip bomb (measured by real
// decompression, not the declared sizes) and XXE / entity-expansion (reject any DTD).
describe('uploadSafety (FU-663) — XXE / DTD guard', () => {
  async function xmlPartZip(partName, xml) {
    const z = new JSZip();
    z.file('[Content_Types].xml', partName === '[Content_Types].xml' ? xml : '<Types/>');
    z.file('xl/workbook.xml', '<workbook/>');
    if (partName !== '[Content_Types].xml') z.file(partName, xml);
    return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
  test('external-entity XXE (file://) is rejected', async () => {
    const buf = await xmlPartZip('[Content_Types].xml',
      '<?xml version="1.0"?><!DOCTYPE t [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Types>&xxe;</Types>');
    const e = expectReject(() => assertSafeUpload(buf, 'xlsx'));
    expect(e.status).toBe(400); expect(e.message).toMatch(/document-type|entity/i);
  });
  test('SSRF external entity (http://) is rejected', async () => {
    const buf = await xmlPartZip('xl/sharedStrings.xml',
      '<?xml version="1.0"?><!DOCTYPE t [<!ENTITY x SYSTEM "http://169.254.169.254/">]><sst>&x;</sst>');
    expect(expectReject(() => assertSafeUpload(buf, 'xlsx')).message).toMatch(/document-type|entity/i);
  });
  test('billion-laughs entity-expansion bomb is rejected', async () => {
    const dtd = '<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">';
    const buf = await xmlPartZip('[Content_Types].xml', `<?xml version="1.0"?><!DOCTYPE l [${dtd}]><Types>&b;</Types>`);
    expect(expectReject(() => assertSafeUpload(buf, 'xlsx'))).not.toBeNull();
  });
  test('a clean OOXML part (no DTD) passes', async () => {
    const buf = await xmlPartZip('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="x"/>');
    expect(assertSafeUpload(buf, 'xlsx').kind).toBe('ooxml');
  });
});

describe('uploadSafety (FU-663) — size-lying zip bomb (real decompression)', () => {
  // Build a DEFLATE part of N bytes of zeros (≈tiny compressed), then patch every declared
  // uncompressed-size DOWN to 500 so the cheap declared-size checks all pass.
  async function lyingBomb(realBytes) {
    const z = new JSZip();
    z.file('[Content_Types].xml', '<Types/>'); z.file('xl/workbook.xml', '<workbook/>');
    z.file('xl/bomb.xml', Buffer.alloc(realBytes));
    const buf = Buffer.from(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    let eocd = -1; for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    let n = buf.readUInt16LE(eocd + 10), off = buf.readUInt32LE(eocd + 16);
    for (let k = 0; k < n; k++) {
      const localOff = buf.readUInt32LE(off + 42);
      buf.writeUInt32LE(500, off + 24); buf.writeUInt32LE(500, localOff + 22);
      off += 46 + buf.readUInt16LE(off + 28) + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
    }
    return buf;
  }
  test('a bomb that declares 500 B but inflates to 65 MB is rejected by real decompression', async () => {
    const buf = await lyingBomb(65 * 1024 * 1024);
    expect(inspectZip(buf).total).toBeLessThan(10000);   // the declared check is fooled…
    const e = expectReject(() => assertSafeUpload(buf, 'xlsx'));
    expect(e.status).toBe(400); expect(e.message).toMatch(/zip bomb|too much/i);   // …but the deep inflate catches it
  });
});
