// NEW-FU-355 (Phase 34): adversarial red-team battery for Quick Fix.
// Phase 29 introduced the resolver, Phases 30-33 expanded coverage and
// op types. This battery proves the resolver handles every realistic
// conflict scenario AND degrades gracefully on cases it doesn't
// support (so the user sees a clear "manual fix needed" instead of a
// silent no-op).

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

async function pickFromList(list, predicate) {
  return list.find(predicate);
}

async function createSection(scheduleId, opts) {
  return request(app)
    .post(`/api/v1/schedules/${scheduleId}/sections`)
    .set('Authorization', `Bearer ${adminTok}`)
    .send({
      courseId:      opts.courseId,
      instructorId:  opts.instructorId,
      venueId:       opts.venueId,
      sectionNumber: opts.sectionNumber ?? '01',
      sectionType:   opts.sectionType ?? 'Lec',
      days:          opts.days ?? ['Sunday', 'Tuesday', 'Thursday'],
      startTime:     opts.startTime ?? '09:00',
      endTime:       opts.endTime ?? '09:50',
    });
}

async function plan(scheduleId) {
  const r = await request(app)
    .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
    .set('Authorization', `Bearer ${adminTok}`);
  expect(r.status).toBe(200);
  return r.body;
}

async function apply(scheduleId, ops) {
  const r = await request(app)
    .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
    .set('Authorization', `Bearer ${adminTok}`)
    .send({ ops });
  return r;
}

async function getRefs() {
  const [courses, instructors, venues] = await Promise.all([
    request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
    request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
    request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
  ]);
  return { courses, instructors, venues };
}

async function getSections(scheduleId) {
  const r = await request(app)
    .get(`/api/v1/schedules/${scheduleId}/sections`)
    .set('Authorization', `Bearer ${adminTok}`);
  return r.body.sections || r.body;
}

describe('FU-355: Quick Fix red-team battery (Phase 34)', () => {

  test('R-FIX-4: R-05 venue double-book → plan resolves it', async () => {
    const scheduleId = await freshTermSchedule('273');
    const { courses, instructors, venues } = await getRefs();
    const c1 = await pickFromList(courses, c => c.course_code === 'SWE301');
    const c2 = await pickFromList(courses, c => c.course_code === 'SWE321');
    const hall = venues.find(v => v.type === 'LectureHall');
    // Both sections at same venue same time → R-05 hard
    await createSection(scheduleId, {
      courseId: c1.id, instructorId: instructors[0].id, venueId: hall.id,
      startTime: '10:00', endTime: '10:50',
    });
    await createSection(scheduleId, {
      courseId: c2.id, instructorId: instructors[1].id, venueId: hall.id,
      startTime: '10:00', endTime: '10:50',
    });
    const p = await plan(scheduleId);
    // Either resolves R-05 entirely OR includes it in unresolved.
    // Since this is a HARD conflict, resolution should be aggressive.
    expect((p.unresolvedRuleIds ?? []).includes('R-05')).toBe(false);
  });

  test('R-FIX-14: already-clean schedule → 0 ops + clean message', async () => {
    const scheduleId = await freshTermSchedule('291');
    const p = await plan(scheduleId);
    expect(p.ops.length).toBe(0);
    // unresolvedRuleIds is empty when no conflicts present.
    expect(p.unresolvedRuleIds ?? []).toEqual([]);
  });

  test('R-FIX-16: apply on archived schedule → 409 when X-Active-Term asserts archived', async () => {
    const scheduleId = await freshTermSchedule('292');
    // Archive the term.
    const archiveRes = await request(app)
      .patch('/api/v1/terms/292/archive')
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(archiveRes.status).toBe(200);
    // Apply WITH X-Active-Term: 292 so the middleware sees the
    // archived state. Without the header, refuseIfActiveTermArchived
    // has no context (by design — it's a cooperative protocol).
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .set('X-Active-Term', '292')
      .send({ ops: [{
        type: 'reassign-instructor',
        sectionId: '00000000-0000-0000-0000-000000000000',
        newInstructorId: '00000000-0000-0000-0000-000000000001',
      }] });
    expect(r.status).toBe(409);
    // Unarchive for cleanup.
    await request(app)
      .patch('/api/v1/terms/292/unarchive')
      .set('Authorization', `Bearer ${adminTok}`)
      .catch(() => {});
  });

  test('R-FIX: malformed ops body (not array) → 400', async () => {
    const scheduleId = await freshTermSchedule('293');
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: 'not-an-array' });
    expect(r.status).toBe(400);
  });

  test('R-FIX: empty ops array → 200 with 0 applied', async () => {
    const scheduleId = await freshTermSchedule('301');
    const r = await apply(scheduleId, []);
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(0);
  });

  test('R-FIX: unknown op type → 400 with clear error', async () => {
    const scheduleId = await freshTermSchedule('302');
    const r = await apply(scheduleId, [{ type: 'time-warp', sectionId: '00000000-0000-0000-0000-000000000000' }]);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Unsupported/i);
  });

  test('R-FIX: plan response shape is stable across schedules', async () => {
    const scheduleId = await freshTermSchedule('303');
    const p = await plan(scheduleId);
    // Required fields per Phase 30/33 contract.
    expect(p).toHaveProperty('ops');
    expect(p).toHaveProperty('summary');
    expect(p).toHaveProperty('unresolvedRuleIds');
    expect(p).toHaveProperty('supportedOpTypes');
    expect(p.summary).toHaveProperty('initialHard');
    expect(p.summary).toHaveProperty('initialSoft');
    expect(p.summary).toHaveProperty('remainingHard');
    expect(p.summary).toHaveProperty('remainingSoft');
    expect(p.supportedOpTypes).toContain('reassign-instructor');
    expect(p.supportedOpTypes).toContain('reassign-venue');
    expect(p.supportedOpTypes).toContain('add-day');
    expect(p.supportedOpTypes).toContain('move');
    expect(p.supportedOpTypes).toContain('drop');
  });

  test('R-FIX-13: mixed R-09 + R-10 conflicts → plan covers both', async () => {
    // Two sections, one missing instructor, one missing venue.
    const scheduleId = await freshTermSchedule('281');
    const { courses, instructors, venues } = await getRefs();
    const c1 = await pickFromList(courses, c => c.course_code === 'SWE301');
    const c2 = await pickFromList(courses, c => c.course_code === 'SWE321');
    const hall = venues.find(v => v.type === 'LectureHall');
    await createSection(scheduleId, {
      courseId: c1.id, venueId: hall.id, // no instructor → R-09
      startTime: '10:00', endTime: '10:50',
    });
    await createSection(scheduleId, {
      courseId: c2.id, instructorId: instructors[0].id, // no venue → R-10
      startTime: '11:00', endTime: '11:50',
    });
    const p = await plan(scheduleId);
    // Both R-09 and R-10 should have ops proposed, OR both should
    // disappear from unresolvedRuleIds.
    const unresolved = new Set(p.unresolvedRuleIds ?? []);
    expect(unresolved.has('R-09')).toBe(false);
    expect(unresolved.has('R-10')).toBe(false);
  });

  test('R-FIX-15: applying op that resolves a soft conflict succeeds', async () => {
    // Apply a known-good R-15 add-day op and verify it lands cleanly.
    const scheduleId = await freshTermSchedule('283');
    const { courses, instructors, venues } = await getRefs();
    const c = await pickFromList(courses,
      c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const cr = await createSection(scheduleId, {
      courseId: c.id, instructorId: instructors[0].id,
      venueId: venues.find(v => v.type === 'LectureHall').id,
      days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    expect(cr.status).toBe(201);
    // Delete Tuesday row to trigger R-15.
    const rows = await getSections(scheduleId);
    const tue = rows.find(r => r.courseId === c.id && r.day === 'Tuesday');
    await request(app)
      .delete(`/api/v1/sections/${tue.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);
    // Plan + apply.
    const p = await plan(scheduleId);
    const addDay = p.ops.find(o => o.type === 'add-day');
    expect(addDay).toBeTruthy();
    const ar = await apply(scheduleId, [addDay]);
    expect(ar.status).toBe(200);
    expect(ar.body.applied).toBeGreaterThan(0);
  });

  // NEW-FU-368 (Phase 35): R-FIX-18 — R-02 same-level Graduate with
  // escape. Build a schedule where SWE501 §01 overlaps SWE510 §01 in
  // time (both Graduate), then run Quick Fix. The plan must propose a
  // `move` op for SWE501 (or SWE510 §01) that resolves the soft R-02.
  test('R-FIX-18 (Phase 35): R-02 same-level Graduate → plan proposes move', async () => {
    const scheduleId = await freshTermSchedule('293');
    const { courses, instructors, venues } = await getRefs();
    const gr1 = await pickFromList(courses, c => c.course_code === 'SWE501');
    const gr2 = await pickFromList(courses, c => c.course_code === 'SWE510');
    const hall1 = venues.find(v => v.type === 'LectureHall' && v.name === 'H-201');
    const hall2 = venues.find(v => v.type === 'LectureHall' && v.name === 'H-301');
    expect(gr1 && gr2 && hall1 && hall2).toBeTruthy();
    // SWE501 §01 Mon/Wed 17:00–18:15 (Graduate band, 1 section only → R-02 trigger)
    await createSection(scheduleId, {
      courseId: gr1.id, instructorId: instructors[0].id, venueId: hall1.id,
      sectionNumber: '01', days: ['Monday', 'Wednesday'],
      startTime: '17:00', endTime: '18:15',
    });
    // SWE510 §01 Mon/Wed 17:00–18:15 (overlaps SWE501)
    await createSection(scheduleId, {
      courseId: gr2.id, instructorId: instructors[1].id, venueId: hall2.id,
      sectionNumber: '01', days: ['Monday', 'Wednesday'],
      startTime: '17:00', endTime: '18:15',
    });
    // SWE510 §02 Mon/Wed 18:30–19:45 — gives SWE510 an "escape": some
    // section of SWE510 is free, so R-02 fires SOFT (not HARD) per R02Rule.
    await createSection(scheduleId, {
      courseId: gr2.id, instructorId: instructors[2].id, venueId: hall2.id,
      sectionNumber: '02', days: ['Monday', 'Wednesday'],
      startTime: '18:30', endTime: '19:45',
    });
    // Verify R-02 actually fires in the conflict engine (separate /conflicts
    // endpoint — the plan response has summary + unresolvedRuleIds but
    // not a raw conflict list).
    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body.conflicts;
    const r02 = conflicts.filter(c => c.ruleId === 'R-02');
    expect(r02.length).toBeGreaterThan(0);
    // Then assert the Quick Fix plan offers a move (or compound w/ move) op.
    const planRes = await plan(scheduleId);
    const hasMove = (planRes.ops ?? []).some(op =>
      op.type === 'move' ||
      (op.type === 'compound' && op.subOps?.some(s => s.type === 'move'))
    );
    expect(hasMove).toBe(true);
  });

  // NEW-FU-369 (Phase 35): R-FIX-19 — saturated Graduate window. When
  // the entire 16:00-22:00 band is full of Graduate courses, no simple
  // `move` slot is free for SWE501. The Phase 35 compound fallback
  // proposes `move + reassign-instructor` so an alternative instructor's
  // free-slot opens up. Even when no fix is found the resolver MUST
  // return a plan (possibly with `unresolvedRuleIds` containing R-02)
  // rather than crashing.
  test('R-FIX-19 (Phase 35): Quick Fix degrades gracefully on saturated Graduate window', async () => {
    // Phase 35 expanded TERM_CODE_MAX to 343 (Summer 2034); pick 343 as a
    // fresh-and-unused code at the top of the range.
    const scheduleId = await freshTermSchedule('343');
    const { courses, instructors, venues } = await getRefs();
    const gr1 = await pickFromList(courses, c => c.course_code === 'SWE501');
    const gr2 = await pickFromList(courses, c => c.course_code === 'SWE510');
    const hall = venues.find(v => v.type === 'LectureHall');
    // Single section each, both at the exact same Graduate slot.
    await createSection(scheduleId, {
      courseId: gr1.id, instructorId: instructors[0].id, venueId: hall.id,
      sectionNumber: '01', days: ['Monday', 'Wednesday'],
      startTime: '17:00', endTime: '18:15',
    });
    await createSection(scheduleId, {
      courseId: gr2.id, instructorId: instructors[1].id, venueId: hall.id,
      sectionNumber: '01', days: ['Monday', 'Wednesday'],
      startTime: '17:00', endTime: '18:15',
    });
    const planRes = await plan(scheduleId);
    // Must return a plan response (no crash) — either ops to apply or
    // unresolvedRuleIds explaining the gap.
    expect(planRes).toBeDefined();
    expect(Array.isArray(planRes.ops)).toBe(true);
    const hasOpsOrUnresolved =
      (planRes.ops?.length ?? 0) > 0 ||
      (planRes.unresolvedRuleIds?.length ?? 0) > 0;
    expect(hasOpsOrUnresolved).toBe(true);
  });
});
