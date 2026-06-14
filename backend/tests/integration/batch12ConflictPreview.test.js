// NEW-FU-534 (Batch 12): the edit panel must run the FULL conflict engine on a PROPOSED
// change so a conflicting edit can never be saved unflagged. This locks the dry-run
// preview endpoint — it catches venue/instructor double-booking (R-04/R-05) AND returns
// no conflicts for a clash-free change, using the same engine Quick Fix / Suggest use.
const request = require('supertest');
const app = require('../../src/app');
const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);

let tok, sid;
beforeAll(async () => {
  tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token;
  sid = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === '252').id;
});

test('preview flags a proposed change that double-books a venue, and clears for a free change', async () => {
  const list = (() => { const b = []; return b; })();
  const secs = (await A(request(app).get(`${B}/schedules/${sid}/sections`), tok)).body;
  const arr = secs.sections || secs;
  const T = arr.find(s => (s.venueId ?? s.venue_id) && (s.startTime ?? s.start_time));
  const S = arr.find(s => s.id !== T.id
    && (s.courseId ?? s.course_id) !== (T.courseId ?? T.course_id) && s.sectionType === 'Lec');

  // Move S onto T's venue + day + time → must flag R-05 (venue double-book).
  const clash = await A(request(app).post(`${B}/schedules/${sid}/conflicts/preview`), tok).send({
    sectionId: S.id, courseId: S.courseId ?? S.course_id, instructorId: S.instructorId ?? S.instructor_id,
    venueId: T.venueId ?? T.venue_id, sectionNumber: S.sectionNumber ?? S.section_number, sectionType: 'Lec',
    days: [T.day], startTime: (T.startTime || T.start_time).slice(0, 5), endTime: (T.endTime || T.end_time).slice(0, 5),
  });
  expect(clash.status).toBe(200);
  expect(clash.body.conflicts.some(c => c.ruleId === 'R-05')).toBe(true);

  // Preview S unchanged at its own current slot → no NEW conflict involving it.
  const same = await A(request(app).post(`${B}/schedules/${sid}/conflicts/preview`), tok).send({
    sectionId: S.id, courseId: S.courseId ?? S.course_id, instructorId: S.instructorId ?? S.instructor_id,
    venueId: S.venueId ?? S.venue_id, sectionNumber: S.sectionNumber ?? S.section_number, sectionType: 'Lec',
    days: [S.day], startTime: (S.startTime || S.start_time).slice(0, 5), endTime: (S.endTime || S.end_time).slice(0, 5),
  });
  expect(same.status).toBe(200);
  expect(same.body.conflicts.filter(c => c.ruleId === 'R-04' || c.ruleId === 'R-05').length).toBe(0);
});
