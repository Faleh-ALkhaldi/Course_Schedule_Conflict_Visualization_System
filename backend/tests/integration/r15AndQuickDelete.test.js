// NEW-FU-274: Integration tests for Phase 22 — per-day quick-delete +
// section-group delete + R-15 InsufficientCreditCoverage.
//
// Phase 22 introduced:
//   • DELETE /sections/:id?scope=row    — wipes ONE meeting row.       (FU-271)
//   • DELETE /sections/:id              — wipes the section GROUP.     (existing)
//   • R-15: InsufficientCreditCoverage — fires when a section's
//     surviving meeting days × duration don't cover the course's
//     credit-hour requirement.                                          (FU-270)
//
// These tests exercise the round-trip: create sections via Suggest,
// delete a single day, verify R-15 fires; delete the whole group,
// verify R-15 clears.

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

// Convenience: seed one course in STT 50min pattern (3 meetings × 50 min
// = 150 min/week — exactly the minimum for a 3-credit course).
async function seedOneSection(scheduleId, course) {
  const r = await request(app)
    .post(`/api/v1/schedules/${scheduleId}/suggest`)
    .set('Authorization', `Bearer ${adminTok}`)
    .send({ courseConfigs: [{ courseId: course.id, sections: 1, dayPattern: 'STT', duration: 50 }] });
  expect(r.status).toBe(200);
}

describe('FU-274: Phase 22 — per-day delete, section-group delete, R-15', () => {

  // ── FU-271: per-row delete ───────────────────────────────────────
  test('DELETE /sections/:id?scope=row removes ONE meeting (sibling rows survive)', async () => {
    const scheduleId = await freshTermSchedule('261');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    await seedOneSection(scheduleId, c1);

    const before = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const beforeList = (before.sections || before).filter(s => s.courseId === c1.id);
    // STT pattern → 3 rows (Sun/Tue/Thu).
    expect(beforeList.length).toBe(3);

    // Delete the Sunday row only.
    const sunRow = beforeList.find(s => s.day === 'Sunday');
    expect(sunRow).toBeTruthy();
    const dr = await request(app)
      .delete(`/api/v1/sections/${sunRow.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(dr.status).toBe(200);
    expect(dr.body.deleted).toBe(true);
    expect(dr.body.scope).toBe('row');

    // The other 2 rows (Tue + Thu) survive.
    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const afterList = (after.sections || after).filter(s => s.courseId === c1.id);
    expect(afterList.length).toBe(2);
    const days = new Set(afterList.map(s => s.day));
    expect(days).toEqual(new Set(['Tuesday', 'Thursday']));
  });

  // ── FU-271: default scope still deletes the group ────────────────
  test('DELETE /sections/:id (default scope) removes the whole section group', async () => {
    const scheduleId = await freshTermSchedule('262');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    await seedOneSection(scheduleId, c1);

    const before = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sunRow = (before.sections || before).find(s => s.courseId === c1.id && s.day === 'Sunday');

    // Default scope — no query string.
    const dr = await request(app)
      .delete(`/api/v1/sections/${sunRow.id}`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(dr.status).toBe(200);
    expect(dr.body.scope).toBe('group');

    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const c1Remaining = (after.sections || after).filter(s => s.courseId === c1.id);
    expect(c1Remaining.length).toBe(0);
  });

  // ── FU-270: R-15 fires when surviving meetings under-cover credits ─
  test('R-15 fires when per-day delete makes a 3-credit section meet only 2 days', async () => {
    const scheduleId = await freshTermSchedule('263');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    expect(c1).toBeTruthy();
    await seedOneSection(scheduleId, c1);

    // Sanity — no R-15 right after seeding (STT 50 = 150 min/week, exactly the
    // 3-cr minimum).
    const conflictsBefore = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r15Before = (conflictsBefore.conflicts ?? []).filter(c => c.ruleId === 'R-15');
    expect(r15Before.length).toBe(0);

    // Delete one day → 100 min/week → below the 150 min requirement → R-15 fires.
    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sunRow = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Sunday');
    await request(app)
      .delete(`/api/v1/sections/${sunRow.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);

    const conflictsAfter = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r15After = (conflictsAfter.conflicts ?? []).filter(c => c.ruleId === 'R-15');
    expect(r15After.length).toBe(1);
    expect(r15After[0].severity).toBe('Soft');
    expect(r15After[0].description).toMatch(/100 min\/week/);
    expect(r15After[0].description).toMatch(new RegExp(c1.course_code));
  });

  // ── FU-270: R-15 dedupes per section group ───────────────────────
  test('R-15 produces exactly ONE conflict per section group (not per surviving day)', async () => {
    const scheduleId = await freshTermSchedule('281');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    await seedOneSection(scheduleId, c1);

    // Delete TWO days (Sun + Thu) → only Tue survives → 50 min/week.
    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sunRow = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Sunday');
    const thuRow = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Thursday');
    await request(app)
      .delete(`/api/v1/sections/${sunRow.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);
    await request(app)
      .delete(`/api/v1/sections/${thuRow.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);

    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r15 = (conflicts.conflicts ?? []).filter(c => c.ruleId === 'R-15');
    expect(r15.length).toBe(1);
    expect(r15[0].description).toMatch(/50 min\/week/);
  });

  // ── FU-270: R-15 clears when section is brought back to spec ─────
  test('R-15 clears when the whole under-covered section group is deleted', async () => {
    const scheduleId = await freshTermSchedule('282');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    await seedOneSection(scheduleId, c1);

    // Make it deficient.
    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sunRow = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Sunday');
    await request(app)
      .delete(`/api/v1/sections/${sunRow.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);

    // Now wipe the entire group (default scope) — R-15 should clear.
    const sx2 = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const surviving = (sx2.sections || sx2).find(s => s.courseId === c1.id);
    await request(app)
      .delete(`/api/v1/sections/${surviving.id}`)
      .set('Authorization', `Bearer ${adminTok}`);

    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r15 = (conflicts.conflicts ?? []).filter(c => c.ruleId === 'R-15');
    expect(r15.length).toBe(0);
  });

  // ── FU-270: R-15 doesn't fire on 75min × 2-day patterns (sufficient) ─
  test('R-15 does NOT fire on a 3-credit MW 75min pattern (150 min/week, exactly meets requirement)', async () => {
    const scheduleId = await freshTermSchedule('283');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);

    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c1.id, sections: 1, dayPattern: 'MW', duration: 75 }] });
    expect(r.status).toBe(200);

    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r15 = (conflicts.conflicts ?? []).filter(c => c.ruleId === 'R-15');
    expect(r15.length).toBe(0);
  });
});
