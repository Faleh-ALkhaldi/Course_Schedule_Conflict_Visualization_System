// NEW-FU-328 (Phase 30): integration tests for QuickFix's expanded
// rule coverage. Phase 29 only handled R-04 / R-05 — when the user
// faced any other rule, the modal said "No automatic fixes available"
// even though the conflict was deterministically fixable.
//
// Phase 30 adds op generators for:
//   R-09 (missing instructor)         → reassign-instructor (from null)
//   R-10 (missing venue)              → reassign-venue (from null)
//   R-11 (lab in non-lab venue)       → reassign-venue to Lab
//   R-12 (lec in lab venue)           → reassign-venue to LectureHall
//   R-15 (insufficient credit cov.)   → add-day (new op primitive)
//
// Each test creates a schedule with the target conflict, calls
// /quick-fix, and asserts the plan contains an op of the expected
// shape. We DON'T necessarily call /apply for each — that's covered
// by the Phase 29 apply-end-to-end test and by quickFix.test.js.

const request = require('supertest');
const app     = require('../../src/app');

const ADMIN = { username: 'admin1', password: 'password123' };

let adminTok;
const createdCodes = new Set();

beforeAll(async () => {
  const r = await request(app).post('/api/v1/auth/login').send(ADMIN);
  expect(r.status).toBe(200);
  adminTok = r.body.token;
});

afterAll(async () => {
  for (const code of createdCodes) {
    await request(app)
      .delete(`/api/v1/terms/${code}`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`)
      .catch(() => {});
  }
});

async function freshTermSchedule(code) {
  createdCodes.add(code);
  await request(app)
    .delete(`/api/v1/terms/${code}`)
    .query({ activeCode: '251' })
    .set('Authorization', `Bearer ${adminTok}`)
    .catch(() => {});
  const tr = await request(app)
    .post('/api/v1/terms')
    .set('Authorization', `Bearer ${adminTok}`)
    .send({ code });
  expect(tr.status).toBe(201);
  const sr = await request(app)
    .get('/api/v1/departments/SWE-DEPT/schedules')
    .set('Authorization', `Bearer ${adminTok}`);
  const sched = sr.body.find(s => s.semester === code);
  expect(sched).toBeTruthy();
  // Wipe seeded sections so each test starts clean — the season-family
  // auto-seed (FU-234) lays down a default set that would otherwise
  // pollute the R-09/R-10/etc. fixtures we're constructing.
  const existing = (await request(app)
    .get(`/api/v1/schedules/${sched.id}/sections`)
    .set('Authorization', `Bearer ${adminTok}`)).body;
  for (const s of (existing.sections || existing)) {
    await request(app)
      .delete(`/api/v1/sections/${s.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`)
      .catch(() => {});
  }
  return sched.id;
}

async function createSection(scheduleId, opts) {
  const r = await request(app)
    .post(`/api/v1/schedules/${scheduleId}/sections`)
    .set('Authorization', `Bearer ${adminTok}`)
    .send({
      courseId:      opts.courseId,
      instructorId:  opts.instructorId,   // can be undefined
      venueId:       opts.venueId,        // can be undefined
      sectionNumber: opts.sectionNumber ?? '01',
      sectionType:   opts.sectionType ?? 'Lec',
      days:          opts.days ?? ['Sunday', 'Tuesday', 'Thursday'],
      startTime:     opts.startTime ?? '09:00',
      endTime:       opts.endTime ?? '09:50',
    });
  return r;
}

describe('FU-328: Quick Fix coverage for R-09..R-15 (Phase 30)', () => {

  test('R-09 missing instructor → plan has reassign-instructor op', async () => {
    const scheduleId = await freshTermSchedule('282');
    const courses   = (await request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)).body;
    const venues    = (await request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`)).body;
    const c   = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const lec = venues.find(v => v.type === 'LectureHall');

    // Create section WITHOUT instructorId → triggers R-09 soft conflict.
    const cr = await createSection(scheduleId, {
      courseId: c.id, venueId: lec.id, sectionNumber: '01',
    });
    expect(cr.status).toBe(201);

    const plan = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(plan.status).toBe(200);

    const reassign = plan.body.ops.find(o =>
      o.type === 'reassign-instructor' && o.newInstructorId
    );
    expect(reassign).toBeTruthy();
  });

  test('R-10 missing venue → plan has reassign-venue op', async () => {
    const scheduleId = await freshTermSchedule('283');
    const courses     = (await request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)).body;
    const instructors = (await request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`)).body;
    const c     = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const instr = instructors[0];

    const cr = await createSection(scheduleId, {
      courseId: c.id, instructorId: instr.id, sectionNumber: '01',
    });
    expect(cr.status).toBe(201);

    const plan = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(plan.status).toBe(200);

    const reassign = plan.body.ops.find(o =>
      o.type === 'reassign-venue' && o.newVenueId
    );
    expect(reassign).toBeTruthy();
  });

  test('R-15 insufficient credit coverage → plan has add-day op', async () => {
    const scheduleId = await freshTermSchedule('302');
    const courses     = (await request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)).body;
    const instructors = (await request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`)).body;
    const venues      = (await request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`)).body;
    const c     = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const instr = instructors[0];
    const lec   = venues.find(v => v.type === 'LectureHall');

    // Build a 3-credit STT group, then DELETE one day to trigger R-15
    // (insufficient credit coverage on the 2 surviving days).
    const cr = await createSection(scheduleId, {
      courseId: c.id, instructorId: instr.id, venueId: lec.id,
      sectionNumber: '01',
      days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    expect(cr.status).toBe(201);

    // Delete the Tuesday row → group now Sun/Thu = 2 days × 50min = 100min
    // for a 3-credit course needing 150min. R-15 fires.
    const list = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const tueRow = (list.sections || list).find(s =>
      s.courseId === c.id && s.day === 'Tuesday'
    );
    expect(tueRow).toBeTruthy();
    await request(app)
      .delete(`/api/v1/sections/${tueRow.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);

    const plan = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(plan.status).toBe(200);

    const addDay = plan.body.ops.find(o => o.type === 'add-day');
    expect(addDay).toBeTruthy();
    expect(Array.isArray(addDay.addDays)).toBe(true);
    expect(addDay.addDays.length).toBeGreaterThan(0);
    // The missing day for STT pattern is Tuesday (the one we deleted).
    expect(addDay.addDays).toContain('Tuesday');
  });

  test('plan returns unresolvedRuleIds + supportedOpTypes metadata', async () => {
    const scheduleId = await freshTermSchedule('252');
    // Empty schedule → no conflicts, no ops. The shape fields still
    // present (FU-327 contract) so the modal can read them.
    const plan = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(plan.status).toBe(200);
    expect(Array.isArray(plan.body.unresolvedRuleIds)).toBe(true);
    expect(Array.isArray(plan.body.supportedOpTypes)).toBe(true);
    expect(plan.body.supportedOpTypes).toContain('add-day');
    expect(plan.body.supportedOpTypes).toContain('reassign-instructor');
    expect(plan.body.supportedOpTypes).toContain('reassign-venue');
    expect(plan.body.supportedOpTypes).toContain('drop');
  });

  test('apply endpoint accepts add-day op shape', async () => {
    const scheduleId = await freshTermSchedule('253');
    const courses     = (await request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)).body;
    const instructors = (await request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`)).body;
    const venues      = (await request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`)).body;
    const c     = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const instr = instructors[0];
    const lec   = venues.find(v => v.type === 'LectureHall');

    // Same R-15 fixture as above.
    await createSection(scheduleId, {
      courseId: c.id, instructorId: instr.id, venueId: lec.id,
      sectionNumber: '01',
      days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    const list = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const tueRow = (list.sections || list).find(s =>
      s.courseId === c.id && s.day === 'Tuesday'
    );
    await request(app)
      .delete(`/api/v1/sections/${tueRow.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);

    const planRes = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    const addDayOp = planRes.body.ops.find(o => o.type === 'add-day');
    expect(addDayOp).toBeTruthy();

    const applyRes = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: [addDayOp] });
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.applied).toBeGreaterThan(0);

    // Verify the missing day was added back.
    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const days = (after.sections || after)
      .filter(s => s.courseId === c.id)
      .map(s => s.day)
      .sort();
    expect(days).toContain('Tuesday');
  });

  test('FU-333: R-02 adjacent-level overlap → plan has move op', async () => {
    // R-02 fires when two single-section courses of adjacent academic
    // levels (e.g., Junior + Senior, diff=1) overlap in time. Phase 31
    // adds the `move` op primitive so the resolver can propose
    // shifting one of them to a non-overlapping slot.
    const scheduleId = await freshTermSchedule('273');
    const courses     = (await request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)).body;
    const instructors = (await request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`)).body;
    const venues      = (await request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`)).body;
    const halls = venues.filter(v => v.type === 'LectureHall');

    // SWE301 (Junior) + SWE411 (Senior) — adjacent levels, both
    // single-section, both 3cr no-lab. Same day/time → R-02 fires.
    // Different instructors AND different venues so R-04/R-05 don't
    // fire alongside R-02 (would confuse the test signal).
    const junior = courses.find(c => c.course_code === 'SWE301');
    const senior = courses.find(c => c.course_code === 'SWE411');
    expect(junior).toBeTruthy();
    expect(senior).toBeTruthy();

    await createSection(scheduleId, {
      courseId: junior.id, instructorId: instructors[0].id, venueId: halls[0].id,
      sectionNumber: '01',
      days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    await createSection(scheduleId, {
      courseId: senior.id, instructorId: instructors[1].id, venueId: halls[1].id,
      sectionNumber: '01',
      days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });

    const plan = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(plan.status).toBe(200);

    // A move op should be proposed for one of the two sections.
    const moveOps = plan.body.ops.filter(o => o.type === 'move');
    expect(moveOps.length).toBeGreaterThan(0);
    // The move target should be different from the original 09:00 slot.
    expect(moveOps[0].newStartTime).not.toBe('09:00');
  });

  test('FU-333: apply endpoint accepts move op shape and updates DB', async () => {
    const scheduleId = await freshTermSchedule('281');
    const courses     = (await request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)).body;
    const instructors = (await request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`)).body;
    const venues      = (await request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`)).body;
    const c     = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const instr = instructors[0];
    const lec   = venues.find(v => v.type === 'LectureHall');

    await createSection(scheduleId, {
      courseId: c.id, instructorId: instr.id, venueId: lec.id,
      sectionNumber: '01',
      days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });

    // Apply a manual move op (skip the plan stage to isolate the
    // apply-path test from any quirks of plan generation).
    const sections = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sun = (sections.sections || sections).find(s =>
      s.courseId === c.id && s.day === 'Sunday'
    );
    expect(sun).toBeTruthy();

    const applyRes = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: [{
        type: 'move',
        sectionId: sun.id,
        newStartTime: '14:00',
        newEndTime: '14:50',
      }] });
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.applied).toBeGreaterThan(0);

    // All 3 group rows should now be at 14:00 (group propagation).
    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const groupRows = (after.sections || after).filter(s => s.courseId === c.id);
    expect(groupRows.length).toBe(3);
    for (const row of groupRows) {
      expect(row.startTime ?? row.start_time).toMatch(/^14:00/);
    }
  });

  test('apply endpoint rejects move op with malformed time strings', async () => {
    const scheduleId = await freshTermSchedule('291');
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: [{
        type: 'move',
        sectionId: '00000000-0000-0000-0000-000000000000',
        newStartTime: 'two o\'clock',
        newEndTime:   'three o\'clock',
      }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/HH:MM/);
  });

  test('plan response supportedOpTypes now includes "move"', async () => {
    const scheduleId = await freshTermSchedule('261');
    const plan = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(plan.status).toBe(200);
    expect(plan.body.supportedOpTypes).toContain('move');
  });

  test('apply endpoint rejects add-day op with missing addDays', async () => {
    const scheduleId = await freshTermSchedule('272');
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: [{ type: 'add-day', sectionId: '00000000-0000-0000-0000-000000000000' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/addDays/i);
  });
});
