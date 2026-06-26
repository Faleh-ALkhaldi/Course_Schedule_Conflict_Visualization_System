// NEW-FU-672 (re-audit round 2) — adversarial unit tests for the gaps/hardening this pass closed.
// Each constructs the exact bypassing input; each FAILS against the pre-FU-672 code and passes now.
const JSZip   = require('jszip');
const ExcelJS = require('exceljs');
const { assertSafeUpload } = require('../../src/domain/uploadSafety');
const { instructorNameError } = require('../../src/domain/instructorFormat');
const { validateImportFields, venueNameError } = require('../../src/domain/importFieldValidation');
const { assertDocxStructureSafe } = require('../../src/services/ImportParserService');
const exportSvc = require('../../src/services/ExportService');

// Build a minimal valid OOXML package (DEFLATE) with the required structural parts.
async function ooxml(extra = {}, kind = 'docx') {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  z.file(kind === 'docx' ? 'word/document.xml' : 'xl/workbook.xml', '<?xml version="1.0"?><root/>');
  for (const [name, body] of Object.entries(extra)) z.file(name, body);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const findEOCD = (buf) => { for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i; return -1; };
const SECTION_HEADERS = ['Course Code','Course Name','Academic Level','Category','Credits','Course Type','Section #','Section Type','Gender','Days','Start Time','End Time','Duration (min)','Instructor','Venue','Venue Type'];
const oneRow = (over = {}) => ({ __row: 2, courseCode: 'SWE 211', courseName: 'X', academicLevel: 'Sophomore', category: 'UG', credits: 3, sectionNumber: '01', sectionType: 'Lec', gender: 'Male', days: ['Sunday'], startTime: '08:00', endTime: '08:50', instructorName: 'John Smith', venueName: '22-120', __raw: {}, ...over });

describe('FU-675 — jszip-based gate: the four historical CD divergences are closed by construction', () => {
  // The gate now inspects via jszip (mammoth/exceljs's own unzipper), so a structural game that
  // fooled the old hand-rolled CD walk (entry-count desync, prepend/`zero`, 0x7075 name override)
  // can no longer hide or rename a part: jszip resolves the REAL part set + names and the gate
  // catches the danger in THAT view. (assertSafeUpload is async now → await/.rejects.)
  const zlib = require('zlib');
  const storedZip = (entries) => {
    const L = [], C = []; let off = 0;
    for (const e of entries) {
      const nb = Buffer.from(e.name, 'utf8'); const d = e.data; const x = e.cdExtra || Buffer.alloc(0);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(zlib.crc32(d), 14); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(nb.length, 26);
      const lr = Buffer.concat([lh, nb, d]);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(zlib.crc32(d), 16); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt16LE(x.length, 30); ch.writeUInt32LE(off, 42);
      C.push(Buffer.concat([ch, nb, x])); L.push(lr); off += lr.length;
    }
    const cd = Buffer.concat(C); const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(entries.length, 8); eo.writeUInt16LE(entries.length, 10); eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(off, 16);
    return Buffer.concat([...L, cd, eo]);
  };
  const up7075 = (headerName, override) => {   // CRC matches the header name → jszip HONORS the override (the real attack)
    const c = Buffer.alloc(4); c.writeUInt32LE(zlib.crc32(Buffer.from(headerName, 'utf8')), 0);
    const un = Buffer.from(override, 'utf8'); const d = Buffer.concat([Buffer.from([1]), c, un]);
    const r = Buffer.alloc(4); r.writeUInt16LE(0x7075, 0); r.writeUInt16LE(d.length, 2); return Buffer.concat([r, d]);
  };

  test('a valid OOXML package passes', async () => {
    await expect(assertSafeUpload(await ooxml(), 'docx')).resolves.toBeDefined();
  });
  test('0x7075 name-override (FU-674 vector): jszip resolves decoy→vbaProject.bin, gate catches it', async () => {
    const evil = storedZip([
      { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>') },
      { name: 'word/decoy.xml', data: Buffer.from('<?xml version="1.0"?><x/>'), cdExtra: up7075('word/decoy.xml', 'word/vbaProject.bin') },
    ]);
    await expect(assertSafeUpload(evil, 'docx')).rejects.toThrow(/macros|active content|unsafe/i);
  });
  test('count-desync (FU-672 vector) can no longer hide a macro part from jszip enumeration', async () => {
    const buf = Buffer.from(await ooxml({ 'word/vbaProject.bin': 'MZ' }));
    const eocd = findEOCD(buf);
    buf.writeUInt16LE(Math.max(0, buf.readUInt16LE(eocd + 10) - 1), eocd + 10);   // under-count to hide the macro from a count-walk
    buf.writeUInt16LE(Math.max(0, buf.readUInt16LE(eocd + 8) - 1), eocd + 8);
    await expect(assertSafeUpload(buf, 'docx')).rejects.toThrow(/macros|active content|corrupt|unsafe/i);
  });
  test('a DTD/<!ENTITY part past 1 MB of incompressible filler is rejected (whole-part scan)', async () => {
    const filler = '<!--' + require('crypto').randomBytes(900 * 1024).toString('base64') + '-->';
    const late = '<?xml version="1.0"?>' + filler + '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r/>';
    const buf = await ooxml({ 'xl/late.xml': late }, 'xlsx');
    await expect(assertSafeUpload(buf, 'xlsx')).rejects.toThrow(/document-type|entity/i);
  });
});

describe('FU-672 #3 — consecutive-whitespace names forge look-alike duplicates', () => {
  test('instructorNameError rejects "John  Smith" (double space) but accepts "John Smith"', () => {
    expect(instructorNameError('John  Smith')).toMatch(/consecutive/i);
    expect(instructorNameError('John Smith')).toBeNull();
    expect(instructorNameError("Mary-Jane O'Neil")).toBeNull();   // legitimate punctuation still fine
  });
  test('venueNameError rejects "22  120" but accepts "22 120"', () => {
    expect(venueNameError('22  120')).toMatch(/consecutive/i);
    expect(venueNameError('22 120')).toBeNull();
  });
  test('the field gate rejects a double-space instructor or venue on a section row', () => {
    expect(validateImportFields({ rows: [oneRow({ instructorName: 'John  Smith' })] }).errors.some(e => /consecutive/i.test(e))).toBe(true);
    expect(validateImportFields({ rows: [oneRow({ venueName: '22  120' })] }).errors.some(e => /consecutive/i.test(e))).toBe(true);
    expect(validateImportFields({ rows: [oneRow()] }).errors).toEqual([]);   // clean row passes
  });
});

describe('FU-672 hardening — <td>/<th> balance in assertDocxStructureSafe', () => {
  test('an unbalanced run of <td> openers is rejected', () => {
    expect(() => assertDocxStructureSafe('<table><tr>' + '<td>'.repeat(5000) + '</tr></table>')).toThrow(/malformed/i);
  });
  test('balanced cells parse fine', () => {
    expect(assertDocxStructureSafe('<table><tr><td>a</td><td>b</td></tr></table>')).toBe(1);
  });
});

describe('FU-672 hardening — formula cells read as their result, not "[object Object]"', () => {
  test('a formula course-code cell parses to its computed result', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sections');
    ws.addRow(SECTION_HEADERS);
    const row = ws.addRow(['PLACEHOLDER', 'Software Eng', 'Sophomore', 'Undergraduate', 3, 'Standard', '01', 'Lecture', 'Male', 'Sunday, Tuesday, Thursday', '08:00', '08:50', 50, 'JOHN SMITH', '99-001', 'Lecture Hall']);
    row.getCell(1).value = { formula: 'CONCATENATE("SWE"," 211")', result: 'SWE 211' };
    const parsed = await exportSvc.parseRows(Buffer.from(await wb.xlsx.writeBuffer()), 'xlsx');
    expect(parsed.rows[0].courseCode).toBe('SWE 211');
  });
});

describe('FU-672 hardening — scope marker fails SAFE on an unrecognized value', () => {
  const metaWb = (scopeVal) => {
    const w = new ExcelJS.Workbook();
    const s = w.addWorksheet('Sections'); s.addRow(['Course Code', 'Section #', 'Days', 'Start Time', 'End Time']); s.addRow(['SWE 211', '01', 'Sunday', '08:00', '08:50']);
    const m = w.addWorksheet('Meta'); m.addRow(['Field', 'Value']); m.addRow(['Scope', scopeVal]);
    return w;
  };
  test('a recognized scope is honored (full / instructor / venue)', async () => {
    for (const v of ['full', 'instructor', 'venue']) {
      const parsed = await exportSvc.parseRows(Buffer.from(await metaWb(v).xlsx.writeBuffer()), 'xlsx');
      expect(parsed.scope).toBe(v);
    }
  });
  test('a present-but-garbage scope value is REJECTED (not silently coerced to destructive "full")', async () => {
    const buf = Buffer.from(await metaWb('XYZ_TAMPERED').xlsx.writeBuffer());
    await expect(exportSvc.parseRows(buf, 'xlsx')).rejects.toThrow(/scope marker is unrecognized/i);
  });
});

describe('FU-672 hardening — reference-sheet & Meta cells read as their scalar (consistency w/ Sections path)', () => {
  // exceljs returns computed/styled cells as OBJECTS: a formula is {formula,result}, a hyperlink is
  // {text,hyperlink}, rich text is {richText:[…]}. `.toString()` on any of those yields "[object Object]".
  // The Sections path already unwraps via cellScalar(); the Instructors/Venues/OfficeHours/Meta parsers
  // now do too. Each cell below is built in a shape exceljs preserves across writeBuffer→read so the
  // assertion FAILS against the pre-fix `.toString()` read and PASSES now.

  test('formula instructor/venue/OH-instructor names, a hyperlink email, and a formula capacity read as their scalar — not "[object Object]"', async () => {
    const w = new ExcelJS.Workbook();
    // Sections sheet is required for the parse; keep it minimal & plain (no Meta → scope defaults to 'full').
    const s = w.addWorksheet('Sections');
    s.addRow(['Course Code', 'Section #', 'Days', 'Start Time', 'End Time']);
    s.addRow(['SWE 211', '01', 'Sunday', '08:00', '08:50']);

    const ins = w.addWorksheet('Instructors');
    ins.addRow(['Instructor', 'Email']);
    const insRow = ins.addRow(['PLACEHOLDER', 'PLACEHOLDER']);
    insRow.getCell(1).value = { formula: 'UPPER("jane doe")', result: 'JANE DOE' };                 // formula → result
    insRow.getCell(2).value = { text: 'jane@kfupm.edu.sa', hyperlink: 'mailto:jane@kfupm.edu.sa' };  // mailto hyperlink → text

    const ven = w.addWorksheet('Venues');
    ven.addRow(['Venue', 'Type', 'Capacity']);
    const venRow = ven.addRow(['PLACEHOLDER', 'Lecture Hall', 0]);
    venRow.getCell(1).value = { formula: 'CONCATENATE("99","-001")', result: '99-001' };   // formula → result
    venRow.getCell(3).value = { formula: '20+10', result: 30 };                            // formula capacity → 30 (was NaN→null)

    const oh = w.addWorksheet('OfficeHours');
    oh.addRow(['Instructor', 'Day', 'Start Time', 'End Time']);
    const ohRow = oh.addRow(['PLACEHOLDER', 'Sunday', '10:00', '11:00']);
    ohRow.getCell(1).value = { formula: 'UPPER("jane doe")', result: 'JANE DOE' };   // formula → result

    const parsed = await exportSvc.parseRows(Buffer.from(await w.xlsx.writeBuffer()), 'xlsx');
    expect(parsed.instructors[0].name).toBe('JANE DOE');
    expect(parsed.instructors[0].email).toBe('jane@kfupm.edu.sa');
    expect(parsed.venues[0].name).toBe('99-001');
    expect(parsed.venues[0].capacity).toBe(30);
    expect(parsed.officeHours[0].instructorName).toBe('JANE DOE');
  });

  test('a rich-text Meta Scope rendering as "full" is honored, not rejected as unrecognized', async () => {
    const w = new ExcelJS.Workbook();
    const s = w.addWorksheet('Sections');
    s.addRow(['Course Code', 'Section #', 'Days', 'Start Time', 'End Time']);
    s.addRow(['SWE 211', '01', 'Sunday', '08:00', '08:50']);
    const m = w.addWorksheet('Meta');
    m.addRow(['Field', 'Value']);
    const mRow = m.addRow(['Scope', 'PLACEHOLDER']);
    mRow.getCell(2).value = { richText: [{ text: 'fu' }, { text: 'll' }] };   // multi-run rich text → 'full' (stays richText across round-trip)
    const parsed = await exportSvc.parseRows(Buffer.from(await w.xlsx.writeBuffer()), 'xlsx');
    expect(parsed.scope).toBe('full');
  });
});

describe('FU-674 — case-insensitive worksheet lookup (no silent data loss)', () => {
  test('a worksheet renamed to a different case ("officehours") is still read — no silent data loss', async () => {
    const w = new ExcelJS.Workbook();
    const s = w.addWorksheet('Sections'); s.addRow(['Course Code', 'Section #', 'Days', 'Start Time', 'End Time', 'Instructor']); s.addRow(['SWE 211', '01', 'Sunday', '08:00', '08:50', 'JOHN SMITH']);
    const oh = w.addWorksheet('officehours'); oh.addRow(['Instructor', 'Day', 'Start Time', 'End Time']); oh.addRow(['JOHN SMITH', 'Monday', '10:00', '11:00']);
    const parsed = await exportSvc.parseRows(Buffer.from(await w.xlsx.writeBuffer()), 'xlsx');
    expect(parsed.officeHours.length).toBe(1);   // pre-FU-674 the case-variant sheet was skipped → 0 (OH silently dropped)
  });
});
