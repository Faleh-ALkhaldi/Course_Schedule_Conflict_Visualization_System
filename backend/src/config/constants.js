// ── Academic Level ordering ───────────────────────────────────────────────────
// Used by R-01 and R-02 to compare levels numerically.
const ACADEMIC_LEVELS = {
  FRESHMAN:  1,
  SOPHOMORE: 2,
  JUNIOR:    3,
  SENIOR:    4,
  GRADUATE:  5,
};

// Reverse map: number → name
const LEVEL_NAMES = Object.fromEntries(
  Object.entries(ACADEMIC_LEVELS).map(([k, v]) => [v, k])
);

// ── Course categories ─────────────────────────────────────────────────────────
const COURSE_CATEGORY = {
  UG: 'UG',   // Undergraduate – allowed 07:00–17:00
  GR: 'GR',   // Graduate      – allowed 17:00–22:00
};

// ── Time allocation windows (minutes from midnight) ──────────────────────────
const TIME_WINDOWS = {
  UG: { start:  7 * 60, end: 17 * 60 },  // 07:00 – 17:00
  GR: { start: 17 * 60, end: 22 * 60 },  // 17:00 – 22:00
};

// ── Conflict severity ─────────────────────────────────────────────────────────
const SEVERITY = {
  HARD: 'Hard',
  SOFT: 'Soft',
};

// ── Conflict rules (matches SRS rule IDs) ────────────────────────────────────
const RULE_IDS = {
  R01: 'R-01',
  R02: 'R-02',
  R03: 'R-03',
  R04: 'R-04',
  R05: 'R-05',
  R06: 'R-06',
};

// ── Schedule statuses ─────────────────────────────────────────────────────────
const SCHEDULE_STATUS = {
  DRAFT:             'Draft',
  PENDING_APPROVAL:  'PendingApproval',
  FINALIZED:         'Finalized',
};

// ── Venue types ───────────────────────────────────────────────────────────────
const VENUE_TYPE = {
  LECTURE_HALL: 'LectureHall',
  LABORATORY:   'Laboratory',
};

// ── Days of week (as stored in DB) ───────────────────────────────────────────
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];

module.exports = {
  ACADEMIC_LEVELS,
  LEVEL_NAMES,
  COURSE_CATEGORY,
  TIME_WINDOWS,
  SEVERITY,
  RULE_IDS,
  SCHEDULE_STATUS,
  VENUE_TYPE,
  DAYS,
};
