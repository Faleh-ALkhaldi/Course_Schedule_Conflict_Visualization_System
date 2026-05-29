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
// Strategy-pattern rules (live in engine/rules/): R-01, R-02, R-04, R-05, R-06
// Single-section advisory rules (live in repositories + ScheduleService):
//   R-09: missing instructor                    → Soft
//   R-10: missing venue                         → Soft       (NEW-FU-91)
//   R-11: lab section in non-lab venue          → Soft       (NEW-FU-97)
//   R-12: lecture section in lab venue          → Soft       (NEW-FU-98)
//   R-13: instructor has no office hours        → Soft       (NEW-FU-99)
//   R-14: has_lab course missing Lec or Lab     → Soft       (NEW-FU-107)
//   R-15: insufficient credit coverage          → Soft       (NEW-FU-270)
// Auto-suggest-only structural rules (live in SuggestService): R-07, R-08
const RULE_IDS = {
  R01: 'R-01',
  R02: 'R-02',
  R03: 'R-03',
  R04: 'R-04',
  R05: 'R-05',
  R06: 'R-06',
  R09: 'R-09',
  R10: 'R-10',   // NEW-FU-91: missing venue → soft warning
  R11: 'R-11',   // NEW-FU-97: lab section in non-lab venue → soft
  R12: 'R-12',   // NEW-FU-98: lec section in lab venue → soft
  R13: 'R-13',   // NEW-FU-99: instructor without office hours → soft
  R14: 'R-14',   // NEW-FU-107: has_lab course missing Lec or Lab section → soft
  R15: 'R-15',   // NEW-FU-270: section's surviving days × duration don't cover credit hours → soft
};

// ── Schedule statuses ─────────────────────────────────────────────────────────
// NEW-FU-83: PENDING_APPROVAL is reserved for a future intermediate review
// step (Draft → PendingApproval → Finalized) where an admin queues a save
// for department-head sign-off before it goes live. The DB constraint in
// migration 005 already allows the value; no code path currently sets or
// reads it. Kept (not removed) so adding the workflow later doesn't need a
// migration. If you implement it, expose a route POST /schedules/:id/submit
// that transitions Draft → PendingApproval, and an approval route that
// transitions PendingApproval → Finalized (or back to Draft on rejection).
const SCHEDULE_STATUS = {
  DRAFT:             'Draft',
  PENDING_APPROVAL:  'PendingApproval',   // reserved — see comment above
  FINALIZED:         'Finalized',
};

// ── Venue types ───────────────────────────────────────────────────────────────
// NEW-FU-272 (Phase 50 #3): 'Multipurpose' added for rooms used as BOTH
// lecture halls and labs (real KFUPM e.g. 22-334 hosts SWE 363 lectures
// AND SWE 206 labs). Migration 015 extends the venues.type CHECK to allow
// the new value; R-11 / R-12 treat it as valid for either section type.
const VENUE_TYPE = {
  LECTURE_HALL: 'LectureHall',
  LABORATORY:   'Laboratory',
  MULTIPURPOSE: 'Multipurpose',
};

// ── Section types ─────────────────────────────────────────────────────────────
// NEW-FU-93: each section is either a lecture or a lab. Course-level
// has_lab gates whether Lab is a legal choice for a given course's sections.
// Lab-only courses are NOT allowed by the spec — a course is either
// lecture-only or has-both-lecture-and-lab.
const SECTION_TYPE = {
  LEC: 'Lec',
  LAB: 'Lab',
};

// ── Section-number ranges (NEW-FU-106) ────────────────────────────────────────
// Lec sections take '01'..'49'; Lab sections take '50'..'99'.
// The ranges are disjoint by design — see migration 010 for the CHECK
// constraint that enforces this at the DB level. Both controllers (input
// validation) and SuggestService (generated output) consume these.
const SECTION_NUMBER_RANGE = {
  Lec: { min: 1,  max: 49, regex: /^(0[1-9]|[1-4][0-9])$/ },
  Lab: { min: 50, max: 99, regex: /^[5-9][0-9]$/ },
};

// ── Section duration limits (NEW-FU-106) ──────────────────────────────────────
// Lec: 50..75 minutes (default offered: 50, 75 — the two standard
//      class-period lengths)
// Lab: 50..165 minutes (default offered: 50, 75, 165 — standard half-period,
//      full-period, and the 2h45 lab block)
// The DEFAULTS array is what the frontend's SectionModal renders as quick-
// pick buttons; the MIN/MAX bounds are what the backend validates against.
const SECTION_DURATION = {
  Lec: { min: 50, max: 75,  defaults: [50, 75] },
  Lab: { min: 50, max: 165, defaults: [50, 75, 165] },
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
  SECTION_TYPE,           // NEW-FU-93
  SECTION_NUMBER_RANGE,   // NEW-FU-106
  SECTION_DURATION,       // NEW-FU-106
  DAYS,
};
