import axios from 'axios';

// Resolve API base URL.
// - If VITE_API_URL starts with http(s), use it as-is.
// - If VITE_API_URL is a bare host (or host:port from a hosting platform),
//   normalize to https://<host>/api/v1.
// - Otherwise fall back to '/api/v1' so the Vite dev proxy keeps working.
function resolveApiBaseUrl() {
  const raw = import.meta.env.VITE_API_URL;
  if (!raw) return '/api/v1';
  if (/^https?:\/\//i.test(raw)) return raw;
  const hostOnly = raw.replace(/:(80|443)$/, '');
  return `https://${hostOnly}/api/v1`;
}

const API_BASE_URL = resolveApiBaseUrl();

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT on every request
api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  // NEW-FU-212: cooperative active-term enforcement (Phase 12).
  //   We read the active term from the URL ?term=XXX rather than React
  //   state because:
  //     • The api module is created once at module load; reaching into
  //       a live React store from here would require either an event
  //       bus or a Context, both heavier than parsing window.location.
  //     • The URL is the canonical "which term am I viewing" — FU-171
  //       made it the bookmarkable source of truth, and syncUrlTerm
  //       updates it synchronously on every term switch.
  //     • A request fired the instant the URL changes will see the new
  //       value because the URL is updated BEFORE the API call.
  //   Header is omitted entirely if no ?term param is present, keeping
  //   the contract backward-compatible.
  try {
    if (typeof window !== 'undefined' && window.location?.search) {
      const term = new URLSearchParams(window.location.search).get('term');
      if (term) cfg.headers['X-Active-Term'] = term;
    }
  } catch { /* SSR / odd environments — header just won't be set */ }
  return cfg;
});

// Redirect to login on 401 (except for the login endpoint itself — redirecting
// there would race with the SET_ERROR dispatch in doLogin).
api.interceptors.response.use(
  r => r,
  err => {
    // NEW-FU-507 (Phase 123): exact-path match instead of substring — a future
    // endpoint merely CONTAINING '/auth/login' in its path must not suppress
    // the session-expiry redirect. Anchored to end-of-path so only the real
    // login call (whose 401 means "wrong credentials", handled by doLogin)
    // is exempt.
    const reqUrl = String(err.config?.url ?? '');
    if (err.response?.status === 401 && !/\/auth\/login$/.test(reqUrl)) {
      // NEW-FU-51: clear the stale user object too. Previously only the
      // token was cleared on 401, so the LoginPage briefly flashed the
      // last-logged-in username from the persisted user blob via the
      // initial-state IIFE in AppContext.
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      // NEW-FU-43: redirect to '/' (the SPA root) instead of '/login'. The
      // app is router-less — App.jsx renders <LoginPage/> when !token. The
      // old '/login' target only resolved by accident via Render's
      // /* → /index.html SPA rewrite, leaving '/login' in the URL bar as a
      // dead bookmarkable path. '/' is the real address for the unauthed
      // state, so refresh/back/bookmark all behave correctly.
      window.location.href = '/';
    }
    return Promise.reject(err);
  }
);

// ── Auth ──────────────────────────────────────────────────────────────────────
export const login = (username, password) =>
  api.post('/auth/login', { username, password }).then(r => r.data);

// NEW-FU-13: hit the backend logout endpoint (added in M-3) so future
// denylist / audit-log work has a real call to hook into. The endpoint is
// a 204 today; we fire-and-forget so frontend logout is never blocked by
// the network.
// NEW-FU-18: log the failure cause (status / message) before swallowing so
// a misbehaving logout endpoint is still debuggable. Never re-throws — the
// caller (doLogout) must complete localStorage clearing regardless.
export const logout = () =>
  api.post('/auth/logout').then(() => undefined).catch(err => {
    console.error('logout failed:', err?.response?.status ?? err?.message ?? err);
    return undefined;
  });

// ── Reference data ────────────────────────────────────────────────────────────
// NEW-FU-274 (Phase 51 #5): optional `term` arg scopes the result to that
// term's schedule. Without it, the backend returns the global list.
// NEW-FU-415 (Phase 103 item 1): getCourses defaults `term` to the active URL
// term (so even a no-arg call is curriculum-filtered), and supports
// opts.scope='catalog' for the full program catalog (minus invalid-for-term
// courses) — the Suggest modal uses this to keep revealing Graduate courses.
function activeUrlTerm() {
  try { return new URLSearchParams(window.location.search).get('term') || null; } catch { return null; }
}
export const getCourses = (term, opts = {}) => {
  const t = term ?? activeUrlTerm();
  const params = {};
  if (t) params.term = t;
  if (opts.scope) params.scope = opts.scope;
  return api.get('/courses', { params }).then(r => r.data);
};
export const getInstructors = (term) => api.get('/instructors', { params: term ? { term } : {} }).then(r => r.data);
export const getVenues      = (term) => api.get('/venues',      { params: term ? { term } : {} }).then(r => r.data);

// ── Schedules ─────────────────────────────────────────────────────────────────
export const listSchedules  = (deptId) =>
  api.get(`/departments/${deptId}/schedules`).then(r => r.data);
export const createSchedule = (data) =>
  api.post('/schedules', data).then(r => r.data);

// ── Terms (NEW-FU-161..163) ───────────────────────────────────────────────────
// NEW-FU-193: includeArchived param toggles whether the response includes
// rows with archived_at IS NOT NULL. Defaults to false (hot-path query
// stays on the partial index `idx_schedules_active`).
export const listTerms   = (activeCode, includeArchived = false) =>
  api.get('/terms', {
    params: includeArchived
      ? { activeCode, includeArchived: 'true' }
      : { activeCode },
  }).then(r => r.data);
// NEW-FU-232: createTerm now accepts optional admin-supplied dates
// for codes without a published override. Pass undefined to keep
// the backend silent on the date columns (backend will store NULL).
export const createTerm = (code, { startsAt, endsAt } = {}) => {
  const body = (startsAt && endsAt) ? { code, startsAt, endsAt } : { code };
  return api.post('/terms', body).then(r => r.data);
};
export const deleteTerm  = (code, activeCode) =>
  api.delete(`/terms/${encodeURIComponent(code)}`, { params: { activeCode } }).then(r => r.data);
// NEW-FU-185
export const renameTerm  = (code, newCode, activeCode) =>
  api.patch(`/terms/${encodeURIComponent(code)}`, { newCode }, { params: { activeCode } }).then(r => r.data);
// NEW-FU-189
export const setTermStatus = (code, status) =>
  api.patch(`/terms/${encodeURIComponent(code)}/status`, { status }).then(r => r.data);
// NEW-FU-193: archive / unarchive. activeCode on archive is the same guard
// the server uses to refuse archiving the currently-viewed term.
export const archiveTerm   = (code, activeCode) =>
  api.patch(`/terms/${encodeURIComponent(code)}/archive`, {}, { params: { activeCode } }).then(r => r.data);
export const unarchiveTerm = (code) =>
  api.patch(`/terms/${encodeURIComponent(code)}/unarchive`, {}).then(r => r.data);

// ── Sections ──────────────────────────────────────────────────────────────────
export const getSections = (scheduleId, view, filterId) => {
  const params = { view };
  if (view === 'teacher') params.instructorId = filterId;
  if (view === 'venue')   params.venueId      = filterId;
  return api.get(`/schedules/${scheduleId}/sections`, { params }).then(r => r.data);
};

export const createSection = (scheduleId, data) =>
  api.post(`/schedules/${scheduleId}/sections`, data).then(r => r.data);

// NEW-FU-95 + NEW-FU-114: fetch the next unused two-digit section number
// for a course in a schedule, type-scoped. The Lec range is 01..49; the
// Lab range is 50..99. When sectionType is omitted the backend defaults
// to Lec (backward-compat).
export const getNextSectionNumber = (scheduleId, courseId, sectionType = 'Lec') =>
  api.get(`/schedules/${scheduleId}/courses/${courseId}/next-section-number`, {
    params: { sectionType },
  }).then(r => r.data);

export const updateSection = (sectionId, data) =>
  api.put(`/sections/${sectionId}`, data).then(r => r.data);

export const deleteSection = (id) =>
  api.delete(`/sections/${id}`).then(r => r.data);

// NEW-FU-272: per-row delete (one meeting day, leaves the rest of the
// section group intact). Used by the grid-block ✕ quick-delete. The
// backend's `?scope=row` short-circuit skips the findSiblings expansion
// that the default endpoint runs.
export const deleteSectionRow = (id) =>
  api.delete(`/sections/${id}?scope=row`).then(r => r.data);

// NEW-FU-280: extend a section group with additional meeting days.
// Drives the R-15 quick-fix flow (Phase 23). The user clicks a fix
// proposal under an expanded R-15 conflict; the proposal's `addDays`
// becomes the body of this call.
export const extendSection = (id, addDays) =>
  api.post(`/sections/${id}/extend`, { addDays }).then(r => r.data);

// NEW-FU-319 (Phase 29): Quick Fix resolver helpers. plan() returns
// a proposed sequence of remediations WITHOUT applying — the modal
// shows it for review. apply() runs the selected ops in one
// transaction.
export const quickFixPlan = (scheduleId) =>
  api.post(`/schedules/${scheduleId}/quick-fix`).then(r => r.data);
export const quickFixApply = (scheduleId, ops) =>
  api.post(`/schedules/${scheduleId}/quick-fix/apply`, { ops }).then(r => r.data);

// ── Conflicts & Save ──────────────────────────────────────────────────────────
export const getConflicts = (scheduleId) =>
  api.get(`/schedules/${scheduleId}/conflicts`).then(r => r.data);

// NEW-FU-78: optional `confirmSoftIds` argument scopes the dismiss to
// exactly the conflict ids the user saw in the modal. Falls back to the
// legacy boolean form when no ids are supplied.
export const saveSchedule = (scheduleId, confirmSoft = false, confirmSoftIds = null) => {
  const body = confirmSoftIds && Array.isArray(confirmSoftIds)
    ? { confirmSoftIds }
    : { confirmSoft };
  return api.post(`/schedules/${scheduleId}/save`, body).then(r => r.data);
};

// ── Export ────────────────────────────────────────────────────────────────────
// NEW-H4: getExportUrl was deleted. It returned a bare URL with no auth — any
// caller that did `<a href>` / `window.open()` would hit a 401, since the
// endpoint is behind authenticate. The replacement runs through axios so the
// JWT interceptor attaches the token and the response arrives as a Blob.
//
// NEW-FU-36: when the server returns an error response, axios with
// responseType:'blob' delivers the JSON error body as a Blob, not an object —
// so the caller's existing `err.response?.data?.error` lookup returns
// undefined and the toast falls back to a generic "Export failed.".
// We catch here, read the Blob as text, try to parse JSON, and rethrow with
// the parsed message stuffed where the caller already looks for it
// (err.message and err.response.data.error). No caller code changes needed.
export const downloadExport = async (scheduleId, view, filterId, format = 'xlsx') => {
  const params = { view: view || 'full', format };
  if (view === 'teacher' && filterId) params.instructorId = filterId;
  if (view === 'venue'   && filterId) params.venueId      = filterId;
  try {
    const res = await api.get(`/schedules/${scheduleId}/export`, {
      params,
      responseType: 'blob',
    });
    return res.data;
  } catch (err) {
    // Only repackage if the error response body is actually a Blob (i.e. we
    // asked for one). Non-Blob errors (network failure, axios cancellation)
    // bubble through unchanged so retries / timeouts behave normally.
    if (err?.response?.data instanceof Blob) {
      let message;
      try {
        const text = await err.response.data.text();
        const parsed = JSON.parse(text);
        message = parsed?.error || parsed?.message;
      } catch { /* body wasn't JSON — keep undefined */ }
      if (message) {
        // Stuff the parsed message into both spots the caller might check.
        err.response.data = { error: message };
        err.message = message;
      }
    }
    throw err;
  }
};

// ── Instructors ───────────────────────────────────────────────────────────────
export const createInstructor = (data) =>
  api.post('/instructors', data).then(r => r.data);
export const deleteInstructor = (id) =>
  api.delete(`/instructors/${id}`).then(r => r.data);

// ── Venues ────────────────────────────────────────────────────────────────────
export const createVenue = (data) =>
  api.post('/venues', data).then(r => r.data);
export const deleteVenue = (id) =>
  api.delete(`/venues/${id}`).then(r => r.data);

// ── Courses ───────────────────────────────────────────────────────────────────
export const createCourse = (data) =>
  api.post('/courses', data).then(r => r.data);
export const deleteCourse = (id) =>
  api.delete(`/courses/${id}`).then(r => r.data);

export default api;

// ── Office Hours ──────────────────────────────────────────────────────────────
export const getInstructorOfficeHours   = (instructorId) =>
  api.get(`/instructors/${instructorId}/office-hours`).then(r => r.data);
// NEW-FU-461 (Phase 109): suggested default office-hours for the Add-Instructor panel.
export const getSuggestedOfficeHour     = () =>
  api.get('/office-hours/suggested').then(r => r.data);
export const addInstructorOfficeHour    = (instructorId, data) =>
  api.post(`/instructors/${instructorId}/office-hours`, data).then(r => r.data);
// NEW-FU-41: atomic update — preferred over the legacy add+delete pattern
// which left duplicate OH rows in the DB when the delete failed.
export const updateInstructorOfficeHour = (instructorId, ohId, data) =>
  api.put(`/instructors/${instructorId}/office-hours/${ohId}`, data).then(r => r.data);
export const deleteInstructorOfficeHour = (instructorId, ohId) =>
  api.delete(`/instructors/${instructorId}/office-hours/${ohId}`).then(r => r.data);

// ── Suggest ──────────────────────────────────────────────────────────────────
// NEW-FU-262 + FU-316 (Phase 29) + FU-361 (Phase 35):
// suggestSchedule forwards applyToCourseIds, maxConflictsPerSection,
// and an OPTIONAL previewOnly flag. When previewOnly=true the
// backend runs the greedy without DB writes and returns
// { residualConflicts, residualConflictRuleIds, assignments } so
// the modal can warn the user before persisting.
export const suggestSchedule = (scheduleId, courseConfigs, applyToCourseIds, maxConflictsPerSection, options = {}) =>
  api.post(`/schedules/${scheduleId}/suggest`, {
    courseConfigs,
    ...(applyToCourseIds ? { applyToCourseIds } : {}),
    ...(maxConflictsPerSection != null ? { maxConflictsPerSection } : {}),
    ...(options.previewOnly      ? { previewOnly:      true } : {}),
    // NEW-FU-363 (Phase 35): when relaxIfConflicts is true the backend
    // runs preview, then if any residual conflicts exist tries up to 8
    // (duration, dayPattern) variants and returns the conflict-minimum
    // one. Response includes .relaxed (bool) + .relaxedConfigs (the
    // alternative configs used, or null when the original won).
    ...(options.relaxIfConflicts ? { relaxIfConflicts: true } : {}),
    // NEW-FU-425 (Phase 104 item 2): let the auto-fix invent term-local
    // placeholder instructors/venues to keep every section instead of dropping.
    ...(options.allowDummyResources ? { allowDummyResources: true } : {}),
  }).then(r => r.data);

// NEW-FU-264: read-only recommendation. The SuggestModal calls this on mount
// to pre-fill its per-course config grid + render capacity warnings. The
// endpoint runs the greedy in dry-run mode (no DB writes); see
// backend/src/services/SuggestService.js#recommend.
// NEW-FU-346 (Phase 33): optional `sectionsHint` lets the modal
// re-recommend with updated section counts (e.g., user bumped
// SWE301 from 1 → 3). Backend folds the hint into the per-course
// saturation contribution and re-picks the pattern accordingly.
// NEW-FU-381 (Phase 99 item 2 + 5): the live auto-choose passes the modal's
// current per-course `configs`, the user-`lockedCourseIds` to honour, and
// `fast` (skip the heavy greedy server-side). `signal` is an AbortSignal so a
// superseded live call is cancelled in-flight rather than piling up and
// exhausting the DB pool.
export const suggestRecommend = (scheduleId, opts = {}) => {
  const { sectionsHint, configs, lockedCourseIds, fast, signal } = opts;
  const params = {};
  if (sectionsHint && Object.keys(sectionsHint).length > 0) params.sectionsHint = JSON.stringify(sectionsHint);
  if (Array.isArray(configs) && configs.length)             params.configs = JSON.stringify(configs);
  if (Array.isArray(lockedCourseIds) && lockedCourseIds.length) params.lockedCourseIds = JSON.stringify(lockedCourseIds);
  if (fast) params.fast = '1';
  return api.get(`/schedules/${scheduleId}/suggest-recommend`, { params, signal }).then(r => r.data);
};

// ── Import ────────────────────────────────────────────────────────────────────
// `format` is optional — when omitted, backend infers from the file extension
// (.xlsx → xlsx, .docx → docx, .pdf → pdf). Pass it explicitly when you want
// to force a specific parser.
export const importSchedule = (scheduleId, file, format) => {
  const form = new FormData();
  form.append('file', file);
  const url = format
    ? `/schedules/${scheduleId}/import?format=${encodeURIComponent(format)}`
    : `/schedules/${scheduleId}/import`;
  return api.post(url, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data);
};
