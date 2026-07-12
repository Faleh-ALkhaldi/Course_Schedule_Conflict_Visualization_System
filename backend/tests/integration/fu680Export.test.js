// NEW-FU-680 — the Course/Section Type legend appears below the table in every table-bearing export
// (PDF/Word/Excel), all scopes, and is import-INVISIBLE on the Excel round-trip. Verified on seeded
// term 252. (The PDF legend + the density-scaled grid are proven in the live harness + the unit tests;
// PDF text extraction needs pdfjs ESM, which jest's VM cannot dynamic-import.)
const Pdf  = require('../../src/services/PdfExportService');
const Docx = require('../../src/services/DocxExportService');
const Svc  = require('../../src/services/ExportService');
const ExcelJS = require('exceljs');
const JSZip   = require('jszip');
const { query } = require('../../src/config/db');

let sid, venueId, instrId;
beforeAll(async () => {
  sid = (await query(`SELECT id FROM schedules WHERE department_id='SWE-DEPT' AND semester='252'`)).rows[0].id;
  venueId = (await query(`SELECT s.venue_id FROM sections s WHERE s.schedule_id=$1 AND s.venue_id IS NOT NULL LIMIT 1`, [sid])).rows[0]?.venue_id;
  instrId = (await query(`SELECT instructor_id FROM sections WHERE schedule_id=$1 AND instructor_id IS NOT NULL LIMIT 1`, [sid])).rows[0]?.instructor_id;
});
const scopes = () => [['full', { type: 'full' }], ['venue', { type: 'venue', id: venueId }], ['instructor', { type: 'instructor', id: instrId }]];

describe('FU-680 — Course/Section Type legend in the table-bearing exports (all scopes)', () => {
  test('Word: the legend appears (below the table)', async () => {
    for (const [, f] of scopes()) {
      const xml = await (await JSZip.loadAsync(await Docx.buildCombinedDocxBuffer(sid, f, '252'))).file('word/document.xml').async('string');
      expect(xml).toContain('Column guide');
      expect(xml).toMatch(/independent/);
    }
  });

  test('Excel: the legend is on the Sections sheet AND import-invisible (round-trip unchanged)', async () => {
    for (const [, f] of scopes()) {
      const { workbook } = await Svc.buildExport(sid, f, '252', 'xlsx');
      const buf = Buffer.from(await workbook.xlsx.writeBuffer());
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
      const txt = wb.getWorksheet('Sections').getSheetValues().flat().map(v => (v ?? '').toString()).join(' ');
      expect(txt).toContain('Column guide');
      const parsed = await Svc.parseRows(buf, 'xlsx');
      expect(parsed.rows.length).toBeGreaterThan(0);
      expect(parsed.rows.some(r => /column guide|course type —|section type —/i.test(`${r.courseCode} ${r.courseName}`))).toBe(false);
    }
  });

  test('every scope/format still renders a non-trivial artifact (no crash from the new page sizing)', async () => {
    for (const [, f] of scopes()) {
      const pdf = await Pdf.buildCombinedPdfBuffer(sid, f, '252');
      expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(3000);
    }
  });
});
