// NEW-FU-294: Integration tests for Phase 25 — quick-fix proposals on
// R-04 (instructor double-booked) and R-05 (venue double-booked).
//
// Phase 25 extends the FU-278/Conflict.fixes channel (originally built
// for R-15 in Phase 23) to two more rules. Each fix proposal is shaped:
//   { kind: 'reassign-instructor', sectionId, instructorId, instructorName, label }
//   { kind: 'reassign-venue',      sectionId, venueId,      venueName,      label }
// The frontend applies them via PUT /sections/:id with infoOnly=true.
//
// Round-trip tested: create a double-booking → /conflicts returns the
// rule with fixes → PUT to reassign → /conflicts shows the rule cleared.

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

  // Wipe any auto-cloned sections (term creation may seed from a base
  // season-family term — Phase 16). Phase 25 tests need precise control
  // over what's in the schedule, so we start from a true blank slate.
  // Use /suggest with empty configs to clear the schedule, then verify.
  const sections = (await request(app)
    .get(`/api/v1/schedules/${sched.id}/sections`)
    .set('Authorization', `Bearer ${adminTok}`)).body;
  for (const s of (sections.sections || sections)) {
    await request(app)
      .delete(`/api/v1/sections/${s.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`)
      .catch(() => {});
  }
  return sched.id;
}

// Helper: create a single section in this schedule with explicit
// instructor + venue. Bypasses Suggest because we want precise control
// over the conflict we're seeding.
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
      // Default STT 50min — the legal pattern for 3-credit non-lab courses.
      // R-04/R-05 will fire on all 3 days if both sections share the slot,
      // but dedupe collapses them into one logical conflict per pair.
      days:          opts.days ?? ['Sunday', 'Tuesday', 'Thursday'],
      startTime:     opts.startTime ?? '09:00',
      endTime:       opts.endTime   ?? '09:50',
    });
  expect(r.status).toBe(201);
  return r.body.section;
}

describe('FU-294: R-04 quick-fix (Phase 25)', () => {

  test('R-04 conflict carries `fixes` listing free instructors', async () => {
    const scheduleId = await freshTermSchedule('281');

    // Pre-flight data: two distinct 3-cr courses, two distinct instructors,
    // one venue. We'll force-assign the SAME instructor to both → R-04 fires.
    const [courses, instructors, venues] = await Promise.all([
      request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
    ]);
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const c2 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.id !== c1.id);
    const instr = instructors[0];
    const lecVenue1 = venues.find(v => v.type === 'LectureHall');
    const lecVenue2 = venues.find(v => v.type === 'LectureHall' && v.id !== lecVenue1.id);
    expect(c1 && c2 && instr && lecVenue1 && lecVenue2).toBeTruthy();

    // Same instructor on both at 09:00–09:50 Sun → R-04 conflict.
    await createOneSection(scheduleId, {
      courseId: c1.id, instructorId: instr.id, venueId: lecVenue1.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    await createOneSection(scheduleId, {
      courseId: c2.id, instructorId: instr.id, venueId: lecVenue2.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });

    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r04 = (conflicts.conflicts ?? []).find(c => c.ruleId === 'R-04' && c.sectionBId);
    expect(r04).toBeTruthy();
    expect(Array.isArray(r04.fixes)).toBe(true);
    expect(r04.fixes.length).toBeGreaterThan(0);
    for (const fix of r04.fixes) {
      expect(fix.kind).toBe('reassign-instructor');
      expect(typeof fix.sectionId).toBe('string');
      expect(typeof fix.instructorId).toBe('string');
      expect(typeof fix.instructorName).toBe('string');
      expect(fix.instructorId).not.toBe(instr.id);  // never proposes a no-op
      expect(fix.label).toMatch(/Reassign to/);
    }
  });

  test('applying R-04 fix clears the conflict', async () => {
    const scheduleId = await freshTermSchedule('282');

    const [courses, instructors, venues] = await Promise.all([
      request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
    ]);
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const c2 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.id !== c1.id);
    const instr = instructors[0];
    const lec1 = venues.find(v => v.type === 'LectureHall');
    const lec2 = venues.find(v => v.type === 'LectureHall' && v.id !== lec1.id);

    const secA = await createOneSection(scheduleId, {
      courseId: c1.id, instructorId: instr.id, venueId: lec1.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    await createOneSection(scheduleId, {
      courseId: c2.id, instructorId: instr.id, venueId: lec2.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });

    const before = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r04 = (before.conflicts ?? []).find(c => c.ruleId === 'R-04' && c.sectionBId);
    const fix = r04.fixes[0];

    // Apply the fix — PUT /sections/:id with infoOnly + new instructorId.
    const upd = await request(app)
      .put(`/api/v1/sections/${fix.sectionId}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ instructorId: fix.instructorId, infoOnly: true });
    expect(upd.status).toBe(200);

    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r04After = (after.conflicts ?? []).filter(c => c.ruleId === 'R-04' && c.sectionBId);
    // The double-booking is gone since the two sections no longer share an instructor.
    expect(r04After.length).toBe(0);
  });

  test('R-04 fixes never propose an instructor who is also busy at the slot', async () => {
    const scheduleId = await freshTermSchedule('283');

    const [courses, instructors, venues] = await Promise.all([
      request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
    ]);
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const c2 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.id !== c1.id);
    const c3 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.id !== c1.id && c.id !== c2.id);
    const instrA = instructors[0];
    const instrB = instructors[1];
    const lec1 = venues.find(v => v.type === 'LectureHall');
    const lec2 = venues.find(v => v.type === 'LectureHall' && v.id !== lec1.id);
    const lec3 = venues.find(v => v.type === 'LectureHall' && v.id !== lec1.id && v.id !== lec2.id);

    // Force R-04: c1 + c2 both have instrA at 09:00 Sun.
    await createOneSection(scheduleId, {
      courseId: c1.id, instructorId: instrA.id, venueId: lec1.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    await createOneSection(scheduleId, {
      courseId: c2.id, instructorId: instrA.id, venueId: lec2.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    // Also c3 has instrB at the SAME slot — so instrB is now BUSY.
    // A proposal that suggests "reassign to instrB" would just create
    // another R-04. The fix computer must filter this out.
    await createOneSection(scheduleId, {
      courseId: c3.id, instructorId: instrB.id, venueId: lec3.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });

    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r04 = (conflicts.conflicts ?? []).find(c => c.ruleId === 'R-04' && c.sectionBId);
    expect(r04).toBeTruthy();
    // Fix proposals must NEVER include instrB (busy) or instrA (current).
    if (r04.fixes) {
      for (const fix of r04.fixes) {
        expect(fix.instructorId).not.toBe(instrA.id);
        expect(fix.instructorId).not.toBe(instrB.id);
      }
    }
  });
});

describe('FU-294: R-05 quick-fix (Phase 25)', () => {

  test('R-05 conflict carries `fixes` listing free same-type venues', async () => {
    const scheduleId = await freshTermSchedule('261');

    const [courses, instructors, venues] = await Promise.all([
      request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
    ]);
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const c2 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.id !== c1.id);
    const instrA = instructors[0];
    const instrB = instructors[1];
    const sharedLec = venues.find(v => v.type === 'LectureHall');

    // Two sections, different instructors, SAME venue + time → R-05.
    await createOneSection(scheduleId, {
      courseId: c1.id, instructorId: instrA.id, venueId: sharedLec.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    await createOneSection(scheduleId, {
      courseId: c2.id, instructorId: instrB.id, venueId: sharedLec.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });

    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r05 = (conflicts.conflicts ?? []).find(c => c.ruleId === 'R-05' && c.sectionBId);
    expect(r05).toBeTruthy();
    expect(Array.isArray(r05.fixes)).toBe(true);
    expect(r05.fixes.length).toBeGreaterThan(0);
    for (const fix of r05.fixes) {
      expect(fix.kind).toBe('reassign-venue');
      expect(typeof fix.venueId).toBe('string');
      expect(typeof fix.venueName).toBe('string');
      expect(fix.venueId).not.toBe(sharedLec.id);
      // The reassign target must be the same TYPE (LectureHall here) so
      // we don't introduce R-11/R-12 type-mismatch warnings.
      const proposedVenue = venues.find(v => v.id === fix.venueId);
      expect(proposedVenue.type).toBe('LectureHall');
    }
  });

  test('applying R-05 fix clears the conflict', async () => {
    const scheduleId = await freshTermSchedule('262');

    const [courses, instructors, venues] = await Promise.all([
      request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
    ]);
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const c2 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.id !== c1.id);
    const instrA = instructors[0];
    const instrB = instructors[1];
    const sharedLec = venues.find(v => v.type === 'LectureHall');

    await createOneSection(scheduleId, {
      courseId: c1.id, instructorId: instrA.id, venueId: sharedLec.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    await createOneSection(scheduleId, {
      courseId: c2.id, instructorId: instrB.id, venueId: sharedLec.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });

    const before = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r05 = (before.conflicts ?? []).find(c => c.ruleId === 'R-05' && c.sectionBId);
    const fix = r05.fixes[0];

    const upd = await request(app)
      .put(`/api/v1/sections/${fix.sectionId}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ venueId: fix.venueId, infoOnly: true });
    expect(upd.status).toBe(200);

    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r05After = (after.conflicts ?? []).filter(c => c.ruleId === 'R-05' && c.sectionBId);
    expect(r05After.length).toBe(0);
  });

  test('R-05 fixes never propose a venue of the wrong type', async () => {
    // A Lab section in a LectureHall would trigger R-11; a Lec section
    // in a Laboratory would trigger R-12. The fix computer must filter
    // candidates to the SAME type as the conflicting section.
    const scheduleId = await freshTermSchedule('263');

    const [courses, instructors, venues] = await Promise.all([
      request(app).get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/instructors').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
      request(app).get('/api/v1/venues').set('Authorization', `Bearer ${adminTok}`).then(r => r.body),
    ]);
    const c1 = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    const c2 = courses.find(c => Number(c.credits) === 3 && !c.has_lab && c.id !== c1.id);
    const instrA = instructors[0];
    const instrB = instructors[1];
    const lec = venues.find(v => v.type === 'LectureHall');

    await createOneSection(scheduleId, {
      courseId: c1.id, instructorId: instrA.id, venueId: lec.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });
    await createOneSection(scheduleId, {
      courseId: c2.id, instructorId: instrB.id, venueId: lec.id,
      sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'],
      startTime: '09:00', endTime: '09:50',
    });

    const conflicts = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/conflicts`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const r05 = (conflicts.conflicts ?? []).find(c => c.ruleId === 'R-05' && c.sectionBId);
    expect(r05).toBeTruthy();
    if (r05.fixes) {
      for (const fix of r05.fixes) {
        const proposedVenue = venues.find(v => v.id === fix.venueId);
        // Both sections are Lec, so all proposals must be LectureHall.
        expect(proposedVenue.type).toBe('LectureHall');
      }
    }
  });
});
