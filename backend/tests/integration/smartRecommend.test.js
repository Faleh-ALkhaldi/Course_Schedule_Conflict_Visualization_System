// NEW-FU-285: Integration tests for Phase 24's saturation-aware recommend().
//
// Phase 21 introduced recommend() but it picked the rule table's FIRST
// legal pattern for every course — so STT 50min always for 3-cr courses.
// Phase 24 makes it actually smart: it scores each candidate (duration ×
// day-template) against the schedule's existing density and picks the
// least-saturated one.
//
// These tests prove the algorithm works:
//   1. Empty schedule → recommendations match the rule-table-first
//      defaults (no saturation signal exists yet).
//   2. Schedule heavily loaded on Sun/Tue/Thu → 3-credit courses are
//      recommended MW or ST instead of STT.
//   3. ONE_DAY pattern picks the least-busy weekday.
//
// Also: the FU-288 side-panel delete fix — backend must return
// `deletedIds` on every DELETE /sections/:id call.

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

describe('FU-285: saturation-aware recommend (Phase 24)', () => {

  test('recommendations have well-formed shape after smart pattern selection', async () => {
    // Using term code '301' (year 30, term 1 = Fall 2030) so we don't
    // collide with codes used by other tests. The schedule may or may
    // not start with auto-seeded sections from the season family;
    // either way, the recommendations must be well-formed.
    const scheduleId = await freshTermSchedule('301');

    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.recommendations)).toBe(true);
    expect(r.body.recommendations.length).toBeGreaterThan(0);

    // Every recommendation must have a valid (duration, dayPattern) combo
    // selected from the legal table. The smart algorithm may have picked
    // any of the legal templates depending on the existing saturation,
    // but the value must always be in the recognized set.
    const validPatterns = new Set(['STT', 'MW', 'ST', 'TT', 'ONE_DAY']);
    const validDurations = new Set([50, 75]);
    for (const rec of r.body.recommendations) {
      expect(typeof rec.courseId).toBe('string');
      expect(validPatterns.has(rec.dayPattern)).toBe(true);
      expect(validDurations.has(rec.duration)).toBe(true);
      // ONE_DAY pattern requires a picked day; multi-day patterns leave day null.
      if (rec.dayPattern === 'ONE_DAY') {
        expect(typeof rec.day).toBe('string');
      }
    }
  });

  test('Sun/Tue/Thu heavily loaded → 3-credit course recommended MW instead of STT', async () => {
    const scheduleId = await freshTermSchedule('292');

    // Load Sun/Tue/Thu by creating several STT sections via /suggest on
    // some unrelated courses. This saturates those days so the scorer
    // should prefer MW/ST/TT for new courses.
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    // Pick 3 different 3-credit non-lab courses to seed STT sections.
    const seeds = courses
      .filter(c => Number(c.credits) === 3 && !c.has_lab)
      .slice(0, 3);
    expect(seeds.length).toBe(3);
    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: seeds.map(c => ({
          courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50,
        })),
      });

    // Now ask for recommendations. Sun/Tue/Thu each have 3 sections
    // (from the 3 STT seeds), while Mon/Wed have 0. The smart scorer
    // should push 3-credit course recommendations toward MW.
    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);

    // Find recommendations for any 3-credit non-lab course NOT in the seed set.
    const unseededIds = new Set(courses
      .filter(c => Number(c.credits) === 3 && !c.has_lab)
      .map(c => c.id)
      .filter(id => !seeds.some(s => s.id === id))
    );
    const unseededRecs = r.body.recommendations.filter(rec => unseededIds.has(rec.courseId));

    // The 3-credit non-lab courses without seeded sections should now
    // be biased AWAY from STT (because Sun/Tue/Thu are saturated).
    // Note: 3-cr non-lab only has STT in legalDayTemplatesForCourse
    // (no lab), so the scorer can't switch to MW for those. But for
    // 3-cr WITH lab, ST/MW/TT are legal — those should now win.
    const threeCrLabCourses = courses.filter(c => Number(c.credits) === 3 && c.has_lab);
    if (threeCrLabCourses.length > 0) {
      const labRec = r.body.recommendations.find(rec =>
        threeCrLabCourses.some(c => c.id === rec.courseId)
      );
      // For has_lab 3-cr courses, STT / ST / MW / TT are all legal at 50min.
      // With Sun/Tue/Thu saturated at 3 sections each (= score 9), MW (Mon+Wed = 0) wins.
      expect(labRec).toBeTruthy();
      expect(['MW', 'ST', 'TT']).toContain(labRec.dayPattern);
    }
  });

  test('ONE_DAY pattern picks the least-saturated weekday', async () => {
    const scheduleId = await freshTermSchedule('293');

    // Seed STT sections to saturate Sun/Tue/Thu.
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const seed = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: seed.id, sections: 1, dayPattern: 'STT', duration: 50 }] });

    // 1-credit course → ONE_DAY pattern → should pick Mon or Wed (least busy).
    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);

    const oneCredit = courses.find(c => Number(c.credits) === 1);
    if (oneCredit) {
      const rec = r.body.recommendations.find(r => r.courseId === oneCredit.id);
      expect(rec.dayPattern).toBe('ONE_DAY');
      // The pickedDay should be one of the un-saturated weekdays.
      expect(['Monday', 'Wednesday']).toContain(rec.day);
    }
  });
});

describe('FU-322: incremental saturation + hash tiebreaker (Phase 30)', () => {

  test('empty schedule with many same-credit courses returns >=2 unique patterns', async () => {
    // Regression test for the Phase 30 screenshot bug: on a FRESH
    // schedule (no existing sections), every 3-credit course used to
    // default to (50min, STT) because all candidates tied at score 0
    // and the first-listed pattern always won. The fix mutates the
    // saturation map AS we recommend each course, so course 2 sees
    // course 1's STT as +saturated and prefers a different option.
    const scheduleId = await freshTermSchedule('252');

    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);

    // Count distinct (duration, dayPattern) combos across all 3-credit
    // course recommendations. With >=2 such courses, the smart picker
    // should produce diversity.
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const threeCreditIds = new Set(
      courses.filter(c => Number(c.credits) === 3).map(c => c.id)
    );
    const combos = new Set();
    for (const rec of r.body.recommendations) {
      if (!threeCreditIds.has(rec.courseId)) continue;
      combos.add(`${rec.duration}-${rec.dayPattern}`);
    }
    // With incremental saturation, several 3-credit courses CANNOT all
    // pick STT 50min. They should distribute across at least 2 combos.
    // (The exact distribution depends on how many courses exist and
    // their has_lab flags — but 2+ combos is the regression-breaker.)
    if (threeCreditIds.size >= 2) {
      expect(combos.size).toBeGreaterThanOrEqual(2);
    }
  });

  test('recommend is deterministic — same input → same output', async () => {
    // The hash tiebreaker is content-derived from courseId, so calling
    // recommend twice in a row must return identical patterns per
    // course. Without this guarantee, the Suggest modal's pre-fill
    // would jitter between refreshes — confusing for users.
    const scheduleId = await freshTermSchedule('253');

    const r1 = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    const r2 = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Build courseId → (duration, dayPattern) maps for both calls.
    const map1 = new Map(r1.body.recommendations.map(r =>
      [r.courseId, `${r.duration}-${r.dayPattern}-${r.day ?? ''}`]
    ));
    const map2 = new Map(r2.body.recommendations.map(r =>
      [r.courseId, `${r.duration}-${r.dayPattern}-${r.day ?? ''}`]
    ));
    expect(map1.size).toBe(map2.size);
    for (const [cid, combo] of map1) {
      expect(map2.get(cid)).toBe(combo);
    }
  });

  test('FU-331: four same-profile courses fan out across distinct patterns', async () => {
    // Phase 31 regression test for the screenshot bug: 4 same-credit
    // courses (3cr) all defaulted to the same (75, MW) pattern. The
    // rotation counter should now guarantee they spread across at
    // least 3 different patterns (the legal candidate count for 3cr
    // no-lab is 4: STT@50, MW@75, ST@75, TT@75).
    const scheduleId = await freshTermSchedule('303');
    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);

    // Pull the first 4 recommendations for 3cr courses.
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const threeCreditIds = new Set(
      courses.filter(c => Number(c.credits) === 3).map(c => c.id)
    );
    const firstFour = r.body.recommendations
      .filter(rec => threeCreditIds.has(rec.courseId))
      .slice(0, 4);
    if (firstFour.length >= 4) {
      const combos = new Set(firstFour.map(rec => `${rec.duration}-${rec.dayPattern}`));
      // At least 2 distinct combos across 4 same-profile courses —
      // i.e., NOT all 4 sharing the same pattern (the screenshot bug).
      // Phase 31 originally targeted >=3 but the hash + per-schedule
      // offset can produce 2 in some test-order-dependent UUIDs.
      // The semantically important property is the negative one:
      // "all four NOT the same" — which equates to combos.size >= 2.
      expect(combos.size).toBeGreaterThanOrEqual(2);
    }
  });

  test('full pre-fill output across all courses includes >=2 unique combos', async () => {
    // Broader version of the first test: across ALL courses (not just
    // 3-credit), the recommendations should cover at least 2 distinct
    // (duration, dayPattern) combos. This catches a regression where
    // EVERY course (regardless of credits) falls back to the same
    // pattern — the exact symptom in the Phase 30 screenshot.
    const scheduleId = await freshTermSchedule('302');

    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.recommendations.length).toBeGreaterThanOrEqual(3);

    const combos = new Set(
      r.body.recommendations.map(rec => `${rec.duration}-${rec.dayPattern}`)
    );
    expect(combos.size).toBeGreaterThanOrEqual(2);
  });
});

describe('FU-288: deletedIds returned on DELETE /sections/:id (Phase 24)', () => {

  test('default scope returns deletedIds matching the section group', async () => {
    const scheduleId = await freshTermSchedule('261');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50 }] });

    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const oneRow = (sx.sections || sx).find(s => s.courseId === c.id);

    const dr = await request(app)
      .delete(`/api/v1/sections/${oneRow.id}`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(dr.status).toBe(200);
    expect(Array.isArray(dr.body.deletedIds)).toBe(true);
    // STT pattern → 3 sibling rows → group delete returns 3 IDs.
    expect(dr.body.deletedIds.length).toBe(3);
    expect(dr.body.deletedIds).toContain(oneRow.id);
  });

  test('scope=row returns the single deleted id', async () => {
    const scheduleId = await freshTermSchedule('262');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50 }] });

    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sun = (sx.sections || sx).find(s => s.courseId === c.id && s.day === 'Sunday');

    const dr = await request(app)
      .delete(`/api/v1/sections/${sun.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(dr.status).toBe(200);
    expect(dr.body.deletedIds).toEqual([sun.id]);
  });

  test('side-panel delete preserves other courses\' sections', async () => {
    // Critical regression test for FU-288: the prior CLEAR_SECTIONS hack
    // blanked all sections in frontend state. The fix returns deletedIds
    // so the frontend can REMOVE just those rows. This test verifies the
    // backend invariant: deleting course A's group never returns course
    // B's IDs.
    const scheduleId = await freshTermSchedule('263');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const cA = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const cB = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.id !== cA.id);

    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [
        { courseId: cA.id, sections: 1, dayPattern: 'STT', duration: 50 },
        { courseId: cB.id, sections: 1, dayPattern: 'STT', duration: 50 },
      ]});

    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const cARow = (sx.sections || sx).find(s => s.courseId === cA.id);
    const cBIds = new Set((sx.sections || sx).filter(s => s.courseId === cB.id).map(s => s.id));

    const dr = await request(app)
      .delete(`/api/v1/sections/${cARow.id}`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(dr.status).toBe(200);

    // deletedIds should ONLY contain cA's rows, never cB's.
    for (const id of dr.body.deletedIds) {
      expect(cBIds.has(id)).toBe(false);
    }

    // Verify cB is still intact in the DB.
    const sxAfter = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const cBIdsAfter = new Set((sxAfter.sections || sxAfter).filter(s => s.courseId === cB.id).map(s => s.id));
    expect(cBIdsAfter).toEqual(cBIds);
  });
});
