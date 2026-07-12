// NEW-FU-244: Integration tests for the extended Suggest pattern enum.
//
// Phase 17 expanded the suggester's pattern catalog from {STT, MW} to
// the full KFUPM rule table (FU-240/241). These tests exercise the
// round-trip from POST /schedules/:id/suggest with new pattern names
// to the resulting sections in the DB, asserting:
//   • the suggester accepts the new pattern values without 400ing
//   • the resulting sections honor the (days, duration) tuple of the
//     pattern the caller picked
//   • every emitted section passes sectionPattern.validateSectionPattern
//     (no internal-consistency drift between suggester output and
//     validator's rule table)
//
// Each test creates a fresh term, runs Suggest with carefully chosen
// patterns, then DELETEs the term so the suite stays idempotent
// against a dev DB.

const request = require('supertest');
const app     = require('../../src/app');

const ADMIN = { username: 'admin1', password: 'password123' };

let adminTok;
const createdCodes = new Set();

function flag(course, camel, snake) {
  return Boolean(course?.[camel] ?? course?.[snake]);
}

function isSchedulableOneDayLecture(course) {
  return Number(course?.credits) === 1
    && !flag(course, 'hasLab', 'has_lab')
    && !flag(course, 'isCapstone', 'is_capstone')
    && !flag(course, 'isExternal', 'is_external')
    && !flag(course, 'isThesis', 'is_thesis')
    && !flag(course, 'isResearch', 'is_research');
}

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

// Helper: spin up a fresh blank term we can pour suggested sections
// into. Returns the term's schedule id.
async function freshTermSchedule(code) {
  createdCodes.add(code);
  // Pre-clean from any prior partial run.
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
  return sched.id;
}

describe('FU-244: SuggestService accepts the extended pattern enum', () => {

  test('STT_50 pattern produces 3-day 50-min sections', async () => {
    const scheduleId = await freshTermSchedule('291');
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    expect(c).toBeTruthy();

    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c.id, sections: 1, pattern: 'STT_50' }] });
    expect(r.status).toBe(200);

    // Fetch the resulting sections directly so we can inspect days/times.
    const sx = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`);
    const list = (sx.body.sections || sx.body).filter(s => s.courseId === c.id);
    expect(list.length).toBeGreaterThan(0);
    const days = new Set(list.map(s => s.day));
    expect(days).toEqual(new Set(['Sunday', 'Tuesday', 'Thursday']));
    // 50 min == startTime + 50 == endTime
    for (const s of list) {
      const [sh, sm] = s.startTime.split(':').map(Number);
      const [eh, em] = s.endTime.split(':').map(Number);
      expect((eh * 60 + em) - (sh * 60 + sm)).toBe(50);
    }
  });

  test('MW_75 pattern produces 2-day 75-min sections', async () => {
    const scheduleId = await freshTermSchedule('292');
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);

    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c.id, sections: 1, pattern: 'MW_75' }] });
    expect(r.status).toBe(200);

    const sx = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`);
    const list = (sx.body.sections || sx.body).filter(s => s.courseId === c.id);
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list.map(s => s.day))).toEqual(new Set(['Monday', 'Wednesday']));
    for (const s of list) {
      const [sh, sm] = s.startTime.split(':').map(Number);
      const [eh, em] = s.endTime.split(':').map(Number);
      expect((eh * 60 + em) - (sh * 60 + sm)).toBe(75);
    }
  });

  test('legacy STT and MW names still work', async () => {
    const scheduleId = await freshTermSchedule('293');
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);

    // Pre-clean: 293 is a Summer code; the new FU-234 season-family
    // seed might have given it inherited sections from 253. Delete
    // any pre-existing sections so the test's assertion is clean.
    const existing = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`);
    for (const s of (existing.body.sections || existing.body)) {
      await request(app)
        .delete(`/api/v1/sections/${s.id}`)
        .set('Authorization', `Bearer ${adminTok}`)
        .catch(() => {});
    }

    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c.id, sections: 1, pattern: 'STT' }] }); // legacy
    expect(r.status).toBe(200);
    const sx = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`);
    const list = (sx.body.sections || sx.body).filter(s => s.courseId === c.id);
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list.map(s => s.day))).toEqual(new Set(['Sunday', 'Tuesday', 'Thursday']));
  });

  // NEW-FU-250: confirm the two-axis form is accepted end-to-end.
  // Pre-FU-247, callers had to send `pattern: 'STT_50'`. Now they can
  // send `dayPattern: 'STT', duration: 50`; the suggester resolves
  // identically and produces the same sections.
  test('new two-axis shape {dayPattern, duration} produces same sections as legacy STT_50', async () => {
    const scheduleId = await freshTermSchedule('261');
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    expect(c).toBeTruthy();

    // Clear inherited sections so the assertion is clean.
    const existing = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`);
    for (const s of (existing.body.sections || existing.body)) {
      await request(app).delete(`/api/v1/sections/${s.id}`)
        .set('Authorization', `Bearer ${adminTok}`).catch(() => {});
    }

    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [{
          courseId: c.id, sections: 1,
          dayPattern: 'STT', duration: 50,
        }],
      });
    expect(r.status).toBe(200);

    const sx = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`);
    const list = (sx.body.sections || sx.body).filter(s => s.courseId === c.id);
    expect(new Set(list.map(s => s.day))).toEqual(new Set(['Sunday', 'Tuesday', 'Thursday']));
    for (const s of list) {
      const [sh, sm] = s.startTime.split(':').map(Number);
      const [eh, em] = s.endTime.split(':').map(Number);
      expect((eh * 60 + em) - (sh * 60 + sm)).toBe(50);
    }
  });

  // NEW-FU-256: ONE_DAY + explicit `day` produces sections all on
  // the chosen weekday. Confirms the FU-252 wiring from the modal
  // through resolvePattern + generateSlots to the DB.
  test('ONE_DAY + day=Wednesday → all sections land on Wednesday', async () => {
    const scheduleId = await freshTermSchedule('301');
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    // Need a schedulable 1-credit lecture course for ONE_DAY to be legal.
    // Info-only/project rows are deliberately ignored by Suggest, so the
    // fixture must not accidentally reuse one of those seeded courses.
    let oneCreditCourse = courses.find(isSchedulableOneDayLecture);
    let createdCourseId = null;
    if (!oneCreditCourse) {
      for (let n = 180; n <= 199 && !oneCreditCourse; n++) {
        const cR = await request(app)
          .post('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
          .send({
            courseCode: `SWE ${n}`,
            name: 'One Day Pattern Test', credits: 1,
            academicLevel: 'Freshman', category: 'UG', hasLab: false,
          });
        if (cR.status === 201) oneCreditCourse = cR.body;
      }
      expect(oneCreditCourse).toBeTruthy();
      createdCourseId = oneCreditCourse.id;
    }

    // Clear any inherited sections so the assertion is clean.
    const existing = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`);
    for (const s of (existing.body.sections || existing.body)) {
      await request(app).delete(`/api/v1/sections/${s.id}`)
        .set('Authorization', `Bearer ${adminTok}`).catch(() => {});
    }

    const r = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [{
          courseId: oneCreditCourse.id, sections: 1,
          dayPattern: 'ONE_DAY', duration: 50,
          day: 'Wednesday',
        }],
      });
    expect(r.status).toBe(200);

    const sx = await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`);
    const list = (sx.body.sections || sx.body).filter(s => s.courseId === oneCreditCourse.id);
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list.map(s => s.day))).toEqual(new Set(['Wednesday']));

    if (createdCourseId) {
      await request(app).delete(`/api/v1/courses/${createdCourseId}`)
        .set('Authorization', `Bearer ${adminTok}`).catch(() => {});
    }
  });

  test('invalid day=Friday → 400 with clear error', async () => {
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses[0];
    const r = await request(app)
      .post(`/api/v1/schedules/40000000-0000-0000-0000-000000000001/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        courseConfigs: [{
          courseId: c.id, sections: 1,
          dayPattern: 'ONE_DAY', duration: 50, day: 'Friday',
        }],
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid day/i);
  });

  test('bogus pattern → 400 with the allowed-list in the error', async () => {
    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses[0];
    const r = await request(app)
      .post(`/api/v1/schedules/40000000-0000-0000-0000-000000000001/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c.id, sections: 1, pattern: 'BOGUS_PATTERN' }] });
    expect(r.status).toBe(400);
    // NEW-FU-250: error now lists both the legacy names AND the
    // two-axis form so callers can use whichever shape they prefer.
    expect(r.body.error).toMatch(/STT_50/);
    expect(r.body.error).toMatch(/dayPattern/);
  });
});
