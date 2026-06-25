import React, { useState, useRef, useEffect, useMemo } from 'react';
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
// NEW-FU-633 (issue #4): removed the useRenderStrategy import — FilterName no longer
// multi-line-wraps/shrinks names; sidebar names are single-line ellipsis now. (useFitText
// is still used by DraggableCourse for course-card name fitting.)
import OfficeHoursManagerModal from '../modals/OfficeHoursManagerModal.jsx'; // NEW-FU-637 (issue #5): dedicated OH subscreen
import './SidePanel.css';

const LEVEL_ORDER = ['Freshman','Sophomore','Junior','Senior','Graduate'];

// NEW-FU-608 (Batch 30 item 1): compact, professional status flag for the Instructor/Venue
// sidebars — a distinct color + icon + tooltip per state so the user can triage at a glance:
//   'empty'   — instructor with NO classes AND NO office hours (rose + alert)
//   'oh-only' — instructor with office hours but NO classes        (amber + clock)
//   'venue'   — venue with NO classes assigned                      (rose + alert)
// NEW-FU-617 (Batch 32): tooltips now DIRECT the user to the fix — selecting the instructor
// opens the Office Hours editor (scrolled into view) where "+" adds an office hour.
// NEW-FU-630 (audit): drive the pill from theme TONES rather than hardcoded hex. The old
// #f87171 / #fbbf24 used as TEXT over a 13%-alpha tint read fine on the dark sidebar but only
// ~2.8:1 on the light sidebar (#F4F5F6) — under WCAG AA for this 0.62rem label. --danger-* /
// --warn-* are defined per-theme (light #b91c1c-on-#fee2e2, dark #fca5a5-on-#3a1a1a), so the
// label stays accessible in BOTH modes.
// NEW-FU-642 (issue #1b): every instructor-list flag now has a DISTINCT colour — no two share a
// hue (the old 'no data' and 'no hours' were both rose). empty=rose, oh-only=amber, no-oh=violet.
// (venue lives in the separate Venue list, never beside these, so its rose is unambiguous there.)
// NEW-FU-643 (issue #3): measure rendered text width off-DOM via one shared canvas (cheap, exact).
function measureTextWidth(text, font) {
  const c = (measureTextWidth._c || (measureTextWidth._c = document.createElement('canvas')));
  const ctx = c.getContext('2d');
  ctx.font = font;
  return ctx.measureText(text || '').width;
}
// Choose ONE font size at which the LONGEST instructor name fits the available name width, and use
// it for ALL names (uniform). This guarantees every name — however long — renders fully on one line
// without clipping or wrapping. Re-measures whenever the list resizes; a readable floor keeps it
// from going tiny, and a small safety factor avoids a 1px clip. `listRef` is the instructor <ul>.
function useUniformNameFont(names, listRef) {
  const [fz, setFz] = useState(13);
  useEffect(() => {
    const el = listRef.current;
    if (!el || !names || !names.length) { setFz(13); return; }
    const BASE = 13, FLOOR = 9, OVERHEAD = 112, SAFETY = 1.06;
    // NEW-FU-644 (issue #1a): wrap the WHOLE measurement in try/catch. Last round a throw inside
    // compute() (e.g. a canvas/getComputedStyle hiccup) left the size stuck at the 13px default —
    // "the code was served" yet names still clipped. Now any failure falls back to BASE cleanly,
    // and the success path actually shrinks. The widened Instructor/Venue panel (FU-644 #1b) means
    // current names fit at BASE; this is the safety net for an extreme name.
    const compute = () => {
      try {
        const family = getComputedStyle(el).fontFamily || 'sans-serif';
        const font = `600 ${BASE}px ${family}`;
        let longest = 0;
        for (const n of names) { const w = measureTextWidth(n, font); if (w > longest) longest = w; }
        if (!(longest > 0)) { setFz(BASE); return; }
        // Available name width ≈ list width minus the per-row chrome (avatar + gaps + selected
        // check + clock/× actions). A generous OVERHEAD makes the size only ever SMALLER.
        const avail = Math.max(80, el.clientWidth - OVERHEAD);
        let px = Math.min(BASE, (avail / (longest * SAFETY)) * BASE);
        px = Math.max(FLOOR, px);
        setFz(Math.round(px * 10) / 10);
      } catch { setFz(BASE); }
    };
    compute();
    let ro = null;
    try { ro = new ResizeObserver(compute); ro.observe(el); } catch { /* no RO → keep the static fit */ }
    return () => { if (ro) ro.disconnect(); };
  }, [names, listRef]);
  return fz;
}

const STATUS_FLAG_CFG = {
  empty:     { tone: 'danger', icon: 'info',  label: 'no data',  title: 'No classes or office hours yet — click this instructor, then "+ Office Hours" below to add office hours.' },
  'oh-only': { tone: 'warn',   icon: 'clock', label: 'no class', title: 'Has office hours but no classes — drag a course onto the grid to assign a class.' },
  // NEW-FU-640 (issue #5): teaching but no office hours (the R-13 case).
  'no-oh':   { tone: 'violet', icon: 'alert', label: 'no hours', title: 'Teaching but has no office hours — click the clock button to add at least one (every teaching instructor needs office hours).' },
  venue:     { tone: 'danger', icon: 'alert', label: 'no class', title: 'No classes assigned to this venue.' },
};
const STATUS_FLAG_TONE = {
  danger: { fg: 'var(--danger-fg)', bg: 'var(--danger-bg)' },
  warn:   { fg: 'var(--warn-fg)',   bg: 'var(--warn-bg)' },
  violet: { fg: 'var(--violet-fg)', bg: 'var(--violet-bg)' },
};
function StatusFlag({ type }) {
  const cfg = type && STATUS_FLAG_CFG[type];
  if (!cfg) return null;
  const tone = STATUS_FLAG_TONE[cfg.tone];
  return (
    <span className="sp-status-flag" title={cfg.title}
      /* NEW-FU-633 (issue #4): compact inline pill — tighter padding/gap, fixed line-height
         so it never adds row height or clips its 1em icon; flex-shrink:0 keeps it whole while
         the name ellipsizes. */
      style={{ display:'inline-flex', alignItems:'center', gap:2, marginLeft:4, padding:'0 5px',
        borderRadius:5, fontSize:'0.6rem', fontWeight:700, lineHeight:1.55, letterSpacing:'0.01em',
        whiteSpace:'nowrap', color:tone.fg, background:tone.bg, border:`1px solid ${tone.fg}`, flexShrink:0 }}>
      <Ico name={cfg.icon} /> {cfg.label}
    </span>
  );
}

export default function SidePanel({ showToast, onAddSection, onEditSection, onQuickFix }) {
  const {
    view, filterId, schedule,
    courses, instructors, venues,
    sections, officeHours, conflicts, coverage,
    switchView, loadView,
    removeSection,
    // NEW-FU-280 (Phase 56): addInstructor / addVenue / addCourse are no
    // longer destructured here — each lives inside its dedicated modal,
    // which calls useApp() on its own. Only the remove* helpers stay,
    // since the × buttons in this sidebar still drive deletions.
    removeInstructor,
    removeVenue,
    removeCourse,
    confirm,   // NEW-FU-547 (Batch 15 Issue 5): themed, dark-mode-compatible confirm
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
    ? 'Term is finalized — click the Locked button in the top bar to unlock it first.'
    : 'Term is archived — unarchive to make changes.';

  // NEW-FU-608 (Batch 30 item 1): side-panel status flags. `coverage` (refreshed by loadView)
  // tells us, for THIS term, which instructors have ≥1 class, which venues have ≥1 class, and
  // which instructors have any office hours — so the user can triage the list WITHOUT opening
  // each one. instructorFlag(): 'empty' (no classes AND no office hours) | 'oh-only' (office
  // hours but no classes) | 'no-oh' (teaching but no office hours) | null (fully set up).
  // venueFlag(): 'venue' (no classes) | null.
  const instrWithClasses = React.useMemo(() => new Set(coverage?.instructorIdsWithClasses ?? []), [coverage]);
  const instrWithOH      = React.useMemo(() => new Set(coverage?.instructorIdsWithOfficeHours ?? []), [coverage]);
  const venueWithClasses = React.useMemo(() => new Set(coverage?.venueIdsWithClasses ?? []), [coverage]);
  // No flags until coverage has loaded (avoids a first-paint flash of "all empty").
  // NEW-FU-640 (issue #5): a THIRD flag — an instructor who IS teaching but has NO office hours
  // (the R-13 soft conflict). Previously a teaching instructor showed no flag at all, so this
  // missing-OH state was invisible in the sidebar (only the conflicts panel surfaced it).
  const instructorFlag = (id) => {
    if (!coverage) return null;
    const hasClass = instrWithClasses.has(id), hasOH = instrWithOH.has(id);
    if (hasClass) return hasOH ? null : 'no-oh';      // teaching → flag ONLY if it has no office hours
    return hasOH ? 'oh-only' : 'empty';               // not teaching → 'no class' / 'no data'
  };
  const venueFlag = (id) => (!coverage ? null : (venueWithClasses.has(id) ? null : 'venue'));

  // NEW-FU-643 (issue #3): one dynamic, uniform font size for ALL instructor names — sized so the
  // LONGEST fits fully on one line at the current panel width. Sort once here so the same order
  // feeds both the fit measurement and the render.
  const instrListRef = useRef(null);
  const sortedInstructors = useMemo(
    () => [...instructors].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })),
    [instructors]);
  const instrNames = useMemo(() => sortedInstructors.map(i => i.name || ''), [sortedInstructors]);
  const nameFontSize = useUniformNameFont(instrNames, instrListRef);

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

  // ── Office Hours (NEW-FU-637, issue #5) ──────────────────────────────────────
  // Office-hour viewing/editing moved OUT of the sidebar into a dedicated subscreen
  // (OfficeHoursManagerModal), opened by a per-instructor "Office Hours" button — a control
  // DISTINCT from clicking the name. Clicking a name now only shows the schedule and no longer
  // force-scrolls the sidebar (the old FU-617 scrollIntoView + the inline form/list are gone).
  // The modal owns its own fetch/add/edit/delete, enforces the 08:00–16:00 window, the OH↔OH
  // overlap guard, and the #2b OH↔class up-front confirmation, and is read-only when finalized/
  // archived. `ohManagerFor` is the instructor currently being managed (null = closed).
  const [ohManagerFor, setOhManagerFor] = useState(null);

  function selectFilter(id) {
    if (!schedule) return;
    const newId = filterId === id ? null : id;
    // H-7: switchView updates filterId in context which triggers the useEffect
    // in SchedulerPage — calling loadView here too causes a double-fetch race.
    switchView(view, newId);
  }

  // NEW-FU-561 (audit P3): removed the dead inline add-section form cluster (secForm
  // state + computeEndTime + handleAddSection) — superseded by the SectionModal flow and
  // never wired to any JSX. Only the contextual Office-Hours form remains inline.

  // NEW-FU-280 (Phase 56): handleAddInstructor / handleAddVenue /
  // handleAddCourse moved into their respective modal components
  // (AddInstructorModal / AddVenueModal / AddCourseModal). Each modal
  // owns its own submit handler, local form state, and validation —
  // SidePanel no longer needs the duplicated copies.

  const hardCount = conflicts.filter(c => c.severity === 'Hard').length;
  const softCount = conflicts.filter(c => c.severity === 'Soft' && !c.confirmed).length;

  // NEW-FU-644 (issue #1b): WIDER panel (sp-wide) in Instructor & Venue views — sparse,
  // non-overlapping grids, so long instructor names get room; Course View keeps the narrow width.
  return (
    <aside className={`sp-root${collapsed ? ' sp-collapsed' : ''}${(view === VIEWS.TEACHER || view === VIEWS.VENUE) ? ' sp-wide' : ''}`}>
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
            <span className="sp-dummy-advisory-icon" aria-hidden="true"><Ico name="info" /></span>
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
              title={isArchived ? lockedTitle : 'Add section'}><Ico name="plus" /></button>
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
                    <div className="sp-sec-level-header" style={{borderColor:colors.border,color:colors.text}}>
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
                          {/* NEW-FU-604 (Batch 29 item 1): show the course's credits in the
                              Sections sidebar (read-only) — the same number that drives each
                              section's legal pattern/duration in the edit panel. */}
                          {(() => {
                            const cr = courses.find(c => (c.course_code ?? c.courseCode) === courseCode)?.credits;
                            return cr != null
                              ? <span style={{ opacity: 0.65, fontWeight: 400 }}> · {cr} cr</span>
                              : null;
                          })()}
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
                                  color:colors.text,fontWeight:700}}>{sectionLabel(grp)}</span>
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
                                    if (!await confirm({
                                      title: `Remove the ${courseCode} ${sectionLabel(grp)} section?`,
                                      message: 'All meeting days for this section will be removed.',
                                      confirmLabel: 'Remove',
                                    })) {
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
              title={isArchived ? lockedTitle : 'Add instructor'}><Ico name="plus" /></button>
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
          {/* NEW-FU-637 (issue #5): dedicated office-hours subscreen for one instructor. */}
          {ohManagerFor && (
            <OfficeHoursManagerModal
              instructor={ohManagerFor}
              onClose={() => setOhManagerFor(null)}
              showToast={showToast}
            />
          )}

          {/* NEW-FU-643 (issue #3): ref + the computed uniform name font size, applied to every
              .sp-filter-name via the --sp-name-fz variable so all names share one fitting size. */}
          <ul className="sp-list" ref={instrListRef} style={{ '--sp-name-fz': `${nameFontSize}px` }}>
            {/* NEW-FU-420 (Phase 104 item 6): always render alphabetically, case-insensitively —
                a newly-added instructor is appended to state, so sorting keeps the list ordered. */}
            {sortedInstructors.map(instr => (
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
                  {/* NEW-FU-642 (issue #1a): name on its OWN line (always full, never clipped by a
                      flag); the triage flag sits on a SECOND line below it — so a long name like
                      "NUHA ABDULRAHMAN ALBADI" renders complete while the readable text flag stays
                      visible and never steals the name's horizontal width. */}
                  <span className="sp-filter-textcol">
                    <span className="sp-filter-nameline">
                      <FilterName>{instr.name}</FilterName>
                      {/* NEW-FU-425 (Phase 104 item 2): clearly label placeholder instructors. */}
                      {instr.is_dummy && <span className="sp-dummy-badge" title="Placeholder added by Suggest — add a real instructor to replace it">dummy</span>}
                    </span>
                    {/* NEW-FU-608 (Batch 30 item 1): triage flag — no classes / no office hours. */}
                    <StatusFlag type={instructorFlag(instr.id)} />
                  </span>
                  {filterId===instr.id && <span className="sp-check"><Ico name="check" /></span>}
                </button>
                {/* NEW-FU-637 (issue #5): distinct control to MANAGE office hours. Selects the
                    instructor so the schedule + its sections load (for the #2b check), then opens
                    the subscreen. NEW-FU-644 (issue #3): DISABLED on a finalized/archived term —
                    no sub-screen opens when locked (only Unlock + Export are permitted). */}
                {/* NEW-FU-641 (issue #1): the clock + × controls live in a FIXED, non-shrinking
                    actions group so they can never be pushed off-frame by a long instructor name. */}
                <span className="sp-filter-actions">
                <button type="button" className="sp-oh-btn"
                  title={isArchived ? lockedTitle : 'Manage office hours'}
                  disabled={isArchived}
                  onClick={() => { selectFilter(instr.id); setOhManagerFor(instr); }}>
                  <Ico name="clock" />
                </button>
                <button className="sp-del-btn"
                  title={isArchived ? lockedTitle : 'Remove instructor'}
                  disabled={isArchived}
                  onClick={async () => {
                    // NEW-M17: confirm before deleting (cascades to office_hours,
                    // sets sections.instructor_id to NULL across all schedules).
                    if (!await confirm({
                      title: `Delete instructor "${instr.name}"?`,
                      message: 'Their office hours will be removed and any sections they teach will lose their instructor.',
                      confirmLabel: 'Delete',
                    })) return;
                    try { await removeInstructor(instr.id); }
                    catch (err) {
                      showToast && showToast(
                        err.response?.data?.error || 'Failed to delete instructor.',
                        'error',
                      );
                    }
                  }}>×</button>
                </span>
              </li>
            ))}
          </ul>
          {/* NEW-FU-637 (issue #5): the inline office-hours editor was removed from the sidebar.
              Office hours are now managed via the per-instructor "Office Hours" button (above),
              which opens the dedicated OfficeHoursManagerModal (rendered at the foot of this panel). */}
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
              title={isArchived ? lockedTitle : 'Add venue'}><Ico name="plus" /></button>
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
                  {/* NEW-FU-648: mirror the instructor row's two-line layout (FU-642) — venue name on
                      its OWN line (never wrapped or squeezed by the cap + flag), with capacity and the
                      triage flag on a second line below. Fixes the broken venue rows where long names
                      like "04-001-A" wrapped to 2–3 lines and shoved the cap/flag out of place. */}
                  <span className="sp-filter-textcol">
                    <span className="sp-filter-nameline">
                      <FilterName>{v.name}</FilterName>
                      {/* NEW-FU-425 (Phase 104 item 2): clearly label placeholder venues. */}
                      {v.is_dummy && <span className="sp-dummy-badge" title="Placeholder added by Suggest — add a real venue to replace it">dummy</span>}
                    </span>
                    <span className="sp-venue-metaline">
                      {!v.is_dummy && <span className="sp-venue-cap">cap.{v.capacity}</span>}
                      {/* NEW-FU-608 (Batch 30 item 1): triage flag — venue with no classes. */}
                      <StatusFlag type={venueFlag(v.id)} />
                    </span>
                  </span>
                  {filterId===v.id && <span className="sp-check"><Ico name="check" /></span>}
                </button>
                <button className="sp-del-btn"
                  title={isArchived ? lockedTitle : 'Remove venue'}
                  disabled={isArchived}
                  onClick={async () => {
                    // NEW-M17: confirm before deleting (sections.venue_id is
                    // set to NULL across every schedule that used this venue).
                    if (!await confirm({
                      title: `Delete venue "${v.name}"?`,
                      message: 'Any sections currently scheduled in this venue will lose their venue assignment.',
                      confirmLabel: 'Delete',
                    })) return;
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
            title={isArchived ? lockedTitle : 'Add course'}><Ico name="plus" /></button>
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
              // NEW-FU-577 (Batch 22): sort each tier's courses by course NUMBER so a
              // newly added course slots into numeric order (e.g. SWE 564 between 555 and
              // 587) instead of appending to the bottom of its tier in insertion order.
              const cs = [...grouped[level]].sort((a, b) =>
                (a.course_code || a.courseCode || '').localeCompare(
                  b.course_code || b.courseCode || '', undefined, { numeric: true }));
              return (
            <div key={level} className="sp-level-group">
              <div className="sp-level-header" style={{color: LEVEL_COLORS[level]?.text, borderColor: LEVEL_COLORS[level]?.border}}>
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
function FilterName({ children }) {
  // NEW-FU-633 (issue #4): one-line ellipsis (driven by .sp-filter-name CSS). The prior
  // useRenderStrategy + useFitText shrink-and-wrap (FU-298/305) produced multi-line,
  // shrunk names; the full name + email now live in the parent row's title tooltip.
  return <span className="sp-filter-name">{children}</span>;
}

// ── DraggableCourse ──────────────────────────────────────────────────────────
function DraggableCourse({ course, level, onRemove, showToast, isArchived = false, lockedTitle = '' }) {
  // NEW-FU-205: when isArchived, useDraggable's `disabled` prevents the
  // drag-handle from initiating any drag operation. Spreading listeners +
  // attributes is still safe; dnd-kit no-ops them under disabled.
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: course.id, disabled: isArchived });
  const { confirm } = useApp();   // NEW-FU-547 (Batch 15 Issue 5): themed confirm
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
      <span className="sp-course-code" style={{ color: colors.text }}>
        {course.course_code}
        {/* NEW-FU-604 (Batch 29 item 1): credits shown on the course card (read-only). */}
        {course.credits != null && <span style={{ opacity: 0.6, fontWeight: 400 }}> · {course.credits} cr</span>}
      </span>
      <span className="sp-course-name" ref={nameRef} style={{ color: colors.text }}>{course.name}</span>
      <button
        className="sp-del-btn"
        title={isArchived ? lockedTitle : 'Remove course'}
        disabled={isArchived}
        onPointerDown={e => e.stopPropagation()}
        onClick={async e => {
          e.stopPropagation();
          if (!await confirm({ title: `Delete ${course.course_code} and ALL its sections?`, confirmLabel: 'Delete' })) return;
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
