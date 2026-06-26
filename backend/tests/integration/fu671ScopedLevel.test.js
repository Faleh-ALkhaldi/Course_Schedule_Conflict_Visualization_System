// NEW-FU-671 (re-audit residual): the SCOPED / merge import path (ScopedImportService) carried a
// duplicate academic-level resolver that MISSED FU-671's whitespace fix — so a PDF-wrapped
// "Sophomor e" in an instructor-scoped file silently became "Freshman" on merge, even though the
// whole-term path had been fixed. Both paths now share resolveAcademicLevel (domain/courseFormat).
// This locks the scoped path end-to-end over HTTP against the fresh test DB.
const request   = require('supertest');
const app       = require('../../src/app');
const exportSvc = require('../../src/services/ExportService');
const { query } = require('../../src/config/db');

const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let tok;
beforeAll(async () => {
  tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token;
});
const schedules = async () => (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body;
const makeBlankTerm = async (code) => {
  await A(request(app).post(`${B}/terms`), tok).send({ code, seedMode: 'blank' });
  return (await schedules()).find((s) => s.semester === code);
};

describe('FU-671 — scoped (instructor) import resolves a PDF-wrapped academic level', () => {
  test('"Sophomor e" in an instructor-scoped file merges as "Sophomore" (not silently "Freshman")', async () => {
    const src = (await schedules()).find((s) => s.semester === '252');
    // An instructor in 252 who teaches a Sophomore course → their scoped export carries a Sophomore row.
    const pick = (await query(
      `SELECT s.instructor_id AS id, c.course_code AS code
         FROM sections s JOIN courses c ON c.id = s.course_id
        WHERE s.schedule_id = $1 AND c.academic_level = 'Sophomore' AND s.instructor_id IS NOT NULL
        LIMIT 1`, [src.id])).rows[0];
    expect(pick).toBeTruthy();   // seed term 252 has a Sophomore course taught by an instructor

    // Export that instructor's scoped file (Meta sheet ⇒ scope:'instructor' ⇒ routes to the merge path).
    const { workbook } = await exportSvc.buildExport(src.id, { type: 'instructor', id: pick.id }, '252', 'xlsx');
    const ws = workbook.getWorksheet('Sections');
    const col = {};
    ws.getRow(1).eachCell((c, n) => { col[String(c.value).trim()] = n; });
    let injected = false;
    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const isTarget = String(row.getCell(col['Course Code']).value).trim() === pick.code &&
                       String(row.getCell(col['Academic Level']).value ?? '').trim() === 'Sophomore';
      if (isTarget) { row.getCell(col['Academic Level']).value = 'Sophomor e'; row.commit(); injected = true; }
    }
    expect(injected).toBe(true);   // the char-wrapped form is now in the scoped file

    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    const tgt = await makeBlankTerm('341');
    const r = await A(request(app).post(`${B}/schedules/${tgt.id}/import`), tok)
      .attach('file', buf, { filename: 'instructor.xlsx', contentType: XLSX_MIME });
    expect(r.status).toBe(200);
    expect(r.body.needsDecision).toBeFalsy();   // blank target ⇒ conflict-free scoped merge commits

    const lvl = (await query(
      `SELECT academic_level FROM courses WHERE owner_semester = '341' AND course_code = $1`, [pick.code]
    )).rows[0]?.academic_level;
    expect(lvl).toBe('Sophomore');   // scoped path used the shared whitespace-tolerant resolver
  });
});
