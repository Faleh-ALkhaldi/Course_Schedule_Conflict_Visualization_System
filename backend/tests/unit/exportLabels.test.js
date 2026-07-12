// NEW-FU-666 — end-user export labels ↔ codes, and the import field gate accepting BOTH the
// human labels (Lecture / Female / Lecture Hall / Undergraduate) and the legacy codes.
const labels = require('../../src/domain/exportLabels');
const { validateImportFields } = require('../../src/domain/importFieldValidation');

describe('exportLabels (FU-666) — display ↔ code round-trip', () => {
  test('venue type', () => {
    expect(labels.venueTypeDisplay('LectureHall')).toBe('Lecture Hall');
    expect(labels.venueTypeCode('Lecture Hall')).toBe('LectureHall');
    expect(labels.venueTypeCode('LectureHall')).toBe('LectureHall');   // legacy code still accepted
    expect(labels.venueTypeDisplay('Laboratory')).toBe('Laboratory');
    expect(labels.venueTypeDisplay('Multipurpose')).toBe('Multipurpose');
  });
  test('category', () => {
    expect(labels.categoryDisplay('UG')).toBe('Undergraduate');
    expect(labels.categoryDisplay('GR')).toBe('Graduate');
    expect(labels.categoryCode('Undergraduate')).toBe('UG');
    expect(labels.categoryCode('Graduate')).toBe('GR');
    expect(labels.categoryCode('GR')).toBe('GR');
    expect(labels.categoryCode('')).toBe('UG');   // empty → legacy default
  });
  test('section type (table full word) + short flag (grid card)', () => {
    expect(labels.sectionTypeDisplay('Lec')).toBe('Lecture');
    expect(labels.sectionTypeDisplay('Lab')).toBe('Laboratory');
    expect(labels.sectionTypeCode('Lecture')).toBe('Lec');
    expect(labels.sectionTypeCode('Laboratory')).toBe('Lab');
    expect(labels.sectionTypeCode('Lec')).toBe('Lec');   // legacy code
    expect(labels.sectionTypeShort('Lec')).toBe('Lec');
    expect(labels.sectionTypeShort('Lab')).toBe('Lab');
  });
  test('gender', () => {
    expect(labels.genderDisplay('M')).toBe('Male');
    expect(labels.genderDisplay('F')).toBe('Female');
    expect(labels.genderCode('Female')).toBe('F');
    expect(labels.genderCode('male')).toBe('M');
    expect(labels.genderCode('F')).toBe('F');
  });
  test('course type label — FU-687: capstone surfaces as Project, new Thesis, External/Regular kept', () => {
    expect(labels.courseTypeLabel({ isCapstone: true })).toBe('Project');   // FU-687 rename
    expect(labels.courseTypeLabel({ isThesis: true })).toBe('Thesis');      // FU-687 new flag
    expect(labels.courseTypeLabel({ isSeminar: true })).toBe('Seminar');
    expect(labels.courseTypeLabel({ isExternal: true })).toMatch(/external/i);
    expect(labels.courseTypeLabel({ hasLab: true })).toBe('Has Laboratory');
    expect(labels.courseTypeLabel({})).toBe('Regular');
  });
  test('effectiveSectionType — FU-687/688: display-only Lec→Prj/Ths/Sem/St/Int/Res derivation', () => {
    // stored Lab/Prj/Ths/Sem honoured as-is
    expect(labels.effectiveSectionType({ sectionType: 'Lab' })).toBe('Lab');
    expect(labels.effectiveSectionType({ sectionType: 'Prj' })).toBe('Prj');
    expect(labels.effectiveSectionType({ sectionType: 'Ths' })).toBe('Ths');
    expect(labels.effectiveSectionType({ sectionType: 'Sem' })).toBe('Sem');   // NEW-FU-688
    // legacy 'Lec' rows derive from the course nature WITHOUT being rewritten
    expect(labels.effectiveSectionType({ sectionType: 'Lec', isThesis: true })).toBe('Ths');
    expect(labels.effectiveSectionType({ sectionType: 'Lec', isResearch: true })).toBe('Res');  // NEW-FU-688
    expect(labels.effectiveSectionType({ sectionType: 'Lec', isCapstone: true })).toBe('Prj');
    expect(labels.effectiveSectionType({ sectionType: 'Lec', isSeminar: true })).toBe('Sem');
    expect(labels.effectiveSectionType({ sectionType: 'Lec' })).toBe('Lec');         // regular lecture
    // NEW-FU-688: an external course's activity is term-derived — Summer Training in a Summer term, Internship otherwise
    expect(labels.effectiveSectionType({ sectionType: 'Lec', isExternal: true }, { season: '3' })).toBe('St');
    expect(labels.effectiveSectionType({ sectionType: 'Lec', isExternal: true }, { season: '2' })).toBe('Int');
    expect(labels.effectiveSectionType({ sectionType: 'Lec', isExternal: true })).toBe('Int');  // no season → default Internship
    // snake_case input (DB rows) also accepted
    expect(labels.effectiveSectionType({ section_type: 'Lec', is_capstone: true })).toBe('Prj');
  });
  test('unknown value passes through UNCHANGED (so strict validators still reject it)', () => {
    expect(labels.venueTypeCode('Auditorium')).toBe('Auditorium');
    expect(labels.sectionTypeCode('Tutorial')).toBe('Tutorial');
    expect(labels.genderCode('X')).toBe('X');
  });
});

describe('importFieldValidation (FU-666) — gate accepts human labels, rejects junk', () => {
  const goodRow = (over = {}, raw = {}) => ({
    courseCode: 'SWE 101', courseName: 'Intro', academicLevel: 'Freshman', category: 'UG',
    credits: 3, sectionNumber: '01', sectionType: 'Lec', gender: 'M', isCapstone: false, isExternal: false,
    days: ['Sunday'], startTime: '08:00', endTime: '08:50', instructorName: 'TEST PROF', venueName: 'ROOM-X',
    venueType: 'LectureHall', __row: 2, __raw: { gender: 'M', sectionType: 'Lec', credits: '3', ...raw }, ...over,
  });
  const GI = [{ name: 'Test Prof', email: 'a@dept.edu' }];
  const GV = [{ name: 'ROOM-X', type: 'LectureHall', capacity: 30 }];
  const errs = (over, raw) => validateImportFields({ rows: [goodRow(over, raw)], instructors: GI, venues: GV }).errors;

  test('human gender "Female" accepted', () => { expect(errs({}, { gender: 'Female' })).toEqual([]); });
  test('human section type "Lecture" accepted', () => { expect(errs({ sectionType: 'Lec' }, { sectionType: 'Lecture' })).toEqual([]); });
  test('humanized venue type "Lecture Hall" accepted', () => { expect(errs({ venueType: 'LectureHall' })).toEqual([]); });
  test('still rejects a junk gender', () => { expect(errs({}, { gender: 'Other' }).join(' ')).toMatch(/Gender/); });
  test('still rejects a junk section type', () => { expect(errs({}, { sectionType: 'Tutorial' }).join(' ')).toMatch(/Section Type/); });
  test('still rejects a junk venue type', () => { expect(errs({ venueType: 'Auditorium' }).join(' ')).toMatch(/Venue Type/); });
});
