/**
 * Batch 22 (FU-576) — a course's NUMBER fixes its academic level/category
 * (100–199 Freshman … 500–699 Graduate). The frontend blocks Save on a mismatch;
 * courseCodeLevelError is the backend backstop. Also covers the 599→699 range bump
 * (graduate runs to 699, e.g. SWE 610 Thesis).
 */
const { courseCodeLevelError, levelForCourseNumber, courseCodeError } = require('../../src/domain/courseFormat');

describe('courseCodeLevelError (Batch 22 / FU-576)', () => {
  test('levelForCourseNumber maps each range to the right level/category', () => {
    expect(levelForCourseNumber(101)).toEqual({ category: 'UG', level: 'Freshman' });
    expect(levelForCourseNumber(206)).toEqual({ category: 'UG', level: 'Sophomore' });
    expect(levelForCourseNumber(316)).toEqual({ category: 'UG', level: 'Junior' });
    expect(levelForCourseNumber(445)).toEqual({ category: 'UG', level: 'Senior' });
    expect(levelForCourseNumber(567)).toEqual({ category: 'GR', level: 'Graduate' });
    expect(levelForCourseNumber(610)).toEqual({ category: 'GR', level: 'Graduate' });
  });

  test('a level that matches the number → no error', () => {
    expect(courseCodeLevelError('SWE 567', 'Graduate', 'GR')).toBeNull();
    expect(courseCodeLevelError('SWE 316', 'Junior', 'UG')).toBeNull();
    expect(courseCodeLevelError('SWE 445', 'Senior', 'UG')).toBeNull();
    expect(courseCodeLevelError('SWE 206', 'Sophomore', 'UG')).toBeNull();
  });

  test('a mismatched level → error naming the expected level', () => {
    expect(courseCodeLevelError('SWE 567', 'Senior', 'UG')).toMatch(/Graduate/);     // grad number, UG-senior chosen
    expect(courseCodeLevelError('SWE 316', 'Graduate', 'GR')).toMatch(/Junior/);     // junior number, grad chosen
    expect(courseCodeLevelError('SWE 101', 'Senior', 'UG')).toMatch(/Freshman/);
    expect(courseCodeLevelError('SWE 445', 'Graduate', 'GR')).toMatch(/Senior/);
  });

  test('malformed/empty code → null (courseCodeError owns format)', () => {
    expect(courseCodeLevelError('SWE 99', 'Freshman', 'UG')).toBeNull();
    expect(courseCodeLevelError('', 'Freshman', 'UG')).toBeNull();
    expect(courseCodeLevelError('MATH 101', 'Freshman', 'UG')).toBeNull();
  });

  test('the range now allows graduate 600s (SWE 610) and rejects out-of-range', () => {
    expect(courseCodeError('SWE 610')).toBeNull();
    expect(courseCodeError('SWE 567')).toBeNull();
    expect(courseCodeError('SWE 700')).toMatch(/101–699/);
    expect(courseCodeError('SWE 100')).toMatch(/101–699/);
  });
});
