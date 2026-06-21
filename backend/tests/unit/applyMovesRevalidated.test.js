/**
 * audit-2 P2-3 — ScheduleService.applyMovesRevalidated must SERVER-SIDE re-validate
 * a move-only Quick-Fix plan: apply the moves, re-run the conflict engine, and ROLL
 * BACK (409) if the plan raised the hard-conflict count. Before this fix the apply
 * trusted the client's plan and committed unconditionally, so a stale/crafted plan
 * could persist fresh hard conflicts.
 *
 * Pure unit test — the pg layer is mocked, so this never touches any database
 * (honours the "unit tests only, SKIP_TEST_DB=1" rule).
 */

// Mock the pg access layer BEFORE requiring the service. The factory may only
// reference variables whose names start with `mock` (jest hoisting rule).
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../../src/config/db', () => ({
  getClient: jest.fn(async () => mockClient),
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
}));

const schedSvc = require('../../src/services/ScheduleService');

const SID = '11111111-1111-1111-1111-111111111111';

function programClient() {
  // Editable schedule for the lock SELECT; UPDATE affects one row; BEGIN/COMMIT/
  // ROLLBACK/DELETE/INSERT all resolve as harmless no-ops.
  mockClient.query.mockReset();
  mockClient.release.mockReset();
  mockClient.query.mockImplementation(async (sql) => {
    if (/FOR UPDATE/i.test(sql))      return { rowCount: 1, rows: [{ status: 'Draft', archived_at: null }] };
    if (/^\s*UPDATE\s+sections/i.test(sql)) return { rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

const sqlCalls = () => mockClient.query.mock.calls.map((c) => String(c[0]));

describe('ScheduleService.applyMovesRevalidated (audit-2 P2-3)', () => {
  beforeEach(programClient);

  test('rejects with 409 and ROLLS BACK when the plan raises the hard-conflict count', async () => {
    const evalSpy = jest.spyOn(schedSvc, '_evaluateSchedule')
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [] })                     // before: 0 hard
      .mockResolvedValueOnce({ hardConflicts: [{ id: 'x' }], conflicts: [{ id: 'x' }] }); // after: 1 hard

    await expect(
      schedSvc.applyMovesRevalidated(SID, [{ sectionId: SID, startTime: '10:00', endTime: '10:50' }]),
    ).rejects.toMatchObject({ status: 409 });

    const calls = sqlCalls();
    expect(calls.some((s) => /^\s*UPDATE\s+sections/i.test(s))).toBe(true); // the move was attempted…
    expect(calls.some((s) => /ROLLBACK/i.test(s))).toBe(true);             // …but undone
    expect(calls.some((s) => /COMMIT/i.test(s))).toBe(false);             // and never committed
    evalSpy.mockRestore();
  });

  test('commits when the plan does not raise the hard-conflict count', async () => {
    const evalSpy = jest.spyOn(schedSvc, '_evaluateSchedule')
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [] })  // before: 0 hard
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [] }); // after:  0 hard

    const out = await schedSvc.applyMovesRevalidated(SID, [
      { sectionId: SID, startTime: '10:00', endTime: '10:50' },
    ]);

    expect(out).toMatchObject({ ok: true, moved: 1 });
    const calls = sqlCalls();
    expect(calls.some((s) => /COMMIT/i.test(s))).toBe(true);
    expect(calls.some((s) => /ROLLBACK/i.test(s))).toBe(false);
    evalSpy.mockRestore();
  });

  // NEW-FU-625 (audit): the gate now also refuses a SOFT-only increase. The move-only panel
  // Quick Fix promises zero NEW conflict of ANY severity, so a stale plan that keeps the hard
  // count flat but adds a soft conflict must still roll back (the old hard-only gate committed it).
  test('rejects with 409 and ROLLS BACK when the plan raises the SOFT (total) count, hard unchanged', async () => {
    const evalSpy = jest.spyOn(schedSvc, '_evaluateSchedule')
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [{ id: 's1' }] })                // before: 0 hard / 1 total
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [{ id: 's1' }, { id: 's2' }] }); // after:  0 hard / 2 total

    await expect(
      schedSvc.applyMovesRevalidated(SID, [{ sectionId: SID, startTime: '10:00', endTime: '10:50' }]),
    ).rejects.toMatchObject({ status: 409 });

    const calls = sqlCalls();
    expect(calls.some((s) => /ROLLBACK/i.test(s))).toBe(true);
    expect(calls.some((s) => /COMMIT/i.test(s))).toBe(false);
    evalSpy.mockRestore();
  });

  // Guard against a false-refusal: a plan that LOWERS the total (a real fix) still commits.
  // (after = [] keeps replaceAll a no-op against the mocked pg layer — the gate, not the
  // persistence, is what we're asserting here.)
  test('commits when the plan lowers the total conflict count (a real fix)', async () => {
    const evalSpy = jest.spyOn(schedSvc, '_evaluateSchedule')
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [{ id: 's1' }, { id: 's2' }] }) // before: 2 total
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [] });                          // after:  0 total

    const out = await schedSvc.applyMovesRevalidated(SID, [{ sectionId: SID, startTime: '10:00', endTime: '10:50' }]);
    expect(out).toMatchObject({ ok: true, moved: 1 });
    expect(sqlCalls().some((s) => /COMMIT/i.test(s))).toBe(true);
    evalSpy.mockRestore();
  });

  test('refuses an archived schedule (editability lock) before any move', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (/FOR UPDATE/i.test(sql)) return { rowCount: 1, rows: [{ status: 'Draft', archived_at: '2025-01-01' }] };
      return { rows: [], rowCount: 0 };
    });
    const evalSpy = jest.spyOn(schedSvc, '_evaluateSchedule');

    await expect(
      schedSvc.applyMovesRevalidated(SID, [{ sectionId: SID, startTime: '10:00', endTime: '10:50' }]),
    ).rejects.toMatchObject({ status: 409 });

    // The engine was never even consulted, and no UPDATE ran.
    expect(evalSpy).not.toHaveBeenCalled();
    expect(sqlCalls().some((s) => /^\s*UPDATE\s+sections/i.test(s))).toBe(false);
    evalSpy.mockRestore();
  });
});
