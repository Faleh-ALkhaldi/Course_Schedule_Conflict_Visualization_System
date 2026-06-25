// NEW-FU-210: cooperative active-term enforcement.
//
// The frontend asserts the term it's currently viewing via the
// `X-Active-Term` request header (axios interceptor — FU-212). This
// module turns that assertion into a server-side guarantee for routes
// that mutate GLOBAL resources (courses, instructors, venues,
// office-hours) — resources that have no per-schedule foreign key but
// shouldn't be edited "from" an archived-term context, because the UI
// has already told the user that view is read-only.
//
// Design notes:
//   • Header missing  → req.activeTerm is null; mutations proceed
//     unchanged. This preserves backward compatibility for curl, scripts,
//     and any pre-FU-212 client.
//   • Header malformed → silently ignored (no 400). We don't want a
//     header validation error to surface on every legitimate request
//     just because someone mistyped a query string elsewhere.
//   • Header references a nonexistent code → req.activeTerm is null
//     (the lookup just returns no rows). Resilient: a stale URL
//     `?term=xyz` shouldn't lock the user out of every mutation.
//   • Header references an archived code → req.activeTerm carries
//     archivedAt; refuseIfActiveTermArchived turns that into a 409.
//
// One DB lookup per request when the header is present. Cheap enough
// that we apply extractActiveTerm globally in app.js; the actual
// rejection middleware is opt-in per-route.

const { query } = require('../config/db');

const DEFAULT_DEPT = 'SWE-DEPT';
// Match the YYT format used by decodeTerm (T ∈ {1,2,3}).
const TERM_CODE_RE = /^\d{2}[123]$/;

async function extractActiveTerm(req, _res, next) {
  // Header names are case-insensitive in Node's http parser.
  const raw = req.get('X-Active-Term');
  if (!raw || !TERM_CODE_RE.test(raw)) {
    req.activeTerm = null;
    return next();
  }
  try {
    const r = await query(
      `SELECT id, semester, archived_at, status
         FROM schedules
        WHERE department_id = $1 AND semester = $2`,
      [DEFAULT_DEPT, raw]
    );
    if (r.rowCount === 0) {
      req.activeTerm = null;
    } else {
      req.activeTerm = {
        code:        r.rows[0].semester,
        scheduleId:  r.rows[0].id,
        archivedAt:  r.rows[0].archived_at, // Date or null
        status:      r.rows[0].status,      // 'Draft' | 'PendingApproval' | 'Finalized' (NEW-FU-632)
      };
    }
  } catch {
    // DB hiccup shouldn't 500 every request — fall back to no-context.
    // The downstream route either doesn't care or has its own DB call
    // that will surface the real failure with a better error message.
    req.activeTerm = null;
  }
  next();
}

// Reject mutations on global resources when the frontend has asserted
// (via header) that its viewport is on an archived term. The UI already
// disables the affordance (Phase 11); this is the API-level twin of
// that contract — so a power-user who circumvents the disabled button
// via dev tools still gets a clean 409 rather than silently writing
// a global record they didn't intend.
function refuseIfActiveTermArchived(req, res, next) {
  if (req.activeTerm && req.activeTerm.archivedAt) {
    return res.status(409).json({
      error: `Cannot modify global resources while viewing archived term ${req.activeTerm.code}. Switch to an active term first.`,
    });
  }
  next();
}

// NEW-FU-632 (issue #2): the API-level twin of the read-only contract for office hours.
// A FINALIZED term is read-only in the UI (banner + Locked button), and an ARCHIVED term
// likewise — yet office hours are GLOBAL (no per-schedule FK), so unlike section edits they
// can't be gated by the schedule row-lock (assertSchedulerEditableLocked). The only existing
// gate, refuseIfActiveTermArchived, blocked archived but NOT finalized, so OH add/edit/delete
// went through while viewing a finalized term. Block BOTH here. (Frontend disables the
// affordance too; this is the backstop for a dev-tools power user.) Status is the schedule's
// own status — a draft term active elsewhere is unaffected.
function refuseIfActiveTermArchivedOrFinalized(req, res, next) {
  const t = req.activeTerm;
  if (t && t.archivedAt) {
    return res.status(409).json({
      error: `Cannot modify office hours while viewing archived term ${t.code}. Switch to an active term first.`,
    });
  }
  if (t && t.status === 'Finalized') {
    return res.status(409).json({
      error: `Cannot modify office hours while term ${t.code} is finalized. Unlock the term first.`,
    });
  }
  next();
}

module.exports = { extractActiveTerm, refuseIfActiveTermArchived, refuseIfActiveTermArchivedOrFinalized };
