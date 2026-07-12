// NEW-FU-512 (Batch 5 Issue 2): resolver completeness — Quick Fix must always
// offer a path to ZERO conflicts and never leave the user stuck with
// "no automatic fix". Owner directive: "must always drive the schedule to 0 hard
// + 0 soft … only as a last resort, drop/delete — until no conflicts remain."
//
// Contract locked here:
//   • A MOVABLE soft conflict is resolved by a non-destructive op (move/reassign)
//     — minimal change, NO drop. (We never reach for the axe when a nudge works.)
//   • If a soft conflict can be resolved after other safe fixes unlock room, it
//     still prefers that non-destructive path. If no such path exists, the plan
//     ships an opt-in lastResort DROP (previously it produced ZERO ops → the
//     reported "stuck" state). summary.remaining* still reflects the no-drop
//     world.
//   • Every initial conflict is covered by at least one op that resolves it —
//     i.e. the plan always describes a complete path to zero.

const request = require('supertest');
const app = require('../../src/app');
const { query } = require('../../src/config/db');   // NEW-FU-673: term-valid resource selection
const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);

let tok;
beforeAll(async () => {
  tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token;
});

async function freshTerm(code) {
  await A(request(app).post(`${B}/terms`), tok).send({ code });
  const sched = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === code);
  const ex = (await A(request(app).get(`${B}/schedules/${sched.id}/sections`), tok)).body;
  for (const s of (ex.sections || ex)) {
    await A(request(app).delete(`${B}/sections/${s.id}?scope=row`), tok).catch(() => {});
  }
  return sched.id;
}
// NEW-FU-673: resources OWNED BY THIS TERM (owner_semester = code). Post-FU-645 the global GET
// /courses|instructors|venues lists also surface every OTHER term's private copies. Picking from
// them grabs a foreign-term resource → section-create 409, which `mk` swallows (it doesn't assert
// 201) → the venue-saturation fillers silently fail → V keeps free slots → the greedy can move the
// "saturated" section → remainingSoft drops to 0 and the lastResort-drop assertion fails. The
// resolver's reassign pool is also owner_semester=term ONLY, so owned-only both lets every section
// create AND matches the pool the resolver draws from. A default-copy term owns a full private
// pool (Junior+Senior UG courses, 20+ halls, 20+ instructors). The GET endpoints don't expose
// owner_semester, so we query directly.
async function refs(code) {
  const courses = (await query(
    `SELECT id, course_code, credits, has_lab, category, academic_level,
            is_capstone, is_external, is_thesis, is_research
       FROM courses
      WHERE owner_semester = $1`, [code])).rows.map(c => ({ ...c, credits: Number(c.credits) }));
  const venues = (await query(
    `SELECT id, type FROM venues
      WHERE owner_semester = $1 AND is_dummy = false AND type = 'LectureHall' ORDER BY name`, [code])).rows;
  const instr = (await query(
    `SELECT id, name FROM instructors
      WHERE owner_semester = $1 AND is_dummy = false ORDER BY name`, [code])).rows;
  return { courses, venues, instr };
}
const mk = (sid, cId, iId, vId, st, sn = '01') =>
  A(request(app).post(`${B}/schedules/${sid}/sections`), tok).send({
    courseId: cId, instructorId: iId, venueId: vId, sectionNumber: sn, sectionType: 'Lec',
    days: ['Sunday', 'Tuesday', 'Thursday'], startTime: st, endTime: st.replace(':00', ':50'),
  });
const plan = (sid) => A(request(app).post(`${B}/schedules/${sid}/quick-fix`), tok).then(r => r.body);
const lectureFixtureCourse = (c) =>
  c.credits === 3
  && !c.has_lab
  && c.category === 'UG'
  && !c.is_capstone
  && !c.is_external
  && !c.is_thesis
  && !c.is_research;

describe('Batch 5 Issue 2 — Quick Fix resolver completeness', () => {
  test('movable soft R-02 is resolved by a non-destructive op (no drop)', async () => {
    const sid = await freshTerm('312');
    const { courses, venues, instr } = await refs('312');   // NEW-FU-673: term-owned
    const jun = courses.find(c => c.academic_level === 'Junior' && lectureFixtureCourse(c));
    const sen = courses.find(c => c.academic_level === 'Senior' && lectureFixtureCourse(c));
    await mk(sid, jun.id, instr[0].id, venues[0].id, '10:00');
    await mk(sid, sen.id, instr[1].id, venues[1].id, '10:00');
    const r02 = (await plan(sid)).ops.filter(o => (o.resolves || []).includes('R-02'));
    expect(r02.length).toBeGreaterThanOrEqual(1);
    expect(r02.some(o => o.type !== 'drop')).toBe(true);          // a nudge, not the axe
    await A(request(app).delete(`${B}/terms/312`).query({ activeCode: '251' }), tok).catch(() => {});
  });

  test('contended soft R-02 prefers a non-destructive path or falls back to lastResort drop', async () => {
    const sid = await freshTerm('322');
    // NEW-FU-673: term-owned resources only (see refs()) — the global GET re-fetch grabbed
    // foreign-term courses/instructors whose section-creates 409'd silently, leaving V with free
    // slots so the greedy could move the section and remainingSoft fell to 0.
    const { courses, venues, instr } = await refs('322');
    const ug3 = courses.filter(lectureFixtureCourse);
    const V = venues[0].id;
    const jun = ug3.find(c => c.academic_level === 'Junior');
    const sen = ug3.find(c => c.academic_level === 'Senior' && c.id !== jun.id);
    expect(jun && sen).toBeTruthy();
    await mk(sid, jun.id, instr[0].id, V, '10:00');               // A
    await mk(sid, sen.id, instr[1].id, venues[1].id, '10:00');    // B — overlaps A (soft R-02)
    // Fill venue V at every other start slot so the fixture remains crowded.
    // If the resolver can unlock a safe non-destructive path through another
    // fix first, that is the desired outcome; otherwise it must still offer a
    // lastResort drop so the user is not stuck.
    const slots = ['07:00', '08:00', '09:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];
    let fi = 2;
    for (const st of slots) {
      const c = ug3[fi++ % ug3.length];
      const r = await mk(sid, c.id, instr[fi % instr.length].id, V, st, '0' + ((fi % 8) + 2));
      expect(r.status).toBe(201);
    }
    const p = await plan(sid);
    const r02 = p.ops.filter(o => (o.resolves || []).includes('R-02'));
    expect(r02.length).toBeGreaterThanOrEqual(1);
    if (p.summary.remainingSoft > 0) {
      expect(r02.every(o => o.type === 'drop' && o.lastResort === true)).toBe(true);
    } else {
      expect(r02.some(o => o.type !== 'drop' && o.lastResort !== true)).toBe(true);
    }
    await A(request(app).delete(`${B}/terms/322`).query({ activeCode: '251' }), tok).catch(() => {});
  });
});
