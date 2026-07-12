// NEW-FU-688 (Phase 126) — registrar Activity flag set: Summer Training / Internship (ST/INT,
// external+season-derived), Research (RES, new sibling of Thesis), Project (PRJ, fully
// conflict-exempt + time-optional), Seminar (SEM, single-day EXACTLY 75 min — FU-689). These tests pin the PURE
// domain logic that the controller / engine / exports all build on, so a regression in the
// exemption set or the Seminar pattern surfaces here, fast and DB-free.
const labels         = require('../../src/domain/exportLabels');
const Section        = require('../../src/domain/Section');
const sectionPattern = require('../../src/domain/sectionPattern');
const { courseFlagError, seminarFlagError } = require('../../src/domain/courseFormat');
const SectionRepository   = require('../../src/repositories/SectionRepository');

const mkSec = (over = {}) => new Section({
  id: 's1', scheduleId: 'sch', courseId: 'c1', sectionNumber: '01',
  day: 'Sunday', startTime: '08:00', endTime: '08:50', sectionType: 'Lec', gender: 'M',
  ...over,
});

describe('FU-688 isInfoOnlyCourse — the grid-excluded / fully-exempt family', () => {
  test('external, thesis, research are info-only', () => {
    expect(labels.isInfoOnlyCourse({ isExternal: true })).toBe(true);
    expect(labels.isInfoOnlyCourse({ isThesis: true })).toBe(true);
    expect(labels.isInfoOnlyCourse({ isResearch: true })).toBe(true);
    expect(labels.isInfoOnlyCourse({ is_research: true })).toBe(true);   // snake_case DB row
  });
  test('Project (capstone) is NOT info-only — it draws in the grid when timed', () => {
    expect(labels.isInfoOnlyCourse({ isCapstone: true })).toBe(false);
  });
  test('a plain lecture / seminar course is not info-only', () => {
    expect(labels.isInfoOnlyCourse({})).toBe(false);
    expect(labels.isInfoOnlyCourse({ sectionType: 'Sem' })).toBe(false);
  });
});

describe('FU-688 Section.isConflictExempt — external|thesis|research|capstone', () => {
  test('each conflict-exempt flag flips the getter on', () => {
    expect(mkSec({ isExternal: true }).isConflictExempt).toBe(true);
    expect(mkSec({ isThesis:   true }).isConflictExempt).toBe(true);
    expect(mkSec({ isResearch: true }).isConflictExempt).toBe(true);
    expect(mkSec({ isCapstone: true }).isConflictExempt).toBe(true);
  });
  test('a regular Lecture / Lab / Seminar is NOT exempt', () => {
    expect(mkSec({}).isConflictExempt).toBe(false);
    expect(mkSec({ sectionType: 'Lab' }).isConflictExempt).toBe(false);
    expect(mkSec({ sectionType: 'Sem' }).isConflictExempt).toBe(false);
  });
});

describe('FU-688/689 sectionPattern — Seminar rule + time-optional skip', () => {
  test('Seminar: a single weekly block of EXACTLY 75 minutes is legal', () => {
    expect(sectionPattern.validateSectionPattern({
      credits: 1, hasLab: false, sectionType: 'Sem', days: ['Monday'], startTime: '10:00', endTime: '11:15', // 75 min
    }).ok).toBe(true);
  });
  test('Seminar: any duration other than 75 is ILLEGAL (50, 100, 160 all rejected)', () => {
    for (const end of ['10:50' /*50*/, '11:40' /*100*/, '12:40' /*160*/]) {
      const r = sectionPattern.validateSectionPattern({
        credits: 1, hasLab: false, sectionType: 'Sem', days: ['Monday'], startTime: '10:00', endTime: end,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/exactly 75/);
    }
  });
  test('Seminar: more than one meeting day is ILLEGAL', () => {
    const r = sectionPattern.validateSectionPattern({
      credits: 1, hasLab: false, sectionType: 'Sem', days: ['Sunday', 'Tuesday'], startTime: '10:00', endTime: '11:15',
    });
    expect(r.ok).toBe(false);
  });
  test('an UNTIMED section (Project / info-only) skips the pattern entirely', () => {
    expect(sectionPattern.validateSectionPattern({
      credits: 3, hasLab: false, sectionType: 'Lec', days: [], startTime: null, endTime: null,
    }).ok).toBe(true);
  });
});

describe('FU-688/127 courseFlagError — Research/Seminar share the at-most-one mutual-exclusion set', () => {
  test('Research alone is fine', () => {
    expect(courseFlagError({ isResearch: true })).toBeNull();
  });
  test('Seminar alone is fine when the code and level are Graduate SWE 500–699', () => {
    expect(courseFlagError({ isSeminar: true })).toBeNull();
    expect(seminarFlagError({
      courseCode: 'SWE 599',
      academicLevel: 'Graduate',
      category: 'GR',
      credits: 1,
      isSeminar: true,
    })).toBeNull();
  });
  test('Seminar is rejected unless it is exactly 1 credit', () => {
    expect(seminarFlagError({
      courseCode: 'SWE 599',
      academicLevel: 'Graduate',
      category: 'GR',
      credits: 3,
      isSeminar: true,
    })).toMatch(/1 credit/);
  });
  test('Research + Thesis together is rejected', () => {
    expect(courseFlagError({ isResearch: true, isThesis: true })).toMatch(/Research/);
  });
  test('Seminar + Has lab together is rejected', () => {
    expect(courseFlagError({ isSeminar: true, hasLab: true })).toMatch(/Seminar/);
  });
  test('Research + Capstone together is rejected', () => {
    expect(courseFlagError({ isResearch: true, isCapstone: true })).toBeTruthy();
  });
  test('Seminar is rejected outside Graduate SWE 500–699', () => {
    expect(seminarFlagError({
      courseCode: 'SWE 499',
      academicLevel: 'Senior',
      category: 'UG',
      isSeminar: true,
    })).toMatch(/Graduate SWE 500–699/);
  });
  test('no flags is fine (a plain course)', () => {
    expect(courseFlagError({})).toBeNull();
  });
});

describe('FU-688 R-09/R-10 repo exemptions — info-only carries instructor but no venue', () => {
  const repo = new SectionRepository();
  test('R-09 (one instructor) applies to external / thesis / research / project', () => {
    expect(repo.validateOneInstructor(mkSec({ instructorId: null, isExternal: true }))).not.toBeNull();
    expect(repo.validateOneInstructor(mkSec({ instructorId: null, isThesis: true }))).not.toBeNull();
    expect(repo.validateOneInstructor(mkSec({ instructorId: null, isResearch: true }))).not.toBeNull();
    expect(repo.validateOneInstructor(mkSec({ instructorId: null, isCapstone: true }))).not.toBeNull();
  });
  test('R-10 (one venue) skips info-only AND Project (venue optional)', () => {
    expect(repo.validateOneVenue(mkSec({ venueId: null, isResearch: true }))).toBeNull();
    expect(repo.validateOneVenue(mkSec({ venueId: null, isCapstone: true }))).toBeNull();
    // A regular Lecture with no venue still flags R-10.
    expect(repo.validateOneVenue(mkSec({ venueId: null }))).not.toBeNull();
  });
});

// NEW-FU-690: the import field gate must accept an info-only row (Thesis/Research/External/Project) with
// NO day and NO time, while still REQUIRING a day+time for a genuinely scheduled section.
describe('FU-690 validateImportFields — info-only rows may omit day/time; scheduled rows may not', () => {
  const { validateImportFields } = require('../../src/domain/importFieldValidation');
  const base = (over = {}) => ({
    courseCode: 'SWE 494', courseName: 'Undergraduate Thesis I', academicLevel: 'Senior', category: 'UG',
    credits: 3, sectionNumber: '01', sectionType: 'Ths', gender: 'M',
    days: [], startTime: '', endTime: '', instructorName: 'SUP ONE', venueName: '', venueType: '',
    __row: 2, __raw: { gender: 'M', sectionType: 'Ths', credits: '3' }, ...over,
  });
  const errs = (over) => validateImportFields({ rows: [base(over)], instructors: [], venues: [] }).errors;

  test('a Thesis row with no day/time passes the gate', () => {
    expect(errs({ isThesis: true })).toEqual([]);
  });
  test('a Research row with no day/time passes the gate', () => {
    expect(errs({ isResearch: true })).toEqual([]);
  });
  test('a Project row with no day/time passes the gate', () => {
    expect(errs({ isCapstone: true })).toEqual([]);
  });
  test('a normal Lecture row with no day/time is REJECTED (day + time required)', () => {
    const e = errs({ sectionType: 'Lec', courseCode: 'SWE 206', academicLevel: 'Sophomore' }).join(' ');
    expect(e).toMatch(/Days|Time/);
  });
  test('an information-only row still requires a supervising instructor', () => {
    const e = errs({ isThesis: true, instructorName: '' }).join(' ');
    expect(e).toMatch(/Instructor/);
  });
  test('an information-only row rejects day, time, and venue cells', () => {
    const e = errs({
      isResearch: true,
      days: ['Sunday'],
      startTime: '08:00',
      endTime: '08:50',
      venueName: '22-120',
      venueType: 'LectureHall',
    }).join(' ');
    expect(e).toMatch(/information-only activities must not have meeting days/);
    expect(e).toMatch(/information-only activities must not have a start or end time/);
    expect(e).toMatch(/information-only activities must not have a venue/);
  });
  test('a Project venue without a meeting time is rejected', () => {
    const e = errs({
      courseCode: 'SWE 412',
      courseName: 'Software Engineering Project II',
      isCapstone: true,
      sectionType: 'Prj',
      __raw: { gender: 'M', sectionType: 'Prj', credits: '3' },
      venueName: '24-240',
      venueType: 'LectureHall',
    }).join(' ');
    expect(e).toMatch(/Project venue requires a meeting time/);
  });
  test('a timed Project must be one day and one of the registrar durations', () => {
    const twoDay = errs({
      courseCode: 'SWE 412',
      courseName: 'Software Engineering Project II',
      isCapstone: true,
      sectionType: 'Prj',
      __raw: { gender: 'M', sectionType: 'Prj', credits: '3' },
      days: ['Sunday', 'Tuesday'],
      startTime: '17:20',
      endTime: '18:35',
      venueName: '',
      venueType: '',
    }).join(' ');
    expect(twoDay).toMatch(/exactly one day/);

    const badDuration = errs({
      courseCode: 'SWE 412',
      courseName: 'Software Engineering Project II',
      isCapstone: true,
      sectionType: 'Prj',
      __raw: { gender: 'M', sectionType: 'Prj', credits: '3' },
      days: ['Sunday'],
      startTime: '17:20',
      endTime: '18:30',
    }).join(' ');
    expect(badDuration).toMatch(/50, 75, 100, or 160/);
  });
  test.each([
    ['50 minutes', '17:20', '18:10'],
    ['75 minutes', '17:20', '18:35'],
    ['100 minutes', '17:20', '19:00'],
    ['160 minutes', '17:20', '20:00'],
  ])('a timed Project accepts %s with optional venue', (_label, startTime, endTime) => {
    expect(errs({
      courseCode: 'SWE 412',
      courseName: 'Software Engineering Project II',
      isCapstone: true,
      sectionType: 'Prj',
      __raw: { gender: 'M', sectionType: 'Prj', credits: '3' },
      days: ['Sunday'],
      startTime,
      endTime,
      venueName: '',
      venueType: '',
    })).toEqual([]);
  });
});
