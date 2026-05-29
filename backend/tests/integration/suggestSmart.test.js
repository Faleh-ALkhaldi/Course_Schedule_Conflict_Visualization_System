// NEW-FU-267: Integration tests for the smart auto-suggester (Phase 21).
//
// Phase 21 added three behaviors to the suggest pipeline:
//   • GET /schedules/:id/suggest-recommend — read-only dry-run that
//     returns per-course recommendations + capacityWarnings (FU-261).
//   • POST /schedules/:id/suggest with applyToCourseIds — wipes +
//     regenerates ONLY the specified courses, preserving existing
//     sections of unlisted courses (FU-262).
//   • Per-course capacityWarnings emitted when the greedy can't find
//     a conflict-free slot (FU-266 — courseId/courseCode/message).
//
// These tests exercise the round-trip from API → DB → response so any
// drift between SuggestService and the controllers surfaces here.

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
  return sched.id;
}

describe('FU-267: smart auto-suggester (Phase 21)', () => {

  // ── FU-261 / FU-264: recommend endpoint ───────────────────────────
  test('GET /suggest-recommend returns recommendations and capacityWarnings', async () => {
    const scheduleId = await freshTermSchedule('281');

    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);

    // Shape: { recommendations: [...], capacityWarnings: [...] }
    expect(Array.isArray(r.body.recommendations)).toBe(true);
    expect(Array.isArray(r.body.capacityWarnings)).toBe(true);
    // Each recommendation has the flat shape the modal expects.
    for (const rec of r.body.recommendations) {
      expect(typeof rec.courseId).toBe('string');
      expect(typeof rec.sections).toBe('number');
      expect(typeof rec.duration).toBe('number');
      expect(typeof rec.dayPattern).toBe('string');
      // day is null for multi-day templates, string for ONE_DAY.
      expect(rec.day === null || typeof rec.day === 'string').toBe(true);
    }
  });

  // The dry-run pass must NOT write to the DB — calling it twice on a
  // fresh schedule should leave zero sections both times.
  test('recommend is read-only — no DB writes', async () => {
    const scheduleId = await freshTermSchedule('282');

    const before = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`);
    const beforeCount = (before.body.sections || before.body).length;

    await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);

    const after = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`);
    const afterCount = (after.body.sections || after.body).length;

    expect(afterCount).toBe(beforeCount);
  });

  // ── FU-262 / FU-265: applyToCourseIds filter ──────────────────────
  test('POST /suggest with applyToCourseIds only regenerates listed courses', async () => {
    const scheduleId = await freshTermSchedule('283');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const c2 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.id !== c1.id);
    expect(c1).toBeTruthy();
    expect(c2).toBeTruthy();

    // First run: populate BOTH courses.
    const r1 = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [
        { courseId: c1.id, sections: 1, dayPattern: 'STT', duration: 50 },
        { courseId: c2.id, sections: 1, dayPattern: 'STT', duration: 50 },
      ]});
    expect(r1.status).toBe(200);

    const before = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const beforeList = before.sections || before;
    const c1SectionsBefore = beforeList.filter(s => s.courseId === c1.id);
    const c2SectionsBefore = beforeList.filter(s => s.courseId === c2.id);
    expect(c1SectionsBefore.length).toBeGreaterThan(0);
    expect(c2SectionsBefore.length).toBeGreaterThan(0);
    // Capture c2's section IDs — we'll assert they're untouched.
    const c2IdsBefore = new Set(c2SectionsBefore.map(s => s.id));

    // Second run: applyToCourseIds = [c1.id]. c2's sections must stay.
    const r2 = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [
          { courseId: c1.id, sections: 2, dayPattern: 'STT', duration: 50 },
        ],
        applyToCourseIds: [c1.id],
      });
    expect(r2.status).toBe(200);

    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const afterList = after.sections || after;
    const c2SectionsAfter = afterList.filter(s => s.courseId === c2.id);
    const c2IdsAfter = new Set(c2SectionsAfter.map(s => s.id));

    // c2 sections must be the SAME IDs — proves they weren't wiped+rebuilt.
    expect(c2IdsAfter).toEqual(c2IdsBefore);

    // c1 should now have 2 distinct sectionNumbers (the new config).
    // We count by sectionNumber, not raw rows: STT pattern produces 3
    // meeting rows per section (Sun/Tue/Thu) so 2 sections == 6 rows
    // but 2 unique sectionNumbers.
    const c1SectionsAfter = afterList.filter(s => s.courseId === c1.id);
    const c1Numbers = new Set(c1SectionsAfter.map(s => s.sectionNumber));
    expect(c1Numbers.size).toBe(2);
  });

  // ── FU-262: applyToCourseIds validation ────────────────────────────
  test('POST /suggest rejects non-array applyToCourseIds with 400', async () => {
    const scheduleId = await freshTermSchedule('271');
    // courseConfigs must be non-empty for the validator to reach the
    // applyToCourseIds check — that's the field-order behavior of the
    // controller (see backend/src/controllers/index.js#suggestSchedule).
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);

    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [{ courseId: c1.id, sections: 1, dayPattern: 'STT', duration: 50 }],
        applyToCourseIds: 'not-an-array',
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/applyToCourseIds/i);
  });

  // ── FU-266: per-course capacity warnings carry courseId/code ──────
  test('capacityWarnings (when present) include courseId and courseCode for per-card attribution', async () => {
    const scheduleId = await freshTermSchedule('272');

    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);

    // On a fresh schedule with no other sections, the greedy SHOULD
    // find conflict-free slots — so warnings are expected to be empty.
    // But if any do appear, the contract (FU-266) requires them to
    // include the attribution fields.
    for (const w of r.body.capacityWarnings) {
      expect(typeof w.courseId).toBe('string');
      expect(typeof w.courseCode).toBe('string');
      expect(typeof w.message).toBe('string');
      expect(w.message.length).toBeGreaterThan(0);
    }
  });

  // ── FU-262: empty applyToCourseIds is a no-op (no sections written) ──
  // The controller validates courseConfigs must be non-empty (legacy
  // contract — preserved when applyToCourseIds is empty too), so the
  // realistic "no-op" path is `applyToCourseIds: [<id not in configs>]`
  // — the filter intersects, sees no overlap, and skips the wipe.
  test('POST /suggest with applyToCourseIds excluding the supplied course is a no-op for that course', async () => {
    const scheduleId = await freshTermSchedule('273');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const c2 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.id !== c1.id);

    // Seed with c1.
    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c1.id, sections: 1, dayPattern: 'STT', duration: 50 }] });

    const before = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const beforeC1 = (before.sections || before).filter(s => s.courseId === c1.id);
    const beforeC1Ids = new Set(beforeC1.map(s => s.id));
    expect(beforeC1Ids.size).toBeGreaterThan(0);

    // Run with a courseConfig for c1 but applyToCourseIds = [c2.id].
    // The filter intersects → no courses get wiped, and c1's config
    // is never written. c1's existing sections must survive unchanged.
    const r2 = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [{ courseId: c1.id, sections: 2, dayPattern: 'STT', duration: 50 }],
        applyToCourseIds: [c2.id],
      });
    expect(r2.status).toBe(200);

    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const afterC1 = (after.sections || after).filter(s => s.courseId === c1.id);
    const afterC1Ids = new Set(afterC1.map(s => s.id));

    // c1's section IDs are identical — no wipe happened.
    expect(afterC1Ids).toEqual(beforeC1Ids);
  });
});
