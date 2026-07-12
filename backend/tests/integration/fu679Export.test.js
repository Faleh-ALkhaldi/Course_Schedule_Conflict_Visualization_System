// NEW-FU-679 — export rendering fixes, verified on real seeded data (term 252).
//   Issue 1 (PDF table no mid-word break) + Issue 2 (PDF/PNG grid no truncation): the precise
//     rendering invariants are unit-tested in tests/unit/fu679ExportLayout.test.js (column widths +
//     fitCellText + pickCardFont); here we smoke that every scope/format renders end-to-end without
//     error and produces a non-trivial artifact. (PDF *text* extraction needs pdfjs ESM, which jest's
//     VM can't dynamic-import — it's proven in the live harness instead.)
//   Issue 3 (venue note rides with the office hours): asserted directly on the real Excel + Word output.
const Pdf  = require('../../src/services/PdfExportService');
const Docx = require('../../src/services/DocxExportService');
const Svc  = require('../../src/services/ExportService');
const ExcelJS = require('exceljs');
const JSZip   = require('jszip');
const { query } = require('../../src/config/db');

let sid, venueId, instrId;
beforeAll(async () => {
  sid = (await query(`SELECT id FROM schedules WHERE department_id='SWE-DEPT' AND semester='252'`)).rows[0].id;
  venueId = (await query(
    `SELECT s.venue_id FROM sections s
       JOIN office_hours oh ON oh.instructor_id = s.instructor_id
      WHERE s.schedule_id=$1 AND s.venue_id IS NOT NULL LIMIT 1`, [sid])).rows[0]?.venue_id;
  instrId = (await query(
    `SELECT instructor_id FROM sections WHERE schedule_id=$1 AND instructor_id IS NOT NULL LIMIT 1`, [sid])).rows[0]?.instructor_id;
});

const PNG_MAGIC = '89504e470d0a1a0a';

describe('FU-679 Issues 1+2 — every scope/format renders cleanly end-to-end', () => {
  test('all three scopes export a non-trivial PDF (table + grid pages) without error', async () => {
    for (const filter of [{ type: 'full' }, { type: 'venue', id: venueId }, { type: 'instructor', id: instrId }]) {
      const pdf = await Pdf.buildCombinedPdfBuffer(sid, filter, '252');
      expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(3000);
    }
  });
  // (The PNG export — buildGridPngBuffer — rasterizes this same grid PDF via pdfjs, whose ESM
  // dynamic-import jest's VM can't run; it is proven valid in the live verification harness.)
});

describe('FU-679 Issue 3 — venue note rides with the office hours', () => {
  test('Excel: note on the OfficeHours sheet above the header, Meta has none, re-import still parses OH', async () => {
    if (!venueId) throw new Error('no venue-with-OH found in 252 seed');
    const { workbook } = await Svc.buildExport(sid, { type: 'venue', id: venueId }, '252', 'xlsx');
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const oh = wb.getWorksheet('OfficeHours');
    expect((oh.getCell(1, 1).value ?? '').toString().toLowerCase()).toMatch(/venue|office hours/);
    let hdrRow = 0;
    for (let r = 1; r <= 8; r++) if ((oh.getCell(r, 1).value ?? '').toString().toLowerCase() === 'instructor') { hdrRow = r; break; }
    expect(hdrRow).toBeGreaterThanOrEqual(2);                       // header below the note
    const meta = wb.getWorksheet('Meta').getSheetValues().flat().map(v => (v ?? '').toString()).join(' ');
    expect(meta).not.toContain('expected, not an error');          // note no longer on Meta
    const parsed = await Svc.parseRows(buf, 'xlsx');                // round-trip: leading note didn't break import
    expect(parsed.officeHours.length).toBeGreaterThan(0);
    expect(parsed.scope).toBe('venue');
  });

  test('Word: note precedes the Office Hours heading with NO page break between them', async () => {
    if (!venueId) throw new Error('no venue-with-OH found in 252 seed');
    const buf = await Docx.buildCombinedDocxBuffer(sid, { type: 'venue', id: venueId }, '252');
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
    const noteIdx = xml.indexOf('Why this venue file');
    const ohIdx   = xml.indexOf('Office Hours');
    expect(noteIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeLessThan(ohIdx);
    expect(xml.slice(noteIdx, ohIdx)).not.toContain('w:type="page"');
  });
});
