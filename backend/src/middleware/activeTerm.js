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
      `SELECT id, semester, archived_at
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

module.exports = { extractActiveTerm, refuseIfActiveTermArchived };
