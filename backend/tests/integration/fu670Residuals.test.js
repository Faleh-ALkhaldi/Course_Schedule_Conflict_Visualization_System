// NEW-FU-670 — whole-term REPLACE now also prunes orphan VENUES (FU-669 pruned only
// instructors). Safe because the Venues reference sheet is now complete (fetchVenuesRef full
// = every owner-term venue), so a faithful round-trip prunes nothing. Uses constructed minimal
// files (controlled instructor + venue) so the assertions don't depend on seed specifics.
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
async function buildParsed(instr, venue) {
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet('Sections');
  s.addRow(HEADERS);
  s.addRow(['SWE 211', 'Software Engineering 1', 'Sophomore', 'Undergraduate', 3, 'Standard',
            '01', 'Lecture', 'Male', 'Sunday, Tuesday, Thursday', '08:00', '08:50',
            50, instr, venue, 'Lecture Hall']);
  const oh = w.addWorksheet('OfficeHours');
  oh.addRow(['Instructor', 'Day', 'Start Time', 'End Time']);
  oh.addRow([instr, 'Monday', '10:00', '11:00']);
  return exportSvc.parseRows(Buffer.from(await w.xlsx.writeBuffer()), 'xlsx');
}
const commit = (p, sid) => exportSvc.commitRows(p.rows, sid, p.officeHours, p.instructors, p.venues);
const venueNames = async (code) =>
  (await query(`SELECT name FROM venues WHERE owner_semester=$1 ORDER BY name`, [code])).rows.map(r => r.name);

describe('FU-670 — whole-term REPLACE prunes orphan venues', () => {
  test('importing a DIFFERENT file prunes the previous file\'s venue (no orphans)', async () => {
    const tgt = await makeTerm('321');
    await commit(await buildParsed('ALPHA ONE', '11-001'), tgt.id);
    expect(await venueNames('321')).toEqual(['11-001']);
    await commit(await buildParsed('BETA TWO', '22-002'), tgt.id);
    expect(await venueNames('321')).toEqual(['22-002']);   // 11-001 pruned, not accumulated
  });

  test('a faithful re-import of the SAME file prunes no venue (no false drop)', async () => {
    const tgt = await makeTerm('322');
    const p = await buildParsed('GAMMA THREE', '33-003');
    await commit(p, tgt.id); expect(await venueNames('322')).toEqual(['33-003']);
    await commit(p, tgt.id); expect(await venueNames('322')).toEqual(['33-003']);   // still there
  });
});
