// NEW-FU-682 — lab-course completeness, end to end:
//   • Fix A: a scoped (instructor/venue) export of a Has-Laboratory course now CARRIES the course's
//     complementary half (the Lab when the file holds the Lecture), so re-importing it rebuilds the
//     COMPLETE Lecture+Lab course — has_lab=true, no R-14 (missing lab) and no R-15 (credit coverage).
//   • Fix B: the conflict-fix engine COMPLETES an orphan Has-Laboratory course (a Lab with no Lecture)
//     by ADDING the missing Lecture in a conflict-free slot with a free prior-instructor + a free
//     lecture hall, instead of dropping the orphan. R-14 clears with zero new conflicts.
const request   = require('supertest');
const app       = require('../../src/app');
const exportSvc = require('../../src/services/ExportService');
const quickFix  = require('../../src/services/QuickFixService');
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

describe('FU-682 Fix A — a scoped export carries the complementary half so re-import is COMPLETE', () => {
  test('an instructor file whose Lab is taught by someone else carries that Lab → re-import has BOTH halves, 0 R-14/R-15', async () => {
    // An instructor in 252 who teaches the LECTURE of a has_lab course whose LAB is taught by someone else.
    const row = (await query(`
      SELECT se.instructor_id, c.course_code
        FROM sections se JOIN courses c ON c.id = se.course_id JOIN schedules s ON s.id = se.schedule_id
       WHERE s.semester='252' AND c.has_lab = true AND se.section_type='Lec' AND se.instructor_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM sections lb WHERE lb.schedule_id = se.schedule_id AND lb.course_id = se.course_id
                       AND lb.section_type='Lab' AND lb.instructor_id IS DISTINCT FROM se.instructor_id)
       LIMIT 1`)).rows[0];
    expect(row).toBeTruthy();
    const sid252 = (await query(`SELECT id FROM schedules WHERE department_id='SWE-DEPT' AND semester='252'`)).rows[0].id;

    const { workbook } = await exportSvc.buildExport(sid252, { type: 'instructor', id: row.instructor_id }, '252', 'xlsx');
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());

    // The exported workbook's Sections sheet carries the complementary Lab (flagged with the Note tag).
    const reparsed = await exportSvc.parseRows(buf, 'xlsx');
    const labRows = reparsed.rows.filter(r => r.courseCode === row.course_code && r.sectionType === 'Lab');
    expect(labRows.length).toBeGreaterThan(0);   // the Lab half rode along even though this instructor doesn't teach it

    await A(request(app).post(`${B}/terms`), tok).send({ code: '323', seedMode: 'blank' });
    const sid323 = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === '323').id;
    const imp = await A(request(app).post(`${B}/schedules/${sid323}/import`), tok).attach('file', buf, 'instr.xlsx');
    expect(imp.status).toBe(200);

    // The re-imported course is COMPLETE: a has_lab course with BOTH a Lecture and a Lab → no orphan.
    const types = (await query(`
      SELECT DISTINCT se.section_type FROM sections se JOIN courses c ON c.id = se.course_id
       WHERE se.schedule_id=$1 AND c.course_code=$2`, [sid323, row.course_code])).rows.map(r => r.section_type);
    expect(types).toEqual(expect.arrayContaining(['Lec', 'Lab']));
    const course = (await query(`SELECT has_lab FROM courses WHERE owner_semester='323' AND course_code=$1`, [row.course_code])).rows[0];
    expect(course.has_lab).toBe(true);
    const bad = (await query(`SELECT rule_id FROM conflicts WHERE schedule_id=$1 AND rule_id IN ('R-14','R-15') AND section_a_id IN (
      SELECT id FROM sections WHERE schedule_id=$1 AND course_id=(SELECT id FROM courses WHERE owner_semester='323' AND course_code=$2))`, [sid323, row.course_code])).rows;
    expect(bad.length).toBe(0);

    await wipe('323');
  });
});

describe('FU-682 Fix B — the fix engine COMPLETES an orphan lab course instead of dropping it', () => {
  test('an orphan Lab (no Lecture) is resolved by ADDING the missing Lecture, conflict-free', async () => {
    // A term with the seed catalog (courses/instructors/venues), wiped to a single orphan Lab.
    await A(request(app).post(`${B}/terms`), tok).send({ code: '321' });
    const sid = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === '321').id;
    await query(`DELETE FROM sections WHERE schedule_id=$1`, [sid]);

    const course = (await query(`SELECT id FROM courses WHERE owner_semester='321' AND has_lab=true AND credits=3 LIMIT 1`)).rows[0];
    const labV   = (await query(`SELECT id FROM venues WHERE owner_semester='321' AND type='Laboratory' LIMIT 1`)).rows[0];
    const hallV  = (await query(`SELECT id FROM venues WHERE owner_semester='321' AND type IN ('LectureHall','Multipurpose') LIMIT 1`)).rows[0];
    const instr  = (await query(`SELECT id FROM instructors WHERE owner_semester='321' AND is_dummy=false ORDER BY name LIMIT 1`)).rows[0];
    expect(course && labV && hallV && instr).toBeTruthy();
    // give the instructor office hours so the completed course raises no R-13.
    await query(`INSERT INTO office_hours (instructor_id, day, start_time, end_time)
                 SELECT $1,'Wednesday','09:00','10:00' WHERE NOT EXISTS (SELECT 1 FROM office_hours WHERE instructor_id=$1)`, [instr.id]);
    // the ORPHAN Lab — a has_lab course with a Lab but no Lecture.
    await query(`INSERT INTO sections (schedule_id, course_id, instructor_id, venue_id, section_number, day, start_time, end_time, section_type, gender)
                 VALUES ($1,$2,$3,$4,'50','Monday','10:00','11:50','Lab','M')`, [sid, course.id, instr.id, labV.id]);

    // PLAN: the preferred R-14 op is now add-complement-section (NOT a drop).
    const plan = await quickFix.plan(sid);
    const addOp = (plan.ops || []).find(o => o.type === 'add-complement-section');
    expect(addOp).toBeTruthy();
    expect(addOp.complement.sectionType).toBe('Lec');
    expect(addOp.complement.priorInstructor).toBe(true);     // the lab's instructor has taught the course
    expect(plan.ops.some(o => o.type === 'add-complement-section' && !o.lastResort)).toBe(true);

    // APPLY it → the course is completed and R-14 clears with no new conflict.
    await quickFix.apply(sid, [addOp]);
    const types = (await query(`SELECT DISTINCT section_type FROM sections WHERE schedule_id=$1 AND course_id=$2`, [sid, course.id])).rows.map(r => r.section_type);
    expect(types).toEqual(expect.arrayContaining(['Lec', 'Lab']));
    const r14 = (await query(`SELECT 1 FROM conflicts WHERE schedule_id=$1 AND rule_id='R-14'`, [sid])).rows;
    expect(r14.length).toBe(0);
    // the added Lecture is in a lecture hall with the prior instructor.
    const lec = (await query(`SELECT v.type, s.instructor_id FROM sections s JOIN venues v ON v.id=s.venue_id
                  WHERE s.schedule_id=$1 AND s.course_id=$2 AND s.section_type='Lec' LIMIT 1`, [sid, course.id])).rows[0];
    expect(['LectureHall', 'Multipurpose']).toContain(lec.type);
    expect(lec.instructor_id).toBe(instr.id);

    await wipe('321');
  });
});
