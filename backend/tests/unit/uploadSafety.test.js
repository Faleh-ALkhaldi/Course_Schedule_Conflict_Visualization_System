/**
 * NEW-FU-662 / NEW-FU-675 — pre-parse upload safety gate. After FU-675 the OOXML inspection runs
 * via jszip (the parser's own unzipper) and assertSafeUpload is ASYNC, so every gate call is awaited
 * and rejections are asserted with `await expectReject(...)`.
 */
const JSZip = require('jszip');
const {
  assertSafeUpload, assertNoActiveContent, withParseTimeout,
  MAX_ZIP_ENTRIES, MAX_SINGLE_ENTRY,
} = require('../../src/domain/uploadSafety');

// Build a structurally-valid OOXML zip (passes the structure check) with extra files.
async function ooxmlZip(extra = {}, fmt = 'xlsx') {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file(fmt === 'docx' ? 'word/document.xml' : 'xl/workbook.xml', '<r/>');
  for (const [k, v] of Object.entries(extra)) z.file(k, v);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const expectReject = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

describe('uploadSafety — magic bytes / structure (via jszip)', () => {
  test('a structurally-valid xlsx zip is accepted', async () => {
    expect((await assertSafeUpload(await ooxmlZip(), 'xlsx')).kind).toBe('ooxml');
  });
  test('text renamed .xlsx is rejected (415)', async () => {
    const e = await expectReject(() => assertSafeUpload(Buffer.from('not a zip, just text'), 'xlsx'));
    expect(e).not.toBeNull(); expect(e.status).toBe(415);
  });
  test('empty file is rejected (400)', async () => {
    expect((await expectReject(() => assertSafeUpload(Buffer.alloc(0), 'xlsx'))).status).toBe(400);
  });
  test('a ZIP signature with garbage body is rejected', async () => {
    const buf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage'.repeat(4))]);
    expect(await expectReject(() => assertSafeUpload(buf, 'xlsx'))).not.toBeNull();
  });
  test('a valid zip lacking OOXML parts is rejected', async () => {
    const z = new JSZip(); z.file('hello.txt', 'hi');
    const buf = await z.generateAsync({ type: 'nodebuffer' });
    expect(await expectReject(() => assertSafeUpload(buf, 'xlsx'))).not.toBeNull();
  });
  test('an xlsx zip missing xl/ is rejected as not-a-workbook', async () => {
    const z = new JSZip(); z.file('[Content_Types].xml', '<x/>'); z.file('word/document.xml', '<x/>');
    const buf = await z.generateAsync({ type: 'nodebuffer' });
    expect((await expectReject(() => assertSafeUpload(buf, 'xlsx'))).message).toMatch(/Excel workbook/);
  });
  test('PDF magic is required', async () => {
    expect((await assertSafeUpload(Buffer.from('%PDF-1.7\n...'), 'pdf')).kind).toBe('pdf');
    expect((await expectReject(() => assertSafeUpload(Buffer.from('GIF89a'), 'pdf'))).status).toBe(415);
  });
});

describe('uploadSafety — macros & caps', () => {
  test('vbaProject.bin (macros) is rejected', () => {
    let err = null; try { assertNoActiveContent(['[Content_Types].xml', 'xl/vbaProject.bin']); } catch (e) { err = e; }
    expect(err.status).toBe(400);
  });
  test('a clean part list passes', () => {
    expect(assertNoActiveContent(['[Content_Types].xml', 'xl/worksheets/sheet1.xml'])).toBeUndefined();
  });
  test('a macro-bearing OOXML zip is rejected end-to-end', async () => {
    const buf = await ooxmlZip({ 'xl/vbaProject.bin': 'MZ' });
    expect((await expectReject(() => assertSafeUpload(buf, 'xlsx'))).message).toMatch(/macros|active content/);
  });
  test('too many ZIP entries is rejected', async () => {
    const extra = {};
    for (let i = 0; i < MAX_ZIP_ENTRIES + 50; i++) extra['p' + i] = 'x';
    const buf = await ooxmlZip(extra);
    expect((await expectReject(() => assertSafeUpload(buf, 'xlsx'))).status).toBe(400);
  });
});

describe('uploadSafety — parse timeout', () => {
  test('a fast promise resolves through', async () => {
    await expect(withParseTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });
  test('a hung promise is rejected with status 400', async () => {
    const never = new Promise(() => {});
    await expect(withParseTimeout(never, 20)).rejects.toMatchObject({ status: 400 });
  });
});

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
    const e = await expectReject(() => assertSafeUpload(buf, 'xlsx'));
    expect(e.status).toBe(400); expect(e.message).toMatch(/document-type|entity/i);
  });
  test('SSRF external entity (http://) is rejected', async () => {
    const buf = await xmlPartZip('xl/sharedStrings.xml',
      '<?xml version="1.0"?><!DOCTYPE t [<!ENTITY x SYSTEM "http://169.254.169.254/">]><sst>&x;</sst>');
    expect((await expectReject(() => assertSafeUpload(buf, 'xlsx'))).message).toMatch(/document-type|entity/i);
  });
  test('billion-laughs entity-expansion bomb is rejected', async () => {
    const dtd = '<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">';
    const buf = await xmlPartZip('[Content_Types].xml', `<?xml version="1.0"?><!DOCTYPE l [${dtd}]><Types>&b;</Types>`);
    expect(await expectReject(() => assertSafeUpload(buf, 'xlsx'))).not.toBeNull();
  });
  test('a DTD past 1 MB of incompressible filler is still rejected (whole-part scan)', async () => {
    const filler = '<!--' + require('crypto').randomBytes(900 * 1024).toString('base64') + '-->';
    const xml = '<?xml version="1.0"?>' + filler + '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r/>';
    const buf = await xmlPartZip('xl/late.xml', xml);
    expect((await expectReject(() => assertSafeUpload(buf, 'xlsx'))).message).toMatch(/document-type|entity/i);
  });
  test('a clean OOXML part (no DTD) passes', async () => {
    const buf = await xmlPartZip('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="x"/>');
    expect((await assertSafeUpload(buf, 'xlsx')).kind).toBe('ooxml');
  });
});

describe('uploadSafety (FU-663/675) — size-lying zip bomb, measured by bounded inflate', () => {
  test('a part that inflates to 65 MB is rejected at the per-part cap, fast (bounded streaming inflate)', async () => {
    const buf = await ooxmlZip({ 'xl/bomb.xml': Buffer.alloc(65 * 1024 * 1024, 0x41) });
    const t0 = Date.now();
    const e = await expectReject(() => assertSafeUpload(buf, 'xlsx'));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/oversized|too much|zip bomb/i);
    // The streaming inflate ABORTS at the 25 MB cap rather than inflating the whole part, so this
    // returns quickly. (Peak-memory boundedness is verified separately against a 300 MB bomb in the
    // FU-675 feasibility harness — peak RSS stayed ≈ baseline + a couple MB.)
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
