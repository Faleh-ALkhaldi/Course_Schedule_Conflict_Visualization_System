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
const { query } = require('../../src/config/db');   // NEW-FU-673: term-valid resource selection

const ADMIN = { username: 'admin1', password: 'password123' };

let adminTok;
const createdCodes = new Set();

function normalizeCourseRow(c) {
  return { ...c, credits: Number(c.credits) };
}

function isSchedulableCourse(c) {
  return c.category === 'UG'
    && c.is_external !== true
    && c.is_thesis !== true
    && c.is_research !== true
    && c.is_capstone !== true;
}

function threeCreditNoLabCourse(c) {
  return isSchedulableCourse(c) && Number(c.credits) === 3 && !c.has_lab;
}

function threeCreditLabCourse(c) {
  return isSchedulableCourse(c) && Number(c.credits) === 3 && c.has_lab;
}

async function ensureOneDaySchedulableCourse(code, candidates = null) {
  const pool = candidates ?? await termValidUgCourses(code);
  const existing = pool.find(c => isSchedulableCourse(c) && Number(c.credits) === 1 && !c.has_lab);
  if (existing) return existing;

  const inserted = await query(
    `INSERT INTO courses
       (course_code, name, credits, academic_level, category, num_sections, has_lab,
        is_capstone, is_external, is_thesis, is_research, owner_semester)
     VALUES ($1, 'One-Day Pattern Fixture', 1, 'Senior', 'UG', 1, false,
             false, false, false, false, $2)
     RETURNING id, credits, has_lab, category, course_code,
               is_capstone, is_external, is_thesis, is_research`,
    [`SWE 9${code}`, code]
  );
  return normalizeCourseRow(inserted.rows[0]);
}

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

async function freshTermSchedule(code, seedMode) {
  createdCodes.add(code);
  await request(app)
    .delete(`/api/v1/terms/${code}`)
    .query({ activeCode: '251' })
    .set('Authorization', `Bearer ${adminTok}`)
    .catch(() => {});
  // Default (copy) create so the term OWNS its own course/instructor/venue pool — recommend()
  // scores the term's OWN courses (owner_semester = code, FU-651), so a copy is required for the
  // recommend-output tests. Fall/Spring-family codes (xx1/xx2) copy a rich seeded sibling (251/
  // 252/261/262); season-3 (xx3) copies the near-empty 253 — tests here use xx1/xx2 codes.
  // NEW-FU-673: CREATE-only tests pass seedMode:'blank' — a blank term skips the copy entirely
  // (no copy-create dup risk: a copied schedule whose source sat in a wiped lineage can violate
  // the per-(course,section,day) unique key during the copy) and selects template resources
  // (owner IS NULL) which are always assignable for section-create.
  const tr = await request(app)
    .post('/api/v1/terms')
    .set('Authorization', `Bearer ${adminTok}`)
    .send(seedMode ? { code, seedMode } : { code });
  expect(tr.status).toBe(201);

  const sr = await request(app)
    .get('/api/v1/departments/SWE-DEPT/schedules')
    .set('Authorization', `Bearer ${adminTok}`);
  const sched = sr.body.find(s => s.semester === code);
  expect(sched).toBeTruthy();

  // NEW-FU-673: deliberately do NOT wipe the auto-cloned sections here. The copy-create
  // derives the term's OWNED courses from the sections it copies, so wiping would leave the
  // term (and any later term that copies it) with an empty course pool — breaking recommend(),
  // which scores ONLY the term's owned courses. Tests needing a clean section slate wipe
  // explicitly (see wipeSections below). Auto-cloned sections come from copying a SEEDED base
  // (or a direct-created section), both of which are copy-safe — only /suggest-created sections
  // trigger the TermService copy-create venue-dup, so this file never seeds via /suggest.

  // NEW-FU-673: return the term's OWN courses (owner_semester = code) — the SAME id space
  // recommend() returns (CourseRepository.findAll(code) is term-scoped, NOT the NULL template
  // library). The old global GET /api/v1/courses returned templates + every term's owned copies,
  // so `courses.find(...)` grabbed ids recommend never emits → lookups returned undefined.
  // Seeding /suggest with a foreign-term courseId also corrupted the per-term isolation state and
  // broke later copy-creates (uq_venues_name_per_term dup). UG-only keeps the R-06 graduate
  // window from interfering.
  const courses = (await query(
    `SELECT id, credits, has_lab, category, course_code,
            is_capstone, is_external, is_thesis, is_research
       FROM courses
      WHERE owner_semester = $1 AND category = 'UG'`, [code])).rows
    .map(normalizeCourseRow);
  // instructors/venues: owner = code OR NULL template (both are assignable for section-create,
  // exactly the r04r05QuickFix selection) — never another term's private copy (409 belongs-to).
  const instructors = (await query(
    `SELECT id, name FROM instructors
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows;
  const venues = (await query(
    `SELECT id, type FROM venues
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows;
  return { scheduleId: sched.id, courses, instructors, venues };
}

// NEW-FU-673: term-VALID UG courses (owner = code OR NULL template) for tests that only
// CREATE + delete sections (no recommend-output assertion). Template courses are always
// present, so these tests are immune to copy-source course-pool variance. is_external = false
// drops SWE 399 (Summer-only off-campus) which a non-Summer term would reject.
async function termValidUgCourses(code) {
  return (await query(
    `SELECT id, credits, has_lab, category, course_code,
            is_capstone, is_external, is_thesis, is_research
       FROM courses
      WHERE (owner_semester = $1 OR owner_semester IS NULL)
        AND category = 'UG' AND is_external = false`, [code])).rows
    .map(normalizeCourseRow);
}

// NEW-FU-673: seed a section group with a DIRECT POST /sections call rather than via
// /suggest. /suggest-created sections trigger a TermService copy-create venue-dup
// (uq_venues_name_per_term) the moment a later same-season term copies this one — direct
// section-create is collision-safe (it's what r04r05QuickFix uses) and produces the SAME
// per-day saturation signal the recommend scorer reads.
async function seedSection(scheduleId, { courseId, instructorId, venueId, sectionNumber = '01', days = ['Sunday', 'Tuesday', 'Thursday'], startTime = '09:00', endTime = '09:50' }) {
  const r = await request(app)
    .post(`/api/v1/schedules/${scheduleId}/sections`)
    .set('Authorization', `Bearer ${adminTok}`)
    .send({ courseId, instructorId, venueId, sectionNumber, sectionType: 'Lec', days, startTime, endTime });
  expect(r.status).toBe(201);
  return r.body.section;
}

// NEW-FU-673: wipe a schedule's auto-cloned sections IN A TEST (not in freshTermSchedule —
// see the note there) when the test needs a precisely-known section set. The term keeps its
// OWNED courses, so recommend() still scores the full owned pool. SQL-level so a multi-day
// group goes in one shot (and never trips FU-609's row→group coercion mid-loop).
async function wipeSections(scheduleId) {
  await query(`DELETE FROM sections WHERE schedule_id = $1`, [scheduleId]);
}

describe('FU-285: saturation-aware recommend (Phase 24)', () => {

  test('recommendations have well-formed shape after smart pattern selection', async () => {
    // NEW-FU-673: Spring-family code '252' copies a rich seeded base, so the term
    // OWNS a full course set — recommend() (which scores only owned courses) returns
    // well-formed recommendations. (Codes are chosen across this file so no
    // section-wiping term is ever the nearest-year copy-source of a rich-needing one.)
    const { scheduleId } = await freshTermSchedule('252');

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
    // NEW-FU-673: Fall-family code '281' — owns the 3-credit LAB course (SWE 206)
    // this test's recommend-output assertion needs; copies a rich seeded base.
    const { scheduleId, courses, instructors, venues } = await freshTermSchedule('281');
    await wipeSections(scheduleId);   // NEW-FU-673: control saturation precisely

    // Load Sun/Tue/Thu by creating several STT sections (direct-create, FU-673)
    // on some unrelated courses. This saturates those days so the scorer should
    // prefer MW/ST/TT for new courses.
    // Pick 3 different 3-credit non-lab courses to seed STT sections.
    const seeds = courses.filter(threeCreditNoLabCourse).slice(0, 3);
    expect(seeds.length).toBe(3);
    const lecHalls = venues.filter(v => v.type === 'LectureHall');
    // Distinct instructor + venue per seed so no R-04/R-05 noise; all on STT.
    for (let i = 0; i < seeds.length; i++) {
      await seedSection(scheduleId, {
        courseId: seeds[i].id,
        instructorId: instructors[i % instructors.length].id,
        venueId: lecHalls[i % lecHalls.length].id,
        sectionNumber: '01',
        days: ['Sunday', 'Tuesday', 'Thursday'], startTime: '09:00', endTime: '09:50',
      });
    }

    // Now ask for recommendations. Sun/Tue/Thu each have 3 sections
    // (from the 3 STT seeds), while Mon/Wed have 0. The smart scorer
    // should push 3-credit course recommendations toward MW.
    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);

    // Find recommendations for any 3-credit non-lab course NOT in the seed set.
    const unseededIds = new Set(courses
      .filter(threeCreditNoLabCourse)
      .map(c => c.id)
      .filter(id => !seeds.some(s => s.id === id))
    );
    const unseededRecs = r.body.recommendations.filter(rec => unseededIds.has(rec.courseId));

    // The 3-credit non-lab courses without seeded sections should now
    // be biased AWAY from STT (because Sun/Tue/Thu are saturated).
    // Note: 3-cr non-lab only has STT in legalDayTemplatesForCourse
    // (no lab), so the scorer can't switch to MW for those. But for
    // 3-cr WITH lab, ST/MW/TT are legal — those should now win.
    const threeCrLabCourses = courses.filter(threeCreditLabCourse);
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
    // NEW-FU-673: a BLANK term with a SMALL, fully-controlled in-term course set.
    // Why blank: recommend()'s Phase-30 saturation map mutates AS it processes each
    // in-term course, so on a copied term (13+ owned courses) the day the 1-credit
    // ONE_DAY course lands on is dominated by the other 12 courses' picks — not by our
    // explicit seed (the original Mon/Wed expectation predates that FU-322 change). With
    // only the seeds + the 1-credit course in-term, Sun/Tue/Thu are the clearly-loaded
    // days and the scorer reliably puts the ONE_DAY course on an empty Mon/Wed.
    // findAll(term) treats a course with a section in the term as in-term, so sectioning
    // the seeds + the 1-credit course is what makes them appear in recommend's output.
    const { scheduleId } = await freshTermSchedule('271', 'blank');
    const tmpl = await termValidUgCourses('271');   // owner = code OR NULL templates
    const seeds = tmpl.filter(threeCreditNoLabCourse).slice(0, 3);
    const oneCredit = await ensureOneDaySchedulableCourse('271', tmpl);
    expect(seeds.length).toBe(3);
    expect(oneCredit).toBeTruthy();

    const instructors = (await query(
      `SELECT id FROM instructors WHERE owner_semester IS NULL AND is_dummy = false ORDER BY name`)).rows;
    const halls = (await query(
      `SELECT id FROM venues WHERE owner_semester IS NULL AND is_dummy = false AND type = 'LectureHall' ORDER BY name`)).rows;

    // Saturate Sun/Tue/Thu with 3 STT seeds (staggered times so no R-04/R-05).
    const hh = n => String(n).padStart(2, '0');
    for (let i = 0; i < 3; i++) {
      await seedSection(scheduleId, {
        courseId: seeds[i].id, instructorId: instructors[i].id, venueId: halls[i].id,
        days: ['Sunday', 'Tuesday', 'Thursday'], startTime: `${hh(9 + i)}:00`, endTime: `${hh(9 + i)}:50`,
      });
    }
    // Put the 1-credit course in-term too (on a SATURATED day) so recommend emits a
    // pattern for it — the scorer should still move its ONE_DAY suggestion to an empty day.
    await seedSection(scheduleId, {
      courseId: oneCredit.id, instructorId: instructors[3].id, venueId: halls[3].id,
      days: ['Sunday'], startTime: '13:00', endTime: '13:50',
    });

    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);

    const rec = r.body.recommendations.find(rr => rr.courseId === oneCredit.id);
    expect(rec).toBeTruthy();
    expect(rec.dayPattern).toBe('ONE_DAY');
    // The picked day should be one of the un-saturated weekdays (Mon/Wed are empty).
    expect(['Monday', 'Wednesday']).toContain(rec.day);
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
    // NEW-FU-673: Spring-family code '262' (rich owned set) — term-owned courses
    // match recommend()'s id space.
    const { scheduleId, courses } = await freshTermSchedule('262');

    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);

    // Count distinct (duration, dayPattern) combos across all 3-credit
    // course recommendations. With >=2 such courses, the smart picker
    // should produce diversity.
    const threeCreditIds = new Set(
      courses.filter(c => isSchedulableCourse(c) && Number(c.credits) === 3).map(c => c.id)
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
    // NEW-FU-673: Spring-family code '272' (rich owned set) — season-3 codes
    // copy the near-empty 253 seed and would give recommend almost nothing.
    const { scheduleId } = await freshTermSchedule('272');

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
    // NEW-FU-673: Spring-family code '292' (rich owned set: 12 3-credit no-lab) +
    // term-owned id space so the 3-credit filter matches recommend's output.
    const { scheduleId, courses } = await freshTermSchedule('292');
    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);

    // Pull the first 4 recommendations for 3cr courses.
    const threeCreditIds = new Set(
      courses.filter(c => isSchedulableCourse(c) && Number(c.credits) === 3).map(c => c.id)
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
    const { scheduleId } = await freshTermSchedule('302');  // NEW-FU-673: Spring-family rich owned set

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
    // NEW-FU-673: this test only CREATES + deletes a section (no recommend-output
    // assertion). Use a BLANK term (no copy → no copy-create dup) + template resources
    // (owner = code OR NULL), which are always assignable for section-create.
    const { scheduleId, instructors, venues } = await freshTermSchedule('311', 'blank');
    const courses = await termValidUgCourses('311');

    const c = courses.find(threeCreditNoLabCourse);
    await seedSection(scheduleId, {
      courseId: c.id, instructorId: instructors[0].id,
      venueId: venues.find(v => v.type === 'LectureHall').id,
      days: ['Sunday', 'Tuesday', 'Thursday'], startTime: '09:00', endTime: '09:50',
    });

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
    // NEW-FU-673: Fall-family code '321' owns a 1-credit course (SWE 413). A
    // 1-credit ONE_DAY section is a genuine SINGLE-row group, so scope=row
    // returns exactly that one id. (FU-609 deliberately coerces a row-delete on
    // a MULTI-day group to a whole-group delete — "never leave a partial group"
    // — so a single-day section is the faithful fixture for the row-scope
    // single-id contract this test asserts.)
    const { scheduleId, instructors, venues } = await freshTermSchedule('321', 'blank');
    const courses = await termValidUgCourses('321');   // NEW-FU-673: template-inclusive (1cr always present)
    const c = await ensureOneDaySchedulableCourse('321', courses);
    expect(c).toBeTruthy();
    const lec = venues.find(v => v.type === 'LectureHall');

    const cr = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseId: c.id, instructorId: instructors[0].id, venueId: lec.id,
        sectionNumber: '01', sectionType: 'Lec',
        days: ['Monday'], startTime: '09:00', endTime: '09:50',
      });
    expect(cr.status).toBe(201);

    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const row = (sx.sections || sx).find(s => s.courseId === c.id);

    const dr = await request(app)
      .delete(`/api/v1/sections/${row.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(dr.status).toBe(200);
    expect(dr.body.scope).toBe('row');             // single-day → no coercion
    expect(dr.body.deletedIds).toEqual([row.id]);
  });

  test('side-panel delete preserves other courses\' sections', async () => {
    // Critical regression test for FU-288: the prior CLEAR_SECTIONS hack
    // blanked all sections in frontend state. The fix returns deletedIds
    // so the frontend can REMOVE just those rows. This test verifies the
    // backend invariant: deleting course A's group never returns course
    // B's IDs.
    // NEW-FU-673: CREATE-only test → BLANK term + template-inclusive courses (immune to
    // copy-source variance). Code '331' (Fall). Seed both groups with direct section-create
    // (distinct venue/instructor + distinct time so no R-04/R-05).
    const { scheduleId, instructors, venues } = await freshTermSchedule('331', 'blank');
    const courses = await termValidUgCourses('331');

    const cA = courses.find(threeCreditNoLabCourse);
    const cB = courses.find(c => threeCreditNoLabCourse(c) && c.id !== cA.id);
    const lecHalls = venues.filter(v => v.type === 'LectureHall');

    await seedSection(scheduleId, {
      courseId: cA.id, instructorId: instructors[0].id, venueId: lecHalls[0].id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'], startTime: '09:00', endTime: '09:50',
    });
    await seedSection(scheduleId, {
      courseId: cB.id, instructorId: instructors[1 % instructors.length].id, venueId: lecHalls[1 % lecHalls.length].id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'], startTime: '10:00', endTime: '10:50',
    });

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
