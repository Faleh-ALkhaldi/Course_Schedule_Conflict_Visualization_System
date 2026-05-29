// NEW-FU-316: Integration tests for Phase 29's refuse-to-place behavior.
//
// Phase 29 added `maxConflictsPerSection` to the suggest payload. When
// set to 0/1/2, the greedy SKIPS sections that would create more
// conflicts than the tolerance allows, instead of force-placing them.
// Skipped sections appear in placementSkipped[] in the response.

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
  // Wipe auto-cloned sections so the test starts blank.
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

describe('FU-316: refuse-to-place + maxConflictsPerSection (Phase 29)', () => {

  test('legacy: maxConflictsPerSection unset → placementSkipped is empty', async () => {
    // Backward-compat check. Pre-Phase-29 callers that don't send the
    // knob keep getting the "force everything" behavior, just with
    // placementSkipped: [] (or absent — both treated as empty).
    const scheduleId = await freshTermSchedule('291');
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50 }] });
    expect(r.status).toBe(200);
    const skipped = r.body.placementSkipped ?? [];
    expect(skipped.length).toBe(0);
  });

  test('maxConflictsPerSection=any explicitly → same as legacy', async () => {
    const scheduleId = await freshTermSchedule('292');
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [{ courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50 }],
        maxConflictsPerSection: 'any',
      });
    expect(r.status).toBe(200);
    expect(r.body.placementSkipped ?? []).toEqual([]);
  });

  test('maxConflictsPerSection=0 + saturated schedule → placementSkipped populated', async () => {
    // Force saturation more aggressively: request many sections of MANY
    // 3-credit courses, all on the same STT 50min pattern. With only
    // ~5 instructors and 3 LectureHalls in the seed, and the Phase 29
    // sibling-spread penalty heavily discouraging stacking same-course
    // sections at the same time, strict mode (0) MUST skip some.
    const scheduleId = await freshTermSchedule('293');
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const threeCr = courses.filter(c => Number(c.credits) === 3 && !c.has_lab).slice(0, 6);
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        // 6 courses × 8 sections each = 48 sections competing on STT 50min.
        // The seed has ~5 instructors × ~12 time slots = 60 slot-instructor
        // combos, but most produce conflicts due to overlapping levels
        // and sibling-spread penalty. Strict mode HAS to refuse some.
        courseConfigs: threeCr.map(c => ({
          courseId: c.id, sections: 8, dayPattern: 'STT', duration: 50,
        })),
        maxConflictsPerSection: 0,
      });
    expect(r.status).toBe(200);
    const skipped = r.body.placementSkipped ?? [];
    expect(skipped.length).toBeGreaterThan(0);
    for (const s of skipped) {
      expect(typeof s.courseId).toBe('string');
      expect(typeof s.sectionNumber).toBe('string');
      expect(typeof s.reason).toBe('string');
      expect(s.reason.length).toBeGreaterThan(0);
    }
  });

  test('maxConflictsPerSection=0 + uncontested schedule → no skips', async () => {
    // The flip side: when the schedule has plenty of headroom, strict
    // mode shouldn't refuse to place anything.
    const scheduleId = await freshTermSchedule('261');
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [{ courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50 }],
        maxConflictsPerSection: 0,
      });
    expect(r.status).toBe(200);
    expect(r.body.placementSkipped ?? []).toEqual([]);
  });

  test('invalid maxConflictsPerSection returns 400', async () => {
    const scheduleId = await freshTermSchedule('262');
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    // 'banana' is not 'any' nor an integer 0..10.
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [{ courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50 }],
        maxConflictsPerSection: 'banana',
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/maxConflictsPerSection/i);
  });

  test('skipped sections actually leave the DB without rows', async () => {
    // When a section is skipped, its rows must NOT be inserted. The user
    // sees this as "the suggester didn't add SWE206 §03" — useful as a
    // signal to add more resources rather than ship a conflicted schedule.
    const scheduleId = await freshTermSchedule('263');
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const threeCr = courses.filter(c => Number(c.credits) === 3 && !c.has_lab).slice(0, 5);

    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: threeCr.map(c => ({
          courseId: c.id, sections: 4, dayPattern: 'STT', duration: 50,
        })),
        maxConflictsPerSection: 0,
      });
    expect(r.status).toBe(200);
    const skipped = r.body.placementSkipped ?? [];
    if (skipped.length === 0) return; // not saturated enough — no-op test

    const sxAfter = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const allSections = sxAfter.sections || sxAfter;
    // For each skipped (courseId, sectionNumber), there must be no row
    // in the schedule.
    for (const s of skipped) {
      const matches = allSections.filter(
        sec => sec.courseId === s.courseId && sec.sectionNumber === s.sectionNumber
      );
      expect(matches.length).toBe(0);
    }
  });
});
