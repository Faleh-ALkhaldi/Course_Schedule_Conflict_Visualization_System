// NEW-FU-684 — R-15 (credit coverage) must derive "has a lab" from the ACTUAL Lab section, not only the
// course's has_lab FLAG. The user hit a 100-min SWE 206 lecture firing the soft R-15 "needs 150 min"
// even though the course's Lab WAS scheduled — because has_lab had gone stale/false (an old import / a
// later untag), and the only offered remediations were to EXTEND the lecture or DROP it, ignoring the lab
// sitting right there. With the lab present, the lecture only needs (credits-1)×50 = 100 min, so R-15
// must NOT fire; with NO lab present it still must.
const request   = require('supertest');
const app       = require('../../src/app');
const { query } = require('../../src/config/db');

const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);
let tok;
beforeAll(async () => { tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token; });
const wipe = async (code) => {
  await query(`DELETE FROM office_hours WHERE instructor_id IN (SELECT id FROM instructors WHERE owner_semester=$1)`, [code]);
  await query(`DELETE FROM schedules WHERE department_id='SWE-DEPT' AND semester=$1`, [code]);
  for (const t of ['courses', 'instructors', 'venues']) await query(`DELETE FROM ${t} WHERE owner_semester=$1`, [code]);
};
// GET /conflicts re-evaluates the schedule live and returns the current conflict set.
const r15Count = async (sid) => {
  const body = (await A(request(app).get(`${B}/schedules/${sid}/conflicts`), tok)).body;
  return (body.conflicts || []).filter(c => (c.ruleId || c.rule_id) === 'R-15').length;
};

describe('FU-684 — R-15 recognizes a real Lab section even when has_lab is stale/false', () => {
  test('a 100-min lecture + a Lab section + has_lab=FALSE → NO false R-15; remove the lab → R-15 fires', async () => {
    await A(request(app).post(`${B}/terms`), tok).send({ code: '341' });
    const sid = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === '341').id;
    await query(`DELETE FROM sections WHERE schedule_id=$1`, [sid]);

    // A 3-credit course whose has_lab FLAG is FALSE (the stale/dropped state).
    const course = (await query(
      `SELECT id FROM courses WHERE owner_semester='341' AND credits=3 AND is_capstone=false AND is_external=false LIMIT 1`)).rows[0];
    await query(`UPDATE courses SET has_lab=false WHERE id=$1`, [course.id]);
    const hall = (await query(`SELECT id FROM venues WHERE owner_semester='341' AND type IN ('LectureHall','Multipurpose') LIMIT 1`)).rows[0];
    const lab  = (await query(`SELECT id FROM venues WHERE owner_semester='341' AND type='Laboratory' LIMIT 1`)).rows[0];
    const instr = (await query(`SELECT id FROM instructors WHERE owner_semester='341' AND is_dummy=false ORDER BY name LIMIT 1`)).rows[0];

    // 100-min lecture (2 × 50) + a Lab section for the same course.
    await query(`INSERT INTO sections (schedule_id,course_id,instructor_id,venue_id,section_number,day,start_time,end_time,section_type,gender) VALUES
      ($1,$2,$3,$4,'01','Sunday','07:00','07:50','Lec','M'),
      ($1,$2,$3,$4,'01','Tuesday','07:00','07:50','Lec','M'),
      ($1,$2,$3,$5,'50','Monday','08:00','10:40','Lab','M')`, [sid, course.id, instr.id, hall.id, lab.id]);

    expect(await r15Count(sid)).toBe(0);   // the Lab is present → the 100-min lecture is correct → NO R-15

    // Remove the Lab → the lecture is now genuinely under-length (no lab to carry the 3rd credit).
    await query(`DELETE FROM sections WHERE schedule_id=$1 AND section_type='Lab'`, [sid]);
    expect(await r15Count(sid)).toBeGreaterThan(0);   // no lab now → R-15 correctly fires

    await wipe('341');
  });
});
