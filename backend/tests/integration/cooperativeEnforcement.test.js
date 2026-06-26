// NEW-FU-213: Integration tests for cooperative active-term enforcement.
//
// Exercises the contract introduced in FU-210/FU-211:
//
//   Request header                         | Effect on mutating routes
//   ---------------------------------------|---------------------------------
//   absent                                 | proceed (backward compat)
//   X-Active-Term: <active code>           | proceed
//   X-Active-Term: <archived code>         | 409 with "archived" in error
//   X-Active-Term: <unknown / malformed>   | proceed (resilience)
//
// Routes under test: POST/PUT/DELETE for /courses, /instructors, /venues,
// and /instructors/:id/office-hours. The shape is identical for all
// twelve verb-endpoint pairs because the middleware sits ahead of every
// controller; we test the "archived → 409" path for each, plus the four
// header-state scenarios on a single representative (POST /courses) to
// keep the matrix tractable.
//
// Sections deliberately aren't included: their per-schedule guard lives
// in schedSvc.assertSchedulerEditableLocked (Phase 10) and operates on
// the schedule id, not the X-Active-Term header. The two enforcement
// axes are complementary, not duplicative.

const request = require('supertest');
const app     = require('../../src/app');

const ADMIN = { username: 'admin1', password: 'password123' };
const HDR   = 'X-Active-Term';

let adminTok;
const createdTermCodes = new Set();
const createdCourses     = [];
const createdInstructors = [];
const createdVenues      = [];
const createdOH          = []; // { instructorId, ohId }

// NEW-FU-217: range guard rejects pre-251 / post-303. Use an in-range
// code distinct from every other test fixture (253 = Summer 2026).
const ARCHIVED_CODE = '253';

async function login(creds) {
  const r = await request(app).post('/api/v1/auth/login').send(creds);
  expect(r.status).toBe(200);
  return r.body.token;
}

// Tiny helpers to keep the assertion shape consistent across tests.
const auth   = (req) => req.set('Authorization', `Bearer ${adminTok}`);
const withHdr = (req, code) => (code === null ? req : req.set(HDR, code));

beforeAll(async () => {
  adminTok = await login(ADMIN);

  // Provision an archived term we can point the header at. The pre-clean
  // tolerates a leftover from a crashed prior run.
  createdTermCodes.add(ARCHIVED_CODE);
  await request(app)
    .delete(`/api/v1/terms/${ARCHIVED_CODE}`)
    .query({ activeCode: '251' })
    .set('Authorization', `Bearer ${adminTok}`);
  const createRes = await request(app)
    .post('/api/v1/terms')
    .set('Authorization', `Bearer ${adminTok}`)
    .send({ code: ARCHIVED_CODE });
  expect(createRes.status).toBe(201);
  const archiveRes = await request(app)
    .patch(`/api/v1/terms/${ARCHIVED_CODE}/archive`)
    .query({ activeCode: '251' })
    .set('Authorization', `Bearer ${adminTok}`);
  expect(archiveRes.status).toBe(200);
});

afterAll(async () => {
  // Cleanup order matters: delete child OH rows before instructors so
  // the instructor's cascade target isn't already absent.
  for (const { instructorId, ohId } of createdOH) {
    await auth(request(app).delete(`/api/v1/instructors/${instructorId}/office-hours/${ohId}`));
  }
  for (const id of createdInstructors) {
    await auth(request(app).delete(`/api/v1/instructors/${id}`));
  }
  for (const id of createdVenues) {
    await auth(request(app).delete(`/api/v1/venues/${id}`));
  }
  for (const id of createdCourses) {
    await auth(request(app).delete(`/api/v1/courses/${id}`));
  }
  for (const code of createdTermCodes) {
    await request(app)
      .delete(`/api/v1/terms/${code}`)
      .query({ activeCode: '251' })
      .set('Authorization', `Bearer ${adminTok}`);
  }
});

// Counter that gives every test a unique resource code/name so reruns
// don't collide on UNIQUE constraints. The course-code form keeps the
// counter at the END inside a 20-char budget so increments don't get
// truncated into duplicates by a slice(0, N).
let uniq = 0;
const next = (prefix) => `${prefix}-FU213-${Date.now()}-${++uniq}`;
// NEW-FU-673: course codes must now match "SWE" + space + a 3-digit number whose
// hundreds digit fixes the academic level (FU-422/FU-576): 100–199 = Freshman.
// Every course this suite creates is academicLevel 'Freshman', so codes live in
// the 100s. SWE 101 is the only 100-level seed code, so 102+ never collides.
// A dedicated counter keeps each create unique and in-range (the suite makes only
// a handful of courses); globalSetup drops/reseeds the DB per run, so the counter
// resetting to 0 each run can't clash with a prior run.
let courseNum = 101;
const nextCourseCode = () => `SWE ${++courseNum}`; // SWE 102, SWE 103, … (Freshman range)

describe('FU-213: Cooperative active-term enforcement', () => {

  // ── Header-state matrix on a single representative (POST /courses) ──────
  describe('POST /courses — header state matrix', () => {
    test('no header → 201 (backward compat)', async () => {
      const code = nextCourseCode();
      const r = await auth(request(app).post('/api/v1/courses')).send({
        courseCode: code, name: 'No-Header Course', credits: 3, academicLevel: 'Freshman', category: 'UG',
      });
      expect(r.status).toBe(201);
      createdCourses.push(r.body.id);
    });

    test('X-Active-Term: <active> → 201', async () => {
      const code = nextCourseCode();
      const r = await withHdr(auth(request(app).post('/api/v1/courses')), '251').send({
        courseCode: code, name: 'Active-Header Course', credits: 3, academicLevel: 'Freshman', category: 'UG',
      });
      expect(r.status).toBe(201);
      createdCourses.push(r.body.id);
    });

    test('X-Active-Term: <archived> → 409', async () => {
      const code = nextCourseCode();
      const r = await withHdr(auth(request(app).post('/api/v1/courses')), ARCHIVED_CODE).send({
        courseCode: code, name: 'Archived-Header Course', credits: 3, academicLevel: 'Freshman', category: 'UG',
      });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/archived/i);
      expect(r.body.error).toMatch(new RegExp(ARCHIVED_CODE));
    });

    test('X-Active-Term: <bogus / unknown> → 201 (resilient)', async () => {
      const code = nextCourseCode();
      const r = await withHdr(auth(request(app).post('/api/v1/courses')), '999').send({
        courseCode: code, name: 'Bogus-Header Course', credits: 3, academicLevel: 'Freshman', category: 'UG',
      });
      expect(r.status).toBe(201);
      createdCourses.push(r.body.id);
    });

    test('X-Active-Term: <malformed> → 201 (resilient, no 400)', async () => {
      const code = nextCourseCode();
      const r = await withHdr(auth(request(app).post('/api/v1/courses')), 'not-a-code').send({
        courseCode: code, name: 'Malformed-Header Course', credits: 3, academicLevel: 'Freshman', category: 'UG',
      });
      expect(r.status).toBe(201);
      createdCourses.push(r.body.id);
    });
  });

  // ── Each protected verb-endpoint pair: archived header → 409 ────────────
  describe('Archived-header rejection across all protected routes', () => {
    let existingCourseId, existingInstructorId, existingVenueId, existingOhId;

    beforeAll(async () => {
      // Seed one resource of each type so PUT/DELETE have a valid target.
      // These reuse the no-header path, so they succeed regardless of the
      // archived term we set up in the outer beforeAll.
      const cR = await auth(request(app).post('/api/v1/courses')).send({
        courseCode: nextCourseCode(), name: 'Seed Course', credits: 3, academicLevel: 'Freshman', category: 'UG',
      });
      expect(cR.status).toBe(201);
      existingCourseId = cR.body.id;
      createdCourses.push(existingCourseId);

      const iR = await auth(request(app).post('/api/v1/instructors')).send({
        // NEW-FU-510 (Batch 2): instructor names are letters/space/hyphen/apostrophe
        // only — the unique token lives in the email (which allows digits), not the name.
        name: 'Iseed Cooperative', email: `${next('eseed')}@test.local`,
      });
      expect(iR.status).toBe(201);
      existingInstructorId = iR.body.id;
      createdInstructors.push(existingInstructorId);

      const vR = await auth(request(app).post('/api/v1/venues')).send({
        name: next('V').slice(0, 16), type: 'LectureHall', capacity: 30,
      });
      expect(vR.status).toBe(201);
      existingVenueId = vR.body.id;
      createdVenues.push(existingVenueId);

      const ohR = await auth(request(app).post(`/api/v1/instructors/${existingInstructorId}/office-hours`)).send({
        day: 'Sunday', startTime: '14:00', endTime: '15:00',
      });
      expect(ohR.status).toBe(201);
      existingOhId = ohR.body.id;
      createdOH.push({ instructorId: existingInstructorId, ohId: existingOhId });
    });

    // PUT /courses
    test('PUT /courses/:id with archived header → 409', async () => {
      const r = await withHdr(auth(request(app).put(`/api/v1/courses/${existingCourseId}`)), ARCHIVED_CODE).send({
        name: 'Updated Name',
      });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/archived/i);
    });

    test('DELETE /courses/:id with archived header → 409', async () => {
      const r = await withHdr(auth(request(app).delete(`/api/v1/courses/${existingCourseId}`)), ARCHIVED_CODE);
      expect(r.status).toBe(409);
    });

    test('POST /instructors with archived header → 409', async () => {
      const r = await withHdr(auth(request(app).post('/api/v1/instructors')), ARCHIVED_CODE).send({
        name: next('I'), email: `${next('e')}@test.local`,
      });
      expect(r.status).toBe(409);
    });

    test('PUT /instructors/:id with archived header → 409', async () => {
      const r = await withHdr(auth(request(app).put(`/api/v1/instructors/${existingInstructorId}`)), ARCHIVED_CODE).send({
        name: 'Updated Instructor',
      });
      expect(r.status).toBe(409);
    });

    test('DELETE /instructors/:id with archived header → 409', async () => {
      const r = await withHdr(auth(request(app).delete(`/api/v1/instructors/${existingInstructorId}`)), ARCHIVED_CODE);
      expect(r.status).toBe(409);
    });

    test('POST /venues with archived header → 409', async () => {
      const r = await withHdr(auth(request(app).post('/api/v1/venues')), ARCHIVED_CODE).send({
        name: next('V').slice(0, 16), type: 'LectureHall', capacity: 30,
      });
      expect(r.status).toBe(409);
    });

    test('PUT /venues/:id with archived header → 409', async () => {
      const r = await withHdr(auth(request(app).put(`/api/v1/venues/${existingVenueId}`)), ARCHIVED_CODE).send({
        name: 'Updated Venue',
      });
      expect(r.status).toBe(409);
    });

    test('DELETE /venues/:id with archived header → 409', async () => {
      const r = await withHdr(auth(request(app).delete(`/api/v1/venues/${existingVenueId}`)), ARCHIVED_CODE);
      expect(r.status).toBe(409);
    });

    test('POST /office-hours with archived header → 409', async () => {
      const r = await withHdr(
        auth(request(app).post(`/api/v1/instructors/${existingInstructorId}/office-hours`)),
        ARCHIVED_CODE
      ).send({ day: 'Monday', startTime: '10:00', endTime: '11:00' });
      expect(r.status).toBe(409);
    });

    test('PUT /office-hours/:ohId with archived header → 409', async () => {
      const r = await withHdr(
        auth(request(app).put(`/api/v1/instructors/${existingInstructorId}/office-hours/${existingOhId}`)),
        ARCHIVED_CODE
      ).send({ day: 'Tuesday', startTime: '11:00', endTime: '12:00' });
      expect(r.status).toBe(409);
    });

    test('DELETE /office-hours/:ohId with archived header → 409', async () => {
      const r = await withHdr(
        auth(request(app).delete(`/api/v1/instructors/${existingInstructorId}/office-hours/${existingOhId}`)),
        ARCHIVED_CODE
      );
      expect(r.status).toBe(409);
    });
  });

  // ── Read endpoints stay open even with archived header ──────────────────
  describe('Read endpoints unaffected by archived header', () => {
    test('GET /courses passes through (200)', async () => {
      const r = await withHdr(auth(request(app).get('/api/v1/courses')), ARCHIVED_CODE);
      expect(r.status).toBe(200);
    });

    test('GET /instructors passes through (200)', async () => {
      const r = await withHdr(auth(request(app).get('/api/v1/instructors')), ARCHIVED_CODE);
      expect(r.status).toBe(200);
    });

    test('GET /venues passes through (200)', async () => {
      const r = await withHdr(auth(request(app).get('/api/v1/venues')), ARCHIVED_CODE);
      expect(r.status).toBe(200);
    });

    test('GET /terms passes through (200) — term mgmt is always allowed', async () => {
      const r = await withHdr(auth(request(app).get('/api/v1/terms')), ARCHIVED_CODE);
      expect(r.status).toBe(200);
    });
  });

  // ── Term-management endpoints stay open even with archived header ──────
  // Otherwise the user couldn't recover from being on an archived term —
  // they'd be unable to unarchive it (which is exactly the operation they
  // need to escape the lockdown).
  describe('Term-management endpoints unaffected by archived header', () => {
    test('PATCH /terms/:code/unarchive with archived header succeeds (200)', async () => {
      // Unarchive then re-archive to keep the suite's archived state intact.
      const u = await withHdr(
        auth(request(app).patch(`/api/v1/terms/${ARCHIVED_CODE}/unarchive`)),
        ARCHIVED_CODE
      );
      expect(u.status).toBe(200);
      const a = await withHdr(
        auth(request(app).patch(`/api/v1/terms/${ARCHIVED_CODE}/archive`)).query({ activeCode: '251' }),
        ARCHIVED_CODE
      );
      expect(a.status).toBe(200);
    });
  });
});
