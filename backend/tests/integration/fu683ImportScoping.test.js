// NEW-FU-683 — live import-flow regressions reported from the browser:
//   • After a scoped instructor import, the sidebar showed ~9 duplicate "AHMED AL-NAZER" + duplicate
//     venues. ROOT CAUSE was a FRONTEND call (ExportModal reloaded the reference lists with a bare
//     loadReference() — no term — so when the URL lacked ?term= the backend returned the WHOLE catalog,
//     every term's owned copy). The backend contract these tests pin: an entity list is term-scoped
//     whenever a term context is supplied, and the import itself creates NO duplicate rows. (The frontend
//     fix passes the term; these guard the contract it relies on.)
//   • A has_lab course imported LECTURE-ONLY must keep has_lab (from the "Course Type" column) so the
//     100-min lecture raises no false R-15; a Fix-A export that carries the complement Lab re-imports to
//     a COMPLETE course with no R-14/R-15.
const request   = require('supertest');
const app       = require('../../src/app');
const exportSvc = require('../../src/services/ExportService');
const { query } = require('../../src/config/db');

const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);
let tok;
beforeAll(async () => { tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token; });
const wipe = async (code) => {
  await query(`DELETE FROM office_hours WHERE instructor_id IN (SELECT id FROM instructors WHERE owner_semester=$1)`, [code]);
  await query(`DELETE FROM schedules WHERE department_id='SWE-DEPT' AND semester=$1`, [code]);
  for (const t of ['courses', 'instructors', 'venues']) await query(`DELETE FROM ${t} WHERE owner_semester=$1`, [code]);
};

describe('FU-683 — entity lists stay term-scoped after a scoped import (no cross-term leak / no dup rows)', () => {
  test('a scoped instructor import creates only the term\'s own + complement entities, and /instructors is scoped', async () => {
    // An instructor in 252 who teaches the LECTURE of a has_lab course whose LAB is taught by someone else.
    const row = (await query(`
      SELECT se.instructor_id, c.course_code
        FROM sections se JOIN courses c ON c.id=se.course_id JOIN schedules s ON s.id=se.schedule_id
       WHERE s.semester='252' AND c.has_lab=true AND se.section_type='Lec' AND se.instructor_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM sections lb WHERE lb.schedule_id=se.schedule_id AND lb.course_id=se.course_id
                       AND lb.section_type='Lab' AND lb.instructor_id IS DISTINCT FROM se.instructor_id)
       LIMIT 1`)).rows[0];
    expect(row).toBeTruthy();
    const sid252 = (await query(`SELECT id FROM schedules WHERE department_id='SWE-DEPT' AND semester='252'`)).rows[0].id;
    const { workbook } = await exportSvc.buildExport(sid252, { type: 'instructor', id: row.instructor_id }, '252', 'xlsx');
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());

    await A(request(app).post(`${B}/terms`), tok).send({ code: '331', seedMode: 'blank' });
    const sid331 = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === '331').id;
    expect((await A(request(app).post(`${B}/schedules/${sid331}/import`), tok).attach('file', buf, 'instr.xlsx')).status).toBe(200);

    // NO duplicate instructor/venue rows were created in the term.
    const dupInstr = (await query(`SELECT name FROM instructors WHERE owner_semester='331' GROUP BY name HAVING count(*)>1`)).rows;
    const dupVenue = (await query(`SELECT name FROM venues      WHERE owner_semester='331' GROUP BY name HAVING count(*)>1`)).rows;
    expect(dupInstr).toEqual([]);
    expect(dupVenue).toEqual([]);

    // The contract the fixed frontend relies on: a term-scoped list returns ONLY this term's entities
    // (a handful), NEVER the whole multi-term catalog. A bare unscoped call would return the catalog —
    // that is exactly the leak the ExportModal fix avoids by passing the term.
    const scoped = (await A(request(app).get(`${B}/instructors`).set('X-Active-Term', '331'), tok)).body;
    const catalog = (await A(request(app).get(`${B}/instructors`), tok)).body;            // no term context → whole catalog
    expect(scoped.length).toBeLessThan(catalog.length);
    const names = scoped.map(i => i.name);
    expect(names.length).toBe(new Set(names).size);                                       // no duplicate names in the scoped list

    await wipe('331');
  });
});

describe('FU-683 — a has_lab course imports complete / keeps has_lab, with no false R-15', () => {
  test('lecture-only import keeps has_lab (no R-15); complement-carrying import is complete (no R-14/R-15)', async () => {
    const row = (await query(`
      SELECT se.instructor_id, c.course_code
        FROM sections se JOIN courses c ON c.id=se.course_id JOIN schedules s ON s.id=se.schedule_id
       WHERE s.semester='252' AND c.has_lab=true AND se.section_type='Lec' AND se.instructor_id IS NOT NULL LIMIT 1`)).rows[0];
    const sid252 = (await query(`SELECT id FROM schedules WHERE department_id='SWE-DEPT' AND semester='252'`)).rows[0].id;
    const { workbook } = await exportSvc.buildExport(sid252, { type: 'instructor', id: row.instructor_id }, '252', 'xlsx');
    const fullBuf = Buffer.from(await workbook.xlsx.writeBuffer());

    // (a) complement-carrying file → COMPLETE course, no R-14/R-15.
    await A(request(app).post(`${B}/terms`), tok).send({ code: '341', seedMode: 'blank' });
    const sid341 = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === '341').id;
    await A(request(app).post(`${B}/schedules/${sid341}/import`), tok).attach('file', fullBuf, 'f.xlsx');
    const course341 = (await query(`SELECT id, has_lab FROM courses WHERE owner_semester='341' AND course_code=$1`, [row.course_code])).rows[0];
    expect(course341.has_lab).toBe(true);
    const types341 = (await query(`SELECT DISTINCT section_type FROM sections WHERE schedule_id=$1 AND course_id=$2`, [sid341, course341.id])).rows.map(r => r.section_type);
    expect(types341).toEqual(expect.arrayContaining(['Lec', 'Lab']));
    const bad341 = (await query(`SELECT rule_id FROM conflicts WHERE schedule_id=$1 AND rule_id IN ('R-14','R-15')
      AND section_a_id IN (SELECT id FROM sections WHERE schedule_id=$1 AND course_id=$2)`, [sid341, course341.id])).rows;
    expect(bad341.length).toBe(0);

    // (b) a genuinely lecture-only file (Lab rows stripped) still keeps has_lab via the Course Type column,
    //     so the 100-min lecture raises NO R-15.
    const wb = new (require('exceljs').Workbook)();
    await wb.xlsx.load(fullBuf);
    const ws = wb.getWorksheet('Sections');
    const hdr = ws.getRow(1).values.map(v => String(v).toLowerCase());
    const tcol = hdr.indexOf('section type');
    for (let n = ws.rowCount; n >= 2; n--) if (String(ws.getRow(n).getCell(tcol).value).toLowerCase().includes('lab')) ws.spliceRows(n, 1);
    const lecBuf = Buffer.from(await wb.xlsx.writeBuffer());

    await A(request(app).post(`${B}/terms`), tok).send({ code: '343', seedMode: 'blank' });
    const sid343 = (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === '343').id;
    await A(request(app).post(`${B}/schedules/${sid343}/import`), tok).attach('file', lecBuf, 'lec.xlsx');
    const course343 = (await query(`SELECT has_lab FROM courses WHERE owner_semester='343' AND course_code=$1`, [row.course_code])).rows[0];
    expect(course343.has_lab).toBe(true);                          // preserved from "Has Laboratory" Course Type
    const r15 = (await query(`SELECT 1 FROM conflicts WHERE schedule_id=$1 AND rule_id='R-15'`, [sid343])).rows;
    expect(r15.length).toBe(0);                                    // 100-min has_lab lecture is fine — no false R-15

    await wipe('341'); await wipe('343');
  });
});
