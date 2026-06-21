// NEW-FU-172: Integration tests for /api/v1/terms.
//
// Uses supertest against the live express app instance (no separate test
// DB — we track every term we create and clean them up in afterAll, so
// the suite is idempotent + safe to re-run against a dev DB.
//
// To run: `npm run test:int -- terms.test.js`
//
// Requires: backend dependencies installed + a seeded DB (the default
// 'SWE-DEPT' department with '251' as the existing schedule — migrated
// from legacy 'Fall-2025' via migration 011).

const request = require('supertest');
const app     = require('../../src/app');

const ADMIN     = { username: 'admin1',     password: 'password123' };
const SCHEDULER = { username: 'scheduler1', password: 'password123' };

// Track term codes created during tests so we can clean them up regardless
// of which test threw. Each test that POSTs a term should push to this set.
const createdCodes = new Set();

async function login(creds) {
  const res = await request(app).post('/api/v1/auth/login').send(creds);
  expect(res.status).toBe(200);
  return res.body.token;
}

let adminTok, schedulerTok;

beforeAll(async () => {
  adminTok     = await login(ADMIN);
  schedulerTok = await login(SCHEDULER);
});

afterAll(async () => {
  // Clean up every test-created term. Use admin token + activeCode '251'
  // (the seed default) so the delete is never targeted at the active term.
  for (const code of createdCodes) {
    await request(app)
      .delete(`/api/v1/terms/${code}`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
  }
});

describe('GET /api/v1/terms', () => {
  test('returns 401 without auth', async () => {
    const r = await request(app).get('/api/v1/terms');
    expect(r.status).toBe(401);
  });

  test('returns the seed 251 (Fall 2025) term with stats', async () => {
    const r = await request(app)
      .get('/api/v1/terms')
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const fall = r.body.find(t => t.code === '251');
    expect(fall).toBeTruthy();
    expect(fall.isActive).toBe(true);
    expect(fall.sectionCount).toBeGreaterThan(0);
    expect(fall.courseCount).toBeGreaterThan(0);
    expect(fall.instructorCount).toBeGreaterThan(0);
    expect(fall.venueCount).toBeGreaterThan(0);
  });

  test('scheduler can read terms (open to any authenticated user)', async () => {
    const r = await request(app)
      .get('/api/v1/terms')
      .set('Authorization', `Bearer ${schedulerTok}`);
    expect(r.status).toBe(200);
  });
});

describe('POST /api/v1/terms', () => {
  test('admin can create a Fall term (seeds from template)', async () => {
    const code = '291'; // Fall 2029 — unlikely to collide with manual testing
    createdCodes.add(code);
    const r = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code });
    expect(r.status).toBe(201);
    expect(r.body.code).toBe(code);
    expect(r.body.label).toBe('Fall 2029');
    expect(r.body.isSummer).toBe(false);
    expect(r.body.season).toBe('Fall');
    // Should be seeded from the existing 251 (Fall 2025) schedule
    expect(r.body.sectionCount).toBeGreaterThan(0);
  });

  test('admin can create a Summer term (blank)', async () => {
    const code = '293'; // Summer 2030
    createdCodes.add(code);
    const r = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code });
    expect(r.status).toBe(201);
    expect(r.body.code).toBe(code);
    expect(r.body.isSummer).toBe(true);
    expect(r.body.sectionCount).toBe(0);
    expect(r.body.courseCount).toBe(0);
  });

  test('duplicate code returns 409', async () => {
    const code = '291';
    const r = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already exists/i);
  });

  test('invalid code returns 400', async () => {
    const cases = ['abc', '254', '2', '2510'];
    for (const code of cases) {
      const r = await request(app)
        .post('/api/v1/terms')
        .set('Authorization', `Bearer ${adminTok}`)
        .send({ code });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/Invalid term code/i);
    }
  });

  // NEW-FU-219: range guard. Tests every "interesting" boundary so
  // changing CODE_MIN/CODE_MAX in the future surfaces clearly.
  // NEW-FU-371 (Phase 35): TERM_CODE_MAX bumped 303 → 343 so the
  // red-team battery has unused codes. Updated assertions to match.
  test('out-of-range code returns 400 with "range" in the error', async () => {
    // All have valid YYT shape but lie outside 251–343.
    const tooOld   = ['241', '242', '243', '231', '211', '111'];
    const tooNew   = ['351', '361', '371', '381', '991'];
    for (const code of [...tooOld, ...tooNew]) {
      const r = await request(app)
        .post('/api/v1/terms')
        .set('Authorization', `Bearer ${adminTok}`)
        .send({ code });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/range/i);
      expect(r.body.error).toMatch(/251/);   // both bounds should appear in
      expect(r.body.error).toMatch(/343/);   // the message for clarity
    }
  });

  test('boundary codes 251 + 343 are accepted', async () => {
    // 251 is the seed (already exists) → returns 409 from the dup check.
    // That's still "accepted" by the range guard — what we're proving
    // here is that 251 doesn't get rejected with a 400-range message.
    const r251 = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code: '251' });
    expect(r251.status).toBe(409);
    expect(r251.body.error).not.toMatch(/range/i);

    // 343 is the new upper bound (Phase 35, Summer 2034) and
    // (likely) unseeded — should succeed.
    const code = '343';
    createdCodes.add(code);
    const r343 = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code });
    expect(r343.status).toBe(201);
  });

  test('non-admin cannot create (403)', async () => {
    const r = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${schedulerTok}`)
      .send({ code: '299' });
    expect(r.status).toBe(403);
  });
});

describe('DELETE /api/v1/terms/:code', () => {
  test('admin can delete a non-active term', async () => {
    const code = '292'; // Spring 2030
    createdCodes.add(code);
    await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code });
    const r = await request(app)
      .delete(`/api/v1/terms/${code}`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBeDefined();
    expect(typeof r.body.deleted.sections).toBe('number');
    createdCodes.delete(code); // already deleted — don't try again in afterAll
  });

  test('admin CAN delete the active term in place (NEW-FU-590)', async () => {
    // Batch 25: deleting the term you're currently viewing is now allowed — the
    // client auto-switches afterward. Simulate "active" by passing activeCode = code.
    const code = '263';
    await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code });
    const r = await request(app)
      .delete(`/api/v1/terms/${code}`)
      .query({ activeCode: code }) // same as the deleted term ⇒ "active"
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBeDefined();
  });

  test('non-admin cannot delete (403)', async () => {
    const r = await request(app)
      .delete(`/api/v1/terms/291`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${schedulerTok}`);
    expect(r.status).toBe(403);
  });

  test('non-existent term returns 404', async () => {
    const r = await request(app)
      .delete(`/api/v1/terms/999`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(404);
  });
});

describe('PATCH /api/v1/terms/:code (rename)', () => {
  // Reminder: valid codes are YYT where T ∈ {1,2,3}. Codes ending in 4–9
  // are deliberately rejected by decodeTerm. Use 281/282/283 etc.
  test('admin can rename a non-active term', async () => {
    const from = '281';
    const to   = '282';
    createdCodes.add(from);
    createdCodes.add(to);
    await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code: from });
    const r = await request(app)
      .patch(`/api/v1/terms/${from}`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ newCode: to });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(to);
    // The "from" code no longer exists post-rename — drop from cleanup.
    createdCodes.delete(from);
  });

  test('rename to existing code returns 409', async () => {
    const code = '283';
    createdCodes.add(code);
    await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code });
    // Try to rename to the seed code 251.
    const r = await request(app)
      .patch(`/api/v1/terms/${code}`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ newCode: '251' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already exists/i);
  });

  test('rename with invalid new code returns 400', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/282`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ newCode: 'xyz' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid term code/i);
  });

  test('CAN rename the active term in place (NEW-FU-584)', async () => {
    // Batch 25: renaming the term you're viewing is allowed — the schedule id is
    // unchanged, so the client keeps viewing under the new code.
    const from = '311', to = '312'; // both in the 251–343 valid range, unused
    createdCodes.add(to); // surviving code — clean up in afterAll
    await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code: from });
    const r = await request(app)
      .patch(`/api/v1/terms/${from}`)
      .query({ activeCode: from }) // renaming the active term
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ newCode: to });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(to);
  });

  test('non-admin cannot rename (403)', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/282`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${schedulerTok}`)
      .send({ newCode: '272' });
    expect(r.status).toBe(403);
  });

  // NEW-FU-219: range guard on rename. Renaming an existing term to an
  // out-of-range code is the other path through which a bad code could
  // sneak in; assertTermCodeInRange covers it the same way.
  test('rename to out-of-range code returns 400', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/282`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ newCode: '241' }); // pre-251, valid shape, out of range
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/range/i);
  });
});

describe('PATCH /api/v1/terms/:code/status (NEW-FU-189)', () => {
  test('admin can transition Draft → Finalized (when no hard conflicts)', async () => {
    const code = '271';
    createdCodes.add(code);
    await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code });
    const r = await request(app)
      .patch(`/api/v1/terms/${code}/status`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'Finalized' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('Finalized');
    // Re-list should reflect new status.
    const list = await request(app)
      .get('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`);
    const updated = list.body.find(t => t.code === code);
    expect(updated.status).toBe('Finalized');
  });

  test('admin can flip back Finalized → Draft', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/271/status`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'Draft' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('Draft');
  });

  test('invalid status returns 400', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/271/status`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'NotARealStatus' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid status/i);
  });

  test('non-existent term returns 404', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/999/status`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'Draft' });
    expect(r.status).toBe(404);
  });

  test('non-admin cannot change status (403)', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/271/status`)
      .set('Authorization', `Bearer ${schedulerTok}`)
      .send({ status: 'Finalized' });
    expect(r.status).toBe(403);
  });
});

// NEW-FU-197: Conflict-guarded Finalize integration test.
//
// Reproduces the FU-189 guardrail end-to-end:
//   1. Create a fresh term (seeds from 251)
//   2. Locate the new term's scheduleId via listSchedules
//   3. Pick an existing seeded section (every Fall term inherits ≥1 section
//      with non-null instructorId from the 251 template)
//   4. Find a course distinct from that section's course
//   5. POST a hard-conflicting section (same instructor + day + time, but
//      a different course → R-1 instructor double-booking)
//   6. Verify conflicts endpoint reports ≥1 hard conflict
//   7. PATCH .../status with Finalized → expect 422 + hardCount in details
//   8. Verify the term is still Draft via /terms list
//
// Why this lives in the integration suite: the guard reads from the
// `conflicts` table, which is populated as a side-effect of section
// CRUD via revalidateSchedule. A pure unit test can mock the count but
// can't verify the round-trip from section-create → conflicts-row →
// status-guard. This test exercises the whole path.
describe('Conflict-guarded Finalize (NEW-FU-197)', () => {
  // Fall code (T===1) is REQUIRED — the test seeds a conflict by reusing an
  // instructor + venue + timeslot already present in the inherited
  // section set. Spring/Summer codes create blank schedules with no
  // sections to clone-conflict against.
  const HARD_CONFLICT_CODE = '281'; // Fall 2028

  test('Finalize blocked by hard conflict (422)', async () => {
    createdCodes.add(HARD_CONFLICT_CODE);

    // 1. Create the term (Fall semester convention copies from 251)
    const created = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code: HARD_CONFLICT_CODE });
    expect(created.status).toBe(201);

    // 2. Find scheduleId for this term in the default SWE-DEPT department.
    const schedsRes = await request(app)
      .get('/api/v1/departments/SWE-DEPT/schedules')
      .set('Authorization', `Bearer ${adminTok}`);
    expect(schedsRes.status).toBe(200);
    const sched = schedsRes.body.find(s => s.semester === HARD_CONFLICT_CODE);
    expect(sched).toBeTruthy();
    const scheduleId = sched.id;

    // 3. Pick a seeded section with a non-null instructor + venue.
    //    Defensive: HARD_CONFLICT_CODE must be a Fall code (T===1) because
    //    Spring/Summer terms seed blank — they'd have no sections to
    //    conflict against.
    expect(HARD_CONFLICT_CODE).toMatch(/^\d{2}1$/);

    const sectsRes = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(sectsRes.status).toBe(200);
    const sections = sectsRes.body.sections || sectsRes.body;
    // NEW-FU-237: prefer a base section whose day is in the STT triple
    // so the conflicting STT section we post below is guaranteed to
    // overlap. Falls back to any base if the seed only has Mon/Wed
    // sections (unlikely — STT is the dominant pattern at KFUPM).
    // NEW-FU-Phase31-test-fix: tighten the base filter further. The
    // sectionPattern validator requires (credits, has_lab, duration)
    // to map to a legal day-template; 3cr no-lab is STT@50 ONLY. So
    // when we POST a 3cr-no-lab conflict section, the days MUST be
    // STT and the duration MUST be 50min. To guarantee we can mirror
    // the base's time+days, prefer a base that's ALREADY 50min on an
    // STT day. Falls back to any base if such doesn't exist.
    function isFiftyMin(s) {
      const start = (s.startTime || '').substring(0,5);
      const end   = (s.endTime   || '').substring(0,5);
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      return (eh*60+em) - (sh*60+sm) === 50;
    }
    const STT_DAY_NAMES = ['Sunday', 'Tuesday', 'Thursday'];
    const base = sections.find(s => s.instructorId && s.venueId && isFiftyMin(s) && STT_DAY_NAMES.includes(s.day))
              ?? sections.find(s => s.instructorId && s.venueId);
    expect(base).toBeTruthy();

    // 4. Find a different course to pair with the same instructor+time.
    const coursesRes = await request(app)
      .get('/api/v1/courses')
      .set('Authorization', `Bearer ${adminTok}`);
    // NEW-FU-237: the pattern validator (FU-236) restricts a 3-credit
    // Lec to STT 50min / MW 75min / etc. To stay conforming with the
    // new rules while still creating an instructor double-booking
    // conflict, pick a DIFFERENT 3-credit non-lab course and post an
    // STT 50min section that overlaps with `base` on at least one day.
    const otherCourse = coursesRes.body.find(c =>
      c.id !== base.courseId &&
      Number(c.credits) === 3 &&
      !c.has_lab
    );
    expect(otherCourse).toBeTruthy();

    // 5. Insert the hard-conflicting section. We mirror the BASE's
    //    EXACT day pattern + time so the overlap is guaranteed
    //    regardless of what the auto-clone produced.
    //
    //    NEW-FU-Phase29-test-fix: also derive the DAY pattern from the
    //    base, not hardcoded STT. The clone source may switch between
    //    STT and MW depending on prior test state (other tests may
    //    have run Suggest on the source term, leaving it MW). Picking
    //    base's day pattern guarantees the overlap regardless.
    //    Trim seconds off the time strings — Postgres returns HH:MM:SS
    //    but the create endpoint expects HH:MM.
    const baseStart = (base.startTime || '').substring(0, 5);
    const baseEnd   = (base.endTime   || '').substring(0, 5);
    // STT days → STT triple. MW days → MW pair. Single-day patterns
    // and other rare cases use just the base's day.
    const STT_DAYS = ['Sunday', 'Tuesday', 'Thursday'];
    const MW_DAYS  = ['Monday', 'Wednesday'];
    const ST_DAYS  = ['Sunday', 'Tuesday'];
    const TT_DAYS  = ['Tuesday', 'Thursday'];
    let conflictDays;
    if (STT_DAYS.includes(base.day))      conflictDays = STT_DAYS;
    else if (MW_DAYS.includes(base.day))  conflictDays = MW_DAYS;
    else if (ST_DAYS.includes(base.day))  conflictDays = ST_DAYS;
    else if (TT_DAYS.includes(base.day))  conflictDays = TT_DAYS;
    else                                  conflictDays = [base.day];
    const conflictPost = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseId:      otherCourse.id,
        instructorId:  base.instructorId,
        venueId:       base.venueId,
        sectionNumber: '49',
        sectionType:   'Lec',
        days:          conflictDays,
        startTime:     baseStart,
        endTime:       baseEnd,
      });
    expect(conflictPost.status).toBe(201);

    // 6. Verify the conflict engine flagged this as hard.
    const conflictsRes = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(conflictsRes.status).toBe(200);
    const conflicts = conflictsRes.body.conflicts || conflictsRes.body;
    const hardCount = conflicts.filter(c => c.severity === 'Hard').length;
    expect(hardCount).toBeGreaterThan(0);

    // 7. The guardrail fires: 422 + details.hardCount.
    const finalizeRes = await request(app)
      .patch(`/api/v1/terms/${HARD_CONFLICT_CODE}/status`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'Finalized' });
    expect(finalizeRes.status).toBe(422);
    expect(finalizeRes.body.error).toMatch(/hard conflict/i);
    expect(finalizeRes.body.details?.hardCount).toBeGreaterThan(0);

    // 8. The term must remain Draft — guard short-circuits before write.
    const listRes = await request(app)
      .get('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`);
    const updated = listRes.body.find(t => t.code === HARD_CONFLICT_CODE);
    expect(updated.status).toBe('Draft');
  });
});

// NEW-FU-195: Archive flow integration tests.
//
// Covered:
//   • PATCH .../archive  hides the term from the default list
//   • ?includeArchived=true surfaces it back with isArchived:true + archivedAt
//   • PATCH .../unarchive restores it to the default view
//   • CAN archive the active term in place (NEW-FU-590)
//   • Idempotent: archive on an already-archived row is a no-op
//   • Non-admin gets 403 on both archive + unarchive
//   • 404 on non-existent codes
//
// Out of scope for this suite (would need section-creation scaffolding):
//   • The conflict-guarded Finalize case (FU-189). Creating a hard conflict
//     requires colliding-section POSTs against a fresh schedule, which is
//     test-harness work we can layer on top later. For now the happy-path
//     Finalize test above covers the supported transition; the guardrail
//     itself is exercised by the unit tests in TermService.spec.js.
describe('Archive flow (NEW-FU-194 / FU-195)', () => {
  const ARCHIVE_CODE = '321'; // Fall 2032 — in 251–343 range, unused & NOT seeded
                              // (was '261', which later became a seed term → create 409)

  beforeAll(async () => {
    // Seed the term we'll archive. Tracked in createdCodes so afterAll
    // hard-deletes it (DELETE works regardless of archived_at state).
    createdCodes.add(ARCHIVE_CODE);
    const r = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code: ARCHIVE_CODE });
    expect(r.status).toBe(201);
  });

  test('CAN archive the active term in place (NEW-FU-590)', async () => {
    // Batch 25: archiving the term you're viewing is allowed — the client switches
    // to another non-archived term first. Simulate "active" by passing activeCode = code.
    const code = '313'; // in the 251–343 valid range, unused
    createdCodes.add(code); // afterAll hard-deletes regardless of archived state
    await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code });
    const r = await request(app)
      .patch(`/api/v1/terms/${code}/archive`)
      .query({ activeCode: code })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.isArchived).toBe(true);
  });

  test('admin can archive a non-active term', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/${ARCHIVE_CODE}/archive`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.isArchived).toBe(true);
  });

  test('archived term is hidden from the default list', async () => {
    const r = await request(app)
      .get('/api/v1/terms')
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    const hit = r.body.find(t => t.code === ARCHIVE_CODE);
    expect(hit).toBeUndefined();
  });

  test('archived term shows up with ?includeArchived=true', async () => {
    const r = await request(app)
      .get('/api/v1/terms')
      .query({ activeCode: '251', includeArchived: 'true' })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    const hit = r.body.find(t => t.code === ARCHIVE_CODE);
    expect(hit).toBeTruthy();
    expect(hit.isArchived).toBe(true);
    expect(hit.archivedAt).toBeTruthy();
    // ISO-8601 round-trip sanity — server should be returning a string.
    expect(typeof hit.archivedAt).toBe('string');
  });

  test('archiving an already-archived term is idempotent', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/${ARCHIVE_CODE}/archive`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.alreadyArchived).toBe(true);
  });

  test('non-admin cannot archive (403)', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/${ARCHIVE_CODE}/archive`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${schedulerTok}`);
    expect(r.status).toBe(403);
  });

  test('archive on non-existent term returns 404', async () => {
    const r = await request(app)
      .patch('/api/v1/terms/999/archive')
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(404);
  });

  test('admin can unarchive a term', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/${ARCHIVE_CODE}/unarchive`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.isArchived).toBe(false);
  });

  test('unarchived term reappears in the default list', async () => {
    const r = await request(app)
      .get('/api/v1/terms')
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
    const hit = r.body.find(t => t.code === ARCHIVE_CODE);
    expect(hit).toBeTruthy();
    expect(hit.isArchived).toBe(false);
    expect(hit.archivedAt).toBeNull();
  });

  test('unarchive on an already-active term is idempotent', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/${ARCHIVE_CODE}/unarchive`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.alreadyUnarchived).toBe(true);
  });

  test('non-admin cannot unarchive (403)', async () => {
    const r = await request(app)
      .patch(`/api/v1/terms/${ARCHIVE_CODE}/unarchive`)
      .set('Authorization', `Bearer ${schedulerTok}`);
    expect(r.status).toBe(403);
  });

  test('unarchive on non-existent term returns 404', async () => {
    const r = await request(app)
      .patch('/api/v1/terms/999/unarchive')
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(404);
  });

  // NEW-FU-201: archived schedules reject every write endpoint that
  // touches their sections. The guard lives in
  // schedSvc.assertSchedulerEditableLocked (+ inline checks in save and
  // suggest), so adding the archived_at clause to that one helper covers
  // five upstream endpoints.
  describe('Archived schedule blocks section writes (NEW-FU-201)', () => {
    // NEW-FU-217: range guard rejects pre-251. Use the highest in-range
    // Fall code (301 = Fall 2030) so the seed-from-template path stays
    // valid (Fall semesters inherit from the active 251) and we don't
    // collide with the other Fall codes (251/261/271/281/291).
    const RO_CODE = '301';
    let scheduleId;
    let seedSection;

    beforeAll(async () => {
      createdCodes.add(RO_CODE);

      // 1. Create the term + seed from 251.
      const createRes = await request(app)
        .post('/api/v1/terms')
        .set('Authorization', `Bearer ${adminTok}`)
        .send({ code: RO_CODE });
      expect(createRes.status).toBe(201);

      // 2. Resolve scheduleId via departments → schedules.
      const schedsRes = await request(app)
        .get('/api/v1/departments/SWE-DEPT/schedules')
        .set('Authorization', `Bearer ${adminTok}`);
      scheduleId = schedsRes.body.find(s => s.semester === RO_CODE).id;

      // 3. Grab one seeded section so we have a sectionId for PUT/DELETE.
      // NEW-FU-237: prefer a 3-credit Lec section so the POST test
      // below can use the canonical STT 50-min pattern with the same
      // courseId — keeps the test in the legal pattern space.
      const sectsRes = await request(app)
        .get(`/api/v1/schedules/${scheduleId}/sections`)
        .set('Authorization', `Bearer ${adminTok}`);
      const coursesRes = await request(app)
        .get('/api/v1/courses')
        .set('Authorization', `Bearer ${adminTok}`);
      const threeCreditIds = new Set(
        coursesRes.body.filter(c => Number(c.credits) === 3 && !c.has_lab).map(c => c.id)
      );
      const list = sectsRes.body.sections || sectsRes.body;
      seedSection =
        list.find(s => threeCreditIds.has(s.courseId) && s.sectionType === 'Lec') ||
        list[0];
      expect(seedSection).toBeTruthy();

      // 4. Archive the term — that's the precondition under test.
      const archiveRes = await request(app)
        .patch(`/api/v1/terms/${RO_CODE}/archive`)
        .query({ activeCode: '251' })
        .set('Authorization', `Bearer ${adminTok}`);
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.isArchived).toBe(true);
    });

    test('POST /sections refuses on archived schedule (409)', async () => {
      // NEW-FU-237: use a KFUPM-conformant STT 50min pattern so the
      // pattern validator passes and we reach the archive check (which
      // is what this test is actually verifying). Without conformance
      // the section is rejected at 400 BEFORE the archive guard fires
      // — masking the real test.
      const r = await request(app)
        .post(`/api/v1/schedules/${scheduleId}/sections`)
        .set('Authorization', `Bearer ${adminTok}`)
        .send({
          courseId:      seedSection.courseId,
          instructorId:  seedSection.instructorId,
          venueId:       seedSection.venueId,
          sectionNumber: '49',
          sectionType:   'Lec',
          days:          ['Sunday', 'Tuesday', 'Thursday'],
          startTime:     '09:00',
          endTime:       '09:50',
        });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/archived/i);
    });

    test('PUT /sections refuses on archived schedule (409)', async () => {
      // infoOnly:true routes to updateSectionInfo (not assignSection) so
      // the minimal payload doesn't need day/startTime/endTime — the
      // controller validates those for the move-day path.
      const r = await request(app)
        .put(`/api/v1/sections/${seedSection.id}`)
        .set('Authorization', `Bearer ${adminTok}`)
        .send({ infoOnly: true, sectionNumber: '02' });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/archived/i);
    });

    test('DELETE /sections refuses on archived schedule (409)', async () => {
      const r = await request(app)
        .delete(`/api/v1/sections/${seedSection.id}`)
        .set('Authorization', `Bearer ${adminTok}`);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/archived/i);
    });

    test('POST /suggest refuses on archived schedule (409)', async () => {
      // Suggest requires a non-empty courseConfigs (input validation runs
      // before the archive guard). Send a single valid config so we reach
      // the service-layer check.
      const r = await request(app)
        .post(`/api/v1/schedules/${scheduleId}/suggest`)
        .set('Authorization', `Bearer ${adminTok}`)
        .send({ courseConfigs: [{ courseId: seedSection.courseId, sections: 1 }] });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/archived/i);
    });

    test('POST /save refuses on archived schedule (409)', async () => {
      const r = await request(app)
        .post(`/api/v1/schedules/${scheduleId}/save`)
        .set('Authorization', `Bearer ${adminTok}`)
        .send({ confirmSoft: false });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/archived/i);
    });

    test('GET /sections still works on archived schedule (read-only)', async () => {
      // Reads must remain available so admins can inspect historical state.
      const r = await request(app)
        .get(`/api/v1/schedules/${scheduleId}/sections`)
        .set('Authorization', `Bearer ${adminTok}`);
      expect(r.status).toBe(200);
      const list = r.body.sections || r.body;
      expect(Array.isArray(list)).toBe(true);
    });

    test('GET /conflicts still works on archived schedule (read-only)', async () => {
      const r = await request(app)
        .get(`/api/v1/schedules/${scheduleId}/conflicts`)
        .set('Authorization', `Bearer ${adminTok}`);
      expect(r.status).toBe(200);
    });

    test('writes succeed again after unarchive (round-trip sanity)', async () => {
      const unarchiveRes = await request(app)
        .patch(`/api/v1/terms/${RO_CODE}/unarchive`)
        .set('Authorization', `Bearer ${adminTok}`);
      expect(unarchiveRes.status).toBe(200);
      // PUT now succeeds — same infoOnly path as the 409 case above.
      //
      // NEW-FU-Phase29-test-fix: rename to an unused sectionNumber.
      // The hardcoded '03' collided with an existing seed section
      // when the auto-clone source had multi-section data (Phase 29's
      // sibling-spread bump made certain clone sources end up with
      // a §03 already populated). Pick a value certain to be free
      // by reading the current list and adding 1 to the max number.
      const sxBefore = await request(app)
        .get(`/api/v1/schedules/${scheduleId}/sections`)
        .set('Authorization', `Bearer ${adminTok}`);
      const existingNums = (sxBefore.body.sections || sxBefore.body)
        .filter(s => s.courseId === seedSection.courseId)
        .map(s => Number(s.sectionNumber) || 0);
      const maxN = existingNums.length ? Math.max(...existingNums) : 0;
      const freeNum = String(maxN + 1).padStart(2, '0');
      const r = await request(app)
        .put(`/api/v1/sections/${seedSection.id}`)
        .set('Authorization', `Bearer ${adminTok}`)
        .send({ infoOnly: true, sectionNumber: freeNum });
      expect(r.status).toBe(200);
    });
  });

  // NEW-FU-199: archived terms reject status changes at the API.
  // The UI already hides the lock button on archived rows, but a direct
  // PATCH /status call would previously succeed — silently violating the
  // "archived = frozen" invariant. The 409 makes the contract explicit.
  test('cannot change status of an archived term (409)', async () => {
    // Re-archive the term (it was un-archived above to test the round trip).
    await request(app)
      .patch(`/api/v1/terms/${ARCHIVE_CODE}/archive`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
    const r = await request(app)
      .patch(`/api/v1/terms/${ARCHIVE_CODE}/status`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'Finalized' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/archived/i);
    // Sanity: unarchive again then status changes should work.
    await request(app)
      .patch(`/api/v1/terms/${ARCHIVE_CODE}/unarchive`)
      .set('Authorization', `Bearer ${adminTok}`);
    const r2 = await request(app)
      .patch(`/api/v1/terms/${ARCHIVE_CODE}/status`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'Finalized' });
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('Finalized');
  });
});

// NEW-FU-235: season-family seed selection tests.
//
// Previously createTerm seeded from "most recent non-summer schedule"
// regardless of the new term's season. FU-234 changed it to pick the
// NEAREST existing term in the SAME season family (T digit), with an
// earlier-neighbor tie-break. These tests pin that contract.
//
// The fixture codes here are chosen to avoid every other test in this
// file: 281 (Fall 2028), 282 (Spring 2028), 283 (Summer 2028), and
// 292 (Spring 2029) — none are referenced by sibling tests, and we
// hard-DELETE them in afterAll via the shared createdCodes set.
describe('Season-family seed selection (NEW-FU-235)', () => {
  // Earlier describes in this file create 281 / 283 / 291 as fixtures
  // and only DELETE them in the outer afterAll. By the time this
  // describe runs they exist in the DB → POSTing the same code 409s.
  // Pre-clean so the tests start from a known state. Errors are
  // swallowed: 404 on a fresh DB is the expected case.
  beforeAll(async () => {
    // 293 was added to the cleanup list, with 281/283/291 — earlier
    // describes create them as fixtures and only DELETE in the outer
    // afterAll. Pre-clean here so our POSTs aren't 409s.
    for (const code of ['281', '283', '291', '293']) {
      await request(app)
        .delete(`/api/v1/terms/${code}`)
        .query({ activeCode: '251' })
        .set('Authorization', `Bearer ${adminTok}`)
        .catch(() => {});
    }
  });

  // Fall family — 251 (seed) is the only Fall in the DB by default;
  // the FU-202 archive-write describe creates 301 later, but suite
  // order isn't guaranteed — we don't rely on it.
  test('new Fall seeds from nearest existing Fall', async () => {
    const code = '281'; // Fall 2028 — distance 3 from seed 251
    createdCodes.add(code);
    const r = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code });
    expect(r.status).toBe(201);
    expect(r.body.season).toBe('Fall');
    // The seed 251 has sections; the new term should have inherited
    // them. (If a closer Fall like 271 happens to exist from a sibling
    // test, that's fine — the only contract here is that we inherit
    // SOME Fall family member, not specifically 251.)
    expect(r.body.sectionCount).toBeGreaterThan(0);
  });

  // Summer family — pre-FU-234, Summer always started blank. Now it
  // seeds from nearest Summer IF one exists. We construct that fixture
  // inside the test so the assertion isn't dependent on cross-file
  // state.
  test('new Summer seeds from nearest existing Summer (no longer blank)', async () => {
    // Create the source Summer first. Defensive DELETE so this test
    // is rerun-idempotent against a dev DB (cooperativeEnforcement
    // and prior runs may have left 283/293 around — the suite-level
    // beforeAll covered 283 but a flake or partial cleanup can break
    // that guarantee).
    const sourceCode = '283'; // Summer 2028
    createdCodes.add(sourceCode);
    await request(app)
      .delete(`/api/v1/terms/${sourceCode}`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`)
      .catch(() => {});
    const src = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code: sourceCode });
    expect(src.status).toBe(201);

    // The source itself may have inherited from 253 if 253 exists in
    // the DB; either way we need it to have sections so the assertion
    // is meaningful. If it's blank, post a section via the API so the
    // template is non-empty. This keeps the test self-contained.
    if (src.body.sectionCount === 0) {
      // Grab a course + the source's scheduleId so we can plant a
      // throwaway section. Reusing the shape from FU-197 + FU-202.
      const [coursesRes, schedsRes] = await Promise.all([
        request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`),
        request(app).get('/api/v1/departments/SWE-DEPT/schedules').set('Authorization', `Bearer ${adminTok}`),
      ]);
      const srcSchedule = schedsRes.body.find(s => s.semester === sourceCode);
      // NEW-FU-237: pick a 3-credit non-lab course and use the
      // canonical STT 50-min pattern. KFUPM's seed reliably has
      // 3-credit courses; 1-credit is rare so we don't rely on it.
      const threeCreditCourse = coursesRes.body.find(
        c => Number(c.credits) === 3 && !c.has_lab
      );
      expect(threeCreditCourse).toBeTruthy();
      const planted = await request(app)
        .post(`/api/v1/schedules/${srcSchedule.id}/sections`)
        .set('Authorization', `Bearer ${adminTok}`)
        .send({
          courseId: threeCreditCourse.id,
          sectionNumber: '01',
          sectionType: 'Lec',
          days: ['Sunday', 'Tuesday', 'Thursday'],
          startTime: '10:00',
          endTime: '10:50',
        });
      expect(planted.status).toBe(201);
    }

    // Now create a new Summer that should seed from 283 (or whatever's
    // nearest). 293 (Summer 2030) is closer to 283 than to 253 (if 253
    // exists). Distance: |29-28| = 1 vs |29-25| = 4 → 283 wins.
    const newCode = '293';
    createdCodes.add(newCode);
    const r = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code: newCode });
    expect(r.status).toBe(201);
    expect(r.body.season).toBe('Summer');
    // The decisive assertion: post-FU-234 Summer no longer starts blank
    // when there's a Summer to seed from.
    expect(r.body.sectionCount).toBeGreaterThan(0);
  });

  // Tie-break test — with multiple equidistant candidates, pick the
  // earlier one. 281 already exists from the first test in this
  // describe (Fall 2028). Create 291 (Fall 2029) ahead, then 285…
  // wait, 285 isn't valid (third digit must be 1/2/3). Better:
  //   Existing Falls: 251, 281, 301 (might exist from FU-202)
  //   Create 291 — distances: |29-25|=4, |29-28|=1, |29-30|=1.
  //   Tie at distance 1 between 281 and 301. Earlier-wins ⇒ 281.
  // We can't assert WHICH source 291 picked from the API response
  // (createTerm doesn't surface that), so we assert that 291 inherited
  // sections (proves the seed query found a match) and trust the unit-
  // test layer for the tie-break logic itself.
  test('tie-break picks the earlier neighbor (smoke check)', async () => {
    const code = '291'; // Fall 2029
    createdCodes.add(code);
    const r = await request(app)
      .post('/api/v1/terms')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ code });
    // 291 might exist from earlier tests; tolerate that case.
    expect([201, 409]).toContain(r.status);
    if (r.status === 201) {
      expect(r.body.season).toBe('Fall');
      expect(r.body.sectionCount).toBeGreaterThan(0);
    }
  });
});
