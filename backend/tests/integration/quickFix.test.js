// NEW-FU-318: Integration tests for the Quick Fix resolver (Phase 29).
//
// Quick Fix takes a schedule with conflicts and proposes a plan of
// minimally-destructive ops (reassign instructor / reassign venue /
// drop) that resolves as many as possible. The plan is returned
// without applying; a separate endpoint applies the user-selected
// subset atomically in one transaction.

const request = require('supertest');
const app     = require('../../src/app');
const { query } = require('../../src/config/db');   // NEW-FU-673: term-valid resource selection

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
  // NEW-FU-673: return resources VALID FOR THIS TERM — owned by this term (owner_semester = code) or
  // template (NULL). Picking from the global GET lists grabs another term's owner-scoped copy
  // (FU-645) → section-create 409 "belongs to term …". UG-only avoids the R-06 graduate window.
  const courses = (await query(
    `SELECT id, credits, has_lab, category FROM courses
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND category = 'UG'`, [code])).rows
    .map(c => ({ ...c, credits: Number(c.credits) }));
  const instructors = (await query(
    `SELECT id, name FROM instructors
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows;
  const venues = (await query(
    `SELECT id, type FROM venues
      WHERE (owner_semester = $1 OR owner_semester IS NULL) AND is_dummy = false ORDER BY name`, [code])).rows;
  return { scheduleId: sched.id, courses, instructors, venues };
}

async function createOneSection(scheduleId, opts) {
  const r = await request(app)
    .post(`/api/v1/schedules/${scheduleId}/sections`)
    .set('Authorization', `Bearer ${adminTok}`)
    .send({
      courseId:      opts.courseId,
      instructorId:  opts.instructorId,
      venueId:       opts.venueId,
      sectionNumber: opts.sectionNumber,
      sectionType:   opts.sectionType ?? 'Lec',
      days:          opts.days ?? ['Sunday', 'Tuesday', 'Thursday'],
      startTime:     opts.startTime ?? '09:00',
      endTime:       opts.endTime   ?? '09:50',
    });
  expect(r.status).toBe(201);
  return r.body.section;
}

describe('FU-318: Quick Fix resolver (Phase 29)', () => {

  test('plan endpoint returns an empty plan when there are no conflicts', async () => {
    const { scheduleId } = await freshTermSchedule('291');
    // Schedule starts empty (no conflicts).
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.ops).toEqual([]);
    expect(r.body.summary.initialHard).toBe(0);
    expect(r.body.summary.initialSoft).toBe(0);
  });

  test('plan proposes a reassign-instructor op for R-04', async () => {
    const { scheduleId, courses, instructors, venues } = await freshTermSchedule('292');
    // Use UG-category courses so R-06 (graduate-time-window) doesn't
    // fire alongside R-04 — keep the test focused on just R-04.
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const c2 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG' && c.id !== c1.id);
    const instr = instructors[0];
    const lec1 = venues.find(v => v.type === 'LectureHall');
    const lec2 = venues.find(v => v.type === 'LectureHall' && v.id !== lec1.id);

    // Two sections, same instructor, same time → R-04 hard conflict.
    await createOneSection(scheduleId, {
      courseId: c1.id, instructorId: instr.id, venueId: lec1.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    await createOneSection(scheduleId, {
      courseId: c2.id, instructorId: instr.id, venueId: lec2.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });

    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.summary.initialHard).toBeGreaterThan(0);
    // Plan should include a reassign-instructor op.
    const reassign = r.body.ops.find(o => o.type === 'reassign-instructor');
    expect(reassign).toBeTruthy();
    expect(reassign.newInstructorId).toBeTruthy();
    expect(reassign.newInstructorId).not.toBe(instr.id);
  });

  test('apply endpoint clears the conflict after applying', async () => {
    const { scheduleId, courses, instructors, venues } = await freshTermSchedule('293');
    // UG-only to avoid R-06 noise.
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG');
    const c2 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.category === 'UG' && c.id !== c1.id);
    const instr = instructors[0];
    const lec1 = venues.find(v => v.type === 'LectureHall');
    const lec2 = venues.find(v => v.type === 'LectureHall' && v.id !== lec1.id);

    await createOneSection(scheduleId, {
      courseId: c1.id, instructorId: instr.id, venueId: lec1.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    await createOneSection(scheduleId, {
      courseId: c2.id, instructorId: instr.id, venueId: lec2.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });

    const planRes = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix`)
      .set('Authorization', `Bearer ${adminTok}`);
    const ops = planRes.body.ops;
    expect(ops.length).toBeGreaterThan(0);

    const applyRes = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops });
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.applied).toBeGreaterThan(0);

    // Verify R-04 is gone.
    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r04 = (conflicts.conflicts ?? []).filter(c => c.ruleId === 'R-04' && c.sectionBId);
    expect(r04.length).toBe(0);
  });

  test('apply endpoint rejects unknown op types', async () => {
    const { scheduleId } = await freshTermSchedule('261');
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: [{ type: 'time-warp', sectionId: 'whatever' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Unsupported/i);
  });

  test('apply endpoint rejects malformed payload', async () => {
    const { scheduleId } = await freshTermSchedule('262');
    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/quick-fix/apply`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ ops: 'not-an-array' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/ops must be an array/i);
  });
});
