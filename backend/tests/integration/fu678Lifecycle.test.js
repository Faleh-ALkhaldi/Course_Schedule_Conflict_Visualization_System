// NEW-FU-678 (re-audit round 7) — peripheral-engine fixes:
//   • Finalize/archive lock now covers renameTerm + deleteTerm (a finalized/archived term — incl. the
//     protected published 251/252 — could be renamed/deleted outright; every other path was locked).
//   • A pure time-move (PUT /sections/:id with only {day,startTime,endTime}) no longer NULLs the
//     section's instructor+venue (assignSection now COALESCEs the omitted fields).
const request   = require('supertest');
const app       = require('../../src/app');
const exportSvc = require('../../src/services/ExportService');
const { query } = require('../../src/config/db');

const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);
let tok;
beforeAll(async () => { tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token; });
const schedules = async () => (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body;
const wipe = async (code) => {
  await query(`DELETE FROM office_hours WHERE instructor_id IN (SELECT id FROM instructors WHERE owner_semester=$1)`, [code]);
  await query(`DELETE FROM schedules WHERE department_id='SWE-DEPT' AND semester=$1`, [code]);
  for (const t of ['courses', 'instructors', 'venues']) await query(`DELETE FROM ${t} WHERE owner_semester=$1`, [code]);
};

describe('FU-678 — term-lifecycle finalize/archive lock covers rename + delete', () => {
  test('a FINALIZED term cannot be renamed or deleted (must unfinalize first)', async () => {
    await A(request(app).post(`${B}/terms`), tok).send({ code: '311', seedMode: 'blank' });
    await A(request(app).patch(`${B}/terms/311/status`), tok).send({ status: 'Finalized' });
    expect((await A(request(app).patch(`${B}/terms/311`), tok).send({ newCode: '313' })).status).toBe(409);
    expect((await A(request(app).delete(`${B}/terms/311`), tok)).status).toBe(409);
    await A(request(app).patch(`${B}/terms/311/status`), tok).send({ status: 'Draft' });   // escape hatch
    expect((await A(request(app).delete(`${B}/terms/311`), tok)).status).toBe(200);
  });
  test('an ARCHIVED term cannot be renamed or deleted (must unarchive first)', async () => {
    await A(request(app).post(`${B}/terms`), tok).send({ code: '312', seedMode: 'blank' });
    await A(request(app).patch(`${B}/terms/312/archive`), tok).send({});
    expect((await A(request(app).patch(`${B}/terms/312`), tok).send({ newCode: '313' })).status).toBe(409);
    expect((await A(request(app).delete(`${B}/terms/312`), tok)).status).toBe(409);
    await A(request(app).patch(`${B}/terms/312/unarchive`), tok).send({});
    expect((await A(request(app).delete(`${B}/terms/312`), tok)).status).toBe(200);
  });
});

describe('FU-678 — pure time-move preserves the section instructor + venue', () => {
  test('a {day,startTime,endTime}-only update keeps instructor_id + venue_id (COALESCE, not NULL)', async () => {
    const src = (await schedules()).find(s => s.semester === '252');
    await A(request(app).post(`${B}/terms`), tok).send({ code: '313', seedMode: 'blank' });
    const tgt = (await schedules()).find(s => s.semester === '313');
    const ex = await exportSvc.buildExport(src.id, { type: 'full' }, '252', 'xlsx');
    const p = await exportSvc.parseRows(Buffer.from(await ex.workbook.xlsx.writeBuffer()), 'xlsx');
    await exportSvc.commitRows(p.rows, tgt.id, p.officeHours, p.instructors, p.venues);

    const sec = (await query(
      `SELECT id, instructor_id, venue_id, day, start_time::text st, end_time::text et
         FROM sections WHERE schedule_id=$1 AND instructor_id IS NOT NULL AND venue_id IS NOT NULL LIMIT 1`, [tgt.id])).rows[0];
    expect(sec.instructor_id).toBeTruthy();

    // Pure time-move: re-send the SAME day/time but OMIT instructorId/venueId (the minimal payload).
    const r = await A(request(app).put(`${B}/sections/${sec.id}`), tok)
      .send({ day: sec.day, startTime: sec.st.slice(0, 5), endTime: sec.et.slice(0, 5) });
    expect(r.status).toBe(200);

    const after = (await query(`SELECT instructor_id, venue_id FROM sections WHERE id=$1`, [sec.id])).rows[0];
    expect(after.instructor_id).toBe(sec.instructor_id);   // PRESERVED (pre-FU-678 this became NULL)
    expect(after.venue_id).toBe(sec.venue_id);

    await wipe('313');
  });
});
