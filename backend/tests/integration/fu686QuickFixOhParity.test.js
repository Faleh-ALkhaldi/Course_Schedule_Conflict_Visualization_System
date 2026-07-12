// NEW-FU-686 — Quick-Fix simulator/runtime PARITY for office hours, so the PREFERRED orphan-completion
// (FU-682 Fix B: add the missing Lecture) actually wins instead of silently losing to untag/drop.
//
// THE BUG: plan() built the in-memory office-hours map from ONLY the instructors already teaching a
// section. When the complement planner assigns the new Lecture to a FREE instructor who teaches nothing
// yet (which happens whenever the course's prior teacher is busy at the first legal lecture slot — the
// planner returns the first slot where SOME instructor is free, picking a non-teaching one), that
// instructor's office hours were absent from the map. The in-memory engine then saw "teaches but has no
// office hours" and raised a PHANTOM R-13, so the greedy scored add-complement-section as creating a
// soft conflict and fell back to untag-has-lab — even though the real apply is CLEAN (the ScheduleService
// evaluator loads ALL office hours). Fix: plan() sources office hours for the whole ASSIGNABLE pool.
//
// REPRO (mirrors the live find): course A (Freshman) is COMPLETE and its Lecture sits at the first legal
// lecture slot (Sun/Tue 07:00); course B (Junior, so no R-02 with A) is an ORPHAN Lab taught by the SAME
// instructor X. Completing B places its Lecture at Sun/Tue 07:00, where X is busy with A — so the free
// office-hour-holder Y is chosen. Pre-fix the plan offered untag-has-lab for B (Y's OH unseen → phantom
// R-13); post-fix it offers add-complement-section, and applying it completes B with 0 conflicts.
const request   = require('supertest');
const app       = require('../../src/app');
const quickFix  = require('../../src/services/QuickFixService');
const { query } = require('../../src/config/db');

const Bv = '/api/v1';
const A  = (r, t) => r.set('Authorization', `Bearer ${t}`);
let tok;
beforeAll(async () => { tok = (await request(app).post(`${Bv}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token; });
const wipe = async (code) => {
  await query(`DELETE FROM office_hours WHERE instructor_id IN (SELECT id FROM instructors WHERE owner_semester=$1)`, [code]);
  await query(`DELETE FROM schedules WHERE department_id='SWE-DEPT' AND semester=$1`, [code]);
  for (const t of ['courses', 'instructors', 'venues']) await query(`DELETE FROM ${t} WHERE owner_semester=$1`, [code]);
};

describe('FU-686 — Quick-Fix office-hour parity: orphan-completion wins over untag for a non-teaching instructor', () => {
  test('prior teacher busy at the first lecture slot → a free OH-holder completes the course (no phantom R-13)', async () => {
    const T = '343';
    await A(request(app).post(`${Bv}/terms`), tok).send({ code: T });
    const sid = (await A(request(app).get(`${Bv}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === T).id;
    // Start from a clean, fully-controlled fixture (the test DB seeds a new term only minimally).
    await query(`DELETE FROM sections WHERE schedule_id=$1`, [sid]);
    await query(`DELETE FROM office_hours WHERE instructor_id IN (SELECT id FROM instructors WHERE owner_semester=$1)`, [T]);
    for (const t of ['courses', 'instructors', 'venues']) await query(`DELETE FROM ${t} WHERE owner_semester=$1`, [T]);

    // Two has_lab courses of different UG levels (so A's lecture and B's new lecture at the same time
    // raise no R-02), taught by the SAME instructor X. Y is a FREE instructor who HAS office hours
    // (not at the lecture slot, so Y is free there) — the one the planner will pick to complete B.
    const cA = (await query(`INSERT INTO courses (course_code,name,credits,academic_level,category,num_sections,has_lab,owner_semester)
      VALUES ('SWE 911','Parity A',3,'Freshman','UG',1,true,$1) RETURNING id`, [T])).rows[0];
    const cB = (await query(`INSERT INTO courses (course_code,name,credits,academic_level,category,num_sections,has_lab,owner_semester)
      VALUES ('SWE 912','Parity B',3,'Junior','UG',1,true,$1) RETURNING id`, [T])).rows[0];
    const X = (await query(`INSERT INTO instructors (name,email,is_dummy,owner_semester) VALUES ('XAVIER PRIOR','xavier-686@kfupm.test',false,$1) RETURNING id`, [T])).rows[0];
    const Y = (await query(`INSERT INTO instructors (name,email,is_dummy,owner_semester) VALUES ('YASMIN FREE','yasmin-686@kfupm.test',false,$1) RETURNING id`, [T])).rows[0];
    const hall  = (await query(`INSERT INTO venues (name,type,capacity,is_dummy,owner_semester) VALUES ('22-911','LectureHall',40,false,$1) RETURNING id`, [T])).rows[0];
    // A SECOND lecture hall, free at the first lecture slot: course A occupies 22-911 at Sun/Tue 07:00,
    // so without this the planner would skip to a later slot where the prior teacher X is free again
    // (a teaching instructor → no parity issue). With it, B's lecture lands at 07:00 where X is busy →
    // the FREE office-hour-holder Y is chosen, which is exactly the case FU-686 fixes.
    const hall2 = (await query(`INSERT INTO venues (name,type,capacity,is_dummy,owner_semester) VALUES ('22-913','LectureHall',40,false,$1) RETURNING id`, [T])).rows[0];
    const lab   = (await query(`INSERT INTO venues (name,type,capacity,is_dummy,owner_semester) VALUES ('22-LAB','Laboratory',30,false,$1) RETURNING id`, [T])).rows[0];
    // Both instructors have office hours (R-13 requires every teaching instructor to hold OH), placed
    // away from their classes. Y's are NOT at the lecture slot → Y is free to take the Sun/Tue 07:00
    // lecture, and because Y HAS office hours the real engine raises no R-13 — the parity the fix restores.
    await query(`INSERT INTO office_hours (instructor_id,day,start_time,end_time) VALUES
      ($1,'Tuesday','12:00','13:00'),($1,'Thursday','12:00','13:00')`, [X.id]);
    await query(`INSERT INTO office_hours (instructor_id,day,start_time,end_time) VALUES
      ($1,'Monday','12:00','13:00'),($1,'Wednesday','12:00','13:00')`, [Y.id]);

    // A = COMPLETE has_lab course; its Lecture occupies the first legal lecture slot (Sun/Tue 07:00).
    // B = ORPHAN Lab (no Lecture), same instructor X → X is busy at Sun/Tue 07:00.
    await query(`INSERT INTO sections (schedule_id,course_id,instructor_id,venue_id,section_number,day,start_time,end_time,section_type,gender) VALUES
      ($1,$2,$3,$4,'01','Sunday','07:00','07:50','Lec','M'),
      ($1,$2,$3,$4,'01','Tuesday','07:00','07:50','Lec','M'),
      ($1,$2,$3,$5,'50','Monday','08:00','10:40','Lab','M')`, [sid, cA.id, X.id, hall.id, lab.id]);
    await query(`INSERT INTO sections (schedule_id,course_id,instructor_id,venue_id,section_number,day,start_time,end_time,section_type,gender) VALUES
      ($1,$2,$3,$4,'51','Wednesday','08:00','10:40','Lab','M')`, [sid, cB.id, X.id, lab.id]);

    // PLAN: the orphan B must be resolved by COMPLETING it (add-complement-section), NOT by untagging it.
    const plan = await quickFix.plan(sid);
    const opForB = (plan.ops || []).find(o => (o.resolves || []).includes('R-14'));
    expect(opForB).toBeTruthy();
    expect(opForB.type).toBe('add-complement-section');          // FU-686: not phantom-R-13-penalised into untag
    expect(/Add the missing Lecture/i.test(opForB.label || '')).toBe(true);
    expect(/YASMIN FREE/.test(opForB.label || '')).toBe(true);    // a NON-teaching office-hour-holder was chosen

    // APPLY: B becomes a complete Lecture+Lab course and the schedule is conflict-free.
    await quickFix.apply(sid, [opForB]);
    const types = (await query(`SELECT DISTINCT section_type FROM sections WHERE schedule_id=$1 AND course_id=$2`, [sid, cB.id]))
      .rows.map(r => r.section_type).sort();
    expect(types).toEqual(['Lab', 'Lec']);
    const conflicts = (await A(request(app).get(`${Bv}/schedules/${sid}/conflicts`), tok)).body.conflicts || [];
    expect(conflicts.length).toBe(0);

    await wipe(T);
  });
});
