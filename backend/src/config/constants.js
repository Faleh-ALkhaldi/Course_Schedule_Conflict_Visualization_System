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
  UG: 'UG',   // Undergraduate – allowed 07:00–17:10
  GR: 'GR',   // Graduate      – allowed 17:20–22:00
};

// ── Time allocation windows (minutes from midnight) ──────────────────────────
// NEW-FU-495 (Phase 120): authoritative teaching windows.
//   Undergraduate : 07:00 – 17:10   (latest end 17:10)
//   Graduate      : 17:20 – 22:00   (earliest start 17:20)
// There is an intentional 10-minute gap (17:10 → 17:20) between the UG day and
// the GR evening — DO NOT collapse it. Capstone courses are venue-exempt but
// NOT time-exempt: every capstone is an Undergraduate Senior course, so it is
// bound to the UG window (07:00–17:10) via R-06 (see R06Rule — no capstone
// early-return anymore). External courses have no section row → fully exempt.
const TIME_WINDOWS = {
  UG: { start:  7 * 60,      end: 17 * 60 + 10 },  // 07:00 – 17:10
  GR: { start: 17 * 60 + 20, end: 22 * 60 },       // 17:20 – 22:00
};

// NEW-FU-497 (Phase 121): per-course R-06 time-window exemption.
// SWE 412 (Software Engineering Project II) legitimately meets in the evening
// (registrar: Tue 17:20–20:00) — it's the one capstone the registrar schedules
// outside the UG day. Per the registrar-faithfulness audit, SWE 412 ONLY is
// exempt from the R-06 teaching-window check (it still needs a venue and shows
// on the grid). All other capstones (SWE 413/414) stay bound to 07:00–17:10.
const R06_TIME_EXEMPT_COURSES = new Set(['SWE 412']);

// ── Office-hours allowed window ──────────────────────────────────────────────
// NEW-FU-466 (Phase 112): office hours may ONLY be held 08:00–16:00 (8 AM–4 PM).
// Enforced at EVERY input (Add-Instructor panel, Edit-Office-Hours modal, Import)
// AND at the API (addOfficeHour / updateOfficeHour) so an out-of-window block can
// never be saved. This is the root-cause fix for the R-04 storm: a wide early
// block (e.g. 04:00) used to overlap an instructor's whole morning of sections.
const OFFICE_HOURS_WINDOW = {
  startStr: '08:00', endStr: '16:00',
  start: 8 * 60, end: 16 * 60,
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
// NEW-FU-498 (Phase 122): Prj (Project) and Ths (Thesis) join Lec/Lab —
// the registrar's PRJ/THS activities (capstone projects, thesis courses).
const SECTION_TYPE = {
  LEC: 'Lec',
  LAB: 'Lab',
  PRJ: 'Prj',
  THS: 'Ths',
};

// ── Section-number ranges (NEW-FU-106) ────────────────────────────────────────
// Lec sections take '01'..'49'; Lab sections take '50'..'99'.
// The ranges are disjoint by design — see migration 010 for the CHECK
// constraint that enforces this at the DB level. Both controllers (input
// validation) and SuggestService (generated output) consume these.
const SECTION_NUMBER_RANGE = {
  Lec: { min: 1,  max: 49, regex: /^(0[1-9]|[1-4][0-9])$/ },
  Lab: { min: 50, max: 99, regex: /^[5-9][0-9]$/ },
  // NEW-FU-498 (Phase 122): Prj/Ths share the Lec 01–49 range (matches the
  // registrar, e.g. SWE 412-01, SWE 413-01/02, SWE 494-01).
  Prj: { min: 1,  max: 49, regex: /^(0[1-9]|[1-4][0-9])$/ },
  Ths: { min: 1,  max: 49, regex: /^(0[1-9]|[1-4][0-9])$/ },
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
  // NEW-FU-498 (Phase 122): Project/Thesis meet in long single blocks (or, for
  // thesis, often no fixed meeting at all — the duration check is skipped when
  // no time is set). 50–180 covers the registrar's PRJ spread (75-min SWE 413,
  // 100-min SWE 414, 160-min SWE 412).
  Prj: { min: 50, max: 180, defaults: [75, 100, 160] },
  Ths: { min: 50, max: 180, defaults: [75, 100, 160] },
};

// ── Days of week (as stored in DB) ───────────────────────────────────────────
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];

module.exports = {
  ACADEMIC_LEVELS,
  LEVEL_NAMES,
  COURSE_CATEGORY,
  TIME_WINDOWS,
  R06_TIME_EXEMPT_COURSES, // NEW-FU-497 (Phase 121)
  OFFICE_HOURS_WINDOW,    // NEW-FU-466 (Phase 112)
  SEVERITY,
  RULE_IDS,
  SCHEDULE_STATUS,
  VENUE_TYPE,
  SECTION_TYPE,           // NEW-FU-93
  SECTION_NUMBER_RANGE,   // NEW-FU-106
  SECTION_DURATION,       // NEW-FU-106
  DAYS,
};
