/**
 * NEW-FU-661 — the strict per-field import gate. Every malformed value/cell must be
 * rejected with a precise message, and a fully valid baseline must pass clean. Also
 * covers the shared instructor name/email format module.
 */
const { validateImportFields } = require('../../src/domain/importFieldValidation');
const { emailError, instructorNameError } = require('../../src/domain/instructorFormat');

// A fully valid section row (with the __raw the gate reads for the silently-coerced fields).
const goodRow = (over = {}, raw = {}) => ({
  courseCode: 'SWE 101', courseName: 'Intro to Software', academicLevel: 'Freshman',
  category: 'UG', credits: 3, sectionNumber: '01', sectionType: 'Lec', gender: 'M',
  isCapstone: false, isExternal: false, days: ['Sunday', 'Tuesday', 'Thursday'],
  startTime: '08:00', endTime: '08:50', instructorName: 'TEST PROF', venueName: 'ROOM-X',
  venueType: 'LectureHall', __row: 2, __raw: { gender: 'M', sectionType: 'Lec', credits: '3', ...raw }, ...over,
});
const GI = [{ name: 'Test Prof', email: 'a@dept.edu' }];
const GV = [{ name: 'ROOM-X', type: 'LectureHall', capacity: 30 }];
const run = (over, raw, opts = {}) =>
  validateImportFields({ rows: [goodRow(over, raw)], instructors: opts.instructors ?? GI, venues: opts.venues ?? GV }).errors;

describe('importFieldValidation (FU-661) — valid baseline', () => {
  test('a fully valid row + refs produces zero errors', () => {
    expect(validateImportFields({ rows: [goodRow()], instructors: GI, venues: GV }).errors).toEqual([]);
  });
  test('an empty payload is vacuously valid', () => {
    expect(validateImportFields({}).errors).toEqual([]);
  });
});

describe('importFieldValidation (FU-661) — course code', () => {
  test.each([
    ['ICS 32X'], ['CS 200'], ['MATH 101'], ['SWE 099'], ['SWE 700'], ['SWE 12'],
    ['swe 101'], ['SWE101'], ['SWE 1O1'], ['SWE  101'], [' SWE 101 garbage'],
  ])('rejects course code %s', (code) => {
    const e = run({ courseCode: code });
    expect(e.length).toBeGreaterThan(0);
    expect(e[0]).toMatch(/Course Code/);
  });
  test('accepts a valid in-range code', () => {
    expect(run({ courseCode: 'SWE 699' })).toEqual([]);
  });
});

describe('importFieldValidation (FU-661) — credits, flags, gender, type', () => {
  test('credits 5 rejected', () => { expect(run({ credits: 5 }, { credits: '5' })[0]).toMatch(/Credits/); });
  test('credits non-numeric rejected', () => { expect(run({ credits: 3 }, { credits: 'abc' })[0]).toMatch(/Credits/); });
  test('credits negative rejected', () => { expect(run({ credits: -1 }, { credits: '-1' })[0]).toMatch(/Credits/); });
  test('capstone + external rejected', () => { expect(run({ isCapstone: true, isExternal: true })[0]).toMatch(/Course Type/); });
  test('thesis + research rejected', () => { expect(run({ isThesis: true, isResearch: true })[0]).toMatch(/Course Type/); });
  test('has-lab + thesis rejected', () => { expect(run({ courseTypeHasLab: true, isThesis: true })[0]).toMatch(/Course Type/); });
  test('seminar + has-lab rejected', () => {
    expect(run({
      courseCode: 'SWE 599',
      academicLevel: 'Graduate',
      category: 'GR',
      sectionType: 'Sem',
      isSeminar: true,
      courseTypeHasLab: true,
      days: ['Monday'],
      startTime: '17:20',
      endTime: '18:35',
    }, { sectionType: 'Sem' })[0]).toMatch(/Course Type/);
  });
  test('seminar outside Graduate SWE 500–699 rejected', () => {
    expect(run({
      courseCode: 'SWE 499',
      academicLevel: 'Senior',
      category: 'UG',
      sectionType: 'Sem',
      isSeminar: true,
      days: ['Monday'],
      startTime: '17:20',
      endTime: '18:35',
    }, { sectionType: 'Sem' }).join(' ')).toMatch(/Graduate SWE 500–699/);
  });
  test('gender X rejected (not silently coerced)', () => { expect(run({}, { gender: 'X' })[0]).toMatch(/Gender/); });
  test('gender empty defaults to M (accepted)', () => { expect(run({}, { gender: '' })).toEqual([]); });
  test('section type Tutorial rejected with the complete accepted-label list', () => {
    const message = run({}, { sectionType: 'Tutorial' })[0];
    expect(message).toMatch(/Section Type/);
    expect(message).toMatch(/Summer Training/);
    expect(message).toMatch(/Internship/);
    expect(message).toMatch(/Research/);
  });
  test.each(['Summer Training', 'Internship', 'Research'])('section type %s is accepted for round-trip imports', (sectionType) => {
    expect(run({}, { sectionType })).toEqual([]);
  });
});

describe('importFieldValidation (FU-661) — section number range by type', () => {
  test('Lec 50 rejected', () => { expect(run({ sectionNumber: '50' })[0]).toMatch(/Section #/); });
  test('Lab 01 rejected', () => { expect(run({ sectionType: 'Lab', sectionNumber: '01' }, { sectionType: 'Lab' })[0]).toMatch(/Section #/); });
  test('00 and 100 rejected', () => {
    expect(run({ sectionNumber: '00' })[0]).toMatch(/Section #/);
    expect(run({ sectionNumber: '100' })[0]).toMatch(/Section #/);
  });
  test('Lab 50 accepted', () => { expect(run({ sectionType: 'Lab', sectionNumber: '50' }, { sectionType: 'Lab' })).toEqual([]); });
  test('Seminar uses the lecture-number range 01–49', () => {
    const sem = (sectionNumber) => run({
      courseCode: 'SWE 599',
      courseName: 'Graduate Seminar',
      academicLevel: 'Graduate',
      category: 'GR',
      credits: 1,
      sectionType: 'Sem',
      sectionNumber,
      isSeminar: true,
      days: ['Monday'],
      startTime: '17:20',
      endTime: '18:35',
    }, { sectionType: 'Sem', credits: '1' });
    expect(sem('49')).toEqual([]);
    expect(sem('50').join(' ')).toMatch(/Section #/);
  });
});

describe('importFieldValidation (FU-661) — days', () => {
  test('Friday rejected', () => { expect(run({ days: ['Friday'] })[0]).toMatch(/Days/); });
  test('unknown day rejected', () => { expect(run({ days: ['Funday'] })[0]).toMatch(/Days/); });
  test('empty days rejected', () => { expect(run({ days: [] })[0]).toMatch(/Days/); });
  test('duplicate day rejected', () => { expect(run({ days: ['Sunday', 'Sunday'] })[0]).toMatch(/repeated/); });
});

describe('importFieldValidation (FU-661) — times', () => {
  test('99:99 rejected', () => { expect(run({ startTime: '99:99', endTime: '10:00' })[0]).toMatch(/HH:MM/); });
  test('25:00 rejected', () => { expect(run({ startTime: '25:00', endTime: '26:00' })[0]).toMatch(/HH:MM/); });
  test('end before start rejected', () => { expect(run({ startTime: '10:00', endTime: '09:00' })[0]).toMatch(/after/); });
  test('before 07:00 rejected', () => { expect(run({ startTime: '06:00', endTime: '06:50' }).some(e => /07:00–22:00/.test(e))).toBe(true); });
  test('after 22:00 rejected', () => { expect(run({ startTime: '22:10', endTime: '22:50' }).some(e => /07:00–22:00/.test(e))).toBe(true); });
  test('17:20–18:35 (graduate evening) accepted', () => { expect(run({ startTime: '17:20', endTime: '18:35' })).toEqual([]); });
  test('seminar import accepts exactly one 75-minute graduate meeting', () => {
    expect(run({
      courseCode: 'SWE 599',
      courseName: 'Graduate Seminar',
      academicLevel: 'Graduate',
      category: 'GR',
      credits: 1,
      sectionType: 'Sem',
      isSeminar: true,
      days: ['Monday'],
      startTime: '17:20',
      endTime: '18:35',
    }, { sectionType: 'Sem', credits: '1' })).toEqual([]);
  });
  test('seminar import rejects non-1-credit rows', () => {
    const badCredits = run({
      courseCode: 'SWE 599',
      courseName: 'Graduate Seminar',
      academicLevel: 'Graduate',
      category: 'GR',
      credits: 3,
      sectionType: 'Sem',
      isSeminar: true,
      days: ['Monday'],
      startTime: '17:20',
      endTime: '18:35',
    }, { sectionType: 'Sem', credits: '3' }).join(' ');
    expect(badCredits).toMatch(/1 credit/i);
  });
  test('seminar import rejects non-75-minute or multi-day meetings', () => {
    const badDuration = run({
      courseCode: 'SWE 599',
      courseName: 'Graduate Seminar',
      academicLevel: 'Graduate',
      category: 'GR',
      credits: 1,
      sectionType: 'Sem',
      isSeminar: true,
      days: ['Monday'],
      startTime: '17:20',
      endTime: '18:10',
    }, { sectionType: 'Sem', credits: '1' }).join(' ');
    expect(badDuration).toMatch(/75/);

    const badDays = run({
      courseCode: 'SWE 599',
      courseName: 'Graduate Seminar',
      academicLevel: 'Graduate',
      category: 'GR',
      credits: 1,
      sectionType: 'Sem',
      isSeminar: true,
      days: ['Sunday', 'Tuesday'],
      startTime: '17:20',
      endTime: '18:35',
    }, { sectionType: 'Sem', credits: '1' }).join(' ');
    expect(badDays).toMatch(/one day/i);
  });
});

describe('importFieldValidation (FU-661) — venue type + reference sheets', () => {
  test('section venue type Classroom rejected', () => { expect(run({ venueType: 'Classroom' })[0]).toMatch(/Venue Type/); });
  test('instructor bad email rejected', () => {
    expect(validateImportFields({ rows: [goodRow()], instructors: [{ name: 'Test Prof', email: 'nope' }], venues: GV }).errors[0]).toMatch(/email/);
  });
  test('instructor junk name rejected', () => {
    expect(validateImportFields({ rows: [goodRow()], instructors: [{ name: 'X#$%', email: 'a@dept.edu' }], venues: GV }).errors[0]).toMatch(/Instructor/);
  });
  test('venue capacity 0 / negative rejected', () => {
    expect(validateImportFields({ rows: [goodRow()], instructors: GI, venues: [{ name: 'ROOM-X', type: 'LectureHall', capacity: 0 }] }).errors[0]).toMatch(/capacity/);
    expect(validateImportFields({ rows: [goodRow()], instructors: GI, venues: [{ name: 'ROOM-X', type: 'LectureHall', capacity: -5 }] }).errors[0]).toMatch(/capacity/);
  });
  test('venue bad type rejected', () => {
    expect(validateImportFields({ rows: [goodRow()], instructors: GI, venues: [{ name: 'ROOM-X', type: 'Room', capacity: 30 }] }).errors[0]).toMatch(/Laboratory|LectureHall/);
  });
});

describe('instructorFormat (FU-661)', () => {
  test('valid email passes, junk fails', () => {
    expect(emailError('a@dept.edu')).toBeNull();
    expect(emailError('notanemail')).toMatch(/name@host/);
    expect(emailError('a@b')).toMatch(/name@host/);
  });
  test('valid full name passes, junk/one-word fails, placeholder exempt', () => {
    expect(instructorNameError('FALEH ALKHALDI')).toBeNull();
    expect(instructorNameError('NEW INSTRUCTOR 3')).toBeNull();
    expect(instructorNameError('Mononym')).toMatch(/full name/);
    expect(instructorNameError('X#$%')).toMatch(/letters/);
  });
});

// NEW-FU-664 — name-cell content: formula injection, control / zero-width / bidi / odd-space,
// and the previously-unvalidated section-row instructor + venue (and venue ref sheet).
describe('importFieldValidation (FU-664) — prohibited characters in names', () => {
  const GI2 = [{ name: 'Test Prof', email: 'a@dept.edu' }];
  const GV2 = [{ name: '22-120', type: 'LectureHall', capacity: 30 }];
  const errs = (over, instr = GI2, ven = GV2) => validateImportFields({ rows: [goodRow(over)], instructors: instr, venues: ven }).errors;

  test('formula-leading course name rejected', () => { expect(errs({ courseName: '=WEBSERVICE("x")' }).join(' ')).toMatch(/formula/i); });
  test('formula-leading venue name (section row) rejected', () => { expect(errs({ venueName: '=HYPERLINK("x")' }).length).toBeGreaterThan(0); });
  test('@-formula venue rejected', () => { expect(errs({ venueName: '@SUM(1)' }).length).toBeGreaterThan(0); });
  test('control char in course name rejected', () => { expect(errs({ courseName: 'Introto SE' }).join(' ')).toMatch(/control/i); });
  test('zero-width char in course name rejected', () => { expect(errs({ courseName: 'Intro​Software Eng' }).join(' ')).toMatch(/hidden|zero-width/i); });
  test('RTL-override in venue name rejected', () => { expect(errs({ venueName: '22‮120' }).length).toBeGreaterThan(0); });
  test('non-breaking space in course name rejected', () => { expect(errs({ courseName: 'Intro Software Eng' }).join(' ')).toMatch(/unusual|space/i); });
  test('section-row junk instructor (digits) rejected', () => { expect(errs({ instructorName: 'PROF 123' }).join(' ')).toMatch(/Instructor/); });
  test('section-row junk instructor (symbols) rejected', () => { expect(errs({ instructorName: 'P #$%' }).length).toBeGreaterThan(0); });
  test('venue ref sheet formula name rejected', () => { expect(errs({}, GI2, [{ name: '=cmd', type: 'LectureHall', capacity: 30 }]).length).toBeGreaterThan(0); });

  test('real values pass: em-dash / one-word course name, full instructor, NN-NNN venue', () => {
    expect(errs({ courseName: 'Introduction to Software Engineering — Freshman Seminar', instructorName: 'FALEH ALKHALDI', venueName: '04-001-A' })).toEqual([]);
    expect(errs({ courseName: 'Thesis', instructorName: 'OMAR HAMMAD', venueName: '42-AUD' })).toEqual([]);
  });
});

// NEW-FU-665 — office hours ride along in the same import file but were never run through
// this gate, so a malformed OH was silently dropped or committed non-atomically (and an
// out-of-window block — the R-04 storm OFFICE_HOURS_WINDOW exists to prevent — has no DB CHECK
// and would persist). Every OH cell is now validated BEFORE any DB write, on both paths.
describe('importFieldValidation (FU-665) — office hours', () => {
  // The OH instructor must be one the file defines, so include them as a section-row instructor.
  const oh = (over = {}) => ({ instructorName: 'TEST PROF', day: 'Sunday', startTime: '09:00', endTime: '10:00', ...over });
  const ohErrs = (over) => validateImportFields({ rows: [goodRow()], instructors: GI, venues: GV, officeHours: [oh(over)] }).errors;

  test('a valid in-window OH for a known instructor passes', () => {
    expect(ohErrs()).toEqual([]);
  });
  test('OH before the 08:00–16:00 window rejected', () => {
    expect(ohErrs({ startTime: '06:00', endTime: '07:00' }).join(' ')).toMatch(/08:00–16:00|window/);
  });
  test('OH after the window rejected', () => {
    expect(ohErrs({ startTime: '16:30', endTime: '17:30' }).join(' ')).toMatch(/08:00–16:00|window/);
  });
  test('OH on Friday (non-schedulable day) rejected', () => {
    expect(ohErrs({ day: 'Friday' }).join(' ')).toMatch(/Sunday–Thursday/);
  });
  test('OH with an unknown day rejected', () => {
    expect(ohErrs({ day: 'Funday' }).join(' ')).toMatch(/Sunday–Thursday/);
  });
  test('OH end <= start rejected', () => {
    expect(ohErrs({ startTime: '10:00', endTime: '09:00' }).join(' ')).toMatch(/after/);
  });
  test('OH malformed time rejected', () => {
    expect(ohErrs({ startTime: '99:99' }).join(' ')).toMatch(/HH:MM/);
  });
  test('OH formula-injection / junk instructor name rejected', () => {
    expect(ohErrs({ instructorName: '=cmd|x' }).length).toBeGreaterThan(0);
    expect(ohErrs({ instructorName: 'PROF 123' }).length).toBeGreaterThan(0);
  });
  test('OH naming an instructor the file does not define rejected (no silent drop)', () => {
    expect(ohErrs({ instructorName: 'GHOST LECTURER' }).join(' ')).toMatch(/not one of the file's instructors/);
  });
  test('OH missing an instructor rejected', () => {
    expect(ohErrs({ instructorName: '' }).join(' ')).toMatch(/must name an instructor/);
  });
  test('OH instructor from the Instructors reference sheet (no section) is accepted', () => {
    // A scoped instructor file may carry OH for someone defined only in the Instructors sheet.
    const errs = validateImportFields({
      rows: [goodRow()], instructors: [{ name: 'Lab Only Prof', email: 'l@dept.edu' }], venues: GV,
      officeHours: [{ instructorName: 'Lab Only Prof', day: 'Monday', startTime: '08:00', endTime: '09:00' }],
    }).errors;
    expect(errs).toEqual([]);
  });
  test('no officeHours key is vacuously valid (back-compat)', () => {
    expect(validateImportFields({ rows: [goodRow()], instructors: GI, venues: GV }).errors).toEqual([]);
  });
  test('boundary OH exactly 08:00–16:00 accepted', () => {
    expect(ohErrs({ startTime: '08:00', endTime: '16:00' })).toEqual([]);
  });

  const twoOH = (a, b) => validateImportFields({
    rows: [goodRow()], instructors: GI, venues: GV,
    officeHours: [{ instructorName: 'TEST PROF', day: 'Sunday', ...a }, { instructorName: 'TEST PROF', day: 'Sunday', ...b }],
  }).errors;
  test('two OVERLAPPING OH for the same instructor/day rejected', () => {
    expect(twoOH({ startTime: '09:00', endTime: '10:30' }, { startTime: '10:00', endTime: '11:00' }).join(' ')).toMatch(/overlaps/);
  });
  test('two DISJOINT same-day OH for one instructor accepted (legit multi-block)', () => {
    expect(twoOH({ startTime: '09:00', endTime: '10:00' }, { startTime: '13:00', endTime: '14:00' })).toEqual([]);
  });
  test('adjacent (touching) same-day OH accepted (no overlap)', () => {
    expect(twoOH({ startTime: '09:00', endTime: '10:00' }, { startTime: '10:00', endTime: '11:00' })).toEqual([]);
  });
});
