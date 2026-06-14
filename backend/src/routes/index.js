const router = require('express').Router();
const ctrl   = require('../controllers/index');
const { authenticate, requireRole } = require('../middleware/auth');
// NEW-FU-210: cooperative active-term enforcement.
//   • extractActiveTerm reads `X-Active-Term` and attaches req.activeTerm.
//     Applied below to ALL authenticated routes — cheap (one DB SELECT only
//     when the header is present, and only on the routes downstream of
//     `router.use(authenticate)`).
//   • refuseIfActiveTermArchived is opt-in per-route and returns 409 when
//     the frontend has asserted it's viewing an archived term. Wired into
//     POST/PUT/DELETE on global resources (courses, instructors, venues,
//     office-hours) below.
const { extractActiveTerm, refuseIfActiveTermArchived } = require('../middleware/activeTerm');

// NEW-FU-9: centralized UUID validation for every paramized route. Express
// runs router.param handlers before the route handler, so a malformed UUID
// returns a precise 400 instead of falling through to pg and surfacing as
// a sanitized 500. The existing inline isUuid checks in controllers (added
// by M-8) stay as defense-in-depth but become unreachable for these params.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validateUuid = (name) => (req, res, next, value) => {
  if (!UUID_RE.test(value)) {
    return res.status(400).json({ error: `${name} must be a UUID.` });
  }
  next();
};
router.param('scheduleId',   validateUuid('scheduleId'));
router.param('courseId',     validateUuid('courseId'));
router.param('instructorId', validateUuid('instructorId'));
router.param('venueId',      validateUuid('venueId'));
router.param('sectionId',    validateUuid('sectionId'));
router.param('ohId',         validateUuid('ohId'));

// NEW-H5: in-process token-bucket rate limiter for /auth/login. A real
// production deployment behind multiple workers should use a shared store
// (Redis), but this dramatically slows brute-force from a single IP and
// is acceptable for the current single-instance topology.
//
// NEW-FU-37 made req.ip reliable on Render (trust proxy = 1). NEW-FU-53
// further hardens the bucket-key resolution:
//   1. req.ip                  — the trust-proxy-derived client IP
//   2. req.socket.remoteAddress — fallback for transport-layer requests
//                                 that somehow bypassed Express's IP
//                                 resolution
//   3. 'unknown'                — last-resort; gets a TIGHTER limit so a
//                                 flood of header-less requests can only
//                                 lock out itself, not legitimate clients.
const LOGIN_WINDOW_MS    = 60_000;
const LOGIN_MAX          = 8;
const LOGIN_MAX_UNKNOWN  = 3;   // NEW-FU-53: stricter limit for unidentifiable clients
const loginAttempts      = new Map();
function rateLimitLogin(req, res, next) {
  const ip   = req.ip || req.socket?.remoteAddress || null;
  const key  = ip || 'unknown';
  const max  = ip ? LOGIN_MAX : LOGIN_MAX_UNKNOWN;
  const now  = Date.now();
  let rec    = loginAttempts.get(key);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginAttempts.set(key, rec);
  }
  rec.count++;
  if (rec.count > max) {
    const retrySec = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
    res.setHeader('Retry-After', retrySec);
    return res.status(429).json({ error: `Too many login attempts. Try again in ${retrySec}s.` });
  }
  next();
}
// Sweep stale buckets every 5 min so the Map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) if (now > v.resetAt) loginAttempts.delete(k);
}, 5 * 60_000).unref();

// Public
router.get ('/health',     (req, res) => res.json({ status: 'ok' }));
// NOTE: /health/version lives in app.js (NEW-FU-303, Phase 27) and was
// augmented in Phase 35 with `dirty` + `phaseTag` so a user can answer
// "is my backend stale?" without shell access.
router.post('/auth/login', rateLimitLogin, ctrl.login);

// All routes below require JWT
router.use(authenticate);
// NEW-FU-210: resolve the asserted active term once per authenticated
// request. Sets req.activeTerm = { code, scheduleId, archivedAt } | null.
// Cheap when the header is absent; one cached-pool SELECT when present.
router.use(extractActiveTerm);

// NEW-M3: explicit logout endpoint. Stateless JWTs cannot be invalidated
// server-side without a denylist; the route exists so the frontend has a
// single place to call and so a future denylist hooks in without churn.
router.post('/auth/logout', ctrl.logout);

// ── Courses ───────────────────────────────────────────────────────────────────
// NEW-C3: shared reference data (courses/instructors/venues) is admin-only
// to write. Schedulers can still read everything and freely edit sections.
// NEW-FU-211: refuseIfActiveTermArchived blocks mutations when the
// request's X-Active-Term header asserts an archived term. Reads stay open.
router.get   ('/courses',          ctrl.getCourses);
router.post  ('/courses',          requireRole('admin'), refuseIfActiveTermArchived, ctrl.createCourse);
router.put   ('/courses/:courseId',requireRole('admin'), refuseIfActiveTermArchived, ctrl.updateCourse);
router.delete('/courses/:courseId',requireRole('admin'), refuseIfActiveTermArchived, ctrl.deleteCourse);

// ── Instructors ───────────────────────────────────────────────────────────────
router.get   ('/instructors',                               ctrl.getInstructors);
router.post  ('/instructors',                               requireRole('admin'), refuseIfActiveTermArchived, ctrl.createInstructor);
router.put   ('/instructors/:instructorId',                 requireRole('admin'), refuseIfActiveTermArchived, ctrl.updateInstructor);
router.delete('/instructors/:instructorId',                 requireRole('admin'), refuseIfActiveTermArchived, ctrl.deleteInstructor);
// NEW-FU-461 (Phase 109): suggested default office-hours for the Add-Instructor panel.
router.get   ('/office-hours/suggested',                    ctrl.getSuggestedOfficeHour);
router.get   ('/instructors/:instructorId/office-hours',    ctrl.getOfficeHours);
// NEW-FU-28: addOfficeHour is now admin-only, matching DELETE (already
// admin) and matching the smoke test's implicit assumption that adding an
// OH is an admin operation. Symmetric gates on add/delete also prevent
// the previous UX where a scheduler could add an OH they could not later
// remove. The existing SidePanel form's catch block surfaces the 403 as
// "Insufficient permissions." — same pattern as course/instructor/venue
// add buttons.
// NEW-FU-211: OH timing was an explicit Phase-11 request — block all three
// OH mutation verbs when the active-term context is archived.
router.post  ('/instructors/:instructorId/office-hours',    requireRole('admin'), refuseIfActiveTermArchived, ctrl.addOfficeHour);
// NEW-FU-41: atomic office-hour update. Replaces the frontend's previous
// create-new + delete-old dance, which silently duplicated OH rows on
// partial failure. Admin-only to stay in lockstep with the POST/DELETE
// gate from FU-28.
router.put   ('/instructors/:instructorId/office-hours/:ohId', requireRole('admin'), refuseIfActiveTermArchived, ctrl.updateOfficeHour);
router.delete('/instructors/:instructorId/office-hours/:ohId', requireRole('admin'), refuseIfActiveTermArchived, ctrl.deleteOfficeHour);

// ── Venues ────────────────────────────────────────────────────────────────────
router.get   ('/venues',         ctrl.getVenues);
router.post  ('/venues',         requireRole('admin'), refuseIfActiveTermArchived, ctrl.createVenue);
router.put   ('/venues/:venueId',requireRole('admin'), refuseIfActiveTermArchived, ctrl.updateVenue);
router.delete('/venues/:venueId',requireRole('admin'), refuseIfActiveTermArchived, ctrl.deleteVenue);

// ── Schedules ─────────────────────────────────────────────────────────────────
// NEW-C3: schedule creation stays open to schedulers — the boot flow auto-
// provisions the working draft on first load. Department-membership ownership
// is a deferred design item (ownership not yet enforced).
router.get ('/departments/:departmentId/schedules', ctrl.listSchedules);
router.post('/schedules',                           ctrl.createSchedule);

// ── Sections ──────────────────────────────────────────────────────────────────
// Section CRUD is the scheduler's core workflow — open to scheduler role.
router.get   ('/schedules/:scheduleId/sections', ctrl.getSections);
router.post  ('/schedules/:scheduleId/sections', ctrl.createSection);
// NEW-FU-534 (Batch 12): dry-run the FULL conflict engine for a proposed change.
router.post  ('/schedules/:scheduleId/conflicts/preview', ctrl.previewConflicts);
router.put   ('/sections/:sectionId',            ctrl.updateSection);
router.delete('/sections/:sectionId',            ctrl.deleteSection);
// NEW-FU-277: extend a section group with additional meeting days. The
// R-15 quick-fix UI (Phase 23) calls this endpoint with the days from
// the chosen fix proposal. Scheduler-accessible (matches section CRUD).
router.post  ('/sections/:sectionId/extend',     ctrl.extendSection);
// NEW-FU-95: next-available two-digit section number for a course in a
// schedule (used by the "+ Add Section" UI to pre-fill the default).
router.get   ('/schedules/:scheduleId/courses/:courseId/next-section-number',
              ctrl.getNextSectionNumber);

// ── Conflict & Save ───────────────────────────────────────────────────────────
router.get ('/schedules/:scheduleId/conflicts', ctrl.getConflicts);
// Suggest regenerates the draft — non-destructive, scheduler-accessible.
router.post('/schedules/:scheduleId/suggest',   ctrl.suggestSchedule);
// NEW-FU-261: read-only recommendation endpoint. Synthesizes a default
// per-course config and runs the suggester's greedy in dry-run mode;
// returns the recommended placements + capacity warnings without
// touching the DB. Drives the Suggest modal's pre-fill on open.
router.get ('/schedules/:scheduleId/suggest-recommend', ctrl.suggestRecommend);
// NEW-FU-318 (Phase 29): Quick Fix resolver — generates a plan of
// minimally-destructive ops that resolve conflicts, then applies
// the user's selected subset atomically.
router.post('/schedules/:scheduleId/quick-fix',       ctrl.quickFixPlan);
router.post('/schedules/:scheduleId/quick-fix/apply', refuseIfActiveTermArchived, ctrl.quickFixApply);
// NEW-M5: finalizing a schedule is destructive (it locks state); admin only.
router.post('/schedules/:scheduleId/save',      requireRole('admin'), ctrl.saveSchedule);

// ── Export ────────────────────────────────────────────────────────────────────
router.get ('/schedules/:scheduleId/export', ctrl.exportSchedule);
router.post('/schedules/:scheduleId/import', requireRole('admin'), ctrl.upload.single('file'), ctrl.importSchedule);

// ── Terms (NEW-FU-161..163) ───────────────────────────────────────────────────
// GET open to any authenticated user; create/delete admin-only because they
// shape global term inventory.
router.get   ('/terms',                  ctrl.listTerms);
router.post  ('/terms',                  requireRole('admin'), ctrl.createTerm);
router.patch ('/terms/:code',            requireRole('admin'), ctrl.renameTerm);
router.patch ('/terms/:code/status',     requireRole('admin'), ctrl.setTermStatus);
// NEW-FU-193: archive / unarchive routes. PATCH (idempotent), admin-only.
// Archive requires activeCode so the server can refuse to archive the term
// the user is currently viewing — same guard pattern as delete/rename.
router.patch ('/terms/:code/archive',    requireRole('admin'), ctrl.archiveTerm);
router.patch ('/terms/:code/unarchive',  requireRole('admin'), ctrl.unarchiveTerm);
router.delete('/terms/:code',            requireRole('admin'), ctrl.deleteTerm);

module.exports = router;
