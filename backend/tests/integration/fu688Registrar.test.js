// NEW-FU-688/689 (Phase 126) — the registrar Activity flag set, end to end:
//   • Thesis (THS) + Research (RES): siblings — info-only (no time/place, no conflict). FU-689: allowed
//     at BOTH Undergraduate and Graduate level (the FU-688 GR-only gate was removed).
//   • Project (PRJ): MUST have an instructor; venue + time are OPTIONAL; NEVER raises a conflict —
//     an UNTIMED Project section is creatable (no day/start/end) and a timed one out of window is clean.
//   • Seminar (SEM): GRADUATE-only, a single-day block of EXACTLY 75 min (FU-689) — 50/100/160/multi-day/UG rejected.
//   • Summer Training / Internship (ST/INT): the SAME external course shows "Summer Training" in a
//     Summer term (code ends 3) and "Internship" otherwise — a term-derived label, no stored change.
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
const ensureCourse = async (term, courseCode, payload) => {
  const existing = (await query(`SELECT id FROM courses WHERE owner_semester=$1 AND course_code=$2`, [term, courseCode])).rows[0];
  if (existing) return existing;
  const res = await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', term).send(payload);
  expect(res.status).toBe(201);
  return (await query(`SELECT id FROM courses WHERE owner_semester=$1 AND course_code=$2`, [term, courseCode])).rows[0];
};

describe('FU-688 — registrar Activity flags, end to end', () => {
  const SUM = '333';   // Summer term (last digit 3) → external shows Summer Training
  const FALL = '331';  // Fall term            (last digit 1) → external shows Internship

  beforeAll(async () => { await wipe(SUM); await wipe(FALL); await wipe('332'); });
  afterAll(async () => { await wipe(SUM); await wipe(FALL); await wipe('332'); });

  test('seeded registrar info-only activities stay side-panel only and reject scheduled API payloads', async () => {
    const sid253 = await sidFor('253');
    const seededExternal = (await query(`
      SELECT c.id, c.is_external, s.day, s.start_time, s.end_time, s.venue_id, s.instructor_id, s.section_type
        FROM sections s
        JOIN courses c ON c.id = s.course_id
       WHERE s.schedule_id = $1
         AND c.course_code = 'SWE 399'
    `, [sid253])).rows;
    expect(seededExternal).toHaveLength(1);
    expect(seededExternal[0].is_external).toBe(true);
    expect(seededExternal[0].day).toBeNull();
    expect(seededExternal[0].start_time).toBeNull();
    expect(seededExternal[0].end_time).toBeNull();
    expect(seededExternal[0].venue_id).toBeNull();
    expect(seededExternal[0].instructor_id).toBeTruthy();

    const badExternal = await A(request(app).post(`${B}/schedules/${sid253}/sections`), tok)
      .send({
        courseId: seededExternal[0].id,
        instructorId: seededExternal[0].instructor_id,
        sectionNumber: '02',
        days: ['Sunday'],
        startTime: '08:00',
        endTime: '08:50',
      });
    expect(badExternal.status).toBe(400);
    expect(String(badExternal.body.error)).toMatch(/information-only/i);

    const thesis = (await query(`SELECT id, is_thesis FROM courses WHERE course_code = 'SWE 610' LIMIT 1`)).rows[0];
    expect(thesis).toBeTruthy();
    expect(thesis.is_thesis).toBe(true);
    const sid261 = await sidFor('261');
    const badThesis = await A(request(app).post(`${B}/schedules/${sid261}/sections`), tok)
      .send({
        courseId: thesis.id,
        sectionNumber: '01',
        days: ['Monday'],
        startTime: '17:20',
        endTime: '18:35',
      });
    expect(badThesis.status).toBe(400);
    expect(String(badThesis.body.error)).toMatch(/information-only/i);

    const scheduledInfoOnly = (await query(`
      SELECT COUNT(*)::int AS n
        FROM sections s
        JOIN courses c ON c.id = s.course_id
       WHERE (c.is_external OR c.is_thesis OR c.is_research)
         AND (s.day IS NOT NULL OR s.start_time IS NOT NULL OR s.end_time IS NOT NULL OR s.venue_id IS NOT NULL)
    `)).rows[0].n;
    expect(scheduledInfoOnly).toBe(0);
  });

  test('FU-689: Thesis and Research are allowed at BOTH Undergraduate and Graduate level', async () => {
    await A(request(app).post(`${B}/terms`), tok).send({ code: SUM });
    // UG + research → now ALLOWED (the FU-688 GR-only gate was removed in FU-689).
    const ugRes = await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SUM)
      .send({ courseCode: 'SWE 305', name: 'Undergrad Research', credits: 3, academicLevel: 'Junior', category: 'UG', numSections: 1, isResearch: true });
    expect(ugRes.status).toBe(201);
    expect((await query(`SELECT is_research FROM courses WHERE owner_semester=$1 AND course_code='SWE 305'`, [SUM])).rows[0].is_research).toBe(true);
    // UG + thesis → also allowed.
    const ugThs = await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SUM)
      .send({ courseCode: 'SWE 411', name: 'Undergrad Thesis', credits: 2, academicLevel: 'Senior', category: 'UG', numSections: 1, isThesis: true });
    expect(ugThs.status).toBe(201);
    expect((await query(`SELECT is_thesis FROM courses WHERE owner_semester=$1 AND course_code='SWE 411'`, [SUM])).rows[0].is_thesis).toBe(true);
    // GR + research → still allowed, flag persisted, mutually exclusive.
    const gr = await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SUM)
      .send({ courseCode: 'SWE 698', name: 'Directed Research', credits: 3, academicLevel: 'Graduate', category: 'GR', numSections: 1, isResearch: true });
    expect(gr.status).toBe(201);
    const row = (await query(`SELECT is_research, is_thesis, is_capstone FROM courses WHERE owner_semester=$1 AND course_code='SWE 698'`, [SUM])).rows[0];
    expect(row.is_research).toBe(true);
    expect(row.is_thesis).toBe(false);
    expect(row.is_capstone).toBe(false);
  });

  test('Project: an UNTIMED section is creatable (time-optional) and raises no conflict', async () => {
    const sid = await sidFor(SUM);
    await query(`DELETE FROM sections WHERE schedule_id=$1`, [sid]);
    await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SUM)
      .send({ courseCode: 'SWE 491', name: 'Senior Project', credits: 0, academicLevel: 'Senior', category: 'UG', numSections: 1, isCapstone: true });
    const prj = (await query(`SELECT id FROM courses WHERE owner_semester=$1 AND course_code='SWE 491'`, [SUM])).rows[0];
    const instr = (await query(`INSERT INTO instructors (name,email,is_dummy,owner_semester) VALUES ('PRJ SUP','prj688@kfupm.test',false,$1) RETURNING id`, [SUM])).rows[0].id;
    await query(`INSERT INTO office_hours (instructor_id,day,start_time,end_time) VALUES ($1,'Monday','12:00','13:00')`, [instr]);

    // No day / startTime / endTime at all — Project time is optional.
    const res = await A(request(app).post(`${B}/schedules/${sid}/sections`), tok).set('X-Active-Term', SUM)
      .send({ courseId: prj.id, instructorId: instr, sectionNumber: '01', sectionType: 'Prj' });
    expect(res.status).toBe(201);
    const stored = (await query(`SELECT day, start_time, end_time FROM sections WHERE course_id=$1`, [prj.id])).rows[0];
    expect(stored.day).toBeNull();
    expect(stored.start_time).toBeNull();
    expect(stored.end_time).toBeNull();

    const conf = (await A(request(app).get(`${B}/schedules/${sid}/conflicts`), tok)).body.conflicts || [];
    expect(conf.length).toBe(0);   // untimed Project: instructor present (no R-09), no venue (exempt), no time (no clash)
  });

  test('Project: an instructor IS still required (the one field a Project must have)', async () => {
    const sid = await sidFor(SUM);
    const prj = (await query(`SELECT id FROM courses WHERE owner_semester=$1 AND course_code='SWE 491'`, [SUM])).rows[0];
    const res = await A(request(app).post(`${B}/schedules/${sid}/sections`), tok).set('X-Active-Term', SUM)
      .send({ courseId: prj.id, sectionNumber: '02', sectionType: 'Prj' });   // no instructor
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/instructor/i);
  });

  test('FU-689 Seminar: GRADUATE-only, exactly 75 min single-day (50/100/160/multi-day/UG all rejected)', async () => {
    const sid = await sidFor(SUM);
    const instr = (await query(`SELECT id FROM instructors WHERE owner_semester=$1 LIMIT 1`, [SUM])).rows[0].id;
    const venue = (await query(`INSERT INTO venues (name,type,capacity,owner_semester) VALUES ('SEM-HALL','LectureHall',40,$1) RETURNING id`, [SUM])).rows[0].id;
    // Seminar is GRADUATE → bound to the GR teaching window (17:20–22:00); schedule it there.
    const post = (over) => A(request(app).post(`${B}/schedules/${sid}/sections`), tok).set('X-Active-Term', SUM)
      .send({ instructorId: instr, venueId: venue, sectionType: 'Sem', days: ['Monday'], startTime: '17:20', endTime: '18:35', ...over });

    const badCredits = await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SUM)
      .send({ courseCode: 'SWE 591', name: 'Bad Seminar Credits', credits: 3, academicLevel: 'Graduate', category: 'GR', numSections: 1, isSeminar: true });
    expect(badCredits.status).toBe(400);
    expect(String(badCredits.body.error)).toMatch(/1 credit/i);

    // GRADUATE 1-credit seminar course.
    await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SUM)
      .send({ courseCode: 'SWE 590', name: 'Graduate Seminar', credits: 1, academicLevel: 'Graduate', category: 'GR', numSections: 1, isSeminar: true });
    const grSem = (await query(`SELECT id FROM courses WHERE owner_semester=$1 AND course_code='SWE 590'`, [SUM])).rows[0];

    const okSem = await post({ courseId: grSem.id, sectionNumber: '03', endTime: '18:35' });
    expect(okSem.status).toBe(201); // 75 min ✓
    expect((await post({ courseId: grSem.id, sectionNumber: '04', endTime: '18:10' })).status).toBe(400); // 50 min ✗
    expect((await post({ courseId: grSem.id, sectionNumber: '05', endTime: '19:00' })).status).toBe(400); // 100 min ✗
    expect((await post({ courseId: grSem.id, sectionNumber: '06', endTime: '20:00' })).status).toBe(400); // 160 min ✗
    expect((await post({ courseId: grSem.id, sectionNumber: '07', days: ['Sunday','Tuesday'] })).status).toBe(400); // multi-day ✗
    const missingVenue = await A(request(app).post(`${B}/schedules/${sid}/sections`), tok).set('X-Active-Term', SUM)
      .send({ courseId: grSem.id, instructorId: instr, sectionType: 'Sem', sectionNumber: '09', days: ['Tuesday'], startTime: '17:20', endTime: '18:35' });
    expect(missingVenue.status).toBe(400);
    expect(String(missingVenue.body.error)).toMatch(/venue is required/i);

    const fixedFlag = await A(request(app).put(`${B}/courses/${grSem.id}`), tok).set('X-Active-Term', SUM)
      .send({ isSeminar: false });
    expect(fixedFlag.status).toBe(400);
    expect(String(fixedFlag.body.error)).toMatch(/fixed after creation/i);
    const fixedCredits = await A(request(app).put(`${B}/courses/${grSem.id}`), tok).set('X-Active-Term', SUM)
      .send({ credits: 3 });
    expect(fixedCredits.status).toBe(400);
    expect(String(fixedCredits.body.error)).toMatch(/1 credit/i);

    const savedSem = (await query(`
      SELECT id, section_type FROM sections
       WHERE schedule_id=$1 AND course_id=$2 AND section_number='03'
       LIMIT 1
    `, [sid, grSem.id])).rows[0];
    expect(savedSem.section_type).toBe('Sem');
    const clearedVenue = await A(request(app).put(`${B}/sections/${savedSem.id}`), tok).set('X-Active-Term', SUM)
      .send({ infoOnly: true, instructorId: instr, venueId: null });
    expect(clearedVenue.status).toBe(400);
    expect(String(clearedVenue.body.error)).toMatch(/venue is required/i);

    // Seminar creation is rejected outside the Graduate SWE 500–699 range.
    const badCreate = await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SUM)
      .send({ courseCode: 'SWE 392', name: 'UG Not A Seminar', credits: 1, academicLevel: 'Junior', category: 'UG', numSections: 1, isSeminar: true });
    expect(badCreate.status).toBe(400);
    expect(String(badCreate.body.error)).toMatch(/Graduate SWE 500.*699|Graduate SWE 500–699/);

    // A Seminar section on a non-Seminar course is rejected; section type is derived from the course flag.
    await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SUM)
      .send({ courseCode: 'SWE 392', name: 'UG Not A Seminar', credits: 1, academicLevel: 'Junior', category: 'UG', numSections: 1 });
    const ugCourse = (await query(`SELECT id FROM courses WHERE owner_semester=$1 AND course_code='SWE 392'`, [SUM])).rows[0];
    const ugSem = await post({ courseId: ugCourse.id, sectionNumber: '08' });
    expect(ugSem.status).toBe(400);
    expect(String(ugSem.body.error)).toMatch(/Seminar/i);
  });

  test('Summer Training vs Internship: the same external course is term-derived in the export', async () => {
    // External course in the SUMMER term → "Summer Training".
    const sidS = await sidFor(SUM);
    const extS = await ensureCourse(SUM, 'SWE 399', { courseCode: 'SWE 399', name: 'Summer Field Training', credits: 1, academicLevel: 'Junior', category: 'UG', numSections: 1, isExternal: true });
    // A placeholder-timed external section (the legacy shape) — still info-only, term-derived label.
    const instrS = (await query(`SELECT id FROM instructors WHERE owner_semester=$1 LIMIT 1`, [SUM])).rows[0].id;
    await query(`INSERT INTO sections (schedule_id,course_id,instructor_id,section_number,day,start_time,end_time,section_type,gender)
                 VALUES ($1,$2,$3,'01','Sunday','08:00','08:50','Lec','M')`, [sidS, extS.id, instrS]);

    const { workbook: wbS } = await exportSvc.buildExport(sidS, { type: 'full' }, SUM, 'xlsx');
    const labelInSheet = (wb, code) => {
      const ws = wb.getWorksheet('Sections');
      let val = null;
      ws.eachRow((row) => { if (String(row.getCell('courseCode').value).trim() === code) val = String(row.getCell('sectionType').value).trim(); });
      return val;
    };
    expect(labelInSheet(wbS, 'SWE 399')).toBe('Summer Training');   // last digit 3 → Summer

    // The SAME external course code in a FALL term → "Internship".
    await A(request(app).post(`${B}/terms`), tok).send({ code: FALL });
    const sidF = await sidFor(FALL);
    await query(`DELETE FROM sections WHERE schedule_id=$1`, [sidF]);
    const extF = await ensureCourse(FALL, 'SWE 399', { courseCode: 'SWE 399', name: 'Summer Field Training', credits: 1, academicLevel: 'Junior', category: 'UG', numSections: 1, isExternal: true });
    const instrF = (await query(`INSERT INTO instructors (name,email,is_dummy,owner_semester) VALUES ('FALL SUP','fall688@kfupm.test',false,$1) RETURNING id`, [FALL])).rows[0].id;
    await query(`INSERT INTO sections (schedule_id,course_id,instructor_id,section_number,day,start_time,end_time,section_type,gender)
                 VALUES ($1,$2,$3,'01','Sunday','08:00','08:50','Lec','M')`, [sidF, extF.id, instrF]);

    const { workbook: wbF } = await exportSvc.buildExport(sidF, { type: 'full' }, FALL, 'xlsx');
    expect(labelInSheet(wbF, 'SWE 399')).toBe('Internship');        // last digit 1 → non-Summer
  });

  test('FU-689: external (ST/INT) is Junior-only; INT also derives in a Spring term', async () => {
    // Junior-only: a non-Junior external course is rejected.
    const senior = await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SUM)
      .send({ courseCode: 'SWE 499', name: 'Senior External', credits: 1, academicLevel: 'Senior', category: 'UG', numSections: 1, isExternal: true });
    expect(senior.status).toBe(400);
    expect(String(senior.body.error)).toMatch(/Junior/i);

    // Spring term (last digit 2) → external derives "Internship" too (only Summer ⇒ ST).
    const SPRING = '332';
    await wipe(SPRING);
    await A(request(app).post(`${B}/terms`), tok).send({ code: SPRING });
    const sidSp = await sidFor(SPRING);
    await query(`DELETE FROM sections WHERE schedule_id=$1`, [sidSp]);
    const extSp = await ensureCourse(SPRING, 'SWE 399', { courseCode: 'SWE 399', name: 'Field Training', credits: 1, academicLevel: 'Junior', category: 'UG', numSections: 1, isExternal: true });
    const instrSp = (await query(`INSERT INTO instructors (name,email,is_dummy,owner_semester) VALUES ('SPRING SUP','spr689@kfupm.test',false,$1) RETURNING id`, [SPRING])).rows[0].id;
    await query(`INSERT INTO sections (schedule_id,course_id,instructor_id,section_number,day,start_time,end_time,section_type,gender)
                 VALUES ($1,$2,$3,'01','Sunday','08:00','08:50','Lec','M')`, [sidSp, extSp.id, instrSp]);
    const { workbook: wbSp } = await exportSvc.buildExport(sidSp, { type: 'full' }, SPRING, 'xlsx');
    const ws = wbSp.getWorksheet('Sections'); let val = null;
    ws.eachRow((row) => { if (String(row.getCell('courseCode').value).trim() === 'SWE 399') val = String(row.getCell('sectionType').value).trim(); });
    expect(val).toBe('Internship');   // last digit 2 (Spring) → Internship
    await wipe(SPRING);
  });
});
