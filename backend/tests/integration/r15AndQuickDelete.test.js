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
  // NEW-FU-673: return a course VALID FOR THIS TERM (owned by this term, owner_semester = code,
  // OR template, owner_semester IS NULL). The global GET /courses list now also surfaces every
  // OTHER term's private copies (FU-645), so picking from it can grab a foreign-term course.
  // /suggest accepts a template course, so the OR-NULL set is always populated; UG-only avoids
  // the R-06 graduate window. The GET endpoint doesn't expose owner_semester — query directly.
  const courses = (await query(
    `SELECT id, course_code, credits, has_lab, category FROM courses
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND category = 'UG'`, [code])).rows
    .map(c => ({ ...c, credits: Number(c.credits) }));
  const course = courses.find(c => c.credits === 3 && !c.has_lab && c.category === 'UG');
  return { scheduleId: sched.id, course, courses };
}

// NEW-FU-673: drop ONE meeting row of a section group at the DB level. The tests below need a
// section group left meeting FEWER days than its credit pattern requires, so R-15 fires. They used
// to do that with `DELETE /sections/:id?scope=row`, but FU-609 (Batch 30 item 2) now COERCES a
// row-scope delete on a multi-day group into a whole-group delete ("one meeting of a 3-day section
// left behind is not a legal section state") — which deletes the group entirely and R-15 can never
// fire. A raw DB delete reproduces exactly the under-covered state the rule is designed to catch
// (the same simulation pattern this suite already uses for divergent-time scenarios).
async function rawDeleteRow(sectionId) {
  await query('DELETE FROM sections WHERE id = $1', [sectionId]);
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

  // ── FU-271 + FU-609: per-row delete on a multi-day group ─────────
  test('DELETE /sections/:id?scope=row on a multi-day group is coerced to a whole-group delete', async () => {
    // NEW-FU-673: this predated FU-609 (Batch 30 item 2). It used to assert that scope=row
    // removed only the Sunday meeting and left Tue + Thu. FU-609 deliberately changed that — a
    // row-scope delete on a section that's part of a MULTI-day group is now COERCED to a whole-
    // group delete, because leaving a partial group (one meeting of a 3-day section) is not a
    // legal section state. So the modern contract for a 3-day group is: scope=row ⇒ all 3 rows go.
    const { scheduleId, course: c1 } = await freshTermSchedule('261');
    await seedOneSection(scheduleId, c1);

    const before = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const beforeList = (before.sections || before).filter(s => s.courseId === c1.id);
    // STT pattern → 3 rows (Sun/Tue/Thu).
    expect(beforeList.length).toBe(3);

    // Ask for a row-scope delete of the Sunday row → FU-609 coerces to a group delete.
    const sunRow = beforeList.find(s => s.day === 'Sunday');
    expect(sunRow).toBeTruthy();
    const dr = await request(app)
      .delete(`/api/v1/sections/${sunRow.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(dr.status).toBe(200);
    expect(dr.body.deleted).toBe(true);
    expect(dr.body.scope).toBe('group');   // coerced

    // The entire group is gone (no orphaned siblings).
    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const afterList = (after.sections || after).filter(s => s.courseId === c1.id);
    expect(afterList.length).toBe(0);
  });

  // ── FU-271: default scope still deletes the group ────────────────
  test('DELETE /sections/:id (default scope) removes the whole section group', async () => {
    const { scheduleId, course: c1 } = await freshTermSchedule('262');
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
  test('R-15 fires when a 3-credit section is left meeting only 2 days', async () => {
    const { scheduleId, course: c1 } = await freshTermSchedule('263');
    expect(c1).toBeTruthy();
    await seedOneSection(scheduleId, c1);

    // Sanity — no R-15 right after seeding (STT 50 = 150 min/week, exactly the
    // 3-cr minimum).
    const conflictsBefore = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r15Before = (conflictsBefore.conflicts ?? []).filter(c => c.ruleId === 'R-15');
    expect(r15Before.length).toBe(0);

    // Drop one day → 100 min/week → below the 150 min requirement → R-15 fires.
    // NEW-FU-673: raw DB delete (not the HTTP scope=row endpoint) because FU-609 now coerces a
    // row-scope delete on a multi-day group into a whole-group delete — see rawDeleteRow().
    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sunRow = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Sunday');
    await rawDeleteRow(sunRow.id);

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
    const { scheduleId, course: c1 } = await freshTermSchedule('281');
    await seedOneSection(scheduleId, c1);

    // Drop TWO days (Sun + Thu) → only Tue survives → 50 min/week.
    // NEW-FU-673: raw DB deletes (FU-609 coerces HTTP scope=row on a multi-day group to a
    // whole-group delete, which would remove the group entirely instead of leaving Tue).
    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sunRow = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Sunday');
    const thuRow = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Thursday');
    await rawDeleteRow(sunRow.id);
    await rawDeleteRow(thuRow.id);

    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r15 = (conflicts.conflicts ?? []).filter(c => c.ruleId === 'R-15');
    expect(r15.length).toBe(1);
    expect(r15[0].description).toMatch(/50 min\/week/);
  });

  // ── FU-270: R-15 clears when section is brought back to spec ─────
  test('R-15 clears when the whole under-covered section group is deleted', async () => {
    const { scheduleId, course: c1 } = await freshTermSchedule('282');
    await seedOneSection(scheduleId, c1);

    // Make it deficient (2 days = 100 min/week). NEW-FU-673: raw DB delete of one row, since
    // FU-609 coerces HTTP scope=row on a multi-day group to a full-group delete (which would
    // clear R-15 prematurely and defeat the point of this test).
    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sunRow = (sx.sections || sx).find(s => s.courseId === c1.id && s.day === 'Sunday');
    await rawDeleteRow(sunRow.id);

    // Sanity: R-15 is now firing on the deficient group.
    const mid = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    expect((mid.conflicts ?? []).filter(c => c.ruleId === 'R-15').length).toBe(1);

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
    const { scheduleId, course: c1 } = await freshTermSchedule('283');   // NEW-FU-673: term-valid course

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
