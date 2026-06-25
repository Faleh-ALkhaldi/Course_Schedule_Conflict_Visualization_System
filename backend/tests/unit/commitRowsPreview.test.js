/**
 * NEW-FU-668 — ExportService.commitRows({ preview:true }) must stage the whole replace
 * inside its transaction, evaluate the conflicts the imported term WOULD have, and then
 * ROLL BACK (never COMMIT) so the controller can show the proceed / cancel / fix dialog
 * before any DB write. "Cancel" is therefore just "never committed".
 *
 * Pure unit test — the pg layer + the domain validators + the conflict evaluator are all
 * mocked, so this never touches a database (honours the SKIP_TEST_DB=1 rule).
 */

// Mock the pg layer BEFORE requiring the service (jest hoists this; the factory may only
// reference `mock`-prefixed names).
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../../src/config/db', () => ({
  getClient: jest.fn(async () => mockClient),
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
}));
// The field/name gates run real-DB-free already, but mock them to a clean pass so the test
// targets ONLY the preview branch, not validation (covered elsewhere).
jest.mock('../../src/domain/importFieldValidation', () => ({ validateImportFields: () => ({ errors: [] }) }));
jest.mock('../../src/domain/courseFormat', () => ({
  ...jest.requireActual('../../src/domain/courseFormat'),   // keep creditsFlagError etc. real
  courseCodeError: () => null, courseNameError: () => null, courseCodeLevelError: () => null,
}));

const schedSvc  = require('../../src/services/ScheduleService');
const exportSvc = require('../../src/services/ExportService');

const SID = '11111111-1111-1111-1111-111111111111';
const ROW = {
  courseCode: 'SWE 211', courseName: 'Software Engineering 1', academicLevel: 'Sophomore',
  category: 'UG', credits: 3, sectionNumber: '01', sectionType: 'Lec', gender: 'M',
  days: ['Sunday', 'Tuesday', 'Thursday'], startTime: '08:00', endTime: '08:50',
  instructorName: 'TEST INSTRUCTOR', venueName: '99-001', venueType: 'LectureHall',
};

beforeEach(() => {
  mockClient.query.mockReset();
  mockClient.release.mockReset();
  // Editable lock; every INSERT … RETURNING hands back an id; everything else is a no-op.
  mockClient.query.mockImplementation(async (sql) => {
    if (/FOR UPDATE/i.test(sql))   return { rowCount: 1, rows: [{ status: 'Draft', archived_at: null }] };
    if (/RETURNING/i.test(sql))    return { rowCount: 1, rows: [{ id: 'new-id', name: 'TEST INSTRUCTOR' }] };
    return { rows: [], rowCount: 0 };
  });
  jest.spyOn(schedSvc, 'assertSchedulerEditableLocked').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

const sqlOf = () => mockClient.query.mock.calls.map((c) => String(c[0]));

describe('ExportService.commitRows preview (FU-668)', () => {
  test('preview returns the evaluator conflicts, ROLLS BACK, and never COMMITs', async () => {
    const fakeConflicts = [
      { ruleId: 'R-01', isSoft: false, description: 'instructor double-booked' },
      { ruleId: 'R-15', isSoft: true,  description: 'coverage short' },
    ];
    jest.spyOn(schedSvc, '_evaluateSchedule').mockResolvedValue({ conflicts: fakeConflicts });

    const res = await exportSvc.commitRows([ROW], SID, [], [], [], { preview: true });

    expect(res.preview).toBe(true);
    expect(res.conflicts).toEqual(fakeConflicts);
    const sql = sqlOf();
    expect(sql.some((s) => /ROLLBACK/i.test(s))).toBe(true);    // rolled back
    expect(sql.some((s) => /^\s*COMMIT/i.test(s))).toBe(false); // never committed
  });

  test('a NON-preview commit COMMITs and does not call the preview evaluator', async () => {
    const spy = jest.spyOn(schedSvc, '_evaluateSchedule').mockResolvedValue({ conflicts: [] });

    const res = await exportSvc.commitRows([ROW], SID, [], [], []);   // no opts → real commit

    expect(res.preview).toBeUndefined();
    const sql = sqlOf();
    expect(sql.some((s) => /^\s*COMMIT/i.test(s))).toBe(true);   // committed
    expect(spy).not.toHaveBeenCalled();                          // preview path not taken
  });
});
