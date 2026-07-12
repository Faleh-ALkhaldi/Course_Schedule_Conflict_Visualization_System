// NEW-FU-399 (Phase 39): targeted red-team for the GENERALIZED
// lastResort drop pattern. Phase 38 was R-14-only; Phase 39 extends
// the principle to every rule + to Suggest's infeasibility path.
//
// Contract (re-confirmed):
//   • Every unresolved conflict in Quick Fix produces a `lastResort:
//     true` drop op the user can opt into.
//   • `summary.remaining*` reflects what happens if NO drops are
//     applied — the drops are bonus, not auto-counted.
//   • The drop op's `resolves[ruleId]` matches the conflict it
//     would clear.
//   • Suggest's `feasible:false` response includes a
//     `lastResortPlan` whenever Pass E found a drop-able subset
//     that's zero-conflict.

const request = require('supertest');
const app     = require('../../src/app');
const { query } = require('../../src/config/db');   // NEW-FU-673: term-valid resource selection

const ADMIN = { username: 'admin1', password: 'password123' };
const TERM_CODES = ['311','312','313','321','322','323','331','332','341','342'];

let adminTok;
const usedCodes = new Set();
let codeIdx = 0;

beforeAll(async () => {
  const r = await request(app).post('/api/v1/auth/login').send(ADMIN);
  expect(r.status).toBe(200);
  adminTok = r.body.token;
});

afterAll(async () => {
  for (const code of usedCodes) {
    await request(app)
      .delete(`/api/v1/terms/${code}`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`)
      .catch(() => {});
  }
});

function nextCode() {
  if (codeIdx >= TERM_CODES.length) codeIdx = 0;
  const code = TERM_CODES[codeIdx++];
  usedCodes.add(code);
  return code;
}

async function freshTermSchedule() {
  const code = nextCode();
  await request(app)
    .delete(`/api/v1/terms/${code}`)
    .query({ activeCode: '251' })
    .set('Authorization', `Bearer ${adminTok}`)
    .catch(() => {});
  await request(app)
    .post('/api/v1/terms')
    .set('Authorization', `Bearer ${adminTok}`)
    .send({ code });
  const sr = await request(app)
    .get('/api/v1/departments/SWE-DEPT/schedules')
    .set('Authorization', `Bearer ${adminTok}`);
  const sched = sr.body.find(s => s.semester === code);
  // NEW-FU-673: SQL-level wipe of auto-cloned sections (one shot; FU-609-safe). Owned resources survive.
  await query(`DELETE FROM sections WHERE schedule_id = $1`, [sched.id]);
  // NEW-FU-673: return the code too so getRefs can scope to THIS term (see getRefs).
  return { scheduleId: sched.id, code };
}

// NEW-FU-673: resources VALID FOR THIS TERM — owned by `code` OR template (owner IS NULL).
// The global GET lists return templates + EVERY term's owner-scoped copies (FU-645), so
// picking `instructors[0]` / `courses.find(...)` from them grabs another term's resource →
// section-create 409 "belongs to term X". TERM_CODES here are Fall/Spring (xx1/xx2), which copy
// a rich seeded base, so each term OWNS a usable pool (the resolver only draws candidates from
// the owner-scoped pool). All Suggest-path tests build their own configs from these courses.
async function getRefs(code) {
  const courses = (await query(
    `SELECT id, credits, has_lab, category, course_code FROM courses
      WHERE owner_semester = $1 OR owner_semester IS NULL`, [code])).rows
    .map(c => ({ ...c, credits: Number(c.credits), has_lab: c.has_lab }));
  const instructors = (await query(
    `SELECT id, name FROM instructors
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows;
  const venues = (await query(
    `SELECT id, type, name FROM venues
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows;
  return { courses, instructors, venues };
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
      days:          opts.days ?? ['Sunday','Tuesday','Thursday'],
      startTime:     opts.startTime ?? '13:30',
      endTime:       opts.endTime ?? '14:20',
    });
}

async function plan(scheduleId) {
  const r = await request(app)
    .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
    .set('Authorization', `Bearer ${adminTok}`);
  expect(r.status).toBe(200);
  return r.body;
}

describe('FU-399: Phase 39 generalized lastResort drop', () => {

  // ── G-Q01..G-Q05: every unresolved conflict ships with a
  // lastResort drop the user can opt into ─────────────────────────
  test('G-Q01: R-14 (orphan Lab — a Lab with no Lecture) is RESOLVED by untag-has-lab (NEW-FU-681)', async () => {
    const { scheduleId: sched, code } = await freshTermSchedule();   // NEW-FU-673
    const { courses, instructors, venues } = await getRefs(code);
    // NEW-FU-681: R-14 now fires for an ORPHAN LAB (a Lab with no Lecture); a lecture-only has_lab
    // course no longer flags (its lab is managed separately — e.g. a scoped instructor/venue import).
    // A 3-credit orphan-lab R-14 is RESOLVED non-destructively (untag-has-lab), so it no longer needs
    // a lastResort drop — confirm the resolver addresses it with a real op (not left dangling).
    const labCourse = courses.find(c => c.has_lab);
    const hall = venues.find(v => v.type === 'LectureHall');
    const hassan = instructors.find(i => i.name === 'Dr. Hassan') ?? instructors[1];
    await createSection(sched, { courseId: labCourse.id, instructorId: hassan.id,
      venueId: (venues.find(v => v.type === 'Laboratory') || hall).id, sectionNumber: '50', sectionType: 'Lab',
      days: ['Monday'], startTime: '14:30', endTime: '15:20' });
    const planRes = await plan(sched);
    const r14ops = (planRes.ops ?? []).filter(o => (o.resolves || []).includes('R-14'));
    expect(r14ops.length).toBeGreaterThanOrEqual(1);
    expect(r14ops.every(o => Array.isArray(o.resolves))).toBe(true);
  });

  test('G-Q02: R-10 with no free venue gets a lastResort drop', async () => {
    const { scheduleId: sched, code } = await freshTermSchedule();   // NEW-FU-673
    const { courses, instructors, venues } = await getRefs(code);
    const c = courses.find(c => c.course_code === 'SWE 316');   // real code ("SWE301" doesn't exist)
    // NEW-FU-673: FU-475 made a missing venue a HARD create-time block; create a valid section
    // then NULL the venue at the DB level to seed the R-10 state.
    await createSection(sched, { courseId: c.id, instructorId: instructors[0].id,
      venueId: venues.find(v => v.type === 'LectureHall').id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    await query(`UPDATE sections SET venue_id = NULL WHERE schedule_id = $1`, [sched]);
    const planRes = await plan(sched);
    // R-10 should have either resolved (free venue available) OR be
    // accompanied by a lastResort drop op.
    const r10Unresolved = (planRes.unresolvedRuleIds ?? []).includes('R-10');
    if (r10Unresolved) {
      const dropOps = (planRes.ops ?? []).filter(o => o.type === 'drop');
      expect(dropOps.length).toBeGreaterThanOrEqual(1);
      expect(dropOps[0].lastResort).toBe(true);
    }
  });

  test('G-Q03: dropSuffix in unresolved reasons mentions destructive drop option', async () => {
    const { scheduleId: sched, code } = await freshTermSchedule();   // NEW-FU-673
    const { courses, instructors, venues } = await getRefs(code);
    const labCourse = courses.find(c => c.has_lab);
    const hall = venues.find(v => v.type === 'LectureHall');
    await createSection(sched, { courseId: labCourse.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '50', sectionType: 'Lab',
      days: ['Monday'], startTime: '10:00', endTime: '10:50' });
    const planRes = await plan(sched);
    // R-11 will fire (lab in non-lab venue). Some unresolved rules
    // should have reasons mentioning the drop option.
    let anyMentionsDrop = false;
    for (const rid of (planRes.unresolvedRuleIds ?? [])) {
      const reason = planRes.unresolvedReasons?.[rid] ?? '';
      // R-14 mentions "drop op below" explicitly; other rules now end
      // with "Last resort: check the destructive drop op below..."
      if (/drop op|last resort/i.test(reason)) anyMentionsDrop = true;
    }
    // Only assert if there ARE unresolved rules — happy path may have
    // zero unresolved.
    if ((planRes.unresolvedRuleIds ?? []).length > 0) {
      expect(anyMentionsDrop).toBe(true);
    }
  });

  test('G-Q04: lastResort drops never appear without lastResort:true flag', async () => {
    const { scheduleId: sched, code } = await freshTermSchedule();   // NEW-FU-673
    const { courses, instructors, venues } = await getRefs(code);
    const c1 = courses.find(c => c.course_code === 'SWE 316');   // real codes
    const c2 = courses.find(c => c.course_code === 'SWE 326');
    const hall = venues.find(v => v.type === 'LectureHall');
    await createSection(sched, { courseId: c1.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    await createSection(sched, { courseId: c2.id, instructorId: instructors[0].id,
      venueId: hall.id, sectionNumber: '01',
      days: ['Sunday','Tuesday','Thursday'], startTime: '13:30', endTime: '14:20' });
    const planRes = await plan(sched);
    for (const op of (planRes.ops ?? [])) {
      if (op.type === 'drop') expect(op.lastResort).toBe(true);
    }
  });

  test('G-Q05: applying the orphan-lab R-14 resolution clears the conflict (NEW-FU-681)', async () => {
    const { scheduleId: sched, code } = await freshTermSchedule();   // NEW-FU-673
    const { courses, instructors, venues } = await getRefs(code);
    const labCourse = courses.find(c => c.has_lab);
    const hall = venues.find(v => v.type === 'LectureHall');
    const hassan = instructors.find(i => i.name === 'Dr. Hassan') ?? instructors[1];
    // NEW-FU-681: an orphan-lab R-14 (Lab with no Lecture) is resolved by untag-has-lab; applying
    // the resolving op clears the R-14 conflict.
    await createSection(sched, { courseId: labCourse.id, instructorId: hassan.id,
      venueId: (venues.find(v => v.type === 'Laboratory') || hall).id, sectionNumber: '50', sectionType: 'Lab',
      days: ['Monday'], startTime: '14:30', endTime: '15:20' });
    const planRes = await plan(sched);
    const op = (planRes.ops ?? []).find(o => (o.resolves || []).includes('R-14'));
    expect(op).toBeTruthy();
    const apply = await request(app)
      .post(`/api/v1/schedules/${sched}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: [op] });
    expect(apply.status).toBe(200);
    const post = (await request(app)
      .get(`/api/v1/schedules/${sched}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body.conflicts ?? [];
    expect(post.filter(c => c.ruleId === 'R-14').length).toBe(0);
  });

  // ── G-S01..G-S03: Suggest infeasibility now produces a
  // lastResortPlan when Pass E finds a drop-able subset ────────────
  test('G-S01: response shape includes lastResortPlan field when feasible:false', async () => {
    const { scheduleId: sched, code } = await freshTermSchedule();   // NEW-FU-673
    const { courses } = await getRefs(code);
    // Force infeasibility: 5 courses all forced to ONE_DAY Sunday at
    // the same time slot. Pass A-D can't resolve; Pass E should drop
    // some to make the remainder fit.
    // NEW-FU-673: real catalog codes (the old "SWE101"/"SWE201"… had no spaces and matched
    // nothing, so configs was empty and suggest never exercised the infeasible path).
    const codes = ['SWE 101', 'SWE 216', 'SWE 316', 'SWE 326', 'SWE 402'];
    const configs = codes
      .map(code => courses.find(c => c.course_code === code))
      .filter(Boolean)
      .map(c => ({
        courseId: c.id, sections: 1, duration: 50,
        dayPattern: 'ONE_DAY', day: 'Sunday',
      }));
    const r = await request(app)
      .post(`/api/v1/schedules/${sched}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: configs, relaxIfConflicts: true });
    expect(r.status).toBe(200);
    // Either fully feasible (Pass A succeeded) or infeasible with a
    // lastResortPlan computed by Pass E.
    if (r.body.feasible === false) {
      // The lastResortPlan field MUST exist on every infeasible response
      // — it may be null if Pass E couldn't find a drop-able subset
      // either, but the field shape should be present.
      expect(r.body).toHaveProperty('lastResortPlan');
    }
  });

  test('G-S02: lastResortPlan (when populated) has zero residual conflicts on its own preview', async () => {
    const { scheduleId: sched, code } = await freshTermSchedule();   // NEW-FU-673
    const { courses } = await getRefs(code);
    // Strongly infeasible config: 5 single-section courses all forced
    // to identical ONE_DAY 50min Sunday slot. Pass E should find that
    // dropping enough courses to leave one yields a feasible plan.
    const codes = ['SWE 101', 'SWE 216', 'SWE 316', 'SWE 326', 'SWE 402'];   // NEW-FU-673: real codes
    const configs = codes
      .map(code => courses.find(c => c.course_code === code))
      .filter(Boolean)
      .map(c => ({
        courseId: c.id, sections: 1, duration: 50,
        dayPattern: 'ONE_DAY', day: 'Sunday',
      }));
    const r = await request(app)
      .post(`/api/v1/schedules/${sched}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: configs, relaxIfConflicts: true });
    expect(r.status).toBe(200);
    if (r.body.feasible === false && r.body.lastResortPlan) {
      const lrp = r.body.lastResortPlan;
      expect(lrp.residualConflicts).toBe(0);
      expect(Array.isArray(lrp.droppedCourseIds)).toBe(true);
      expect(lrp.droppedCourseIds.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(lrp.keptConfigs)).toBe(true);
    }
  });

  test('G-S03: applying lastResortPlan.keptConfigs yields 0 conflicts post-persist', async () => {
    const { scheduleId: sched, code } = await freshTermSchedule();   // NEW-FU-673
    const { courses } = await getRefs(code);
    const codes = ['SWE 101', 'SWE 216', 'SWE 316', 'SWE 326', 'SWE 402'];   // NEW-FU-673: real codes
    const configs = codes
      .map(code => courses.find(c => c.course_code === code))
      .filter(Boolean)
      .map(c => ({
        courseId: c.id, sections: 1, duration: 50,
        dayPattern: 'ONE_DAY', day: 'Sunday',
      }));
    const r = await request(app)
      .post(`/api/v1/schedules/${sched}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: configs, relaxIfConflicts: true });
    if (r.body.feasible === false && r.body.lastResortPlan) {
      // Apply the lastResort plan's kept-configs without preview flag.
      const apply = await request(app)
        .post(`/api/v1/schedules/${sched}/suggest`)
        .set('Authorization', `Bearer ${adminTok}`)
        .send({ courseConfigs: r.body.lastResortPlan.keptConfigs });
      expect(apply.status).toBe(200);
      const post = (await request(app)
        .get(`/api/v1/schedules/${sched}/conflicts`)
        .set('Authorization', `Bearer ${adminTok}`)).body.conflicts ?? [];
      expect(post.length).toBe(0);
    }
  });
});
