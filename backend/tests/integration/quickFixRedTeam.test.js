// NEW-FU-355 (Phase 34): adversarial red-team battery for Quick Fix.
// Phase 29 introduced the resolver, Phases 30-33 expanded coverage and
// op types. This battery proves the resolver handles every realistic
// conflict scenario AND degrades gracefully on cases it doesn't
// support (so the user sees a clear "manual fix needed" instead of a
// silent no-op).

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
  // NEW-FU-673: SQL-level wipe of the auto-cloned sections (one shot; never trips FU-609's
  // row→group coercion mid-loop). The term's OWNED resources survive.
  await query(`DELETE FROM sections WHERE schedule_id = $1`, [sched.id]);
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

// NEW-FU-673: resources VALID FOR THIS TERM — owned by `code` OR template (owner IS NULL).
// Post-FU-645 the global GET lists also include OTHER terms' owner-scoped copies, so picking
// `instructors[0]` / `courses.find(...)` from them grabs a resource owned by another term →
// section-create 409 "belongs to term X". Query directly (GETs don't expose owner_semester).
// `name`/`course_code`/`academic_level` ride along so tests can pick by code or level. The
// QuickFix RESOLVER, however, only reassigns to the term's OWN (owner = code) pool, so tests
// whose assertion needs a reassign target use a rich-season code (xx1/xx2) that owns one.
async function getRefs(code) {
  const courses = (await query(
    `SELECT id, credits, has_lab, category, course_code, academic_level FROM courses
      WHERE owner_semester = $1 OR owner_semester IS NULL`, [code])).rows
    .map(c => ({ ...c, credits: Number(c.credits) }));
  const instructors = (await query(
    `SELECT id, name FROM instructors
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows;
  const venues = (await query(
    `SELECT id, type, name FROM venues
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows;
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
    // NEW-FU-673: rich Fall code '271' (owns LectureHalls so the resolver can reassign one of
    // the double-booked sections) + real course codes (SWE 316/SWE 326 exist; "SWE301" doesn't).
    const scheduleId = await freshTermSchedule('271');
    const { courses, instructors, venues } = await getRefs('271');
    const c1 = await pickFromList(courses, c => c.course_code === 'SWE 316');
    const c2 = await pickFromList(courses, c => c.course_code === 'SWE 326');
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
    // NEW-FU-673: Fall code '281' owns instructors + venues (the resolver's reassign pool).
    // Real course codes (SWE 316/SWE 326). FU-475 made missing instructor/venue HARD create-time
    // blocks, so seed both gap states at the DB level after creating valid sections.
    const scheduleId = await freshTermSchedule('281');
    const { courses, instructors, venues } = await getRefs('281');
    const c1 = await pickFromList(courses, c => c.course_code === 'SWE 316');
    const c2 = await pickFromList(courses, c => c.course_code === 'SWE 326');
    const hall = venues.find(v => v.type === 'LectureHall');
    const s1 = await createSection(scheduleId, {
      courseId: c1.id, instructorId: instructors[0].id, venueId: hall.id,
      startTime: '10:00', endTime: '10:50',
    });
    const s2 = await createSection(scheduleId, {
      courseId: c2.id, instructorId: instructors[1].id, venueId: hall.id,
      startTime: '11:00', endTime: '11:50',
    });
    expect(s1.status).toBe(201);
    expect(s2.status).toBe(201);
    // c1 → no instructor (R-09); c2 → no venue (R-10).
    await query(`UPDATE sections SET instructor_id = NULL WHERE schedule_id = $1 AND course_id = $2`, [scheduleId, c1.id]);
    await query(`UPDATE sections SET venue_id = NULL      WHERE schedule_id = $1 AND course_id = $2`, [scheduleId, c2.id]);
    const p = await plan(scheduleId);
    // Both R-09 and R-10 should have ops proposed, OR both should
    // disappear from unresolvedRuleIds.
    const unresolved = new Set(p.unresolvedRuleIds ?? []);
    expect(unresolved.has('R-09')).toBe(false);
    expect(unresolved.has('R-10')).toBe(false);
  });

  test('R-FIX-15: applying op that resolves a soft conflict succeeds', async () => {
    // Apply a known-good R-15 add-day op and verify it lands cleanly.
    // NEW-FU-673: rich Fall code '341' so the add-day apply re-adds the day onto a term-owned
    // instructor/venue. Real course filter (any 3cr no-lab UG).
    const scheduleId = await freshTermSchedule('341');
    const { courses, instructors, venues } = await getRefs('341');
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
    // NEW-FU-673: DB-level delete (FU-609 would coerce a per-row API delete of a multi-day group
    // into a whole-group delete, so R-15 wouldn't fire).
    const rows = await getSections(scheduleId);
    const tue = rows.find(r => r.courseId === c.id && r.day === 'Tuesday');
    await query(`DELETE FROM sections WHERE id = $1`, [tue.id]);
    // Plan + apply.
    const p = await plan(scheduleId);
    const addDay = p.ops.find(o => o.type === 'add-day');
    expect(addDay).toBeTruthy();
    const ar = await apply(scheduleId, [addDay]);
    expect(ar.status).toBe(200);
    expect(ar.body.applied).toBeGreaterThan(0);
  });

  // R-FIX-18: R-02 adjacent-level overlap WITH escape → SOFT → the plan must propose a `move`.
  // NEW-FU-673: the original "same-level Graduate" scenario no longer fires R-02 — FU-275
  // (Phase 52 #2) made grad↔grad overlap ALLOWED (R02Rule skips when both sides are Graduate),
  // and a Senior↔Graduate adjacent pair can't time-overlap (UG window ends 17:10, GR starts
  // 17:20). So this exercises the SAME resolver move-op path via a valid R-02 trigger: two
  // adjacent UG levels — SWE 316 (Junior) + SWE 402 (Senior) — overlapping, with SWE 402
  // carrying a second free section so R-02 is SOFT (escape exists) per R02Rule.
  test('R-FIX-18 (Phase 35): R-02 adjacent-level (soft, with escape) → plan proposes move', async () => {
    const scheduleId = await freshTermSchedule('292');
    const { courses, instructors, venues } = await getRefs('292');
    const junior = await pickFromList(courses, c => c.course_code === 'SWE 316');
    const senior = await pickFromList(courses, c => c.course_code === 'SWE 402');
    const halls = venues.filter(v => v.type === 'LectureHall');
    expect(junior && senior && halls.length >= 3).toBeTruthy();
    // SWE 316 §01 Mon/Wed 10:00–11:15 (1 section only → R-02 trigger for the Junior side)
    await createSection(scheduleId, {
      courseId: junior.id, instructorId: instructors[0].id, venueId: halls[0].id,
      sectionNumber: '01', days: ['Monday', 'Wednesday'],
      startTime: '10:00', endTime: '11:15',
    });
    // SWE 402 §01 Mon/Wed 10:00–11:15 (overlaps SWE 316)
    await createSection(scheduleId, {
      courseId: senior.id, instructorId: instructors[1].id, venueId: halls[1].id,
      sectionNumber: '01', days: ['Monday', 'Wednesday'],
      startTime: '10:00', endTime: '11:15',
    });
    // SWE 402 §02 Mon/Wed 11:30–12:45 — gives SWE 402 an "escape": a free section
    // exists, so R-02 fires SOFT (not HARD) per R02Rule.
    await createSection(scheduleId, {
      courseId: senior.id, instructorId: instructors[2].id, venueId: halls[2].id,
      sectionNumber: '02', days: ['Monday', 'Wednesday'],
      startTime: '11:30', endTime: '12:45',
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
    // NEW-FU-673: Spring code '342' OWNS Graduate courses (SWE 516/545); use real codes and a
    // GR-window time (17:30, since a 17:00 GR start is rejected 400 by R-06 at create).
    const scheduleId = await freshTermSchedule('342');
    const { courses, instructors, venues } = await getRefs('342');
    const gr1 = await pickFromList(courses, c => c.course_code === 'SWE 516');
    const gr2 = await pickFromList(courses, c => c.course_code === 'SWE 545');
    const hall = venues.find(v => v.type === 'LectureHall');
    expect(gr1 && gr2 && hall).toBeTruthy();
    // Single section each, both at the exact same Graduate slot.
    await createSection(scheduleId, {
      courseId: gr1.id, instructorId: instructors[0].id, venueId: hall.id,
      sectionNumber: '01', days: ['Monday', 'Wednesday'],
      startTime: '17:30', endTime: '18:45',
    });
    await createSection(scheduleId, {
      courseId: gr2.id, instructorId: instructors[1].id, venueId: hall.id,
      sectionNumber: '01', days: ['Monday', 'Wednesday'],
      startTime: '17:30', endTime: '18:45',
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
