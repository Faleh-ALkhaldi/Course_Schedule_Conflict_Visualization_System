// NEW-FU-528 (Batch 9 Issue 1): the (credits × day-pattern × duration) rule must hold
// on the TIME-EDIT path too, not just createSection. assignSection moves a whole group
// to the same start/end, so a duration change can break the pattern — a 3-credit
// Sun/Tue/Thu group is legal at 50 min but ILLEGAL at 75 min (which must be 2 days).
// This is exactly how a 75-min Sun/Tue/Thu group got persisted. The edit modal
// auto-converts the pattern; this is the server-side backstop.
const request = require('supertest');
const app = require('../../src/app');
const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);

let tok;
beforeAll(async () => { tok = (await request(app).post(`${B}/auth/login`).send({ username:'admin1', password:'password123' })).body.token; });

test('time-edit cannot make a group violate credits×duration×days; legal moves still pass', async () => {
  await A(request(app).post(`${B}/terms`), tok).send({ code: '341' });
  const sid = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === '341').id;
  const ex = (await A(request(app).get(`${B}/schedules/${sid}/sections`), tok)).body;
  for (const s of (ex.sections || ex)) await A(request(app).delete(`${B}/sections/${s.id}?scope=row`), tok).catch(() => {});

  const c3 = (await A(request(app).get(`${B}/courses`), tok)).body.find(c => c.credits === 3 && !c.has_lab && c.category === 'UG');
  const v  = (await A(request(app).get(`${B}/venues`), tok)).body.find(x => x.type === 'LectureHall');
  const i  = (await A(request(app).get(`${B}/instructors`), tok)).body[0];

  const cr = await A(request(app).post(`${B}/schedules/${sid}/sections`), tok)
    .send({ courseId: c3.id, instructorId: i.id, venueId: v.id, sectionNumber: '01', sectionType: 'Lec',
            days: ['Sunday','Tuesday','Thursday'], startTime: '10:00', endTime: '10:50' });
  expect(cr.status).toBe(201);

  const arr = (await A(request(app).get(`${B}/schedules/${sid}/sections`), tok)).body;
  const one = (arr.sections || arr).find(s => s.day === 'Sunday');

  // Stretch the Sun/Tue/Thu group to 75 min → illegal (must be 2 days) → rejected.
  const bad = await A(request(app).put(`${B}/sections/${one.id}`), tok).send({ day:'Sunday', startTime:'10:00', endTime:'11:15' });
  expect(bad.status).toBe(400);

  // A pure start-time move at the same legal 50 min stays allowed.
  const ok = await A(request(app).put(`${B}/sections/${one.id}`), tok).send({ day:'Sunday', startTime:'11:00', endTime:'11:50' });
  expect(ok.status).toBe(200);

  await A(request(app).delete(`${B}/terms/341`).query({ activeCode: '251' }), tok).catch(() => {});
});
