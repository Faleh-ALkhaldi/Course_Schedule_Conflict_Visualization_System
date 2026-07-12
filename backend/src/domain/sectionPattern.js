// NEW-FU-236: KFUPM section scheduling-pattern validator.
//
// The existing controller-layer validators check format-level things
// (HH:MM time strings, day enum, section_number range by Lec/Lab).
// This module enforces the next layer up — KFUPM's actual scheduling
// conventions for the (credits × day-pattern × duration) triple.
//
// A section that passes this validator can still be REJECTED by the
// schedule guard (FU-201 archived schedule), the section_number
// uniqueness constraint, or the conflict engine — those are separate
// concerns. This module ONLY answers "is this combination of
// credits, days, and duration a legal KFUPM pattern?"
//
// Data structure: each row of the rule table is independent. The
// matcher walks rows for the relevant (credits, sectionType) and
// asks each whether the candidate section matches. First match wins.
// No fall-through ambiguity — every legal pattern has exactly one
// matching row.

// Valid weekdays as ordered ints so we can do day-gap checks.
const DAY_INDEX = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4 };
const VALID_DAYS = new Set(Object.keys(DAY_INDEX));

// Standard durations in minutes.
const DUR_50  = 50;
const DUR_75  = 75;
const DUR_100 = 100;
const DUR_160 = 160;   // 2h 40m — lab/project

// Per-row helpers. Each rule has a `match` predicate that takes
// `{ days, duration }` and returns true if the candidate fits. We
// keep the predicates expressive (named functions) rather than tiny
// arrow lambdas so the rule list reads like a spec.
function sameDays(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.every((d, i) => d === b[i]);
}
function anyDay(days) {
  return Array.isArray(days) && days.length === 1 && VALID_DAYS.has(days[0]);
}
function twoDayWithGap(days) {
  // The 2-credit-50min rule and the 3-credit-75min rule both require
  // 2 days with a 1-day gap. KFUPM's accepted combos: Sun+Tue (gap=2),
  // Mon+Wed (gap=2), Tue+Thu (gap=2). The first and last day of the
  // week (Sun, Thu) are 1 apart from each other only through the
  // week — not legal here.
  if (!Array.isArray(days) || days.length !== 2) return false;
  if (!days.every(d => VALID_DAYS.has(d))) return false;
  const ALLOWED_2DAY = [['Sunday','Tuesday'], ['Monday','Wednesday'], ['Tuesday','Thursday']];
  return ALLOWED_2DAY.some(pair => sameDays(days, pair));
}

// NEW-FU-561 (audit P3): removed the dead, divergent LEC_RULES table (and lectureRulesFor
// below) — the lecture-pattern rules now live in legalDurationsForCourse /
// legalDayTemplatesForCourse (the live single source of truth, mirrored on the frontend).
// The old table was unused by validateSectionPattern yet read as "the spec", so it was a
// drift hazard.

// LAB rule — single rule that matches by duration AND single-day.
const LAB_RULE = {
  name: 'Lab · 50 / 75 / 160 min · single day Sun–Thu',
  match: ({ days, duration }) =>
    [DUR_50, DUR_75, DUR_160].includes(duration) && anyDay(days),
};

function durationMinutes(startTime, endTime) {
  // Both are HH:MM strings (already validated by the controllers).
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}


/**
 * Validate a section against KFUPM's scheduling patterns.
 *
 * @param {object} input
 * @param {number} input.credits      - 1, 2, 3, or 4. Rejected otherwise.
 * @param {boolean} input.hasLab      - whether the course is configured to have a lab.
 *                                       (4-credit always has a lab; some 3-credit do.)
 * @param {'Lec'|'Lab'} input.sectionType
 * @param {string[]} input.days       - e.g. ['Sunday','Tuesday','Thursday']
 * @param {string} input.startTime    - 'HH:MM'
 * @param {string} input.endTime      - 'HH:MM'
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateSectionPattern({ credits, hasLab, sectionType, days, startTime, endTime }) {
  // NEW-FU-688: a TIME-LESS (info-only) section — no day and no times — is always valid. Off-campus
  // training (Summer Training / Internship), thesis, research, and an untimed project exist as side-
  // panel information with no meeting; there is no pattern to enforce. (A section with SOME of day/
  // start/end but not all still falls through to the normal checks, which reject the partial state.)
  if ((days == null || days.length === 0) && !startTime && !endTime) {
    return { ok: true };
  }
  // Credit cap — domain-level invariant. KFUPM has no 0 or 5+ credit
  // courses, and 4-credit courses must have a lab. Caller is
  // expected to enforce these at the course level too; we double-
  // check here so a stray section can't slip through.
  if (![0, 1, 2, 3, 4].includes(Number(credits))) {
    return { ok: false, error: `Invalid credits ${credits}. Courses must be 0, 1, 2, 3, or 4 credits.` };
  }
  if (credits === 4 && !hasLab) {
    return { ok: false, error: '4-credit courses must have a lab section. Set hasLab on the course or use 3 credits.' };
  }
  if (!['Lec', 'Lab', 'Prj', 'Ths', 'Sem'].includes(sectionType)) {
    return { ok: false, error: `Invalid sectionType "${sectionType}". Expected "Lec", "Lab", "Prj", "Ths", or "Sem".` };
  }
  if (!Array.isArray(days) || days.length === 0 || !days.every(d => VALID_DAYS.has(d))) {
    return { ok: false, error: `Invalid days ${JSON.stringify(days)}. Expected non-empty subset of Sunday–Thursday.` };
  }
  const duration = durationMinutes(startTime, endTime);
  if (duration <= 0) {
    return { ok: false, error: `endTime must be after startTime (got ${duration} min).` };
  }

  // Project sections may be untimed; when timed, they are exactly one meeting
  // day with one of the registrar-supported project block lengths.
  if (sectionType === 'Prj') {
    if (!anyDay(days)) {
      return { ok: false, error: `A Project meets on a single day when timed (got ${days.join('+') || 'none'}).` };
    }
    if (![DUR_50, DUR_75, DUR_100, DUR_160].includes(duration)) {
      return { ok: false, error: `Project section duration must be 50, 75, 100, or 160 minutes (got ${duration}).` };
    }
    return { ok: true };
  }

  if (sectionType === 'Ths') {
    return { ok: false, error: 'Thesis sections are information-only and must not have a meeting time.' };
  }

  // NEW-FU-688 / FU-689: a Seminar meets on a SINGLE day for EXACTLY 75 minutes (a graduate seminar
  // block — distinct from a 1-credit Lecture's fixed 50 min). One day, one fixed duration. The
  // Graduate-only constraint is enforced at the section-create/import gate (it needs the course's
  // category, which the pure pattern validator does not carry).
  if (sectionType === 'Sem') {
    if (days.length !== 1) {
      return { ok: false, error: `A Seminar meets on a single day (got ${days.join('+') || 'none'}).` };
    }
    if (duration !== 75) {
      return { ok: false, error: `A Seminar section must be exactly 75 minutes (got ${duration}).` };
    }
    return { ok: true };
  }

  // Lab section — single rule, applies regardless of credits.
  if (sectionType === 'Lab') {
    if (!hasLab) {
      return { ok: false, error: 'Lab section requested but the course is not configured to have a lab.' };
    }
    if (!LAB_RULE.match({ days, duration })) {
      return {
        ok: false,
        error: `Lab section pattern not allowed. Lab must be 50, 75, or 160 minutes on a single day. Got ${days.join('+')} for ${duration} min.`,
      };
    }
    return { ok: true };
  }

  // Lecture section — match against the credit-driven legal pattern set.
  // legalDayTemplatesForCourse + legalDurationsForCourse are the SINGLE SOURCE OF
  // TRUTH (mirrored on the frontend), so the validator, the picker, and Suggest can
  // never drift. NEW-FU-532 (Batch 11): 75 min is 3/4-credit 2-day only; 50-min
  // meetings-per-week is dictated by credits.
  const c = Number(credits);
  const durOk = legalDurationsForCourse({ credits: c, hasLab }).includes(duration);
  const templates = durOk ? legalDayTemplatesForCourse({ credits: c, hasLab, duration }) : [];
  const matched = templates.some(t =>
    t === 'ONE_DAY' ? anyDay(days) : sameDays(days, DAY_TEMPLATES[t]));
  if (matched) return { ok: true };

  // Clear, plain-language error listing what IS allowed for this course.
  const legal = [];
  for (const dur of legalDurationsForCourse({ credits: c, hasLab })) {
    for (const t of legalDayTemplatesForCourse({ credits: c, hasLab, duration: dur })) {
      legal.push(`${dur} min on ${t === 'ONE_DAY' ? 'any single day' : DAY_TEMPLATE_LABELS[t]}`);
    }
  }
  return {
    ok: false,
    error:
      `${days.join('+')} for ${duration} min isn't a valid pattern for a ${c}-credit ` +
      `${hasLab ? 'with-lab ' : ''}course. Allowed: ${legal.join('; ') || 'none'}.`,
  };
}

// NEW-FU-240: per-(credits, hasLab) pattern catalog used by the
// Auto-Suggest modal and the SuggestService. Each entry is a stable
// machine name that the suggester resolves to a {days, duration}
// tuple via PATTERN_DEFS below.
//
// Naming convention: <DAY_TOKEN>_<DURATION_MIN>. DAY_TOKEN encodes
// the days; for single-day patterns the suggester iterates over the
// 5-day window to let the greedy phase pick the conflict-minimizing
// day, so we use ONE_DAY_* as a synthetic token.
//
// IMPORTANT: this enum is mirrored on the frontend (SuggestModal).
// Adding a value here means updating the frontend mirror. The
// validator (validateSectionPattern above) doesn't care about these
// names — it operates on the raw (days, duration) tuple, which is
// what the SuggestService passes through.
const PATTERN_DEFS = {
  STT_50:     { days: ['Sunday','Tuesday','Thursday'], duration: DUR_50 },
  MW_75:      { days: ['Monday','Wednesday'],           duration: DUR_75 },
  ST_75:      { days: ['Sunday','Tuesday'],             duration: DUR_75 },
  TT_75:      { days: ['Tuesday','Thursday'],           duration: DUR_75 },
  ST_50:      { days: ['Sunday','Tuesday'],             duration: DUR_50 },
  MW_50:      { days: ['Monday','Wednesday'],           duration: DUR_50 },
  TT_50:      { days: ['Tuesday','Thursday'],           duration: DUR_50 },
  // ONE_DAY_* — synthetic. The suggester expands these into 5
  // (one-day combos × time-range) candidates so the greedy phase
  // picks the best day. Modal shows them as a single "Any day" entry.
  ONE_DAY_50: { days: '__ANY__', duration: DUR_50 },
  ONE_DAY_75: { days: '__ANY__', duration: DUR_75 },
};
const PATTERN_LABELS = {
  STT_50:     { label: 'Sun / Tue / Thu', note: '50 min/class' },
  MW_75:      { label: 'Mon / Wed',       note: '75 min/class' },
  ST_75:      { label: 'Sun / Tue',       note: '75 min/class' },
  TT_75:      { label: 'Tue / Thu',       note: '75 min/class' },
  ST_50:      { label: 'Sun / Tue',       note: '50 min/class' },
  MW_50:      { label: 'Mon / Wed',       note: '50 min/class' },
  TT_50:      { label: 'Tue / Thu',       note: '50 min/class' },
  ONE_DAY_50: { label: 'Any day',         note: '50 min/class' },
  ONE_DAY_75: { label: 'Any day',         note: '75 min/class' },
};

// NEW-FU-247: two-axis pattern model. The single-name PATTERN_DEFS
// above bundles (days, duration) into one enum value — fine for the
// suggester's internal lookups but mismatched with the modal UX, where
// the user thinks "I want a 75min class" and THEN "which days?".
// DAY_TEMPLATES below carries just the day combinations; durations
// are a separate axis the modal lets the user choose explicitly.
//
// Naming: every value in PATTERN_DEFS is "<TEMPLATE>_<DURATION>" so
// each legacy enum entry decomposes cleanly:
//   STT_50    → { template: 'STT', duration: 50 }
//   ONE_DAY_75 → { template: 'ONE_DAY', duration: 75 }
// resolvePattern() accepts EITHER shape so the new {dayPattern, duration}
// payload from the modal AND the legacy single-name from older callers
// both produce the same dayCombos/duration output.
const DAY_TEMPLATES = {
  STT:     ['Sunday', 'Tuesday', 'Thursday'],
  MW:      ['Monday', 'Wednesday'],
  ST:      ['Sunday', 'Tuesday'],
  TT:      ['Tuesday', 'Thursday'],
  ONE_DAY: '__ANY__',
};
const DAY_TEMPLATE_LABELS = {
  STT:     'Sun / Tue / Thu',
  MW:      'Mon / Wed',
  ST:      'Sun / Tue',
  TT:      'Tue / Thu',
  ONE_DAY: 'Any day',
};

// The legal duration set per (credits, hasLab). Mirrors the
// validator's rule table.
// NEW-FU-532 (Batch 11): the legal duration set per credits. 75 min is reserved for
// 3- and 4-credit courses (a 2-day pattern); 0/1/2-credit courses are 50 min only.
function legalDurationsForCourse({ credits, hasLab, isSeminar }) {
  if (isSeminar) return [DUR_75];
  const c = Number(credits);
  if (c === 0 || c === 1 || c === 2) return [DUR_50];
  if (c === 3 || c === 4) return [DUR_50, DUR_75];
  return [];
}

// The legal day-templates per (credits, hasLab, duration). Renders
// the second-step buttons in the modal once duration is chosen.
//
// Key per-credit rules:
//   1-cr · 50  → ONE_DAY only
//   2-cr · 50  → 3 two-day combos (ST/MW/TT)
//   2-cr · 75  → ONE_DAY
//   3-cr · 50  → STT always; ST/MW/TT only when hasLab (matches
//                FU-236 "2-day 50min lecture requires lab" rule)
//   3-cr · 75  → MW, ST, TT
//   4-cr · 50  → STT + ST/MW/TT (always has lab)
//   4-cr · 75  → MW, ST, TT
// NEW-FU-532 (Batch 11): legal day-templates per (credits, hasLab, duration).
//   • 75 min → 3/4-credit only, ALWAYS a 2-day pattern (Mon/Wed, Sun/Tue, Tue/Thu).
//   • 50 min → meetings-per-week is dictated by the credits:
//       0 cr (capstone SWE 413) → 1 meeting   1 cr → 1 meeting
//       2 cr (no lab)           → 2 meetings   3 cr no-lab → 3 meetings (Sun/Tue/Thu)
//       3 cr +lab               → 2 lecture meetings (+ a separate lab)
//       4 cr (+lab)             → 3 meetings (Sun/Tue/Thu) (+ a separate lab)
//   (Lab duration never dictates credits.)
function legalDayTemplatesForCourse({ credits, hasLab, duration, isSeminar }) {
  const c = Number(credits);
  const d = Number(duration);
  if (isSeminar) return d === DUR_75 ? ['ONE_DAY'] : [];
  if (d === DUR_75) return (c === 3 || c === 4) ? ['MW', 'ST', 'TT'] : [];
  // d === 50
  if (c === 0) return ['ONE_DAY'];
  if (c === 1) return ['ONE_DAY'];
  if (c === 2) return ['ST', 'MW', 'TT'];
  if (c === 3) return hasLab ? ['ST', 'MW', 'TT'] : ['STT'];
  if (c === 4) return ['STT'];
  return [];
}

// Decompose a legacy single-name pattern into the (template, duration)
// pair so the rest of the new code path doesn't branch on the input
// shape. STT_50 → { template:'STT', duration:50 }; ONE_DAY_75 →
// { template:'ONE_DAY', duration:75 }. Falls back to null for unknown.
function decomposeLegacyName(name) {
  if (name === 'STT') return { template: 'STT', duration: DUR_50 };
  if (name === 'MW')  return { template: 'MW',  duration: DUR_75 };
  const def = PATTERN_DEFS[name];
  if (!def) return null;
  // The PATTERN_DEFS keys are <TEMPLATE>_<DURATION>. Splitting on the
  // last `_` separates ONE_DAY_50 → ['ONE_DAY', '50']. Defensive:
  // confirm the parsed template exists in DAY_TEMPLATES.
  const idx = name.lastIndexOf('_');
  const tpl = name.slice(0, idx);
  if (!Object.prototype.hasOwnProperty.call(DAY_TEMPLATES, tpl)) return null;
  return { template: tpl, duration: def.duration };
}

/**
 * Return the legal lecture-pattern set for a course's (credits, hasLab)
 * combo. Drives the Suggest modal's per-row button rendering AND the
 * suggester's pattern-acceptance check.
 *
 * Behavior per the FU-236 rule table:
 *   • 1-credit → single-day 50min (any day)
 *   • 2-credit → 2-day-with-gap 50min (3 combos) OR 1-day 75min
 *   • 3-credit (no lab) → STT 50, MW 75, ST 75, TT 75
 *   • 3-credit (+lab)   → above + 2-day 50min alternatives
 *   • 4-credit          → same as 3+lab (always has lab — caller's
 *                         responsibility to enforce that elsewhere)
 *   • Invalid credits   → []
 *
 * @returns Array<{ value, label, note, days, duration }>
 */
function legalPatternsForCourse({ credits, hasLab, isSeminar }) {
  const c = Number(credits);
  const wrap = (name) => ({
    value: name,
    label: PATTERN_LABELS[name].label,
    note:  PATTERN_LABELS[name].note,
    days:     PATTERN_DEFS[name].days,
    duration: PATTERN_DEFS[name].duration,
  });

  // NEW-FU-532 (Batch 11): 75 min is 3/4-credit 2-day only; 50-min meetings-per-week
  // is dictated by credits; 3-credit-with-lab is a 2-day lecture (the 3-day Sun/Tue/Thu
  // belongs to no-lab 3-credit); 4-credit is a 3-day lecture (+ lab); 0-credit (SWE 413
  // capstone) is a single 50-min meeting.
  if (isSeminar) return [wrap('ONE_DAY_75')];
  if (c === 0) return [wrap('ONE_DAY_50')];
  if (c === 1) return [wrap('ONE_DAY_50')];
  if (c === 2) return ['ST_50', 'MW_50', 'TT_50'].map(wrap);
  if (c === 3 && !hasLab) return ['STT_50', 'MW_75', 'ST_75', 'TT_75'].map(wrap);
  // NEW-FU-648: a 3-credit course WITH a lab meets the LECTURE in exactly two 50-min
  // sessions (2-day pattern) + a separate lab — NOT 2×75. A 2×75 lecture delivers the full
  // 3-credit load with no room for the lab's contribution, so it's a NO-lab pattern. This is
  // the OFFERING set (drives the Suggest panel + its recommend pre-fill); the validator
  // (legalDurationsForCourse/legalDayTemplatesForCourse) stays lenient so legacy 75-min
  // with-lab lectures already in the data remain editable.
  if (c === 3 &&  hasLab) return ['ST_50', 'MW_50', 'TT_50'].map(wrap);
  if (c === 4) return ['STT_50', 'MW_75', 'ST_75', 'TT_75'].map(wrap);
  return [];
}

/**
 * Resolve a pattern into its (dayCombos, duration) tuple. Accepts two
 * shapes:
 *   • Legacy single name: 'STT_50', 'MW_75', 'ONE_DAY_50', 'STT' (alias)
 *   • New two-axis form:  { dayPattern: 'STT', duration: 50 }
 *
 * For ONE_DAY templates `dayCombos` expands to 5 single-day arrays so
 * the suggester iterates over each — same behavior as before.
 *
 * @returns null if the pattern is unknown / malformed.
 */
function resolvePattern(input) {
  // NEW-FU-247: accept the two-axis object directly so the controller
  // can pass new-shape payloads without re-stringifying them.
  // NEW-FU-252: also accept an optional `day` field that constrains
  // ONE_DAY templates to a specific weekday. If present, the
  // suggester sees exactly one dayCombo instead of all 5 — the user
  // has committed to a day, no greedy-picks-best-day expansion.
  if (input && typeof input === 'object' && input.dayPattern) {
    const tpl = input.dayPattern;
    const dur = Number(input.duration);
    if (!Object.prototype.hasOwnProperty.call(DAY_TEMPLATES, tpl)) return null;
    const allowedDurations = tpl === 'ONE_DAY'
      ? [DUR_50, DUR_75, DUR_100, DUR_160]
      : [DUR_50, DUR_75];
    if (!allowedDurations.includes(dur)) return null;
    const days = DAY_TEMPLATES[tpl];
    if (days === '__ANY__') {
      // Single-day template. Honor `day` if supplied; else expand
      // to all 5 weekdays for the greedy phase to choose.
      if (typeof input.day === 'string') {
        if (!VALID_DAYS.has(input.day)) return null;
        return { dayCombos: [[input.day]], duration: dur };
      }
      return {
        dayCombos: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'].map(d => [d]),
        duration: dur,
      };
    }
    return { dayCombos: [days], duration: dur };
  }

  // Legacy single-name path. Treat as string from here on.
  let name = input;
  if (typeof name !== 'string') return null;
  // Legacy aliases — kept so old client payloads still work.
  if (name === 'STT') name = 'STT_50';
  if (name === 'MW')  name = 'MW_75';
  const def = PATTERN_DEFS[name];
  if (!def) return null;
  if (def.days === '__ANY__') {
    return {
      dayCombos: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']
        .map(d => [d]),
      duration: def.duration,
    };
  }
  return { dayCombos: [def.days], duration: def.duration };
}

module.exports = {
  validateSectionPattern,
  // Exported for tests + auto-suggester filtering.
  LAB_RULE,
  DUR_50, DUR_75, DUR_160,
  // NEW-FU-240: pattern catalog
  PATTERN_DEFS, PATTERN_LABELS, legalPatternsForCourse, resolvePattern,
  // NEW-FU-247: two-axis pattern model — frontend uses this for the
  // duration → day-template stepped modal layout.
  DAY_TEMPLATES, DAY_TEMPLATE_LABELS,
  legalDurationsForCourse, legalDayTemplatesForCourse,
  decomposeLegacyName,
};
