// NEW-FU-159: academic term codec.
//
// Term codes are 3-digit strings `YYT` where:
//   YY = two-digit start year of the academic year (25 → AY 2025-2026)
//   T  = 1 (Fall) | 2 (Spring) | 3 (Summer)
//
// Date ranges are stable across all academic years — only the year changes.
// The TERM_CALENDAR constant below is the SINGLE source of truth for all
// term date math; UI labels, "Add term" preview, and any other code that
// needs to know the dates of a term must call decodeTerm().
//
// Examples:
//   decodeTerm('251') → Fall 2025,    Aug 25, 2025 – Dec 28, 2025
//   decodeTerm('252') → Spring 2026,  Jan 12, 2026 – May 25, 2026
//   decodeTerm('253') → Summer 2026,  Jun 14, 2026 – Aug 6, 2026

const SEASONS = {
  '1': { name: 'Fall',   yearOffset: 0, startMonth: 8, startDay: 25, endMonth: 12, endDay: 28 },
  '2': { name: 'Spring', yearOffset: 1, startMonth: 1, startDay: 12, endMonth: 5,  endDay: 25 },
  '3': { name: 'Summer', yearOffset: 1, startMonth: 6, startDay: 14, endMonth: 8,  endDay: 6  },
};

// NEW-FU-223: per-(YY, T) date overrides.
//
// The SEASONS template above uses fixed start/end days that don't match
// KFUPM's published calendar — every Fall doesn't begin Aug 25, every
// Spring doesn't end May 25. The real calendar shifts year-to-year, so
// this map carries the authoritative per-term dates whenever we know
// them. decodeTerm() consults the override first; on miss it falls back
// to the SEASONS template (so codes we don't have data for still
// produce a plausible label/span).
//
// Source: https://registrar.kfupm.edu.sa/academic-calendar/
//   • START = the calendar row "REGISTRATION CONFIRMATION through KFUPM
//     Portal; Classes Begin" (or close variant).
//   • END   = the calendar row "Last day for faculty to submit grades
//     to the Deanship (2:00 PM); Official Graduation Date" (or close
//     variant).
//
// Add an entry the moment KFUPM publishes a new year. Codes outside the
// 251–303 range guarded by FU-217 cannot be CREATED anyway, so we don't
// need overrides for 24X or 31X+.
//
// Known gap (2026-05-26): the registrar's calendar pages are JS-rendered
// and WebFetch only captured the loading state, so codes 263 and every
// 27X / 28X / 29X / 30X are still on the template fallback. Patch this
// map as those years get published.
const TERM_DATE_OVERRIDES = {
  // YY · T  · Label        · Start (M,D) · End (M,D)
  '251': { startMonth: 8, startDay: 24, endMonth: 12, endDay: 29 }, // Fall 2025
  '252': { startMonth: 1, startDay: 11, endMonth: 5,  endDay: 21 }, // Spring 2026
  '253': { startMonth: 6, startDay: 14, endMonth: 8,  endDay:  9 }, // Summer 2026
  '261': { startMonth: 8, startDay: 19, endMonth: 12, endDay: 26 }, // Fall 2026
  '262': { startMonth: 1, startDay: 10, endMonth: 6,  endDay:  8 }, // Spring 2027
  // NEW-FU-228: KFUPM published 263 between FU-223 and this commit.
  '263': { startMonth: 6, startDay: 20, endMonth: 8,  endDay: 15 }, // Summer 2027
};

const TERM_CODE_RE = /^\d{2}[123]$/;

// NEW-FU-217: hard bounds on accepted term codes. The codec stays
// permissive (decodeTerm accepts any valid YYT) so historical terms
// outside the range remain readable, but creation + rename go through
// assertTermCodeInRange() which enforces the policy. Bumping these
// constants extends the allowed lifetime — no migrations needed.
//
// Range chosen: 251 (Fall 2025) through 343 (Summer 2034 + buffer). That
// spans nine academic years, comfortably above the realistic planning
// horizon and gives the red-team battery (Phase 35) headroom to pick
// unique codes for each scenario without colliding with the legacy
// fixtures from Phases 24-34.
const TERM_CODE_MIN = 251;
const TERM_CODE_MAX = 343;

function assertTermCodeInRange(code) {
  // Caller is expected to have already passed the YYT format check
  // (via decodeTerm or the same regex). If they haven't, parseInt
  // would still NaN-coerce gracefully — but we throw the clearer
  // format error first so the user sees one diagnostic at a time.
  if (typeof code !== 'string' || !TERM_CODE_RE.test(code)) {
    const err = new Error(`Invalid term code: ${JSON.stringify(code)}. Expected 3 digits matching ^\\d{2}[123]$.`);
    err.code = 'BAD_INPUT';
    throw err;
  }
  const n = parseInt(code, 10);
  if (n < TERM_CODE_MIN || n > TERM_CODE_MAX) {
    const err = new Error(`Term code ${code} is outside the allowed range ${TERM_CODE_MIN}–${TERM_CODE_MAX}. Terms before Fall 2025 or after Summer 2034 cannot be created.`);
    err.code = 'BAD_INPUT';
    throw err;
  }
}

// NEW-FU-231: lookup helpers. The frontend now needs to know whether
// a code has a published override BEFORE creating the term, so it can
// decide whether to prompt the admin for dates. Exported as a tiny
// API so the AddTermModal can mirror these helpers without
// duplicating the map.
function hasTermDateOverride(code) {
  return Object.prototype.hasOwnProperty.call(TERM_DATE_OVERRIDES, code);
}
function getTermDateOverride(code) {
  return TERM_DATE_OVERRIDES[code] || null;
}

// NEW-FU-232: validate that an admin-supplied (startsAt, endsAt) pair
// for a term falls inside the calendar window the YYT season demands.
// We intentionally allow generous windows (Fall: Aug 1 → Jan 15 of
// the following year; Spring: Jan 1 → Jun 30; Summer: Jun 1 → Sep 15)
// — KFUPM's actual dates shift year to year and the validator's job
// is to catch obvious mismatches (Spring 2027 starting in November,
// say) not to enforce a single canonical date.
// Returns { ok: true } | { ok: false, error: '...' }.
const SEASON_WINDOWS = {
  // Each window keyed by season digit. start = earliest plausible
  // start date for the term; end = latest plausible end date. Both
  // are inclusive. yearOffset matches SEASONS.yearOffset above so the
  // window math doesn't drift from the rest of the codec.
  '1': { yearOffset: 0, earliestStart: '08-01', latestEnd: '01-15-next' },
  '2': { yearOffset: 1, earliestStart: '01-01', latestEnd: '06-30' },
  '3': { yearOffset: 1, earliestStart: '06-01', latestEnd: '09-15' },
};

function validateTermDateWindow(code, startsAt, endsAt) {
  if (!TERM_CODE_RE.test(code)) {
    return { ok: false, error: `Invalid term code ${JSON.stringify(code)}.` };
  }
  // Both required and both must parse as YYYY-MM-DD.
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof startsAt !== 'string' || !ISO.test(startsAt) ||
      typeof endsAt   !== 'string' || !ISO.test(endsAt)) {
    return { ok: false, error: 'startsAt and endsAt must be YYYY-MM-DD strings.' };
  }
  if (startsAt >= endsAt) {
    return { ok: false, error: `startsAt (${startsAt}) must be before endsAt (${endsAt}).` };
  }
  // Bound the dates inside the season's plausible window. We accept
  // any year offset so the validator stays decoupled from the YY in
  // the code (otherwise a 2-day clock skew would reject legitimate
  // dates near midnight). Concretely we compare (month, day) against
  // the season window's edges in the appropriate calendar year.
  const yy = parseInt(code.slice(0, 2), 10);
  const t  = code[2];
  const win = SEASON_WINDOWS[t];
  const calStart = 2000 + yy + win.yearOffset;
  const startMD = startsAt.slice(5);    // MM-DD
  const endMD   = endsAt.slice(5);
  const startYear = parseInt(startsAt.slice(0, 4), 10);
  const endYear   = parseInt(endsAt.slice(0, 4),   10);

  // earliestStart is always within the calendar year.
  if (startYear !== calStart || startMD < win.earliestStart) {
    return {
      ok: false,
      error: `startsAt (${startsAt}) is too early for ${code}. Expected on or after ${calStart}-${win.earliestStart}.`,
    };
  }
  // latestEnd may roll into the following calendar year (Fall's window
  // extends through mid-January).
  if (win.latestEnd.endsWith('-next')) {
    const naked = win.latestEnd.replace('-next', '');
    const ok = (endYear === calStart && endMD >= win.earliestStart) ||
               (endYear === calStart + 1 && endMD <= naked);
    if (!ok) {
      return {
        ok: false,
        error: `endsAt (${endsAt}) is outside the Fall window. Expected between ${calStart}-${win.earliestStart} and ${calStart + 1}-${naked}.`,
      };
    }
  } else {
    if (endYear !== calStart || endMD > win.latestEnd) {
      return {
        ok: false,
        error: `endsAt (${endsAt}) is too late for ${code}. Expected on or before ${calStart}-${win.latestEnd}.`,
      };
    }
  }
  return { ok: true };
}

// NEW-FU-231: decodeTerm now supports a 3-tier precedence so listTerms
// can surface admin-entered dates without bypassing the cheaper
// override map for known codes:
//   (1) Caller-supplied `{ startsAt, endsAt }` (e.g. from a schedule
//       row that has the columns set). Used verbatim.
//   (2) TERM_DATE_OVERRIDES[code] (KFUPM-published known dates).
//   (3) SEASONS template fallback.
// Each tier's output shape stays identical so downstream consumers
// don't branch.
function decodeTerm(code, ctx = null) {
  if (typeof code !== 'string' || !TERM_CODE_RE.test(code)) {
    throw new Error(`Invalid term code: ${JSON.stringify(code)}. Expected 3 digits matching ^\\d{2}[123]$.`);
  }
  const yy = parseInt(code.slice(0, 2), 10);
  const t  = code[2];
  const ayStart = 2000 + yy;                   // AY starts on year 20YY
  const ayEnd   = ayStart + 1;                 // and ends on the following year
  const s = SEASONS[t];
  const calendarYear = ayStart + s.yearOffset; // Fall stays in ayStart; Spring/Summer roll to ayEnd

  let startsAt, endsAt;
  if (ctx && ctx.startsAt && ctx.endsAt) {
    // (1) row-level dates — caller passes ISO date strings straight
    //     through. Postgres DATE columns serialize as YYYY-MM-DD which
    //     is exactly the shape decodeTerm returns elsewhere.
    startsAt = typeof ctx.startsAt === 'string'
      ? ctx.startsAt.slice(0, 10)
      : ctx.startsAt.toISOString().slice(0, 10);
    endsAt   = typeof ctx.endsAt === 'string'
      ? ctx.endsAt.slice(0, 10)
      : ctx.endsAt.toISOString().slice(0, 10);
  } else {
    // (2) override map → (3) template fallback. Same shape; the only
    //     difference is which dictionary supplies the M/D pairs.
    const dates = TERM_DATE_OVERRIDES[code] || {
      startMonth: s.startMonth, startDay: s.startDay,
      endMonth:   s.endMonth,   endDay:   s.endDay,
    };
    startsAt = isoDate(calendarYear, dates.startMonth, dates.startDay);
    endsAt   = isoDate(calendarYear, dates.endMonth,   dates.endDay);
  }

  return {
    code,
    ay: [ayStart, ayEnd],
    season: s.name,
    label: `${s.name} ${calendarYear}`,
    startsAt,
    endsAt,
    isSummer: t === '3',
  };
}

function isoDate(y, m, d) {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

// TERM_CALENDAR — exported view of the season table for callers that need
// the raw schedule (e.g. an admin UI that lets users edit dates per term).
const TERM_CALENDAR = Object.freeze({
  Fall:   Object.freeze({ ...SEASONS['1'] }),
  Spring: Object.freeze({ ...SEASONS['2'] }),
  Summer: Object.freeze({ ...SEASONS['3'] }),
});

module.exports = {
  decodeTerm, TERM_CALENDAR, TERM_CODE_RE,
  // NEW-FU-217
  assertTermCodeInRange, TERM_CODE_MIN, TERM_CODE_MAX,
  // NEW-FU-223: exported so the AddTermModal preview (which currently
  // duplicates the date computation client-side) can be migrated to the
  // same source of truth in a future pass.
  TERM_DATE_OVERRIDES,
  // NEW-FU-231: tiny lookup API consumed by the frontend (AddTermModal)
  // and the new POST /terms validator. Keeps the override map a
  // backend-owned dictionary while letting consumers branch on it.
  hasTermDateOverride, getTermDateOverride,
  // NEW-FU-232: server-side validator for admin-supplied dates.
  validateTermDateWindow,
};
