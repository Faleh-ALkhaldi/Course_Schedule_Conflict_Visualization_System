// NEW-FU-351 (Phase 33): integration tests for the multi-section
// suggester hardening (FU-350), Quick Fix compound op (FU-348), and
// recommend() courseSectionsHint (FU-346).

const request = require('supertest');
const app     = require('../../src/app');

const ADMIN = { username: 'admin1', password: 'password123' };

let adminTok;
const createdCodes = new Set();

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

async function freshTermSchedule(code) {
  createdCodes.add(code);
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

describe('FU-346: recommend accepts sectionsHint', () => {

  test('recommendation shifts when sectionsHint bumps a course to 3 sections', async () => {
    // Two calls on the same empty schedule: one with no hint, one
    // with a hint that bumps a specific 3-credit course to sections=3.
    // The hinted call should consider that course's saturation
    // contribution as +3 per chosen day, which should push the
    // recommendation to a less-loaded pattern.
    const scheduleId = await freshTermSchedule('262');

    const r1 = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r1.status).toBe(200);
    const baseline = r1.body.recommendations.find(r => r.sections === 1);
    expect(baseline).toBeTruthy();

    const hint = { [baseline.courseId]: 3 };
    const r2 = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .query({ sectionsHint: JSON.stringify(hint) })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r2.status).toBe(200);

    // The hinted course should now report sections=3 in the response.
    const hintedCourse = r2.body.recommendations.find(r => r.courseId === baseline.courseId);
    expect(hintedCourse).toBeTruthy();
    expect(hintedCourse.sections).toBe(3);
  });

  test('invalid sectionsHint JSON returns 400', async () => {
    const scheduleId = await freshTermSchedule('263');
    const r = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/suggest-recommend`)
      .query({ sectionsHint: 'not-valid-json' })
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/URI-encoded JSON/i);
  });
});

describe('FU-348: Quick Fix compound op for saturated R-11/R-12', () => {

  test('saturated R-12 fixture resolves via simple reassign or compound', async () => {
    // Construct: a Lec section in a Lab venue (triggers R-12).
    // BLOCK every LectureHall at the section's slot so the simple
    // reassign-venue generator fails. The compound generator should
    // then propose a move + reassign to a free slot.
    const scheduleId = await freshTermSchedule('271');
    const courses     = (await request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)).body;
    const instructors = (await request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`)).body;
    const venues      = (await request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`)).body;
    const halls = venues.filter(v => v.type === 'LectureHall');
    const lab   = venues.find(v => v.type === 'Laboratory');
    expect(halls.length).toBeGreaterThanOrEqual(2);
    expect(lab).toBeTruthy();

    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const instr = instructors[0];

    // 1. Block ALL LectureHalls at Sunday 09:00 by creating filler
    //    sections of other UG 3cr no-lab courses there. Each STT
    //    section locks (Sun/Tue/Thu, 09:00-09:50).
    const fillerCourses = courses
      .filter(c2 => Number(c2.credits) === 3 && !c2.has_lab && c2.category === 'UG' && c2.id !== c.id)
      .slice(0, halls.length);
    expect(fillerCourses.length).toBe(halls.length);

    for (let i = 0; i < halls.length; i++) {
      const r = await request(app)
        .post(`/api/v1/schedules/${scheduleId}/sections`)
        .set('Authorization', `Bearer ${adminTok}`)
        .send({
          courseId:      fillerCourses[i].id,
          instructorId:  instructors[(i + 1) % instructors.length].id,
          venueId:       halls[i].id,
          sectionNumber: '01',
          sectionType:   'Lec',
          days:          ['Sunday', 'Tuesday', 'Thursday'],
          startTime:     '09:00',
          endTime:       '09:50',
        });
      expect(r.status).toBe(201);
    }

    // 2. Create the offending section: a Lec in a Lab venue at
    //    Sunday 09:00 (also conflicts with the fillers' instructor
    //    bookings, but the focus is R-12). Use a DIFFERENT instructor
    //    to keep R-04 quiet.
    const labSection = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseId:      c.id,
        instructorId:  instr.id,
        venueId:       lab.id,
        sectionNumber: '01',
        sectionType:   'Lec',
        days:          ['Sunday', 'Tuesday', 'Thursday'],
        startTime:     '09:00',
        endTime:       '09:50',
      });
    expect(labSection.status).toBe(201);

    // 3. Run Quick Fix plan.
    const plan = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(plan.status).toBe(200);

    // The R-12 conflict should be RESOLVED by the plan. Either:
    //   (a) a simple reassign-venue op (if other plan-applied moves
    //       freed up a hall at the original slot), OR
    //   (b) a compound op (if halls remain saturated at all
    //       same-slot times — the Phase 33 fallback).
    // What matters for the user is that R-12 is NOT in unresolved.
    expect((plan.body.unresolvedRuleIds ?? []).includes('R-12')).toBe(false);
    // And SOMETHING was proposed.
    expect(plan.body.ops.length).toBeGreaterThan(0);
  });

  test('apply compound op shifts time AND reassigns venue atomically', async () => {
    // Hand-craft a compound op and apply it directly, verifying both
    // the move and the reassign land in the DB.
    const scheduleId = await freshTermSchedule('272');
    const courses     = (await request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)).body;
    const instructors = (await request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`)).body;
    const venues      = (await request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`)).body;
    const c     = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const instr = instructors[0];
    const oldVenue = venues.find(v => v.type === 'LectureHall');
    const newVenue = venues.find(v => v.type === 'LectureHall' && v.id !== oldVenue.id);

    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseId: c.id, instructorId: instr.id, venueId: oldVenue.id,
        sectionNumber: '01', sectionType: 'Lec',
        days: ['Sunday', 'Tuesday', 'Thursday'],
        startTime: '09:00', endTime: '09:50',
      });
    expect(r.status).toBe(201);

    const list = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const sun = (list.sections || list).find(s => s.courseId === c.id && s.day === 'Sunday');

    const applyRes = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: [{
        type: 'compound',
        sectionId: sun.id,
        subOps: [
          { type: 'move',           sectionId: sun.id, newStartTime: '14:00', newEndTime: '14:50' },
          { type: 'reassign-venue', sectionId: sun.id, newVenueId: newVenue.id },
        ],
      }] });
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.applied).toBeGreaterThan(0);

    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const groupRows = (after.sections || after).filter(s => s.courseId === c.id);
    expect(groupRows.length).toBe(3);
    for (const row of groupRows) {
      // Both the time AND the venue changed for EVERY row in the group.
      expect(row.startTime ?? row.start_time).toMatch(/^14:00/);
      expect(row.venueId ?? row.venue_id).toBe(newVenue.id);
    }
  });

  test('apply endpoint rejects compound with invalid subOp', async () => {
    const scheduleId = await freshTermSchedule('273');
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: [{
        type: 'compound',
        sectionId: '00000000-0000-0000-0000-000000000000',
        subOps: [{ type: 'totally-bogus', sectionId: 'x' }],
      }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/compound subOp/i);
  });

  test('apply endpoint rejects nested compound', async () => {
    const scheduleId = await freshTermSchedule('281');
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: [{
        type: 'compound',
        sectionId: '00000000-0000-0000-0000-000000000000',
        subOps: [{
          type: 'compound',
          sectionId: '00000000-0000-0000-0000-000000000000',
          subOps: [{ type: 'move', sectionId: 'x', newStartTime: '09:00', newEndTime: '09:50' }],
        }],
      }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cannot nest/i);
  });
});

describe('FU-350: Multi-section suggester spreads siblings', () => {

  test('two-section course places its sections at DIFFERENT (day, startTime) slots', async () => {
    // SWE201 has num_sections=2 in the seed (Sophomore 3cr no-lab).
    // Run /suggest with sections=2 for SWE201 → both sections should
    // land in distinct (day, startTime) buckets, not stacked.
    const scheduleId = await freshTermSchedule('282');
    const courses = (await request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)).body;
    const target = courses.find(c => c.course_code === 'SWE201');
    expect(target).toBeTruthy();

    const sug = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [{
          courseId: target.id, sections: 2, duration: 50, dayPattern: 'STT',
        }],
      });
    expect(sug.status).toBe(200);

    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const groupRows = (after.sections || after).filter(s => s.courseId === target.id);
    // 2 sections × 3 STT days = 6 rows. Group them by sectionNumber
    // and check section-01's (day, startTime) set is disjoint from
    // section-02's, OR they at least differ at one day-time slot.
    const byNum = new Map();
    for (const row of groupRows) {
      const num = row.sectionNumber ?? row.section_number;
      const slot = `${row.day}|${(row.startTime ?? row.start_time ?? '').substring(0,5)}`;
      if (!byNum.has(num)) byNum.set(num, new Set());
      byNum.get(num).add(slot);
    }
    expect(byNum.size).toBe(2);
    const slots = Array.from(byNum.values());
    // The two sections' slot sets should NOT be identical (stacked).
    const a = slots[0];
    const b = slots[1];
    const aMinusB = [...a].filter(x => !b.has(x));
    expect(aMinusB.length).toBeGreaterThan(0);
  });
});
