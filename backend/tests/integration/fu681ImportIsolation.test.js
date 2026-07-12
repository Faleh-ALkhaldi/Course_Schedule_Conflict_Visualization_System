// NEW-FU-681 — import isolation + lab-course conflict fixes:
//   • The entity list endpoints scope to the ACTIVE TERM (X-Active-Term header), so the sidebar no
//     longer leaks every term's owned copy of each instructor/venue (read as duplicates + leakage).
//   • Import preserves has_lab from the "Course Type" column, so a scoped / lecture-only import of a
//     has_lab course keeps has_lab=true → R-15 (credit coverage) is correct (lecture 100 min is fine,
//     the lab carries the 3rd credit) and R-14 (missing lab) no longer false-fires.
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

describe('FU-681 — entity lists are scoped to the active term (no cross-term leak)', () => {
  test('the instructor list with X-Active-Term shows only that term\'s instructors, once each', async () => {
    const all    = (await A(request(app).get(`${B}/instructors`), tok)).body;                          // no context → catalog (all terms)
    const scoped = (await A(request(app).get(`${B}/instructors`).set('X-Active-Term', '252'), tok)).body;
    expect(scoped.length).toBeLessThan(all.length);                 // the term's slice, not the whole catalog
    const names = scoped.map(i => i.name);
    expect(names.length).toBe(new Set(names).size);                 // NO duplicate names in the scoped list
  });

  test('the venue list with X-Active-Term is term-scoped (no per-term copies leaking in)', async () => {
    const all    = (await A(request(app).get(`${B}/venues`), tok)).body;
    const scoped = (await A(request(app).get(`${B}/venues`).set('X-Active-Term', '252'), tok)).body;
    expect(scoped.length).toBeLessThan(all.length);
    const names = scoped.map(v => v.name);
    expect(names.length).toBe(new Set(names).size);
  });
});

describe('FU-681 — a lecture-only has_lab import keeps has_lab and raises no false conflict', () => {
  test('import an instructor file whose has_lab course carries only its Lecture → has_lab=true, 0 R-14/R-15', async () => {
    // find a has_lab course in 252 and an instructor teaching ONLY its Lecture (the Lab is elsewhere)
    const row = (await query(`
      SELECT se.instructor_id, c.course_code
        FROM sections se JOIN courses c ON c.id = se.course_id JOIN schedules s ON s.id = se.schedule_id
       WHERE s.semester='252' AND c.has_lab = true AND se.section_type='Lec' AND se.instructor_id IS NOT NULL
         AND se.instructor_id NOT IN (
           SELECT se2.instructor_id FROM sections se2 WHERE se2.schedule_id = se.schedule_id
             AND se2.course_id = se.course_id AND se2.section_type='Lab' AND se2.instructor_id IS NOT NULL)
       LIMIT 1`)).rows[0];
    expect(row).toBeTruthy();                                       // the seed has such a case (e.g. SWE 206)
    const sid252 = (await query(`SELECT id FROM schedules WHERE department_id='SWE-DEPT' AND semester='252'`)).rows[0].id;

    // export that instructor's schedule (a scoped file: their Lecture of the has_lab course, no Lab row)
    const { workbook } = await exportSvc.buildExport(sid252, { type: 'instructor', id: row.instructor_id }, '252', 'xlsx');
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());

    await A(request(app).post(`${B}/terms`), tok).send({ code: '313', seedMode: 'blank' });
    const sid313 = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === '313').id;
    const imp = await A(request(app).post(`${B}/schedules/${sid313}/import`), tok).attach('file', buf, 'instr.xlsx');
    expect(imp.status).toBe(200);

    // has_lab preserved from the Course Type column even though the file carried no Lab section
    const course = (await query(`SELECT has_lab FROM courses WHERE owner_semester='313' AND course_code=$1`, [row.course_code])).rows[0];
    expect(course.has_lab).toBe(true);
    // and neither the coverage rule (R-15) nor the missing-lab rule (R-14) false-fires for it
    const bad = (await query(`SELECT rule_id FROM conflicts WHERE schedule_id=$1 AND rule_id IN ('R-14','R-15')`, [sid313])).rows;
    expect(bad.length).toBe(0);

    await wipe('313');
  });
});
