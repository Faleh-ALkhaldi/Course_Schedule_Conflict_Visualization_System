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
const { query } = require('../../src/config/db');   // NEW-FU-673: term-valid resource selection

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
  // NEW-FU-673: SQL-level wipe so a multi-day group goes in one shot (FU-609 would coerce a
  // per-row API delete of a multi-day group to a whole-group delete mid-loop — harmless here,
  // but the SQL wipe is simpler and unambiguous). The term's OWNED resources survive.
  await query(`DELETE FROM sections WHERE schedule_id = $1`, [sched.id]);

  // NEW-FU-673: return resources VALID FOR THIS TERM — owned by this term (owner_semester =
  // code) OR template (owner_semester IS NULL). Post-FU-645 the global GET /courses|instructors|
  // venues lists also include OTHER terms' owner-scoped copies, so picking from them grabs a
  // resource owned by another term → section-create 409 "belongs to term X". Query directly
  // because those GET endpoints don't expose owner_semester. UG-only courses keep the R-06
  // graduate-time-window (17:20–22:00) from rejecting the 09:00 sections these tests build.
  const courses = (await query(
    `SELECT id, credits, has_lab, category, course_code, academic_level FROM courses
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND category = 'UG'`, [code])).rows
    .map(c => ({ ...c, credits: Number(c.credits), has_lab: c.has_lab, course_code: c.course_code }));
  const instructors = (await query(
    `SELECT id, name FROM instructors
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows;
  const venues = (await query(
    `SELECT id, type FROM venues
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows;
  return { scheduleId: sched.id, courses, instructors, venues };
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
    const { scheduleId, courses, instructors, venues } = await freshTermSchedule('282');   // NEW-FU-673
    const c   = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const lec = venues.find(v => v.type === 'LectureHall');

    // NEW-FU-673: FU-475 (Phase 114) made a missing instructor a HARD create-time block (was a
    // soft R-09 warning) — so a section can no longer be POSTed without one. Create a valid
    // section, then NULL the instructor at the DB level to seed the R-09 state the resolver
    // is meant to fix. (This test verifies the RESOLVER's reassign-instructor op, not the
    // create endpoint's new requirement.)
    const cr = await createSection(scheduleId, {
      courseId: c.id, instructorId: instructors[0].id, venueId: lec.id, sectionNumber: '01',
    });
    expect(cr.status).toBe(201);
    await query(`UPDATE sections SET instructor_id = NULL WHERE schedule_id = $1`, [scheduleId]);

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
    // NEW-FU-673: rich Spring code '312' (was Summer '283', which copies the near-empty 253
    // base and OWNS no venues — the resolver's reassign-venue pool is findAssignable(term) =
    // owner-scoped only, so a poor term yields only the add-dummy-venue fallback, not reassign).
    const { scheduleId, courses, instructors, venues } = await freshTermSchedule('312');
    const c     = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const instr = instructors[0];
    const lec   = venues.find(v => v.type === 'LectureHall');

    // NEW-FU-673: FU-475 made a missing venue a HARD create-time block too. Create a valid
    // section, then NULL the venue at the DB level to seed the R-10 state the resolver fixes.
    const cr = await createSection(scheduleId, {
      courseId: c.id, instructorId: instr.id, venueId: lec.id, sectionNumber: '01',
    });
    expect(cr.status).toBe(201);
    await query(`UPDATE sections SET venue_id = NULL WHERE schedule_id = $1`, [scheduleId]);

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
    const { scheduleId, courses, instructors, venues } = await freshTermSchedule('302');   // NEW-FU-673
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
    // NEW-FU-673: delete the row at the DB level. FU-609 (Batch 30) now coerces a per-row API
    // delete of a section that belongs to a MULTI-day group into a whole-group delete ("never
    // leave a partial group") — which would remove all 3 days and R-15 would never fire. The
    // under-covered state R-15 detects is exactly what FU-609 prevents the API from creating, so
    // we seed it directly. (This test verifies the RESOLVER's R-15 add-day op, not the delete
    // endpoint's coercion.)
    const list = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const tueRow = (list.sections || list).find(s =>
      s.courseId === c.id && s.day === 'Tuesday'
    );
    expect(tueRow).toBeTruthy();
    await query(`DELETE FROM sections WHERE id = $1`, [tueRow.id]);

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
    const { scheduleId } = await freshTermSchedule('252');   // NEW-FU-673
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
    const { scheduleId, courses, instructors, venues } = await freshTermSchedule('253');   // NEW-FU-673
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
    // NEW-FU-673: DB-level row delete (FU-609 would coerce a per-row API delete of a multi-day
    // group to a whole-group delete, so R-15 wouldn't fire — see the R-15 test above).
    await query(`DELETE FROM sections WHERE id = $1`, [tueRow.id]);

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
    // NEW-FU-673: code '273' + term-valid resources. The catalog has no "SWE301"/"SWE411"
    // (codes carry a space and those numbers don't exist); use real adjacent-level courses —
    // SWE 316 (Junior) + SWE 402 (Senior), diff = 1 → R-02 (soft) per R02Rule.
    const { scheduleId, courses, instructors, venues } = await freshTermSchedule('273');
    const halls = venues.filter(v => v.type === 'LectureHall');

    // SWE 316 (Junior) + SWE 402 (Senior) — adjacent levels, both single-section,
    // both 3cr no-lab. Same day/time → R-02 fires. Different instructors AND venues so
    // R-04/R-05 don't fire alongside R-02 (would confuse the test signal).
    const junior = courses.find(c => c.course_code === 'SWE 316');
    const senior = courses.find(c => c.course_code === 'SWE 402');
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
    const { scheduleId, courses, instructors, venues } = await freshTermSchedule('281');   // NEW-FU-673
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
    const { scheduleId } = await freshTermSchedule('291');   // NEW-FU-673
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
    const { scheduleId } = await freshTermSchedule('261');   // NEW-FU-673
    const plan = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(plan.status).toBe(200);
    expect(plan.body.supportedOpTypes).toContain('move');
  });

  test('apply endpoint rejects add-day op with missing addDays', async () => {
    const { scheduleId } = await freshTermSchedule('272');   // NEW-FU-673
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: [{ type: 'add-day', sectionId: '00000000-0000-0000-0000-000000000000' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/addDays/i);
  });
});
