// NEW-FU-685 — the user imported a WHOLE-TERM file ("Import and fix the conflicts") and the result still
// showed 2 soft conflicts: "SWE 206 §01 only meets 100 min … needs 150" — even though SWE 206's Lab WAS
// imported alongside its lecture. That R-15 is a false positive (the lab carries the 3rd credit, so the
// 100-min lecture is correct); it arose because R-15 keyed off the has_lab FLAG only (FU-684 fixed the
// evaluator to also recognize a real Lab section). This guards the WHOLE-TERM import path end to end:
// a whole-term file whose has_lab course carries both its Lecture and its Lab re-imports COMPLETE, with
// has_lab preserved and NO false R-15 — so an "Import and fix the conflicts" run has nothing to fail on.
const request   = require('supertest');
const app       = require('../../src/app');
const exportSvc = require('../../src/services/ExportService');
const { query } = require('../../src/config/db');

const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);
let tok;
beforeAll(async () => { tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token; });
const wipe = async (code) => {
  await query(`DELETE FROM office_hours WHERE instructor_id IN (SELECT id FROM instructors WHERE owner_semester=$1)`, [code]);
  await query(`DELETE FROM schedules WHERE department_id='SWE-DEPT' AND semester=$1`, [code]);
  for (const t of ['courses', 'instructors', 'venues']) await query(`DELETE FROM ${t} WHERE owner_semester=$1`, [code]);
};

describe('FU-685 — whole-term import of a complete lab course raises no false R-15', () => {
  test('a whole-term file with a has_lab course (Lec + Lab) re-imports complete, has_lab kept, 0 R-15 on it', async () => {
    // A has_lab course in 252 that actually has BOTH a Lecture and a Lab scheduled.
    const row = (await query(`
      SELECT DISTINCT c.course_code
        FROM sections lec JOIN courses c ON c.id=lec.course_id JOIN schedules s ON s.id=lec.schedule_id
       WHERE s.semester='252' AND c.has_lab=true AND lec.section_type='Lec'
         AND EXISTS (SELECT 1 FROM sections lab WHERE lab.schedule_id=lec.schedule_id
                       AND lab.course_id=lec.course_id AND lab.section_type='Lab')
       LIMIT 1`)).rows[0];
    expect(row).toBeTruthy();
    const sid252 = (await query(`SELECT id FROM schedules WHERE department_id='SWE-DEPT' AND semester='252'`)).rows[0].id;

    // WHOLE-TERM export (scope=full → REPLACE on import).
    const { workbook } = await exportSvc.buildExport(sid252, { type: 'full' }, '252', 'xlsx');
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    const parsed = await exportSvc.parseRows(buf, 'xlsx');
    expect(parsed.scope).toBe('full');

    // Import (REPLACE) into a fresh blank term, committing as-is (mode=with-conflicts) — the whole-term
    // file carries 252's own pre-existing conflicts, which is fine; we only assert the lab course is
    // complete with NO false R-15 on it.
    await A(request(app).post(`${B}/terms`), tok).send({ code: '341', seedMode: 'blank' });
    const sid341 = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === '341').id;
    const imp = await A(request(app).post(`${B}/schedules/${sid341}/import?mode=with-conflicts`), tok).attach('file', buf, 'whole.xlsx');
    expect(imp.status).toBe(200);
    expect(imp.body.created).toBeGreaterThan(0);   // actually committed (not a preview/needsDecision)

    const course = (await query(`SELECT id, has_lab FROM courses WHERE owner_semester='341' AND course_code=$1`, [row.course_code])).rows[0];
    expect(course.has_lab).toBe(true);                               // has_lab preserved on the whole-term path
    const types = (await query(`SELECT DISTINCT section_type FROM sections WHERE schedule_id=$1 AND course_id=$2`, [sid341, course.id])).rows.map(r => r.section_type);
    expect(types).toEqual(expect.arrayContaining(['Lec', 'Lab']));   // complete

    // No false R-15 on this course's lecture (the lab is present → the 100-min lecture is correct).
    const r15 = (await A(request(app).get(`${B}/schedules/${sid341}/conflicts`), tok)).body.conflicts
      .filter(c => (c.ruleId || c.rule_id) === 'R-15')
      .filter(c => (c.description || '').includes(row.course_code));
    expect(r15.length).toBe(0);

    await wipe('341');
  });
});
