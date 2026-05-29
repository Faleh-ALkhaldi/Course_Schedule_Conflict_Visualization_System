// NEW-FU-296: Integration tests for Phase 26's smart greedy.
//
// Phase 26 made the actual greedy smart, not just the recommend()
// pre-compute. The observable improvements are:
//   1. Start times distribute across the day (no more "everything at 07:00")
//   2. Instructors and venues load-balance (not "first match for everyone")
//   3. Immovable existing sections respected when applyToCourseIds is set
//
// These tests verify the observable behavior. They don't lock in any
// specific assignment (the greedy's nondeterminism is fine) — they
// assert the COARSE properties the user cares about.

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
  // Wipe auto-cloned sections so we start from a true blank.
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

describe('FU-296: smart greedy (Phase 26)', () => {

  test('Suggest distributes start times across the day (no 07:00 stacking)', async () => {
    const scheduleId = await freshTermSchedule('281');

    // Run Suggest with multiple courses. Pre-Phase-26 they all stacked
    // at 07:00 because every empty slot scored identically (0,0) and
    // the first slot (07:00) won by enumeration order.
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const threeCreditCourses = courses.filter(c => Number(c.credits) === 3 && !c.has_lab).slice(0, 6);
    expect(threeCreditCourses.length).toBeGreaterThanOrEqual(4);

    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: threeCreditCourses.map(c => ({
          courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50,
        })),
      });
    expect(r.status).toBe(200);

    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sections = sx.sections || sx;

    // Group sections by start time. Each course produces 3 rows (Sun/Tue/Thu)
    // at the SAME time, so we expect (courses × 3) rows distributed across
    // courses × 1 distinct start times — distinct count = course count.
    const startTimes = new Set(sections.map(s => (s.startTime || '').substring(0, 5)));
    // Pre-Phase-26: distinctStartTimes would be 1 (everything at 07:00).
    // Post-Phase-26: should equal the number of courses (each gets its own time).
    expect(startTimes.size).toBeGreaterThanOrEqual(threeCreditCourses.length);
  });

  test('Suggest load-balances venues across sections', async () => {
    const scheduleId = await freshTermSchedule('282');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const threeCreditCourses = courses.filter(c => Number(c.credits) === 3 && !c.has_lab).slice(0, 6);
    expect(threeCreditCourses.length).toBeGreaterThanOrEqual(3);

    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: threeCreditCourses.map(c => ({
          courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50,
        })),
      });

    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sections = sx.sections || sx;

    // Group by venue. Multiple lecture halls in the seed (H-101, H-201, H-301);
    // the venue picker shouldn't put EVERY section in H-101 alone.
    const venuesUsed = new Set(sections.map(s => s.venueId).filter(Boolean));
    // Pre-Phase-26: 1 (everyone at H-101).
    // Post-Phase-26: ≥ 2 (load-balanced across the LectureHall pool).
    expect(venuesUsed.size).toBeGreaterThanOrEqual(2);
  });

  test('Suggest produces no R-04 conflicts on a fresh schedule', async () => {
    // The greedy's saturation-aware + load-balanced picker should
    // never produce an instructor double-booking on an empty schedule
    // with sufficient instructor headroom.
    const scheduleId = await freshTermSchedule('283');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const threeCreditCourses = courses.filter(c => Number(c.credits) === 3 && !c.has_lab).slice(0, 4);

    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: threeCreditCourses.map(c => ({
          courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50,
        })),
      });

    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r04 = (conflicts.conflicts ?? []).filter(c => c.ruleId === 'R-04');
    // Pre-Phase-26: stacking + same-instructor produced many R-04 hard conflicts.
    // Post-Phase-26: zero (load-balanced picker spreads instructors).
    expect(r04.length).toBe(0);
  });

  test('applyToCourseIds preserves immovable sections of other courses', async () => {
    const scheduleId = await freshTermSchedule('261');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const c2 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.id !== c1.id);

    // Seed BOTH courses.
    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [
          { courseId: c1.id, sections: 1, dayPattern: 'STT', duration: 50 },
          { courseId: c2.id, sections: 1, dayPattern: 'STT', duration: 50 },
        ],
      });

    const before = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const c2Before = (before.sections || before)
      .filter(s => s.courseId === c2.id)
      .map(s => s.id);

    // Re-run Suggest with applyToCourseIds = [c1.id]. c2 should be untouched.
    // The smart greedy's pre-seed (FU-296) means new c1 placements
    // RESPECT c2's existing sections (don't reuse c2's instructor/venue
    // at the same time).
    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [
          { courseId: c1.id, sections: 1, dayPattern: 'STT', duration: 50 },
        ],
        applyToCourseIds: [c1.id],
      });

    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const c2After = (after.sections || after)
      .filter(s => s.courseId === c2.id)
      .map(s => s.id);

    // c2's section IDs must be identical — proves nothing was wiped/rebuilt.
    expect(new Set(c2After)).toEqual(new Set(c2Before));
  });
});
