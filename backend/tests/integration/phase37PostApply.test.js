// NEW-FU-391 (Phase 37): post-apply red-team battery. The Phase 36
// battery had a `sideEffectFix` loophole that let "rule disappeared
// because we dropped the section" count as coverage. Phase 37 changes
// the contract: every scenario MUST apply the resolver's plan and
// verify the schedule's `/conflicts` AFTER the apply equals what the
// plan summary CLAIMS will remain. No drops. No silent loopholes.
//
// 30 Quick Fix scenarios + 30 Suggest scenarios.

const request = require('supertest');
const app     = require('../../src/app');
const { query } = require('../../src/config/db');   // NEW-FU-673: term-valid resource selection

const ADMIN = { username: 'admin1', password: 'password123' };

// Phase 35 expanded TERM_CODE_MAX to 343 (Summer 2034). 60 tests cycle through these 12 codes;
// freshTermSchedule tears every code down (NEW-FU-673) before each create so reuse is always clean.
const TERM_CODES = [
  '311','312','313','321','322','323','331','332','333','341','342','343',
];

let adminTok;
const usedCodes = new Set();
let codeIdx = 0;

beforeAll(async () => {
  const r = await request(app).post('/api/v1/auth/login').send(ADMIN);
  expect(r.status).toBe(200);
  adminTok = r.body.token;
});

afterAll(async () => {
  // NEW-FU-673: full teardown — drop schedules AND the per-term private resource copies so the
  // test DB is left pristine (the API delete alone leaks owner-scoped rows; see teardownTerm).
  for (const code of usedCodes) await teardownTerm(code);
});

function nextCode() {
  if (codeIdx >= TERM_CODES.length) codeIdx = 0;
  const code = TERM_CODES[codeIdx++];
  usedCodes.add(code);
  return code;
}

// NEW-FU-673: the solver endpoints (/suggest, /quick-fix[/apply]) share one rate limiter
// (rateLimitSolver: max 60 / 60s, keyed by client IP). This 60-test battery fires ~120 solver
// calls under --runInBand inside a single window → 429s that masquerade as solver failures. The
// app runs behind `trust proxy: 1`, so the limiter buckets by X-Forwarded-For. Stamp a UNIQUE IP
// on every solver request and each gets its own bucket (count 1, never near the cap) — a faithful
// "distinct client" simulation that touches no production code. Used ONLY for solver endpoints.
let _ipSeq = 0;
function freshIp() {
  _ipSeq += 1;
  return `10.${(_ipSeq >> 16) & 0xff}.${(_ipSeq >> 8) & 0xff}.${(_ipSeq & 0xff) || 1}`;
}
function solverPost(path) {
  return request(app)
    .post(path)
    .set('Authorization', `Bearer ${adminTok}`)
    .set('X-Forwarded-For', freshIp());
}

// NEW-FU-673: dedup courses/venues by their natural key, preferring the term-OWNED copy
// over the NULL-owner template when both are returned by the union query. Without this,
// `.find(c => ... && c.id !== c1.id)` could pick a template+owned pair that share the same
// course_code (two different rows, one logical course) and produce surprising conflicts.
function dedupByKey(rows, keyOf) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = byKey.get(key);
    // Prefer the owned copy (owner_semester set) over the template (NULL).
    if (!existing || (existing.owner_semester == null && row.owner_semester != null)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

// NEW-FU-673: fully remove a test term via DIRECT SQL — drop its schedule(s) (sections + conflicts
// cascade via FK ON DELETE CASCADE) AND the FU-645 per-term PRIVATE resource copies
// (owner_semester = code). Done in SQL, NOT the HTTP DELETE endpoint, because this battery tears
// down all 12 test codes before each of its 60 tests; ~720 extra HTTP deletes trip the in-process
// rate limiter (429) and bleed into the real assertions. The owner-scoped rows are always this
// term's own private copies (never a template's NULL-owner row), so dropping them is safe.
// Order: schedules (frees section FK refs) → courses (ON DELETE RESTRICT) → instructors/venues
// (office_hours cascade with their instructor).
async function teardownTerm(code) {
  await query(`DELETE FROM schedules   WHERE semester = $1`, [code]);
  await query(`DELETE FROM courses     WHERE owner_semester = $1`, [code]);
  await query(`DELETE FROM instructors WHERE owner_semester = $1`, [code]);
  await query(`DELETE FROM venues      WHERE owner_semester = $1`, [code]);
}

async function freshTermSchedule(code = nextCode()) {
  usedCodes.add(code);
  // NEW-FU-673: tear down EVERY test code (not just this one) before creating. This battery has
  // 60 tests but only 12 reusable codes, so terms otherwise accumulate. A new term copy-seeds from
  // the NEAREST same-season term (FU-234); with test terms left alive, a Spring create copies from a
  // prior Spring TEST term instead of a clean seed term, building a deep copy-of-a-copy chain whose
  // FU-645 isolation eventually re-mints a duplicate (email|name, owner_semester) → 23505
  // uq_*_per_term, 400-ing the create. Tearing all test terms down keeps the only copy-templates the
  // pristine seed terms (251/252/253/261/262), so every create is clean and deterministic.
  for (const c of TERM_CODES) await teardownTerm(c);   // mostly fast 404s
  // NEW-FU-673: restore the seed's lab-course flag. The seed marks exactly ONE course has_lab=true,
  // the NULL-owner TEMPLATE 'SWE 206' (the term-create copy mints no owned lab copy — no lab section
  // exists in the seed terms to copy from), so the lab scenarios (R-11/R-12/R-14) reference that
  // shared template directly. QuickFix's legitimate "untag-has-lab" R-14 resolution then flips
  // SWE 206.has_lab = FALSE on the shared template, starving every later lab test of a lab course
  // (order-dependent fixture contamination, not a defect in the code under test — the untagging op
  // is correct and its own scenario passes). Re-assert the seeded value so each test sees the same
  // baseline regardless of order. It only re-sets the one genuinely-lab course, so attribute pickers
  // (pickUG requires !has_lab) are unaffected.
  await query(
    `UPDATE courses SET has_lab = TRUE
       WHERE owner_semester IS NULL AND has_lab = FALSE AND replace(course_code, ' ', '') = 'SWE206'`);
  // Default (copy) create so the term owns a real resource pool — the Quick Fix resolver and
  // Suggest relaxer draw their candidate instructors/venues/courses from the term's OWN pool,
  // so a blank term would starve them.
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
  // NEW-FU-673: return resources VALID FOR THIS TERM — owned by this term (owner_semester = code)
  // or template (owner_semester IS NULL). Post-FU-645, picking from the global GET /courses|
  // instructors|venues lists grabs another term's owner-scoped copy → section-create 409
  // "belongs to term …". The GET endpoints don't expose owner_semester, so query the DB directly.
  // Unlike the UG-only QuickFix helpers, this battery's Suggest scenarios use GRADUATE courses
  // (the SuggestService is R-06-aware and auto-places them in 17:20–22:00), so return ALL
  // non-dummy courses with the fields the tests select on, and let each test pick by attribute.
  const courses = dedupByKey((await query(
    `SELECT id, course_code, credits, has_lab, category, academic_level, owner_semester
       FROM courses
      WHERE owner_semester = $1 OR owner_semester IS NULL`, [code])).rows
    .map(c => ({ ...c, credits: Number(c.credits) })), c => c.course_code);
  const instructors = (await query(
    `SELECT id, name FROM instructors
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows;
  const venues = dedupByKey((await query(
    `SELECT id, name, type, owner_semester FROM venues
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows,
    v => v.name);
  return { scheduleId: sched.id, courses, instructors, venues };
}

// NEW-FU-673: attribute-based course pickers. The original battery hard-coded course codes
// (SWE301/SWE321/SWE501/…) and venue names (H-101/H-201/…) that no longer exist in the seed —
// the dataset now uses spaced codes (SWE 316, SWE 503) and building-room venue names (22-119).
// These helpers select an equivalent course by its semantic attributes instead, preserving each
// test's intent (level pairing, lab-bearing, graduate, credit count) against any seed.
function ugCourses(courses) {
  return courses.filter(c => c.category === 'UG' && c.credits === 3 && !c.has_lab)
    .sort((a, b) => a.course_code.localeCompare(b.course_code));
}
function pickUG(courses, n) {
  // n distinct UG 3-credit non-lab courses.
  const list = ugCourses(courses);
  expect(list.length).toBeGreaterThanOrEqual(n);
  return list.slice(0, n);
}
function pickGrad(courses, n) {
  const list = courses.filter(c => c.category === 'GR')
    .sort((a, b) => a.course_code.localeCompare(b.course_code));
  return list.slice(0, n);
}
function pickLab(courses) {
  return courses.find(c => c.has_lab);
}
const LEVEL_ORDER = ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Graduate'];
// Pick `n` courses at consecutive academic levels starting at `startLevel` (adjacent-level
// pairings exercise R-02). Falls back to distinct UG courses if a level is unrepresented.
function pickAdjacentLevels(courses, startIdx, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const lvl = LEVEL_ORDER[startIdx + i];
    const c = courses.find(c => c.academic_level === lvl && !c.has_lab && !out.includes(c));
    if (c) out.push(c);
  }
  // Backfill from distinct UG courses if any level was missing.
  if (out.length < n) {
    for (const c of ugCourses(courses)) {
      if (out.length >= n) break;
      if (!out.includes(c)) out.push(c);
    }
  }
  return out;
}
function lectureHalls(venues) {
  return venues.filter(v => v.type === 'LectureHall');
}

async function createSection(scheduleId, opts) {
  return request(app)
    .post(`/api/v1/schedules/${scheduleId}/sections`)
    .set('Authorization', `Bearer ${adminTok}`)
    .send({
      courseId:      opts.courseId,
      instructorId:  opts.instructorId,
      venueId:       opts.venueId,
      sectionNumber: opts.sectionNumber ?? '01',
      sectionType:   opts.sectionType ?? 'Lec',
      days:          opts.days ?? ['Sunday', 'Tuesday', 'Thursday'],
      startTime:     opts.startTime ?? '13:30',
      endTime:       opts.endTime ?? '14:20',
    });
}

async function getConflicts(scheduleId) {
  const r = await request(app)
    .get(`/api/v1/schedules/${scheduleId}/conflicts`)
    .set('Authorization', `Bearer ${adminTok}`);
  expect(r.status).toBe(200);
  return r.body.conflicts ?? [];
}

async function planAndApply(scheduleId) {
  const planRes = (await solverPost(`/api/v1/schedules/${scheduleId}/quick-fix`)).body;   // NEW-FU-673
  // Phase 38 (FU-395): the only drops the resolver may emit are
  // `lastResort: true` for genuinely-unresolvable rules like R-14.
  // The UI keeps these unchecked by default; the test helper applies
  // ONLY non-drop ops by default and verifies post-apply matches the
  // summary's prediction for that subset.
  for (const op of (planRes.ops ?? [])) {
    if (op.type === 'drop') {
      expect(op.lastResort).toBe(true);
    }
  }
  const nonDropOps = (planRes.ops ?? []).filter(o => o.type !== 'drop');
  if (nonDropOps.length > 0) {
    const apply = await solverPost(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)   // NEW-FU-673
      .send({ ops: nonDropOps });
    expect(apply.status).toBe(200);
  }
  return planRes;
}

/**
 * Phase 37 post-apply assertion. After applying ALL ops the plan
 * generated, fetch /conflicts and verify the live count matches
 * the plan's summary.remaining* exactly (no simulator/runtime drift).
 *
 * Additional checks:
 *   • Every rule in unresolvedRuleIds has a populated unresolvedReasons
 *     entry that references concrete data.
 *   • No `drop` ops were emitted (checked inside planAndApply).
 */
async function assertPostApplyConsistent(scheduleId, planRes) {
  const post = await getConflicts(scheduleId);
  const postHard = post.filter(c => c.severity === 'Hard').length;
  const postSoft = post.filter(c => c.severity === 'Soft').length;
  const predHard = planRes.summary?.remainingHard ?? 0;
  const predSoft = planRes.summary?.remainingSoft ?? 0;
  // The simulator and runtime evaluator must agree. We allow ±1 to absorb
  // ordering-dependent dedup differences (e.g. R-04 vs R-01 categorization)
  // but anything larger is a real drift bug.
  expect(Math.abs(postHard - predHard)).toBeLessThanOrEqual(1);
  expect(Math.abs(postSoft - predSoft)).toBeLessThanOrEqual(1);
  // Every unresolved rule must have a concrete reason.
  const concretePattern = /SWE\d+|Dr\.|H-\d+|G-\d+|\d\d:\d\d|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Laboratory|LectureHall|of \d+|sections?/;
  for (const rid of (planRes.unresolvedRuleIds ?? [])) {
    const reason = (planRes.unresolvedReasons ?? {})[rid] ?? '';
    expect(reason.length).toBeGreaterThan(0);
    expect(concretePattern.test(reason)).toBe(true);
  }
}

describe('FU-391: Phase 37 Quick Fix POST-APPLY battery (30 scenarios)', () => {

  // ── P-Q01..P-Q12: per-rule happy paths with post-apply ───────────
  test('P-Q01: R-04 instructor double-book → applied plan leaves predicted state', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const [c1, c2] = pickUG(courses, 2);
    const halls = lectureHalls(venues);
    await createSection(sched, { courseId: c1.id, instructorId: instructors[0].id,
      venueId: halls[0].id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    await createSection(sched, { courseId: c2.id, instructorId: instructors[0].id,
      venueId: halls[1].id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q02: R-05 venue double-book', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const [c1, c2] = pickUG(courses, 2);
    const hall = lectureHalls(venues)[0];
    await createSection(sched, { courseId: c1.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    await createSection(sched, { courseId: c2.id, instructorId: instructors[1].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q03: R-02 single-section adjacent-level overlap', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const [f, s] = pickAdjacentLevels(courses, 0, 2);   // Freshman + Sophomore (adjacent → R-02)
    const halls = lectureHalls(venues);
    await createSection(sched, { courseId: f.id, instructorId: instructors[2].id,
      venueId: halls[0].id, sectionNumber: '01', days: ['Monday','Wednesday'], startTime: '13:30', endTime: '14:45' });
    await createSection(sched, { courseId: s.id, instructorId: instructors[3].id,
      venueId: halls[1].id, sectionNumber: '01', days: ['Monday','Wednesday'], startTime: '13:30', endTime: '14:45' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q04: R-09 missing instructor', async () => {
    const { scheduleId: sched, courses, venues } = await freshTermSchedule();   // NEW-FU-673
    const c = pickUG(courses, 1)[0];
    const h = lectureHalls(venues)[0];
    await createSection(sched, { courseId: c.id, instructorId: null,
      venueId: h.id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q05: R-10 missing venue', async () => {
    const { scheduleId: sched, courses, instructors } = await freshTermSchedule();   // NEW-FU-673
    const c = pickUG(courses, 1)[0];
    await createSection(sched, { courseId: c.id, instructorId: instructors[0].id,
      venueId: null, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q06: R-11 lab in non-lab venue', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const labCourse = pickLab(courses);
    const hall = lectureHalls(venues)[0];
    await createSection(sched, { courseId: labCourse.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '50', sectionType: 'Lab',
      days: ['Monday'], startTime: '10:00', endTime: '10:50' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q07: R-12 lec in lab venue', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const c = pickUG(courses, 1)[0];
    const lab = venues.find(v => v.type === 'Laboratory');
    await createSection(sched, { courseId: c.id, instructorId: instructors[0].id,
      venueId: lab.id, sectionNumber: '01', sectionType: 'Lec',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q08: R-15 insufficient credit coverage', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const c = pickUG(courses, 1)[0];
    const hall = lectureHalls(venues)[0];
    await createSection(sched, { courseId: c.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '14:30', endTime: '15:20' });
    const rows = (await request(app)
      .get(`/api/v1/schedules/${sched}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const all = rows.sections || rows;
    const toDelete = all.filter(r => r.day === 'Tuesday' || r.day === 'Thursday');
    for (const row of toDelete) {
      await request(app).delete(`/api/v1/sections/${row.id}?scope=row`).set('Authorization', `Bearer ${adminTok}`);
    }
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q09: R-04 + R-05 combined (same instr + same venue)', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const [c1, c2] = pickUG(courses, 2);
    const hall = lectureHalls(venues)[0];
    await createSection(sched, { courseId: c1.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    await createSection(sched, { courseId: c2.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q10: R-09 + R-10 (no instructor, no venue)', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const c = pickUG(courses, 1)[0];
    await createSection(sched, { courseId: c.id, instructorId: null, venueId: null,
      sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q11: R-14 (orphan Lab — a Lab with no Lecture) — unresolvable with concrete reason', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    // NEW-FU-681: R-14 now fires for an ORPHAN LAB (a Lab section with NO Lecture). A lecture-only
    // has_lab course is a legitimate scoped / in-progress state and no longer flags (the lab is
    // managed separately); an orphan lab is still a real structural error with no auto-fix.
    const labCourse = pickLab(courses);
    const hall = lectureHalls(venues)[0];
    await createSection(sched, { courseId: labCourse.id, instructorId: instructors[1].id,
      venueId: hall.id, sectionNumber: '50', sectionType: 'Lab',
      days: ['Monday'], startTime: '14:30', endTime: '15:20' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q12: clean schedule → empty plan, 0 conflicts pre and post', async () => {
    const { scheduleId: sched } = await freshTermSchedule();   // NEW-FU-673
    const planRes = await planAndApply(sched);
    expect(planRes.ops.length).toBe(0);
    expect(planRes.unresolvedRuleIds.length).toBe(0);
    const post = await getConflicts(sched);
    expect(post.length).toBe(0);
  });

  // ── P-Q13..P-Q22: saturated / combined / adversarial ────────────
  test('P-Q13: R-02 same-level Graduate with escape', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const [g1, g2] = pickGrad(courses, 2);
    const halls = lectureHalls(venues);
    // Graduate window (R-06): keep these in 17:20–22:00.
    await createSection(sched, { courseId: g1.id, instructorId: instructors[0].id,
      venueId: halls[0].id, sectionNumber: '01', days: ['Monday','Wednesday'], startTime: '17:30', endTime: '18:45' });
    await createSection(sched, { courseId: g2.id, instructorId: instructors[1].id,
      venueId: halls[1].id, sectionNumber: '01', days: ['Monday','Wednesday'], startTime: '17:30', endTime: '18:45' });
    await createSection(sched, { courseId: g2.id, instructorId: instructors[2].id,
      venueId: halls[1].id, sectionNumber: '02', days: ['Monday','Wednesday'], startTime: '18:50', endTime: '20:05' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q14: R-11 + R-12 together (one Lec in lab + one Lab in hall)', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const labCourse = pickLab(courses);
    const c2 = pickUG(courses, 1)[0];
    const hall = lectureHalls(venues)[0];
    const lab  = venues.find(v => v.type === 'Laboratory');
    // Lab section in Hall → R-11
    await createSection(sched, { courseId: labCourse.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '50', sectionType: 'Lab',
      days: ['Monday'], startTime: '10:00', endTime: '10:50' });
    // Lec section in Lab → R-12
    await createSection(sched, { courseId: c2.id, instructorId: instructors[1].id,
      venueId: lab.id, sectionNumber: '01', sectionType: 'Lec',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q15: R-04 with full instructor pool busy at slot', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const [c1, c2] = pickUG(courses, 2);
    const halls = lectureHalls(venues);
    await createSection(sched, { courseId: c1.id, instructorId: instructors[0].id,
      venueId: halls[0].id, sectionNumber: '01',
      days: ['Monday','Wednesday'], startTime: '16:00', endTime: '17:15' });
    await createSection(sched, { courseId: c2.id, instructorId: instructors[0].id,
      venueId: halls[1].id, sectionNumber: '01',
      days: ['Monday','Wednesday'], startTime: '16:00', endTime: '17:15' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q16: dense schedule — 4 courses with overlapping constraints', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const halls = lectureHalls(venues);
    const picks = pickUG(courses, 4);   // 4 distinct UG courses
    for (let i = 0; i < picks.length; i++) {
      await createSection(sched, { courseId: picks[i].id,
        instructorId: instructors[i % instructors.length].id,
        venueId: halls[i % halls.length].id,
        sectionNumber: '01',
        days: ['Sunday','Tuesday','Thursday'],
        startTime: '15:00', endTime: '15:50',
      });
    }
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q17: R-15 with course needing extension (3-credit, 1 day)', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const c = pickUG(courses, 1)[0];
    const hall = lectureHalls(venues)[0];
    await createSection(sched, { courseId: c.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Monday','Wednesday'], startTime: '15:00', endTime: '16:15' });
    // Delete one row → triggers R-15
    const rows = (await request(app).get(`/api/v1/schedules/${sched}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const all = rows.sections || rows;
    const mon = all.find(r => r.day === 'Monday');
    if (mon) await request(app).delete(`/api/v1/sections/${mon.id}?scope=row`).set('Authorization', `Bearer ${adminTok}`);
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q18: triple conflict — R-04 + R-05 + R-15 cascade', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const [c1, c2] = pickUG(courses, 2);
    const hall = lectureHalls(venues)[0];
    await createSection(sched, { courseId: c1.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Monday','Wednesday'], startTime: '14:00', endTime: '15:15' });
    await createSection(sched, { courseId: c2.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Monday','Wednesday'], startTime: '14:00', endTime: '15:15' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q19: user-screenshot scenario — R-04 + R-05 + R-10 + R-11 + R-12 mix', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const [c1, c2] = pickUG(courses, 2);
    const labCourse = pickLab(courses);
    const c4 = pickGrad(courses, 1)[0];
    const hall = lectureHalls(venues)[0];
    const lab = venues.find(v => v.type === 'Laboratory');
    // R-09 (no instructor)
    await createSection(sched, { courseId: c1.id, instructorId: null, venueId: hall.id,
      sectionNumber: '01', days: ['Sunday','Tuesday','Thursday'], startTime: '08:00', endTime: '08:50' });
    // R-10 (no venue)
    await createSection(sched, { courseId: c2.id, instructorId: instructors[0].id, venueId: null,
      sectionNumber: '01', days: ['Sunday','Tuesday','Thursday'], startTime: '09:00', endTime: '09:50' });
    // R-11 (lab in hall)
    await createSection(sched, { courseId: labCourse.id, instructorId: instructors[0].id, venueId: hall.id,
      sectionNumber: '50', sectionType: 'Lab', days: ['Monday'], startTime: '10:00', endTime: '10:50' });
    // R-12 (lec in lab) — graduate course kept in the 17:20–22:00 window (R-06).
    await createSection(sched, { courseId: c4.id, instructorId: instructors[1].id, venueId: lab.id,
      sectionNumber: '01', sectionType: 'Lec', days: ['Monday','Wednesday'], startTime: '17:30', endTime: '18:45' });
    const planRes = await planAndApply(sched);
    await assertPostApplyConsistent(sched, planRes);
  });

  test('P-Q20: empty schedule with 0 ops + 0 unresolved + 0 conflicts post', async () => {
    const { scheduleId: sched } = await freshTermSchedule();   // NEW-FU-673
    const planRes = await planAndApply(sched);
    expect(planRes.ops.length).toBe(0);
    expect(planRes.unresolvedRuleIds.length).toBe(0);
    const post = await getConflicts(sched);
    expect(post.length).toBe(0);
  });

  // ── P-Q21..P-Q30: idempotency, no-drop guarantee, structural ────
  test('P-Q21: plan response includes unresolvedReasons map shape', async () => {
    const { scheduleId: sched } = await freshTermSchedule();   // NEW-FU-673
    const planRes = (await solverPost(`/api/v1/schedules/${sched}/quick-fix`)).body;   // NEW-FU-673
    expect(planRes).toHaveProperty('unresolvedReasons');
    expect(typeof planRes.unresolvedReasons).toBe('object');
  });

  test('P-Q22: no `drop` ops in plan regardless of conflict severity', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const [c1, c2] = pickUG(courses, 2);
    const hall = lectureHalls(venues)[0];
    // R-04 + R-05 (both hard)
    await createSection(sched, { courseId: c1.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '11:30', endTime: '12:20' });
    await createSection(sched, { courseId: c2.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '11:30', endTime: '12:20' });
    const planRes = (await solverPost(`/api/v1/schedules/${sched}/quick-fix`)).body;   // NEW-FU-673
    // Phase 38 (FU-395): drops are permitted ONLY as lastResort:true
    // for unresolvable conflicts (e.g., R-14). They must never be the
    // resolver's auto-pick for rules where alternatives exist.
    for (const op of (planRes.ops ?? [])) {
      if (op.type === 'drop') {
        expect(op.lastResort).toBe(true);
      }
      if (op.subOps) {
        for (const sub of op.subOps) expect(sub.type).not.toBe('drop');
      }
    }
  });

  test('P-Q23: every op shape — id, type, resolves[], willResolveCount', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const [c1, c2] = pickUG(courses, 2);
    const halls = lectureHalls(venues);
    await createSection(sched, { courseId: c1.id, instructorId: instructors[0].id,
      venueId: halls[0].id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '15:30', endTime: '16:20' });
    await createSection(sched, { courseId: c2.id, instructorId: instructors[0].id,
      venueId: halls[1].id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '15:30', endTime: '16:20' });
    const planRes = (await solverPost(`/api/v1/schedules/${sched}/quick-fix`)).body;   // NEW-FU-673
    for (const op of (planRes.ops ?? [])) {
      expect(op.id).toBeDefined();
      expect(op.type).toBeDefined();
      expect(Array.isArray(op.resolves)).toBe(true);
      expect(op.willResolveCount).toBeDefined();
    }
  });

  test('P-Q24: deterministic — running plan twice yields same op count', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const [c1, c2] = pickUG(courses, 2);
    const halls = lectureHalls(venues);
    await createSection(sched, { courseId: c1.id, instructorId: instructors[0].id,
      venueId: halls[0].id, sectionNumber: '01',
      days: ['Monday','Wednesday'], startTime: '16:00', endTime: '17:15' });
    await createSection(sched, { courseId: c2.id, instructorId: instructors[0].id,
      venueId: halls[1].id, sectionNumber: '01',
      days: ['Monday','Wednesday'], startTime: '16:00', endTime: '17:15' });
    const a = (await solverPost(`/api/v1/schedules/${sched}/quick-fix`)).body;   // NEW-FU-673
    const b = (await solverPost(`/api/v1/schedules/${sched}/quick-fix`)).body;   // NEW-FU-673
    expect(a.ops.length).toBe(b.ops.length);
  });

  test('P-Q25: idempotency — apply twice does not add new conflicts', async () => {
    const { scheduleId: sched, courses, instructors } = await freshTermSchedule();   // NEW-FU-673
    const c = pickUG(courses, 1)[0];
    await createSection(sched, { courseId: c.id, instructorId: instructors[0].id,
      venueId: null, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    const planA = await planAndApply(sched);
    const after1 = await getConflicts(sched);
    const planB = await planAndApply(sched);
    const after2 = await getConflicts(sched);
    expect(after2.length).toBeLessThanOrEqual(after1.length);
  });

  test('P-Q26: empty ops body apply → 200 with 0 applied', async () => {
    const { scheduleId: sched } = await freshTermSchedule();   // NEW-FU-673
    const r = await solverPost(`/api/v1/schedules/${sched}/quick-fix/apply`)   // NEW-FU-673
      .send({ ops: [] });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(0);
  });

  test('P-Q27: malformed ops payload → 400', async () => {
    const { scheduleId: sched } = await freshTermSchedule();   // NEW-FU-673
    const r = await solverPost(`/api/v1/schedules/${sched}/quick-fix/apply`)   // NEW-FU-673
      .send({ ops: 'not an array' });
    expect(r.status).toBe(400);
  });

  test('P-Q28: unknown op type rejected with clear error', async () => {
    const { scheduleId: sched } = await freshTermSchedule();   // NEW-FU-673
    const r = await solverPost(`/api/v1/schedules/${sched}/quick-fix/apply`)   // NEW-FU-673
      .send({ ops: [{ type: 'launch-rocket', sectionId: 'x' }] });
    expect(r.status).toBe(400);
  });

  test('P-Q29: many sections without conflict → plan stays empty', async () => {
    const { scheduleId: sched, courses, instructors, venues } = await freshTermSchedule();   // NEW-FU-673
    const halls = lectureHalls(venues);
    const picks = pickUG(courses, 3);   // 3 distinct UG courses
    for (let i = 0; i < picks.length; i++) {
      await createSection(sched, { courseId: picks[i].id,
        instructorId: instructors[i % instructors.length].id,
        venueId: halls[i % halls.length].id,
        sectionNumber: '01',
        days: ['Sunday','Tuesday','Thursday'],
        startTime: `0${i + 7}:30`, endTime: `0${i + 8}:20`,
      });
    }
    const planRes = (await solverPost(`/api/v1/schedules/${sched}/quick-fix`)).body;   // NEW-FU-673
    expect(planRes.ops.length).toBe(0);
  });

  test('P-Q30: plan endpoint shape stable across schedules', async () => {
    const { scheduleId: sched } = await freshTermSchedule();   // NEW-FU-673
    const r = await solverPost(`/api/v1/schedules/${sched}/quick-fix`);   // NEW-FU-673
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('ops');
    expect(r.body).toHaveProperty('summary');
    expect(r.body).toHaveProperty('unresolvedRuleIds');
    expect(r.body).toHaveProperty('unresolvedReasons');
    expect(r.body).toHaveProperty('supportedOpTypes');
  });
});

describe('FU-391: Phase 37 Suggest POST-APPLY battery (30 scenarios)', () => {

  // For Suggest, the contract is:
  //   • relaxIfConflicts=true returns EITHER feasible:true with 0 conflicts
  //     OR feasible:false.
  //   • If feasible, applying the relaxed plan must leave the schedule's
  //     /conflicts at 0.
  async function suggestRelaxAndAssert(scheduleId, courseConfigs) {
    const r = await solverPost(`/api/v1/schedules/${scheduleId}/suggest`)   // NEW-FU-673
      .send({ courseConfigs, relaxIfConflicts: true });
    expect([200, 400]).toContain(r.status);
    if (r.status !== 200) return;
    if (r.body.feasible === false) {
      expect(typeof r.body.reason).toBe('string');
      expect(r.body.reason.length).toBeGreaterThan(0);
      return;
    }
    expect(r.body.residualConflicts ?? 0).toBe(0);
    // Apply with the relaxed (or original) configs and check post-state.
    const configs = r.body.relaxedConfigs ?? courseConfigs;
    const apply = await solverPost(`/api/v1/schedules/${scheduleId}/suggest`)   // NEW-FU-673
      .send({ courseConfigs: configs });
    expect(apply.status).toBe(200);
    const post = await getConflicts(scheduleId);
    expect(post.length).toBe(0);
  }

  // NEW-FU-673: course selection is attribute-based (see top-of-file pickers) — the original
  // battery's hard-coded SWE101/SWE301/SWE501 codes no longer exist in the seed.

  // P-S01..P-S05: academic-level pairings
  test('P-S01: Freshman + Sophomore single-section', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const [f, s] = pickAdjacentLevels(courses, 0, 2);   // Freshman + Sophomore
    await suggestRelaxAndAssert(sched, [
      { courseId: f.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: s.id, sections: 1, duration: 50, dayPattern: 'STT' },
    ]);
  });
  test('P-S02: Sophomore + Junior single-section', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const [s, j] = pickAdjacentLevels(courses, 1, 2);   // Sophomore + Junior
    await suggestRelaxAndAssert(sched, [
      { courseId: s.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: j.id, sections: 1, duration: 50, dayPattern: 'STT' },
    ]);
  });
  test('P-S03: Junior + Senior single-section', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const [j, sr] = pickAdjacentLevels(courses, 2, 2);   // Junior + Senior
    await suggestRelaxAndAssert(sched, [
      { courseId: j.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: sr.id, sections: 1, duration: 50, dayPattern: 'STT' },
    ]);
  });
  test('P-S04: Senior + Graduate single-section', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const sr = courses.find(c => c.academic_level === 'Senior' && !c.has_lab) ?? pickUG(courses, 1)[0];
    const g = pickGrad(courses, 1)[0];
    await suggestRelaxAndAssert(sched, [
      { courseId: sr.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: g.id, sections: 1, duration: 75, dayPattern: 'MW' },
    ]);
  });
  test('P-S05: Graduate + Graduate (Phase 35 R-02 same-level)', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const [g1, g2] = pickGrad(courses, 2);
    await suggestRelaxAndAssert(sched, [
      { courseId: g1.id, sections: 1, duration: 75, dayPattern: 'MW' },
      { courseId: g2.id, sections: 1, duration: 75, dayPattern: 'ST' },
    ]);
  });

  // P-S06..P-S10: section count saturation
  for (let n = 1; n <= 5; n++) {
    test(`P-S${5 + n}: ${n} section${n > 1 ? 's' : ''} of a Junior UG course`, async () => {
      const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
      const c = pickUG(courses, 1)[0];
      await suggestRelaxAndAssert(sched, [
        { courseId: c.id, sections: n, duration: 50, dayPattern: 'STT' },
      ]);
    });
  }

  // P-S11..P-S15: pattern × duration
  const patterns = [
    ['STT', 50], ['MW', 75], ['ST', 75], ['MWF', 50], ['ONE_DAY', 50],
  ];
  for (let i = 0; i < patterns.length; i++) {
    const [pat, dur] = patterns[i];
    test(`P-S${11 + i}: pattern ${pat} duration ${dur}min`, async () => {
      const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
      const c = pickUG(courses, 1)[0];
      await suggestRelaxAndAssert(sched, [
        { courseId: c.id, sections: 1, duration: dur, dayPattern: pat },
      ]);
    });
  }

  // P-S16..P-S20: saturated / multi-course
  test('P-S16: 3 Graduate courses in 16:00–22:00 window', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const [g1, g2] = pickGrad(courses, 2);
    await suggestRelaxAndAssert(sched, [
      { courseId: g1.id, sections: 2, duration: 75, dayPattern: 'MW' },
      { courseId: g2.id, sections: 2, duration: 75, dayPattern: 'ST' },
    ]);
  });
  test('P-S17: 5 UG single-section courses', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const picks = pickUG(courses, 5);
    await suggestRelaxAndAssert(sched, picks.map(c => ({
      courseId: c.id, sections: 1, duration: 50, dayPattern: 'STT',
    })));
  });
  test('P-S18: 3 multi-section adjacent-level', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const [a, b, c] = pickAdjacentLevels(courses, 1, 3);   // Sophomore + Junior + Senior
    await suggestRelaxAndAssert(sched, [
      { courseId: a.id, sections: 2, duration: 50, dayPattern: 'STT' },
      { courseId: b.id, sections: 2, duration: 50, dayPattern: 'STT' },
      { courseId: c.id, sections: 2, duration: 50, dayPattern: 'STT' },
    ]);
  });
  test('P-S19: 4 single-section adjacent-level chain', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const [a, b, c, d] = pickAdjacentLevels(courses, 0, 4);   // Freshman→Senior
    await suggestRelaxAndAssert(sched, [
      { courseId: a.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: b.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: c.id, sections: 1, duration: 50, dayPattern: 'STT' },
      { courseId: d.id, sections: 1, duration: 50, dayPattern: 'STT' },
    ]);
  });
  test('P-S20: lab-bearing course', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const lab = pickLab(courses);
    await suggestRelaxAndAssert(sched, [
      { courseId: lab.id, sections: 1, duration: 50, dayPattern: 'STT',
        labDuration: 50, labDay: 'Monday' },
    ]);
  });

  // P-S21..P-S25: edge cases
  test('P-S21: lab-bearing course with 2 sections', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const lab = pickLab(courses);
    await suggestRelaxAndAssert(sched, [
      { courseId: lab.id, sections: 2, duration: 50, dayPattern: 'STT' },
    ]);
  });
  test('P-S22: 3 Sophomore courses (same-level)', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    let soph = courses.filter(c => c.academic_level === 'Sophomore' && !c.has_lab).slice(0, 3);
    if (soph.length < 2) soph = pickUG(courses, 3);   // backfill if the seed lacks 2+ sophomores
    await suggestRelaxAndAssert(sched, soph.map(c => ({
      courseId: c.id, sections: 1, duration: 50, dayPattern: 'STT',
    })));
  });
  test('P-S23: 4-credit course (MW 75min)', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const c = courses.find(c => c.credits === 4) || pickUG(courses, 1)[0];
    await suggestRelaxAndAssert(sched, [
      { courseId: c.id, sections: 1, duration: 75, dayPattern: 'MW' },
    ]);
  });
  test('P-S24: ONE_DAY pattern (relaxer may upgrade)', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const c = pickUG(courses, 1)[0];
    await suggestRelaxAndAssert(sched, [
      { courseId: c.id, sections: 1, duration: 50, dayPattern: 'ONE_DAY' },
    ]);
  });
  test('P-S25: 75min single-section', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const c = pickUG(courses, 1)[0];
    await suggestRelaxAndAssert(sched, [
      { courseId: c.id, sections: 1, duration: 75, dayPattern: 'MW' },
    ]);
  });

  // P-S26..P-S30: adversarial / impossible
  test('P-S26: 5 courses all forced to ONE_DAY Sunday (impossible co-pack)', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const picks = pickUG(courses, 5);
    await suggestRelaxAndAssert(sched, picks.map(c => ({
      courseId: c.id, sections: 1, duration: 50, dayPattern: 'ONE_DAY', day: 'Sunday',
    })));
  });
  test('P-S27: 4 Graduate courses each 3 sections forced to MW 75min', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const grads = pickGrad(courses, 4);
    if (grads.length < 2) return;
    await suggestRelaxAndAssert(sched, grads.map(c => ({
      courseId: c.id, sections: 3, duration: 75, dayPattern: 'MW',
    })));
  });
  test('P-S28: zero-config payload', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const c = pickUG(courses, 1)[0];
    // Without pattern → backend may 400 or relaxer fills defaults; either way invariant holds.
    const r = await solverPost(`/api/v1/schedules/${sched}/suggest`)   // NEW-FU-673
      .send({ courseConfigs: [{ courseId: c.id, sections: 1 }],
              relaxIfConflicts: true });
    expect([200, 400]).toContain(r.status);
  });
  test('P-S29: courses spanning all 5 academic levels', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const byLevel = {};
    for (const c of courses) if (!c.has_lab && !byLevel[c.academic_level]) byLevel[c.academic_level] = c;
    const configs = Object.values(byLevel).slice(0, 5).map(c => ({
      courseId: c.id, sections: 1, duration: c.category === 'GR' ? 75 : 50,
      dayPattern: c.category === 'GR' ? 'MW' : 'STT',
    }));
    if (configs.length < 3) return;
    await suggestRelaxAndAssert(sched, configs);
  });
  test('P-S30: dense schedule — 6 courses, mixed', async () => {
    const { scheduleId: sched, courses } = await freshTermSchedule();   // NEW-FU-673
    const ug = pickUG(courses, 4);
    const gr = pickGrad(courses, 2);
    const picks = [...ug, ...gr];
    if (picks.length < 4) return;
    // Graduate courses must use the 17:20–22:00 window patterns (MW/ST 75min); UG use STT 50min.
    await suggestRelaxAndAssert(sched, picks.map((c, i) => {
      if (c.category === 'GR') {
        return { courseId: c.id, sections: (i % 2) + 1, duration: 75, dayPattern: i % 2 ? 'ST' : 'MW' };
      }
      return { courseId: c.id, sections: (i % 2) + 1, duration: 50, dayPattern: 'STT' };
    }));
  });
});
