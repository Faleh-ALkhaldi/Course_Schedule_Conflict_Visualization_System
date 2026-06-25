// NEW-FU-667 — scope helpers + the venue-export explanation note.
const scope = require('../../src/services/exportScope');

describe('exportScope (FU-667)', () => {
  test('scopeOf resolves the three scopes (and defaults to full)', () => {
    expect(scope.scopeOf({ type: 'instructor', id: 'x' })).toBe('instructor');
    expect(scope.scopeOf({ type: 'venue', id: 'x' })).toBe('venue');
    expect(scope.scopeOf({ type: 'full' })).toBe('full');
    expect(scope.scopeOf()).toBe('full');
    expect(scope.scopeOf({ type: 'venue' })).toBe('full');   // no id → not a real scoped export
  });

  test('VENUE_EXPORT_NOTE explains, in plain words, why a venue file carries instructors + office hours', () => {
    const n = scope.VENUE_EXPORT_NOTE;
    expect(typeof n).toBe('string');
    expect(n.length).toBeGreaterThan(80);
    expect(n).toMatch(/instructor/i);
    expect(n).toMatch(/office hour/i);
    expect(n).toMatch(/conflict/i);
    expect(n).toMatch(/not an error|expected/i);   // reassures the user it's intentional
    // plain end-user language — no code-base identifiers
    expect(n).not.toMatch(/LectureHall|owner_semester|scheduleId|undefined|null/);
  });
});
