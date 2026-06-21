import React, { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  DndContext, PointerSensor, useSensor, useSensors, DragOverlay, closestCenter,
} from '@dnd-kit/core';
import { useApp, VIEWS, DAY_DURATION, LEVEL_COLORS, fromMinutes, TIME_WINDOWS } from '../context/AppContext.jsx';

const DAY_GROUPS = {
  Sunday:'STT', Tuesday:'STT', Thursday:'STT',
  Monday:'MW',  Wednesday:'MW',
};
const GROUP_DAYS = { STT:['Sunday','Tuesday','Thursday'], MW:['Monday','Wednesday'] };
const GROUP_LABELS = { STT:'Sun / Tue / Thu (3 days, 50 min)', MW:'Mon / Wed (2 days, 75 min)', single:'Single day' };

// NEW-FU-610 (Batch 30 item 3): credit-aware day-pattern re-derivation for a cross-day-group
// drag. A move to a day outside the section's pattern must restructure the WHOLE section to the
// legal pattern (for the course's credits/flags) that contains the target day, AND set the
// duration that pattern requires — e.g. a 3-credit Sun/Tue/Thu @ 50 dragged to Monday becomes
// Mon/Wed @ 75. legalDayTemplatesFE MIRRORS backend sectionPattern.legalDayTemplatesForCourse
// (and SectionModal's copy) — keep all three in lock-step.
const PATTERN_DAYS = {
  STT: ['Sunday','Tuesday','Thursday'], MW: ['Monday','Wednesday'],
  ST:  ['Sunday','Tuesday'],            TT: ['Tuesday','Thursday'],
};
function legalDayTemplatesFE({ credits, hasLab, duration }) {
  const c = Number(credits), d = Number(duration);
  if (d === 75) return (c === 3 || c === 4) ? ['MW','ST','TT'] : [];
  if (c === 0 || c === 1) return ['single'];
  if (c === 2) return ['ST','MW','TT'];
  if (c === 3) return hasLab ? ['ST','MW','TT'] : ['STT'];
  if (c === 4) return ['STT'];
  return [];
}
// Pick the legal { pattern, days, duration } for `credits` whose day-set CONTAINS targetDay.
// Prefers the section's CURRENT duration when still legal; else the pattern's required one.
// Candidates per day are ordered 3-day → 2-day so a 3-/4-credit course keeps its 3-day shape
// where legal, and falls to a single-day for 0/1-credit.
function targetPatternForDrag(targetDay, credits, hasLab, currentDuration) {
  const candidates = {
    Sunday: ['STT','ST'], Monday: ['MW'], Tuesday: ['STT','ST','TT'],
    Wednesday: ['MW'],    Thursday: ['STT','TT'],
  }[targetDay] || [];
  const durs = [Number(currentDuration), 50, 75].filter((v, i, a) => Number.isFinite(v) && a.indexOf(v) === i);
  for (const pat of candidates) {
    for (const dur of durs) {
      if (legalDayTemplatesFE({ credits, hasLab, duration: dur }).includes(pat)) {
        return { pattern: pat, days: PATTERN_DAYS[pat], duration: dur };
      }
    }
  }
  return { pattern: 'single', days: [targetDay], duration: 50 };  // 0/1-credit (or no legal multi-day)
}
import * as api from '../api/index.js';
import TopBar            from '../components/shared/TopBar.jsx';
import SidePanel         from '../components/panels/SidePanel.jsx';
import ScheduleGrid      from '../components/grid/ScheduleGrid.jsx';
import SoftConflictModal from '../components/modals/SoftConflictModal.jsx';
import SectionModal      from '../components/modals/SectionModal.jsx';
import OfficeHourModal  from '../components/modals/OfficeHourModal.jsx';
import ExportModal      from '../components/modals/ExportModal.jsx';
import GroupChangeModal from '../components/modals/GroupChangeModal.jsx';
import SuggestModal     from '../components/modals/SuggestModal.jsx';
import DecisionModal    from '../components/modals/DecisionModal.jsx';
import QuickFixModal    from '../components/modals/QuickFixModal.jsx';
import { conflictTypesPlain } from '../utils/conflictText.js';
// NEW-FU-503 (Phase 123): shared SVG icons replace emoji glyphs in the chrome.
import Ico from '../components/shared/Icons.jsx';
import './SchedulerPage.css';

const DEPT_ID  = import.meta.env.VITE_DEPT_ID  || 'SWE-DEPT';
// NEW-FU-176: default semester is the canonical FU-159 term code (251 =
// Fall 2025). Migration 011 converted legacy 'Fall-2025' DBs in place;
// the SEMESTER_DISPLAY map in TopBar.jsx still recognises 'Fall-2025'
// as a defensive fallback for any DB that wasn't migrated.
const SEMESTER = import.meta.env.VITE_SEMESTER || '251';

// NEW-FU-182: lightweight term-code → human-label decoder for the export
// filename. Mirrors the YYT rules in backend/src/domain/term.js but stays
// inline so SchedulerPage.jsx doesn't pull in an extra module. Returns
// "Fall-2025" for "251", "Spring-2026" for "252", "Summer-2026" for "253",
// etc. Falls through to the raw input when it doesn't match (legacy
// labels like "Fall-2025" already pass through cleanly).
function decodeTermLabel(code) {
  if (typeof code !== 'string' || !/^\d{2}[123]$/.test(code)) return code || 'schedule';
  const yy = parseInt(code.slice(0, 2), 10);
  const t  = code[2];
  const start = 2000 + yy;
  if (t === '1') return `Fall-${start}`;
  if (t === '2') return `Spring-${start + 1}`;
  return `Summer-${start + 1}`;
}

// NEW-FU-171: helper to mirror the active term into the URL's ?term=
// query param without forcing a navigation. Uses history.replaceState so
// the back button doesn't pile up an entry per switch (replace == in-
// place URL edit). Caller passes the raw semester string (e.g. "252"
// or "Fall-2025"); we URI-encode it for safety even though current codes
// are alphanumeric.
function syncUrlTerm(semester) {
  if (typeof window === 'undefined' || !semester) return;
  const url = new URL(window.location.href);
  if (url.searchParams.get('term') === semester) return; // no-op if unchanged
  url.searchParams.set('term', semester);
  window.history.replaceState(null, '', url.toString());
}

export default function SchedulerPage() {
  // NEW-FU-207: isArchived gates grid-level click + drag handlers so the
  // user can't open the section-edit modal or drag to reorder while
  // viewing an archived term. Banner (FU-203) sets expectation; this
  // ensures no path through the grid bypasses the read-only contract.
  // (OH click still opens the modal — but in read-only mode, FU-206.)
  const { schedule, view, filterId, softPending, saveBlocked,
          loadReference, loadView, saveSchedule, moveSection,
          // NEW-FU-283 (Phase 56): `venues` added so the audit effect
          // below can walk the loaded list.
          sections, courses, venues, instructors, error, dispatch, unfinalizeSchedule, doLogout,
          // NEW-FU-549 (Batch 16): undo/redo
          undo, redo, recordMutation, clearHistory } = useApp();
  const reduceMotion = useReducedMotion();

  // NEW-FU-482 (Phase 116): a term is locked (read-only) when archived OR finalized — the
  // backend refuses writes in both. Gate every mutating entry point up front so a finalized
  // term can't be edited then rejected after the fact.
  const scheduleLocked = Boolean(schedule?.archived_at) || schedule?.status === 'Finalized';

  // NEW-FU-480 (Phase 115): how many real instructors / venues still need registering —
  // each placeholder ("dummy") gets auto-replaced by one real entity. Shown in the header.
  const dummyInstrCount = (instructors || []).filter(i => i.is_dummy).length;
  const dummyVenueCount = (venues || []).filter(v => v.is_dummy).length;

  const [showSoftModal, setShowSoftModal] = useState(false);
  const [toast,         setToast]         = useState(null);
  const [sectionModal,  setSectionModal]  = useState(null);
  const [ohModal,       setOhModal]       = useState(null);
  const [showExport,    setShowExport]    = useState(false);
  // NEW-FU-228 (Phase 97): which tab the Schedule-Data modal opens on — the
  // top-bar Export button → 'export', the new Import button → 'import'.
  const [exportInitialTab, setExportInitialTab] = useState('export');
  const [showSuggest,   setShowSuggest]   = useState(false);
  // NEW-FU-391 (Phase 100): blocking "applying…" overlay shown ONLY during the
  // Suggest compute phases (preview / relaxation / apply+reload) — NOT while a
  // decision dialog is open. It tells the user the run is working and prevents
  // them from interacting (or giving up and refreshing) mid-apply. `withSuggestBusy`
  // wraps each heavy await so the overlay brackets exactly the compute, leaving
  // the decision modals interactive.
  const [suggestBusy, setSuggestBusy] = useState(null); // null | { message }
  async function withSuggestBusy(message, fn) {
    setSuggestBusy({ message });
    try { return await fn(); }
    finally { setSuggestBusy(null); }
  }
  // NEW-FU-223 (Phase 96): in-app decision dialog. The Suggest flow used to
  // drive its "your picks conflict — what now?" decisions through a chain of
  // native window.confirm()/alert() calls (ugly, OK/Cancel-only, R-code-laden).
  // `decision` holds the current dialog spec (incl. its resolve fn); askDecision
  // lets the async flow `await` a user choice inline; DecisionModal renders it.
  const [decision, setDecision] = useState(null);
  function askDecision(spec) {
    return new Promise(resolve => setDecision({ ...spec, resolve }));
  }
  // NEW-FU-319 (Phase 29): Quick Fix preview modal. Opened from the
  // SidePanel's "Quick Fix conflicts" button when conflicts.length > 0.
  // The modal fetches the plan internally and applies the selected ops;
  // we only need to provide a refresh hook (reload conflicts/sections)
  // and a toast surface for success/failure messaging.
  const [showQuickFix,  setShowQuickFix]  = useState(false);
  const [groupChangeModal, setGroupChangeModal] = useState(null); // { sec, newDay, newStartTime, duration }
  const [activeDrag,    setActiveDrag]    = useState(null); // { type:'section'|'course', id }
  // NEW-FU-217 (Phase 91): schedule-grid VIEW MODE. 'overview' = the default
  // fit-to-viewport view (whole week visible, dense cards shrink); 'readable' = fixed
  // legible card sizing that scrolls. Lifted here (the common ancestor of the header
  // toggle and <ScheduleGrid>) and persisted so the user's choice sticks across loads.
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('sg-view-mode') === 'readable' ? 'readable' : 'overview'; }
    catch { return 'overview'; }
  });
  useEffect(() => { try { localStorage.setItem('sg-view-mode', viewMode); } catch { /* ignore */ } }, [viewMode]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  useEffect(() => {
    async function boot() {
      try {
        const { listSchedules, createSchedule } = await import('../api/index.js');
        const list = await listSchedules(DEPT_ID);
        // NEW-FU-171: URL active-term sync. If `?term=XXX` is present and
        // matches an existing schedule, load that one. Otherwise fall
        // back to the default SEMESTER. The URL is the canonical "which
        // term am I viewing" — bookmark-friendly and survives reload.
        const urlTerm = new URLSearchParams(window.location.search).get('term');
        const targetSemester = (urlTerm && list.some(s => s.semester === urlTerm)) ? urlTerm : SEMESTER;
        let sched = list.find(s => s.semester === targetSemester) ?? null;
        if (!sched) {
          try {
            sched = await createSchedule({ departmentId: DEPT_ID, semester: targetSemester });
          } catch {
            // Schedule may already exist — reload list and pick it up
            const list2 = await listSchedules(DEPT_ID);
            sched = list2.find(s => s.semester === targetSemester) ?? null;
          }
        }
        // NEW-FU-274 (Phase 51 #5): loadReference moved after the target
        // term is known so the three reference lists are pre-filtered for
        // the term the user is about to see. Avoids the brief flicker
        // where the sidebar shows global content then collapses to scoped.
        await loadReference(sched.semester);
        dispatch({ type: 'SET_SCHEDULE', schedule: sched });
        // NEW-FU-171: reflect the loaded term in the URL so reload + bookmark
        // round-trip works even when no ?term param was originally set.
        syncUrlTerm(sched.semester);
        await loadView(sched.id, view, filterId);
      } catch (err) {
        // NEW-FU-11: boot failures used to log to console only, leaving the
        // user staring at an empty page with no signal. Surface a toast so
        // a transient backend outage or 401 storm is visible.
        console.error('Boot failed:', err);
        showToast(
          err?.response?.data?.error ||
          'Failed to load workspace. Try refreshing the page.',
          'error',
        );
      }
    }
    boot();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NEW-FU-165 + NEW-FU-171: switch to a different academic term + sync URL.
  // The term picker hands us back a term object with `scheduleId` and
  // `code` (semester). We dispatch SET_SCHEDULE and update the URL's
  // ?term=XXX query param via history.replaceState (no full navigation,
  // no page reload). The existing [view, filterId, schedule?.id] effect
  // below then refetches sections for the newly-active schedule.
  // View-mode + filterId are preserved across the switch.
  const handleSwitchTerm = async (term) => {
    // NEW-FU-561 (audit P1-7): the contract is a term OBJECT ({scheduleId, code,
    // status, archivedAt}), but TermPicker's archive/delete/rename-the-ACTIVE-term
    // flows call this with a bare term-CODE STRING (altCode / newCode). A string has
    // no .scheduleId, so the old guard silently dropped the switch and left the user
    // stranded on the just-removed schedule. Accept either form: resolve a string
    // code to its schedule via the same source the bootstrap uses.
    if (typeof term === 'string') {
      const { listSchedules } = await import('../api/index.js');   // dynamic import — matches boot()
      const list = await listSchedules(DEPT_ID).catch(() => []);
      const sched = list.find(s => s.semester === term);
      if (!sched) return;
      term = { scheduleId: sched.id, code: sched.semester, status: sched.status, archivedAt: sched.archived_at || null };
    }
    if (!term?.scheduleId) return;
    // NEW-FU-203: carry archived_at through so the banner renders
    // immediately on term switch, before listView refetches.
    dispatch({ type: 'SET_SCHEDULE', schedule: {
      id: term.scheduleId,
      semester: term.code,
      department_id: DEPT_ID,
      status: term.status,
      archived_at: term.archivedAt || null,
    } });
    syncUrlTerm(term.code);
    // NEW-FU-274 (Phase 51 #5): refetch reference data scoped to the
    // newly-selected term. Without this, the sidebar would still show
    // the previous term's instructor / venue / course lists until the
    // page reloaded. The await keeps the dispatch ordering stable —
    // the [schedule?.id] effect below picks up the term change too.
    await loadReference(term.code);
  };

  // NEW-FU-551 (Batch 17 Issue 3): ALWAYS call loadView on a view/term change —
  // even for teacher/venue with no filter selected. loadView's own guard (FU-527)
  // handles that case gracefully: it skips the sections fetch (no FU-47 400) but
  // STILL refetches the term-global conflicts. The previous early-return here meant
  // SET_VIEW cleared `conflicts:[]` and nothing refetched them, so Instructor/Venue
  // view showed "No conflicts" while Course View showed the real count for the SAME
  // term — a contradiction. Conflicts are a property of the TERM, not the view.
  useEffect(() => {
    if (!schedule) return;
    loadView(schedule.id, view, filterId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, filterId, schedule?.id]);

  // NEW-FU-31: surface mid-session loadView failures via toast. AppContext's
  // loadView swallows its catch into a SET_ERROR dispatch (so it can't be
  // re-thrown from a useCallback without breaking signal handling for the
  // sequence counter). Without this subscriber, the failure was visible only
  // through state.error which no surface rendered — the user saw an empty
  // schedule with no signal. SET_LOADING at the start of every loadView call
  // resets state.error to null, so a fresh failure flips null→msg and this
  // effect fires again for each new failure.
  useEffect(() => {
    if (error) showToast(error, 'error');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  // NEW-FU-549 (Batch 16): Undo / Redo handlers + global keyboard shortcuts.
  async function handleUndo() {
    const r = await undo();
    if (r) showToast(`↶ Undone: ${r.label}`, 'info');
  }
  async function handleRedo() {
    const r = await redo();
    if (r) showToast(`↷ Redone: ${r.label}`, 'info');
  }
  useEffect(() => {
    function onKey(e) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = (e.key || '').toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      // Don't hijack native text undo while typing, and don't act while any modal is
      // open (its own edits/confirm own the keyboard).
      const t = e.target;
      const tag = t?.tagName;
      if (t?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.querySelector('.sm-overlay, .modal-overlay, .qf-overlay')) return;
      if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); handleRedo(); }
      else if (k === 'z') { e.preventDefault(); handleUndo(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo]);

  // NEW-FU-283 (Phase 56): venue-name audit. Walks the loaded venues
  // list once whenever the term's reference data changes and flags any
  // row whose name doesn't match the registrar convention enforced by
  // AddVenueModal (XX-YYY / XX-YYY-Z / XX-YYYY). The audit is
  // flag-only — we never rewrite existing rows automatically because
  // a "wrong-looking" name might be a deliberately preserved legacy
  // designation. A single toast names a few examples so an admin can
  // open Venue View and fix them by hand.
  //
  // Why startup-time, not server-side: the convention is a frontend
  // policy that arrived in Phase 56; the server validates name length
  // but not structure. Doing this check on the client avoids a
  // migration that would have to make irreversible decisions about
  // ambiguous legacy names.
  //
  // The `venuesAuditedRef` guard de-duplicates: we only toast once per
  // venue-list identity, so flipping between terms doesn't re-fire the
  // warning for the same audit result on every switch.
  const venuesAuditedRef = React.useRef(null);
  useEffect(() => {
    if (!venues || venues.length === 0) return;
    // Single representation of the audit: a stringified list of names
    // makes a stable key — same names in any order produce the same key.
    const auditKey = venues.map(v => v.name).slice().sort().join('|');
    if (venuesAuditedRef.current === auditKey) return;
    venuesAuditedRef.current = auditKey;

    // NEW-FU-286 (Phase 57): suffix expanded from [A-Z] to [A-Z0-9] so
    // legitimate digit-divided rooms like "24-240-1" / "42-114-2" no
    // longer trigger false-positive audit warnings.
    // NEW-FU-222 (Phase 96): broadened to stop flagging the rest of the REAL
    // KFUPM venue forms that fired this warning on every refresh — they are
    // valid registrar designations, not data-entry mistakes:
    //   • single-digit building numbers          → "7-220"
    //   • letter suffix written WITHOUT a dash    → "24-236A"
    //   • named special rooms (auditorium)        → "42-AUD"
    // The audit still catches genuinely malformed names (3+-digit buildings,
    // free-text junk), so legitimate-mistake detection is preserved.
    const NAME_RE = /^\d{1,2}-(\d{3}(-?[A-Z0-9])?|\d{4}|AUD)$/;
    const bad = venues.filter(v => !NAME_RE.test(v.name || ''));
    if (bad.length === 0) return;
    const sample = bad.slice(0, 3).map(v => `"${v.name}"`).join(', ');
    const more   = bad.length > 3 ? ` (+${bad.length - 3} more)` : '';
    // NEW-FU-290 (Phase 57): pluralize the verb too — "1 venue doesn't"
    // / "N venues don't" — not just the noun.
    const verb = bad.length > 1 ? "don't" : "doesn't";
    const noun = bad.length > 1 ? 'venues' : 'venue';
    showToast(
      `⚠ ${bad.length} ${noun} ${verb} match the XX-YYY / XX-YYY-Z / XX-YYYY ` +
      `naming convention: ${sample}${more}. Edit in Venue view if intentional.`,
      'warn',
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venues]);

  // NEW-FU-55: the prior `[sections.length]` effect was a duplicate of the
  // `[view, filterId, schedule?.id]` effect above for the only case it
  // actually fired in (the SET_VIEW reducer wiping sections). Both effects
  // fired together on every view-or-filter change → two simultaneous
  // loadView round-trips for one user action. The seq counter dropped the
  // stale response, but the wasted request still hit the server.
  //
  // The remaining job — react when sections becomes empty for OTHER reasons
  // (e.g., backend purge after CASCADE delete) — is already covered by the
  // CLEAR_SECTIONS dispatch in AppContext.removeCourse / removeInstructor /
  // removeVenue / removeSection, each of which is followed by a loadView at
  // the appropriate call site or by the [view, filterId, schedule?.id]
  // effect when the user then switches views.
  //
  // Effect removed entirely. prevSectionsRef no longer needed.

  // ── Shared DnD handlers (wraps both sidebar + grid) ────────────────────────
  function handleDragStart(e) {
    const id = String(e.active.id);
    if (id.startsWith('oh-')) {
      setActiveDrag({ type: 'officeHour', id, data: e.active.data?.current?.officeHour });
    } else if (sections.some(s => s.id === id)) {
      setActiveDrag({ type: 'section', id });
    } else {
      setActiveDrag({ type: 'course', id });
    }
  }

  // NEW-FU-613 (Batch 30 follow-up): preview a proposed move/restructure and, if it would create
  // ANY conflict, ask the user to confirm BEFORE it is applied. Returns true to PROCEED, false to
  // ABORT. Shared by BOTH the same-group time drag AND the cross-group day-change restructure so
  // they warn identically (same wording, same first-few-conflicts list, Move anyway / Cancel) and
  // neither can silently create a conflict. `change` is the previewConflicts payload (sectionId +
  // the proposed days/startTime/endTime). Advisory: if the preview itself fails, returns true
  // (proceed — the backend + the grid still surface conflicts afterward).
  async function confirmIfConflicts(change) {
    try {
      const { previewConflicts } = await import('../api/index.js');
      const prev = await previewConflicts(schedule.id, change);
      const clashes = prev?.conflicts ?? [];
      if (!clashes.length) return true;
      return await askDecision({
        icon: <Ico name="alert" />,
        title: `This move creates ${clashes.length} conflict${clashes.length !== 1 ? 's' : ''}`,
        lead: clashes.slice(0, 3).map(c => c.description).join('  •  ')
              + (clashes.length > 3 ? `  •  +${clashes.length - 3} more` : ''),
        options: [
          { label: 'Move anyway', value: true, tone: 'danger' },
          { label: 'Cancel',      value: false, tone: 'neutral' },
        ],
        dismissValue: false,
      });
    } catch { return true; }
  }

  async function handleDragEnd(e) {
    const prev = activeDrag;
    setActiveDrag(null);
    const { active, over } = e;
    if (!over || !active) return;
    // NEW-FU-207: defensive no-op on archived view. The block-level
    // useDraggable is already disabled by SectionBlock / DraggableCourse
    // when archived, so this should be unreachable — but if someone routes
    // a drag through some other path, the handler refuses to mutate.
    if (scheduleLocked) return;

    // Only act on drops over grid cells (id format: "Day|minutes")
    const overId = String(over.id);
    if (!overId.includes('|')) return;

    const [day, minStr] = overId.split('|');
    const startTime = fromMinutes(parseInt(minStr));

    try {
      if (prev?.type === 'section') {
        const sec = sections.find(s => s.id === active.id);
        if (!sec) return;
        const origStart  = sec.startTime ?? sec.start_time ?? '';
        const origEnd    = sec.endTime   ?? sec.end_time   ?? '';
        const duration   = timeToMin(origEnd) - timeToMin(origStart);
        // NEW-FU-502 (Phase 123): defensive — a section with missing/equal
        // times would compute duration 0 and the move below would write a
        // zero-length section (start == end). Unreachable from the grid
        // (DayColumn skips time-less sections) but cheap to refuse here.
        if (!Number.isFinite(duration) || duration <= 0) return;
        if (day === sec.day && startTime === origStart.substring(0,5)) return;

        // NEW-FU-371 (Phase 98 item 2): a LAB is single-day by definition
        // (sectionPattern.LAB_RULE = 50/75/160 min on exactly ONE day). The
        // day-GROUP machinery (MW / STT) exists only for multi-day LECTURE
        // groups; routing a lab through it expands the move to the target
        // group's 3 days, which the backend pattern validator then rejects
        // ("Lab must be on a single day") — and, before the createSection fix,
        // first tripped the false "section number must be 01–49" error. So a
        // lab is treated as 'single' here: a cross-group lab drag becomes a
        // clean single-day move (the moveSection path below) onto the dropped
        // day, which is exactly what "move the lab to Sunday" should do.
        // Lecture group moves are unaffected.
        const draggedType = sec.sectionType ?? sec.section_type;
        // NEW-FU-619 (audit P2): trigger the cross-pattern restructure when the target day is
        // OUTSIDE the section's CURRENT day-set — not via the coarse STT/MW DAY_GROUPS table,
        // which is blind to 2-day ST/TT patterns. A 2-credit Sun/Tue section dragged to Thursday
        // used to read origGroup==newGroup=='STT' → no restructure → it fell through to a
        // time-only move that assignSection then coerced back to Sunday → a SILENT no-op with no
        // feedback. Now any multi-day lecture dropped onto a day not in its pattern restructures
        // to the legal pattern containing that day (confirmGroupChange → targetPatternForDrag).
        // Labs are single-day, so they skip this and move freely below.
        const sectionDays = sections.filter(s =>
          (s.courseId      ?? s.course_id)      === (sec.courseId      ?? sec.course_id) &&
          (s.sectionNumber ?? s.section_number) === (sec.sectionNumber ?? sec.section_number) &&
          (s.gender ?? 'M') === (sec.gender ?? 'M')   // gender-scoped, matching the section identity
        ).map(s => s.day);
        const isMultiDayLec = draggedType !== 'Lab' && sectionDays.length > 1;

        // If dropped onto a day OUTSIDE this multi-day section's pattern → confirm a restructure.
        if (isMultiDayLec && !sectionDays.includes(day)) {
          setGroupChangeModal({ sec, newDay: day, newStartTime: startTime, duration, actualSiblingCount: sectionDays.length });
          return;
        }

        // NEW-FU-4 + NEW-FU-8: coerce a cross-day drag into a time-only move
        // ONLY when a sibling already occupies the target day. Checking real
        // collisions (same course + same sectionNumber + target day) instead
        // of "same day-group" lets a single-day section that happens to live
        // on an STT/MW day still be freely moved to another day.
        const hasSiblingOnTarget = sections.some(s =>
          s.id !== sec.id &&
          (s.courseId      ?? s.course_id)      === (sec.courseId      ?? sec.course_id) &&
          (s.sectionNumber ?? s.section_number) === (sec.sectionNumber ?? sec.section_number) &&
          s.day === day
        );
        let effectiveDay = day;
        if (hasSiblingOnTarget) {
          effectiveDay = sec.day;
          // NEW-FU-61: surface the day-coerce so the user knows why their
          // requested day change "didn't take." Without this, the section
          // visually snaps back to its origin day with no signal — confusing
          // because the time change still applies.
          showToast(
            `Day change ignored — a section of this group already exists on ${day}. Time updated only.`,
            'warn',
          );
        }

        // NEW-FU-494 (Phase 119 item 4): R-06 window guard on drag-drop.
        // Prevents dragging a section outside its teaching window at the frontend
        // so the user gets an instant toast instead of a backend 400 that
        // would leave the grid in an unresolved conflict state.
        // NEW-FU-495 (Phase 120): UG 07:00–17:10, GR 17:20–22:00. Capstone is
        // bound to the UG window (venue-exempt but NOT time-exempt); external exempt.
        // NEW-FU-497 (Phase 121): SWE 412 is exempt from the R-06 window (evening capstone).
        if (!sec.isExternal && sec.courseCode !== 'SWE 412') {
          const dragEnd   = fromMinutes(timeToMin(startTime) + duration);
          const sMin      = timeToMin(startTime);
          const eMin      = timeToMin(dragEnd);
          const isGR      = sec.category === 'GR';
          const isCap     = sec.isCapstone;
          const win       = (isGR && !isCap) ? TIME_WINDOWS.GR : TIME_WINDOWS.UG;
          const winStart  = win.start;
          const winEnd    = win.end;
          if (sMin < winStart || eMin > winEnd) {
            const lbl = isCap ? '07:00–17:10 (Capstone)'
                      : isGR  ? '17:20–22:00 (Graduate)'
                               : '07:00–17:10 (Undergraduate)';
            showToast(`Cannot move here — ${sec.courseCode ?? 'section'} must run within ${lbl}.`, 'error');
            return;
          }
        }

        // NEW-FU-611 (Batch 30 item 3a): warn-and-confirm BEFORE a drag creates a conflict.
        // Preview the move (the whole group's days at the new time); if it would clash, ask the
        // user to confirm. Cancel → return WITHOUT moving, so the card snaps back to its original
        // slot (state is untouched, so React re-renders it where it was). Confirm → apply and let
        // the conflict surface in the panel. No drag silently creates a conflict. Advisory: if the
        // preview itself fails, fall through to the move (the grid still shows conflicts after).
        const endTime = fromMinutes(timeToMin(startTime) + duration);
        const sameGroup = (s) =>
          (s.courseId ?? s.course_id) === (sec.courseId ?? sec.course_id) &&
          (s.sectionNumber ?? s.section_number) === (sec.sectionNumber ?? sec.section_number) &&
          (s.gender ?? 'M') === (sec.gender ?? 'M');
        const groupDays = sections.filter(sameGroup).map(s => s.day);
        // Shared pre-apply conflict confirmation (NEW-FU-613). Cancel → return, card snaps back.
        const ok = await confirmIfConflicts({
          sectionId:     sec.id,
          courseId:      sec.courseId      ?? sec.course_id,
          instructorId:  sec.instructorId  ?? sec.instructor_id ?? null,
          venueId:       sec.venueId       ?? sec.venue_id      ?? null,
          sectionNumber: sec.sectionNumber ?? sec.section_number,
          sectionType:   sec.sectionType   ?? sec.section_type  ?? 'Lec',
          gender:        sec.gender ?? 'M',
          days:          groupDays.length ? groupDays : [effectiveDay],
          startTime, endTime,
        });
        if (!ok) return;   // revert — card returns to its original day/time

        await moveSection(sec.id, {
          instructorId: sec.instructorId ?? sec.instructor_id,
          venueId:      sec.venueId      ?? sec.venue_id,
          day: effectiveDay,
          startTime,
          endTime,
        });
        // Reload to show all siblings at new time
        if (schedule) loadView(schedule.id, view, filterId);
      } else if (prev?.type === 'course') {
        setSectionModal({
          mode: 'add',
          initial: { courseId: active.id, day, startTime, duration: DAY_DURATION[day] ?? 50 },
        });
      } else if (prev?.type === 'officeHour' && prev?.data) {
        const oh = prev.data;
        const ohStart = oh.start_time ?? oh.startTime ?? '';
        const ohEnd   = oh.end_time   ?? oh.endTime   ?? '';
        const duration = timeToMin(ohEnd) - timeToMin(ohStart);
        const newEnd   = fromMinutes(timeToMin(startTime) + duration);
        // NEW-FU-41: single atomic PUT replaces the prior create+delete dance.
        // The old pattern silently produced duplicate OHs whenever the delete
        // half failed (network blip, 5xx, race), and the duplicates then
        // got R-04 -flagged against every overlapping section. One UPDATE
        // means the row id is stable and conflict revalidation sees exactly
        // one OH.
        await api.updateInstructorOfficeHour(oh.instructor_id ?? filterId, oh.id, {
          day, startTime, endTime: newEnd,
        });
        if (schedule) loadView(schedule.id, view, filterId);
      }
    } catch(err) {
      // C-7: surface drag errors rather than silently swallowing them
      showToast(err.response?.data?.error || 'Drag action failed.', 'error');
    }
  }

  function handleDragCancel() { setActiveDrag(null); }

  // ── Group change confirmation ──────────────────────────────────────────────
  async function confirmGroupChange() {
    if (!groupChangeModal || !schedule) return;
    const { sec, newDay, newStartTime, duration } = groupChangeModal;
    setGroupChangeModal(null);

    // NEW-FU-610 (Batch 30 item 3): re-derive the WHOLE-section pattern AND duration for the
    // course's credits/flags — not the coarse STT/MW guess at the old duration. A 3-credit
    // Sun/Tue/Thu @ 50 dragged to Monday becomes Mon/Wed @ 75; a 2-credit section dragged to
    // Sunday becomes Sun/Tue @ 50; a 1-credit becomes a single day. This makes the restructure
    // produce a pattern the backend validator accepts (the old fixed-duration path created an
    // illegal Mon/Wed @ 50 for a 3-credit course and the create then 400'd).
    const course   = courses.find(c => c.id === (sec.courseId ?? sec.course_id));
    const credits  = course?.credits ?? sec.credits;
    const hasLab   = course?.has_lab ?? sec.hasLab ?? sec.has_lab ?? false;
    const tgt        = targetPatternForDrag(newDay, credits, hasLab, duration);
    const newDays    = tgt.days;
    const newEndTime = fromMinutes(timeToMin(newStartTime) + tgt.duration);

    // NEW-FU-613 (Batch 30 follow-up): warn-and-confirm BEFORE the restructure creates a conflict
    // — parity with the same-group time drag. Preview the NEW (re-derived) day-set + duration +
    // start time; if it would clash, ask the user via the SAME shared popup. This runs BEFORE any
    // mutation: Cancel → return now, so nothing is deleted or created and the section stays exactly
    // as it was (the card never left its place). Confirm → fall through to the delete+recreate and
    // let the conflict surface. previewConflicts excludes this section's own (old) group by
    // identity, so the check is "does the new pattern clash with OTHER sections?".
    const ok = await confirmIfConflicts({
      sectionId:     sec.id,
      courseId:      sec.courseId      ?? sec.course_id,
      instructorId:  sec.instructorId  ?? sec.instructor_id ?? null,
      venueId:       sec.venueId       ?? sec.venue_id      ?? null,
      sectionNumber: sec.sectionNumber ?? sec.section_number,
      sectionType:   sec.sectionType   ?? sec.section_type  ?? 'Lec',
      gender:        sec.gender ?? 'M',
      days:          newDays,
      startTime:     newStartTime,
      endTime:       newEndTime,
    });
    if (!ok) return;   // aborted before any delete/create — section untouched

    // H-8 + NEW-FU-40: Create new sections FIRST so a failed create leaves
    // the old group intact. Use ONE createSection call with the `days` array
    // so the backend creates all rows in a single transaction (see
    // ScheduleService.createSection — N inserts under one BEGIN/COMMIT).
    // The previous version looped N HTTP calls; if call k of N failed, the
    // first k-1 sections persisted AND the old group was never deleted —
    // leaving the user with the original group PLUS orphaned partial-new
    // sections. Now either ALL new days appear (then deleteSection runs) or
    // none do (deleteSection never runs, old group stays clean).
    try {
      const { createSection, deleteSection } = await import('../api/index.js');
      await createSection(schedule.id, {
        courseId:      sec.courseId      ?? sec.course_id,
        instructorId:  sec.instructorId  ?? sec.instructor_id,
        venueId:       sec.venueId       ?? sec.venue_id,
        sectionNumber: sec.sectionNumber ?? sec.section_number,
        // NEW-FU-371 (Phase 98 item 2): forward the section TYPE so a
        // cross-day-group move of a Lab section (§50–§99) re-creates as a Lab,
        // not a Lec. Without this the backend used to default to 'Lec' and
        // reject the §50 number with "must be in 01–49". Mirrors the payload
        // SectionModal already sends; the backend now also derives type from
        // the number as a second line of defence.
        sectionType:   sec.sectionType   ?? sec.section_type,
        // NEW-FU-562 (audit-2 P1-1): forward GENDER through this drag-triggered
        // delete+recreate restructure. Without it the recreate defaulted to 'M' and
        // silently flipped a female lecture section to male (identity = course+number+
        // gender) — the same corruption fixed in the SectionModal path (P1-5), but this
        // second restructure path (cross-day-group drag) was missed.
        gender:        sec.gender        ?? sec.section_gender ?? 'M',
        days:          newDays,
        day:           newDays[0],
        startTime:     newStartTime,
        endTime:       newEndTime,
      });
      await deleteSection(sec.id);
      recordMutation('move section');   // NEW-FU-549: one undo step for the restructure
      showToast(`✓ Section moved to ${tgt.days.map(d => d.slice(0,3)).join('/')} · ${tgt.duration} min.`, 'success');
      loadView(schedule.id, view, filterId);
    } catch(err) {
      showToast(err.response?.data?.error || 'Failed to change group.', 'error');
    }
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function handleSave() {
    if (saveBlocked) return;
    if (softPending.length > 0) { setShowSoftModal(true); return; }
    await doSave(false);
  }
  // NEW-FU-78: when confirming softs, pass the EXACT set of conflict ids the
  // modal displayed (snapshot at the moment the user clicked Save Anyway).
  // The backend will reject the save and surface a new modal if any soft
  // conflict appeared between then and the save tx — protecting the user
  // from inadvertently confirming a conflict they never saw.
  async function doSave(confirmSoft) {
    setShowSoftModal(false);
    try {
      // confirmSoft can be: false (no softs), true (legacy confirm-all), or
      // an array of soft conflict ids the user acknowledged in the modal.
      const r = await saveSchedule(confirmSoft);
      if (!r.saved && r.newSoftConflicts && r.newSoftConflicts.length > 0) {
        showToast('New soft conflicts appeared since you confirmed. Please review again.', 'warn');
        // The dispatch'd SET_CONFLICTS (via the saveSchedule wrapper's catch)
        // has already refreshed softPending; the user can re-open the modal
        // from the Save button.
        return;
      }
      showToast(r.saved ? '✓ Term finalized & locked.' : 'Conflicts remain.', r.saved ? 'success' : 'error');
    } catch { showToast('Finalize failed.', 'error'); }
  }

  // NEW-FU-467 (Phase 112): un-finalize ("Unlock") parity with Save — the user
  // gets the same bottom-of-screen confirmation Save shows, so the action is
  // acknowledged the same way (Unlock previously changed state silently).
  async function handleUnlock() {
    try {
      await unfinalizeSchedule();
      showToast('Schedule unlocked — you can edit it again.', 'success');
    } catch (err) {
      showToast(err.response?.data?.error || 'Could not unlock the schedule.', 'error');
    }
  }

  // NEW-FU-476 (Phase 114): confirm before logging out. The power button next to the
  // username used to end the session on a single accidental click. Uses the app's own
  // styled dialog (DecisionModal via askDecision), never the OS window.confirm().
  async function handleLogout() {
    const choice = await askDecision({
      icon: <Ico name="power" />,
      title: 'Log out of SchedulerSWE?',
      lead: "You'll need to sign in again to view or change schedules.",
      options: [
        { label: 'Yes, log out', value: 'yes', tone: 'danger' },
        { label: 'Cancel',       value: 'cancel', tone: 'neutral' },
      ],
      dismissValue: 'cancel',
    });
    if (choice === 'yes') doLogout();
  }

  // ── Export / Import ──────────────────────────────────────────────────────
  function handleExport() {
    if (!schedule) return;
    setExportInitialTab('export');
    setShowExport(true);
  }
  // NEW-FU-228 (Phase 97): open the same Schedule-Data modal straight on Import.
  function handleImport() {
    if (!schedule) return;
    setExportInitialTab('import');
    setShowExport(true);
  }

  async function doExport(exportView, exportFilterId, format = 'xlsx') {
    if (!schedule) return;
    try {
      const blob = await api.downloadExport(schedule.id, exportView, exportFilterId, format);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      // NEW-FU-182: human-readable term label; falls back to the raw semester
      // string when decode fails (legacy non-YYT codes).
      const labelPart = decodeTermLabel(schedule.semester);
      a.download = `${labelPart}-${exportView}-schedule.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`✓ ${format.toUpperCase()} downloaded.`, 'success');
    } catch (err) {
      showToast(err.response?.data?.error || 'Export failed.', 'error');
    }
  }

  // PNG export — runs entirely in the browser. We capture the currently
  // rendered schedule grid via html2canvas. Dynamic import keeps html2canvas
  // out of the main bundle until the user actually requests an image.
  async function doExportImage(exportView /* unused — we capture the live DOM */, _filterId) {
    if (!schedule) return;
    try {
      const target = document.querySelector('[data-export-target="schedule-grid"]')
                  ?? document.querySelector('.grid-host')
                  ?? document.querySelector('main');
      if (!target) {
        showToast('Could not find the schedule grid to capture.', 'error');
        return;
      }
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(target, { backgroundColor: '#ffffff', scale: 2 });
      const labelPart = decodeTermLabel(schedule.semester);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `${labelPart}-${exportView}-schedule.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('✓ Image downloaded.', 'success');
    } catch (err) {
      showToast(err.message || 'Image export failed.', 'error');
    }
  }

  function handleBlockClick(section) {
    // NEW-FU-207/482: no-op on archived OR finalized view (read-only).
    if (scheduleLocked) return;
    setSectionModal({ mode: 'edit', initial: { section } });
  }

  // NEW-FU-272/273 + NEW-FU-609 + NEW-FU-629 (audit): grid-block quick-delete handler.
  // The grid ✕ ALWAYS deletes the whole section group (all meeting days) — a section has
  // one identity across its days, so a per-day delete would leave an impossible partial
  // group. The old scope='row' path was removed (SectionBlock hardcodes a group delete and
  // its `deleteSectionRow` API helper is gone). After success we reload the view so the
  // deleted block (and any new R-15 conflict on a surviving group) appear.
  async function handleSectionDelete(section) {
    if (!schedule || scheduleLocked) return;
    const courseCode = section.courseCode ?? section.course_code ?? '';
    const secNum     = section.sectionNumber ?? section.section_number ?? '';
    // NEW-FU-547 (Batch 15 Issue 5): themed dialog (askDecision/DecisionModal) instead
    // of the native window.confirm white panel — dark-mode compatible.
    const ok = await askDecision({
      icon: <Ico name="alert" />,
      title: `Delete ALL meeting days of ${courseCode} §${secNum}?`,
      lead: 'This removes the entire section.',
      options: [
        { label: 'Delete', value: true, tone: 'danger' },
        { label: 'Cancel', value: false, tone: 'neutral' },
      ],
      dismissValue: false,
    });
    if (!ok) return;
    try {
      const { deleteSection } = await import('../api/index.js');
      await deleteSection(section.id);
      recordMutation('delete section');   // NEW-FU-549
      showToast(`✓ Removed entire section ${courseCode} §${secNum} (all meeting days).`, 'success');
      await loadView(schedule.id, view, filterId);
    } catch (err) {
      showToast('Delete failed: ' + (err.response?.data?.error ?? err.message), 'error');
    }
  }
  function handleOHClick(oh) {
    // NEW-FU-206: opens the modal even when archived; the modal renders
    // itself in read-only mode (inputs disabled, Save/Delete disabled) so
    // the admin can inspect OH details without mutating them.
    setOhModal({ officeHour: oh, instructorId: filterId });
  }

  function handleModalClose() {
    setSectionModal(null);
    // Always reload after any modal action (add/edit/delete may affect siblings)
    if (schedule) loadView(schedule.id, view, filterId);
  }
  function handleOpenAdd()            { if (scheduleLocked) return; setSectionModal({ mode: 'add',  initial: {} }); }
  function handleSuggest() {
    if (!schedule || scheduleLocked) return;
    setShowSuggest(true);
  }
  // NEW-FU-319 (Phase 29): open Quick Fix preview modal. The SidePanel
  // shows the button only when conflicts.length > 0, so the defensive
  // !schedule guard here is the same shape as handleSuggest above — we
  // refuse to open without an active schedule, and the modal itself
  // refuses to fetch a plan when archived (the backend's apply route is
  // gated by refuseIfActiveTermArchived).
  function handleQuickFix() {
    if (!schedule) return;
    setShowQuickFix(true);
  }

  // NEW-FU-265: SuggestModal now also returns `applyToCourseIds` (null
  // when the user left every course checked — caller forwards null and
  // the backend takes the legacy "apply to all" path). When non-null,
  // the backend wipes + regenerates ONLY those courses, preserving
  // existing sections of unchecked courses.
  async function runSuggest(courseConfigs, applyToCourseIds /* legacy 3rd arg removed */) {
    setShowSuggest(false);
    showToast('⏳ Calculating best schedule…', 'info');
    // NEW-FU-223 (Phase 96): the Suggest flow is now CLEAN-FIRST. We never ask
    // the user up-front "how many conflicts will you tolerate" — no sane
    // scheduler WANTS conflicts. Instead we always try to honour their exact
    // picks with ZERO conflicts; only if that's impossible do we explain the
    // clashes in plain language and let them choose: adjust automatically
    // (fewest changes) or keep their picks (with conflicts, after a warning).
    // Placement tolerance is therefore fixed to 'any' (force-place the chosen
    // OR relaxed configs); the real decision lives in the dialog, not a knob.
    const TOL = 'any';
    try {
      const { suggestSchedule } = await import('../api/index.js');

      // Ask the backend's relax passes for a conflict-free plan that changes
      // the FEWEST of the user's selections. Returns { proceed, configs }.
      // Owns its own last-resort (drop courses) and dead-end dialogs/toasts.
      // NEW-FU-432 (Phase 106 item 1): build the "drop N sections" bullets/count
      // from a guaranteed hitting-set last-resort plan. Label order: term catalog
      // (code+name) → backend code(+name) → safe label — NEVER a raw id (FU-424).
      function dropPlanInfo(lrp) {
        const courseList = (typeof courses !== 'undefined' && courses) || [];
        const backendMeta = {};
        (lrp.droppedSections ?? []).forEach(d => {
          if (d.courseId && (d.courseCode || d.courseName)) backendMeta[d.courseId] = { code: d.courseCode, name: d.courseName };
        });
        const labelOf = id => {
          const c = courseList.find(x => x.id === id);
          if (c) return `${c.course_code}${c.name ? ' — ' + c.name : ''}`;
          const m = backendMeta[id];
          if (m && m.code) return `${m.code}${m.name ? ' — ' + m.name : ''}`;
          return 'a course';
        };
        const count = lrp.droppedCount ?? (lrp.droppedSections?.length ?? (lrp.droppedCourseIds?.length ?? 0));
        const fully = lrp.fullyDroppedCourseIds ?? [];
        const tally = {};
        (lrp.droppedSections ?? (lrp.droppedCourseIds ?? []).map(id => ({ courseId: id })))
          .forEach(d => { tally[d.courseId] = (tally[d.courseId] || 0) + 1; });
        const bullets = Object.entries(tally).map(([id, n]) =>
          `${labelOf(id)} — ${fully.includes(id) ? 'removed' : `${n} section${n > 1 ? 's' : ''} dropped`}`);
        return { count, bullets };
      }

      async function autoAdjust() {
        showToast('⏳ Looking for a conflict-free arrangement…', 'info');
        // NEW-FU-432 (Phase 106 item 1): the planner no longer silently decides
        // between dropping and inventing placeholders. We dry-run BOTH directions
        // and, when both are viable (a capacity shortage), let the USER pick:
        //   Pass 1 — real resources only → if it must drop, that's the DROP plan.
        //   Pass 2 — with placeholders   → the KEEP-ALL plan.
        // Pass 1: real resources only (no placeholders).
        const real = await withSuggestBusy('Finding a conflict-free arrangement…', () => suggestSchedule(
          schedule.id, courseConfigs, applyToCourseIds, TOL, { relaxIfConflicts: true, allowDummyResources: false }
        ));
        if (real.feasible !== false) {
          // Solvable with REAL resources — no drops, no placeholders, no choice.
          if (real.relaxed) {
            const n = (real.downsized ?? []).length;
            const adjNote = n ? ` (reduced ${n} course${n > 1 ? 's' : ''} to fit)` : '';
            showToast(`✓ Conflict-free plan found${adjNote} — applying.`, 'success');
            return { proceed: true, configs: real.relaxedConfigs, allowDummy: false };
          }
          showToast('✓ Conflict-free plan found — applying.', 'success');
          return { proceed: true, configs: courseConfigs, allowDummy: false };
        }
        // Real resources can't fit everything — capture the minimal DROP plan.
        const lrp = real.lastResortPlan;
        const hasDrop = lrp && (lrp.residualConflicts ?? 0) === 0;
        // Pass 2: would PLACEHOLDERS keep every section? (capacity-bound test)
        const withDummy = await withSuggestBusy('Checking a placeholder option…', () => suggestSchedule(
          schedule.id, courseConfigs, applyToCourseIds, TOL, { relaxIfConflicts: true, allowDummyResources: true }
        ));
        const dummyWorks = withDummy.feasible !== false;
        const nDI = (withDummy.dummyInstructors ?? []).length;
        const nDV = (withDummy.dummyVenues ?? []).length;
        const addParts = [];
        if (nDI) addParts.push(`${nDI} instructor${nDI > 1 ? 's' : ''}`);
        if (nDV) addParts.push(`${nDV} venue${nDV > 1 ? 's' : ''}`);
        const addText = addParts.join(' and ') || 'placeholders';
        const dummyConfigs = withDummy.relaxed ? withDummy.relaxedConfigs : courseConfigs;

        // BOTH directions viable → the user chooses (Phase 106 item 1).
        if (hasDrop && dummyWorks) {
          const { count, bullets } = dropPlanInfo(lrp);
          const choice = await askDecision({
            icon: '🧩',
            title: 'Not enough real instructors/venues for every section',
            lead: 'Every section can stay conflict-free — you choose how:',
            bullets: [
              `Keep all courses — add ${addText} as clearly-labeled "dummy" placeholders (this term only)`,
              `Keep everything real — drop ${count} section${count > 1 ? 's' : ''}: ${bullets.join('; ')}`,
            ],
            question: 'Which direction would you like?',
            options: [
              { label: `Keep all — add ${addText}`, value: 'placeholders', tone: 'primary' },
              { label: `Keep real — drop ${count} section${count > 1 ? 's' : ''}`, value: 'drop', tone: 'danger' },
              { label: 'Cancel', value: 'cancel', tone: 'neutral' },
            ],
            dismissValue: 'cancel',
          });
          if (choice === 'cancel') { showToast('Suggest cancelled — no changes applied.', 'info'); return { proceed: false }; }
          if (choice === 'placeholders') {
            showToast(`✓ Keeping all sections with ${addText} — applying.`, 'success');
            return { proceed: true, configs: dummyConfigs, allowDummy: true };
          }
          showToast(`✓ Conflict-free plan applied (dropped ${count} section${count > 1 ? 's' : ''}).`, 'success');
          return { proceed: true, configs: lrp.keptConfigs, allowDummy: false };
        }

        // Only placeholders can save it (no viable drop plan) — advise + apply.
        if (dummyWorks) {
          await askDecision({
            icon: 'ℹ️',
            title: 'Kept every section using placeholders',
            lead: `To fit all sections conflict-free, the planner added ${addText} as clearly-labeled "dummy" placeholders (only in this term). To run this schedule for real, add:`,
            bullets: addParts,
            options: [{ label: 'Apply with placeholders', value: 'ok', tone: 'primary' }],
            dismissValue: 'ok',
          });
          showToast('✓ Conflict-free plan found — applying.', 'success');
          return { proceed: true, configs: dummyConfigs, allowDummy: true };
        }

        // Only dropping works — even placeholders can't fix it (the clash is in
        // the timing, not capacity). Existing drop dialog.
        if (hasDrop) {
          const { count, bullets } = dropPlanInfo(lrp);
          const ok = await askDecision({
            icon: <Ico name="alert" />,
            title: 'A few sections must be dropped to stay conflict-free',
            lead: `Not every section fits, and no added instructor/venue can fix it (the clash is in the timing). The conflict-free plan drops ${count} section${count > 1 ? 's' : ''}:`,
            bullets,
            question: `Drop ${count} section${count > 1 ? 's' : ''} and apply the conflict-free plan?`,
            options: [
              { label: `Drop ${count} & apply`, value: 'drop', tone: 'primary' },
              { label: 'Cancel', value: 'cancel', tone: 'neutral' },
            ],
            dismissValue: 'cancel',
          });
          if (ok === 'drop') {
            showToast(`✓ Conflict-free plan applied (dropped ${count} section${count > 1 ? 's' : ''}).`, 'success');
            return { proceed: true, configs: lrp.keptConfigs, allowDummy: false };
          }
          showToast('Suggest cancelled — no changes applied.', 'info');
          return { proceed: false };
        }

        // Genuine dead end.
        await askDecision({
          icon: '🚫',
          title: 'No conflict-free plan is possible',
          lead: 'These selections can’t be arranged without conflicts, even after trying alternative days, durations, and added placeholders. Try lowering some section counts or removing a course, then run Suggest again.',
          options: [{ label: 'OK', value: 'ok', tone: 'neutral' }],
          dismissValue: 'ok',
        });
        showToast('Suggest aborted — no conflict-free plan available.', 'error');
        return { proceed: false };
      }

      // ── Clean-first preview ─────────────────────────────────────────────
      // Dry-run the greedy (no write) to see whether the user's exact picks
      // place with zero conflicts.
      let applyAllowDummy = false; // NEW-FU-425: set when the auto-fix used placeholders
      const preview = await withSuggestBusy('Checking your selections…', () => suggestSchedule(
        schedule.id, courseConfigs, applyToCourseIds, TOL, { previewOnly: true }
      ));
      const conflictRules = preview.residualConflictRuleIds ?? [];
      let effectiveConfigs = courseConfigs;

      if (conflictRules.length > 0) {
        // Their exact picks would clash. Explain in plain language and offer
        // the two real choices.
        const choice = await askDecision({
          icon: <Ico name="alert" />,
          title: 'Your selections can’t be scheduled without conflicts',
          lead: 'Placing every course exactly as you set it would create these clashes:',
          bullets: conflictTypesPlain(conflictRules),
          question: 'How would you like to proceed?',
          options: [
            { label: 'Adjust for me — keep my picks, change the fewest needed', value: 'adjust', tone: 'primary' },
            { label: 'Keep my exact selections', value: 'keep', tone: 'danger' },
            { label: 'Cancel', value: 'cancel', tone: 'neutral' },
          ],
          dismissValue: 'cancel',
        });

        if (choice === 'cancel') {
          showToast('Suggest cancelled — no changes applied.', 'info');
          return;
        }

        if (choice === 'keep') {
          // Confirm they accept conflicts. If they back out, fall through to
          // auto-adjust (the conflict-free path) rather than aborting —
          // per the Phase-96 decision tree.
          const sure = await askDecision({
            icon: <Ico name="alert" />,
            title: 'This plan will contain conflicts',
            lead: 'Keeping your exact selections saves the schedule with these unresolved clashes:',
            bullets: conflictTypesPlain(conflictRules),
            question: 'Apply your selections anyway?',
            options: [
              { label: 'Apply anyway — keep the conflicts', value: 'apply', tone: 'danger' },
              { label: 'No — adjust it for me instead', value: 'adjust', tone: 'primary' },
              { label: 'Cancel', value: 'cancel', tone: 'neutral' },
            ],
            dismissValue: 'cancel',
          });
          if (sure === 'cancel') {
            showToast('Suggest cancelled — no changes applied.', 'info');
            return;
          }
          if (sure === 'adjust') {
            const adj = await autoAdjust();
            if (!adj.proceed) return;
            effectiveConfigs = adj.configs;
            applyAllowDummy = adj.allowDummy === true;
          }
          // sure === 'apply' → keep effectiveConfigs = courseConfigs; the
          // apply below force-places it and the conflicts surface in the grid.
        } else {
          // choice === 'adjust'
          const adj = await autoAdjust();
          if (!adj.proceed) return;
          effectiveConfigs = adj.configs;
          applyAllowDummy = adj.allowDummy === true; // NEW-FU-432: honor the chosen direction on apply
        }
      }

      // ── Apply ───────────────────────────────────────────────────────────
      // A clean/relaxed effectiveConfigs places without conflicts; the kept
      // (force-place) path surfaces the conflicts the user accepted.
      // NEW-FU-391 (Phase 100): the apply WRITE and the post-apply grid reload
      // run inside ONE busy span, so the "Applying…" overlay stays up until the
      // new schedule is actually on screen. The reload is awaited (not fire-and-
      // forget), which — now that the relaxation is bounded and the backend is no
      // longer exhausted — makes the grid update in place with NO browser refresh.
      const result = await withSuggestBusy('Applying the suggested schedule…', async () => {
        const r = await suggestSchedule(schedule.id, effectiveConfigs, applyToCourseIds, TOL, { allowDummyResources: applyAllowDummy });
        dispatch({ type:'SET_CONFLICTS', conflicts: r.conflicts ?? [] });
        // NEW-FU-56: defensive — the Suggest button is disabled in teacher/venue
        // without a filter; if we somehow reach here in that state, skip the
        // reload to avoid an FU-47 400 toast that would mask the actual success.
        if (!((view === VIEWS.TEACHER || view === VIEWS.VENUE) && !filterId)) {
          await loadView(schedule.id, view, filterId);
        }
        // NEW-FU-522 (Batch 7 Issue 2): Suggest may MINT placeholder (dummy)
        // instructors/venues. Refresh the reference lists so those dummies enter
        // `instructors`/`venues` — otherwise dummyInstrCount/dummyVenueCount stay 0
        // and the "X instructors / Y venues needed to go live" banner never shows.
        await loadReference(schedule.semester);
        // NEW-FU-585 (Batch 25): Suggest is now UNDOABLE. The snapshot+reconcile history
        // captures the whole regenerated schedule as ONE step (before = pre-Suggest baseline,
        // after = this post-Suggest snapshot), so Cmd+Z reverts the entire Suggest — instead
        // of the Batch-16 `clearHistory()` that wiped the stack and left undo dead afterwards.
        await recordMutation('Suggest');
        return r;
      });
      const hard   = (result.conflicts??[]).filter(c=>c.severity==='Hard').length;
      const soft   = (result.conflicts??[]).filter(c=>c.severity==='Soft').length;
      // NEW-L8: surface forced placements so operators know the suggester
      // had to place some sections without a conflict-free slot.
      const forced = result.forcedPlacements ?? 0;
      // NEW-FU-317 (Phase 29): when refuse-to-place fired (maxConflictsPerSection
      // strict), surface a separate warning toast listing each skipped section.
      // The user explicitly opted into "don't place if it would create
      // conflicts" mode — they need to see WHICH sections were skipped so
      // they can add resources / reduce section count and retry.
      const skipped = result.placementSkipped ?? [];
      const tone   = hard > 0 || forced > 0 ? 'error' : (soft > 0 || skipped.length > 0) ? 'warn' : 'success';
      const forcedPart  = forced > 0 ? `, ${forced} force-placed` : '';
      const skippedPart = skipped.length > 0 ? `, ${skipped.length} skipped (would create conflicts)` : '';
      showToast(`✓ Suggested — ${hard} hard, ${soft} soft conflicts${forcedPart}${skippedPart}.`, tone);
      if (skipped.length > 0) {
        // Detailed follow-up toast listing the first 3 skipped sections.
        // More than 3 → summarize with a "+N more" tail.
        const head = skipped.slice(0, 3).map(s =>
          `${s.courseCode ?? s.courseId} §${s.sectionNumber}`).join(', ');
        const tail = skipped.length > 3 ? ` (+${skipped.length - 3} more)` : '';
        showToast(`⚠ Skipped: ${head}${tail}. Add instructors / venues or lower section counts, then re-run Suggest.`, 'warn');
      }
    } catch(err) {
      // NEW-FU-484 (Phase 118): sanitize the raw error before displaying —
      // strip internal field-path strings (e.g. "courseConfig.sections")
      // that leak implementation details to the user. Replace them with
      // plain-language equivalents.
      const rawErr = err.response?.data?.error ?? err.message ?? 'Unknown error';
      const cleanErr = rawErr
        .replace(/\bcourseConfig\.sections\b/g, 'section count')
        .replace(/\bcourseConfig\.[a-zA-Z.]+\b/g, 'course setting')
        .replace(/\breq\.body\.[a-zA-Z.]+\b/g, 'input field');
      showToast('Suggest failed: ' + cleanErr, 'error');
    }
  }
  // NEW-M18: clear previous timer when a new toast arrives so rapid toasts
  // don't dismiss each other early; clear on unmount to avoid the classic
  // setState-after-unmount warning.
  const toastTimerRef = React.useRef(null);
  React.useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);
  function showToast(msg, type='info') {
    // NEW-FU-506 (Phase 123): unknown types fall back to 'info' so a typo'd
    // call can never render the unstyled transparent pill again (the exact
    // Phase 58 toast bug class — .toast has no background of its own).
    const safeType = ['success','error','info','warn'].includes(type) ? type : 'info';
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message: msg, type: safeType });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3500);
  }

  // Drag overlay content
  const activeSection = activeDrag?.type === 'section'
    ? sections.find(s => s.id === activeDrag.id) : null;
  const activeCourse  = activeDrag?.type === 'course'
    ? courses.find(c => c.id === activeDrag.id) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="scheduler-root">
        <TopBar onSave={handleSave} onSuggest={handleSuggest} onExport={handleExport} onImport={handleImport} onSwitchTerm={handleSwitchTerm} onUnlock={handleUnlock} onLogout={handleLogout} onUndo={handleUndo} onRedo={handleRedo} />

        <div className="scheduler-body">
          <SidePanel showToast={showToast} onAddSection={handleOpenAdd} onEditSection={sec => sec && setSectionModal({ mode:'edit', initial:{ section: sec } })} onQuickFix={handleQuickFix} />

          <main className="scheduler-main">
            {/* NEW-FU-203: archived-term banner. The API enforces read-only
                via 409 on every write endpoint (FU-201), but the user
                shouldn't have to click + see an error toast to learn that.
                Banner makes the state legible up front. */}
            {schedule?.archived_at && (
              <div className="scheduler-archived-banner" role="status" aria-live="polite">
                <span className="scheduler-archived-icon" aria-hidden="true"><Ico name="archive" /></span>
                <span className="scheduler-archived-msg">
                  This term is <strong>archived</strong> and is read-only.
                  Unarchive it from the term picker to make changes.
                </span>
              </div>
            )}
            {/* NEW-FU-482 (Phase 116): finalized terms are read-only too — make it legible
                up front (the controls are disabled) instead of only after a rejected click. */}
            {!schedule?.archived_at && schedule?.status === 'Finalized' && (
              <div className="scheduler-archived-banner" role="status" aria-live="polite">
                <span className="scheduler-archived-icon" aria-hidden="true"><Ico name="lock" /></span>
                <span className="scheduler-archived-msg">
                  This term is <strong>finalized</strong> and is read-only.
                  Click the <strong>Locked</strong> button in the top bar to unlock it and make changes.
                </span>
              </div>
            )}
            <div className="view-label">
              {/* NEW-FU-70: decouple label from filterId. The prior code
                  showed "Course View" any time filterId was null, even
                  when view was TEACHER/VENUE — and then appended a hint
                  saying "select a teacher from the sidebar" right after,
                  producing a contradictory header. Now the label always
                  reflects the active view; the hint adds the filter-pick
                  prompt when applicable. */}
              {/* NEW-FU-503 (Phase 123): SVG icons; span keeps icon+text one flex item. */}
              {view === VIEWS.TEACHER ? <span><Ico name="user" /> Instructor View</span>
                : view === VIEWS.VENUE ? <span><Ico name="pin" /> Venue View</span>
                : <span><Ico name="clipboard" /> Course View</span>}
              {(view === VIEWS.TEACHER || view === VIEWS.VENUE) && !filterId && (
                <span className="view-hint"> — select a{view === VIEWS.TEACHER ? 'n instructor' : ' venue'} from the sidebar</span>
              )}
              {/* NEW-FU-480 (Phase 115): tell the secretary how many real instructors/venues
                  to register — placeholders ("dummies") still stand in for missing ones. */}
              {view === VIEWS.COURSE && (dummyInstrCount > 0 || dummyVenueCount > 0) && (
                <span className="view-dummy-advisory" role="status"
                  style={{ marginLeft: 14, fontSize: '.78rem', fontWeight: 600,
                    borderRadius: 8, padding: '3px 10px' }}>
                  <Ico name="info" /> To finalize this schedule, add{dummyInstrCount > 0 ? ` ${dummyInstrCount} more instructor${dummyInstrCount === 1 ? '' : 's'}` : ''}{dummyInstrCount > 0 && dummyVenueCount > 0 ? ' and' : ''}{dummyVenueCount > 0 ? ` ${dummyVenueCount} more venue${dummyVenueCount === 1 ? '' : 's'}` : ''}.
                </span>
              )}
              {/* NEW-FU-483 (Phase 117): hint text adapts to lock state — dragging and editing are
                  both disabled on finalized/archived terms, so the hint must not suggest them. */}
              <span className="view-hint" style={{ marginLeft:'auto', fontSize:'.73rem' }}>
                {scheduleLocked
                  ? 'This term is read-only'
                  : 'Click a block to edit · Drag a course card to add a section'}
              </span>
              {/* NEW-FU-217 (Phase 91): Overview / Readable view-mode toggle. Overview
                  fits the whole week in the window (dense cards shrink); Readable keeps
                  every card legible and scrolls. Segmented control — the active mode is
                  highlighted; click the other to switch.
                  NEW-FU-221 (Phase 95): shown ONLY in Course View. Instructor & Venue
                  views never have overlapping cards (an instructor/venue can't hold two
                  classes at once), so Readable mode is meaningless there — the toggle is
                  hidden and those views always use the overview layout (forced below). */}
              {view === VIEWS.COURSE && (
                <div className="sg-view-toggle" role="group" aria-label="Schedule view mode">
                  <button
                    type="button"
                    className={`sg-vt-btn${viewMode === 'overview' ? ' active' : ''}`}
                    aria-pressed={viewMode === 'overview'}
                    title="Fit the whole week in the window (dense cards shrink)"
                    onClick={() => setViewMode('overview')}
                  >Overview mode</button>
                  <button
                    type="button"
                    className={`sg-vt-btn${viewMode === 'readable' ? ' active' : ''}`}
                    aria-pressed={viewMode === 'readable'}
                    title="Keep every card legible — scroll to see the whole week"
                    onClick={() => setViewMode('readable')}
                  >Readable mode</button>
                </div>
              )}
            </div>

            <div className="grid-scroll-container" data-export-target="schedule-grid">
              {/* NEW-FU-221 (Phase 95): Course View honours the persisted Overview/Readable
                  choice; Instructor & Venue views always force the overview LAYOUT (no
                  overlaps there → Readable is meaningless, and its persisted value must not
                  leak in). uniformType drives UNIFORM TYPOGRAPHY (same duration ⇒ identical
                  fonts) for Instructor/Venue regardless of layout — the Phase-95 decoupling
                  of uniform fonts from the readable layout. */}
              <motion.div
                key={view + '|' + (filterId ?? '')}
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              >
                <ScheduleGrid
                  onBlockClick={handleBlockClick}
                  onOHClick={handleOHClick}
                  onSectionDelete={handleSectionDelete}
                  viewMode={view === VIEWS.COURSE ? viewMode : 'overview'}
                  uniformType={view !== VIEWS.COURSE}
                />
              </motion.div>
            </div>
          </main>
        </div>

        {showSoftModal && (
          <SoftConflictModal
            conflicts={softPending}
            // NEW-FU-78: pass a *signature* per soft conflict the user is
            // reviewing — NOT the persisted DB id. Saves trigger
            // ConflictRepository.replaceAll which DELETE+INSERTs every
            // conflict row with fresh ids, so any id captured at modal-open
            // time is guaranteed stale by save-tx commit. Signatures are
            // content-derived (`ruleId|sectionAId|sectionBId|description`)
            // and stable across saves for the same logical violation, so
            // backend signature-matching correctly identifies which softs
            // were seen vs new.
            onConfirm={() => doSave(
              softPending.map(c =>
                `${c.ruleId}|${c.sectionAId ?? ''}|${c.sectionBId ?? ''}|${c.description ?? ''}`
              )
            )}
            onCancel={() => setShowSoftModal(false)}
          />
        )}

        {sectionModal && (
          <SectionModal
            mode={sectionModal.mode}
            initial={sectionModal.initial}
            onClose={handleModalClose}
            showToast={showToast}
          />
        )}

        {ohModal && (
          <OfficeHourModal
            officeHour={ohModal.officeHour}
            instructorId={ohModal.instructorId}
            onClose={() => setOhModal(null)}
            onSaved={() => schedule && loadView(schedule.id, view, filterId)}
            showToast={showToast}
          />
        )}

        {showSuggest && (
        <SuggestModal
          scheduleId={schedule?.id}
          onConfirm={runSuggest}
          onClose={() => setShowSuggest(false)}
        />
      )}

      {/* NEW-FU-223 (Phase 96): in-app decision dialog for the clean-first
          Suggest flow. Driven imperatively via askDecision — onChoose /
          onDismiss clear the dialog and resolve the awaiting promise. */}
      {decision && (
        <DecisionModal
          icon={decision.icon}
          title={decision.title}
          lead={decision.lead}
          bullets={decision.bullets}
          question={decision.question}
          options={decision.options}
          onChoose={(value) => { const r = decision.resolve; setDecision(null); r?.(value); }}
          onDismiss={() => { const r = decision.resolve; setDecision(null); r?.(decision.dismissValue ?? 'cancel'); }}
        />
      )}

      {/* NEW-FU-391 (Phase 100): blocking "applying…" overlay shown during the
          Suggest compute phases (preview / relaxation / apply + grid reload).
          It signals progress and prevents the user from interacting or giving
          up and refreshing mid-apply. Never overlaps a decision dialog —
          withSuggestBusy brackets only the compute, not askDecision. */}
      {suggestBusy && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', inset: 0, zIndex: 4000,
          background: 'rgba(15,31,61,0.45)', backdropFilter: 'blur(1.5px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <style>{`@keyframes suggest-busy-spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{
            background: 'var(--bg-elevated)', borderRadius: 14, padding: '26px 34px', minWidth: 260,
            border: '1px solid var(--border-subtle)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
          }}>
            <div style={{
              width: 34, height: 34, borderRadius: '50%',
              border: '3px solid var(--border-strong)', borderTopColor: 'var(--teal-500)',
              animation: 'suggest-busy-spin 0.8s linear infinite',
            }} />
            <div style={{ fontWeight: 600, color: 'var(--fg)', fontSize: 14.5, textAlign: 'center' }}>
              {suggestBusy.message}
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Please wait — don’t refresh.</div>
          </div>
        </div>
      )}

      {/* NEW-FU-319 (Phase 29): Quick Fix preview modal. Fetches a plan
          of remediation ops, lets the user opt out of any, then applies
          the selected subset atomically. On apply we reload the view so
          the resolved sections show their new instructor/venue/days and
          the conflict list updates. */}
      {showQuickFix && schedule && (
        <QuickFixModal
          scheduleId={schedule.id}
          showToast={showToast}
          onClose={() => setShowQuickFix(false)}
          onApplied={async () => {
            await loadView(schedule.id, view, filterId);
            // NEW-FU-522 (Batch 7 Issue 2): Quick Fix add-dummy ops mint placeholder
            // instructors/venues — refresh the reference lists so the "needed to go
            // live" banner reflects them (parity with the Suggest apply path).
            await loadReference(schedule.semester);
            recordMutation('Quick Fix');   // NEW-FU-549: whole grid fix = one undo step
          }}
        />
      )}

      {groupChangeModal && (
        <GroupChangeModal
          sec={groupChangeModal.sec}
          newDay={groupChangeModal.newDay}
          newStartTime={groupChangeModal.newStartTime}
          actualSiblingCount={groupChangeModal.actualSiblingCount}
          onConfirm={confirmGroupChange}
          onCancel={() => setGroupChangeModal(null)}
        />
      )}

      {showExport && (
          <ExportModal
            onExport={doExport}
            onExportImage={doExportImage}
            onClose={() => setShowExport(false)}
            showToast={showToast}
            initialTab={exportInitialTab}
          />
        )}

        {toast && (
          <div className={`toast toast-${toast.type}`} role="alert">{toast.message}</div>
        )}
      </div>

      <DragOverlay>
        {activeSection && (
          <div style={{
            // NEW-FU-561 (audit P2-14): pin an explicit dark text color. Without it the
            // chip inherited --text-primary (near-white in dark mode) on this pale-blue
            // bg → ~1.02:1, invisible. Theme-independent, matches the course-overlay below.
            background:'#e0f2fe', border:'2px solid #0284c7', color:'#0c4a6e',
            borderRadius:6, padding:'6px 10px',
            fontFamily:'var(--font-mono)', fontSize:'.78rem', fontWeight:600,
            boxShadow:'0 4px 16px rgba(0,0,0,.2)',
          }}>
            {activeSection.courseCode ?? activeSection.course_code} §{activeSection.sectionNumber ?? activeSection.section_number}
          </div>
        )}
        {activeCourse && (
          <div style={{
            background: LEVEL_COLORS[activeCourse.academic_level]?.bg ?? '#e0f2fe',
            border: `2px dashed ${LEVEL_COLORS[activeCourse.academic_level]?.border ?? '#0284c7'}`,
            color: LEVEL_COLORS[activeCourse.academic_level]?.text ?? '#0c4a6e',
            borderRadius:6, padding:'6px 10px',
            fontFamily:'var(--font-mono)', fontSize:'.78rem', fontWeight:600,
            boxShadow:'0 4px 16px rgba(0,0,0,.2)',
          }}>
            {activeCourse.course_code} → drop on grid
          </div>
        )}
        {activeDrag?.type === 'officeHour' && (
          <div style={{
            background:'#f3f4f6', border:'2px dashed #6b7280',
            borderRadius:6, padding:'6px 10px',
            fontSize:'.78rem', fontStyle:'italic', color:'#6b7280',
            boxShadow:'0 4px 16px rgba(0,0,0,.2)',
          }}>
            Office Hours → drop to move
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function timeToMin(t) {
  if (!t) return 0;
  const [h,m] = t.substring(0,5).split(':').map(Number);
  return (h||0)*60+(m||0);
}
