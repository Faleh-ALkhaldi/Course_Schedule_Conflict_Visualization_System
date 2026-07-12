// NEW-FU-687 — course-type / section-type reclassification + the new Thesis flag, end to end:
//   • A capstone course's Course Type is exported/displayed as "Project" (not "Capstone"); its meeting
//     is a "Project" (Prj) section, not a "Lecture". The label round-trips: re-importing restores
//     is_capstone (the importer accepts "Project" AND legacy "Capstone").
//   • A thesis/research course carries the new is_thesis flag, is exported/displayed as "Thesis" with a
//     "Thesis" (Ths) section, and is information-only exactly like the registrar listing —
//     so it persists with instructor/section metadata only, never with a scheduled meeting.
//   • The display derivation is non-destructive: a section stored as 'Lec' on a capstone/thesis course
//     still DISPLAYS as Project/Thesis (effectiveSectionType) without rewriting the stored row.
const request   = require('supertest');
const app       = require('../../src/app');
const exportSvc = require('../../src/services/ExportService');
const labels    = require('../../src/domain/exportLabels');
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

describe('FU-687 — Project/Thesis reclassification + thesis exemption, end to end', () => {
  test('effectiveSectionType + courseTypeLabel derive Project/Thesis without rewriting stored rows', () => {
    // pure unit-style guards on the shared deriver (display-only)
    expect(labels.courseTypeLabel({ isCapstone: true })).toBe('Project');
    expect(labels.courseTypeLabel({ isThesis: true })).toBe('Thesis');
    expect(labels.effectiveSectionType({ sectionType: 'Lec', isCapstone: true })).toBe('Prj'); // legacy Lec → Prj (derived)
    expect(labels.effectiveSectionType({ sectionType: 'Lec', isThesis: true })).toBe('Ths');
    expect(labels.effectiveSectionType({ sectionType: 'Lec' })).toBe('Lec');                    // regular lecture unchanged
  });

  test('a thesis section is information-only and the Project/Thesis flags round-trip through export→import', async () => {
    const SRC = '342', DST = '343';
    for (const T of [SRC, DST]) await A(request(app).post(`${B}/terms`), tok).send({ code: T });
    const sidS = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === SRC).id;
    await query(`DELETE FROM sections WHERE schedule_id=$1`, [sidS]);

    // Project (capstone, 0-credit Senior) + Thesis (Graduate) — fresh codes not in the seed.
    // NOTE: the X-Active-Term header stamps owner_semester (per-term private copy).
    await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SRC).send({ courseCode: 'SWE 492', name: 'Capstone Design Project', credits: 0, academicLevel: 'Senior',   category: 'UG', numSections: 1, isCapstone: true });
    await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SRC).send({ courseCode: 'SWE 695', name: 'Graduate Research Thesis', credits: 3, academicLevel: 'Graduate', category: 'GR', numSections: 1, isThesis: true });
    await A(request(app).post(`${B}/courses`), tok).set('X-Active-Term', SRC).send({ courseCode: 'SWE 491', name: 'Normal Scheduling Fixture', credits: 3, academicLevel: 'Senior', category: 'UG', numSections: 1 });
    const cap = (await query(`SELECT id FROM courses WHERE owner_semester=$1 AND course_code='SWE 492'`, [SRC])).rows[0];
    const ths = (await query(`SELECT id FROM courses WHERE owner_semester=$1 AND course_code='SWE 695'`, [SRC])).rows[0];
    const lec = (await query(`SELECT id FROM courses WHERE owner_semester=$1 AND course_code='SWE 491'`, [SRC])).rows[0];
    expect(cap).toBeTruthy(); expect(ths).toBeTruthy(); expect(lec).toBeTruthy();
    // Self-sufficient instructor (the test DB seeds a fresh term only minimally) + office hours so the
    // capstone supervisor (instructor-required, venue-exempt) raises no R-13.
    const instr = (await query(`INSERT INTO instructors (name,email,is_dummy,owner_semester) VALUES ('SUPERVISOR ONE','sup687@kfupm.test',false,$1) RETURNING id`, [SRC])).rows[0].id;
    await query(`INSERT INTO office_hours (instructor_id,day,start_time,end_time) VALUES ($1,'Monday','12:00','13:00')`, [instr]);

    // A scheduled Thesis meeting is now invalid; Thesis is information-only and stores only
    // the supervising instructor + section number.
    const badThesis = await A(request(app).post(`${B}/schedules/${sidS}/sections`), tok).set('X-Active-Term', SRC)
      .send({ courseId: ths.id, instructorId: instr, sectionNumber: '02', days: ['Sunday'], startTime: '08:00', endTime: '09:40', sectionType: 'Ths' });
    expect(badThesis.status).toBe(400);
    expect(badThesis.body.error).toMatch(/information-only/i);

    // Project section + unscheduled Thesis section.
    const ps = await A(request(app).post(`${B}/schedules/${sidS}/sections`), tok).set('X-Active-Term', SRC)
      .send({ courseId: cap.id, instructorId: instr, sectionNumber: '01', days: ['Wednesday'], startTime: '08:00', endTime: '08:50', sectionType: 'Prj' });
    const ts = await A(request(app).post(`${B}/schedules/${sidS}/sections`), tok).set('X-Active-Term', SRC)
      .send({ courseId: ths.id, instructorId: instr, sectionNumber: '01', sectionType: 'Ths' });
    expect(ps.status).toBe(201);
    expect(ts.status).toBe(201);   // thesis: no venue/day/time, but instructor is required

    const rec = await A(request(app).get(`${B}/schedules/${sidS}/suggest-recommend`), tok);
    expect(rec.status).toBe(200);
    const recommendedIds = new Set(rec.body.recommendations.map(r => r.courseId));
    expect(recommendedIds.has(cap.id)).toBe(false);
    expect(recommendedIds.has(ths.id)).toBe(false);

    const beforeSuggestRows = (await query(
      `SELECT id, course_id, day, start_time::text, end_time::text, venue_id
         FROM sections WHERE schedule_id=$1 AND course_id = ANY($2)`,
      [sidS, [cap.id, ths.id]]
    )).rows;
    const suggest = await A(request(app).post(`${B}/schedules/${sidS}/suggest`), tok).send({
      courseConfigs: [
        { courseId: lec.id, sections: 1, dayPattern: 'STT', duration: 50 },
        { courseId: cap.id, sections: 1, dayPattern: 'ONE_DAY', duration: 160, day: 'Wednesday' },
        { courseId: ths.id, sections: 1, dayPattern: 'ONE_DAY', duration: 50, day: 'Sunday' },
      ],
    });
    expect(suggest.status).toBe(200);
    const afterSuggestRows = (await query(
      `SELECT id, course_id, day, start_time::text, end_time::text, venue_id
         FROM sections WHERE schedule_id=$1 AND course_id = ANY($2)`,
      [sidS, [cap.id, ths.id]]
    )).rows;
    expect(afterSuggestRows.map(r => r.id).sort()).toEqual(beforeSuggestRows.map(r => r.id).sort());
    const thsAfter = afterSuggestRows.find(r => r.course_id === ths.id);
    expect(thsAfter.day).toBeNull();
    expect(thsAfter.start_time).toBeNull();
    expect(thsAfter.end_time).toBeNull();
    expect(thsAfter.venue_id).toBeNull();
    const lecAfter = (await query(`SELECT COUNT(*)::int AS n FROM sections WHERE schedule_id=$1 AND course_id=$2`, [sidS, lec.id])).rows[0].n;
    expect(lecAfter).toBeGreaterThan(0);

    // No conflict on the schedule (thesis has no grid meeting; capstone venue-exempt).
    const conf = (await A(request(app).get(`${B}/schedules/${sidS}/conflicts`), tok)).body.conflicts || [];
    expect(conf.length).toBe(0);

    // Export emits "Project"/"Thesis" course types and Prj/Ths section types.
    const { workbook } = await exportSvc.buildExport(sidS, { type: 'full' }, SRC, 'xlsx');
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    const parsed = await exportSvc.parseRows(buf, 'xlsx');
    const cr = parsed.rows.find(r => r.courseCode === 'SWE 492');
    const tr = parsed.rows.find(r => r.courseCode === 'SWE 695');
    expect(cr.isCapstone).toBe(true);   // "Project" parsed back to the capstone flag
    expect(cr.sectionType).toBe('Prj');
    expect(tr.isThesis).toBe(true);     // "Thesis" parsed back to the new flag
    expect(tr.sectionType).toBe('Ths');
    expect(tr.days).toEqual([]);
    expect(tr.startTime).toBe('');
    expect(tr.endTime).toBe('');

    // Re-import into a fresh term restores both flags (lossless round-trip).
    const sidD = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === DST).id;
    const imp = await A(request(app).post(`${B}/schedules/${sidD}/import?mode=with-conflicts`), tok).set('X-Active-Term', DST).attach('file', buf, 'reclass.xlsx');
    expect(imp.status).toBe(200);
    expect(imp.body.created).toBeGreaterThan(0);
    const capD = (await query(`SELECT is_capstone, is_thesis FROM courses WHERE owner_semester=$1 AND course_code='SWE 492'`, [DST])).rows[0];
    const thsD = (await query(`SELECT is_capstone, is_thesis FROM courses WHERE owner_semester=$1 AND course_code='SWE 695'`, [DST])).rows[0];
    expect(capD.is_capstone).toBe(true);  expect(capD.is_thesis).toBe(false);
    expect(thsD.is_thesis).toBe(true);    expect(thsD.is_capstone).toBe(false);

    await wipe(SRC); await wipe(DST);
  });
});
