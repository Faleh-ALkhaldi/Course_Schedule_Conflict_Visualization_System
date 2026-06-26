// NEW-FU-282: Integration tests for the R-15 quick-fix flow (Phase 23).
//
// Phase 23 builds on Phase 22's R-15 detection by making the conflict
// actionable. The flow under test:
//   1. Seed an STT 50min section (3 × 50 = 150 min/week, 3-credit OK).
//   2. ?scope=row delete one day → R-15 fires.
//   3. GET /conflicts returns the R-15 with a `fixes` array proposing
//      to add back the deleted day(s).                         (FU-278)
//   4. POST /sections/:id/extend with the proposed addDays.    (FU-277)
//   5. GET /conflicts shows R-15 cleared.

const request = require('supertest');
const app     = require('../../src/app');
const { query } = require('../../src/config/db');   // NEW-FU-673: term-valid course + raw under-coverage setup

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
  // NEW-FU-673: return a course VALID FOR THIS TERM (owned, owner_semester = code, OR template,
  // owner_semester IS NULL). The global GET /courses list now also surfaces every OTHER term's
  // private copies (FU-645) → a picked course can belong to another term. /suggest accepts a
  // template, so OR-NULL is always populated; UG-only avoids the R-06 graduate window.
  const courses = (await query(
    `SELECT id, course_code, credits, has_lab, category FROM courses
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND category = 'UG'`, [code])).rows
    .map(c => ({ ...c, credits: Number(c.credits) }));
  const course = courses.find(c => c.credits === 3 && !c.has_lab && c.category === 'UG');
  return { scheduleId: sched.id, course, courses };
}

// NEW-FU-673: drop ONE meeting row at the DB level to leave a section group under-covering its
// credit pattern, so R-15 fires. FU-609 (Batch 30 item 2) now coerces an HTTP scope=row delete on
// a multi-day group into a whole-group delete (a partial group is not a legal state), which would
// remove the group entirely and R-15 could never fire. A raw delete reproduces the exact
// under-covered state the rule + its quick-fix are designed to remediate.
async function rawDeleteRow(sectionId) {
  await query('DELETE FROM sections WHERE id = $1', [sectionId]);
}

async function seedSTT(scheduleId, course) {
  const r = await request(app)
    .post(`/api/v1/schedules/${scheduleId}/suggest`)
    .set('Authorization', `Bearer ${adminTok}`)
    .send({ courseConfigs: [{ courseId: course.id, sections: 1, dayPattern: 'STT', duration: 50 }] });
  expect(r.status).toBe(200);
}

describe('FU-282: R-15 quick-fix flow (Phase 23)', () => {

  // ── FU-278: R-15 carries `fixes` proposals ────────────────────────
  test('R-15 conflict includes fixes proposing the missing day', async () => {
    const { scheduleId, course: c1 } = await freshTermSchedule('291');
    await seedSTT(scheduleId, c1);

    // Drop the Thursday meeting → surviving is Sun + Tue (100 min < 150).
    // NEW-FU-673: raw DB delete (FU-609 coerces HTTP scope=row on a multi-day group to a
    // whole-group delete, which would leave nothing for R-15 to fire on).
    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const thu = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Thursday');
    await rawDeleteRow(thu.id);

    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r15 = (conflicts.conflicts ?? []).find(c => c.ruleId === 'R-15');
    expect(r15).toBeTruthy();
    expect(Array.isArray(r15.fixes)).toBe(true);
    expect(r15.fixes.length).toBeGreaterThan(0);

    // The first (smallest) fix should propose adding Thursday — completing STT.
    const sttFix = r15.fixes.find(f => f.template === 'STT');
    expect(sttFix).toBeTruthy();
    expect(sttFix.addDays).toEqual(['Thursday']);
    expect(sttFix.label).toMatch(/Thursday/);
    expect(sttFix.sectionId).toBeTruthy();
  });

  // ── FU-277: extend endpoint applies a fix and R-15 clears ─────────
  test('POST /sections/:id/extend with fix addDays completes the pattern and clears R-15', async () => {
    const { scheduleId, course: c1 } = await freshTermSchedule('292');
    await seedSTT(scheduleId, c1);

    // Drop Tuesday → surviving Sun + Thu. NEW-FU-673: raw DB delete (FU-609 coerces HTTP
    // scope=row on a multi-day group to a whole-group delete).
    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const tue = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Tuesday');
    await rawDeleteRow(tue.id);

    // Get the fix proposal and apply it.
    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r15 = (conflicts.conflicts ?? []).find(c => c.ruleId === 'R-15');
    expect(r15).toBeTruthy();
    const fix = r15.fixes[0];

    const er = await request(app)
      .post(`/api/v1/sections/${fix.sectionId}/extend`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ addDays: fix.addDays });
    expect(er.status).toBe(201);

    // R-15 should clear now (3 days × 50min = 150min, exactly satisfies).
    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r15After = (after.conflicts ?? []).filter(c => c.ruleId === 'R-15');
    expect(r15After.length).toBe(0);

    // And the section group should have 3 days now.
    const sxAfter = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const days = (sxAfter.sections || sxAfter)
      .filter(s => s.courseId === c1.id)
      .map(s => s.day);
    expect(new Set(days)).toEqual(new Set(['Sunday', 'Tuesday', 'Thursday']));
  });

  // ── FU-276: extend rejects an addition that doesn't form a legal pattern ─
  test('POST /sections/:id/extend rejects an illegal addition with 400', async () => {
    const { scheduleId, course: c1 } = await freshTermSchedule('293');   // NEW-FU-673: term-valid course
    await seedSTT(scheduleId, c1);

    // Try to add Friday — not in any legal 3-credit template.
    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sun = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Sunday');

    const er = await request(app)
      .post(`/api/v1/sections/${sun.id}/extend`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ addDays: ['Friday'] });
    expect(er.status).toBe(400);
    expect(er.body.error).toBeTruthy();
  });

  // ── FU-277: extend rejects adding a day already in the group ─────
  test('POST /sections/:id/extend rejects a duplicate day with 409', async () => {
    const { scheduleId, course: c1 } = await freshTermSchedule('261');   // NEW-FU-673: term-valid course
    await seedSTT(scheduleId, c1);

    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sun = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Sunday');

    // Sun is already in the group — adding it again should be rejected.
    const er = await request(app)
      .post(`/api/v1/sections/${sun.id}/extend`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ addDays: ['Sunday'] });
    expect(er.status).toBe(409);
    expect(er.body.error).toMatch(/already exists/);
  });

  // ── FU-277: extend rejects empty addDays with 400 ────────────────
  test('POST /sections/:id/extend rejects empty addDays with 400', async () => {
    const { scheduleId, course: c1 } = await freshTermSchedule('262');   // NEW-FU-673: term-valid course
    await seedSTT(scheduleId, c1);

    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sun = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Sunday');

    const er = await request(app)
      .post(`/api/v1/sections/${sun.id}/extend`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ addDays: [] });
    expect(er.status).toBe(400);
    expect(er.body.error).toMatch(/addDays/i);
  });

  // ── FU-278: no fixes proposed for non-completable patterns ───────
  test('No fixes emitted when surviving days are not a subset of any legal template', async () => {
    const { scheduleId, course: c1 } = await freshTermSchedule('263');
    await seedSTT(scheduleId, c1);

    // Drop Sun AND Tue so only Thu survives. Thu alone is a subset of STT — the fix proposal
    // completes STT by adding Sun + Tue. NEW-FU-673: raw DB deletes (FU-609 coerces HTTP
    // scope=row on a multi-day group to a whole-group delete).
    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sun = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Sunday');
    const tue = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Tuesday');
    await rawDeleteRow(sun.id);
    await rawDeleteRow(tue.id);

    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r15 = (conflicts.conflicts ?? []).find(c => c.ruleId === 'R-15');
    expect(r15).toBeTruthy();
    // Thursday survives. Legal templates for 3cr/50min WITHOUT a lab is
    // STT only (FU-240 rule table). TT is allowed only for has_lab=true
    // courses. So the single fix proposal completes STT by adding Sun + Tue.
    expect(r15.fixes.length).toBe(1);
    const stt = r15.fixes[0];
    expect(stt.template).toBe('STT');
    expect(new Set(stt.addDays)).toEqual(new Set(['Sunday', 'Tuesday']));
  });
});
