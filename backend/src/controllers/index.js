const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { query } = require('../config/db');
const schedSvc   = require('../services/ScheduleService');
const exportSvc  = require('../services/ExportService');
const multer     = require('multer');
// NEW-C2: bound upload size and count to prevent OOM / DoS via unbounded
// multipart bodies. Bumped 5→10MB to fit PDF/DOCX imports (PDFs with images
// can easily exceed 5MB; Excel rarely does).
const upload     = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 1 },
});
const suggestSvc = require('../services/SuggestService');
// NEW-FU-237: KFUPM (credits × day × duration) pattern validator —
// enforced at section create / update; auto-suggester also imports it
// to filter candidates before greedy assignment.
const sectionPattern = require('../domain/sectionPattern');
const { filterCoursesForTerm, isCourseAllowedInTerm, disallowReason } = require('../domain/courseTermValidity');
const { courseCodeError, courseNameError, courseFlagError, creditsFlagError } = require('../domain/courseFormat');
const { R06_TIME_EXEMPT_COURSES, TIME_WINDOWS } = require('../config/constants'); // NEW-FU-497 (Phase 121)
const { ScheduleRepository, VenueRepository, CourseRepository } = require('../repositories/repositories');
const InstructorRepository = require('../repositories/InstructorRepository');
// NEW-FU-23: SectionRepository import dropped — controllers don't touch
// sections directly; they go through schedSvc.

const schedRepo  = new ScheduleRepository();
const venueRepo  = new VenueRepository();
const courseRepo = new CourseRepository();
const instrRepo  = new InstructorRepository();
// NEW-FU-23: dropped `sectRepo` — it was declared but never referenced
// after section operations moved to schedSvc / ScheduleService.

// C-1: Wraps async handlers so unhandled rejections propagate to the global error handler.
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// NEW-M8: lightweight input validators. We don't pull in a schema library
// to keep deps small; these cover the inputs that would otherwise reach the
// DB and surface as opaque "Database constraint violation" errors.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const VALID_DAYS = new Set(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']);
const VALID_LEVELS = new Set(['Freshman','Sophomore','Junior','Senior','Graduate']);
const VALID_CATEGORIES = new Set(['UG','GR']);
// NEW-FU-287 (Phase 57): 'Multipurpose' added — migration 015 already
// extended the DB CHECK constraint to allow it, but this controller
// whitelist still rejected the value, so the new chip in AddVenueModal
// couldn't actually save. Conflict rules R-11/R-12 already treat
// Multipurpose as a wildcard (Lec OK + Lab OK), so adding it here is
// purely an enablement of the existing engine behaviour.
const VALID_VENUE_TYPES = new Set(['LectureHall','Laboratory','Multipurpose']);
// NEW-FU-95: section_number must be exactly '01'..'99' (two-digit, zero-
// padded, no '00'). Matches the DB CHECK constraint added in migration 009.
const SECTION_NUM_RE = /^(0[1-9]|[1-9][0-9])$/;
// NEW-FU-510 (Batch 1): canonicalize a user-supplied section number BEFORE
// validation/storage, so a bare single digit ("2") is accepted and treated as
// "02" — including on a direct API POST. Mirrors padSectionNumber() in
// frontend/src/utils/sectionNumber.js (kept inline here per the hot-path /
// no-module-crossing convention used for the regexes below). A single 0–9
// digit is zero-padded ("2" → "02", "0" → "00", which the range regex then
// rejects); anything else (already two digits, "100", letters, empty) is
// returned trimmed and unchanged so the range regex can reject it precisely.
function padSectionNumber(s) {
  const t = String(s ?? '').trim();
  return /^[0-9]$/.test(t) ? t.padStart(2, '0') : t;
}
// NEW-FU-96: section_type values mirror SECTION_TYPE in constants.js.
// NEW-FU-498 (Phase 122): + Prj (Project) and Ths (Thesis).
const VALID_SECTION_TYPES = new Set(['Lec','Lab','Prj','Ths']);
// NEW-FU-108: type-scoped section# ranges. Mirrors SECTION_NUMBER_RANGE in
// constants.js (kept inline here for hot-path validation perf — no module
// crossing per request). NEW-FU-498: Prj/Ths share the Lec 01–49 range.
const SECTION_NUM_RE_BY_TYPE = {
  Lec: /^(0[1-9]|[1-4][0-9])$/,
  Lab: /^[5-9][0-9]$/,
  Prj: /^(0[1-9]|[1-4][0-9])$/,
  Ths: /^(0[1-9]|[1-4][0-9])$/,
};
// NEW-FU-109: duration limits by type. Frontend offers quick-picks; backend
// validates a numeric in-range minute count.
// NEW-FU-498 (Phase 122): Prj/Ths allow long single blocks (50–180).
const SECTION_DURATION_BY_TYPE = {
  Lec: { min: 50, max: 75  },
  Lab: { min: 50, max: 160 },
  Prj: { min: 50, max: 180 },
  Ths: { min: 50, max: 180 },
};

// NEW-FU-109: compute duration in minutes between two HH:MM strings.
// Assumes both have already passed isTime(). Used by section-create/update
// duration validation. Returns -1 for malformed input (caller already
// checks isTime, so this is defensive).
function durationMinutes(startTime, endTime) {
  if (!startTime || !endTime) return -1;
  const [h1, m1] = startTime.split(':').map(Number);
  const [h2, m2] = endTime.split(':').map(Number);
  if (![h1, m1, h2, m2].every(Number.isInteger)) return -1;
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}

function isUuid(s)  { return typeof s === 'string' && UUID_RE.test(s); }
function isTime(s)  { return typeof s === 'string' && HHMM_RE.test(s); }
function isDay(s)   { return typeof s === 'string' && VALID_DAYS.has(s); }
// NEW-FU-95: matches the DB-level CHECK in migration 009.
// NEW-FU-510 (Batch 1): normalize first so a single digit ("2") is accepted
// and validated as its padded form ("02"); "0"/"00" still fail.
function isSectionNumber(s) { return typeof s === 'string' && SECTION_NUM_RE.test(padSectionNumber(s)); }
// NEW-FU-466 (Phase 112): office hours may only be 08:00–16:00 (8 AM–4 PM).
// Mirrors OFFICE_HOURS_WINDOW in constants.js (kept inline — same hot-path
// reasoning as SECTION_NUM_RE_BY_TYPE). Returns a plain-language message when
// out of window (start before 08:00 or end after 16:00), else null. The root
// cause of the R-04 storm was an out-of-window early block (e.g. 04:00) that
// overlapped an instructor's whole morning; this is the backend guard.
const OH_WINDOW = { startStr: '08:00', endStr: '16:00' };
function officeHoursWindowError(startTime, endTime) {
  const s = String(startTime).slice(0, 5), e = String(endTime).slice(0, 5);
  // NEW-FU-496 (Phase 120): check BOTH edges of BOTH endpoints, so a start AFTER
  // 16:00 (e.g. 17:00) or an end BEFORE 08:00 also returns the window message —
  // previously only start<08:00 / end>16:00 were caught, and an out-of-window
  // start surfaced only as the less-helpful "start before end" ordering error.
  if (s < OH_WINDOW.startStr || s > OH_WINDOW.endStr ||
      e < OH_WINDOW.startStr || e > OH_WINDOW.endStr) {
    return `Office hours must be between ${OH_WINDOW.startStr} and ${OH_WINDOW.endStr} (8:00 AM to 4:00 PM).`;
  }
  return null;
}
function badRequest(res, msg) { return res.status(400).json({ error: msg }); }

// NEW-FU-46: bounded-string validator mirroring the DB VARCHAR column
// limits, so over-long values are rejected with a precise 400 instead of
// reaching pg and getting sanitised to a generic "Database constraint
// violation." Empty strings / non-strings are also rejected here.
function isBoundedString(s, max) {
  return typeof s === 'string' && s.trim().length > 0 && s.length <= max;
}
function badLength(res, field, max) {
  return badRequest(res, `${field} must be a non-empty string up to ${max} characters.`);
}
// NEW-FU-59: normalize a user-supplied string before it reaches the DB.
// Without this, " Dr. Hassan " was stored verbatim with leading/trailing
// whitespace — sorting and equality became inconsistent ("Dr. Hassan" vs
// "Dr. Hassan " differ in name list lookups). Returns null when input
// isn't a usable string so callers can pass through unchanged ("update
// field if provided" semantics).
function normalizeName(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}
// NEW-FU-419 (Phase 104 item 5): instructor names are stored ALL CAPS — the
// established convention across the seed ("HASAN AL-KAF"). Trim, collapse inner
// whitespace, then upper-case, so every create/update is consistent.
function normalizeInstructorName(s) {
  const n = normalizeName(s);
  return n ? n.replace(/\s+/g, ' ').toUpperCase() : n;
}

// NEW-M4: precomputed dummy hash used when a username doesn't exist, so the
// login handler always runs a bcrypt.compare and takes (roughly) the same
// wall-clock time regardless of whether the user is real. Hash is for the
// string "invalid" — never compared to a real password.
const DUMMY_HASH = '$2a$10$Kfhj8s24Og58nRaaZAPLH.8aWPTsT6g6116YR.LM5RDE6SIsc2qiO';

// ── Auth ──────────────────────────────────────────────────────────────────────
const login = ah(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password are required.' });
  const r = await query(
    `SELECT id, username, email, password_hash, role FROM users WHERE username = $1`,
    [username]
  );
  const user = r.rows[0];
  // NEW-M4: always run bcrypt — even when the user doesn't exist — to keep
  // the timing of failed-login responses indistinguishable from successful
  // username-but-wrong-password responses.
  const passwordOk = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !passwordOk)
    return res.status(401).json({ error: 'Invalid credentials.' });
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h', algorithm: 'HS256' }
  );
  return res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// NEW-M3: logout endpoint. Stateless JWTs cannot be invalidated server-side
// without a denylist, so this is currently a 204 acknowledgement — the
// frontend still clears its localStorage. A future denylist implementation
// would slot in here (write jti to revoked_tokens, check in middleware).
const logout = ah(async (req, res) => {
  res.status(204).end();
});

// ── Schedules ─────────────────────────────────────────────────────────────────
const listSchedules = ah(async (req, res) => {
  const schedules = await schedRepo.listByDept(req.params.departmentId);
  res.json(schedules);
});

// NEW-FU-74: charset constraint shared by departmentId & semester. Length
// alone was insufficient — a 30-char `semester` containing `/ \ ? * [ ] "`
// would (1) trip Excel's sheet-name rules at export time (caught by FU-79
// but defence-in-depth is cheaper at the entry point) and (2) corrupt the
// Content-Disposition filename produced by exportSchedule. Restricting to
// alphanumeric + space + dash + underscore covers every realistic semester
// label ("Fall-2025", "Spring 2026", "FY25_T2") and zero attack strings.
const SAFE_LABEL_RE = /^[A-Za-z0-9 _-]+$/;

const createSchedule = ah(async (req, res) => {
  const { departmentId, semester } = req.body;
  if (!departmentId || !semester)
    return res.status(400).json({ error: 'departmentId and semester are required.' });
  // NEW-FU-16: enforce string type + DB-schema length bounds so a non-string
  // payload doesn't trip pg later with an opaque "Database constraint violation".
  if (typeof departmentId !== 'string' || departmentId.length === 0 || departmentId.length > 80)
    return badRequest(res, 'departmentId must be a non-empty string up to 80 characters.');
  if (typeof semester !== 'string' || semester.length === 0 || semester.length > 30)
    return badRequest(res, 'semester must be a non-empty string up to 30 characters.');
  // NEW-FU-74: charset gate (see comment on SAFE_LABEL_RE above).
  if (!SAFE_LABEL_RE.test(departmentId))
    return badRequest(res, 'departmentId may only contain letters, digits, space, underscore, or dash.');
  if (!SAFE_LABEL_RE.test(semester))
    return badRequest(res, 'semester may only contain letters, digits, space, underscore, or dash.');
  const schedule = await schedRepo.create({ departmentId, semester, createdBy: req.user.id });
  res.status(201).json(schedule);
});

// ── Sections ──────────────────────────────────────────────────────────────────
const getSections = ah(async (req, res) => {
  const { scheduleId } = req.params;
  const { view, instructorId, venueId } = req.query;
  // NEW-FU-47: reject teacher/venue views that are missing their id rather
  // than silently falling through to the all-sections response. The previous
  // behaviour masked client bugs — a caller asking for view=teacher without
  // instructorId got every section in the schedule and never learned their
  // request was incomplete.
  if (view === 'teacher') {
    if (!instructorId)               return badRequest(res, 'instructorId is required for view=teacher.');
    if (!isUuid(instructorId))       return badRequest(res, 'instructorId must be a UUID.');
    const data = await schedSvc.getSectionsForInstructor(scheduleId, instructorId);
    return res.json(data);
  }
  if (view === 'venue') {
    if (!venueId)                    return badRequest(res, 'venueId is required for view=venue.');
    if (!isUuid(venueId))            return badRequest(res, 'venueId must be a UUID.');
    const sections = await schedSvc.getSectionsForVenue(scheduleId, venueId);
    return res.json({ sections, officeHours: [] });
  }
  const sections = await schedSvc.getSectionsForSchedule(scheduleId);
  res.json({ sections, officeHours: [] });
});

// NEW-FU-520 (Batch 6): cross-term resource guard. A section in term T may only
// reference resources that are GLOBAL/shared (owner_semester IS NULL) or OWNED by
// T. A resource OWNED BY ANOTHER TERM must never be assigned into T — that is the
// `01-0001` (owned by 271) → assigned-in-261 contamination this batch fixes. The
// candidate pools (Quick Fix / Suggest / inline fixes) are already term-scoped;
// this is the write-layer backstop for manual / API writes. Returns a 409-ready
// message when a supplied instructor/venue is owned by a different term, else null.
// `table` is a hardcoded literal here (never user input) — no injection surface.
async function crossTermResourceError(termSemester, { instructorId, venueId }) {
  if (!termSemester) return null;
  const targets = [];
  if (instructorId) targets.push(['Instructor', 'instructors', instructorId]);
  if (venueId)      targets.push(['Venue',      'venues',      venueId]);
  for (const [label, table, id] of targets) {
    const r = await query(`SELECT owner_semester, name FROM ${table} WHERE id = $1`, [id]);
    const row = r.rows[0];
    if (!row) continue; // missing row → FK / 404 handled elsewhere
    if (row.owner_semester && row.owner_semester !== termSemester) {
      return `${label} "${row.name}" belongs to term ${row.owner_semester} and cannot be used in term ${termSemester}. Add it to this term first (or copy the term).`;
    }
  }
  return null;
}

const createSection = ah(async (req, res) => {
  const { scheduleId } = req.params;
  const { courseId, instructorId, venueId, sectionNumber, sectionType, day, days, startTime, endTime,
          gender /* NEW-FU-277 (Phase 53 #2) — 'M' or 'F'; defaults to 'M' */ } = req.body;
  if (gender !== undefined && gender !== 'M' && gender !== 'F')
    return badRequest(res, 'gender must be "M" or "F".');
  if (!courseId || !sectionNumber || !startTime || !endTime)
    return badRequest(res, 'Please choose a course, a section number, a start time and an end time.');
  // NEW-M8: validate input shapes before they reach the DB. Returns precise
  // 400 messages rather than generic "Database constraint violation" 500s.
  if (!isUuid(scheduleId))                              return badRequest(res, 'scheduleId must be a UUID.');
  if (!isUuid(courseId))                                return badRequest(res, 'courseId must be a UUID.');
  if (instructorId && !isUuid(instructorId))            return badRequest(res, 'instructorId must be a UUID.');
  if (venueId && !isUuid(venueId))                      return badRequest(res, 'venueId must be a UUID.');
  if (!isTime(startTime) || !isTime(endTime))           return badRequest(res, 'startTime and endTime must be HH:MM.');
  // NEW-FU-96: section_type validation. Defaults if not supplied
  // (backward-compat for clients that don't know about the new field).
  // 'Lab' is only valid if the course has has_lab=true — we look that up
  // below before insert (after we have the course in hand).
  // NEW-FU-371 (Phase 98 item 2): DERIVE the default type from the section
  // number's range instead of blindly defaulting to 'Lec'. Section numbers are
  // type-scoped by domain invariant (Lec 01–49, Lab 50–99), so a '50'–'99'
  // number unambiguously means a Lab. The old `?? 'Lec'` mis-classified any
  // Lab section whose creator omitted sectionType — e.g. a cross-day-group
  // drag-move (SchedulerPage.confirmGroupChange) re-creates the section and,
  // before this phase, dropped sectionType → a §50 Lab was validated against
  // the Lec range → false "sectionNumber for Lec sections must be in 01–49"
  // (and, had it passed, ScheduleService would have silently stored it as a
  // Lec). Deriving from the number makes the omitted-type path correct.
  // NEW-FU-510 (Batch 1): canonical two-digit form drives type derivation,
  // the range check, and storage below — so a posted "2" becomes "02".
  const normSectionNumber = padSectionNumber(sectionNumber);
  const effectiveSectionType = sectionType
    ?? (SECTION_NUM_RE_BY_TYPE.Lab.test(normSectionNumber) ? 'Lab' : 'Lec');
  if (!VALID_SECTION_TYPES.has(effectiveSectionType))
    return badRequest(res, `sectionType must be "Lec", "Lab", "Prj", or "Ths" (got "${sectionType}").`);
  // NEW-FU-95 + NEW-FU-108: section number must be in the type-scoped range
  // (Lec: 01-49; Lab: 50-99). This is stricter than the old FU-95 check
  // which only enforced format. The DB CHECK constraint (migration 010)
  // enforces the same predicate, so a malformed value rejected here would
  // also be rejected by pg — surfacing the precise client-facing message
  // up front is the point of this validator.
  // NEW-FU-498 (Phase 122): Lab → 50–99; Lec/Prj/Ths → 01–49.
  const expectedRange = effectiveSectionType === 'Lab' ? '50–99' : '01–49';
  if (!SECTION_NUM_RE_BY_TYPE[effectiveSectionType].test(normSectionNumber))
    return badRequest(res, `sectionNumber for ${effectiveSectionType} sections must be in ${expectedRange} (01–99, single digits accepted and zero-padded).`);
  // NEW-FU-109: duration validation by type. Lec: 50..75; Lab: 50..160.
  const dur = durationMinutes(startTime, endTime);
  const durLimits = SECTION_DURATION_BY_TYPE[effectiveSectionType];
  if (dur < durLimits.min || dur > durLimits.max)
    return badRequest(res, `${effectiveSectionType} section duration must be ${durLimits.min}–${durLimits.max} minutes (got ${dur}).`);
  const dayList = days ?? (day ? [day] : []);
  if (!dayList.length)                                  return badRequest(res, 'At least one day is required.');
  for (const d of dayList) if (!isDay(d))               return badRequest(res, `Invalid day: "${d}".`);
  // NEW-FU-96 / NEW-FU-237: load the course once and reuse it for both
  // the Lab/has_lab gate and the KFUPM pattern validator below.
  const courseRow = await courseRepo.findById(courseId);
  if (!courseRow) return res.status(404).json({ error: 'Course not found.' });
  // NEW-FU-415 (Phase 103 item 1): reject adding a section of a course that is
  // not offered in THIS term (SWE 412 after 252, SWE 399 outside Summer).
  const createSemRow = await query(`SELECT semester FROM schedules WHERE id = $1`, [scheduleId]);
  const createTermSemester = createSemRow.rows[0]?.semester ?? null;
  if (!isCourseAllowedInTerm(courseRow.course_code, createTermSemester)) {
    return res.status(409).json({ error: disallowReason(courseRow.course_code, createTermSemester) });
  }
  // NEW-FU-520 (Batch 6): refuse to assign a resource owned by another term.
  const createXtErr = await crossTermResourceError(createTermSemester, { instructorId, venueId });
  if (createXtErr) return res.status(409).json({ error: createXtErr });
  if (effectiveSectionType === 'Lab' && !courseRow.has_lab) {
    return res.status(409).json({
      error: `Course ${courseRow.course_code} is not configured for lab sections. Enable "has lab" on the course first.`,
    });
  }
  // NEW-FU-475 (Phase 114): instructor AND venue are required for a real section —
  // server-side backstop for the modal's new hard requirement (was a soft R-09/R-10
  // warning). External courses carry no section assignment; capstone courses have no
  // venue. Suggest/Import use their own insert paths, so they are unaffected.
  if (!courseRow.is_external) {
    if (!instructorId) return badRequest(res, 'An instructor is required for the section.');
    if (!courseRow.is_capstone && !venueId) return badRequest(res, 'A venue is required for the section.');
  }
  // H-3: time-order validation
  if (startTime >= endTime)
    return badRequest(res, 'endTime must be after startTime.');
  // NEW-FU-454 (Phase 108): enforce the R-06 teaching WINDOW at create time —
  // server-side defense for the modal's input-time guard, so an out-of-window
  // section is rejected up front instead of persisting and surfacing later as a
  // hard conflict.
  // NEW-FU-495 (Phase 120): UG 07:00–17:10, GR 17:20–22:00. Capstone is now
  // bound to the UG window (venue-exempt but NOT time-exempt — every capstone is
  // a UG Senior course). External courses have no section row → fully exempt.
  if (!courseRow.is_external && !R06_TIME_EXEMPT_COURSES.has(courseRow.course_code)) {
    const hm = t => { const [h,mn] = String(t).split(':').map(Number); return (h||0)*60 + (mn||0); };
    const sMin = hm(startTime), eMin = hm(endTime);
    // Window from constants.TIME_WINDOWS — same source R-06 uses, so create-time
    // validation can't drift from the engine. Capstone is bound to the UG window.
    const win = TIME_WINDOWS[(courseRow.category === 'GR' && !courseRow.is_capstone) ? 'GR' : 'UG'];
    if (sMin < win.start || eMin > win.end) {
      const lbl = courseRow.is_capstone ? '07:00–17:10 (Capstone)'
                : courseRow.category === 'GR' ? '17:20–22:00 (Graduate)' : '07:00–17:10 (Undergraduate)';
      return badRequest(res, `${courseRow.course_code} must be scheduled within ${lbl} (got ${startTime}–${endTime}).`);
    }
  }
  // NEW-FU-237: KFUPM pattern validator. Enforces the (credits ×
  // day-pattern × duration) table from sectionPattern.js. Permissive
  // read, strict write — existing seeded sections that violate the
  // rules stay readable; only new/edited sections are gated.
  const patternCheck = sectionPattern.validateSectionPattern({
    credits:     Number(courseRow.credits),
    hasLab:      Boolean(courseRow.has_lab),
    sectionType: effectiveSectionType,
    days:        dayList,
    startTime,   endTime,
  });
  if (!patternCheck.ok) return badRequest(res, patternCheck.error);
  // NEW-FU-59: trim sectionNumber so "A" and "A " (or "01" and " 01") don't
  // create separate logical sections under the UNIQUE constraint on
  // (schedule_id, course_id, section_number, day).
  // NEW-FU-96: forward effectiveSectionType to the service.
  const { section, conflictResult } = await schedSvc.createSection(scheduleId, {
    courseId, instructorId, venueId,
    // NEW-FU-510 (Batch 1): store the canonical two-digit value so the UNIQUE
    // (schedule, course, section_number, day) duplicate check sees "02", not "2".
    sectionNumber: normSectionNumber,
    sectionType: effectiveSectionType,
    day: day ?? dayList[0],
    days: dayList,
    startTime, endTime,
    // NEW-FU-277 (Phase 53 #2): forward gender through. The service's
    // INSERT will use it (or default to 'M' if omitted).
    gender: gender ?? 'M',
  });
  res.status(201).json({ section, conflicts: conflictResult });
});

const updateSection = ah(async (req, res) => {
  const { sectionId } = req.params;
  const { instructorId, venueId, day, startTime, endTime, sectionNumber, sectionType, infoOnly } = req.body;
  // NEW-M8: validate ids/enums up front.
  if (!isUuid(sectionId))                       return badRequest(res, 'sectionId must be a UUID.');
  if (instructorId && !isUuid(instructorId))    return badRequest(res, 'instructorId must be a UUID.');
  if (venueId && !isUuid(venueId))              return badRequest(res, 'venueId must be a UUID.');
  // NEW-FU-96: section_type validation on update. Only legal values are
  // 'Lec' and 'Lab'. The Lab-requires-has_lab check happens in the service
  // because we need to look up the section's course there.
  if (sectionType != null && !VALID_SECTION_TYPES.has(sectionType))
    return badRequest(res, `sectionType must be "Lec", "Lab", "Prj", or "Ths" (got "${sectionType}").`);
  // NEW-FU-95 + NEW-FU-108: type-scoped section# validation on update.
  // If the caller is changing the section type and/or number, we validate
  // the (type, number) pair. If sectionNumber is provided without type,
  // we can't authoritatively validate — defer to the DB CHECK constraint.
  if (sectionNumber != null) {
    // NEW-FU-510 (Batch 1): normalize so a single digit ("2") is accepted and
    // validated/stored as its padded form ("02"); isSectionNumber normalizes too.
    const normSectionNumber = padSectionNumber(sectionNumber);
    if (!isSectionNumber(sectionNumber))
      return badRequest(res, 'sectionNumber must be "01"–"99" (single digits accepted and zero-padded).');
    if (sectionType != null) {
      const expectedRange = sectionType === 'Lab' ? '50–99' : '01–49'; // NEW-FU-498: Lec/Prj/Ths → 01–49
      if (!SECTION_NUM_RE_BY_TYPE[sectionType].test(normSectionNumber))
        return badRequest(res, `sectionNumber for ${sectionType} sections must be in ${expectedRange}.`);
    }
  }
  // NEW-FU-109: duration validation on time-edit. Skipped on infoOnly (no
  // time fields supplied) and on partial updates that don't change times.
  if (!infoOnly && startTime && endTime) {
    const dur = durationMinutes(startTime, endTime);
    // NEW-FU-445 (Phase 107 M5): validate duration against the section's ACTUAL
    // type, not a 'Lab' default. A time-only edit (drag-resize) sends no type, so
    // the old default (50–160) let a Lec be resized to an illegal 76–160 minutes.
    let typeForDuration = sectionType;
    if (!typeForDuration) {
      const r = await query(`SELECT section_type FROM sections WHERE id = $1`, [sectionId]);
      typeForDuration = r.rows[0]?.section_type ?? 'Lab';
    }
    const durLimits = SECTION_DURATION_BY_TYPE[typeForDuration];
    if (durLimits && (dur < durLimits.min || dur > durLimits.max))
      return badRequest(res, `${typeForDuration} section duration must be ${durLimits.min}–${durLimits.max} minutes (got ${dur}).`);
  }
  try {
    // NEW-FU-520 (Batch 6): cross-term resource guard for BOTH update paths.
    // Resolve this section's owning term once, then refuse any reassignment to an
    // instructor/venue owned by a different term (covers infoOnly reassigns and
    // the drag-move/time-edit assignSection path below).
    if (instructorId || venueId) {
      const tRow = await query(
        `SELECT sc.semester FROM sections s JOIN schedules sc ON sc.id = s.schedule_id WHERE s.id = $1`,
        [sectionId]
      );
      const updateXtErr = await crossTermResourceError(tRow.rows[0]?.semester ?? null, { instructorId, venueId });
      if (updateXtErr) return res.status(409).json({ error: updateXtErr });
    }
    if (infoOnly) {
      // NEW-FU-59: trim sectionNumber on update too.
      // NEW-FU-96: forward sectionType.
      const result = await schedSvc.updateSectionInfo(sectionId, {
        instructorId, venueId,
        // NEW-FU-510 (Batch 1): store the canonical two-digit value ("2" → "02").
        sectionNumber: sectionNumber != null ? padSectionNumber(sectionNumber) : undefined,
        sectionType,
      });
      return res.json({ section: null, conflicts: result });
    }
    if (!day || !startTime || !endTime)
      return badRequest(res, 'day, startTime, endTime are required.');
    if (!isDay(day))                              return badRequest(res, `Invalid day: "${day}".`);
    if (!isTime(startTime) || !isTime(endTime))   return badRequest(res, 'startTime and endTime must be HH:MM.');
    if (startTime >= endTime)                     return badRequest(res, 'endTime must be after startTime.');
    // NEW-FU-494 (Phase 119 item 4): enforce R-06 teaching window on TIME EDITS
    // (drag-move, SectionModal time tab). The create path (createSection) already
    // does this; updateSection lacked it, so dragging a UG section past its window
    // or a GR section before its window was accepted and just surfaced as a hard R-06.
    // NEW-FU-495 (Phase 120): UG 07:00–17:10, GR 17:20–22:00; capstone bound to the
    // UG window (venue-exempt but NOT time-exempt); external fully exempt.
    {
      const secRow = await query(
        `SELECT c.is_external, c.is_capstone, c.category, c.course_code
           FROM sections s JOIN courses c ON c.id = s.course_id WHERE s.id = $1`,
        [sectionId]
      );
      if (secRow.rows.length > 0) {
        const cr = secRow.rows[0];
        if (!cr.is_external && !R06_TIME_EXEMPT_COURSES.has(cr.course_code)) {
          const hm = t => { const [h,mn] = String(t).split(':').map(Number); return (h||0)*60 + (mn||0); };
          const sMin = hm(startTime), eMin = hm(endTime);
          // Window from constants.TIME_WINDOWS (same source as R-06; capstone = UG window).
          const win = TIME_WINDOWS[(cr.category === 'GR' && !cr.is_capstone) ? 'GR' : 'UG'];
          if (sMin < win.start || eMin > win.end) {
            const lbl = cr.is_capstone ? '07:00–17:10 (Capstone)'
                      : cr.category === 'GR' ? '17:20–22:00 (Graduate)' : '07:00–17:10 (Undergraduate)';
            return badRequest(res, `${cr.course_code} must be scheduled within ${lbl} (got ${startTime}–${endTime}).`);
          }
        }
      }
    }
    // NEW-FU-528 (Batch 9 Issue 1): re-validate the (credits × day-pattern × duration)
    // rule on a TIME edit. assignSection moves every linked day to the same start/end,
    // so a duration change here can break the pattern — a 3-credit Sun/Tue/Thu group is
    // legal at 50 min but ILLEGAL at 75 min (which must be 2 days). createSection
    // validated this; the time-edit path did NOT, which is exactly how a 75-min
    // Sun/Tue/Thu group got persisted. Validate the group's full day-set against the new
    // duration and reject an illegal combo (Lec only; the modal auto-converts the
    // pattern so a legitimate UI edit never trips this — it's the root-cause backstop).
    {
      const grpRow = await query(
        `SELECT c.credits, c.has_lab, s.section_type,
                (SELECT array_agg(DISTINCT s2.day)
                   FROM sections s2
                  WHERE s2.schedule_id = s.schedule_id
                    AND s2.course_id = s.course_id
                    AND s2.section_number = s.section_number) AS group_days
           FROM sections s JOIN courses c ON c.id = s.course_id WHERE s.id = $1`,
        [sectionId]
      );
      const g = grpRow.rows[0];
      // NEW-FU-561 (audit P2-7): also validate LAB edits against the pattern. Create
      // runs validateSectionPattern for every type, but this edit-time gate was Lec-only,
      // so a Lab drag-resize was checked only against the loose continuous range and could
      // persist an illegal duration (LAB_RULE allows ONLY 50/75/160 min). Prj/Ths stay
      // ungated here (their flexible meeting has no fixed-duration rule).
      if (g && (g.section_type === 'Lec' || g.section_type === 'Lab')) {
        const check = sectionPattern.validateSectionPattern({
          credits:     Number(g.credits),
          hasLab:      Boolean(g.has_lab),
          sectionType: g.section_type,
          days:        (g.group_days && g.group_days.length) ? g.group_days : [day],
          startTime,   endTime,
        });
        if (!check.ok) return badRequest(res, check.error);
      }
    }
    const result = await schedSvc.assignSection(sectionId, { instructorId, venueId, day, startTime, endTime });
    res.json({ section: null, conflicts: result });
  } catch(err) {
    // H-4: surface not-found as 404 rather than 500
    if (err.message?.includes('not found')) return res.status(404).json({ error: err.message });
    // NEW-M6: surface finalize-lock errors with their declared status (409)
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// NEW-FU-277: extend an existing section group with new meeting days.
// Drives the R-15 quick-fix flow (Phase 23). The fix proposals on each
// R-15 conflict map 1:1 to a POST body here.
//
// Body shape: { addDays: ['Thursday'] | ['Sunday', 'Tuesday'] }
//
// The service-layer validator (NEW-FU-276) re-runs the sectionPattern
// rule table on the union of existing + new days, so this endpoint
// gives up to a 400 if the combined pattern would still be illegal.
const extendSection = ah(async (req, res) => {
  if (!isUuid(req.params.sectionId)) return badRequest(res, 'sectionId must be a UUID.');
  const { addDays } = req.body;
  if (!Array.isArray(addDays) || addDays.length === 0)
    return badRequest(res, 'addDays must be a non-empty array of weekday names.');
  for (const d of addDays) {
    if (!isDay(d)) return badRequest(res, `Invalid day in addDays: "${d}".`);
  }
  try {
    const result = await schedSvc.extendSection(req.params.sectionId, addDays);
    res.status(201).json({ section: result.section, conflicts: result.conflictResult });
  } catch (err) {
    console.error('extendSection error:', err);
    if (err.message?.includes('not found')) return res.status(404).json({ error: err.message });
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const deleteSection = ah(async (req, res) => {
  if (!isUuid(req.params.sectionId)) return badRequest(res, 'sectionId must be a UUID.');
  // NEW-FU-271: `?scope=row` deletes ONLY the queried row (one meeting day
  // of a section). Default (no param OR `?scope=group`) preserves the
  // historical behavior of deleting all sibling rows in the section group
  // — what callers like SchedulerPage.confirmGroupChange already expect.
  //
  // The two scopes exist because Phase 22 introduces the per-day quick-
  // delete (✕) on grid blocks. Before this, a section's day pattern was
  // immutable post-creation (sectionPattern validator enforced legal
  // tuples); per-day delete is now possible, and R-15 (FU-270) is the
  // safety net when surviving meetings under-cover the credit hours.
  const scope = req.query.scope === 'row' ? 'row' : 'group';
  try {
    // NEW-FU-288: forward deletedIds so the frontend updates local state
    // precisely (removing only the listed rows) instead of nuking all
    // sections via CLEAR_SECTIONS and waiting for a refetch — the prior
    // approach caused the schedule to blank out visually mid-delete.
    const result = scope === 'row'
      ? await schedSvc.deleteSectionRow(req.params.sectionId)
      : await schedSvc.deleteSection(req.params.sectionId);
    res.json({ deleted: true, scope, deletedIds: result.deletedIds ?? [] });
  } catch(err) {
    console.error('deleteSection error:', err);
    if (err.message?.includes('not found')) return res.status(404).json({ error: err.message });
    // NEW-M6: 409 from finalize-lock
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// NEW-FU-534 (Batch 12): preview the FULL conflict-engine result for a PROPOSED
// section change, without writing anything. The edit modal used a partial client-side
// check (instructor/venue only) and missed student/academic-level overlaps (R-01/R-02),
// the time window (R-06), etc. — so a conflicting change could be saved unflagged. This
// runs the SAME engine Quick Fix / Suggest use, against the live schedule with the
// change applied in memory, so the modal can flag every resulting conflict and block
// Save. Also reports whether ANY conflict-free start time exists for the proposed
// pattern (instructor/venue/days fixed) — the modal steers the user there, and only
// offers an explicit override when none exists (the schedule is genuinely tight).
const SECTION_SNAPSHOT_SQL = `
  SELECT s.id, s.schedule_id, s.course_id, s.instructor_id, s.venue_id,
         s.section_number, s.day, s.start_time::text, s.end_time::text,
         s.section_type, s.gender,
         c.course_code, c.name AS course_name, c.academic_level, c.category,
         c.num_sections, c.has_lab, c.credits, c.is_capstone, c.is_external,
         i.name AS instructor_name, v.name AS venue_name, v.type AS venue_type
  FROM sections s
  JOIN courses c ON c.id = s.course_id
  LEFT JOIN instructors i ON i.id = s.instructor_id
  LEFT JOIN venues v ON v.id = s.venue_id
  WHERE s.schedule_id = $1`;

const previewConflicts = ah(async (req, res) => {
  const { scheduleId } = req.params;
  const { sectionId, courseId, instructorId, venueId, sectionNumber, sectionType,
          days, startTime, endTime, gender } = req.body;
  if (!isUuid(scheduleId)) return badRequest(res, 'scheduleId must be a UUID.');
  // Not enough to evaluate yet → no conflicts (the modal keeps Save logic on its own
  // required-field checks).
  if (!courseId || !Array.isArray(days) || days.length === 0 || !startTime || !endTime) {
    return res.json({ conflicts: [], conflictFreeStartExists: true });
  }

  const Section = require('../domain/Section');
  const ConflictEngine = require('../engine/ConflictEngine');
  const engine = new ConflictEngine();

  const mk = (row) => new Section({
    id: row.id, scheduleId: row.schedule_id, courseId: row.course_id,
    instructorId: row.instructor_id, venueId: row.venue_id,
    sectionNumber: row.section_number, day: row.day,
    startTime: row.start_time, endTime: row.end_time,
    courseCode: row.course_code, courseName: row.course_name,
    academicLevel: row.academic_level, category: row.category,
    numSections: row.num_sections, instructorName: row.instructor_name,
    venueName: row.venue_name, sectionType: row.section_type, venueType: row.venue_type,
    hasLab: row.has_lab, credits: row.credits, isCapstone: row.is_capstone,
    gender: row.gender, isExternal: row.is_external,
  });

  const snap = await query(SECTION_SNAPSHOT_SQL, [scheduleId]);
  const all = snap.rows.map(mk);

  // Exclude the EDITED section's own group (so it can't conflict with itself). Identify
  // it by sectionId when editing, else by (courseId, sectionNumber).
  let selfCourse = courseId, selfNum = sectionNumber, selfGender = gender;
  if (sectionId) {
    const own = all.find(s => s.id === sectionId);
    if (own) { selfCourse = own.courseId; selfNum = own.sectionNumber; selfGender = selfGender ?? own.gender; }
  }
  const others = all.filter(s => !(s.courseId === selfCourse && s.sectionNumber === String(selfNum)));

  // Course / venue / instructor metadata for the proposed section.
  const cRes = await query(
    `SELECT course_code, name, academic_level, category, num_sections, has_lab, credits, is_capstone, is_external FROM courses WHERE id = $1`,
    [courseId]);
  const course = cRes.rows[0];
  if (!course) return res.json({ conflicts: [], conflictFreeStartExists: true });
  let venue = null, instrName = null;
  if (venueId)      venue     = (await query(`SELECT name, type FROM venues WHERE id = $1`, [venueId])).rows[0] || null;
  if (instructorId) instrName = (await query(`SELECT name FROM instructors WHERE id = $1`, [instructorId])).rows[0]?.name || null;

  // OH map for every instructor in play (incl. the proposed one).
  const instrIds = [...new Set([...others.map(s => s.instructorId), instructorId].filter(Boolean))];
  const ohMap = new Map();
  if (instrIds.length) {
    const ohRes = await query(
      `SELECT instructor_id, day, start_time::text AS start_time, end_time::text AS end_time
       FROM office_hours WHERE instructor_id = ANY($1)`, [instrIds]);
    for (const row of ohRes.rows) {
      if (!ohMap.has(row.instructor_id)) ohMap.set(row.instructor_id, []);
      ohMap.get(row.instructor_id).push({ day: row.day, startTime: row.start_time, endTime: row.end_time });
    }
  }

  const hm = t => { const [h, m] = String(t).slice(0, 5).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const fromMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const durMin = hm(endTime) - hm(startTime);

  // Build the proposed group at a given start minute and return the conflicts that
  // INVOLVE it, using the real engine over (others + proposed).
  const evalAt = (startMin) => {
    const proposed = days.map((day, i) => mk({
      id: `__preview__${i}`, schedule_id: scheduleId, course_id: courseId,
      instructor_id: instructorId || null, venue_id: venueId || null,
      section_number: String(sectionNumber ?? '01'), day,
      start_time: fromMin(startMin), end_time: fromMin(startMin + durMin),
      course_code: course.course_code, course_name: course.name,
      academic_level: course.academic_level, category: course.category,
      num_sections: course.num_sections, instructor_name: instrName,
      venue_name: venue?.name, section_type: sectionType || 'Lec', venue_type: venue?.type,
      has_lab: course.has_lab, credits: course.credits, is_capstone: course.is_capstone,
      // NEW-FU-555 (Batch 18): use the section's REAL gender — hardcoding 'M' flipped a
      // female section to male and defeated the engine's different-gender exemption
      // (R-04/R-05 treat a male + female pair sharing a room/instructor as dual-audience,
      // not a clash). That produced false self-looking conflicts ("§F-12" rendered as
      // "§12" vs "§02") the grid never showed.
      gender: selfGender || 'M', is_external: course.is_external,
    }));
    const ids = new Set(proposed.map(p => p.id));
    const result = engine.evaluateAll([...others, ...proposed], ohMap);
    return result.conflicts.filter(c => ids.has(c.sectionAId) || ids.has(c.sectionBId));
  };

  // Conflicts for the EXACT proposed change.
  const raw = evalAt(hm(startTime));
  const seen = new Set();
  const conflicts = raw.filter(c => {
    const k = `${c.ruleId}|${c.description}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  }).map(c => ({ ruleId: c.ruleId, severity: c.severity, description: c.description }));

  // If the exact change conflicts, scan the teaching window for a fully conflict-free
  // start (same days/instructor/venue/pattern) so the modal can steer vs. override.
  let conflictFreeStartExists = conflicts.length === 0;
  if (!conflictFreeStartExists) {
    const win = (course.category === 'GR' && !course.is_capstone)
      ? { start: 17 * 60 + 20, end: 22 * 60 } : { start: 7 * 60, end: 17 * 60 + 10 };
    for (let st = win.start; st + durMin <= win.end; st += 30) {
      if (evalAt(st).length === 0) { conflictFreeStartExists = true; break; }
    }
  }

  res.json({ conflicts, conflictFreeStartExists });
});

// NEW-FU-541 (Batch 13 Issue 2): constrained, move-only Quick Fix for the section
// EDIT / ADD panels. Tries to make the PROPOSED change conflict-free purely by
// retiming OTHER existing groups — never dropping sections, never assigning dummy
// resources. Returns a plan of moves when achievable, else { feasible:false } so the
// panel can show "Schedule is tight …" and block the change.
const autoFixAround = ah(async (req, res) => {
  const { scheduleId } = req.params;
  const { sectionId, courseId, instructorId, venueId, sectionNumber, sectionType,
          days, startTime, endTime, gender } = req.body;
  if (!isUuid(scheduleId)) return badRequest(res, 'scheduleId must be a UUID.');
  if (!courseId || !Array.isArray(days) || days.length === 0 || !startTime || !endTime) {
    return res.json({ feasible: false, moves: [] });
  }

  const Section = require('../domain/Section');
  const ConflictEngine = require('../engine/ConflictEngine');
  const { planRescheduleAround } = require('../services/RescheduleAroundService');
  const engine = new ConflictEngine();

  const mk = (row) => new Section({
    id: row.id, scheduleId: row.schedule_id, courseId: row.course_id,
    instructorId: row.instructor_id, venueId: row.venue_id,
    sectionNumber: row.section_number, day: row.day,
    startTime: row.start_time, endTime: row.end_time,
    courseCode: row.course_code, courseName: row.course_name,
    academicLevel: row.academic_level, category: row.category,
    numSections: row.num_sections, instructorName: row.instructor_name,
    venueName: row.venue_name, sectionType: row.section_type, venueType: row.venue_type,
    hasLab: row.has_lab, credits: row.credits, isCapstone: row.is_capstone,
    gender: row.gender, isExternal: row.is_external,
  });

  const snap = await query(SECTION_SNAPSHOT_SQL, [scheduleId]);
  const all = snap.rows;

  // Identify and exclude the proposed section's OWN group (it must not appear among
  // the movable "others", and it can't conflict with itself).
  let selfCourse = courseId, selfNum = sectionNumber, selfGender = gender;
  if (sectionId) {
    const own = all.find(r => r.id === sectionId);
    if (own) { selfCourse = own.course_id; selfNum = own.section_number; selfGender = selfGender ?? own.gender; }
  }
  const otherRows = all.filter(r => !(r.course_id === selfCourse && r.section_number === String(selfNum)));

  // Proposed course / venue / instructor metadata.
  const cRes = await query(
    `SELECT course_code, name, academic_level, category, num_sections, has_lab, credits, is_capstone, is_external FROM courses WHERE id = $1`,
    [courseId]);
  const course = cRes.rows[0];
  if (!course) return res.json({ feasible: false, moves: [] });
  let venue = null, instrName = null;
  if (venueId)      venue     = (await query(`SELECT name, type FROM venues WHERE id = $1`, [venueId])).rows[0] || null;
  if (instructorId) instrName = (await query(`SELECT name FROM instructors WHERE id = $1`, [instructorId])).rows[0]?.name || null;

  const hm = t => { const [h, m] = String(t).slice(0, 5).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const fromMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const durMin = hm(endTime) - hm(startTime);

  // OH map for every instructor in play.
  const instrIds = [...new Set([...otherRows.map(r => r.instructor_id), instructorId].filter(Boolean))];
  const ohMap = new Map();
  if (instrIds.length) {
    const ohRes = await query(
      `SELECT instructor_id, day, start_time::text AS start_time, end_time::text AS end_time
       FROM office_hours WHERE instructor_id = ANY($1)`, [instrIds]);
    for (const row of ohRes.rows) {
      if (!ohMap.has(row.instructor_id)) ohMap.set(row.instructor_id, []);
      ohMap.get(row.instructor_id).push({ day: row.day, startTime: row.start_time, endTime: row.end_time });
    }
  }

  // Proposed group rows at the desired time.
  const startMin = hm(startTime);
  const proposedRows = days.map((day, i) => ({
    id: `__proposed__${i}`, schedule_id: scheduleId, course_id: courseId,
    instructor_id: instructorId || null, venue_id: venueId || null,
    section_number: String(sectionNumber ?? '01'), day,
    start_time: fromMin(startMin), end_time: fromMin(startMin + durMin),
    course_code: course.course_code, course_name: course.name,
    academic_level: course.academic_level, category: course.category,
    num_sections: course.num_sections, instructor_name: instrName,
    venue_name: venue?.name, section_type: sectionType || 'Lec', venue_type: venue?.type,
    has_lab: course.has_lab, credits: course.credits, is_capstone: course.is_capstone,
    // NEW-FU-555 (Batch 18): real gender (see previewConflicts) so the move-only Quick
    // Fix doesn't see false different-gender venue/instructor clashes.
    gender: selfGender || 'M', is_external: course.is_external,
  }));

  // Group the other rows by (course, section-number); each group moves as a unit.
  const groupMap = new Map();
  for (const r of otherRows) {
    if (!r.start_time || !r.end_time) continue;           // no fixed time → can't retime
    const key = `${r.course_id}|${r.section_number}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key, rows: [], startMin: hm(r.start_time), durMin: hm(r.end_time) - hm(r.start_time),
        category: r.category, isCapstone: r.is_capstone, isExternal: r.is_external,
        instructorId: r.instructor_id, venueId: r.venue_id,
      });
    }
    groupMap.get(key).rows.push(r);
  }
  const groups = [...groupMap.values()].map(g => {
    // Movable = a real, non-external group whose duration fits its teaching window.
    const win = (g.category === 'GR' && !g.isCapstone)
      ? { start: 17 * 60 + 20, end: 22 * 60 } : { start: 7 * 60, end: 17 * 60 + 10 };
    g.movable = !g.isExternal && (g.startMin >= 0) && (win.start + g.durMin <= win.end);
    return g;
  });

  const plan = planRescheduleAround({
    engine, ohMap, mk, fromMin,
    proposedRows,
    groups,
  });

  res.json({ feasible: plan.feasible, moves: plan.moves || [] });
});

// NEW-FU-541 (Batch 13 Issue 2): apply a move-only Quick-Fix plan. Atomically shifts
// the START/END time of the named OTHER sections (the plan from autoFixAround). It
// NEVER creates/deletes sections and NEVER touches resources — only times. The
// caller then saves its own proposed change through the normal path.
const autoFixAroundApply = ah(async (req, res) => {
  const { scheduleId } = req.params;
  const { moves } = req.body;
  if (!isUuid(scheduleId)) return badRequest(res, 'scheduleId must be a UUID.');
  if (!Array.isArray(moves) || moves.length === 0) return badRequest(res, 'moves must be a non-empty array.');
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const m of moves) {
    if (!isUuid(m.sectionId)) return badRequest(res, 'each move.sectionId must be a UUID.');
    const st = String(m.startTime ?? m.toStart ?? '').slice(0, 5);
    const en = String(m.endTime ?? m.toEnd ?? '').slice(0, 5);
    if (!TIME_RE.test(st) || !TIME_RE.test(en)) return badRequest(res, 'each move needs valid HH:MM start/end times.');
    m._st = st; m._en = en;
  }

  const { getClient } = require('../config/db');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // NEW-FU-561 (audit P1-2): take the SAME editability row-lock every other section
    // writer takes (createSection/assignSection/extendSection all call this). Without
    // it, a move-only Quick-Fix could mutate section times on a FINALIZED or archived
    // schedule, bypassing the immutability contract. Throws err.status (409/423),
    // propagated by the ah() wrapper to the global error handler.
    await schedSvc.assertSchedulerEditableLocked(client, scheduleId);
    let moved = 0;
    for (const m of moves) {
      const r = await client.query(
        `UPDATE sections SET start_time = $1, end_time = $2
           WHERE id = $3 AND schedule_id = $4`,
        [m._st, m._en, m.sectionId, scheduleId]);
      moved += r.rowCount;
    }
    await client.query('COMMIT');
    res.json({ ok: true, moved });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ── Save ──────────────────────────────────────────────────────────────────────
const saveSchedule = ah(async (req, res) => {
  const { scheduleId } = req.params;
  // NEW-FU-78: accept either { confirmSoft: true } (legacy "confirm all")
  // or { confirmSoftIds: [...] } (scoped: confirm only these). The service
  // accepts either as the second argument.
  const { confirmSoft = false, confirmSoftIds } = req.body;
  const arg = Array.isArray(confirmSoftIds) && confirmSoftIds.every(s => typeof s === 'string')
    ? confirmSoftIds
    : confirmSoft;
  const result = await schedSvc.saveSchedule(scheduleId, arg);
  res.status(result.saved ? 200 : 409).json(result);
});

// ── Conflicts ─────────────────────────────────────────────────────────────────
const getConflicts = ah(async (req, res) => {
  const result = await schedSvc.revalidateSchedule(req.params.scheduleId);
  res.json(result);
});

// ── Export ────────────────────────────────────────────────────────────────────
const ALLOWED_EXPORT_FORMATS = new Set(['xlsx', 'pdf', 'docx']);
const ALLOWED_IMPORT_FORMATS = new Set(['xlsx', 'pdf', 'docx']);

// Map a MIME type / extension to our internal format slug. Lets the user upload
// a file without specifying ?format= and have the right parser picked.
function detectImportFormat(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.xlsx')) return 'xlsx';
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.pdf'))  return 'pdf';
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return 'image';
  return null;
}

const importSchedule = ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  // Explicit ?format= takes precedence; otherwise infer from filename.
  let format = (req.query.format || '').toLowerCase() || detectImportFormat(req.file);
  if (format === 'image') {
    return res.status(400).json({
      error: 'Images cannot be imported — they are screenshots, not structured data. Upload an Excel, Word, or PDF file instead.',
    });
  }
  if (!format || !ALLOWED_IMPORT_FORMATS.has(format)) {
    return res.status(400).json({
      error: `Unsupported import format. Allowed: ${[...ALLOWED_IMPORT_FORMATS].join(', ')}.`,
    });
  }
  try {
    const result    = await exportSvc.importBuffer(req.file.buffer, req.params.scheduleId, format);
    const conflicts = await schedSvc.revalidateSchedule(req.params.scheduleId);
    res.json({ ...result, format, conflicts });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const exportSchedule = ah(async (req, res) => {
  const { scheduleId } = req.params;
  const { view, instructorId, venueId } = req.query;
  const format = (req.query.format || 'xlsx').toLowerCase();
  if (!ALLOWED_EXPORT_FORMATS.has(format)) {
    return res.status(400).json({
      error: `Unsupported export format. Allowed: ${[...ALLOWED_EXPORT_FORMATS].join(', ')}.`,
    });
  }
  let filter = { type: 'full' };
  if (view === 'teacher' && instructorId) filter = { type: 'instructor', id: instructorId };
  if (view === 'venue'   && venueId)      filter = { type: 'venue',      id: venueId };
  const schedule = await schedRepo.findById(scheduleId);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found.' });

  const { workbook, buffer, mime, ext } = await exportSvc.buildExport(
    scheduleId, filter, schedule.semester, format
  );
  res.setHeader('Content-Type', mime);
  const safeSemester = exportSvc.safeFilenamePart(schedule.semester) || 'schedule';
  res.setHeader('Content-Disposition', `attachment; filename="${safeSemester}-schedule.${ext}"`);
  if (workbook) {
    await workbook.xlsx.write(res);
    res.end();
  } else {
    res.end(buffer);
  }
});

// ── Courses ───────────────────────────────────────────────────────────────────
// NEW-FU-274 (Phase 51 #5): optional ?term=251 query — when supplied, only
// returns courses with at least one section in that term's schedule. Keeps
// term sidebars from cluttering with courses offered in other terms.
// NEW-FU-415 (Phase 103 item 1): course listing, two scopes, both excluding
// courses not offered in the given term (SWE 412 after 252, SWE 399 outside
// Summer):
//   • default      → courses that already have SECTIONS in the term (term-scoped).
//   • scope=catalog→ the FULL global program catalog (so the Suggest modal still
//                    reveals Graduate / not-yet-added courses — Phase 99 item 6),
//                    minus the curriculum-invalid ones for that term.
const getCourses = ah(async (req, res) => {
  const term = req.query.term || null;
  const courses = req.query.scope === 'catalog'
    ? await courseRepo.findAll(null)   // whole catalog
    : await courseRepo.findAll(term);  // only those with sections in the term
  res.json(filterCoursesForTerm(courses, term));
});

const createCourse = ah(async (req, res) => {
  const { courseCode, name, credits, academicLevel, category, numSections, hasLab,
          isCapstone /* NEW-FU-278 (Phase 54): Phase 50 flag — venue-rule
                       exemption for graduation-project capstones */,
          isExternal /* NEW-FU-278 (Phase 54): Phase 52 flag — full
                       rule exemption for off-campus internships */ } = req.body;
  if (!courseCode || !name || credits == null || !academicLevel || !category)
    return badRequest(res, 'courseCode, name, credits, academicLevel, category required.');
  // NEW-FU-94: hasLab is a boolean toggle. Accept truthy/falsy values from
  // older clients; the repo coerces to Boolean before insert.
  // NEW-M8: validate enums + numeric ranges.
  if (!VALID_LEVELS.has(academicLevel))      return badRequest(res, `Invalid academicLevel: "${academicLevel}".`);
  if (!VALID_CATEGORIES.has(category))       return badRequest(res, `Invalid category: "${category}".`);
  // NEW-FU-46: enforce DB VARCHAR limits for course_code (20) and name (120).
  if (!isBoundedString(courseCode, 20)) return badLength(res, 'courseCode', 20);
  if (!isBoundedString(name,      120)) return badLength(res, 'name',      120);
  // NEW-FU-422 (Phase 104 items 3+4): strict code (SWE 101–599) + real name +
  // single-flag (at most one of has_lab / capstone / external).
  { const e = courseCodeError(courseCode); if (e) return badRequest(res, e); }
  { const e = courseNameError(name);       if (e) return badRequest(res, e); }
  { const e = courseFlagError({ hasLab, isCapstone, isExternal }); if (e) return badRequest(res, e); }
  { const e = creditsFlagError({ credits, hasLab }); if (e) return badRequest(res, e); }   // audit P2-8: 4cr ⇒ has-lab
  // NEW-FU-484 (Phase 118 item 3): level-gated flag constraints.
  // CAPSTONE requires Undergraduate + Senior; EXTERNAL requires Undergraduate + Junior.
  // Frontend disables the checkboxes, but the backend is the authoritative gate.
  if (isCapstone && !(category === 'UG' && academicLevel === 'Senior'))
    return badRequest(res, 'The Capstone flag is only allowed for Undergraduate Senior courses.');
  if (isExternal && !(category === 'UG' && academicLevel === 'Junior'))
    return badRequest(res, 'The External flag is only allowed for Undergraduate Junior courses.');
  // NEW-FU-278 (Phase 54): credits range 0..4 per KFUPM catalog. 0 is a
  // legal value (SWE 413 is 0-credit, capstone part 1). Migration 018
  // relaxed the DB CHECK from `> 0` to `>= 0` to match.
  const creditsNum = parseInt(credits, 10);
  if (!Number.isInteger(creditsNum) || creditsNum < 0 || creditsNum > 4)
    return badRequest(res, 'credits must be an integer between 0 and 4.');
  if (numSections != null) {
    const n = parseInt(numSections, 10);
    if (!Number.isInteger(n) || n < 1) return badRequest(res, 'numSections must be a positive integer.');
  }
  // NEW-FU-59: trim before write so "SWE301 " and "SWE301" don't slip past
  // the UNIQUE(course_code) constraint as distinct rows.
  // NEW-FU-94: forward hasLab to the repo (defaults to false at DB level).
  // NEW-FU-278 (Phase 54): forward isCapstone + isExternal too.
  const course = await courseRepo.create({
    courseCode: normalizeName(courseCode), name: normalizeName(name),
    credits, academicLevel, category, numSections,
    hasLab,
    isCapstone, isExternal,
  });
  res.status(201).json(course);
});

const updateCourse = ah(async (req, res) => {
  // M-3: allowlist fields to prevent mass-assignment
  // NEW-FU-94: include hasLab in the allowlist.
  const { courseCode, name, credits, academicLevel, category, numSections, hasLab } = req.body;
  // NEW-M8: validate enums when provided.
  if (academicLevel && !VALID_LEVELS.has(academicLevel))
    return badRequest(res, `Invalid academicLevel: "${academicLevel}".`);
  if (category && !VALID_CATEGORIES.has(category))
    return badRequest(res, `Invalid category: "${category}".`);
  // NEW-FU-46: enforce DB VARCHAR limits on optional fields when provided.
  if (courseCode != null && !isBoundedString(courseCode, 20))  return badLength(res, 'courseCode', 20);
  if (name       != null && !isBoundedString(name,      120))  return badLength(res, 'name',      120);
  // NEW-FU-422 (Phase 104 item 4): same strict code/name format on edit.
  if (courseCode != null) { const e = courseCodeError(courseCode); if (e) return badRequest(res, e); }
  if (name       != null) { const e = courseNameError(name);       if (e) return badRequest(res, e); }
  // NEW-FU-15: validate numeric fields on update too (create-time validation
  // exists; update was leaking bad values through to pg as opaque errors).
  if (credits != null) {
    const n = parseInt(credits, 10);
    // NEW-FU-278 (Phase 54): align with createCourse — 0..4 range.
    if (!Number.isInteger(n) || n < 0 || n > 4)
      return badRequest(res, 'credits must be an integer between 0 and 4.');
  }
  // NEW-FU-561 (audit P2-8): enforce 4-credit ⇒ has-lab on the MERGED state — a partial
  // update could set credits=4 without touching hasLab, or clear hasLab on an existing
  // 4-credit course. Validate the effective values against the current row.
  if (credits != null || hasLab != null) {
    const existingCourse = await courseRepo.findById(req.params.courseId);
    if (existingCourse) {
      const e = creditsFlagError({
        credits: credits != null ? credits : existingCourse.credits,
        hasLab:  hasLab  != null ? hasLab  : existingCourse.has_lab,
      });
      if (e) return badRequest(res, e);
    }
  }
  if (numSections != null) {
    const n = parseInt(numSections, 10);
    if (!Number.isInteger(n) || n < 1)
      return badRequest(res, 'numSections must be a positive integer.');
  }
  // NEW-FU-59: trim before write (parity with createCourse).
  // NEW-FU-94: forward hasLab when supplied; undefined preserves the
  // existing value via the repo's COALESCE-style update.
  const course = await courseRepo.update(req.params.courseId, {
    courseCode: courseCode != null ? normalizeName(courseCode) : undefined,
    name:       name       != null ? normalizeName(name)       : undefined,
    credits, academicLevel, category, numSections, hasLab,
  });
  // NEW-M9: surface missing rows as 404 instead of returning a confusing
  // "200 OK with null body" that the frontend can't act on.
  if (!course) return res.status(404).json({ error: 'Course not found.' });
  res.json(course);
});

const deleteCourse = ah(async (req, res) => {
  await courseRepo.delete(req.params.courseId);
  res.json({ deleted: true });
});

// ── Instructors ───────────────────────────────────────────────────────────────
// NEW-FU-274 (Phase 51 #5): same ?term= filter as getCourses.
const getInstructors = ah(async (req, res) => { res.json(await instrRepo.findAll(req.query.term || null)); });

// NEW-FU-434 (Phase 106 item 6): when a real instructor/venue is created while
// the active term still has placeholders, AUTOMATICALLY replace the OLDEST
// matching placeholder — reassign its sections to the new real entity and delete
// the placeholder (a dummy instructor's office hours cascade-delete). The active
// term is threaded from the client as req.body.ownerSemester. Transactional so
// reassign+delete can't half-apply. Instructors match by recency; venues also
// match by TYPE (a real Laboratory replaces a placeholder Laboratory, never a
// LectureHall — which would re-introduce R-11/R-12). Returns the replaced
// placeholder { id, name } or null.
async function replaceOldestDummyInstructor(ownerSemester, newInstructorId) {
  // NEW-FU-436 (Phase 107 H2): validate the term code (don't trust a raw body
  // field) and scope the reassign to the owner term's schedule(s) so a stray
  // ownerSemester can never repoint sections in another (or finalized) term.
  if (!ownerSemester || !/^\d{2}[123]$/.test(String(ownerSemester))) return null;
  const { getClient } = require('../config/db');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const d = await client.query(
      `SELECT id, name FROM instructors WHERE is_dummy = true AND owner_semester = $1
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE`, [ownerSemester]);
    if (d.rowCount === 0) { await client.query('ROLLBACK'); return null; }
    const dummy = d.rows[0];
    await client.query(
      `UPDATE sections SET instructor_id = $1
       WHERE instructor_id = $2 AND schedule_id IN (SELECT id FROM schedules WHERE semester = $3)`,
      [newInstructorId, dummy.id, ownerSemester]);
    await client.query(`DELETE FROM instructors WHERE id = $1`, [dummy.id]); // office_hours cascade
    await client.query('COMMIT');
    return { id: dummy.id, name: dummy.name };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { try { client.release(); } catch { /* ignore */ } }
}
async function replaceOldestDummyVenue(ownerSemester, newVenueId, newType) {
  // NEW-FU-436 (Phase 107 H2): validate + scope to the owner term's schedule(s).
  if (!ownerSemester || !/^\d{2}[123]$/.test(String(ownerSemester))) return null;
  const { getClient } = require('../config/db');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const d = await client.query(
      `SELECT id, name FROM venues WHERE is_dummy = true AND owner_semester = $1 AND type = $2
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE`, [ownerSemester, newType]);
    if (d.rowCount === 0) { await client.query('ROLLBACK'); return null; }
    const dummy = d.rows[0];
    await client.query(
      `UPDATE sections SET venue_id = $1
       WHERE venue_id = $2 AND schedule_id IN (SELECT id FROM schedules WHERE semester = $3)`,
      [newVenueId, dummy.id, ownerSemester]);
    await client.query(`DELETE FROM venues WHERE id = $1`, [dummy.id]);
    await client.query('COMMIT');
    return { id: dummy.id, name: dummy.name };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { try { client.release(); } catch { /* ignore */ } }
}

// NEW-FU-461 (Phase 109): a sensible default office-hours block for a new instructor —
// the most-common day among existing instructors + a mid-morning hour (within the real
// office-hours window). Shown pre-filled in the Add-Instructor panel; also the auto-default.
async function suggestedOfficeHour() {
  const r = await query(`SELECT day, COUNT(*) c FROM office_hours GROUP BY day ORDER BY c DESC, day LIMIT 1`);
  return { day: r.rows[0]?.day || 'Sunday', startTime: '10:00', endTime: '11:00' };
}
const getSuggestedOfficeHour = ah(async (_req, res) => { res.json(await suggestedOfficeHour()); });

// NEW-FU-561 (audit P2-2): shared instructor-name validator so updateInstructor (PUT)
// enforces the SAME English-charset + real-full-name rules createInstructor does — the
// server-side backstop must not be bypassable via PUT. Returns an error message or null.
// Solver "NEW INSTRUCTOR <n>" placeholders are exempt (minted programmatically).
function instructorNameError(name) {
  const trimmed = String(name ?? '').trim();
  if (/^NEW INSTRUCTOR \d+$/i.test(trimmed)) return null;
  if (!/^[A-Za-z\s'-]+$/.test(trimmed))
    return 'name may contain only letters, spaces, hyphens and apostrophes.';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || !parts.every(p => /^[A-Za-z][A-Za-z'-]*$/.test(p)))
    return 'Enter a full name — at least a first and last name (English letters only, separated by a space).';
  return null;
}

const createInstructor = ah(async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email)
    return badRequest(res, 'name and email are required.');
  // NEW-M8: light-touch email validation. RFC-compliant validation is famously
  // hard; this catches the worst typos and lets PG's unique check do the rest.
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return badRequest(res, 'email must look like name@host.tld.');
  // NEW-FU-46: enforce DB VARCHAR limits before pg sees the value.
  if (!isBoundedString(name,  120)) return badLength(res, 'name',  120);
  if (!isBoundedString(email, 120)) return badLength(res, 'email', 120);
  // NEW-FU-510 (Batch 2) + NEW-FU-544 (Batch 14 Issue 3): English-charset + real
  // full-name rules (server-side backstop for the front-end filter), now shared with
  // updateInstructor via instructorNameError. Placeholders ("NEW INSTRUCTOR 1") exempt.
  { const ne = instructorNameError(name); if (ne) return badRequest(res, ne); }
  // NEW-FU-59: trim leading/trailing whitespace so " Dr. Hassan " and
  // "Dr. Hassan" don't end up as two distinct DB rows under the UNIQUE
  // constraint they nominally share.
  const cleanEmail = normalizeName(email);
  // NEW-FU-525 (Batch 8 Issue 2): scope the duplicate-email check STRICTLY to the
  // current term (parity with the venue fix). The old check also matched
  // `owner_semester IS NULL`, so a globally-seeded instructor's email blocked adding
  // it in EVERY term — cross-term leakage. Each term is independent: the same email
  // may be registered here even if another term (or the legacy global set) has it.
  // No active term (rare global add) → check the global set so a true global add dedups.
  const ownerSemester = (req.activeTerm && req.activeTerm.code) || req.body.ownerSemester || null;
  const dupInTerm = ownerSemester
    ? await query(
        `SELECT 1 FROM instructors
          WHERE email = $1
            AND (owner_semester = $2
                 OR id IN (SELECT s.instructor_id FROM sections s
                           JOIN schedules sc ON sc.id = s.schedule_id WHERE sc.semester = $2))
          LIMIT 1`,
        [cleanEmail, ownerSemester]
      )
    : await query(`SELECT 1 FROM instructors WHERE email = $1 AND owner_semester IS NULL LIMIT 1`, [cleanEmail]);
  if (dupInTerm.rows.length)
    return res.status(409).json({ error: 'An instructor with this email already exists in this term.' });
  const instructor = await instrRepo.create({ name: normalizeInstructorName(name), email: cleanEmail, ownerSemester });
  // NEW-FU-461 (Phase 109): capture office hours up front so a new instructor never
  // trips the "no office hours" flag. Use what the Add-Instructor panel sends, or a
  // sensible default — even an API-created instructor gets office hours.
  const ohIn = req.body.officeHours;
  let officeHour;
  if (ohIn && ohIn.day && ohIn.startTime && ohIn.endTime) {
    if (!isDay(ohIn.day) || !isTime(ohIn.startTime) || !isTime(ohIn.endTime))
      return badRequest(res, 'Office hours need a valid day, start time and end time.');
    // NEW-FU-496 (Phase 120): window check BEFORE the ordering check, so an
    // out-of-window value returns the window message (which names 08:00–16:00)
    // rather than the ambiguous "start before end" message.
    { const we = officeHoursWindowError(ohIn.startTime, ohIn.endTime); if (we) return badRequest(res, we); } // NEW-FU-466 (Phase 112)
    if (ohIn.startTime >= ohIn.endTime)
      return badRequest(res, 'Office hours need a start time before the end time (within 08:00–16:00).');
    officeHour = await instrRepo.addOfficeHour(instructor.id, { day: ohIn.day, startTime: ohIn.startTime, endTime: ohIn.endTime });
  } else {
    officeHour = await instrRepo.addOfficeHour(instructor.id, await suggestedOfficeHour());
  }
  // NEW-FU-434 (Phase 106 item 6): auto-replace a placeholder in the active term.
  const replacedDummy = await replaceOldestDummyInstructor(req.body.ownerSemester, instructor.id);
  res.status(201).json({ ...instructor, officeHour, replacedDummy });
});

const updateInstructor = ah(async (req, res) => {
  const { name, email } = req.body;
  // NEW-M8: validate email format and uuid.
  if (!isUuid(req.params.instructorId)) return badRequest(res, 'instructorId must be a UUID.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return badRequest(res, 'email must look like name@host.tld.');
  // NEW-FU-46: enforce DB VARCHAR limits when these fields are provided.
  if (name  != null && !isBoundedString(name,  120)) return badLength(res, 'name',  120);
  if (email != null && !isBoundedString(email, 120)) return badLength(res, 'email', 120);
  // NEW-FU-561 (audit P2-2): enforce the same charset + full-name rules as create when a
  // name is supplied — otherwise the PUT path silently bypassed the server-side backstop.
  if (name != null) { const ne = instructorNameError(name); if (ne) return badRequest(res, ne); }
  // NEW-FU-59: trim before write so updates match the same normalization
  // applied at create time.
  // NEW-FU-439 (Phase 107 M4): partial update — COALESCE so a body with only one
  // field doesn't NULL the other (instructors.name/email are NOT NULL). Parity
  // with updateCourse/updateVenue, which already do partial updates.
  const upd = await query(
    `UPDATE instructors SET name=COALESCE($2,name), email=COALESCE($3,email), updated_at=NOW() WHERE id=$1`,
    [req.params.instructorId, name != null ? normalizeInstructorName(name) : null, email != null ? normalizeName(email) : null]
  );
  // NEW-M9: surface missing rows as 404.
  if (upd.rowCount === 0) return res.status(404).json({ error: 'Instructor not found.' });
  const instructor = await instrRepo.findById(req.params.instructorId);
  res.json(instructor);
});

const deleteInstructor = ah(async (req, res) => {
  const id = req.params.instructorId;
  // NEW-FU-561 (audit P2-1): instructors.id is referenced by sections.instructor_id with
  // ON DELETE SET NULL, so a raw DELETE silently nulls assignments in EVERY term — incl.
  // Finalized/archived ones (immutability violation) — and left stale conflicts behind
  // (no revalidation). (a) Refuse if any affected schedule is locked; (b) otherwise delete
  // and revalidate each affected schedule so the now-instructor-less sections surface R-09.
  const affected = await query(
    `SELECT DISTINCT sc.id, sc.status, sc.archived_at
       FROM sections s JOIN schedules sc ON sc.id = s.schedule_id
      WHERE s.instructor_id = $1`, [id]);
  if (affected.rows.some(r => r.status === 'Finalized' || r.archived_at !== null))
    return res.status(409).json({ error: 'This instructor is assigned in a finalized or archived term and cannot be deleted. Reassign those sections first.' });
  await query(`DELETE FROM instructors WHERE id = $1`, [id]);
  for (const r of affected.rows) await schedSvc.revalidateSchedule(r.id).catch(() => {});
  res.json({ deleted: true });
});

// ── Office Hours ──────────────────────────────────────────────────────────────
const getOfficeHours = ah(async (req, res) => {
  const oh = await instrRepo.getOfficeHours(req.params.instructorId);
  res.json(oh);
});

// NEW-FU-52: pre-flight overlap check used by both addOfficeHour and
// updateOfficeHour. The DB has no exclusion constraint on (instructor, day,
// time-range).
//
// NEW-FU-64: the helper used to read outside a transaction — between the
// overlap check and the subsequent INSERT/UPDATE another admin could insert
// a colliding OH. We now accept an optional transactional client and use it
// to perform the read under the same lock the caller is already holding on
// the instructor row (`SELECT … FOR UPDATE` on instructors). Concurrent
// writes serialize behind the lock; the second one sees the first's write
// and is rejected here.
async function findOverlappingOH(instructorId, day, startTime, endTime, excludeId = null, client = null) {
  const db = client ?? { query: (t, p) => query(t, p) };
  const params = [instructorId, day, startTime, endTime];
  let sql = `
    SELECT id FROM office_hours
    WHERE instructor_id = $1 AND day = $2
      AND start_time < $4 AND end_time > $3
  `;
  if (excludeId) { sql += ` AND id != $5`; params.push(excludeId); }
  sql += ` LIMIT 1`;
  const res = await db.query(sql, params);
  return res.rows[0] ?? null;
}

// NEW-FU-64: wrap an OH write (add or update) in a tx that first locks the
// instructor row, then runs the overlap check + write inside that lock so
// concurrent admins can't race two overlapping OHs through the gap.
async function withInstructorLock(instructorId, fn) {
  const { getClient } = require('../config/db');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const lock = await client.query(
      `SELECT id FROM instructors WHERE id = $1 FOR UPDATE`,
      [instructorId]
    );
    if (lock.rowCount === 0) {
      await client.query('ROLLBACK').catch(() => {});
      const err = new Error('Instructor not found.');
      err.status = 404;
      throw err;
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // NEW-FU-48 + NEW-FU-66 + NEW-FU-81: signal pg to destroy a
    // possibly-bad connection. Wrapped in try/catch so a release-throws
    // (extremely rare, possible on a disposed client) doesn't suppress
    // the original `throw err`. This brings withInstructorLock in line
    // with the rest of the codebase's transactional sites — FU-66 had
    // applied this pattern to every other catch path but missed FU-64's
    // helper which was introduced in the same wave.
    try { client.release(err); } catch { /* ignore */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* already released via catch path */ }
  }
}

const addOfficeHour = ah(async (req, res) => {
  const { day, startTime, endTime } = req.body;
  if (!day || !startTime || !endTime)
    return badRequest(res, 'Please provide a day, a start time and an end time.');
  // NEW-M8: validate input shapes.
  if (!isUuid(req.params.instructorId))         return badRequest(res, 'instructorId must be a UUID.');
  if (!isDay(day))                              return badRequest(res, `Invalid day: "${day}".`);
  if (!isTime(startTime) || !isTime(endTime))   return badRequest(res, 'startTime and endTime must be HH:MM.');
  // NEW-FU-496 (Phase 120): window check before the ordering check (see createInstructor).
  { const we = officeHoursWindowError(startTime, endTime); if (we) return badRequest(res, we); } // NEW-FU-466 (Phase 112)
  if (startTime >= endTime)                     return badRequest(res, 'endTime must be after startTime (within 08:00–16:00).');
  // NEW-FU-52 + NEW-FU-64: overlap check + write under FOR UPDATE on the
  // instructor row, so concurrent admin OH writes serialize behind the lock
  // and the second one sees the first's commit (no TOCTOU window).
  try {
    const oh = await withInstructorLock(req.params.instructorId, async (client) => {
      const overlap = await findOverlappingOH(req.params.instructorId, day, startTime, endTime, null, client);
      if (overlap) {
        const err = new Error('This office hour overlaps an existing one for the same instructor and day.');
        err.status = 409;
        throw err;
      }
      return instrRepo.addOfficeHour(req.params.instructorId, { day, startTime, endTime }, client);
    });
    res.status(201).json(oh);
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    throw err;
  }
});

// NEW-FU-41: atomic office-hour update endpoint. Replaces the previous
// frontend "POST new + DELETE old" pattern which left a duplicate OH in
// the DB whenever the DELETE failed. The route is admin-only to stay in
// lockstep with FU-28's POST/DELETE gate — granting the same write power
// via PUT would break that symmetry.
const updateOfficeHour = ah(async (req, res) => {
  const { day, startTime, endTime } = req.body;
  if (!day || !startTime || !endTime)
    return badRequest(res, 'Please provide a day, a start time and an end time.');
  if (!isUuid(req.params.instructorId))         return badRequest(res, 'instructorId must be a UUID.');
  if (!isUuid(req.params.ohId))                 return badRequest(res, 'ohId must be a UUID.');
  if (!isDay(day))                              return badRequest(res, `Invalid day: "${day}".`);
  if (!isTime(startTime) || !isTime(endTime))   return badRequest(res, 'startTime and endTime must be HH:MM.');
  // NEW-FU-496 (Phase 120): window check before the ordering check (see createInstructor).
  { const we = officeHoursWindowError(startTime, endTime); if (we) return badRequest(res, we); } // NEW-FU-466 (Phase 112)
  if (startTime >= endTime)                     return badRequest(res, 'endTime must be after startTime (within 08:00–16:00).');
  // NEW-FU-52 + NEW-FU-64: overlap check + write under FOR UPDATE on the
  // instructor row to serialize concurrent admin writes.
  try {
    const oh = await withInstructorLock(req.params.instructorId, async (client) => {
      const overlap = await findOverlappingOH(
        req.params.instructorId, day, startTime, endTime, req.params.ohId, client
      );
      if (overlap) {
        const err = new Error('This office hour overlaps an existing one for the same instructor and day.');
        err.status = 409;
        throw err;
      }
      const updated = await instrRepo.updateOfficeHour(req.params.ohId, { day, startTime, endTime }, client);
      if (!updated) {
        const err = new Error('Office hour not found.');
        err.status = 404;
        throw err;
      }
      return updated;
    });
    res.json(oh);
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    throw err;
  }
});

const deleteOfficeHour = ah(async (req, res) => {
  await instrRepo.deleteOfficeHour(req.params.ohId);
  res.json({ deleted: true });
});

// ── Venues ────────────────────────────────────────────────────────────────────
// NEW-FU-274 (Phase 51 #5): same ?term= filter as getCourses.
const getVenues = ah(async (req, res) => { res.json(await venueRepo.findAll(req.query.term || null)); });

// NEW-FU-483 (Phase 117): whole-room vs sub-room identity rule. Replaces the Phase-115
// venueCanonicalKey approach (which only prevented format variants of the same key,
// but did not enforce the whole-room/sub-room exclusivity constraint).
//
// A room identified by building+room may exist as the whole room (no suffix) OR as
// one-or-more sub-rooms (with suffixes) — never both. Format variants like "01-002"
// and "01-0002" are the same building+room (parsed integers, not strings).
//
// Returns a plain-English conflict message when adding `newName` is blocked, null when allowed.
function venueConflictError(newName, existingNames) {
  function parseParts(n) {
    const ps = String(n || '').trim().split('-');
    return {
      bldg:   parseInt(ps[0], 10),
      room:   parseInt(ps[1], 10),
      suffix: (ps[2] || '').toUpperCase(),
    };
  }
  const { bldg: nb, room: nr, suffix: ns } = parseParts(newName);
  if (isNaN(nb) || isNaN(nr)) return null; // malformed — other validators handle it

  const sameRoom = (existingNames || []).filter(n => {
    const { bldg, room } = parseParts(n);
    return bldg === nb && room === nr;
  });

  if (sameRoom.length === 0) return null; // nothing here yet — allow

  if (!ns) {
    // Adding a whole room (no suffix)
    if (sameRoom.some(n => !parseParts(n).suffix))
      return 'A room with this building and room number already exists.';
    return 'Sub-rooms of this room already exist. The whole room cannot be added alongside its sub-rooms.';
  } else {
    // Adding a sub-room (has suffix)
    if (sameRoom.some(n => !parseParts(n).suffix))
      return 'The whole room is already registered. Sub-rooms cannot be added once the whole room exists.';
    if (sameRoom.some(n => parseParts(n).suffix === ns))
      return 'A sub-room with this suffix already exists. Choose a different suffix.';
    return null; // different suffix, no whole room — allowed
  }
}

const createVenue = ah(async (req, res) => {
  const { name, type, capacity } = req.body;
  if (!name || !type || capacity == null)
    return badRequest(res, 'name, type, capacity required.');
  // NEW-M8: validate venue type enum + capacity range.
  if (!VALID_VENUE_TYPES.has(type)) return badRequest(res, `Invalid venue type: "${type}".`);
  const cap = parseInt(capacity, 10);
  // NEW-FU-225 (Phase 97): cap 10000 → 250 (realistic KFUPM venue max).
  if (!Number.isInteger(cap) || cap < 1 || cap > 250)
    return badRequest(res, 'capacity must be an integer between 1 and 250.');
  // NEW-FU-46: enforce DB VARCHAR(80) on venues.name.
  if (!isBoundedString(name, 80)) return badLength(res, 'name', 80);
  // NEW-FU-59: trim before write (parity with createInstructor).
  const cleanName = normalizeName(name);
  // NEW-FU-483 (Phase 117): whole-room/sub-room exclusivity check backstops the modal's
  // client-side gate. Handles format variants (01-002 ≡ 01-0002), whole-room blocking,
  // and sub-room coexistence rules. Returns a plain-English message when blocked.
  // NEW-FU-525 (Batch 8 Issue 2): scope the whole-room/sub-room duplicate check
  // STRICTLY to the current term — venues OWNED by this term or assigned to a section
  // in it. The old query also matched `owner_semester IS NULL` (global/legacy venues),
  // which made a globally-seeded room name register as "already taken" in EVERY term
  // and contradicted the term-scoped frontend check — the cross-term "phantom" block.
  // Each term is independent: a room name free in this term may be added here even if
  // another term (or the legacy global set) has it. With no active term (rare global
  // add) we fall back to checking the global set so a true global add still dedups.
  const ownerSemester = (req.activeTerm && req.activeTerm.code) || req.body.ownerSemester || null;
  const existingVenues = ownerSemester
    ? await query(
        `SELECT name FROM venues
          WHERE owner_semester = $1
             OR id IN (SELECT s.venue_id FROM sections s
                       JOIN schedules sc ON sc.id = s.schedule_id WHERE sc.semester = $1)`,
        [ownerSemester]
      )
    : await query(`SELECT name FROM venues WHERE owner_semester IS NULL`);
  const conflictMsg = venueConflictError(cleanName, existingVenues.rows.map(v => v.name));
  if (conflictMsg) return res.status(409).json({ error: conflictMsg });
  const venue = await venueRepo.create({ name: cleanName, type, capacity, ownerSemester });
  // NEW-FU-434 (Phase 106 item 6): auto-replace a placeholder venue of the SAME type.
  const replacedDummy = await replaceOldestDummyVenue(req.body.ownerSemester, venue.id, type);
  res.status(201).json({ ...venue, replacedDummy });
});

const updateVenue = ah(async (req, res) => {
  // M-3: allowlist fields to prevent mass-assignment
  const { name, type, capacity } = req.body;
  // NEW-M8: validate enum + range when provided.
  if (type && !VALID_VENUE_TYPES.has(type)) return badRequest(res, `Invalid venue type: "${type}".`);
  if (capacity != null) {
    const cap = parseInt(capacity, 10);
    // NEW-FU-15: tighten capacity max bound to match createVenue (was missing
    // upper bound on update, allowing 1..Infinity through to pg).
    // NEW-FU-225 (Phase 97): cap 10000 → 250 (realistic KFUPM venue max).
    if (!Number.isInteger(cap) || cap < 1 || cap > 250)
      return badRequest(res, 'capacity must be an integer between 1 and 250.');
  }
  // NEW-FU-46: enforce DB VARCHAR(80) on venues.name when supplied.
  if (name != null && !isBoundedString(name, 80)) return badLength(res, 'name', 80);
  // NEW-FU-59: trim before update (parity with createVenue).
  const venue = await venueRepo.update(req.params.venueId, { name: name != null ? normalizeName(name) : undefined, type, capacity });
  // NEW-M9: surface missing rows as 404.
  if (!venue) return res.status(404).json({ error: 'Venue not found.' });
  res.json(venue);
});

const deleteVenue = ah(async (req, res) => {
  const id = req.params.venueId;
  // NEW-FU-561 (audit P2-1): venues.id is referenced by sections.venue_id ON DELETE SET
  // NULL — same hazard as deleteInstructor. Refuse if assigned in a finalized/archived
  // term; otherwise delete and revalidate each affected schedule (orphaned sections → R-10).
  const affected = await query(
    `SELECT DISTINCT sc.id, sc.status, sc.archived_at
       FROM sections s JOIN schedules sc ON sc.id = s.schedule_id
      WHERE s.venue_id = $1`, [id]);
  if (affected.rows.some(r => r.status === 'Finalized' || r.archived_at !== null))
    return res.status(409).json({ error: 'This venue is assigned in a finalized or archived term and cannot be deleted. Reassign those sections first.' });
  await venueRepo.delete(id);
  for (const r of affected.rows) await schedSvc.revalidateSchedule(r.id).catch(() => {});
  res.json({ deleted: true });
});

// NEW-FU-95 + NEW-FU-110: return the next unused two-digit section number
// for a course within a schedule, scoped to a section type. The
// `sectionType` query parameter selects which range to search:
//   sectionType=Lec → search 01..49
//   sectionType=Lab → search 50..99
//   sectionType absent or invalid → default to Lec range (backward-compat
//                                   with FU-95 callers that didn't supply it)
// Returns 409 when all numbers in the requested range are taken.
const getNextSectionNumber = ah(async (req, res) => {
  const { scheduleId, courseId } = req.params;
  if (!isUuid(scheduleId)) return badRequest(res, 'scheduleId must be a UUID.');
  if (!isUuid(courseId))   return badRequest(res, 'courseId must be a UUID.');
  const sectionType = req.query.sectionType === 'Lab' ? 'Lab' : 'Lec';
  const sectRepo = new (require('../repositories/SectionRepository'))();
  const next = await sectRepo.getNextSectionNumber(scheduleId, courseId, sectionType);
  if (!next) {
    const range = sectionType === 'Lec' ? '01..49' : '50..99';
    return res.status(409).json({ error: `All ${sectionType} section numbers (${range}) are in use for this course.` });
  }
  res.json({ nextSectionNumber: next, sectionType });
});

const suggestSchedule = ah(async (req, res) => {
  const { courseConfigs } = req.body;
  // NEW-FU-10: a string has .length too — explicitly require Array so a
  // payload like `"abc"` doesn't sneak past as 3-element courseConfigs.
  if (!Array.isArray(courseConfigs) || courseConfigs.length === 0)
    return res.status(400).json({ error: 'courseConfigs must be a non-empty array.' });
  // NEW-FU-17: validate pattern + sections per entry. The service had silent
  // fallbacks (any non-STT pattern → MW; non-numeric sections → 0 iterations).
  // Reject explicitly so typos surface as precise 400s instead of silently
  // dropping courses from the suggested schedule.
  for (const cfg of courseConfigs) {
    if (!cfg || typeof cfg !== 'object' || !cfg.courseId)
      return res.status(400).json({ error: 'Each courseConfig must include a courseId.' });
    // NEW-FU-241 + FU-248: accept either the legacy single-name
    // (cfg.pattern: 'STT_50') OR the new two-axis form
    // (cfg.dayPattern: 'STT', cfg.duration: 50). resolvePattern()
    // handles both shapes — we just need to thread whichever the
    // caller supplied into the same validator.
    const resolveInput = cfg.dayPattern
      ? { dayPattern: cfg.dayPattern, duration: cfg.duration }
      : cfg.pattern;
    if (resolveInput != null && !sectionPattern.resolvePattern(resolveInput)) {
      const allowed = Object.keys(sectionPattern.PATTERN_DEFS).sort();
      const templates = Object.keys(sectionPattern.DAY_TEMPLATES).sort();
      return res.status(400).json({
        error:
          `Invalid pattern. Pass either { pattern: "<NAME>" } where NAME ∈ {${allowed.join(', ')}}, ` +
          `or { dayPattern: "<TEMPLATE>", duration: 50|75 } where TEMPLATE ∈ {${templates.join(', ')}}.`,
      });
    }
    // NEW-FU-253: optional per-course single-day override. Lecture
    // side: `cfg.day` is honored only when dayPattern === 'ONE_DAY'
    // (other templates are inherently multi-day). Lab side:
    // `cfg.labDay` constrains the lab to a single weekday.
    //
    // We use a TIGHTER day set than the general `isDay` here —
    // KFUPM's academic week is Sun-Thu, so allowing Friday/Saturday
    // (which `isDay` permits for the section-CRUD endpoints) would
    // surface as a confusing 500 from generateSlots returning an
    // empty slot list when resolvePattern rejects Friday.
    const SUGGEST_DAYS = new Set(['Sunday','Monday','Tuesday','Wednesday','Thursday']);
    if (cfg.day != null && !SUGGEST_DAYS.has(cfg.day)) {
      return res.status(400).json({
        error: `Invalid day "${cfg.day}". Expected one of Sunday, Monday, Tuesday, Wednesday, Thursday.`,
      });
    }
    if (cfg.labDay != null && !SUGGEST_DAYS.has(cfg.labDay)) {
      return res.status(400).json({
        error: `Invalid labDay "${cfg.labDay}". Expected one of Sunday, Monday, Tuesday, Wednesday, Thursday.`,
      });
    }
    // NEW-FU-253: optional lab duration override (50, 75, or 160 min
    // — the allowed lab durations from the FU-236 rule table).
    if (cfg.labDuration != null) {
      const ld = Number(cfg.labDuration);
      if (![50, 75, 160].includes(ld)) {
        return res.status(400).json({
          error: `Invalid labDuration ${cfg.labDuration}. Expected 50, 75, or 160 minutes.`,
        });
      }
      cfg.labDuration = ld;
    }
    if (cfg.sections != null) {
      const n = parseInt(cfg.sections, 10);
      // NEW-FU-30: unify with SuggestModal's `<input max="10">`. The earlier
      // FU-17 bound of 20 silently accepted requests the UI cannot generate.
      // Picking the tighter limit means the API and UI agree; the limit can
      // be raised later if needed.
      if (!Number.isInteger(n) || n < 1 || n > 10)
        return res.status(400).json({ error: 'Each section count must be a whole number between 1 and 10.' });
      // NEW-FU-33: propagate the canonical integer to the service. Without
      // this, payloads like {"sections":"5abc"} pass the validator (parseInt
      // returns 5) but the service's `for (let sec=1; sec<=cfg.sections; sec++)`
      // coerces '5abc' via Number() → NaN, so the loop silently does nothing
      // and the course gets zero sections.
      // Note: createCourse/updateCourse credits & numSections and create/
      // updateVenue capacity DON'T need this — their repositories re-parse
      // with parseInt() so the asymmetry is invisible at the storage layer.
      cfg.sections = n;
    }
  }
  // NEW-FU-262: forward optional applyToCourseIds — when supplied,
  // only those courses' sections are wiped+replaced; others stay
  // untouched. Controller validation: must be array of UUID strings;
  // empty array is allowed and means "apply nothing" (no-op).
  const { applyToCourseIds, maxConflictsPerSection } = req.body;
  if (applyToCourseIds != null) {
    if (!Array.isArray(applyToCourseIds) || !applyToCourseIds.every(id => typeof id === 'string')) {
      return res.status(400).json({ error: 'applyToCourseIds must be an array of course UUID strings.' });
    }
  }
  // NEW-FU-316 (Phase 29): tunable conflict tolerance. Accepted values:
  //   0 / 1 / 2  — strict; sections whose best placement exceeds the
  //                tolerance are SKIPPED and reported in placementSkipped[]
  //   'any'      — legacy "force every section into the best available
  //                slot, even with conflicts" behavior
  //   undefined  — same as 'any' (backward-compat for legacy callers)
  if (maxConflictsPerSection != null) {
    const v = maxConflictsPerSection;
    const valid = v === 'any' || (typeof v === 'number' && v >= 0 && v <= 10 && Number.isInteger(v));
    if (!valid) {
      return res.status(400).json({ error: "maxConflictsPerSection must be 'any' or an integer 0..10." });
    }
  }
  // NEW-FU-361 (Phase 35): `previewOnly` runs the greedy without writing
  // to DB and returns the residual conflict count + rule IDs. The
  // frontend uses this to ask "your choices will create N conflicts —
  // apply anyway, or let Suggest find a better config?" before
  // persisting. Underlying mechanism: forwards to options.dryRun
  // which Phase 21's recommend() already wired.
  //
  // NEW-FU-363 (Phase 35): `relaxIfConflicts` — when true AND the
  // initial preview has residual conflicts, the service tries up to
  // 8 alternative (duration, dayPattern) variants per course and
  // returns the conflict-minimizing variant. Implies previewOnly
  // (a relaxation result is never written directly — the frontend
  // shows the relaxed plan, then the user re-submits the relaxed
  // configs without `relaxIfConflicts` to persist).
  const { previewOnly, relaxIfConflicts } = req.body;
  if (typeof previewOnly !== 'undefined' && typeof previewOnly !== 'boolean') {
    return res.status(400).json({ error: 'previewOnly must be a boolean.' });
  }
  if (typeof relaxIfConflicts !== 'undefined' && typeof relaxIfConflicts !== 'boolean') {
    return res.status(400).json({ error: 'relaxIfConflicts must be a boolean.' });
  }
  // NEW-FU-425 (Phase 104 item 2): allowDummyResources — the explicit auto-fix
  // (and its apply) may invent term-local placeholder instructors/venues to keep
  // every section instead of dropping. Forwarded to both the relaxation and the
  // direct apply below.
  const { allowDummyResources } = req.body;
  const opts = {
    applyToCourseIds: applyToCourseIds ?? undefined,
    maxConflictsPerSection: maxConflictsPerSection ?? undefined,
    allowDummyResources: allowDummyResources === true,
  };
  if (relaxIfConflicts) {
    // NEW-FU-372 (Phase 36): suggestWithRelaxation now guarantees its
    // result is either a zero-conflict plan (feasible:true) OR a
    // feasible:false response with suggestedRemovals. The controller
    // forwards both shapes — the frontend decides which to render.
    // Either way, no DB write happens here (relaxation is preview-only;
    // the user must re-POST with the relaxed configs and previewOnly=false
    // to persist). This is the contract that prevents accidentally
    // persisting a non-zero plan.
    const result = await suggestSvc.suggestWithRelaxation(
      req.params.scheduleId, courseConfigs, opts,
    );
    return res.json(result);
  }
  const result = await suggestSvc.suggest(req.params.scheduleId, courseConfigs, {
    ...opts,
    dryRun: Boolean(previewOnly),
  });
  res.json(result);
});

// NEW-FU-261: GET /schedules/:scheduleId/suggest-recommend
// Read-only — synthesizes default per-course configs, runs the
// suggester's greedy in dry-run mode, returns the recommendation
// + capacity warnings. Drives the SuggestModal's pre-fill on open.
//
// NEW-FU-346 (Phase 33): accepts an optional `sectionsHint` query
// param (URI-encoded JSON: { [courseId]: numSections }). When
// supplied, recommend() treats that course as if it had the hinted
// section count, so the saturation map reflects what the user just
// chose in the modal. Lets the modal re-recommend live as the user
// bumps "# Sections."
const suggestRecommend = ah(async (req, res) => {
  let sectionsHint;
  if (req.query.sectionsHint) {
    try {
      sectionsHint = JSON.parse(req.query.sectionsHint);
      if (sectionsHint == null || typeof sectionsHint !== 'object') sectionsHint = undefined;
    } catch {
      return res.status(400).json({ error: 'sectionsHint must be URI-encoded JSON.' });
    }
  }
  // NEW-FU-381 (Phase 99 item 2 + 5): the live auto-choose passes the modal's
  // current per-course configs + the set of user-locked courses + fast=1 (skip
  // the heavy greedy). All URI-encoded JSON, mirroring sectionsHint. Each is
  // optional and parse-tolerant — a bad value just degrades to the legacy
  // behaviour rather than 400-ing the whole live request.
  let configs, lockedCourseIds;
  if (req.query.configs) {
    try { const v = JSON.parse(req.query.configs); if (Array.isArray(v)) configs = v; } catch { /* ignore */ }
  }
  if (req.query.lockedCourseIds) {
    try { const v = JSON.parse(req.query.lockedCourseIds); if (Array.isArray(v)) lockedCourseIds = v; } catch { /* ignore */ }
  }
  const fast = req.query.fast === '1' || req.query.fast === 'true';
  const result = await suggestSvc.recommend(req.params.scheduleId, {
    sectionsHint, configs, lockedCourseIds, fast,
  });
  res.json(result);
});

// NEW-FU-318 (Phase 29): Quick Fix resolver.
//   POST /schedules/:scheduleId/quick-fix       → returns a plan (no writes)
//   POST /schedules/:scheduleId/quick-fix/apply → atomic apply of selected ops
const quickFixSvc = require('../services/QuickFixService');
const quickFixPlan = ah(async (req, res) => {
  const result = await quickFixSvc.plan(req.params.scheduleId);
  res.json(result);
});
const quickFixApply = ah(async (req, res) => {
  const { ops } = req.body;
  if (!Array.isArray(ops)) {
    return res.status(400).json({ error: 'ops must be an array.' });
  }
  // Validate each op shape — defense against arbitrary client payloads.
  // NEW-FU-327 (Phase 30): allow 'add-day'.
  // NEW-FU-333 (Phase 31): allow 'move'.
  // NEW-FU-348 (Phase 33): allow 'compound' — wraps multiple sub-ops
  // applied atomically inside the same transaction. Each subOp is
  // validated recursively.
  // NEW-FU-227 (Phase 97): the resolver (QuickFixService) GENERATES and APPLIES
  // three course/venue-level metadata ops — 'mark-venue-exempt', 'reclassify-venue',
  // 'untag-has-lab' — but this request validator's allow-list omitted them, so
  // applying any plan containing one failed with "Unsupported op.type:
  // mark-venue-exempt" and NO conflict could be cleared. Kept in sync with
  // QuickFixService's `supportedOpTypes`. (Root cause of the broken Quick Fix.)
  // NEW-FU-426 (Phase 105): allow the placeholder-resource ops the resolver now
  // generates ('add-dummy-instructor' / 'add-dummy-venue') — same allow-list /
  // supportedOpTypes sync discipline as NEW-FU-227 above. Omitting them would
  // 400 every plan that resolves a capacity bind with a placeholder.
  const ALLOWED_OP_TYPES = ['reassign-instructor', 'reassign-venue', 'drop', 'add-day', 'move', 'compound',
    'mark-venue-exempt', 'reclassify-venue', 'untag-has-lab',
    'add-dummy-instructor', 'add-dummy-venue',
    // NEW-FU-561 (audit P1-8): QuickFixService emits this (Phase 109 / FU-460) but it
    // was never added here, so quickFixApply 400'd and aborted ANY plan containing it.
    'assign-office-hours'];
  // These metadata ops act on a course or venue row, not a section, so they
  // carry courseId / venueId instead of sectionId.
  const COURSE_LEVEL_OPS = new Set(['mark-venue-exempt', 'untag-has-lab']);
  const VENUE_LEVEL_OPS  = new Set(['reclassify-venue']);
  // assign-office-hours is instructor-scoped: it carries instructorId + officeHours, no sectionId.
  const INSTRUCTOR_LEVEL_OPS = new Set(['assign-office-hours']);
  const isHHMM = (s) => typeof s === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(s);
  function validateOp(o, depth = 0) {
    if (!o || typeof o.type !== 'string') return 'Each op must have a type field.';
    if (!ALLOWED_OP_TYPES.includes(o.type)) return `Unsupported op.type: ${o.type}.`;
    // Course/venue-level metadata ops validate their own id field and are
    // section-less; everything else is section-scoped.
    if (COURSE_LEVEL_OPS.has(o.type)) {
      return typeof o.courseId === 'string' ? null : `${o.type} op requires courseId: string.`;
    }
    if (VENUE_LEVEL_OPS.has(o.type)) {
      if (typeof o.venueId !== 'string') return 'reclassify-venue op requires venueId: string.';
      if (typeof o.newType !== 'string') return 'reclassify-venue op requires newType: string.';
      return null;
    }
    if (INSTRUCTOR_LEVEL_OPS.has(o.type)) {
      if (typeof o.instructorId !== 'string') return 'assign-office-hours op requires instructorId: string.';
      if (!o.officeHours || typeof o.officeHours !== 'object') return 'assign-office-hours op requires officeHours: object.';
      return null;
    }
    if (typeof o.sectionId !== 'string') return 'op.sectionId must be a string.';
    if (o.type === 'add-day') {
      if (!Array.isArray(o.addDays) || o.addDays.length === 0
          || !o.addDays.every(d => typeof d === 'string')) {
        return 'add-day op requires addDays: string[].';
      }
    }
    if (o.type === 'move') {
      if (!isHHMM(o.newStartTime) || !isHHMM(o.newEndTime)) {
        return 'move op requires newStartTime and newEndTime as HH:MM strings.';
      }
    }
    if (o.type === 'compound') {
      if (depth > 0) return 'compound op cannot nest inside another compound.';
      if (!Array.isArray(o.subOps) || o.subOps.length === 0) {
        return 'compound op requires non-empty subOps: array.';
      }
      for (const sub of o.subOps) {
        const subErr = validateOp(sub, depth + 1);
        if (subErr) return `compound subOp: ${subErr}`;
      }
    }
    // NEW-FU-426 (Phase 105): placeholder venue op carries the required venue
    // type so apply() mints the right kind; apply() defaults it defensively,
    // but reject an explicitly non-string value.
    if (o.type === 'add-dummy-venue' && o.venueType !== undefined
        && typeof o.venueType !== 'string') {
      return 'add-dummy-venue op venueType must be a string when provided.';
    }
    return null;
  }
  for (const op of ops) {
    const err = validateOp(op);
    if (err) return res.status(400).json({ error: err });
  }
  const result = await quickFixSvc.apply(req.params.scheduleId, ops);
  res.json(result);
});

// ── Terms (NEW-FU-161..163) ───────────────────────────────────────────────────
const termSvc = require('../services/TermService');

const listTerms = ah(async (req, res) => {
  // Active term comes from a query param (`?activeCode=252`) so the frontend
  // can ask "which term am I currently viewing?" without backend session state.
  // FU-159 decision: URL query param is the single source of truth.
  // NEW-FU-193: ?includeArchived=true returns archived terms too. Default
  // false matches the picker's "show only live terms" common case.
  const activeCode = req.query.activeCode || null;
  const includeArchived = req.query.includeArchived === 'true';
  const terms = await termSvc.listTerms({ activeCode, includeArchived });
  res.json(terms);
});

const createTerm = ah(async (req, res) => {
  const { code, startsAt, endsAt } = req.body;
  if (typeof code !== 'string') {
    return res.status(400).json({ error: 'code must be a string matching ^\\d{2}[123]$.' });
  }
  // NEW-FU-232: startsAt/endsAt are optional. The service silently
  // ignores them when the code has a known override (override wins);
  // otherwise it validates the season window and persists to the new
  // schedule row. Sending one without the other is a user error and
  // gets caught by the validator with a clear message.
  if ((startsAt && !endsAt) || (!startsAt && endsAt)) {
    return res.status(400).json({
      error: 'startsAt and endsAt must be supplied together (or both omitted).',
    });
  }
  try {
    const term = await termSvc.createTerm({
      code, createdBy: req.user?.id,
      startsAt, endsAt,
    });
    res.status(201).json(term);
  } catch (e) {
    if (e.code === 'CONFLICT')  return res.status(409).json({ error: e.message });
    // NEW-FU-217: BAD_INPUT covers range-guard rejections too.
    if (e.code === 'BAD_INPUT') return res.status(400).json({ error: e.message });
    if (/Invalid term code/.test(e.message)) return res.status(400).json({ error: e.message });
    throw e;
  }
});

const archiveTerm = ah(async (req, res) => {
  const { code } = req.params;
  // NEW-FU-452 (Phase 107 D3): prefer the server-resolved active term (header) over the query param.
  const activeCode = req.activeTerm?.code || req.query.activeCode || null;
  try {
    const out = await termSvc.archiveTerm({ code, activeCode });
    res.json(out);
  } catch (e) {
    if (e.code === 'CONFLICT')  return res.status(409).json({ error: e.message });
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
    throw e;
  }
});

const unarchiveTerm = ah(async (req, res) => {
  const { code } = req.params;
  try {
    const out = await termSvc.unarchiveTerm({ code });
    res.json(out);
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
    throw e;
  }
});

const setTermStatus = ah(async (req, res) => {
  const { code }      = req.params;
  const { status }    = req.body;
  if (typeof status !== 'string') {
    return res.status(400).json({ error: 'status must be a string (Draft | PendingApproval | Finalized).' });
  }
  try {
    const out = await termSvc.setTermStatus({ code, newStatus: status });
    res.json(out);
  } catch (e) {
    if (e.code === 'BAD_INPUT')     return res.status(400).json({ error: e.message });
    if (e.code === 'NOT_FOUND')     return res.status(404).json({ error: e.message });
    // NEW-FU-199: archived → 409, hard conflict → 422 (the two refusal axes
    // for status mutations).
    if (e.code === 'CONFLICT')      return res.status(409).json({ error: e.message });
    if (e.code === 'UNPROCESSABLE') return res.status(422).json({ error: e.message, details: e.details });
    throw e;
  }
});

const renameTerm = ah(async (req, res) => {
  const { code } = req.params;
  const { newCode } = req.body;
  // NEW-FU-452 (Phase 107 D3): prefer the server-resolved active term (header) over the query param.
  const activeCode = req.activeTerm?.code || req.query.activeCode || null;
  if (typeof newCode !== 'string') {
    return res.status(400).json({ error: 'newCode must be a string matching ^\\d{2}[123]$.' });
  }
  try {
    const out = await termSvc.renameTerm({ code, newCode, activeCode });
    res.json(out);
  } catch (e) {
    if (e.code === 'CONFLICT')  return res.status(409).json({ error: e.message });
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
    // NEW-FU-217: BAD_INPUT covers range-guard rejections too.
    if (e.code === 'BAD_INPUT') return res.status(400).json({ error: e.message });
    if (/Invalid term code/.test(e.message)) return res.status(400).json({ error: e.message });
    throw e;
  }
});

const deleteTerm = ah(async (req, res) => {
  const { code } = req.params;
  // NEW-FU-452 (Phase 107 D3): prefer the server-resolved active term (from the
  // X-Active-Term header the axios interceptor always sends) over a per-call query
  // param that's easy to omit — so "can't delete the active term" can't be bypassed
  // by just dropping ?activeCode. Query param remains a fallback for non-app clients.
  const activeCode = req.activeTerm?.code || req.query.activeCode || null;
  try {
    const out = await termSvc.deleteTerm({ code, activeCode });
    res.json(out);
  } catch (e) {
    if (e.code === 'CONFLICT')  return res.status(409).json({ error: e.message });
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
    throw e;
  }
});

module.exports = {
  login, logout,
  listSchedules, createSchedule,
  getSections, createSection, updateSection, deleteSection, extendSection, previewConflicts,
  autoFixAround, autoFixAroundApply,
  quickFixPlan, quickFixApply,
  importSchedule, upload,
  suggestSchedule, suggestRecommend,
  saveSchedule, getConflicts, exportSchedule,
  getCourses, createCourse, updateCourse, deleteCourse,
  getInstructors, createInstructor, updateInstructor, deleteInstructor, getSuggestedOfficeHour,
  getOfficeHours, addOfficeHour, updateOfficeHour, deleteOfficeHour,
  getNextSectionNumber,   // NEW-FU-95
  getVenues, createVenue, updateVenue, deleteVenue,
  // NEW-FU-161..163, FU-185, FU-189, FU-193
  listTerms, createTerm, deleteTerm, renameTerm, setTermStatus,
  archiveTerm, unarchiveTerm,
};
