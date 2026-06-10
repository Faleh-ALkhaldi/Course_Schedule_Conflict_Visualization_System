import React, { useState } from 'react';
// NEW-FU-503 (Phase 123): shared SVG icons replace emoji glyphs.
import Ico from '../shared/Icons.jsx';
import { useDraggable } from '@dnd-kit/core';
import { useApp, VIEWS, LEVEL_COLORS, DAYS, DAY_DURATION, sectionLabel } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
import AddCourseModal     from '../modals/AddCourseModal.jsx';
import AddInstructorModal from '../modals/AddInstructorModal.jsx';
import AddVenueModal      from '../modals/AddVenueModal.jsx';
// NEW-FU-295 (Phase 59): per-element font auto-fit so the visible card
// text never crosses the ellipsis threshold. Wraps the same hook the
// grid uses (SectionBlock).
import { useFitText } from '../../hooks/useFitText.js';
// NEW-FU-298 (Phase 60): content-aware rendering. Picks "KHALID\nALJASSER"
// or "K. ALJASSER" etc. based on the sidebar row's measured width.
import { useRenderStrategy } from '../../hooks/useRenderStrategy.js';
import './SidePanel.css';

const LEVEL_ORDER = ['Freshman','Sophomore','Junior','Senior','Graduate'];

export default function SidePanel({ showToast, onAddSection, onEditSection, onQuickFix }) {
  const {
    view, filterId, schedule,
    courses, instructors, venues,
    sections, officeHours, conflicts,
    switchView, loadView,
    addSection, removeSection,
    // NEW-FU-280 (Phase 56): addInstructor / addVenue / addCourse are no
    // longer destructured here — each lives inside its dedicated modal,
    // which calls useApp() on its own. Only the remove* helpers stay,
    // since the × buttons in this sidebar still drive deletions.
    removeInstructor,
    removeVenue,
    removeCourse,
  } = useApp();

  // NEW-FU-205: archived-view UI lockdown. When the active schedule is
  // archived, every mutation affordance in the sidebar must be disabled.
  // Sections + suggest + save already 409 server-side (FU-201). The global
  // resources (courses/instructors/venues/OH) wouldn't 409 because they're
  // not per-term, so this UI guard is the only thing that prevents the
  // confusing "I'm adding to an archived term, why does it show up
  // everywhere else?" experience.
  // NEW-FU-482 (Phase 116): lock on EITHER archived OR finalized — the backend refuses
  // writes in both (assertSchedulerEditableLocked), so every mutating control here must be
  // disabled up front in both states, not only when archived.
  const isFinalized = schedule?.status === 'Finalized';
  const isArchived  = Boolean(schedule?.archived_at) || isFinalized;
  const lockedTitle = isFinalized
    ? 'Term is finalized — unlock it first (Save button → Unlock) to make changes.'
    : 'Term is archived — unarchive to make changes.';

  const [collapsed, setCollapsed] = useState(false);
  const [openForm, setOpenForm] = useState(null); // 'section'|'instructor'|'venue'|'course'
  const [expandedConflict, setExpandedConflict] = useState(null); // index of expanded conflict
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  // NEW-FU-281: per-fix-button busy flag so the user can't double-click an
  // in-flight quick-fix. Keyed by `${sectionId}|${addDays.join(',')}` so
  // multiple fixes on the same conflict are independent.
  const [fixBusy, setFixBusy] = useState(null);

  // NEW-FU-281 + FU-293 (Phase 25): apply a quick-fix proposal of any
  // kind. The fix.kind field discriminates: 'add-days' (R-15 → extend
  // section), 'reassign-instructor' (R-04), 'reassign-venue' (R-05).
  // All converge on the same UX: optimistic disable → API call → reload
  // view → success toast. On failure the conflict stays put and the
  // user sees a precise error from the server.
  //
  // The reassign branches call api.updateSection with infoOnly=true,
  // which is the existing endpoint for instructor/venue swaps — no
  // new backend route needed. infoOnly skips the time-change
  // validation path; the section keeps its day/start/end and just
  // gets a new instructor or venue.
  async function applyFix(fix) {
    if (isArchived) return;
    // NEW-FU-293: per-fix busy key — was joined on addDays before, but
    // R-04/R-05 fixes don't carry addDays. Use a kind-discriminated key.
    const key = `${fix.sectionId}|${fix.kind}|${fix.instructorId ?? fix.venueId ?? (fix.addDays ?? []).join(',')}`;
    if (fixBusy === key) return;
    setFixBusy(key);
    try {
      let toastMessage;
      if (fix.kind === 'add-days') {
        await api.extendSection(fix.sectionId, fix.addDays);
        toastMessage = fix.addDays.length === 1
          ? `Added ${fix.addDays[0]} meeting.`
          : `Added ${fix.addDays.length} meetings.`;
      } else if (fix.kind === 'reassign-instructor') {
        await api.updateSection(fix.sectionId, {
          instructorId: fix.instructorId,
          infoOnly: true,
        });
        toastMessage = `Reassigned to ${fix.instructorName}.`;
      } else if (fix.kind === 'reassign-venue') {
        await api.updateSection(fix.sectionId, {
          venueId: fix.venueId,
          infoOnly: true,
        });
        toastMessage = `Reassigned to ${fix.venueName}.`;
      } else {
        // Unknown kind — defensive guard. Future fix types fall here
        // until applyFix learns them. The toast surfaces the gap.
        throw new Error(`Unknown fix kind: ${fix.kind}`);
      }
      showToast(`✓ ${toastMessage}`, 'success');
      if (schedule) await loadView(schedule.id, view, filterId);
    } catch (err) {
      showToast('Fix failed: ' + (err.response?.data?.error ?? err.message), 'error');
    } finally {
      setFixBusy(null);
    }
  }

  // ── Section form state ────────────────────────────────────────────────────
  const [secForm, setSecForm] = useState({
    courseId:'', instructorId:'', venueId:'',
    sectionNumber:'', day:'Sunday', startTime:'08:00', duration:'50',
  });

  // ── Office Hours form (still inline — scoped to a selected instructor) ────
  // NEW-FU-280 (Phase 56): instrForm + venueForm + courseForm + their
  // handlers all moved into dedicated modal components
  // (AddInstructorModal / AddVenueModal / AddCourseModal). The OH form
  // stays inline because it only appears when a specific instructor is
  // filtered — a narrow, contextual form, not a top-level "add entity"
  // flow.
  const [ohForm,    setOhForm]    = useState({ day:'Sunday', startTime:'10:00', endTime:'11:00' });
  const [ohList,    setOhList]    = useState([]);
  const [ohLoading, setOhLoading] = useState(false);

  // Load office hours when an instructor is selected
  React.useEffect(() => {
    if (view === VIEWS.TEACHER && filterId) {
      setOhLoading(true);
      api.getInstructorOfficeHours(filterId)
        .then(data => setOhList(Array.isArray(data) ? data : []))
        .catch(() => setOhList([]))
        .finally(() => setOhLoading(false));
    } else {
      setOhList([]);
    }
  }, [filterId, view]);

  // NEW-FU-496 (Phase 120): office hours are 08:00–16:00. clampOH keeps the
  // inputs inside the window (runtime prevention); handleAddOH checks the window
  // FIRST (priority + named) then ordering, so the secretary is never left guessing.
  const OH_MIN = '08:00', OH_MAX = '16:00';
  const clampOH = v => !v ? v : (v < OH_MIN ? OH_MIN : v > OH_MAX ? OH_MAX : v);
  const ohOutOfWindow = t => t && (t < OH_MIN || t > OH_MAX);

  async function handleAddOH(e) {
    e.preventDefault();
    if (!filterId) return;
    // NEW-FU-496 (Phase 120): window check first (names 8:00 AM–4:00 PM), then order.
    if (ohOutOfWindow(ohForm.startTime) || ohOutOfWindow(ohForm.endTime)) {
      setFormError('Office hours can only be between 8:00 AM and 4:00 PM.');
      return;
    }
    if (ohForm.endTime <= ohForm.startTime) {
      setFormError('End time must be after start time (office hours are 8:00 AM–4:00 PM).');
      return;
    }
    setBusy(true); setFormError('');
    try {
      const oh = await api.addInstructorOfficeHour(filterId, ohForm);
      setOhList(prev => [...prev, oh]);
      setOhForm({ day:'Sunday', startTime:'10:00', endTime:'11:00' });
      setOpenForm(null);
      // Reload view to show new office hour block on grid
      if (schedule) loadView(schedule.id, view, filterId);
    } catch(err) {
      setFormError(err.response?.data?.error || 'Failed to add office hour.');
    } finally { setBusy(false); }
  }

  async function handleDeleteOH(ohId) {
    if (!filterId) return;
    // NEW-FU-45: confirm before deleting, matching the existing
    // instructor / venue / course / section delete UX. A single click on
    // the small "×" used to nuke an office hour with no undo.
    const oh = ohList.find(o => o.id === ohId);
    const label = oh
      ? `${oh.day} ${(oh.start_time ?? oh.startTime ?? '').substring(0,5)}–${(oh.end_time ?? oh.endTime ?? '').substring(0,5)}`
      : 'this office hour';
    if (!window.confirm(`Delete the ${label} office hour?`)) return;
    try {
      await api.deleteInstructorOfficeHour(filterId, ohId);
      setOhList(prev => prev.filter(o => o.id !== ohId));
      if (schedule) loadView(schedule.id, view, filterId);
    } catch (err) {
      showToast && showToast(
        err.response?.data?.error || 'Failed to delete office hours.',
        'error',
      );
    }
  }

  function selectFilter(id) {
    if (!schedule) return;
    const newId = filterId === id ? null : id;
    // H-7: switchView updates filterId in context which triggers the useEffect
    // in SchedulerPage — calling loadView here too causes a double-fetch race.
    switchView(view, newId);
  }

  // compute end time from start + duration
  function computeEndTime(startTime, duration) {
    const [h, m] = startTime.split(':').map(Number);
    const total = h * 60 + m + parseInt(duration || 0);
    return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;
  }

  async function handleAddSection(e) {
    e.preventDefault();
    if (!schedule) return;
    setBusy(true); setFormError('');
    try {
      const endTime = computeEndTime(secForm.startTime, secForm.duration);
      await addSection(schedule.id, {
        courseId:      secForm.courseId,
        instructorId:  secForm.instructorId || undefined,
        venueId:       secForm.venueId      || undefined,
        sectionNumber: secForm.sectionNumber,
        day:           secForm.day,
        startTime:     secForm.startTime,
        endTime,
      });
      setOpenForm(null);
      setSecForm({ courseId:'', instructorId:'', venueId:'', sectionNumber:'', day:'Sunday', startTime:'08:00', duration:'50' });
    } catch(err) {
      setFormError(err.response?.data?.error || 'Failed to add section.');
    } finally { setBusy(false); }
  }

  // NEW-FU-280 (Phase 56): handleAddInstructor / handleAddVenue /
  // handleAddCourse moved into their respective modal components
  // (AddInstructorModal / AddVenueModal / AddCourseModal). Each modal
  // owns its own submit handler, local form state, and validation —
  // SidePanel no longer needs the duplicated copies.

  const hardCount = conflicts.filter(c => c.severity === 'Hard').length;
  const softCount = conflicts.filter(c => c.severity === 'Soft' && !c.confirmed).length;

  return (
    <aside className={`sp-root${collapsed ? ' sp-collapsed' : ''}`}>
      <button
        className="sp-collapse-btn"
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Expand panel' : 'Collapse panel'}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? '›' : '‹'}
      </button>

      {/* NEW-FU-418 (Phase 103 item 5): the scrolling content lives in an inner
          wrapper so the collapse handle (a direct child of .sp-root, which no
          longer scrolls) stays pinned to the panel's visible vertical centre at
          every scroll position. */}
      {!collapsed && (
      <div className="sp-scroll">

      {/* ── Conflict summary ─────────────────────────────────────────────── */}
      <div className="sp-section">
        <div className="sp-heading">Conflicts</div>
        <div className="sp-badges">
          <span className={`sp-badge hard ${hardCount > 0 ? 'active' : ''}`}>
            ● {hardCount} Hard
          </span>
          <span className={`sp-badge soft ${softCount > 0 ? 'active' : ''}`}>
            ● {softCount} Soft
          </span>
        </div>
        {/* NEW-FU-319 (Phase 29): Quick Fix launcher. Visible only when
            there's something to fix — no conflicts means no plan to
            compute. Disabled on archived terms so the user gets the
            "term is archived" message instead of clicking through to a
            modal that would 409 on apply anyway. Per-conflict fix
            buttons (the ✦ chips inside each conflict <li>) still work
            for single-issue fixes; this button is for batch resolution. */}
        {conflicts.length > 0 && (
          <button
            className="sp-quick-fix-btn"
            onClick={() => onQuickFix && onQuickFix()}
            disabled={isArchived}
            title={isArchived ? lockedTitle : 'Open Quick Fix planner — propose a sequence of remediation ops to clear conflicts.'}
          >
            <Ico name="sparkles" /> Quick Fix conflicts
          </button>
        )}
        {conflicts.length > 0 && (
          <ul className="sp-conflict-list">
            {conflicts.map((conflict, i) => {
              // NEW-L4: stable identity = rule + section pair, so expanding a
              // conflict survives a re-order from a backend re-fetch.
              const stableKey  = `${conflict.ruleId}|${conflict.sectionAId ?? ''}|${conflict.sectionBId ?? ''}|${i}`;
              const isExpanded = expandedConflict === stableKey;
              const preview = conflict.description.length > 80
                ? conflict.description.substring(0, 80) + '…'
                : conflict.description;
              // NEW-FU-281: R-15 conflicts may carry `fixes` — concrete
              // "add a day" proposals computed by the backend (FU-278).
              // Only rendered when expanded (matches the description's
              // expand-on-click pattern) so the collapsed view stays tidy.
              const hasFixes = Array.isArray(conflict.fixes) && conflict.fixes.length > 0;
              return (
                <li key={stableKey}
                  className={`sp-conflict-item ${conflict.severity.toLowerCase()} clickable`}
                  onClick={() => setExpandedConflict(isExpanded ? null : stableKey)}
                  title="Click to expand"
                >
                  <div className="sp-conflict-header">
                    {/* NEW-FU-472 (Phase 113): no raw rule code (e.g. "R-04") on screen —
                        the severity tag + the plain description below convey the clash.
                        The non-technical secretary never needs the internal code. */}
                    <span className="sp-conflict-severity">{conflict.severity}</span>
                    {hasFixes && !isExpanded && (
                      <span className="sp-conflict-fix-hint" title="Quick fixes available">
                        <Ico name="sparkles" /> {conflict.fixes.length}
                      </span>
                    )}
                    <span className="sp-conflict-toggle">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                  <span className="sp-conflict-desc">
                    {isExpanded ? conflict.description : preview}
                  </span>
                  {isExpanded && hasFixes && (
                    <div className="sp-conflict-fixes"
                      // Clicks inside this region must NOT collapse the
                      // surrounding conflict <li>. stopPropagation prevents
                      // the <li>'s toggle handler from firing on button click.
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="sp-conflict-fixes-label">Quick fixes</div>
                      {conflict.fixes.map((fix, fi) => {
                        // NEW-FU-293 (Phase 25): kind-discriminated busy
                        // key. Matches the key applyFix() uses so the
                        // disabled state corresponds to THIS specific
                        // proposal (not all proposals on the conflict).
                        const key = `${fix.sectionId}|${fix.kind}|${fix.instructorId ?? fix.venueId ?? (fix.addDays ?? []).join(',')}`;
                        const isBusy = fixBusy === key;
                        // Title text varies by kind so the hover hint is
                        // accurate. All three kinds reuse the same button
                        // chassis (color + chip style) — only the verb
                        // differs.
                        const title = isArchived ? lockedTitle
                          : fix.kind === 'add-days'             ? `Complete the ${fix.template} pattern`
                          : fix.kind === 'reassign-instructor'  ? `Move this section to ${fix.instructorName}`
                          : fix.kind === 'reassign-venue'       ? `Move this section to ${fix.venueName}`
                          : 'Apply quick fix';
                        const busyVerb = fix.kind === 'add-days' ? '⏳ Adding…' : '⏳ Reassigning…';
                        return (
                          <button
                            key={fi}
                            className="sp-conflict-fix-btn"
                            disabled={isBusy || isArchived}
                            title={title}
                            onClick={() => applyFix(fix)}
                          >
                            {isBusy ? busyVerb : fix.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {conflicts.length === 0 && schedule && (
          <div className="sp-no-conflict">
            <span className="sp-no-conflict-badge"><Ico name="check" /></span>
            <div className="sp-no-conflict-text">
              <span className="sp-no-conflict-title">No conflicts</span>
              <span className="sp-no-conflict-sub">All sections are clash-free.</span>
            </div>
          </div>
        )}
      </div>

      {/* NEW-FU-433 (Phase 106 item 5): advisory — how many real instructors/
          venues to add to replace the "dummy" placeholders Suggest/Quick Fix
          created so the schedule can run for real. Shown in every view. */}
      {schedule && (() => {
        const dI = (instructors ?? []).filter(i => i.is_dummy).length;
        const dV = (venues ?? []).filter(v => v.is_dummy).length;
        if (!dI && !dV) return null;
        const parts = [];
        if (dI) parts.push(`${dI} instructor${dI > 1 ? 's' : ''}`);
        if (dV) parts.push(`${dV} venue${dV > 1 ? 's' : ''}`);
        return (
          <div className="sp-dummy-advisory" role="status">
            <span className="sp-dummy-advisory-icon" aria-hidden="true">🧩</span>
            <div className="sp-dummy-advisory-text">
              <strong>To implement this schedule for real, add {parts.join(' and ')}.</strong>
              <span> These swap out the “dummy” placeholders Suggest added — creating a real instructor or venue replaces one automatically.</span>
            </div>
          </div>
        );
      })()}

      {/* ── Sections (Course View) ───────────────────────────────────────── */}
      {view === VIEWS.COURSE && (
        <div className="sp-section">
          <div className="sp-heading-row">
            <span className="sp-heading">Sections</span>
            <button className="sp-add-btn"
              onClick={() => onAddSection && onAddSection()}
              disabled={isArchived}
              title={isArchived ? lockedTitle : 'Add section'}>+</button>
          </div>

          {/* Section list — grouped by course, ordered by academic level */}
          {sections.length === 0
            ? <ul className="sp-list"><li className="sp-empty">No sections yet</li></ul>
            : LEVEL_ORDER.map(level => {
                const grps = groupSections(sections).filter(g => (g.academicLevel??'Freshman') === level);
                if (!grps.length) return null;
                // Further group by courseCode
                const byCourse = {};
                for (const grp of grps) {
                  if (!byCourse[grp.courseCode]) byCourse[grp.courseCode] = [];
                  byCourse[grp.courseCode].push(grp);
                }
                const colors = LEVEL_COLORS[level] ?? LEVEL_COLORS.Freshman;
                return (
                  <div key={level} className="sp-sec-level-group">
                    <div className="sp-sec-level-header" style={{borderColor:colors.border,color:colors.border}}>
                      {level}
                    </div>
                    {/* NEW-FU-499 (Phase 123): sort course groups numerically.
                        Object.entries preserved insertion order, so Senior listed
                        422 → 413 → 412 (whatever order sections loaded in) while the
                        Courses panel below sorts — the same numeric-aware compare
                        makes both panels agree (412 → 413 → 422 → …). */}
                    {Object.entries(byCourse)
                      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
                      .map(([courseCode, courseGrps]) => (
                      <div key={courseCode} className="sp-sec-course-group">
                        <div className="sp-sec-course-label"
                          style={{background:colors.bg, borderLeft:`3px solid ${colors.border}`}}>
                          {courseCode}
                        </div>
                        <ul className="sp-list" style={{marginTop:2}}>
                          {courseGrps.sort((a,b) => a.sectionNumber.localeCompare(b.sectionNumber, undefined, {numeric:true})).map(grp => {
                            const days = grp.days.sort((a,b)=>{
                              const o=['Sunday','Monday','Tuesday','Wednesday','Thursday'];
                              return o.indexOf(a)-o.indexOf(b);
                            }).map(d=>d.substring(0,3)).join('/');
                            return (
                              <li key={grp.key}
                                className={`sp-section-item ${isArchived ? '' : 'clickable'}`}
                                onClick={isArchived ? undefined : () => onEditSection && onEditSection(
                                  sections.find(s => s.id === grp.representativeId)
                                )}
                                title={isArchived ? lockedTitle : 'Click to edit'}
                              >
                                {/* NEW-FU-282 (Phase 56): sectionLabel handles the
                                    §F-XX vs §XX distinction so the sidebar's
                                    female sections render as "§F-01" (with
                                    hyphen) instead of "§01" (which dropped the
                                    gender entirely before this phase). */}
                                <span className="sp-sec-code" style={{minWidth:28,fontSize:'.72rem',
                                  color:colors.border,fontWeight:700}}>{sectionLabel(grp)}</span>
                                <span className="sp-sec-detail">{days} {grp.startTime}</span>
                                <button className="sp-del-btn"
                                  title={isArchived ? lockedTitle : `Remove entire section ${sectionLabel(grp)} (all meeting days)`}
                                  disabled={isArchived}
                                  onPointerDown={e=>e.stopPropagation()}
                                  onClick={async e=>{
                                    e.stopPropagation();
                                    // NEW-FU-300 (Phase 26): explicit confirm so users
                                    // don't accidentally wipe a whole section by misclick.
                                    // Phase 22 wired the side panel ✕ to group-scope (correct);
                                    // a confirmation surface makes the scope inescapable.
                                    if (!window.confirm(`Remove the entire ${courseCode} ${sectionLabel(grp)} section (all meeting days)?`)) {
                                      return;
                                    }
                                    try {
                                      await removeSection(grp.representativeId);
                                      // NEW-FU-300: explicit toast naming the scope so the
                                      // user sees "section" (not "row") was removed. The
                                      // old behavior gave no feedback at all.
                                      showToast && showToast(
                                        `✓ Removed entire section ${courseCode} ${sectionLabel(grp)} (all meeting days).`,
                                        'success',
                                      );
                                    }
                                    catch (err) {
                                      showToast && showToast(
                                        err.response?.data?.error || 'Failed to delete section.',
                                        'error',
                                      );
                                    }
                                  }}>×</button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                );
              })
          }
        </div>
      )}

      {/* ── Instructors (Teacher View) ────────────────────────────────────── */}
      {view === VIEWS.TEACHER && (
        <div className="sp-section">
          <div className="sp-heading-row">
            <span className="sp-heading">Instructors</span>
            <button className="sp-add-btn"
              onClick={()=>setOpenForm(openForm==='instructor'?null:'instructor')}
              disabled={isArchived}
              title={isArchived ? lockedTitle : 'Add instructor'}>+</button>
          </div>

          {/* NEW-FU-280 (Phase 56): the + button now opens AddInstructorModal
              instead of expanding an inline form inside the sidebar's
              narrow `.sp-form` scope. Same reason as the Phase 55
              promotion of Add Course — the modal escapes the sidebar's
              width and gives us labelled `.sm-field` rows, an
              auto-derived KFUPM email preview, and the standard chrome
              shared with every other modal. */}
          {openForm === 'instructor' && (
            <AddInstructorModal
              onClose={() => setOpenForm(null)}
              showToast={showToast}
            />
          )}

          <ul className="sp-list">
            {/* NEW-FU-420 (Phase 104 item 6): always render alphabetically,
                case-insensitively — a newly-added instructor is appended to
                state, so sorting at render keeps the list ordered without a
                re-fetch. */}
            {[...instructors].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map(instr => (
              <li key={instr.id}>
                <button
                  className={`sp-filter-item ${filterId===instr.id?'selected':''}`}
                  /* NEW-FU-288 (Phase 57): tooltip carries the full
                     instructor name + email. Very long names ("Dr.
                     Mohammed Bin Abdullah Al-Khaldi") may still
                     line-clamp on narrow viewports — the hover lets
                     you see the full string without expanding the row. */
                  title={`${instr.name}${instr.email ? ` · ${instr.email}` : ''}`}
                  onClick={()=>selectFilter(instr.id)}
                >
                  {/* NEW-FU-421 (Phase 104 item 7): avatar = FIRST name's initial
                      (was .pop() → last name). */}
                  <span className={`sp-avatar${instr.is_dummy ? ' sp-avatar-dummy' : ''}`}>{((instr.name || '').trim().split(/\s+/)[0] || '?').charAt(0)}</span>
                  <FilterName>{instr.name}</FilterName>
                  {/* NEW-FU-425 (Phase 104 item 2): clearly label placeholder instructors. */}
                  {instr.is_dummy && <span className="sp-dummy-badge" title="Placeholder added by Suggest — add a real instructor to replace it">dummy</span>}
                  {filterId===instr.id && <span className="sp-check"><Ico name="check" /></span>}
                </button>
                <button className="sp-del-btn"
                  title={isArchived ? lockedTitle : 'Remove instructor'}
                  disabled={isArchived}
                  onClick={async () => {
                    // NEW-M17: confirm before deleting (cascades to office_hours,
                    // sets sections.instructor_id to NULL across all schedules).
                    if (!window.confirm(
                      `Delete instructor "${instr.name}"?\n` +
                      `Their office hours will be removed and any sections they teach will lose their instructor.`
                    )) return;
                    try { await removeInstructor(instr.id); }
                    catch (err) {
                      showToast && showToast(
                        err.response?.data?.error || 'Failed to delete instructor.',
                        'error',
                      );
                    }
                  }}>×</button>
              </li>
            ))}
          </ul>

          {/* Office Hours for selected instructor */}
          {filterId && (
            <div className="sp-oh-section">
              <div className="sp-heading-row" style={{marginTop:10}}>
                <span className="sp-heading">Office Hours</span>
                <button className="sp-add-btn"
                  onClick={()=>setOpenForm(openForm==='oh'?null:'oh')}
                  disabled={isArchived}
                  title={isArchived ? lockedTitle : 'Add office hour'}>+</button>
              </div>

              {openForm === 'oh' && (
                <form className="sp-form" onSubmit={handleAddOH}>
                  <select value={ohForm.day} onChange={e=>setOhForm(f=>({...f,day:e.target.value}))}>
                    {DAYS.map(d=><option key={d} value={d}>{d}</option>)}
                  </select>
                  <div style={{display:'flex',gap:6}}>
                    <input type="time" min={OH_MIN} max={OH_MAX} value={ohForm.startTime}
                      onChange={e=>setOhForm(f=>({...f,startTime:clampOH(e.target.value)}))} required />
                    <input type="time" min={OH_MIN} max={OH_MAX} value={ohForm.endTime}
                      onChange={e=>setOhForm(f=>({...f,endTime:clampOH(e.target.value)}))} required />
                  </div>
                  {formError && <div className="sp-form-error">{formError}</div>}
                  <div className="sp-form-actions">
                    <button type="button" onClick={()=>setOpenForm(null)}>Cancel</button>
                    <button type="submit" className="sp-submit" disabled={busy}>{busy?'…':'Add'}</button>
                  </div>
                </form>
              )}

              {ohLoading && <p className="sp-empty">Loading…</p>}
              {!ohLoading && ohList.length === 0 && (
                <p className="sp-empty">No office hours set</p>
              )}
              <ul className="sp-list">
                {ohList.map(oh => (
                  <li key={oh.id} className="sp-oh-item">
                    <span className="sp-oh-day">{oh.day}</span>
                    <span className="sp-oh-time">
                      {(oh.start_time??oh.startTime??'').substring(0,5)}–{(oh.end_time??oh.endTime??'').substring(0,5)}
                    </span>
                    <button className="sp-del-btn"
                      title={isArchived ? lockedTitle : 'Remove office hour'}
                      disabled={isArchived}
                      onClick={()=>handleDeleteOH(oh.id)}>×</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── Venues (Venue View) ────────────────────────────────────────────── */}
      {view === VIEWS.VENUE && (
        <div className="sp-section">
          <div className="sp-heading-row">
            <span className="sp-heading">Venues</span>
            <button className="sp-add-btn"
              onClick={()=>setOpenForm(openForm==='venue'?null:'venue')}
              disabled={isArchived}
              title={isArchived ? lockedTitle : 'Add venue'}>+</button>
          </div>
          {/* NEW-FU-287 (Phase 57): copy updated — the venue category list
              now includes Multipurpose alongside Lecture Hall and Laboratory. */}
          <p className="sp-hint">Lecture halls, labs &amp; multipurpose rooms</p>

          {/* NEW-FU-281 (Phase 56): the + button now opens AddVenueModal
              instead of expanding an inline form. The modal enforces the
              registrar's XX-YYY / XX-YYY-Z / XX-YYYY naming convention
              through structured Building / Room / Section inputs with a
              live preview — see AddVenueModal.jsx for the validation
              rules. The old inline form let any free-form string through,
              which is how non-conforming names ended up in the DB. */}
          {openForm === 'venue' && (
            <AddVenueModal
              onClose={() => setOpenForm(null)}
              showToast={showToast}
            />
          )}

          <ul className="sp-list">
            {venues.map(v => (
              <li key={v.id} className="sp-venue-li">
                <button
                  className={`sp-filter-item ${filterId===v.id?'selected':''}`}
                  /* NEW-FU-288 (Phase 57): tooltip carries the full venue
                     name + type + capacity, so a wrapped name (`24-\n101-A`)
                     remains identifiable on hover. */
                  title={`${v.name} · ${v.type} · cap.${v.capacity}`}
                  onClick={()=>selectFilter(v.id)}
                >
                  {/* NEW-FU-287 (Phase 57): venue-type pill labels the
                      three categories. Multipurpose rooms use 'MULTI' to
                      keep the badge short (parity with HALL/LAB widths). */}
                  <span className={`sp-venue-tag ${
                    v.type === 'Laboratory'  ? 'lab'
                    : v.type === 'Multipurpose' ? 'multi'
                    : 'hall'
                  }`}>
                    {v.type === 'Laboratory'   ? 'LAB'
                     : v.type === 'Multipurpose' ? 'MULTI'
                     : 'HALL'}
                  </span>
                  <FilterName role="venue">{v.name}</FilterName>
                  {/* NEW-FU-425 (Phase 104 item 2): clearly label placeholder venues. */}
                  {v.is_dummy
                    ? <span className="sp-dummy-badge" title="Placeholder added by Suggest — add a real venue to replace it">dummy</span>
                    : <span className="sp-venue-cap">cap.{v.capacity}</span>}
                  {filterId===v.id && <span className="sp-check"><Ico name="check" /></span>}
                </button>
                <button className="sp-del-btn"
                  title={isArchived ? lockedTitle : 'Remove venue'}
                  disabled={isArchived}
                  onClick={async () => {
                    // NEW-M17: confirm before deleting (sections.venue_id is
                    // set to NULL across every schedule that used this venue).
                    if (!window.confirm(
                      `Delete venue "${v.name}"?\n` +
                      `Any sections currently scheduled in this venue will lose their venue assignment.`
                    )) return;
                    try { await removeVenue(v.id); }
                    catch (err) {
                      showToast && showToast(
                        err.response?.data?.error || 'Failed to delete venue.',
                        'error',
                      );
                    }
                  }}>×</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Courses (always shown at bottom) ─────────────────────────────── */}
      <div className="sp-section">
        <div className="sp-heading-row">
          <span className="sp-heading">Courses</span>
          {/* NEW-FU-279 (Phase 55): the + button now opens the AddCourseModal
              instead of expanding an inline form. The inline form was
              compressed by the sidebar's `.sp-form` scope to ~30px effective
              content width — checkbox descriptions wrapped one word per
              line. The modal escapes that scope entirely. */}
          <button className="sp-add-btn"
            onClick={()=>setOpenForm(openForm==='course'?null:'course')}
            disabled={isArchived}
            title={isArchived ? lockedTitle : 'Add course'}>+</button>
        </div>

        {openForm === 'course' && (
          <AddCourseModal
            onClose={() => setOpenForm(null)}
            showToast={showToast}
          />
        )}

        {/* NEW-FU-274 (Phase 51 #4): walk LEVEL_ORDER so the groups render
            Freshman → Sophomore → Junior → Senior → Graduate, not the
            alphabetical "Freshman, Graduate, Junior, Senior" order that
            Object.entries used to produce. Mirrors the section-list grouping
            at line 393. Unknown levels are appended in original order so a
            future tier doesn't silently drop. */}
        <div className="sp-course-groups">
          {(() => {
            const grouped = groupBy(courses, 'academic_level');
            const orderedLevels = [
              ...LEVEL_ORDER.filter(l => grouped[l]),
              ...Object.keys(grouped).filter(l => !LEVEL_ORDER.includes(l)),
            ];
            return orderedLevels.map(level => {
              const cs = grouped[level];
              return (
            <div key={level} className="sp-level-group">
              <div className="sp-level-header" style={{color: LEVEL_COLORS[level]?.border, borderColor: LEVEL_COLORS[level]?.border}}>
                <span className="sp-level-dot" style={{background:LEVEL_COLORS[level]?.bg, borderColor:LEVEL_COLORS[level]?.border}} />
                {level}
              </div>
              <div className="sp-level-courses">
                {cs.map(c => (
                  <DraggableCourse key={c.id} course={c} level={level}
                    onRemove={removeCourse} showToast={showToast}
                    isArchived={isArchived} lockedTitle={lockedTitle} />
                ))}
              </div>
            </div>
              );
            });
          })()}
        </div>
      </div>

      </div> /* end .sp-scroll (!collapsed) */
      )}
    </aside>
  );
}

// NEW-FU-295 (Phase 59): tiny wrapper that auto-fits an `.sp-filter-name`
// span. Used in the instructor + venue list rows. We need a component
// (not a callback inline in `.map()`) so each rendered row has its own
// hook instance + ref — React rules-of-hooks forbid calling hooks
// inside a loop in the parent function.
//
// NEW-FU-298 (Phase 60): added `role` prop + useRenderStrategy. Each
// row first picks its display string via the strategy ladder, then
// useFitText sizes whatever was picked. `role` selects between the
// instructor and venue pickers (different text structures).
function FilterName({ children, role = 'instructor' }) {
  const ref = React.useRef(null);
  // NEW-FU-305 (Phase 63): floor lowered 6 → 4 px. The user's
  // "never break a word" rule needs more shrink room for the
  // rare long single names that overflow even a sidebar row.
  const display = useRenderStrategy(children, ref, role);
  useFitText(ref, { minPx: 4 });
  return (
    <span className="sp-filter-name" ref={ref}
      style={{ whiteSpace: 'pre-line' }}>{display}</span>
  );
}

// ── DraggableCourse ──────────────────────────────────────────────────────────
function DraggableCourse({ course, level, onRemove, showToast, isArchived = false, lockedTitle = '' }) {
  // NEW-FU-205: when isArchived, useDraggable's `disabled` prevents the
  // drag-handle from initiating any drag operation. Spreading listeners +
  // attributes is still safe; dnd-kit no-ops them under disabled.
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: course.id, disabled: isArchived });
  const colors = LEVEL_COLORS[level] ?? LEVEL_COLORS.Freshman;
  // NEW-FU-295 (Phase 59): auto-fit the course name. The 3-line clamp
  // from Phase 58 still works for the common case, but if the user
  // shrinks the sidebar width or zooms in, individual long names get
  // an extra knob — the font shrinks per-card until the name fits.
  const nameRef = React.useRef(null);
  // NEW-FU-305 (Phase 63): course-card floor 5 → 3 px to fit
  // genuinely-long course names even when the sidebar is narrow
  // AND char-break is forbidden (Phase 63 rule).
  useFitText(nameRef, { minPx: 3 });
  const style = {
    transform: transform ? `translate3d(${transform.x}px,${transform.y}px,0)` : undefined,
    opacity: isDragging ? 0.4 : (isArchived ? 0.7 : 1),
    cursor: isArchived ? 'default' : 'grab',
  };
  return (
    <div
      ref={setNodeRef}
      className="sp-course-card"
      style={{ ...style, borderColor: colors.border, background: colors.bg }}
      {...listeners}
      {...attributes}
      /* NEW-FU-288 (Phase 57): tooltip carries the full course name +
         code. The 2-line clamp on `.sp-course-name` can still ellipsis-
         truncate genuinely-long names (e.g. test fixtures like
         "Introduction to SE (DUMMY — Freshman)"), so the tooltip is the
         readable-tail fallback. */
      title={isArchived
        ? lockedTitle
        : `${course.course_code} — ${course.name}\nDrag onto the grid to add a section`}
    >
      <span className="sp-course-code" style={{ color: colors.text }}>{course.course_code}</span>
      <span className="sp-course-name" ref={nameRef} style={{ color: colors.text }}>{course.name}</span>
      <button
        className="sp-del-btn"
        title={isArchived ? lockedTitle : 'Remove course'}
        disabled={isArchived}
        onPointerDown={e => e.stopPropagation()}
        onClick={async e => {
          e.stopPropagation();
          if (!window.confirm(`Delete ${course.course_code} and ALL its sections?`)) return;
          try {
            await onRemove(course.id);
          } catch (err) {
            showToast && showToast(
              err.response?.data?.error || 'Failed to delete course.',
              'error',
            );
          }
        }}
      >×</button>
    </div>
  );
}

// Group sections by courseId+sectionNumber+gender for the sidebar display.
//
// NEW-FU-282 (Phase 56): gender added to the dedupe key. Without it,
// an M-01 and an F-01 of the same course (both with section_number =
// '01' in the DB, distinguished only by the gender column) would
// collide into a single sidebar row showing the days of both groups
// combined. The `gender` field is also propagated to the resulting
// group so `sectionLabel({...grp})` returns "§F-01" vs "§01" correctly.
function groupSections(sections) {
  const map = new Map();
  for (const sec of sections) {
    const gender = sec.gender ?? 'M';
    const key = `${sec.courseId??sec.course_id}|${sec.sectionNumber??sec.section_number}|${gender}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        courseCode:       sec.courseCode      ?? sec.course_code      ?? '?',
        sectionNumber:    sec.sectionNumber   ?? sec.section_number   ?? '',
        gender,
        academicLevel:    sec.academicLevel   ?? sec.academic_level   ?? 'Freshman',
        startTime:        (sec.startTime ?? sec.start_time ?? '').substring(0,5),
        days:             [],
        representativeId: sec.id,
      });
    }
    map.get(key).days.push(sec.day);
  }
  return Array.from(map.values());
}

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    // NEW-L5: skip items missing the key rather than bucketing them under
    // "undefined" — those leak into the UI as an unlabelled group.
    const k = item[key];
    if (k == null || k === '') return acc;
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}
