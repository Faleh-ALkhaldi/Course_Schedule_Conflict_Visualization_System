// NEW-FU-690 — info-only sections (Thesis / Research / untimed Project / Summer Training / Internship)
// carry NO day and NO time. They must still round-trip losslessly through export → import: the parser
// keeps a course+section row even with a blank day/time, the field gate does not demand a time for a
// time-optional row, and the commit persists a single NULL-day section. (Before FU-690 these rows were
// dropped on re-import.) Also guards: the export legend rows are NOT mis-parsed as data.
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
const sidFor = async (code) => (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === code).id;

describe('FU-690 — info-only sections round-trip losslessly through export → import', () => {
  const SRC = '321', DST = '322';
  beforeAll(async () => { await wipe(SRC); await wipe(DST); });
  afterAll(async () => { await wipe(SRC); await wipe(DST); });

  test('an untimed UG Thesis section survives export→import with is_thesis + NULL day/time intact', async () => {
    for (const T of [SRC, DST]) await A(request(app).post(`${B}/terms`), tok).send({ code: T });
    const sidS = await sidFor(SRC);
    await query(`DELETE FROM sections WHERE schedule_id=$1`, [sidS]);

    // A UG Thesis course + an UNTIMED, info-only section (no day/time), with a supervising instructor.
    await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SRC)
      .send({ courseCode: 'SWE 494', name: 'Undergraduate Thesis I', credits: 3, academicLevel: 'Senior', category: 'UG', numSections: 1, isThesis: true });
    const ths = (await query(`SELECT id FROM courses WHERE owner_semester=$1 AND course_code='SWE 494'`, [SRC])).rows[0];
    const instr = (await query(`INSERT INTO instructors (name,email,is_dummy,owner_semester) VALUES ('THESIS SUP','ths690@kfupm.test',false,$1) RETURNING id`, [SRC])).rows[0].id;
    const created = await A(request(app).post(`${B}/schedules/${sidS}/sections`), tok).set('X-Active-Term', SRC)
      .send({ courseId: ths.id, instructorId: instr, sectionNumber: '01', sectionType: 'Ths' });   // NO day/time
    expect(created.status).toBe(201);
    const stored = (await query(`SELECT day, start_time, end_time FROM sections WHERE course_id=$1`, [ths.id])).rows[0];
    expect(stored.day).toBeNull(); expect(stored.start_time).toBeNull(); expect(stored.end_time).toBeNull();

    // Export the term (xlsx), then re-import into a FRESH term.
    const { workbook } = await exportSvc.buildExport(sidS, { type: 'full' }, SRC, 'xlsx');
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());

    // The legend rows must NOT be parsed as data; the thesis row MUST be.
    const parsed = await exportSvc.parseRows(buf, 'xlsx');
    const t494 = parsed.rows.filter(r => r.courseCode === 'SWE 494');
    expect(t494.length).toBe(1);
    expect(t494[0].isThesis).toBe(true);
    expect(t494[0].days).toEqual([]);            // blank day round-tripped
    expect(parsed.rows.some(r => /Column guide|Course Type —/.test(r.courseCode))).toBe(false);  // legend not mis-parsed

    const sidD = await sidFor(DST);
    const imp = await A(request(app).post(`${B}/schedules/${sidD}/import?mode=with-conflicts`), tok).set('X-Active-Term', DST)
      .attach('file', buf, 'roundtrip.xlsx');
    expect(imp.status).toBe(200);
    expect(imp.body.created).toBeGreaterThan(0);

    // The thesis course + its info-only section now exist in DST with is_thesis + NULL day/time.
    const courseD = (await query(`SELECT id, is_thesis FROM courses WHERE owner_semester=$1 AND course_code='SWE 494'`, [DST])).rows[0];
    expect(courseD).toBeTruthy();
    expect(courseD.is_thesis).toBe(true);
    const secD = (await query(`SELECT day, start_time, end_time, section_type FROM sections WHERE course_id=$1`, [courseD.id])).rows;
    expect(secD.length).toBe(1);
    expect(secD[0].day).toBeNull();
    expect(secD[0].start_time).toBeNull();
    expect(secD[0].end_time).toBeNull();
    expect(secD[0].section_type).toBe('Ths');

    await wipe(SRC); await wipe(DST);
  });
});
