/**
 * Batch 21 (FU-574) — QuickFixService.apply must refuse a fix set that does not
 * REDUCE the weighted conflict cost, not merely the hard COUNT. The old gate only
 * checked hard count, so an applied (subset of a) plan could still raise the SOFT
 * count and "succeed" — the grid Quick Fix appeared to ADD conflicts.
 *
 * Pure unit test — the pg layer is mocked, so this never touches a database.
 */
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../../src/config/db', () => ({
  getClient: jest.fn(async () => mockClient),
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
}));

const qfSvc    = require('../../src/services/QuickFixService');
const schedSvc = require('../../src/services/ScheduleService');

const SID = '11111111-1111-1111-1111-111111111111';
// A single op that no-ops (its peek SELECT returns 0 rows via the mock) so the apply
// loop runs but mutates nothing — apply() early-returns on an EMPTY ops array, so we
// need ≥1 op to reach the post-apply re-validation gate. `applied` stays 0.
const NOOP_OPS = [{ type: 'reassign-instructor', sectionId: SID, newInstructorId: SID }];

function programClient() {
  mockClient.query.mockReset();
  mockClient.release.mockReset();
  mockClient.query.mockImplementation(async (sql) => {
    if (/FOR UPDATE/i.test(sql))        return { rowCount: 1, rows: [{ status: 'Draft', archived_at: null }] };
    if (/SELECT\s+semester/i.test(sql)) return { rowCount: 1, rows: [{ semester: '251' }] };
    // ConflictRepository.replaceAll's `INSERT … RETURNING id` reads res.rows[i].id —
    // hand back enough id rows so the commit path doesn't blow up on the mock.
    if (/INSERT\s+INTO\s+conflicts/i.test(sql)) return { rowCount: 64, rows: Array.from({ length: 64 }, (_, i) => ({ id: 'c' + i })) };
    return { rows: [], rowCount: 0 };
  });
}
const sqlCalls = () => mockClient.query.mock.calls.map((c) => String(c[0]));

describe('QuickFixService.apply weighted-cost gate (Batch 21 / FU-574)', () => {
  beforeEach(programClient);

  test('rejects (409) + ROLLS BACK when the applied set RAISES weighted cost (soft up, hard flat)', async () => {
    const evalSpy = jest.spyOn(schedSvc, '_evaluateSchedule')
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [{ ruleId: 'R-13' }] })                                       // before: weighted 5
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [{ ruleId: 'R-13' }, { ruleId: 'R-13' }, { ruleId: 'R-13' }] }); // after:  weighted 15

    await expect(qfSvc.apply(SID, NOOP_OPS)).rejects.toMatchObject({ status: 409 });

    const calls = sqlCalls();
    expect(calls.some((s) => /ROLLBACK/i.test(s))).toBe(true);
    expect(calls.some((s) => /COMMIT/i.test(s))).toBe(false);
    evalSpy.mockRestore();
  });

  test('commits when the applied set REDUCES weighted cost', async () => {
    const evalSpy = jest.spyOn(schedSvc, '_evaluateSchedule')
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [{ ruleId: 'R-13' }, { ruleId: 'R-13' }] }) // before: 10
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [{ ruleId: 'R-13' }] });                    // after:  5

    const out = await qfSvc.apply(SID, NOOP_OPS);
    expect(out).toMatchObject({ applied: 0 });
    const calls = sqlCalls();
    expect(calls.some((s) => /COMMIT/i.test(s))).toBe(true);
    expect(calls.some((s) => /ROLLBACK/i.test(s))).toBe(false);
    evalSpy.mockRestore();
  });

  test('a hard→soft trade that LOWERS weighted cost is allowed even though the soft count rose', async () => {
    // before: 1 hard R-04 (weight 80). after: 2 soft R-13 (10). Weighted 80→10 (big win),
    // but soft COUNT went 0→2 — a naive count gate would wrongly block this real fix.
    const evalSpy = jest.spyOn(schedSvc, '_evaluateSchedule')
      .mockResolvedValueOnce({ hardConflicts: [{ ruleId: 'R-04' }], conflicts: [{ ruleId: 'R-04' }] })
      .mockResolvedValueOnce({ hardConflicts: [], conflicts: [{ ruleId: 'R-13' }, { ruleId: 'R-13' }] });

    const out = await qfSvc.apply(SID, NOOP_OPS);
    expect(out).toMatchObject({ applied: 0 });
    expect(sqlCalls().some((s) => /COMMIT/i.test(s))).toBe(true);
    evalSpy.mockRestore();
  });
});
