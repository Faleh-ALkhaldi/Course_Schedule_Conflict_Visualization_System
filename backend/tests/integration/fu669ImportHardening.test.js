// NEW-FU-669 — whole-term REPLACE is a FAITHFUL replace (DB-backed, fresh test DB). Uses
// fully-constructed minimal files (one controlled instructor each) so the assertions don't
// depend on seed-data specifics:
//   • importing a DIFFERENT whole-term file PRUNES the previous file's instructor (no orphan
//     lingering in the dropdown / re-exports). Safe because the wanted set = the file's section
//     rows + its (complete) Instructors reference sheet, so a faithful round-trip prunes nothing.
//   • a whole-term commit with NO office hours CLEARS the term's existing OH (was gated on
//     length → left stale OH orphaned).
const request   = require('supertest');
const ExcelJS   = require('exceljs');
const app       = require('../../src/app');
const exportSvc = require('../../src/services/ExportService');
const { query } = require('../../src/config/db');

const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);
const HEADERS = ['Course Code', 'Course Name', 'Academic Level', 'Category', 'Credits', 'Course Type',
                 'Section #', 'Section Type', 'Gender', 'Days', 'Start Time', 'End Time',
                 'Duration (min)', 'Instructor', 'Venue', 'Venue Type'];

let tok;
beforeAll(async () => {
  tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token;
});
const schedules = async () => (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body;
const makeTerm  = async (code) => {
  await A(request(app).post(`${B}/terms`), tok).send({ code, seedMode: 'blank' });
  return (await schedules()).find(s => s.semester === code);
};

// A conflict-free single-section whole-term file for `instr` (3-cr UG lecture, Sun/Tue/Thu
// 08:00–08:50, lecture-hall venue). `withOH` adds a non-overlapping Monday office hour (R-13).
async function buildParsed(instr, withOH) {
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet('Sections');
  s.addRow(HEADERS);
  s.addRow(['SWE 211', 'Software Engineering 1', 'Sophomore', 'Undergraduate', 3, 'Standard',
            '01', 'Lecture', 'Male', 'Sunday, Tuesday, Thursday', '08:00', '08:50',
            50, instr, '99-001', 'Lecture Hall']);
  if (withOH) {
    const oh = w.addWorksheet('OfficeHours');
    oh.addRow(['Instructor', 'Day', 'Start Time', 'End Time']);
    oh.addRow([instr, 'Monday', '10:00', '11:00']);
  }
  return exportSvc.parseRows(Buffer.from(await w.xlsx.writeBuffer()), 'xlsx');
}
const commit = (p, sid, oh) => exportSvc.commitRows(p.rows, sid, oh ?? p.officeHours, p.instructors, p.venues);
const instrNames = async (code) =>
  (await query(`SELECT name FROM instructors WHERE owner_semester=$1 ORDER BY name`, [code])).rows.map(r => r.name);

describe('FU-669 — faithful whole-term REPLACE', () => {
  test('importing a DIFFERENT file prunes the previous file\'s instructor (no orphans)', async () => {
    const tgt = await makeTerm('343');
    await commit(await buildParsed('ALPHA ONE', true), tgt.id);
    expect(await instrNames('343')).toEqual(['ALPHA ONE']);
    await commit(await buildParsed('BETA TWO', true), tgt.id);
    expect(await instrNames('343')).toEqual(['BETA TWO']);   // ALPHA ONE pruned, not accumulated
  });

  test('a faithful re-import of the SAME file prunes nothing (no false drop)', async () => {
    const tgt = await makeTerm('342');
    const p = await buildParsed('GAMMA THREE', true);
    await commit(p, tgt.id); expect(await instrNames('342')).toEqual(['GAMMA THREE']);
    await commit(p, tgt.id); expect(await instrNames('342')).toEqual(['GAMMA THREE']);   // still there
  });

  test('a commit with NO office hours clears the term\'s existing OH (no stale orphans)', async () => {
    const tgt = await makeTerm('332');
    const ohCount = async () => (await query(
      `SELECT COUNT(*)::int c FROM office_hours oh JOIN instructors i ON i.id=oh.instructor_id WHERE i.owner_semester='332'`)).rows[0].c;
    const p = await buildParsed('DELTA FOUR', true);
    await commit(p, tgt.id);         expect(await ohCount()).toBe(1);   // OH present
    await commit(p, tgt.id, []);     expect(await ohCount()).toBe(0);   // empty-OH commit ⇒ cleared, not orphaned
  });
});
