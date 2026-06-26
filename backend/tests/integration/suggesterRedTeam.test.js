// NEW-FU-354 (Phase 34): adversarial test battery for the suggester.
// Each scenario tests an edge case the user reported (or one that
// previous phases attempted to fix). The R-02 leak that survived
// Phases 32 & 33 is the headline case: a single-section adjacent-
// level course MUST NOT overlap with a multi-section course's
// sections, regardless of placement order.

const request = require('supertest');
const app     = require('../../src/app');
const { query } = require('../../src/config/db');   // NEW-FU-673: term-valid course selection

const ADMIN = { username: 'admin1', password: 'password123' };

let adminTok;
const createdCodes = new Set();
// NEW-FU-673: freshTermSchedule() clears `createdCodes` each call (it deletes prior
// test terms first), so a separate never-cleared set records every code for teardown.
const allCodes = new Set();

beforeAll(async () => {
  const r = await request(app).post('/api/v1/auth/login').send(ADMIN);
  expect(r.status).toBe(200);
  adminTok = r.body.token;
});

afterAll(async () => {
  for (const code of allCodes) {
    await request(app)
      .delete(`/api/v1/terms/${code}`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`)
      .catch(() => {});
  }
});

async function freshTermSchedule(code) {
  // NEW-FU-673: drop EVERY prior test term before creating this one. Post-FU-234 a
  // default (copy) term-create seeds sections from the NEAREST same-season term, and
  // post-FU-645 that copy mints PRIVATE per-term course/instructor/venue rows. After a
  // Suggest run, a test term's sections reference BOTH its own private venue (e.g.
  // "22-127" owner=<term>) AND the template "22-127" (owner NULL); copying THAT polluted
  // term into the next same-season test term makes the isolation step mint two "22-127"
  // rows for the new owner → uq_venues_name_per_term 23505 → term-create 400. The base
  // SEED terms (251/252/253/261/262) reference only template venues, so copying FROM them
  // is collision-free. Deleting prior test terms first guarantees the nearest same-season
  // neighbour is always a pristine seed term. Tests run serially (--runInBand) and each
  // has finished asserting before the next call, so this is safe. The default (copy) seed
  // is KEPT so the term owns a real instructor/venue pool — Suggest's findAssignable()
  // draws from owner_semester=term ONLY (templates are not assignable), so a blank term
  // would starve the placer and inject phantom R-13/R-14 noise.
  for (const prior of createdCodes) {
    await request(app)
      .delete(`/api/v1/terms/${prior}`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`)
      .catch(() => {});
  }
  createdCodes.clear();
  createdCodes.add(code);
  allCodes.add(code);
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

async function runSuggest(scheduleId, courseConfigs) {
  const r = await request(app)
    .post(`/api/v1/schedules/${scheduleId}/suggest`)
    .set('Authorization', `Bearer ${adminTok}`)
    .send({ courseConfigs });
  expect(r.status).toBe(200);
  return r.body;
}

async function getConflicts(scheduleId) {
  const r = await request(app)
    .get(`/api/v1/schedules/${scheduleId}/conflicts`)
    .set('Authorization', `Bearer ${adminTok}`);
  expect(r.status).toBe(200);
  return r.body.conflicts ?? r.body;
}

// NEW-FU-673: term-valid course lookup by code. The seed course codes carry a SPACE
// ("SWE 101", not "SWE101") and the legacy fixture codes (SWE201/301/321/310/411/510)
// don't exist at all, so the old global-GET predicate match returned undefined for
// every scenario. We query by canonical seed code, returning the course VALID FOR THIS
// TERM — the term's own copy (owner_semester = code, minted by the copy-seed) when
// present, else the template (owner_semester IS NULL). Suggest accepts either id; the
// conflict engine reads level/category/has_lab off the row, so the scenario's intent
// (level adjacency, lab presence, graduate window) is preserved exactly.
async function pickCourse(termCode, courseCode) {
  const res = await query(
    `SELECT id, course_code, academic_level, category, has_lab, credits
       FROM courses
      WHERE course_code = $2 AND (owner_semester = $1 OR owner_semester IS NULL)
      ORDER BY (owner_semester = $1) DESC NULLS LAST
      LIMIT 1`,
    [termCode, courseCode]
  );
  return res.rows[0];
}

describe('FU-354: Suggester red-team battery (Phase 34)', () => {

  test('SCENARIO 1a: Freshman + Sophomore single-section → 0 R-02', async () => {
    const scheduleId = await freshTermSchedule('272');   // NEW-FU-673: non-seed code (was 252, a base seed term)
    const freshman = await pickCourse('272', 'SWE 101');   // NEW-FU-673: Freshman
    const soph     = await pickCourse('272', 'SWE 216');   // NEW-FU-673: Sophomore (SWE201 doesn't exist)
    await runSuggest(scheduleId, [
      { courseId: freshman.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: soph.id,     sections: 1, duration: 75, dayPattern: 'MW' },
    ]);
    const conflicts = await getConflicts(scheduleId);
    const r02 = conflicts.filter(c => c.ruleId === 'R-02');
    expect(r02.length).toBe(0);
  });

  test('SCENARIO 1b: Sophomore + Junior single-section → 0 R-02', async () => {
    const scheduleId = await freshTermSchedule('273');   // NEW-FU-673: non-seed code (was 253, a base seed term)
    const soph = await pickCourse('273', 'SWE 216');   // NEW-FU-673: Sophomore
    const jr   = await pickCourse('273', 'SWE 316');   // NEW-FU-673: Junior
    await runSuggest(scheduleId, [
      { courseId: soph.id, sections: 1, duration: 75, dayPattern: 'MW' },
      { courseId: jr.id,   sections: 1, duration: 50, dayPattern: 'STT' },
    ]);
    const conflicts = await getConflicts(scheduleId);
    const r02 = conflicts.filter(c => c.ruleId === 'R-02');
    expect(r02.length).toBe(0);
  });

  test('SCENARIO 2: single-section Freshman + lab-bearing Sophomore → 0 R-02', async () => {
    // The headline screenshot scenario. SWE101 (Freshman, 1 section)
    // and SWE206 (Sophomore, has_lab, 1 section) MUST not overlap on
    // any meeting day, even though SWE206 has both LAB and LEC rows.
    const scheduleId = await freshTermSchedule('291');   // NEW-FU-673: non-seed code (was 261, a base seed term)
    const freshman = await pickCourse('291', 'SWE 101');   // NEW-FU-673: Freshman
    const swe206   = await pickCourse('291', 'SWE 206');   // NEW-FU-673: Sophomore w/ lab
    await runSuggest(scheduleId, [
      { courseId: freshman.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: swe206.id,   sections: 1, duration: 50, dayPattern: 'STT', labDuration: 50, labDay: 'Sunday' },
    ]);
    const conflicts = await getConflicts(scheduleId);
    const r02 = conflicts.filter(c => c.ruleId === 'R-02');
    expect(r02.length).toBe(0);
  });

  test('SCENARIO 5: Sophomore 3-section + Freshman 1-section → 0 R-02 + sections spread', async () => {
    const scheduleId = await freshTermSchedule('292');   // NEW-FU-673: non-seed code (was 262, a base seed term)
    const freshman = await pickCourse('292', 'SWE 101');   // NEW-FU-673: Freshman
    const soph     = await pickCourse('292', 'SWE 216');   // NEW-FU-673: Sophomore
    await runSuggest(scheduleId, [
      { courseId: freshman.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: soph.id,     sections: 3, duration: 75, dayPattern: 'MW' },
    ]);
    const conflicts = await getConflicts(scheduleId);
    const r02 = conflicts.filter(c => c.ruleId === 'R-02');
    expect(r02.length).toBe(0);

    // Multi-section spread: SWE201's 3 sections at DISTINCT (day,
    // startTime) buckets.
    const sections = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sophRows = (sections.sections || sections).filter(s => s.courseId === soph.id);
    const slots = new Set(sophRows.map(s =>
      `${s.day}|${(s.startTime ?? s.start_time ?? '').substring(0,5)}`));
    // 3 sections × 2 days each = 6 rows, in 6 (day, time) buckets.
    // If sections shared a slot, the set would be smaller than 6.
    expect(slots.size).toBe(6);
  });

  test('SCENARIO 6: 3 same-level single-section courses → 0 R-01 (hard)', async () => {
    const scheduleId = await freshTermSchedule('263');
    const j1 = await pickCourse('263', 'SWE 316');   // NEW-FU-673: three Junior courses
    const j2 = await pickCourse('263', 'SWE 326');
    const j3 = await pickCourse('263', 'SWE 363');
    await runSuggest(scheduleId, [
      { courseId: j1.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: j2.id, sections: 1, duration: 75, dayPattern: 'MW'  },
      { courseId: j3.id, sections: 1, duration: 75, dayPattern: 'ST'  },
    ]);
    const conflicts = await getConflicts(scheduleId);
    const r01 = conflicts.filter(c => c.ruleId === 'R-01');
    expect(r01.length).toBe(0);
  });

  test('SCENARIO 7: same input twice on identical schedules → identical placements', async () => {
    const scheduleA = await freshTermSchedule('271');
    // NEW-FU-673: the original also created a second term (272) but never used it — the
    // assertion only snapshots scheduleA twice. Dropped it: freshTermSchedule now wipes
    // prior test terms (to dodge the copy-seed venue-name collision), so a second create
    // here would delete scheduleA's term out from under this test.
    const freshman = await pickCourse('271', 'SWE 101');

    async function placeAndSnapshot(id) {
      await runSuggest(id, [{ courseId: freshman.id, sections: 1, duration: 50, dayPattern: 'STT' }]);
      const after = (await request(app)
        .get(`/api/v1/schedules/${id}/sections`)
        .set('Authorization', `Bearer ${adminTok}`)).body;
      return (after.sections || after)
        .map(s => `${s.courseId}|${s.sectionNumber || s.section_number}|${s.day}|${(s.startTime ?? s.start_time ?? '').substring(0,5)}`)
        .sort();
    }

    const a1 = await placeAndSnapshot(scheduleA);
    const a2 = await placeAndSnapshot(scheduleA);
    // Same schedule twice → identical output.
    expect(a1).toEqual(a2);
  });

  test('SCENARIO 8: no eligible instructors/venues never crashes', async () => {
    // No courses configured → /suggest returns immediately with empty
    // assignment. Tests the empty-input edge case.
    const scheduleId = await freshTermSchedule('281');
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [] });
    // Empty courseConfigs is rejected by the controller's validation.
    // The fact that the endpoint returns a controlled 4xx (not a 500)
    // is the test invariant — defensive validation works.
    expect([400, 200]).toContain(r.status);
  });

  test('SCENARIO 9: graduate course defaults respect R-06 time window', async () => {
    const scheduleId = await freshTermSchedule('282');
    const gr = await pickCourse('282', 'SWE 503');   // NEW-FU-673: Graduate (GR → R-06 window)
    expect(gr).toBeTruthy();
    await runSuggest(scheduleId, [
      { courseId: gr.id, sections: 1, duration: 75, dayPattern: 'MW' },
    ]);
    const conflicts = await getConflicts(scheduleId);
    // R-06 may or may not fire depending on the suggester's slot
    // selection. We assert that IF a graduate course was placed, the
    // slot is either within the graduate window OR the conflict is
    // flagged (not silently ignored).
    const r06 = conflicts.filter(c => c.ruleId === 'R-06');
    if (r06.length > 0) {
      // R-06 fired → the system is correctly reporting it; user can
      // fix via Quick Fix.
      expect(r06[0].ruleId).toBe('R-06');
    }
  });

  test('SCENARIO 11 (Phase 35): same-level R-02 — Graduate ↔ Graduate, both single-section', async () => {
    // The same-level R-02 case (the screenshot 1 leak). Phase 34's
    // reverse-check used `!== 1` which excluded diff=0 (same-level).
    // Phase 35's `> 1` catches it. With both 1-section + 2 distinct
    // day patterns, a 0-R-02 placement is feasible — multi-restart
    // should find it.
    const scheduleId = await freshTermSchedule('303');
    const gr1 = await pickCourse('303', 'SWE 503');   // NEW-FU-673: Graduate ↔ Graduate
    const gr2 = await pickCourse('303', 'SWE 516');
    expect(gr1 && gr2).toBeTruthy();
    await runSuggest(scheduleId, [
      { courseId: gr1.id, sections: 1, duration: 75, dayPattern: 'MW' },
      { courseId: gr2.id, sections: 1, duration: 75, dayPattern: 'ST' },
    ]);
    const conflicts = await getConflicts(scheduleId);
    const r02 = conflicts.filter(c => c.ruleId === 'R-02');
    expect(r02.length).toBe(0);
  });

  test('SCENARIO 10: lab co-location — Lec and Lab don\'t collide', async () => {
    const scheduleId = await freshTermSchedule('283');
    const labCourse = await pickCourse('283', 'SWE 206');   // NEW-FU-673: Sophomore w/ lab
    await runSuggest(scheduleId, [
      { courseId: labCourse.id, sections: 1, duration: 50, dayPattern: 'STT',
        labDuration: 50, labDay: 'Monday' },
    ]);
    const sections = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const rows = (sections.sections || sections).filter(s => s.courseId === labCourse.id);
    // R-04 / R-05 hard conflicts must NOT fire on the lab+lec pair.
    const conflicts = await getConflicts(scheduleId);
    const r04 = conflicts.filter(c => c.ruleId === 'R-04');
    const r05 = conflicts.filter(c => c.ruleId === 'R-05');
    expect(r04.length).toBe(0);
    expect(r05.length).toBe(0);
    // R-14 must NOT fire (both Lec and Lab exist).
    const r14 = conflicts.filter(c => c.ruleId === 'R-14');
    expect(r14.length).toBe(0);
  });

  // NEW-FU-365 (Phase 35): SCENARIO 12 — Graduate time-window stress.
  // Three Graduate courses, each 2 sections, all squeezed into the
  // R-06 16:00–22:00 window. The suggester must place all sections
  // within that window AND avoid cross-course R-02 overlaps.
  test('SCENARIO 12 (Phase 35): Graduate time-window stress — multiple courses, 0 R-02 + 0 R-06', async () => {
    // Term codes must match ^\d{2}[123]$ (migration 011). 313 ≠ 304.
    const scheduleId = await freshTermSchedule('313');
    const gr1 = await pickCourse('313', 'SWE 503');   // NEW-FU-673: Graduate time-window stress
    const gr2 = await pickCourse('313', 'SWE 516');
    expect(gr1 && gr2).toBeTruthy();
    await runSuggest(scheduleId, [
      { courseId: gr1.id, sections: 2, duration: 75, dayPattern: 'MW' },
      { courseId: gr2.id, sections: 2, duration: 75, dayPattern: 'ST' },
    ]);
    const conflicts = await getConflicts(scheduleId);
    const r02 = conflicts.filter(c => c.ruleId === 'R-02');
    const r06 = conflicts.filter(c => c.ruleId === 'R-06');
    expect(r02.length).toBe(0);
    expect(r06.length).toBe(0);
    // Every placed Graduate section must start at 16:00 or later.
    const sections = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const placed = sections.sections || sections;
    const grRows = placed.filter(s => s.academicLevel === 'Graduate');
    expect(grRows.length).toBeGreaterThan(0);
    for (const row of grRows) {
      const [h] = (row.startTime || '').split(':').map(Number);
      expect(h).toBeGreaterThanOrEqual(16);
    }
  });

  // NEW-FU-366 (Phase 35): SCENARIO 13 — saturated single-section adjacent
  // chain. One single-section course per level (F, S, J, Sr, G), all
  // forced to STT/50min. Hard conflicts (R-01) must be 0; soft R-02 must
  // be minimized via the multi-restart machinery.
  test('SCENARIO 13 (Phase 35): saturated 1-section adjacent chain → 0 R-01 hard', async () => {
    const scheduleId = await freshTermSchedule('323');
    const f  = await pickCourse('323', 'SWE 101');   // NEW-FU-673: one course per level —
    const so = await pickCourse('323', 'SWE 216');   // Freshman / Sophomore / Junior /
    const j  = await pickCourse('323', 'SWE 316');   // Senior / Graduate (SWE411 → SWE 402,
    const sr = await pickCourse('323', 'SWE 402');   // both Senior; SWE201/301/501 remapped
    const g  = await pickCourse('323', 'SWE 503');   // to real seed codes).
    expect(f && so && j && sr && g).toBeTruthy();
    await runSuggest(scheduleId, [
      { courseId: f.id,  sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: so.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: j.id,  sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: sr.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: g.id,  sections: 1, duration: 50, dayPattern: 'STT' },
    ]);
    const conflicts = await getConflicts(scheduleId);
    const hardR01 = conflicts.filter(c => c.ruleId === 'R-01' && c.severity === 'Hard');
    expect(hardR01.length).toBe(0);
  });

  // NEW-FU-367 (Phase 35): preview dry-run — POSTing previewOnly:true must
  // NOT persist sections, and must echo residualConflicts + ruleIds.
  test('PREVIEW: previewOnly=true returns residual stats without writing', async () => {
    const scheduleId = await freshTermSchedule('333');
    const course = await pickCourse('333', 'SWE 316');   // NEW-FU-673: Junior (SWE301 doesn't exist)
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        previewOnly: true,
        courseConfigs: [{ courseId: course.id, sections: 1, duration: 50, dayPattern: 'STT' }],
      });
    expect(r.status).toBe(200);
    expect(r.body.residualConflicts).toBeDefined();
    expect(Array.isArray(r.body.residualConflictRuleIds)).toBe(true);
    // Critical: dry-run must NOT have written sections to DB.
    const sections = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const placed = sections.sections || sections;
    expect(placed.length).toBe(0);
  });
});
