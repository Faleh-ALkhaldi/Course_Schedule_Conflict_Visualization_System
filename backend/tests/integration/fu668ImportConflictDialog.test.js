// NEW-FU-668: EVERY acceptable import must DETECT conflicts before committing and offer
// the proceed / cancel / fix dialog — the scoped-merge behaviour, now generalized to the
// whole-term REPLACE path. Locked here, end-to-end over HTTP against the fresh test DB:
//   • PREVIEW (no mode) on a conflicting whole-term file → 200 + needsDecision (scope:full)
//     + a conflict count, and NOTHING is persisted (the target term is untouched → "Cancel"
//     is simply never committing).
//   • FIX AND IMPORT (?mode=conflict-free) → commits, runs the resolver, reports what it
//     changed, and the remaining conflict count is lower than before.
//   • PROCEED (?mode=with-conflicts) → commits the file exactly as-is, conflicts kept.
const request   = require('supertest');
const ExcelJS   = require('exceljs');
const app       = require('../../src/app');
const exportSvc = require('../../src/services/ExportService');
const { query } = require('../../src/config/db');

const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let tok;
beforeAll(async () => {
  tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token;
});

const schedules = async () => (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body;
const secCount  = async (id) => (await query(`SELECT COUNT(*)::int c FROM sections WHERE schedule_id=$1`, [id])).rows[0].c;

// Build a whole-term xlsx that DEFINITELY contains a conflict: export a populated seed term,
// then point the 2nd section row at the 1st row's instructor + day + time (an R-01 clash).
async function conflictingWholeTermBuffer(scheduleId, semester) {
  const { workbook } = await exportSvc.buildExport(scheduleId, { type: 'full' }, semester, 'xlsx');
  const ws = workbook.getWorksheet('Sections');
  const col = {};
  ws.getRow(1).eachCell((c, n) => { col[String(c.value).trim()] = n; });
  const r2 = ws.getRow(2), r3 = ws.getRow(3);
  for (const h of ['Instructor', 'Days', 'Start Time', 'End Time']) {
    r3.getCell(col[h]).value = r2.getCell(col[h]).value;
  }
  r3.commit();
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function makeTerm(code, seedMode = 'blank') {
  // Default to a BLANK target so a copy-seeded term's pre-existing office hours can't
  // intermittently clash with the imported class (made the conflict-free case flaky).
  await A(request(app).post(`${B}/terms`), tok).send({ code, seedMode });
  return (await schedules()).find(s => s.semester === code);
}

describe('FU-668 — whole-term import conflict dialog', () => {
  test('PREVIEW detects conflicts without committing (cancel-safe), then FIX resolves them', async () => {
    const src = (await schedules()).find(s => s.semester === '252');
    const buf = await conflictingWholeTermBuffer(src.id, '252');
    const tgt = await makeTerm('313');
    const before = await secCount(tgt.id);

    // (1) PREVIEW — no mode. needsDecision + scope:full + a count, and 0 DB change.
    const pv = await A(request(app).post(`${B}/schedules/${tgt.id}/import`), tok)
      .attach('file', buf, { filename: 's.xlsx', contentType: XLSX_MIME });
    expect(pv.status).toBe(200);
    expect(pv.body.needsDecision).toBe(true);
    expect(pv.body.scope).toBe('full');
    expect(pv.body.conflictCount).toBeGreaterThan(0);
    expect(pv.body.hardCount + pv.body.softCount).toBe(pv.body.conflictCount);
    expect(await secCount(tgt.id)).toBe(before);   // nothing persisted

    // (2) FIX AND IMPORT — commits, resolves, reports.
    const fx = await A(request(app).post(`${B}/schedules/${tgt.id}/import?mode=conflict-free`), tok)
      .attach('file', buf, { filename: 's.xlsx', contentType: XLSX_MIME });
    expect(fx.status).toBe(200);
    expect(fx.body.created).toBeGreaterThan(0);          // it committed
    expect(fx.body.fix).toBeTruthy();                     // resolver summary present
    const resolved  = (fx.body.fix.resolvedHard || 0) + (fx.body.fix.resolvedSoft || 0);
    const initial   = (fx.body.fix.initialHard  || 0) + (fx.body.fix.initialSoft  || 0);
    const remaining = (fx.body.fix.remainingHard || 0) + (fx.body.fix.remainingSoft || 0);
    expect(resolved).toBeGreaterThan(0);                  // at least one conflict fixed
    expect(remaining).toBeLessThan(initial);              // fewer than before the fix
  });

  test('PROCEED (with-conflicts) commits the file as-is, conflicts kept', async () => {
    const src = (await schedules()).find(s => s.semester === '252');
    const buf = await conflictingWholeTermBuffer(src.id, '252');
    const tgt = await makeTerm('323');

    const wc = await A(request(app).post(`${B}/schedules/${tgt.id}/import?mode=with-conflicts`), tok)
      .attach('file', buf, { filename: 's.xlsx', contentType: XLSX_MIME });
    expect(wc.status).toBe(200);
    expect(wc.body.created).toBeGreaterThan(0);
    expect((wc.body.conflicts?.conflicts || []).length).toBeGreaterThan(0);   // kept, not fixed
  });

  test('re-importing the same whole-term file is IDEMPOTENT — no duplicate entities (Issue 1)', async () => {
    const src = (await schedules()).find(s => s.semester === '252');
    const { workbook } = await exportSvc.buildExport(src.id, { type: 'full' }, '252', 'xlsx');
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    const tgt = await makeTerm('333');
    const counts = async () => (await query(`SELECT
        (SELECT COUNT(*)::int FROM instructors WHERE owner_semester='333') i,
        (SELECT COUNT(*)::int FROM courses     WHERE owner_semester='333') c,
        (SELECT COUNT(*)::int FROM venues      WHERE owner_semester='333') v,
        (SELECT COUNT(DISTINCT name)        ::int FROM instructors WHERE owner_semester='333') di,
        (SELECT COUNT(DISTINCT course_code) ::int FROM courses     WHERE owner_semester='333') dc,
        (SELECT COUNT(DISTINCT name)        ::int FROM venues      WHERE owner_semester='333') dv`)).rows[0];

    // 252 carries (soft) conflicts → import with-conflicts so it commits past the dialog.
    const imp = () => A(request(app).post(`${B}/schedules/${tgt.id}/import?mode=with-conflicts`), tok)
      .attach('file', buf, { filename: 's.xlsx', contentType: XLSX_MIME });
    await imp(); const a = await counts();
    await imp(); const b = await counts();

    // (a) the second import grows nothing, and (b) every entity count equals its DISTINCT-name
    // count — so the importer reuses by name and never piles up duplicate instructors/courses/venues.
    expect(b).toEqual(a);
    expect(b.i).toBe(b.di);
    expect(b.c).toBe(b.dc);
    expect(b.v).toBe(b.dv);
  });

  test('a CONFLICT-FREE whole-term file imports straight through (no dialog)', async () => {
    // Seed terms (and even individual seed courses) carry soft conflicts, so we don't derive the
    // clean file from seed data. Build a minimal whole-term file from scratch with ONE fully
    // controlled, self-consistent section: a 3-credit UG Standard lecture, Sun/Tue/Thu 08:00–08:50
    // (3×50 = 150 min coverage), its own instructor + lecture-hall venue, no office hours. Nothing
    // can clash → it must import with NO needsDecision dialog. (No Meta sheet ⇒ scope defaults full.)
    const w = new ExcelJS.Workbook();
    const s = w.addWorksheet('Sections');
    s.addRow(['Course Code', 'Course Name', 'Academic Level', 'Category', 'Credits', 'Course Type',
              'Section #', 'Section Type', 'Gender', 'Days', 'Start Time', 'End Time',
              'Duration (min)', 'Instructor', 'Venue', 'Venue Type']);
    s.addRow(['SWE 211', 'Software Engineering 1', 'Sophomore', 'Undergraduate', 3, 'Standard',
              '01', 'Lecture', 'Male', 'Sunday, Tuesday, Thursday', '08:00', '08:50',
              50, 'CLEAN TEST INSTRUCTOR', '99-001', 'Lecture Hall']);
    // R-13: a teaching instructor needs ≥1 office hour. Put it on Monday (the instructor doesn't
    // teach Mon ⇒ no R-04 class overlap), inside the 08:00–16:00 office-hours window.
    const oh = w.addWorksheet('OfficeHours');
    oh.addRow(['Instructor', 'Day', 'Start Time', 'End Time']);
    oh.addRow(['CLEAN TEST INSTRUCTOR', 'Monday', '10:00', '11:00']);
    const buf = Buffer.from(await w.xlsx.writeBuffer());

    const tgt = await makeTerm('331');
    const r = await A(request(app).post(`${B}/schedules/${tgt.id}/import`), tok)
      .attach('file', buf, { filename: 's.xlsx', contentType: XLSX_MIME });
    expect(r.status).toBe(200);
    expect(r.body.needsDecision).toBeFalsy();      // no dialog for a conflict-free file
    expect(r.body.created).toBeGreaterThan(0);
  });
});
