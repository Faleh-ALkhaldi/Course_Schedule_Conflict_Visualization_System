// NEW-FU-671 (re-audit fixes), DB-backed (fresh test DB):
//   • "Fix and import" is robust: if the post-commit auto-fix fails, the import STILL stands
//     (HTTP 200, committed, conflicts reported as remaining) — it never masquerades as a rejected
//     import (the old non-atomic bug returned the fix's 4xx as if nothing changed).
//   • A PDF-wrapped academic level ("Sophomor e") round-trips to "Sophomore" (was silently
//     defaulting every wrapped row to "Freshman").
const request   = require('supertest');
const ExcelJS   = require('exceljs');
const app       = require('../../src/app');
const exportSvc = require('../../src/services/ExportService');
const quickFixSvc = require('../../src/services/QuickFixService');
const { query } = require('../../src/config/db');

const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HEADERS = ['Course Code', 'Course Name', 'Academic Level', 'Category', 'Credits', 'Course Type',
                 'Section #', 'Section Type', 'Gender', 'Days', 'Start Time', 'End Time',
                 'Duration (min)', 'Instructor', 'Venue', 'Venue Type'];

let tok;
beforeAll(async () => {
  tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token;
});
const schedules = async () => (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body;
const makeTerm  = async (code) => {
  await A(request(app).post(`${B}/terms`), tok).send({ code, seedMode: 'blank' });
  return (await schedules()).find(s => s.semester === code);
};

// A whole-term xlsx that contains a conflict: export a seeded term, point row 3 at row 2's
// instructor+day+time (an R-01 clash).
async function conflictingBuffer() {
  const src = (await schedules()).find(s => s.semester === '252');
  const { workbook } = await exportSvc.buildExport(src.id, { type: 'full' }, '252', 'xlsx');
  const ws = workbook.getWorksheet('Sections');
  const col = {}; ws.getRow(1).eachCell((c, n) => { col[String(c.value).trim()] = n; });
  const r2 = ws.getRow(2), r3 = ws.getRow(3);
  for (const h of ['Instructor', 'Days', 'Start Time', 'End Time']) r3.getCell(col[h]).value = r2.getCell(col[h]).value;
  r3.commit();
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('FU-671 — re-audit fixes', () => {
  test('fix-and-import DEGRADES gracefully when the auto-fix fails (import stands, not a misleading reject)', async () => {
    const buf = await conflictingBuffer();
    const tgt = await makeTerm('311');
    // Force the post-commit resolver to fail (e.g. a concurrent finalize / weighted-gate 409).
    const spy = jest.spyOn(quickFixSvc, 'apply').mockRejectedValue(Object.assign(new Error('boom'), { status: 409 }));
    try {
      const r = await A(request(app).post(`${B}/schedules/${tgt.id}/import?mode=conflict-free`), tok)
        .attach('file', buf, { filename: 's.xlsx', contentType: XLSX_MIME });
      expect(r.status).toBe(200);                       // the IMPORT succeeded — NOT a 409
      expect(r.body.created).toBeGreaterThan(0);        // …and committed
      expect(r.body.fix?.failed).toBe(true);            // …with an honest "fix could not run" report
      expect((r.body.conflicts?.conflicts || []).length).toBeGreaterThan(0);   // conflicts remain
    } finally { spy.mockRestore(); }
    // the term really was replaced (committed), so it holds the imported sections
    const secs = (await query(`SELECT COUNT(*)::int c FROM sections WHERE schedule_id=$1`, [tgt.id])).rows[0].c;
    expect(secs).toBeGreaterThan(0);
  });

  test('a PDF-wrapped academic level "Sophomor e" round-trips to "Sophomore" (not silently "Freshman")', async () => {
    // Inject the PDF-wrapped form into a REAL (known) Sophomore course of a seeded term, so the
    // known-code leniency skips the name/level gate and the downstream level matcher is exercised.
    const src = (await schedules()).find(s => s.semester === '252');
    const { workbook } = await exportSvc.buildExport(src.id, { type: 'full' }, '252', 'xlsx');
    const ws = workbook.getWorksheet('Sections');
    const col = {}; ws.getRow(1).eachCell((c, n) => { col[String(c.value).trim()] = n; });
    let targetCode = null;
    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      if (String(row.getCell(col['Academic Level']).value ?? '').trim() === 'Sophomore') {
        row.getCell(col['Academic Level']).value = 'Sophomor e';   // the char-wrapped form
        targetCode = String(row.getCell(col['Course Code']).value).trim();
        row.commit();
      }
    }
    expect(targetCode).toBeTruthy();   // the seed term has a Sophomore course

    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    const tgt = await makeTerm('312');
    const r = await A(request(app).post(`${B}/schedules/${tgt.id}/import?mode=with-conflicts`), tok)
      .attach('file', buf, { filename: 's.xlsx', contentType: XLSX_MIME });
    expect(r.status).toBe(200);   // imported (known codes ⇒ no false rejection on the wrapped level)

    const lvl = (await query(`SELECT academic_level FROM courses WHERE owner_semester='312' AND course_code=$1`, [targetCode])).rows[0].academic_level;
    expect(lvl).toBe('Sophomore');   // the matcher collapsed "Sophomor e" → "Sophomore"
  });
});
