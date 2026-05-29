import React, { useEffect, useState } from 'react';
import {
  DndContext, PointerSensor, useSensor, useSensors, DragOverlay, closestCenter,
} from '@dnd-kit/core';
import { useApp, VIEWS, DAY_DURATION, LEVEL_COLORS, fromMinutes } from '../context/AppContext.jsx';

const DAY_GROUPS = {
  Sunday:'STT', Tuesday:'STT', Thursday:'STT',
  Monday:'MW',  Wednesday:'MW',
};
const GROUP_DAYS = { STT:['Sunday','Tuesday','Thursday'], MW:['Monday','Wednesday'] };
const GROUP_LABELS = { STT:'Sun / Tue / Thu (3 days, 50 min)', MW:'Mon / Wed (2 days, 75 min)', single:'Single day' };
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
import QuickFixModal    from '../components/modals/QuickFixModal.jsx';
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
          sections, courses, venues, error, dispatch } = useApp();

  const [showSoftModal, setShowSoftModal] = useState(false);
  const [toast,         setToast]         = useState(null);
  const [sectionModal,  setSectionModal]  = useState(null);
  const [ohModal,       setOhModal]       = useState(null);
  const [showExport,    setShowExport]    = useState(false);
  const [showSuggest,   setShowSuggest]   = useState(false);
  // NEW-FU-319 (Phase 29): Quick Fix preview modal. Opened from the
  // SidePanel's "Quick Fix conflicts" button when conflicts.length > 0.
  // The modal fetches the plan internally and applies the selected ops;
  // we only need to provide a refresh hook (reload conflicts/sections)
  // and a toast surface for success/failure messaging.
  const [showQuickFix,  setShowQuickFix]  = useState(false);
  const [groupChangeModal, setGroupChangeModal] = useState(null); // { sec, newDay, newStartTime, duration }
  const [activeDrag,    setActiveDrag]    = useState(null); // { type:'section'|'course', id }

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

  // NEW-FU-47b: skip loadView entirely when the view is teacher/venue but
  // no filter has been selected yet. The backend now rejects these requests
  // with a precise 400 (FU-47 stricter validation) — without this gate,
  // every transient "I've switched view but not picked anyone yet" state
  // would fire an error toast. Pre-FU-47 the backend silently returned all
  // sections, which masked the bug. Now we explicitly do nothing until the
  // user picks a filter — and the view label already says "select a {view}
  // from the sidebar".
  useEffect(() => {
    if (!schedule) return;
    if ((view === VIEWS.TEACHER || view === VIEWS.VENUE) && !filterId) return;
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
    const NAME_RE = /^\d{2}-(\d{3}(-[A-Z0-9])?|\d{4})$/;
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

  async function handleDragEnd(e) {
    const prev = activeDrag;
    setActiveDrag(null);
    const { active, over } = e;
    if (!over || !active) return;
    // NEW-FU-207: defensive no-op on archived view. The block-level
    // useDraggable is already disabled by SectionBlock / DraggableCourse
    // when archived, so this should be unreachable — but if someone routes
    // a drag through some other path, the handler refuses to mutate.
    if (schedule?.archived_at) return;

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
        if (day === sec.day && startTime === origStart.substring(0,5)) return;

        const origGroup = DAY_GROUPS[sec.day] ?? 'single';
        const newGroup  = DAY_GROUPS[day]     ?? 'single';

        // If dropped onto a different day group → show confirmation first
        if (origGroup !== newGroup && origGroup !== 'single') {
          // NEW-FU-73: compute the actual sibling count from current state
          // so the modal's "delete all N day-sections" copy reflects reality
          // rather than the group constant (3 for STT, 2 for MW).
          const courseId = sec.courseId ?? sec.course_id;
          const secNumber = sec.sectionNumber ?? sec.section_number;
          const actualSiblingCount = sections.filter(s =>
            (s.courseId ?? s.course_id) === courseId &&
            (s.sectionNumber ?? s.section_number) === secNumber
          ).length;
          setGroupChangeModal({ sec, newDay: day, newStartTime: startTime, duration, actualSiblingCount });
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

        await moveSection(sec.id, {
          instructorId: sec.instructorId ?? sec.instructor_id,
          venueId:      sec.venueId      ?? sec.venue_id,
          day: effectiveDay,
          startTime,
          endTime: fromMinutes(timeToMin(startTime) + duration),
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

    const newGroup   = DAY_GROUPS[newDay] ?? 'single';
    const newDays    = newGroup !== 'single' ? GROUP_DAYS[newGroup] : [newDay];
    const newEndTime = fromMinutes(timeToMin(newStartTime) + duration);

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
        days:          newDays,
        day:           newDays[0],
        startTime:     newStartTime,
        endTime:       newEndTime,
      });
      await deleteSection(sec.id);
      showToast(`✓ Section moved to ${GROUP_LABELS[newGroup] ?? newDay}.`, 'success');
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
      showToast(r.saved ? '✓ Schedule saved.' : 'Conflicts remain.', r.saved ? 'success' : 'error');
    } catch { showToast('Save failed.', 'error'); }
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  function handleExport() {
    if (!schedule) return;
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
    // NEW-FU-207: no-op on archived view. The banner already explains why.
    if (schedule?.archived_at) return;
    setSectionModal({ mode: 'edit', initial: { section } });
  }

  // NEW-FU-272/273: grid-block quick-delete handler.
  //   scope='row'   → DELETE just this meeting day (calls /sections/:id?scope=row)
  //   scope='group' → DELETE the whole section group (default endpoint behavior)
  // Confirmation prompts differ by scope:
  //   • per-day: light prompt, low-risk action ("delete this meeting day?")
  //   • group:   stronger prompt naming the course + section
  // After success we reload the view so the deleted block (and any new
  // R-15 conflict on the surviving group) appear.
  async function handleSectionDelete(section, scope) {
    if (!schedule || schedule.archived_at) return;
    const courseCode = section.courseCode ?? section.course_code ?? '';
    const secNum     = section.sectionNumber ?? section.section_number ?? '';
    const day        = section.day ?? '';
    const prompt = scope === 'row'
      ? `Delete the ${day} meeting of ${courseCode} §${secNum}? Other meeting days of this section will remain.`
      : `Delete ALL meeting days of ${courseCode} §${secNum}? This removes the entire section.`;
    if (!window.confirm(prompt)) return;
    try {
      const { deleteSection, deleteSectionRow } = await import('../api/index.js');
      if (scope === 'row') await deleteSectionRow(section.id);
      else                 await deleteSection(section.id);
      // NEW-FU-299/FU-300 (Phase 26): toast text explicitly names which
      // SCOPE happened. Prior text was ambiguous ("Removed Tuesday meeting"
      // vs "Removed SWE201 §01") and the user couldn't tell at a glance
      // whether they'd just deleted one day or the whole group. Now the
      // toast names BOTH the scope and the target so future delete-scope
      // regressions are visible without opening DevTools.
      const toast = scope === 'row'
        ? `✓ Removed ${day} meeting of ${courseCode} §${secNum} (other days remain).`
        : `✓ Removed entire section ${courseCode} §${secNum} (all meeting days).`;
      showToast(toast, 'success');
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
  function handleOpenAdd()            { setSectionModal({ mode: 'add',  initial: {} }); }
  function handleSuggest() {
    if (!schedule) return;
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
  async function runSuggest(courseConfigs, applyToCourseIds, maxConflictsPerSection) {
    setShowSuggest(false);
    showToast('⏳ Calculating best schedule…', 'info');
    try {
      const { suggestSchedule } = await import('../api/index.js');
      // NEW-FU-361 (Phase 35): preview first. The backend runs the
      // greedy without writing and returns residualConflictRuleIds.
      // If non-empty we ask the user to confirm before persisting.
      const preview = await suggestSchedule(
        schedule.id, courseConfigs, applyToCourseIds,
        maxConflictsPerSection, { previewOnly: true }
      );
      const conflictRules = preview.residualConflictRuleIds ?? [];
      let effectiveConfigs = courseConfigs;
      if (conflictRules.length > 0) {
        // NEW-FU-363 (Phase 35): three-way decision when the chosen config
        // would create conflicts. Default = let Suggest find an alternative;
        // override = apply with conflicts; abort = cancel. We sequence two
        // window.confirm calls so the dialog stays native + a11y-friendly
        // without dragging in a new modal component.
        const tryRelax = window.confirm(
          `Your choices would create ${conflictRules.length} conflict type(s) ` +
          `(${conflictRules.join(', ')}).\n\n` +
          `OK   = let Suggest try alternative duration / day-pattern combos.\n` +
          `Cancel = decide what to do next.`
        );
        if (tryRelax) {
          showToast('⏳ Searching for a conflict-free alternative…', 'info');
          // suggestSchedule returns the relaxed preview when relaxIfConflicts
          // is on. Phase 36 contract: response is EITHER a zero-conflict
          // plan with `feasible: true`, OR `feasible: false` with
          // `suggestedRemovals` — we MUST NOT persist anything in the
          // latter case.
          const relaxed = await suggestSchedule(
            schedule.id, courseConfigs, applyToCourseIds,
            maxConflictsPerSection, { relaxIfConflicts: true }
          );
          let lastResortAccepted = false;
          if (relaxed.feasible === false) {
            // NEW-FU-398 (Phase 39): if the backend's Pass E computed a
            // last-resort plan (drop N courses and the rest fits
            // cleanly), offer it as an opt-in confirm BEFORE aborting.
            const lrp = relaxed.lastResortPlan;
            if (lrp && (lrp.residualConflicts ?? 0) === 0) {
              const courseList = (typeof courses !== 'undefined' && courses) || [];
              const droppedLabels = lrp.droppedCourseIds.map(id => {
                const c = courseList.find(x => x.id === id);
                return c ? `${c.course_code} (${c.name ?? ''})`.trim() : id;
              });
              const ok = window.confirm(
                `No conflict-free plan exists with all courses included.\n\n` +
                `${relaxed.reason ?? ''}\n\n` +
                `Last-resort plan available:\n` +
                `  • Drop ${lrp.droppedCourseIds.length} course(s):\n      ${droppedLabels.join('\n      ')}\n` +
                `  • Remaining ${lrp.keptConfigs.length} course(s) fit with 0 conflicts.\n\n` +
                `OK = drop those courses and apply the conflict-free plan.\n` +
                `Cancel = abort and keep the current schedule.`
              );
              if (ok) {
                effectiveConfigs = lrp.keptConfigs;
                lastResortAccepted = true;
                const dropped = lrp.droppedCourseIds.length;
                showToast(`✓ Applying last-resort plan (dropped ${dropped} course(s) to clear conflicts).`, 'success');
              } else {
                showToast('Suggest aborted — no changes applied.', 'info');
                return;
              }
            } else {
              // No last-resort plan available either — true dead end.
              const removals = (relaxed.suggestedRemovals ?? [])
                .map(r => r.courseId).join(', ');
              const msg =
                `No conflict-free plan exists for the chosen courses.\n\n` +
                (relaxed.reason ?? '') +
                (removals ? `\n\nCourses to consider removing:\n  ${removals}` : '') +
                `\n\nOK = abort and keep current schedule.\n` +
                `(Use the SuggestModal to adjust which courses are included.)`;
              window.alert(msg);
              showToast('Suggest aborted — no conflict-free plan available.', 'error');
              return;
            }
          }
          if (!lastResortAccepted) {
            if ((relaxed.residualConflicts ?? 0) === 0 && relaxed.relaxed) {
              effectiveConfigs = relaxed.relaxedConfigs;
              const downsizedNote = (relaxed.downsized ?? []).length
                ? ` (down-sized ${relaxed.downsized.length} course(s) to fit)`
                : '';
              showToast(`✓ Found a conflict-free alternative${downsizedNote} — applying.`, 'success');
            } else if ((relaxed.residualConflicts ?? 0) === 0) {
              showToast('✓ Conflict-free on retry — applying.', 'success');
            } else {
              window.alert(
                `Suggest could not find a conflict-free plan ` +
                `(best had ${relaxed.residualConflicts} residual conflicts). ` +
                `No changes applied.`
              );
              showToast('Suggest aborted — no conflict-free plan.', 'error');
              return;
            }
          }
        } else {
          const applyAsIs = window.confirm(
            `Apply the original plan WITH ${conflictRules.length} conflict type(s)?\n\n` +
            `OK   = apply as-is, conflicts will appear in the schedule.\n` +
            `Cancel = abort, no changes.`
          );
          if (!applyAsIs) {
            showToast('Suggest cancelled — no changes applied.', 'info');
            return;
          }
        }
      }
      const result = await suggestSchedule(schedule.id, effectiveConfigs, applyToCourseIds, maxConflictsPerSection);
      dispatch({ type:'SET_CONFLICTS', conflicts: result.conflicts ?? [] });
      // NEW-FU-56: defensive — the Suggest button is now disabled in
      // teacher/venue without a filter, but if the user somehow reaches
      // this code path with that state, skip the post-run loadView to
      // avoid an FU-47 400 toast that would mask the actual success.
      if (!((view === VIEWS.TEACHER || view === VIEWS.VENUE) && !filterId)) {
        await loadView(schedule.id, view, filterId);
      }
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
      showToast('Suggest failed: ' + (err.response?.data?.error ?? err.message), 'error');
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
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message: msg, type });
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
        <TopBar onSave={handleSave} onSuggest={handleSuggest} onExport={handleExport} onSwitchTerm={handleSwitchTerm} />

        <div className="scheduler-body">
          <SidePanel showToast={showToast} onAddSection={handleOpenAdd} onEditSection={sec => sec && setSectionModal({ mode:'edit', initial:{ section: sec } })} onQuickFix={handleQuickFix} />

          <main className="scheduler-main">
            {/* NEW-FU-203: archived-term banner. The API enforces read-only
                via 409 on every write endpoint (FU-201), but the user
                shouldn't have to click + see an error toast to learn that.
                Banner makes the state legible up front. */}
            {schedule?.archived_at && (
              <div className="scheduler-archived-banner" role="status" aria-live="polite">
                <span className="scheduler-archived-icon" aria-hidden="true">📦</span>
                <span className="scheduler-archived-msg">
                  This term is <strong>archived</strong> and is read-only.
                  Unarchive it from the term picker to make changes.
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
              {view === VIEWS.TEACHER ? '👤 Instructor View'
                : view === VIEWS.VENUE ? '🏛 Venue View'
                : '📋 Course View'}
              {(view === VIEWS.TEACHER || view === VIEWS.VENUE) && !filterId && (
                <span className="view-hint"> — select a{view === VIEWS.TEACHER ? 'n instructor' : ' venue'} from the sidebar</span>
              )}
              <span className="view-hint" style={{ marginLeft:'auto', fontSize:'.73rem' }}>
                Click a block to edit · Drag a course card to add a section
              </span>
            </div>

            <div className="grid-scroll-container" data-export-target="schedule-grid">
              <ScheduleGrid
                onBlockClick={handleBlockClick}
                onOHClick={handleOHClick}
                onSectionDelete={handleSectionDelete}
              />
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
          onApplied={() => loadView(schedule.id, view, filterId)}
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
          />
        )}

        {toast && (
          <div className={`toast toast-${toast.type}`} role="alert">{toast.message}</div>
        )}
      </div>

      <DragOverlay>
        {activeSection && (
          <div style={{
            background:'#e0f2fe', border:'2px solid #0284c7',
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
