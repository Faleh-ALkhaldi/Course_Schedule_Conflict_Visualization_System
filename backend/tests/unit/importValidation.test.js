/**
 * audit-2 Phase-11 P2 — ExportService.commitRows must validate imported rows
 * through the same domain stack as createSection BEFORE its destructive DELETE.
 * This covers the pure validation module that does it (no DB).
 */
const { validateImportRows, deriveHasLabByCourse } = require('../../src/domain/importValidation');

describe('importValidation (audit-2 Phase-11 P2)', () => {
  test('deriveHasLabByCourse: a course with any Lab section ⇒ has lab', () => {
    const rows = [
      { courseCode: 'SWE211', sectionType: 'Lec', sectionNumber: '01' },
      { courseCode: 'SWE211', sectionType: 'Lab', sectionNumber: '50' },
      { courseCode: 'MATH101', sectionType: 'Lec', sectionNumber: '01' },
    ];
    const m = deriveHasLabByCourse(rows);
    expect(m.get('swe211')).toBe(true);
    expect(m.get('math101')).toBe(false);
  });

  test('clean Project rows produce no errors', () => {
    const rows = [
      { courseCode: 'SWE411', courseName: 'Senior Project', credits: 3, sectionType: 'Prj',
        sectionNumber: '01', days: ['Sunday'], startTime: '10:00', endTime: '10:50' },
    ];
    expect(validateImportRows(rows).errors).toEqual([]);
  });

  test('4-credit course with NO lab section is rejected (would import unschedulable)', () => {
    const rows = [
      { courseCode: 'SWE363', courseName: 'X', credits: 4, sectionType: 'Lec',
        sectionNumber: '01', days: ['Sunday', 'Tuesday', 'Thursday'], startTime: '08:00', endTime: '08:50' },
    ];
    const { errors } = validateImportRows(rows);
    expect(errors.some(e => /SWE363/.test(e) && /lab/i.test(e))).toBe(true);
  });

  test('a 4-credit course WITH a lab section is accepted (has_lab derived true)', () => {
    const rows = [
      // Project stand-in for the lecture half keeps the pattern check trivially valid;
      // the point is that the presence of a Lab flips has_lab so creditsFlagError clears.
      { courseCode: 'SWE211', courseName: 'X', credits: 4, sectionType: 'Prj',
        sectionNumber: '01', days: ['Sunday'], startTime: '10:00', endTime: '11:00' },
      { courseCode: 'SWE211', courseName: 'X', credits: 4, sectionType: 'Lab',
        sectionNumber: '50', days: ['Monday'], startTime: '10:00', endTime: '10:50' },
    ];
    const { errors, hasLabByCourse } = validateImportRows(rows);
    expect(hasLabByCourse.get('swe211')).toBe(true);
    expect(errors.some(e => /4-credit/i.test(e))).toBe(false);
  });

  test('out-of-range section number is rejected (Lab in the Lec band)', () => {
    const rows = [
      { courseCode: 'SWE211', courseName: 'X', credits: 1, sectionType: 'Lab',
        sectionNumber: '01', days: ['Sunday'], startTime: '10:00', endTime: '10:50' },
    ];
    const { errors } = validateImportRows(rows);
    expect(errors.some(e => /section number/i.test(e))).toBe(true);
  });

  test('invalid section type is rejected', () => {
    const rows = [
      { courseCode: 'SWE211', courseName: 'X', credits: 3, sectionType: 'Foo',
        sectionNumber: '01', days: ['Sunday'], startTime: '10:00', endTime: '10:50' },
    ];
    const { errors } = validateImportRows(rows);
    expect(errors.some(e => /invalid section type/i.test(e))).toBe(true);
  });
});
