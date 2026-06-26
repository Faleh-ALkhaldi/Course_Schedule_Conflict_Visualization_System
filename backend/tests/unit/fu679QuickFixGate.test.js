// NEW-FU-679 (re-audit round 8): the QuickFix accept-gate must never let its
// count-fallback branch wave through a weighted-INCREASING trade. The raw count
// metric scores 1 hard = 2 soft, so the old unguarded `||` count branch would
// accept trading several light soft conflicts for one critical hard (count
// drops, but weighted cost explodes). acceptsOp now guards the count branch
// with `afterWeighted <= beforeWeighted`.
const QF = require('../../src/services/QuickFixService');
const acceptsOp    = QF._acceptsOp;
const weightedCost = QF._weightedCost;

const HARD = new Set(['R-01', 'R-02', 'R-04', 'R-05', 'R-06']);
const conf = (ruleId) => ({ ruleId, severity: HARD.has(ruleId) ? 'Hard' : 'Soft' });
const set  = (...ids) => ids.map(conf);

describe('FU-679 — QuickFix accept-gate never raises weighted cost via the count branch', () => {
  test('accepts a strict weighted improvement (R-02 w50 → R-13 w5)', () => {
    expect(acceptsOp(set('R-02'), set('R-13'))).toBe(true);
  });

  test('accepts fewer-conflicts-at-EQUAL-weight (4× R-13 w20 → 1× R-10 w20)', () => {
    // weighted tie 20→20, count 4→1: a genuine "same cost, fewer conflicts" win.
    expect(weightedCost(set('R-13', 'R-13', 'R-13', 'R-13'))).toBe(20);
    expect(weightedCost(set('R-10'))).toBe(20);
    expect(acceptsOp(set('R-13', 'R-13', 'R-13', 'R-13'), set('R-10'))).toBe(true);
  });

  test('REJECTS trading 3 soft R-13 (w15) for 1 HARD R-01 (w100) — the round-8 regression', () => {
    // count metric: before 3 soft = 3; after 1 hard = 2 → drops 3→2 (the old `||`
    // count branch accepted on this alone). weighted 15→100 RISES → must reject.
    expect(weightedCost(set('R-13', 'R-13', 'R-13'))).toBe(15);
    expect(weightedCost(set('R-01'))).toBe(100);
    expect(acceptsOp(set('R-13', 'R-13', 'R-13'), set('R-01'))).toBe(false);
  });

  test('REJECTS trading 3 light soft (w15) for 1 heavier soft R-14 (w30)', () => {
    expect(acceptsOp(set('R-13', 'R-13', 'R-13'), set('R-14'))).toBe(false);
  });

  test('rejects a no-op (identical before/after)', () => {
    expect(acceptsOp(set('R-02', 'R-13'), set('R-02', 'R-13'))).toBe(false);
  });

  test('rejects strictly-worse (adding a hard on top)', () => {
    expect(acceptsOp(set('R-13'), set('R-13', 'R-01'))).toBe(false);
  });
});
