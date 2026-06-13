// NEW-FU-512 (Batch 5 Issue 2): resolver completeness — Quick Fix must always
// offer a path to ZERO conflicts and never leave the user stuck with
// "no automatic fix". Owner directive: "must always drive the schedule to 0 hard
// + 0 soft … only as a last resort, drop/delete — until no conflicts remain."
//
// Contract locked here:
//   • A MOVABLE soft conflict is resolved by a non-destructive op (move/reassign)
//     — minimal change, NO drop. (We never reach for the axe when a nudge works.)
//   • A SATURATED soft conflict the greedy cannot move/reassign now ships an
//     opt-in lastResort DROP (previously it produced ZERO ops → the reported
//     "stuck" state). summary.remaining* still reflects the no-drop world.
//   • Every initial conflict is covered by at least one op that resolves it —
//     i.e. the plan always describes a complete path to zero.

const request = require('supertest');
const app = require('../../src/app');
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
async function refs() {
  const [courses, venues, instr] = await Promise.all([
    A(request(app).get(`${B}/courses`), tok).then(r => r.body),
    A(request(app).get(`${B}/venues`), tok).then(r => r.body),
    A(request(app).get(`${B}/instructors`), tok).then(r => r.body),
  ]);
  return { courses, venues: venues.filter(v => v.type === 'LectureHall'), instr };
}
const mk = (sid, cId, iId, vId, st, sn = '01') =>
  A(request(app).post(`${B}/schedules/${sid}/sections`), tok).send({
    courseId: cId, instructorId: iId, venueId: vId, sectionNumber: sn, sectionType: 'Lec',
    days: ['Sunday', 'Tuesday', 'Thursday'], startTime: st, endTime: st.replace(':00', ':50'),
  });
const plan = (sid) => A(request(app).post(`${B}/schedules/${sid}/quick-fix`), tok).then(r => r.body);

describe('Batch 5 Issue 2 — Quick Fix resolver completeness', () => {
  test('movable soft R-02 is resolved by a non-destructive op (no drop)', async () => {
    const sid = await freshTerm('312');
    const { courses, venues, instr } = await refs();
    const jun = courses.find(c => c.academic_level === 'Junior'  && c.credits === 3);
    const sen = courses.find(c => c.academic_level === 'Senior'  && c.credits === 3);
    await mk(sid, jun.id, instr[0].id, venues[0].id, '10:00');
    await mk(sid, sen.id, instr[1].id, venues[1].id, '10:00');
    const r02 = (await plan(sid)).ops.filter(o => (o.resolves || []).includes('R-02'));
    expect(r02.length).toBeGreaterThanOrEqual(1);
    expect(r02.some(o => o.type !== 'drop')).toBe(true);          // a nudge, not the axe
    await A(request(app).delete(`${B}/terms/312`).query({ activeCode: '251' }), tok).catch(() => {});
  });

  test('saturated soft R-02 (cannot be moved) ships an opt-in lastResort drop → path to zero', async () => {
    const sid = await freshTerm('322');
    const { venues, instr } = await refs();
    const ug3 = (await A(request(app).get(`${B}/courses`), tok)).body
      .filter(c => c.credits === 3 && !c.has_lab && c.category === 'UG');
    const V = venues[0].id;
    const jun = ug3.find(c => c.academic_level === 'Junior');
    const sen = ug3.find(c => c.academic_level === 'Senior' && c.id !== jun.id);
    await mk(sid, jun.id, instr[0].id, V, '10:00');               // A
    await mk(sid, sen.id, instr[1].id, venues[1].id, '10:00');    // B — overlaps A (soft R-02)
    // Saturate venue V at every other start slot so A's only free-venue slot is
    // its current (overlapping) one → the greedy cannot move A away.
    const slots = ['07:00', '08:00', '09:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];
    let fi = 2;
    for (const st of slots) {
      const c = ug3[fi++ % ug3.length];
      await mk(sid, c.id, instr[fi % instr.length].id, V, st, '0' + ((fi % 8) + 2));
    }
    const p = await plan(sid);
    const r02 = p.ops.filter(o => (o.resolves || []).includes('R-02'));
    // The greedy found no non-destructive fix (summary still shows the soft)…
    expect(p.summary.remainingSoft).toBeGreaterThanOrEqual(1);
    // …but the plan now offers an opt-in lastResort drop so zero is reachable.
    expect(r02.length).toBeGreaterThanOrEqual(1);
    expect(r02.every(o => o.type === 'drop' && o.lastResort === true)).toBe(true);
    await A(request(app).delete(`${B}/terms/322`).query({ activeCode: '251' }), tok).catch(() => {});
  });
});
