/**
 * NEW-FU-632 (issue #2) — office-hour mutations must be refused when the active term
 * (asserted via X-Active-Term, resolved into req.activeTerm by extractActiveTerm) is
 * ARCHIVED or FINALIZED. Office hours are global (no per-schedule FK), so unlike section
 * edits they can't be gated by the schedule row-lock — this middleware is the API-level
 * backstop for the read-only contract. Pure unit test (no DB, no Express).
 */
const { refuseIfActiveTermArchived, refuseIfActiveTermArchivedOrFinalized } = require('../../src/middleware/activeTerm');

function run(mw, activeTerm) {
  let status = null, body = null, nexted = false;
  const req = { activeTerm };
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  mw(req, res, () => { nexted = true; });
  return { status, body, nexted };
}

describe('refuseIfActiveTermArchivedOrFinalized (audit / FU-632)', () => {
  test('blocks an ARCHIVED active term with 409', () => {
    const r = run(refuseIfActiveTermArchivedOrFinalized, { code: '251', archivedAt: new Date('2025-01-01'), status: 'Finalized' });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/archived/i);
  });

  test('blocks a FINALIZED (non-archived) active term with 409 — the gap this fix closes', () => {
    const r = run(refuseIfActiveTermArchivedOrFinalized, { code: '251', archivedAt: null, status: 'Finalized' });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/finalized/i);
  });

  test('allows a DRAFT active term (calls next, no response)', () => {
    const r = run(refuseIfActiveTermArchivedOrFinalized, { code: '261', archivedAt: null, status: 'Draft' });
    expect(r.nexted).toBe(true);
    expect(r.status).toBe(null);
  });

  test('allows when there is no active-term context (back-compat: header absent → null)', () => {
    const r = run(refuseIfActiveTermArchivedOrFinalized, null);
    expect(r.nexted).toBe(true);
  });

  test('the original archived-only gate still ignores Finalized (unchanged behavior for other routes)', () => {
    // refuseIfActiveTermArchived must NOT newly block finalized — only OH routes get the stricter gate.
    const r = run(refuseIfActiveTermArchived, { code: '251', archivedAt: null, status: 'Finalized' });
    expect(r.nexted).toBe(true);
    expect(r.status).toBe(null);
  });
});
