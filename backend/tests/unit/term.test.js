// NEW-FU-159: unit tests for the term codec.
// NEW-FU-223: dates for 251/252/253/261/262 are sourced from the
// TERM_DATE_OVERRIDES map (KFUPM-published values). Codes without an
// override (e.g. 263, 31X) still hit the SEASONS template fallback —
// the 263 test below pins that fallback behavior so a future regression
// in the override lookup surfaces clearly.
const { decodeTerm, TERM_CODE_RE, TERM_CALENDAR, TERM_DATE_OVERRIDES } = require('../../src/domain/term');

describe('decodeTerm', () => {
  test('251 → Fall 2025, Aug 24 2025 – Dec 29 2025 (KFUPM override)', () => {
    const t = decodeTerm('251');
    expect(t.season).toBe('Fall');
    expect(t.ay).toEqual([2025, 2026]);
    expect(t.label).toBe('Fall 2025');
    expect(t.startsAt).toBe('2025-08-24');
    expect(t.endsAt).toBe('2025-12-29');
    expect(t.isSummer).toBe(false);
  });

  test('252 → Spring 2026, Jan 11 2026 – May 21 2026 (KFUPM override)', () => {
    const t = decodeTerm('252');
    expect(t.season).toBe('Spring');
    expect(t.ay).toEqual([2025, 2026]);
    expect(t.label).toBe('Spring 2026');
    expect(t.startsAt).toBe('2026-01-11');
    expect(t.endsAt).toBe('2026-05-21');
    expect(t.isSummer).toBe(false);
  });

  test('253 → Summer 2026, Jun 14 2026 – Aug 9 2026 (KFUPM override)', () => {
    const t = decodeTerm('253');
    expect(t.season).toBe('Summer');
    expect(t.ay).toEqual([2025, 2026]);
    expect(t.label).toBe('Summer 2026');
    expect(t.startsAt).toBe('2026-06-14');
    expect(t.endsAt).toBe('2026-08-09');
    expect(t.isSummer).toBe(true);
  });

  test('261 → Fall 2026, Aug 19 2026 – Dec 26 2026 (KFUPM override)', () => {
    const t = decodeTerm('261');
    expect(t.label).toBe('Fall 2026');
    expect(t.ay).toEqual([2026, 2027]);
    expect(t.startsAt).toBe('2026-08-19');
    expect(t.endsAt).toBe('2026-12-26');
  });

  test('262 → Spring 2027, Jan 10 2027 – Jun 8 2027 (KFUPM override)', () => {
    const t = decodeTerm('262');
    expect(t.label).toBe('Spring 2027');
    expect(t.ay).toEqual([2026, 2027]);
    expect(t.startsAt).toBe('2027-01-10');
    expect(t.endsAt).toBe('2027-06-08');
  });

  test('263 → Summer 2027, Jun 20 2027 – Aug 15 2027 (KFUPM override)', () => {
    // NEW-FU-228: 263 dates published after FU-223; promoted from
    // template fallback to TERM_DATE_OVERRIDES entry.
    const t = decodeTerm('263');
    expect(t.label).toBe('Summer 2027');
    expect(t.ay).toEqual([2026, 2027]);
    expect(t.startsAt).toBe('2027-06-20');
    expect(t.endsAt).toBe('2027-08-15');
  });

  test('273 (no override yet) → falls back to SEASONS template Jun 14 – Aug 6', () => {
    // NEW-FU-228: 273 (Summer 2028) is the new "still unpublished"
    // canary that pins the fallback path. The day someone adds a
    // '273' override this test will fail loudly, signaling that the
    // fallback-detector needs to move to the next uncovered code.
    // Pattern carried over from the original 263 test under FU-223.
    expect(TERM_DATE_OVERRIDES['273']).toBeUndefined();
    const t = decodeTerm('273');
    expect(t.label).toBe('Summer 2028');
    expect(t.ay).toEqual([2027, 2028]);
    expect(t.startsAt).toBe('2028-06-14'); // template start
    expect(t.endsAt).toBe('2028-08-06');   // template end
  });

  test('31X covers AY 2031-2032 across the 3 seasons', () => {
    const fall   = decodeTerm('311');
    const spring = decodeTerm('312');
    const summer = decodeTerm('313');
    expect(fall.ay).toEqual([2031, 2032]);
    expect(spring.ay).toEqual([2031, 2032]);
    expect(summer.ay).toEqual([2031, 2032]);
    expect(fall.label).toBe('Fall 2031');
    expect(spring.label).toBe('Spring 2032');
    expect(summer.label).toBe('Summer 2032');
  });

  test('invalid codes throw with descriptive errors', () => {
    expect(() => decodeTerm('abc')).toThrow(/Invalid term code/);
    expect(() => decodeTerm('254')).toThrow(/Invalid term code/); // 4 is not a valid season
    expect(() => decodeTerm('2'  )).toThrow(/Invalid term code/);
    expect(() => decodeTerm('2510')).toThrow(/Invalid term code/);
    expect(() => decodeTerm(null )).toThrow(/Invalid term code/);
    expect(() => decodeTerm(252  )).toThrow(/Invalid term code/); // number, not string
  });

  test('TERM_CODE_RE matches every valid YYT', () => {
    for (const yy of ['00', '25', '99']) {
      for (const t of ['1', '2', '3']) {
        expect(TERM_CODE_RE.test(`${yy}${t}`)).toBe(true);
      }
    }
    expect(TERM_CODE_RE.test('254')).toBe(false);
    expect(TERM_CODE_RE.test('2510')).toBe(false);
  });

  test('TERM_CALENDAR exposes stable per-season date offsets', () => {
    expect(TERM_CALENDAR.Fall.startMonth).toBe(8);
    expect(TERM_CALENDAR.Spring.startMonth).toBe(1);
    expect(TERM_CALENDAR.Summer.startMonth).toBe(6);
    // Frozen — assignment must be a no-op (silent in sloppy mode, throws in strict).
    const before = TERM_CALENDAR.Fall.startMonth;
    try { TERM_CALENDAR.Fall.startMonth = 9; } catch (e) { /* strict mode */ }
    expect(TERM_CALENDAR.Fall.startMonth).toBe(before);
  });
});
