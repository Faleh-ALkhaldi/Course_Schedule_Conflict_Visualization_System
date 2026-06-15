// NEW-FU-238: unit tests for sectionPattern.validateSectionPattern.
//
// Each row of the (credits × day-pattern × duration) table from
// FU-236 gets a success test pinning the legal combination, plus a
// matching violation test confirming the rejection is informative.
// The lab single-rule + the credit cap each get their own tests.

const {
  validateSectionPattern,
  DUR_50, DUR_75, DUR_160,
  legalPatternsForCourse, resolvePattern, PATTERN_DEFS,
} = require('../../src/domain/sectionPattern');

// Helper: build a candidate section input with sane defaults so each
// test only states what matters. startTime is fixed; endTime is set
// based on `duration` so callers can write `duration: 50` ergonomically.
const mk = (opts) => {
  const { credits = 3, hasLab = false, sectionType = 'Lec', days, duration } = opts;
  const startMin = 8 * 60; // 08:00 — arbitrary, valid
  const endMin   = startMin + duration;
  const pad = n => String(n).padStart(2, '0');
  const fmt = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return {
    credits, hasLab, sectionType, days,
    startTime: fmt(startMin),
    endTime:   fmt(endMin),
  };
};

describe('validateSectionPattern - lecture rule table', () => {
  // ── 1 credit ────────────────────────────────────────────────────────
  test('1-credit · 50 min · single day Sun–Thu → ok', () => {
    for (const d of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
      const r = validateSectionPattern(mk({ credits: 1, days: [d], duration: DUR_50 }));
      expect(r).toEqual({ ok: true });
    }
  });
  test('1-credit · 50 min · two days → rejected', () => {
    const r = validateSectionPattern(mk({ credits: 1, days: ['Sunday','Tuesday'], duration: DUR_50 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1-credit/);
  });
  test('1-credit · 75 min · one day → rejected (wrong duration)', () => {
    const r = validateSectionPattern(mk({ credits: 1, days: ['Sunday'], duration: DUR_75 }));
    expect(r.ok).toBe(false);
  });

  // ── 2 credits ───────────────────────────────────────────────────────
  test('2-credit · 50 min · Sun+Tue (with gap) → ok', () => {
    const r = validateSectionPattern(mk({ credits: 2, days: ['Sunday','Tuesday'], duration: DUR_50 }));
    expect(r).toEqual({ ok: true });
  });
  test('2-credit · 50 min · Mon+Wed (with gap) → ok', () => {
    const r = validateSectionPattern(mk({ credits: 2, days: ['Monday','Wednesday'], duration: DUR_50 }));
    expect(r).toEqual({ ok: true });
  });
  test('2-credit · 50 min · Tue+Thu (with gap) → ok', () => {
    const r = validateSectionPattern(mk({ credits: 2, days: ['Tuesday','Thursday'], duration: DUR_50 }));
    expect(r).toEqual({ ok: true });
  });
  test('2-credit · 50 min · Sun+Mon (NO gap) → rejected', () => {
    const r = validateSectionPattern(mk({ credits: 2, days: ['Sunday','Monday'], duration: DUR_50 }));
    expect(r.ok).toBe(false);
  });
  test('2-credit · 75 min → rejected (FU-532: 75 min is 3/4-credit only)', () => {
    const r = validateSectionPattern(mk({ credits: 2, days: ['Wednesday'], duration: DUR_75 }));
    expect(r.ok).toBe(false);
  });
  test('2-credit · 75 min · two days → rejected', () => {
    const r = validateSectionPattern(mk({ credits: 2, days: ['Sunday','Tuesday'], duration: DUR_75 }));
    expect(r.ok).toBe(false);
  });

  // ── 3 credits (no lab) ──────────────────────────────────────────────
  test('3-credit · 50 min · Sun+Tue+Thu → ok (most common)', () => {
    const r = validateSectionPattern(mk({
      credits: 3, days: ['Sunday','Tuesday','Thursday'], duration: DUR_50,
    }));
    expect(r).toEqual({ ok: true });
  });
  test('3-credit · 75 min · Mon+Wed → ok', () => {
    const r = validateSectionPattern(mk({ credits: 3, days: ['Monday','Wednesday'], duration: DUR_75 }));
    expect(r).toEqual({ ok: true });
  });
  test('3-credit · 75 min · Sun+Tue → ok', () => {
    const r = validateSectionPattern(mk({ credits: 3, days: ['Sunday','Tuesday'], duration: DUR_75 }));
    expect(r).toEqual({ ok: true });
  });
  test('3-credit · 75 min · Tue+Thu → ok', () => {
    const r = validateSectionPattern(mk({ credits: 3, days: ['Tuesday','Thursday'], duration: DUR_75 }));
    expect(r).toEqual({ ok: true });
  });
  test('3-credit · 50 min · 2 days (no lab) → rejected', () => {
    // 2-day 50-min lecture is only legal when paired with a lab. Without
    // hasLab=true this combination is rejected.
    const r = validateSectionPattern(mk({
      credits: 3, hasLab: false, days: ['Sunday','Tuesday'], duration: DUR_50,
    }));
    expect(r.ok).toBe(false);
  });

  // ── 3 credits WITH lab ──────────────────────────────────────────────
  test('3-credit · 50 min · Sun+Tue (with lab) → ok (lecture portion)', () => {
    // hasLab=true unlocks the 2-day 50-min lecture pattern for 3-cr courses.
    const r = validateSectionPattern(mk({
      credits: 3, hasLab: true, days: ['Sunday','Tuesday'], duration: DUR_50,
    }));
    expect(r).toEqual({ ok: true });
  });
  test('3-credit · 50 min · Sun+Tue+Thu WITH lab → rejected (FU-532: +lab is a 2-day lecture)', () => {
    // The 3-day Sun/Tue/Thu 50-min lecture is the NO-lab 3-credit pattern. A 3-credit
    // course that HAS a lab meets the lecture in 2 days (ST/MW/TT) + a separate lab.
    const r = validateSectionPattern(mk({
      credits: 3, hasLab: true, days: ['Sunday','Tuesday','Thursday'], duration: DUR_50,
    }));
    expect(r.ok).toBe(false);
  });
  test('3-credit · 50 min · Sun+Tue WITH lab → ok (2-day lecture + lab)', () => {
    const r = validateSectionPattern(mk({
      credits: 3, hasLab: true, days: ['Sunday','Tuesday'], duration: DUR_50,
    }));
    expect(r).toEqual({ ok: true });
  });

  // ── 4 credits — ALWAYS has lab; lecture portion follows 3-credit rules ──
  test('4-credit · 50 min · Sun+Tue+Thu (has lab) → ok', () => {
    const r = validateSectionPattern(mk({
      credits: 4, hasLab: true, days: ['Sunday','Tuesday','Thursday'], duration: DUR_50,
    }));
    expect(r).toEqual({ ok: true });
  });
  test('4-credit · without lab → rejected at credit-cap layer', () => {
    const r = validateSectionPattern(mk({
      credits: 4, hasLab: false, days: ['Sunday','Tuesday','Thursday'], duration: DUR_50,
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/4-credit.*must have a lab/i);
  });
});

describe('validateSectionPattern - lab rule', () => {
  test('Lab · 50 min · single day → ok', () => {
    const r = validateSectionPattern(mk({
      credits: 3, hasLab: true, sectionType: 'Lab',
      days: ['Wednesday'], duration: DUR_50,
    }));
    expect(r).toEqual({ ok: true });
  });
  test('Lab · 75 min · single day → ok', () => {
    const r = validateSectionPattern(mk({
      credits: 3, hasLab: true, sectionType: 'Lab',
      days: ['Sunday'], duration: DUR_75,
    }));
    expect(r).toEqual({ ok: true });
  });
  test('Lab · 160 min (2h 40m) · single day → ok', () => {
    const r = validateSectionPattern(mk({
      credits: 4, hasLab: true, sectionType: 'Lab',
      days: ['Tuesday'], duration: DUR_160,
    }));
    expect(r).toEqual({ ok: true });
  });
  test('Lab · 165 min (former max, now illegal) → rejected', () => {
    const r = validateSectionPattern(mk({
      credits: 4, hasLab: true, sectionType: 'Lab',
      days: ['Tuesday'], duration: 165,
    }));
    expect(r.ok).toBe(false);
  });
  test('Lab · 90 min (illegal duration) → rejected', () => {
    const r = validateSectionPattern(mk({
      credits: 3, hasLab: true, sectionType: 'Lab',
      days: ['Monday'], duration: 90,
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Lab.*50.*75.*160/);
  });
  test('Lab · 50 min · two days → rejected (lab is single-day only)', () => {
    const r = validateSectionPattern(mk({
      credits: 3, hasLab: true, sectionType: 'Lab',
      days: ['Sunday','Tuesday'], duration: DUR_50,
    }));
    expect(r.ok).toBe(false);
  });
  test('Lab on a course without hasLab → rejected', () => {
    const r = validateSectionPattern(mk({
      credits: 3, hasLab: false, sectionType: 'Lab',
      days: ['Sunday'], duration: DUR_50,
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured to have a lab/i);
  });
});

describe('validateSectionPattern - credit cap', () => {
  test('5 credits → rejected', () => {
    const r = validateSectionPattern(mk({
      credits: 5, days: ['Sunday','Tuesday','Thursday'], duration: DUR_50,
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/0, 1, 2, 3, or 4 credits/);
  });
  test('0-credit (capstone SWE 413) · 50 min · single day → ok', () => {
    const r = validateSectionPattern(mk({
      credits: 0, days: ['Sunday'], duration: DUR_50,
    }));
    expect(r).toEqual({ ok: true });
  });
  test('0-credit · 75 min or multi-day → rejected', () => {
    expect(validateSectionPattern(mk({ credits: 0, days: ['Sunday'], duration: DUR_75 })).ok).toBe(false);
    expect(validateSectionPattern(mk({ credits: 0, days: ['Sunday','Tuesday'], duration: DUR_50 })).ok).toBe(false);
  });
});

describe('validateSectionPattern - format guards', () => {
  test('invalid sectionType → rejected', () => {
    const r = validateSectionPattern(mk({
      credits: 3, sectionType: 'Workshop',
      days: ['Sunday','Tuesday','Thursday'], duration: DUR_50,
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid sectionType/);
  });
  test('empty day list → rejected', () => {
    const r = validateSectionPattern(mk({ credits: 1, days: [], duration: DUR_50 }));
    expect(r.ok).toBe(false);
  });
  test('Saturday → rejected (KFUPM week is Sun–Thu)', () => {
    const r = validateSectionPattern(mk({ credits: 1, days: ['Saturday'], duration: DUR_50 }));
    expect(r.ok).toBe(false);
  });
  test('end before start → rejected', () => {
    const r = validateSectionPattern({
      credits: 1, hasLab: false, sectionType: 'Lec',
      days: ['Sunday'], startTime: '10:00', endTime: '09:00',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/endTime must be after startTime/i);
  });
});

// NEW-FU-243: tests for the per-course pattern catalog used by the
// Suggest modal (FU-242) and the SuggestService (FU-241).
describe('legalPatternsForCourse', () => {
  // Helper: pull just the `value` field for ergonomic assertions.
  const values = (arr) => arr.map(p => p.value);

  test('1-credit → [ONE_DAY_50]', () => {
    expect(values(legalPatternsForCourse({ credits: 1, hasLab: false }))).toEqual(['ONE_DAY_50']);
  });

  test('2-credit → 3 × 2-day-50 only (FU-532: no 75 min for 2-credit)', () => {
    expect(values(legalPatternsForCourse({ credits: 2, hasLab: false }))).toEqual(
      ['ST_50', 'MW_50', 'TT_50']
    );
  });

  test('0-credit (capstone) → [ONE_DAY_50]', () => {
    expect(values(legalPatternsForCourse({ credits: 0, hasLab: false }))).toEqual(['ONE_DAY_50']);
  });

  test('3-credit no lab → 3-day 50min + 2-day 75min (STT 50, MW/ST/TT 75)', () => {
    expect(values(legalPatternsForCourse({ credits: 3, hasLab: false }))).toEqual(
      ['STT_50', 'MW_75', 'ST_75', 'TT_75']
    );
  });

  test('3-credit WITH lab → 2-day lecture (50 + 75), never the 3-day Sun/Tue/Thu', () => {
    expect(values(legalPatternsForCourse({ credits: 3, hasLab: true }))).toEqual(
      ['ST_50', 'MW_50', 'TT_50', 'MW_75', 'ST_75', 'TT_75']
    );
  });

  test('4-credit → 3-day 50min + 2-day 75min (matches 3-credit no-lab)', () => {
    expect(values(legalPatternsForCourse({ credits: 4, hasLab: true }))).toEqual(
      ['STT_50', 'MW_75', 'ST_75', 'TT_75']
    );
  });

  test('invalid credits → empty list', () => {
    expect(legalPatternsForCourse({ credits: 5, hasLab: false })).toEqual([]);
    expect(legalPatternsForCourse({ credits: -1, hasLab: false })).toEqual([]);
  });

  test('every returned entry carries the label + note pair', () => {
    const out = legalPatternsForCourse({ credits: 3, hasLab: true });
    for (const p of out) {
      expect(typeof p.label).toBe('string');
      expect(typeof p.note).toBe('string');
      expect(p.days).toBeDefined();
      expect(typeof p.duration).toBe('number');
    }
  });
});

describe('resolvePattern', () => {
  test('canonical pattern names resolve to {dayCombos, duration}', () => {
    expect(resolvePattern('STT_50')).toEqual({
      dayCombos: [['Sunday', 'Tuesday', 'Thursday']],
      duration: 50,
    });
    expect(resolvePattern('MW_75')).toEqual({
      dayCombos: [['Monday', 'Wednesday']],
      duration: 75,
    });
  });

  test('ONE_DAY_50 expands to 5 single-day combos for the greedy iterator', () => {
    const r = resolvePattern('ONE_DAY_50');
    expect(r.duration).toBe(50);
    expect(r.dayCombos).toHaveLength(5);
    expect(r.dayCombos).toEqual([
      ['Sunday'], ['Monday'], ['Tuesday'], ['Wednesday'], ['Thursday'],
    ]);
  });

  test('legacy STT and MW aliases still work', () => {
    expect(resolvePattern('STT')).toEqual(resolvePattern('STT_50'));
    expect(resolvePattern('MW')).toEqual(resolvePattern('MW_75'));
  });

  test('unknown pattern → null', () => {
    expect(resolvePattern('BOGUS')).toBeNull();
    expect(resolvePattern('')).toBeNull();
  });

  test('every PATTERN_DEFS entry is resolvable (catalog ↔ resolver consistency)', () => {
    // Self-consistency check: every name registered in PATTERN_DEFS
    // must resolve. Catches the bug where someone adds an entry to
    // PATTERN_DEFS but forgets the resolver path.
    for (const name of Object.keys(PATTERN_DEFS)) {
      const r = resolvePattern(name);
      expect(r).not.toBeNull();
      expect(Array.isArray(r.dayCombos)).toBe(true);
      expect(r.dayCombos.length).toBeGreaterThan(0);
      expect([50, 75]).toContain(r.duration);
    }
  });
});

// NEW-FU-250: tests for the two-axis pattern model from FU-247.
describe('legalDurationsForCourse', () => {
  const { legalDurationsForCourse, DUR_50, DUR_75 } = require('../../src/domain/sectionPattern');

  test('1-credit → [50]', () => {
    expect(legalDurationsForCourse({ credits: 1, hasLab: false })).toEqual([DUR_50]);
  });
  test('0-credit → [50]', () => {
    expect(legalDurationsForCourse({ credits: 0, hasLab: false })).toEqual([DUR_50]);
  });
  test('2-credit → [50] only (FU-532: 75 min is 3/4-credit only)', () => {
    expect(legalDurationsForCourse({ credits: 2, hasLab: false })).toEqual([DUR_50]);
  });
  test('3-credit no lab → [50, 75]', () => {
    expect(legalDurationsForCourse({ credits: 3, hasLab: false })).toEqual([DUR_50, DUR_75]);
  });
  test('3-credit with lab → [50, 75] (same set; lab adds day combos, not durations)', () => {
    expect(legalDurationsForCourse({ credits: 3, hasLab: true })).toEqual([DUR_50, DUR_75]);
  });
  test('4-credit → [50, 75]', () => {
    expect(legalDurationsForCourse({ credits: 4, hasLab: true })).toEqual([DUR_50, DUR_75]);
  });
  test('invalid credits → []', () => {
    expect(legalDurationsForCourse({ credits: 5, hasLab: true })).toEqual([]);
    expect(legalDurationsForCourse({ credits: -1, hasLab: false })).toEqual([]);
  });
});

describe('legalDayTemplatesForCourse', () => {
  const { legalDayTemplatesForCourse, DUR_50, DUR_75 } = require('../../src/domain/sectionPattern');
  const T = (c, hasLab, d) => legalDayTemplatesForCourse({ credits: c, hasLab, duration: d });

  test('1-credit · 50 → [ONE_DAY]', () => {
    expect(T(1, false, DUR_50)).toEqual(['ONE_DAY']);
  });
  test('2-credit · 50 → [ST, MW, TT]', () => {
    expect(T(2, false, DUR_50)).toEqual(['ST', 'MW', 'TT']);
  });
  test('0-credit · 50 → [ONE_DAY] (capstone SWE 413)', () => {
    expect(T(0, false, DUR_50)).toEqual(['ONE_DAY']);
  });
  test('2-credit · 75 → [] (FU-532: 75 min is 3/4-credit only)', () => {
    expect(T(2, false, DUR_75)).toEqual([]);
  });
  test('3-credit no-lab · 50 → [STT] (3 meetings)', () => {
    expect(T(3, false, DUR_50)).toEqual(['STT']);
  });
  test('3-credit +lab · 50 → [ST, MW, TT] (2 lecture meetings; the 3-day belongs to no-lab)', () => {
    expect(T(3, true, DUR_50)).toEqual(['ST', 'MW', 'TT']);
  });
  test('3-credit · 75 (with or without lab) → [MW, ST, TT]', () => {
    expect(T(3, false, DUR_75)).toEqual(['MW', 'ST', 'TT']);
    expect(T(3, true,  DUR_75)).toEqual(['MW', 'ST', 'TT']);
  });
  test('4-credit · 50 → [STT] only (3 meetings + lab)', () => {
    expect(T(4, true, DUR_50)).toEqual(['STT']);
  });
  test('illegal (credits, duration) combo → []', () => {
    expect(T(1, false, DUR_75)).toEqual([]); // 1-credit doesn't get 75min
    expect(T(2, false, DUR_75)).toEqual([]); // 2-credit doesn't get 75min
    expect(T(99, false, DUR_50)).toEqual([]);
  });
});

describe('resolvePattern accepts two-axis input', () => {
  const { resolvePattern, DUR_50, DUR_75 } = require('../../src/domain/sectionPattern');

  test('{dayPattern: STT, duration: 50} ≡ legacy STT_50', () => {
    const a = resolvePattern({ dayPattern: 'STT', duration: 50 });
    const b = resolvePattern('STT_50');
    expect(a).toEqual(b);
  });
  test('{dayPattern: ONE_DAY, duration: 75} expands to 5 single-day combos × 75min', () => {
    const r = resolvePattern({ dayPattern: 'ONE_DAY', duration: 75 });
    expect(r.duration).toBe(75);
    expect(r.dayCombos).toHaveLength(5);
  });
  test('unknown dayPattern → null', () => {
    expect(resolvePattern({ dayPattern: 'BOGUS', duration: 50 })).toBeNull();
  });
  test('invalid duration (e.g. 90) → null', () => {
    expect(resolvePattern({ dayPattern: 'STT', duration: 90 })).toBeNull();
  });
  test('object without dayPattern → falls back to legacy string path (null for non-string)', () => {
    expect(resolvePattern({ duration: 50 })).toBeNull();
  });
});

describe('decomposeLegacyName', () => {
  const { decomposeLegacyName, DUR_50, DUR_75 } = require('../../src/domain/sectionPattern');
  test('STT_50 → { template: STT, duration: 50 }', () => {
    expect(decomposeLegacyName('STT_50')).toEqual({ template: 'STT', duration: DUR_50 });
  });
  test('ONE_DAY_75 → { template: ONE_DAY, duration: 75 } (underscore in template handled)', () => {
    expect(decomposeLegacyName('ONE_DAY_75')).toEqual({ template: 'ONE_DAY', duration: DUR_75 });
  });
  test('legacy STT alias → STT_50 decomposition', () => {
    expect(decomposeLegacyName('STT')).toEqual({ template: 'STT', duration: DUR_50 });
  });
  test('unknown name → null', () => {
    expect(decomposeLegacyName('BOGUS')).toBeNull();
  });
});

// NEW-FU-256: tests for the per-day constraint on ONE_DAY templates.
// FU-252 added an optional `day` field to resolvePattern's input;
// when supplied it filters the synthetic 5-day expansion down to
// exactly one specific weekday. Multi-day templates (STT/MW/ST/TT)
// ignore the field — their days are inherent to the template.
describe('resolvePattern with explicit day', () => {
  const { resolvePattern } = require('../../src/domain/sectionPattern');

  test('ONE_DAY + day=Tuesday → exactly one dayCombo ["Tuesday"]', () => {
    const r = resolvePattern({ dayPattern: 'ONE_DAY', duration: 50, day: 'Tuesday' });
    expect(r.dayCombos).toEqual([['Tuesday']]);
    expect(r.duration).toBe(50);
  });
  test('ONE_DAY + day=Wednesday + 75min → ["Wednesday"] at 75min', () => {
    const r = resolvePattern({ dayPattern: 'ONE_DAY', duration: 75, day: 'Wednesday' });
    expect(r.dayCombos).toEqual([['Wednesday']]);
    expect(r.duration).toBe(75);
  });
  test('ONE_DAY without day → still expands to all 5 (backward-compat)', () => {
    const r = resolvePattern({ dayPattern: 'ONE_DAY', duration: 50 });
    expect(r.dayCombos).toHaveLength(5);
  });
  test('ONE_DAY + day=Friday → null (weekend not legal at KFUPM)', () => {
    expect(resolvePattern({ dayPattern: 'ONE_DAY', duration: 50, day: 'Friday' })).toBeNull();
  });
  test('ONE_DAY + day=Bogus → null', () => {
    expect(resolvePattern({ dayPattern: 'ONE_DAY', duration: 50, day: 'NotADay' })).toBeNull();
  });
  test('STT + day=Tuesday → day is IGNORED (multi-day template)', () => {
    // STT is fundamentally Sun+Tue+Thu; passing `day` shouldn't
    // narrow it (that would break the lecture pattern).
    const r = resolvePattern({ dayPattern: 'STT', duration: 50, day: 'Tuesday' });
    expect(r.dayCombos).toEqual([['Sunday', 'Tuesday', 'Thursday']]);
  });
});
