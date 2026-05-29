// NEW-FU-305: Integration test for Phase 27's true section-group delete.
//
// Phase 27 changed deleteSection (default scope) to match purely by
// (scheduleId, courseId, sectionNumber) — no longer by day-group + time.
// The user-facing "delete entire section" action (side panel ✕) needs
// to match the SidePanel's groupSections semantic, which groups by
// (courseId, sectionNumber) alone. Previously, when a section group's
// rows had different times per day (rare but possible after manual
// edits), only the matching-time row would be deleted.
//
// This test creates a section group with different times per day and
// confirms the broader query catches all rows.

const request = require('supertest');
const app     = require('../../src/app');
const { getClient } = require('../../src/config/db');

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
  // Wipe auto-cloned sections.
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

describe('FU-305: side-panel ✕ deletes entire section group (Phase 27)', () => {

  test('STT pattern with same times across days: all 3 rows deleted', async () => {
    const scheduleId = await freshTermSchedule('281');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50 }] });

    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const groupBefore = (sx.sections || sx).filter(s => s.courseId === c.id);
    expect(groupBefore.length).toBe(3); // Sun/Tue/Thu

    // Delete using the side-panel path (default scope, no ?scope param).
    const dr = await request(app)
      .delete(`/api/v1/sections/${groupBefore[0].id}`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(dr.status).toBe(200);
    expect(dr.body.deletedIds.length).toBe(3); // All 3 rows of the group

    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const groupAfter = (after.sections || after).filter(s => s.courseId === c.id);
    expect(groupAfter.length).toBe(0);
  });

  // The regression we're guarding: pre-Phase-27 deleteSection filtered
  // by time. If a section group had different times per day (rare, but
  // possible after manual edits), only the matching-time row would
  // be deleted, leaving the others orphaned. The SidePanel's groupSections
  // shows ONE entry per (courseId, sectionNumber) regardless of time,
  // so the user saw "click ✕, only one card disappears".
  test('section group with DIFFERENT times per day: still all rows deleted', async () => {
    const scheduleId = await freshTermSchedule('282');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);

    // Seed an STT group first.
    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50 }] });

    // Force divergent times by directly UPDATEing one row's time. This
    // simulates the rare manual-edit scenario the pre-Phase-27 code
    // mishandled.
    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const groupBefore = (sx.sections || sx).filter(s => s.courseId === c.id);
    expect(groupBefore.length).toBe(3);
    const thuRow = groupBefore.find(s => s.day === 'Thursday');

    // Use a transactional client to UPDATE the time on one row. The
    // service-layer assignSection would move all siblings together;
    // raw UPDATE skips that, producing the divergent-time state.
    const client = await getClient();
    try {
      await client.query(
        `UPDATE sections SET start_time = $1, end_time = $2 WHERE id = $3`,
        ['11:00', '11:50', thuRow.id]
      );
    } finally {
      client.release();
    }

    // Side-panel ✕ click → delete the Sun row (representativeId).
    const sunRow = groupBefore.find(s => s.day === 'Sunday');
    const dr = await request(app)
      .delete(`/api/v1/sections/${sunRow.id}`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(dr.status).toBe(200);
    // Phase 27 fix: should delete ALL 3 rows even though Thursday has
    // a different time. Pre-Phase-27 would have deleted only 2 (Sun + Tue).
    expect(dr.body.deletedIds.length).toBe(3);

    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const groupAfter = (after.sections || after).filter(s => s.courseId === c.id);
    expect(groupAfter.length).toBe(0);
  });

  test('per-day delete (?scope=row) still removes only ONE row', async () => {
    // Sanity: the new broader group-by-section query for default scope
    // doesn't affect ?scope=row behavior. The grid-block ✕ must keep
    // removing only the targeted day.
    const scheduleId = await freshTermSchedule('283');

    const courses = (await request(app)
      .get('/api/v1/courses').set('Authorization', `Bearer ${adminTok}`)
    ).body;
    const c = courses.find(c => Number(c.credits) === 3 && !c.has_lab);
    await request(app)
      .post(`/api/v1/schedules/${scheduleId}/suggest`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ courseConfigs: [{ courseId: c.id, sections: 1, dayPattern: 'STT', duration: 50 }] });

    const sx = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const tueRow = (sx.sections || sx).find(s => s.courseId === c.id && s.day === 'Tuesday');

    const dr = await request(app)
      .delete(`/api/v1/sections/${tueRow.id}?scope=row`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(dr.status).toBe(200);
    expect(dr.body.deletedIds.length).toBe(1);

    const after = (await request(app)
      .get(`/api/v1/schedules/${scheduleId}/sections`)
      .set('Authorization', `Bearer ${adminTok}`)).body;
    const surviving = (after.sections || after).filter(s => s.courseId === c.id);
    expect(surviving.length).toBe(2);
    expect(new Set(surviving.map(s => s.day))).toEqual(new Set(['Sunday', 'Thursday']));
  });
});
