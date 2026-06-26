// NEW-FU-672 — whole-term REPLACE must prune orphan instructors + venues even for an
// ALL-ANONYMOUS file: every section's Instructor/Venue cell blank AND no
// Instructors/Venues/OfficeHours reference sheets. FU-669/670 gated the two prune
// DELETEs on `wantInstr.length` / `wantVenue.length`, so an anonymous file (empty
// want-lists) skipped BOTH DELETEs and the PREVIOUS import's instructors + venues
// survived as orphans — they then leaked into re-export reference sheets and the
// assignment dropdowns. The office-hours DELETE was already unconditional (FU-669),
// so this closes the matching gap for instructors + venues.
//
// Uses constructed minimal files (one controlled instructor + venue) so the
// assertions don't depend on seed specifics. Scratch terms 341/342 (isolated _test DB;
// within the 251–343 creatable range, not part of the seed set).
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

// One section. Blank `instr`/`venue` → an "anonymous" row; an anonymous file also carries
// NO Instructors/Venues/OfficeHours reference sheets (only the Sections sheet).
async function buildParsed(instr, venue) {
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet('Sections');
  s.addRow(HEADERS);
  s.addRow(['SWE 211', 'Software Engineering 1', 'Sophomore', 'Undergraduate', 3, 'Standard',
            '01', 'Lecture', 'Male', 'Sunday, Tuesday, Thursday', '08:00', '08:50',
            50, instr, venue, instr || venue ? 'LectureHall' : '']);
  if (instr) {                                  // the anonymous file deliberately omits the OH sheet
    const oh = w.addWorksheet('OfficeHours');
    oh.addRow(['Instructor', 'Day', 'Start Time', 'End Time']);
    oh.addRow([instr, 'Monday', '10:00', '11:00']);
  }
  return exportSvc.parseRows(Buffer.from(await w.xlsx.writeBuffer()), 'xlsx');
}
const commit  = (p, sid) => exportSvc.commitRows(p.rows, sid, p.officeHours, p.instructors, p.venues);
const namesOf = async (tbl, code) =>
  (await query(`SELECT name FROM ${tbl} WHERE owner_semester=$1 ORDER BY name`, [code])).rows.map(r => r.name);

describe('FU-672 — whole-term REPLACE prunes orphans even for an all-anonymous file', () => {
  test('anonymous re-import (blank instructor + venue, no ref sheets) leaves 0 orphan instructors/venues', async () => {
    const tgt = await makeTerm('341');
    // 1) Populate: a file that DOES reference an instructor + a venue.
    await commit(await buildParsed('ALPHA ONE', '11-001'), tgt.id);
    expect(await namesOf('instructors', '341')).toEqual(['ALPHA ONE']);
    expect(await namesOf('venues',      '341')).toEqual(['11-001']);
    // 2) Re-import the SAME term anonymously: every Instructor/Venue cell blank, no ref sheets.
    await commit(await buildParsed('', ''), tgt.id);
    expect(await namesOf('instructors', '341')).toEqual([]);   // ALPHA ONE pruned, not orphaned
    expect(await namesOf('venues',      '341')).toEqual([]);   // 11-001  pruned, not orphaned
  });

  test('the anonymous replace prunes ONLY instructors + venues — the term\'s course survives', async () => {
    const tgt = await makeTerm('342');
    await commit(await buildParsed('BETA TWO', '22-002'), tgt.id);
    await commit(await buildParsed('', ''), tgt.id);
    expect(await namesOf('instructors', '342')).toEqual([]);
    expect(await namesOf('venues',      '342')).toEqual([]);
    const courses = (await query(`SELECT course_code FROM courses WHERE owner_semester=$1`, ['342'])).rows;
    expect(courses.length).toBeGreaterThan(0);                 // courses are NOT pruned by a REPLACE
  });
});
