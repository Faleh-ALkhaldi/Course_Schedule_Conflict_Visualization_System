import React, { createContext, useContext, useReducer, useCallback } from 'react';
import * as api from '../api/index.js';

export const VIEWS = { COURSE: 'course', TEACHER: 'teacher', VENUE: 'venue' };

// NEW-FU-474 (Phase 114): order venues by building number, then room number,
// numerically — so a NEWLY-ADDED venue sorts into place instead of being appended
// at the bottom of the list. Matches the backend's load-time ORDER BY. Handles the
// XX-YYY, XX-YYY-Z and XX-YYYY name formats (leading digits = building, digits after
// the first dash = room); unparseable names sort last by string.
export function venueOrder(a, b) {
  const parse = v => {
    const m = String((v && v.name) || v || '').match(/^(\d+)(?:-(\d+))?/);
    return [m && m[1] ? +m[1] : Infinity, m && m[2] ? +m[2] : Infinity];
  };
  const [ab, ar] = parse(a), [bb, br] = parse(b);
  return ab - bb || ar - br ||
    String((a && a.name) || '').localeCompare(String((b && b.name) || ''), undefined, { numeric: true });
}
export const DAYS  = ['Sunday','Monday','Tuesday','Wednesday','Thursday'];

// Sun/Tue/Thu = 50 min, Mon/Wed = 75 min
export const DAY_DURATION = {
  Sunday: 50, Monday: 75, Tuesday: 50, Wednesday: 75, Thursday: 50,
};

export const SLOT_STEP  = 5;
const SLOT_START = 7 * 60;
const SLOT_END   = 22 * 60;

// Frontend mirror of backend constants.TIME_WINDOWS (the client can't import the
// server config). This is the ONE place the R-06 teaching windows live on the
// frontend — the drag-drop guard (SchedulerPage) and SectionModal both read it.
// Keep in sync with backend/src/config/constants.js if the windows ever change.
//   UG (and capstone): 07:00–17:10   |   GR: 17:20–22:00
export const TIME_WINDOWS = {
  UG: { start: 7 * 60,       end: 17 * 60 + 10 },
  GR: { start: 17 * 60 + 20, end: 22 * 60 },
};

export function fromMinutes(m) {
  // NEW-FU-453 (Phase 108): clamp to a valid minute-of-day (0–1439) so a bad or
  // overflowed input can NEVER render as scientific notation / a >24h garbage
  // time ("510:30", "1.66e+26:32") anywhere in the app. Validation upstream
  // blocks such values from being saved; this is the last-line display guard.
  const v = Number.isFinite(m) ? Math.max(0, Math.min(Math.trunc(m), 24 * 60 - 1)) : 0;
  return `${String(Math.floor(v/60)).padStart(2,'0')}:${String(v%60).padStart(2,'0')}`;
}
export function toMinutes(t) {
  if (!t) return 0;
  const [h,mn] = t.substring(0,5).split(':').map(Number);
  return (h||0)*60+(mn||0);
}
export function generateSlots() {
  const slots = [];
  for (let m = SLOT_START; m < SLOT_END; m += SLOT_STEP) slots.push(fromMinutes(m));
  return slots;
}
export function isLabelSlot(slot) {
  return slot.endsWith(':00') || slot.endsWith(':30');
}

// NEW-FU-282 (Phase 56): canonical display label for a section.
//   Male / unset gender → "§01", "§02"…
//   Female gender ('F')  → "§F-01", "§F-02"…   (hyphen is mandatory)
//
// Why a single helper: prior to Phase 56 the codebase rendered female
// sections inconsistently — some places dropped the `§` prefix, some
// used `F01` with no hyphen, the SectionModal preview used `F${num}`
// while SidePanel just used `§{num}` with no gender awareness at all.
// One function used everywhere keeps the registrar-style `§F-XX`
// notation uniform across the sidebar, grid blocks, conflict messages
// and exports.
//
// `withSection` toggles the leading `§`. The few places that already
// embed the symbol in surrounding chrome (e.g., the SidePanel's
// `<span className="sp-sec-code">§{...}</span>`) pass `false` so the
// helper only contributes the gender+number portion.
//
// Accepts either camelCase (`sectionNumber`) or snake_case
// (`section_number`) — the API used to return snake_case before the
// repository layer normalized things, and some legacy paths still
// pass raw rows through.
export function sectionLabel(section, { withSection = true } = {}) {
  const raw    = (section?.sectionNumber ?? section?.section_number ?? '').toString();
  // NEW-FU-526 (Batch 8 Issue 1): section numbers are a two-digit format — always
  // DISPLAY them zero-padded (1 → 01, 3 → 03), even in the live modal preview where
  // the user has typed a single digit before save. Pad only pure-digit values so the
  // "__" placeholder and any non-numeric label pass through untouched. Stored values
  // are already padded, so this is a no-op for them.
  const num    = /^\d+$/.test(raw) ? raw.padStart(2, '0') : raw;
  const gender = section?.gender ?? 'M';
  const prefix = withSection ? '§' : '';
  return gender === 'F' ? `${prefix}F-${num}` : `${prefix}${num}`;
}

// Level colors are now CSS variables (defined in index.css :root + the dark block)
// so cards flip with the theme. Light values are unchanged from before; the
// FU-156 Junior-contrast tuning now lives on --lvl-ju-* in index.css.
export const LEVEL_COLORS = {
  Freshman:  { bg:'var(--lvl-fr-bg)', border:'var(--lvl-fr-bd)', text:'var(--lvl-fr-tx)' },
  Sophomore: { bg:'var(--lvl-so-bg)', border:'var(--lvl-so-bd)', text:'var(--lvl-so-tx)' },
  Junior:    { bg:'var(--lvl-ju-bg)', border:'var(--lvl-ju-bd)', text:'var(--lvl-ju-tx)' },
  Senior:    { bg:'var(--lvl-se-bg)', border:'var(--lvl-se-bd)', text:'var(--lvl-se-tx)' },
  Graduate:  { bg:'var(--lvl-gr-bg)', border:'var(--lvl-gr-bd)', text:'var(--lvl-gr-tx)' },
};
export const SOFT_CONFLICT_BG = 'var(--conflict-soft-bg)';
export const HARD_CONFLICT_BG = 'var(--conflict-hard-bg)';
export const PX_PER_MIN = 2.2;

const initialState = {
  user:null, token:localStorage.getItem('token')||null,
  schedule:null, sections:[], officeHours:[], conflicts:[],
  courses:[], instructors:[], venues:[],
  view:VIEWS.COURSE, filterId:null,
  loading:false, saveBlocked:false, softPending:[], error:null,
};

function reducer(state, action) {
  switch(action.type) {
    case 'SET_AUTH':       return { ...state, user:action.user, token:action.token };
    case 'LOGOUT':         return { ...initialState, token:null };
    // NEW-FU-84: short-circuit when the dispatch would be a no-op so
    // React doesn't trigger an unnecessary re-render. Rapid back-to-back
    // loadView calls (10 view-tab clicks, StrictMode double-invoke, etc.)
    // used to dispatch SET_LOADING:true 10× even though only the first
    // mattered — the reducer always returned a new object reference, so
    // every dispatch caused a render. Returning `state` unchanged when the
    // values already match keeps the error-reset semantics for actual
    // transitions while collapsing the wasted no-ops.
    case 'SET_LOADING':
      if (state.loading === action.value && state.error === null) return state;
      return { ...state, loading:action.value, error:null };
    case 'SET_ERROR':      return { ...state, error:action.error, loading:false };
    case 'SET_REFERENCE':  return { ...state,
      courses:     action.courses     ?? state.courses,
      instructors: action.instructors ?? state.instructors,
      venues:      action.venues ? [...action.venues].sort(venueOrder) : state.venues,
    };
    case 'SET_SCHEDULE':   return { ...state, schedule:action.schedule };
    case 'SET_VIEW_DATA':  return { ...state, sections:action.sections, officeHours:action.officeHours??[], loading:false };
    case 'SET_CONFLICTS':  return { ...state,
      conflicts:   action.conflicts,
      saveBlocked: action.conflicts.some(c => c.severity === 'Hard' && !c.confirmed),
      softPending: action.conflicts.filter(c => c.severity === 'Soft' && !c.confirmed),
    };
    case 'SET_VIEW':       return { ...state, view:action.view, filterId:action.filterId??null, sections:[], officeHours:[], conflicts:[] };
    case 'UPSERT_SECTION': {
      // section may be null when backend returns group update (reload handles it)
      if (!action.section) return state;
      const idx = state.sections.findIndex(s=>s.id===action.section.id);
      return { ...state, sections: idx>=0
        ? state.sections.map((s,i)=>i===idx?action.section:s)
        : [...state.sections, action.section] };
    }
    case 'REMOVE_SECTION':     return { ...state, sections:    state.sections.filter(s=>s.id!==action.id) };
    // C-6: Clears only sections (to trigger reload) without wiping officeHours.
    // SET_VIEW_DATA(sections:[]) was incorrectly used for this and blanked Teacher View.
    case 'CLEAR_SECTIONS':     return { ...state, sections: [], loading: false };
    case 'ADD_INSTRUCTOR':     return { ...state, instructors: [...state.instructors, action.instructor] };
    case 'REMOVE_INSTRUCTOR':  return { ...state, instructors: state.instructors.filter(i=>i.id!==action.id) };
    case 'ADD_VENUE':          return { ...state, venues:      [...state.venues, action.venue].sort(venueOrder) };
    case 'REMOVE_VENUE':       return { ...state, venues:      state.venues.filter(v=>v.id!==action.id) };
    case 'ADD_COURSE':         return { ...state, courses:     [...state.courses, action.course] };
    case 'REMOVE_COURSE':      return { ...state, courses:     state.courses.filter(c=>c.id!==action.id) };
    default: return state;
  }
}

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    user: (() => { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } })(),
  });

  const doLogin = useCallback(async (username, password) => {
    dispatch({ type:'SET_LOADING', value:true });
    try {
      const { token, user } = await api.login(username, password);
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      dispatch({ type:'SET_AUTH', user, token });
    } catch(err) {
      dispatch({ type:'SET_ERROR', error:err.response?.data?.error||'Login failed' });
      throw err;
    }
  }, []);

  const doLogout = useCallback(() => {
    // NEW-FU-13: notify the backend so a future denylist / audit log gets the
    // event. Fire-and-forget: localStorage clearing and reducer LOGOUT happen
    // regardless of whether the network call succeeds.
    api.logout();
    localStorage.removeItem('token'); localStorage.removeItem('user');
    dispatch({ type:'LOGOUT' });
  }, []);

  // NEW-FU-471 (Phase 113): stale-response guard, mirroring loadView's loadViewSeq.
  // Without it, a fast term-switch (A→B→A) lets whichever reference fetch resolves
  // LAST win — so the sidebar (courses / instructors / venues) could show term A
  // while the grid shows term B. Same ++seq / drop-if-superseded pattern as loadView.
  const loadReferenceSeq = React.useRef(0);
  const loadReference = useCallback(async (termCode = null) => {
    const mySeq = ++loadReferenceSeq.current;
    // NEW-FU-12: use allSettled so a single endpoint failing (e.g. /venues
    // returns 500) doesn't blank out the other two reference lists. Each
    // failed fetch keeps its previous value via the reducer's `?? state.*`
    // fallback.
    //
    // NEW-FU-274 (Phase 51 #5): when `termCode` is provided, scope the
    // three reference lists to that term's schedule. The caller (boot
    // + handleSwitchTerm in SchedulerPage) passes the current term so
    // the sidebar reflects only entities offered in that term.
    const results = await Promise.allSettled([
      api.getCourses(termCode), api.getInstructors(termCode), api.getVenues(termCode),
    ]);
    const [courses, instructors, venues] = results.map(r => r.status === 'fulfilled' ? r.value : undefined);
    // NEW-FU-471 (Phase 113): a newer term-switch superseded this fetch — drop it
    // so we never paint a stale term's reference lists over the current term.
    if (mySeq !== loadReferenceSeq.current) return;
    // NEW-FU-32: surface partial failures via the existing FU-31 toast
    // pipeline. Before this dispatch, the only signal of a transient backend
    // hiccup was a dev-only console.error — the user saw a sidebar missing
    // (say) all instructors with no indication of what went wrong.
    // SET_ERROR triggers SchedulerPage's [error] useEffect → showToast.
    const failedNames = results
      .map((r, i) => r.status === 'rejected' ? ['courses', 'instructors', 'venues'][i] : null)
      .filter(Boolean);
    if (failedNames.length > 0) {
      console.error('loadReference: partial failure',
        results.filter(r => r.status === 'rejected').map(r => r.reason));
      dispatch({
        type: 'SET_ERROR',
        error: `Failed to load ${failedNames.join(', ')}. Some data may be missing.`,
      });
    }
    dispatch({ type:'SET_REFERENCE', courses, instructors, venues });
  }, []);

  // NEW-M15: track the latest in-flight loadView so a fast view-switch cancels
  // the stale response instead of letting it overwrite the new view's data.
  const loadViewSeq = React.useRef(0);
  const loadView = useCallback(async (scheduleId, view, filterId) => {
    const mySeq = ++loadViewSeq.current;
    dispatch({ type:'SET_LOADING', value:true });
    // NEW-FU-527 (Batch 8 Issue 4): Venue/Instructor view needs a selected resource.
    // Without one (booting into a persisted Venue View, or before a venue is picked)
    // the sections fetch would 400 with a raw internal "venueId is required for
    // view=venue" message that leaked to the user as an error toast. Show the empty
    // "select a venue/instructor" state instead — but still refresh the conflicts
    // panel (it needs no resource id), so the sidebar stays accurate.
    if ((view === VIEWS.VENUE || view === VIEWS.TEACHER) && !filterId) {
      dispatch({ type:'SET_VIEW_DATA', sections: [], officeHours: [] });
      try {
        const c = await api.getConflicts(scheduleId);
        if (mySeq === loadViewSeq.current) dispatch({ type:'SET_CONFLICTS', conflicts: c.conflicts ?? [] });
      } catch { /* conflicts are advisory here — ignore a transient failure */ }
      if (mySeq === loadViewSeq.current) dispatch({ type:'SET_LOADING', value:false });
      return;
    }
    // NEW-FU-71: Promise.allSettled instead of Promise.all so a transient
    // failure of one half (e.g., /conflicts returns 5xx during a brief DB
    // hiccup) doesn't discard the other half's successful response. Same
    // pattern NEW-FU-12 applies to loadReference. Each settled half
    // dispatches independently; SET_ERROR fires only if both failed (or
    // if the still-applicable half failed and there's nothing useful to
    // partially render).
    // NEW-FU-458 (Phase 108): retry the sections fetch once on a transient failure.
    // SET_VIEW clears sections on a view-switch; if the follow-up fetch then errors
    // (a brief 5xx/DB hiccup) the grid would sit blank. One retry keeps a momentary
    // failure from rendering the term as empty — "never blank a term on an error".
    const getSectionsResilient = async () => {
      try { return await api.getSections(scheduleId, view, filterId); }
      catch { return await api.getSections(scheduleId, view, filterId); }
    };
    const results = await Promise.allSettled([
      getSectionsResilient(),
      api.getConflicts(scheduleId),
    ]);
    // Stale-response guard (same as before — newer loadView wins).
    if (mySeq !== loadViewSeq.current) return;
    const sectionsResult  = results[0];
    const conflictsResult = results[1];

    if (sectionsResult.status === 'fulfilled') {
      const data = sectionsResult.value;
      dispatch({ type:'SET_VIEW_DATA', sections:data.sections??data, officeHours:data.officeHours??[] });
    }
    if (conflictsResult.status === 'fulfilled') {
      dispatch({ type:'SET_CONFLICTS', conflicts:conflictsResult.value.conflicts??[] });
    }

    // Surface an error only if at least one half failed. Prefer the
    // sections failure message because that's the more visible UI surface.
    if (sectionsResult.status === 'rejected' || conflictsResult.status === 'rejected') {
      const err = sectionsResult.status === 'rejected'
        ? sectionsResult.reason
        : conflictsResult.reason;
      console.error('loadView partial failure:', sectionsResult.reason, conflictsResult.reason);
      dispatch({
        type: 'SET_ERROR',
        error: err?.response?.data?.error || 'Failed to load schedule data.',
      });
    }
  }, []);

  // Shared "reload the current view after a resource change" guard, used by
  // addInstructor / removeInstructor / addVenue / removeVenue / removeCourse below.
  // Skips the reload only for an unfiltered Teacher/Venue view (nothing selected).
  const reloadCurrentView = useCallback(() => {
    if (state.schedule && !((state.view === VIEWS.VENUE || state.view === VIEWS.TEACHER) && !state.filterId)) {
      loadView(state.schedule.id, state.view, state.filterId);
    }
  }, [state.schedule, state.view, state.filterId, loadView]);

  const moveSection = useCallback(async (sectionId, updates) => {
    const { section, conflicts:result } = await api.updateSection(sectionId, updates);
    // section may be null for group updates — reload whole view to get all siblings
    if (section) {
      dispatch({ type:'UPSERT_SECTION', section });
    }
    dispatch({ type:'SET_CONFLICTS', conflicts:result.conflicts??[] });
    return result;
  }, []);

  const addSection = useCallback(async (scheduleId, data) => {
    const { section, conflicts:result } = await api.createSection(scheduleId, data);
    if (section) {
      dispatch({ type:'UPSERT_SECTION', section });
    }
    dispatch({ type:'SET_CONFLICTS', conflicts:result.conflicts??[] });
    return { section, conflictResult:result };
  }, []);

  const removeSection = useCallback(async (sectionId) => {
    try {
      // NEW-FU-288 (Phase 24): backend now returns the list of deleted IDs
      // (the section group's rows). Removing only those keeps every other
      // section visible during the delete — the prior CLEAR_SECTIONS hack
      // wiped ALL sections from local state and waited for the SchedulerPage
      // reload to repopulate, blanking the entire schedule for ~100-200ms
      // (or indefinitely if the reload effect didn't fire). The user
      // experienced this as "the X button removes the whole schedule" —
      // critical bug fix.
      const result = await api.deleteSection(sectionId);
      const deletedIds = Array.isArray(result?.deletedIds) ? result.deletedIds : [sectionId];
      for (const id of deletedIds) {
        dispatch({ type:'REMOVE_SECTION', id });
      }
    } catch(err) {
      console.error('Delete section failed:', err.response?.data?.error ?? err.message);
      throw err;
    }
  }, []);

  const addInstructor = useCallback(async (data) => {
    // NEW-FU-434 (Phase 106 item 6): thread the active term so the backend can
    // auto-replace the oldest placeholder instructor in it. If it did, drop the
    // placeholder from the list and reload sections (now on the new instructor).
    const { replacedDummy, ...instructor } = await api.createInstructor({ ...data, ownerSemester: state.schedule?.semester });
    dispatch({ type:'ADD_INSTRUCTOR', instructor });
    if (replacedDummy) {
      dispatch({ type:'REMOVE_INSTRUCTOR', id: replacedDummy.id });
      // NEW-FU-437 (Phase 107 H3): the backend reassigned the placeholder's
      // sections to the new real instructor — RELOAD the view so the grid shows
      // it. (The old CLEAR_SECTIONS just blanked the grid: the sections-length
      // reload effect it relied on was removed in FU-55.)
      reloadCurrentView();
    }
    return { ...instructor, replacedDummy };
  }, [state.schedule, state.view, state.filterId, loadView, reloadCurrentView]);

  const removeInstructor = useCallback(async (id) => {
    await api.deleteInstructor(id);
    dispatch({ type:'REMOVE_INSTRUCTOR', id });
    // NEW-FU-437 (Phase 107 H3): RELOAD the view (sections.instructor_id is now
    // NULL on affected rows). The old CLEAR_SECTIONS relied on a SchedulerPage
    // reload effect that FU-55 removed, so the grid blanked with no re-fetch.
    reloadCurrentView();
  }, [state.schedule, state.view, state.filterId, loadView, reloadCurrentView]);

  const addVenue = useCallback(async (data) => {
    // NEW-FU-434 (Phase 106 item 6): auto-replace the oldest placeholder venue of
    // the SAME type in the active term, then drop it + reload sections.
    const { replacedDummy, ...venue } = await api.createVenue({ ...data, ownerSemester: state.schedule?.semester });
    dispatch({ type:'ADD_VENUE', venue });
    if (replacedDummy) {
      dispatch({ type:'REMOVE_VENUE', id: replacedDummy.id });
      // NEW-FU-437 (Phase 107 H3): reload so the grid shows the real venue on the
      // placeholder's reassigned sections (CLEAR_SECTIONS only blanked it).
      reloadCurrentView();
    }
    return { ...venue, replacedDummy };
  }, [state.schedule, state.view, state.filterId, loadView, reloadCurrentView]);

  const removeVenue = useCallback(async (id) => {
    await api.deleteVenue(id);
    dispatch({ type:'REMOVE_VENUE', id });
    // NEW-FU-437 (Phase 107 H3): reload so the deleted venue's name disappears
    // from the grid (sections.venue_id is NULL via cascade).
    reloadCurrentView();
  }, [state.schedule, state.view, state.filterId, loadView, reloadCurrentView]);

  const addCourse = useCallback(async (data) => {
    const course = await api.createCourse(data);
    dispatch({ type:'ADD_COURSE', course });
    return course;
  }, []);

  const removeCourse = useCallback(async (id) => {
    try {
      await api.deleteCourse(id);
      dispatch({ type:'REMOVE_COURSE', id });
      // NEW-FU-437 (Phase 107 H3): reload so the deleted course's sections leave
      // the grid (CLEAR_SECTIONS alone blanked it — FU-55 removed the reload effect).
      reloadCurrentView();
    } catch(err) {
      console.error('Delete course failed:', err.response?.data?.error ?? err.message);
      throw err;
    }
  }, [state.schedule, state.view, state.filterId, loadView, reloadCurrentView]);

  // NEW-FU-78: accept either a boolean (legacy "confirm all softs") or an
  // array of explicit conflict ids the user saw and acknowledged. The
  // backend rejects the save with `newSoftConflicts` populated if any
  // unseen soft conflict appeared between modal-open and confirm-click.
  const saveSchedule = useCallback(async (confirmSoft=false) => {
    if (!state.schedule) return;
    try {
      const isIdList = Array.isArray(confirmSoft);
      const result = await api.saveSchedule(
        state.schedule.id,
        isIdList ? false : confirmSoft,
        isIdList ? confirmSoft : null
      );
      dispatch({ type:'SET_CONFLICTS', conflicts:result.conflictResult?.conflicts??[] });
      // NEW-FU-42: when the backend reports saved:true it also returns the
      // refreshed schedule row (status=Finalized). Sync state.schedule so
      // the Save button stops re-arming and a follow-up edit can show the
      // 409 finalize message in context rather than as a mysterious failure.
      if (result.saved && result.schedule) {
        dispatch({ type:'SET_SCHEDULE', schedule: result.schedule });
      }
      return result;
    } catch(err) {
      const r = err.response?.data;
      if (r?.conflictResult) dispatch({ type:'SET_CONFLICTS', conflicts:r.conflictResult.conflicts??[] });
      throw err;
    }
  }, [state.schedule]);

  // NEW-FU-465 (Phase 110): un-finalize / unlock — the reverse of Save. Returns the
  // term to Draft so it can be edited again. Always allowed (no hard-conflict guard);
  // lets the top button toggle Save (finalize) ↔ Unlock (un-finalize).
  const unfinalizeSchedule = useCallback(async () => {
    if (!state.schedule) return;
    await api.setTermStatus(state.schedule.semester, 'Draft');
    dispatch({ type:'SET_SCHEDULE', schedule: { ...state.schedule, status: 'Draft' } });
  }, [state.schedule]);

  const switchView = useCallback((view, filterId=null) => {
    dispatch({ type:'SET_VIEW', view, filterId });
  }, []);

  return (
    <AppContext.Provider value={{
      ...state,
      doLogin, doLogout, loadReference, loadView,
      moveSection, addSection, removeSection,
      addInstructor, removeInstructor,
      addVenue, removeVenue,
      addCourse, removeCourse,
      saveSchedule, unfinalizeSchedule, switchView, dispatch,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => useContext(AppContext);
