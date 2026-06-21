/**
 * NEW-FU-628 (audit) — SuggestService's slot generators must honor the R-06 time-window
 * exemption via the shared teachingWindowFor, like every other scheduling tool (FU-621).
 * Before this, generateSlots/generateLabSlots hardcoded TIME_WINDOWS[GR|UG], so Suggest
 * clamped SWE 412 (the one R-06-time-exempt course) to the 07:00–17:10 UG day and could
 * report no feasible evening placement — even though the registrar schedules SWE 412 in the
 * evening and the engine accepts it.
 */
const svc = require('../../src/services/SuggestService');
const generateSlots = svc._generateSlots;
const generateLabSlots = svc._generateLabSlots;

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const maxStart = (slots) => Math.max(...slots.map((s) => toMin(s.startTime)));

describe('SuggestService R-06-aware slot windows (audit / FU-628)', () => {
  test('a normal UG course gets only daytime lecture slots (last start fits before 17:10)', () => {
    const slots = generateSlots('ONE_DAY_50', 'UG', 'SWE 363');
    expect(slots.length).toBeGreaterThan(0);
    expect(maxStart(slots)).toBeLessThanOrEqual(17 * 60 + 10 - 50); // last 50-min slot ends by 17:10
    expect(slots.some((s) => toMin(s.startTime) >= 17 * 60 + 20)).toBe(false); // no evening slots
  });

  test('SWE 412 (R-06-exempt) gets evening lecture slots too (up to 22:00)', () => {
    const slots = generateSlots('ONE_DAY_50', 'UG', 'SWE 412');
    expect(slots.some((s) => toMin(s.startTime) >= 17 * 60 + 20)).toBe(true);  // evening exists now
    expect(maxStart(slots) + 50).toBeLessThanOrEqual(22 * 60);                 // last 50-min slot ends by 22:00 (30-min step)
    expect(maxStart(slots)).toBeGreaterThan(17 * 60 + 10 - 50);               // extends well past the UG-only ceiling
  });

  test('lab generator is R-06-aware too — SWE 412 labs reach the evening, normal courses do not', () => {
    const normal = generateLabSlots('UG', { duration: 50 }, 'SWE 363');
    const exempt = generateLabSlots('UG', { duration: 50 }, 'SWE 412');
    expect(normal.some((s) => toMin(s.startTime) >= 17 * 60 + 20)).toBe(false);
    expect(exempt.some((s) => toMin(s.startTime) >= 17 * 60 + 20)).toBe(true);
  });

  test('no courseCode → unchanged strict UG/GR behavior (no accidental exemption)', () => {
    const ug = generateSlots('ONE_DAY_50', 'UG');
    const gr = generateSlots('ONE_DAY_50', 'GR');
    expect(maxStart(ug)).toBeLessThanOrEqual(17 * 60 + 10 - 50);
    expect(Math.min(...gr.map((s) => toMin(s.startTime)))).toBeGreaterThanOrEqual(17 * 60 + 20);
  });
});
