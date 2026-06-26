// NEW-FU-671 (re-audit residual): the academic-level resolver was duplicated in the whole-term
// import path (ExportService.commitRows) and the scoped/merge path (ScopedImportService). FU-671
// fixed only the first copy to tolerate the PDF-wrapped "Sophomor e"; the scoped copy still used a
// strict match and would silently default such a row to "Freshman". This specs ONE shared resolver
// (domain/courseFormat.js) both paths use, so they can never diverge again.
const { resolveAcademicLevel } = require('../../src/domain/courseFormat');

describe('resolveAcademicLevel — shared, whitespace-tolerant level resolver', () => {
  test('exact level text resolves to itself', () => {
    expect(resolveAcademicLevel('Freshman', 'UG')).toBe('Freshman');
    expect(resolveAcademicLevel('Sophomore', 'UG')).toBe('Sophomore');
    expect(resolveAcademicLevel('Junior', 'UG')).toBe('Junior');
    expect(resolveAcademicLevel('Senior', 'UG')).toBe('Senior');
  });

  test('the PDF-wrapped form "Sophomor e" resolves to "Sophomore" (the bug)', () => {
    expect(resolveAcademicLevel('Sophomor e', 'UG')).toBe('Sophomore');
  });

  test('whitespace tolerance is general, not Sophomore-special-cased', () => {
    expect(resolveAcademicLevel('Seni or', 'UG')).toBe('Senior');
    expect(resolveAcademicLevel('  Junior  ', 'UG')).toBe('Junior');
    expect(resolveAcademicLevel('Fresh\tman', 'UG')).toBe('Freshman');
  });

  test('matching is case-insensitive', () => {
    expect(resolveAcademicLevel('sophomore', 'UG')).toBe('Sophomore');
    expect(resolveAcademicLevel('SENIOR', 'UG')).toBe('Senior');
  });

  test('GR category is always Graduate, regardless of the level text', () => {
    expect(resolveAcademicLevel('Senior', 'GR')).toBe('Graduate');
    expect(resolveAcademicLevel('', 'GR')).toBe('Graduate');
    expect(resolveAcademicLevel('Graduate', 'GR')).toBe('Graduate');
  });

  test('unrecognized / empty / null level falls back to Freshman (preserves existing behavior)', () => {
    expect(resolveAcademicLevel('Bogus', 'UG')).toBe('Freshman');
    expect(resolveAcademicLevel('', 'UG')).toBe('Freshman');
    expect(resolveAcademicLevel(null, 'UG')).toBe('Freshman');
    expect(resolveAcademicLevel(undefined, undefined)).toBe('Freshman');
  });
});
