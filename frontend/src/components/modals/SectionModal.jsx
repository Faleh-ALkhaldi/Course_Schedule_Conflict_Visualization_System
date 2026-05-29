import React, { useState, useEffect } from 'react';
import { useApp, DAYS, DAY_DURATION, fromMinutes, toMinutes, sectionLabel } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
// NEW-FU-280/281 (Phase 56): replace window.prompt-based "+ New"
// shortcuts with proper modals. SectionModal nests them so the user
// stays in flow — the new entity is auto-selected on close.
import AddInstructorModal from './AddInstructorModal.jsx';
import AddVenueModal      from './AddVenueModal.jsx';
import './SectionModal.css';

// NEW-FU-277 (Phase 53 #1): full day-template table mirroring
// backend/src/domain/sectionPattern.js. The modal walks this table to
// build the pattern pills, then filters by what's legal for the
// selected course's (credits, hasLab, duration). A pattern that's
// listed but not legal renders disabled (with a tooltip) instead of
// being hidden — so the user sees the full universe + can learn what
// shapes the system supports.
const DAY_TEMPLATES = {
  STT:    { days: ['Sunday','Tuesday','Thursday'], label: 'Sun / Tue / Thu' },
  MW:     { days: ['Monday','Wednesday'],          label: 'Mon / Wed'       },
  ST:     { days: ['Sunday','Tuesday'],            label: 'Sun / Tue'       },
  TT:     { days: ['Tuesday','Thursday'],          label: 'Tue / Thu'       },
  // ONE_DAY in the modal collapses into the existing "Single day" mode —
  // the user picks the specific day in the day dropdown below.
  single: { days: null,                            label: 'Single day'      },
};

// Mirror of legalDayTemplatesForCourse in sectionPattern.js. Per-credit
// rules — change one side, change both.
function legalDayTemplatesForCourse({ credits, hasLab, duration }) {
  const c = Number(credits);
  const d = Number(duration);
  if (c === 1 && d === 50) return ['single'];
  if (c === 2 && d === 50) return ['ST', 'MW', 'TT'];
  if (c === 2 && d === 75) return ['single'];
  if (c === 3 && d === 50) return hasLab ? ['STT', 'ST', 'MW', 'TT'] : ['STT'];
  if (c === 3 && d === 75) return ['MW', 'ST', 'TT'];
  if (c === 4 && d === 50) return ['STT', 'ST', 'MW', 'TT'];
  if (c === 4 && d === 75) return ['MW', 'ST', 'TT'];
  return [];
}

function legalDurationsForCourse({ credits, hasLab }) {
  const c = Number(credits);
  if (c === 1) return [50];
  if (c === 2) return [50, 75];
  if (c === 3) return [50, 75];
  if (c === 4) return [50, 75];
  return [50, 75];  // fallback
}

// DAY_GROUPS / GROUP_DAYS retained for the edit-mode "existing group"
// inference logic — those work off the pre-Phase-53 simple STT/MW/single
// model and don't need to know about ST/TT.
const DAY_GROUPS = {
  Sunday:'STT', Tuesday:'STT', Thursday:'STT',
  Monday:'MW',  Wednesday:'MW',
};
const GROUP_DAYS = {
  STT: ['Sunday','Tuesday','Thursday'],
  MW:  ['Monday','Wednesday'],
  ST:  ['Sunday','Tuesday'],
  TT:  ['Tuesday','Thursday'],
};
// NEW-FU-113: duration defaults + limits by section type (mirrors
// SECTION_DURATION in backend/src/config/constants.js). The quick-pick
// buttons render exactly these values; the numeric input enforces the
// limits as min/max attributes.
const DURATION_DEFAULTS_BY_TYPE = {
  Lec: [50, 75],
  Lab: [50, 75, 165],
};
const DURATION_LIMITS_BY_TYPE = {
  Lec: { min: 50, max: 75  },
  Lab: { min: 50, max: 165 },
};

export default function SectionModal({ mode, initial, onClose, showToast }) {
  // NEW-FU-35: Escape dismisses the modal, matching the established pattern
  // in SoftConflictModal / OfficeHourModal / GroupChangeModal.
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // NEW-FU-280/281 (Phase 56): `dispatch` removed — the new "+ New"
  // sub-modals call addInstructor / addVenue from context, which
  // already dispatch ADD_INSTRUCTOR / ADD_VENUE on their own. The old
  // path required a manual SET_REFERENCE dispatch because it bypassed
  // context and used api.* directly.
  const { courses, instructors, venues, schedule, sections,
          addSection, moveSection, removeSection, loadView, view, filterId,
        } = useApp();

  // NEW-FU-280/281 (Phase 56): tracks which "+ New" sub-modal is open.
  // Null = no sub-modal; 'instructor' or 'venue' = the corresponding
  // AddXModal is mounted. Auto-clears on the sub-modal's onClose.
  const [subModal, setSubModal] = useState(null);

  const existing = initial?.section;

  // ── Determine existing group ──────────────────────────────────────────────
  const existingGroup = existing ? (DAY_GROUPS[existing.day] ?? 'single') : null;

  const [tab, setTab] = useState(mode === 'edit' ? 'time' : 'info');
  // 'info' = instructor/venue/section# | 'time' = day/startTime/duration

  // NEW-FU-39: derive the initial dayMode from `initial?.day` instead of
  // hard-coding 'STT' for add mode. Dropping a course card onto Monday used
  // to open the modal with dayMode='STT', which then triggered the
  // dayMode-watching effect below and silently rewrote day→Sunday and
  // duration→50. Reading DAY_GROUPS[initial.day] first means a Monday drop
  // opens with dayMode='MW' (day=Monday, duration=75) — matching the user's
  // drop target. Falls back to 'STT' only when no initial day was provided
  // (e.g., the "+ Add Section" sidebar button).
  const initialDayMode =
    initial?.dayMode ??
    (mode === 'add'
      ? (DAY_GROUPS[initial?.day] ?? 'STT')
      : (existingGroup ?? 'single'));

  const [form, setForm] = useState({
    courseId:      existing?.courseId      ?? existing?.course_id      ?? initial?.courseId ?? '',
    instructorId:  existing?.instructorId  ?? existing?.instructor_id  ?? '',
    venueId:       existing?.venueId       ?? existing?.venue_id       ?? '',
    sectionNumber: existing?.sectionNumber ?? existing?.section_number ?? '',
    dayMode:       initialDayMode,
    day:           existing?.day ?? initial?.day ?? 'Sunday',
    startTime:     (existing?.startTime ?? existing?.start_time ?? initial?.startTime ?? '08:00').substring(0,5),
    duration: existing
      ? String(toMinutes(existing.endTime ?? existing.end_time) - toMinutes(existing.startTime ?? existing.start_time))
      : String(initial?.duration ?? 50),
    // NEW-FU-104: section_type is 'Lec' by default for new sections.
    // The selector below only renders when the course has has_lab=true.
    sectionType:   existing?.sectionType   ?? existing?.section_type   ?? 'Lec',
    // NEW-FU-277 (Phase 53 #2): gender selector. Defaults to 'M' (matches
    // the column default in mig 014). The visible section label preview
    // ("§01" vs "F01") below updates live from this field.
    gender:        existing?.gender ?? 'M',
  });

  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState('');

  // NEW-FU-95 + NEW-FU-104 + NEW-FU-114: in 'add' mode, auto-fill
  // sectionNumber with the next unused two-digit value in the type-scoped
  // range (Lec: 01..49; Lab: 50..99). Re-runs when the user picks a
  // different course OR changes the section type — the type-scoped range
  // changes, so a stale auto-fill from the other range would be wrong.
  // Manual override is preserved when the user has typed a value that's
  // still in the new range; otherwise the new auto-fill replaces it.
  useEffect(() => {
    if (mode !== 'add') return;
    if (!form.courseId || !schedule) return;
    let cancelled = false;
    api.getNextSectionNumber(schedule.id, form.courseId, form.sectionType)
      .then(res => {
        if (cancelled) return;
        setForm(f => {
          // Replace the auto-fill if:
          //  - the field is empty, OR
          //  - the current value sits in the OPPOSITE type's range (stale
          //    from a previous Lec ↔ Lab toggle)
          const current = f.sectionNumber;
          const range = form.sectionType === 'Lab'
            ? /^[5-9][0-9]$/
            : /^(0[1-9]|[1-4][0-9])$/;
          if (current === '' || !range.test(current)) {
            return { ...f, sectionNumber: res.nextSectionNumber };
          }
          return f;
        });
      })
      .catch(() => { /* 409 (all in use) or transient — leave field as-is */ });
    return () => { cancelled = true; };
  }, [mode, form.courseId, form.sectionType, schedule]);

  // NEW-FU-113: when section type changes, adapt the dayMode and duration
  // to match what makes sense for the new type:
  //   - Switching to 'Lab' → force dayMode='single' (labs are once-weekly
  //     per spec) and pick 165 min (the typical lab block) if the current
  //     duration is outside the Lab range or matches an old Lec default.
  //   - Switching to 'Lec' → restore the FU-39 derived dayMode from
  //     initial.day (or 'STT' fallback) and pick 50/75 if current duration
  //     is outside Lec range.
  // Skipped in edit mode — the existing section's dayMode/duration are
  // authoritative there.
  useEffect(() => {
    if (mode !== 'add') return;
    setForm(f => {
      const next = { ...f };
      const limits = DURATION_LIMITS_BY_TYPE[f.sectionType];
      const curDur = parseInt(f.duration, 10);
      if (f.sectionType === 'Lab') {
        if (f.dayMode !== 'single') next.dayMode = 'single';
        if (!Number.isInteger(curDur) || curDur < limits.min || curDur > limits.max
            || curDur === 50 || curDur === 75) {
          // Default Lab to 165 unless the user has already typed a value
          // that fits and isn't one of the Lec defaults.
          next.duration = '165';
        }
      } else {
        // Lec: clamp duration into 50..75 if it's out of range.
        if (!Number.isInteger(curDur) || curDur < limits.min || curDur > limits.max) {
          next.duration = '50';
        }
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.sectionType, mode]);

  // NEW-FU-39 + NEW-FU-49: when the user actively *toggles* dayMode (not on
  // mount), pick a representative day for the new pattern and only nudge
  // duration to the pattern default IF the current duration still matches
  // the previous pattern's default. This preserves a user-typed custom
  // duration (e.g., 60 min) across pattern toggles, while still doing the
  // helpful auto-fill for users who haven't customised. The previous useRef
  // skip-on-mount gate keeps the initial render from clobbering the values
  // we just derived in `initialDayMode` above.
  const prevDayModeRef = React.useRef(initialDayMode);
  useEffect(() => {
    if (mode !== 'add') return;
    if (prevDayModeRef.current === form.dayMode) return; // mount or no real change
    const prev = prevDayModeRef.current;
    prevDayModeRef.current = form.dayMode;

    setForm(f => {
      const next = { ...f };
      // Move day to the new pattern's lead day if the current day doesn't
      // belong to the new pattern's day set.
      if (form.dayMode === 'STT' && !GROUP_DAYS.STT.includes(f.day)) next.day = 'Sunday';
      else if (form.dayMode === 'MW' && !GROUP_DAYS.MW.includes(f.day)) next.day = 'Monday';
      // NEW-FU-57: when transitioning FROM single, prevDefault is null and
      // the old guard `f.duration === prevDefault` was always false — so the
      // pattern default was never populated, leaving e.g. single@45min stuck
      // at 45 even when toggled to MW (which expects 75). Treat single's
      // null prevDefault as "always overwrite" so users get the pattern
      // default they're switching into, matching the helpful auto-fill
      // behaviour they get on initial render. Pattern → pattern transitions
      // still preserve a user-customised duration via the FU-49 guard.
      const prevDefault = prev === 'STT' ? '50' : prev === 'MW' ? '75' : null;
      const newDefault  = form.dayMode === 'STT' ? '50' : form.dayMode === 'MW' ? '75' : null;
      const isFromSingle = prev === 'single';
      if (newDefault && (f.duration === prevDefault || isFromSingle)) {
        next.duration = newDefault;
      }
      return next;
    });
  }, [form.dayMode, mode]);

  function computeEnd() {
    const [h,m] = form.startTime.split(':').map(Number);
    return fromMinutes(h*60+m+parseInt(form.duration||0));
  }

  // Days that will be created/affected
  function getAffectedDays() {
    // NEW-FU-277 (Phase 53 #1): use the DAY_TEMPLATES table so ST/TT also
    // expand correctly. STT/MW stay the same; 'single' falls through to
    // the user-picked day.
    const tmpl = DAY_TEMPLATES[form.dayMode];
    if (tmpl?.days) return tmpl.days;
    return [form.day];
  }

  async function handleSubmitInfo(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (mode === 'add') {
        // NEW-FU-277 (Phase 53 #5): external courses (SWE 399) don't need
        // a section row — the seed-time placeholder already covers it.
        // Submitting from external mode is a no-op (just close).
        if (courseIsExternal) {
          showToast(`✓ ${selectedCourse.course_code} noted — no section row needed.`, 'success');
          onClose();
          return;
        }
        const days = getAffectedDays();
        await addSection(schedule.id, {
          courseId:      form.courseId,
          instructorId:  form.instructorId  || undefined,
          venueId:       form.venueId       || undefined,
          sectionNumber: form.sectionNumber,
          // NEW-FU-104: forward sectionType. Backend validates that 'Lab'
          // is only legal on a course with has_lab=true.
          sectionType:   form.sectionType,
          // NEW-FU-277 (Phase 53 #2): forward gender so the M/F pool
          // distinction makes it to the DB row instead of always defaulting
          // to 'M'. Controller validates 'M'|'F'.
          gender:        form.gender,
          days,
          day:           days[0],
          startTime:     form.startTime,
          endTime:       computeEnd(),
        });
        showToast(`✓ Section added (${days.length} day${days.length>1?'s':''}).`, 'success');
      } else {
        // Edit info only — propagates to all siblings
        await api.updateSection(existing.id, {
          infoOnly:      true,
          instructorId:  form.instructorId  || null,
          venueId:       form.venueId       || null,
          sectionNumber: form.sectionNumber,
          // NEW-FU-104: forward sectionType on edit too (propagates to all
          // sibling rows via the service's updateSectionInfo path).
          sectionType:   form.sectionType,
        });
        showToast('✓ Section info updated for all linked days.', 'success');
        if (schedule) loadView(schedule.id, view, filterId);
      }
      onClose();
    } catch(err) {
      setError(err.response?.data?.error || err.message || 'Failed.');
    } finally { setBusy(false); }
  }

  async function handleSubmitTime(e) {
    e.preventDefault();
    if (!existing) return;
    setBusy(true); setError('');
    // NEW-FU-4 + NEW-FU-8: coerce a cross-day edit into a time-only move
    // ONLY when a sibling already occupies the target day. Single-day
    // sections that happen to live on an STT/MW day stay freely movable.
    const origDay = existing.day;
    const existingCourseId = existing.courseId ?? existing.course_id;
    const existingSecNum   = existing.sectionNumber ?? existing.section_number;
    const hasSiblingOnTarget = sections.some(s =>
      s.id !== existing.id &&
      (s.courseId      ?? s.course_id)      === existingCourseId &&
      (s.sectionNumber ?? s.section_number) === existingSecNum &&
      s.day === form.day
    );
    let effectiveDay = form.day;
    if (hasSiblingOnTarget) {
      effectiveDay = origDay;
    }
    try {
      await moveSection(existing.id, {
        instructorId: form.instructorId || null,
        venueId:      form.venueId      || existing.venueId      || existing.venue_id,
        day:          effectiveDay,
        startTime:    form.startTime,
        endTime:      computeEnd(),
      });
      showToast('✓ Time updated for all linked days.', 'success');
      onClose();
    } catch(err) {
      // M-4: surface the API error message rather than a generic string
      setError(err.response?.data?.error || 'Failed to update time.');
    } finally { setBusy(false); }
  }

  async function handleDelete() {
    if (!existing) return;
    const label = `${existing.courseCode??existing.course_code} ${sectionLabel(existing)}`;
    if (!window.confirm(`Delete ${label} and all linked days in its group?`)) return;
    setBusy(true);
    try {
      await removeSection(existing.id);
      showToast('Section deleted.', 'info');
      onClose();
    } catch { setError('Failed to delete.'); setBusy(false); }
  }

  const selectedCourse = courses.find(c => c.id === form.courseId);
  // NEW-FU-104: courses get has_lab from the backend (FU-94). For
  // courses with has_lab=false, the Lec/Lab selector is hidden and
  // the section is implicitly a lecture. When the selected course
  // changes to one without has_lab, force sectionType back to 'Lec'
  // so a stale 'Lab' value doesn't reach the controller.
  const courseHasLab = !!(selectedCourse && selectedCourse.has_lab);
  useEffect(() => {
    if (!courseHasLab && form.sectionType !== 'Lec') {
      setForm(f => ({ ...f, sectionType: 'Lec' }));
    }
  }, [courseHasLab, form.sectionType]);

  // NEW-FU-275 (Phase 52 #6): capstone- and external-awareness.
  // Capstone courses (SWE 411/412/413/414) don't have venues by design —
  // hide the venue selector and don't suggest one. External courses
  // (SWE 399 off-campus internship) have NO scheduling at all — short
  // out the entire form and tell the user the section is auto-managed.
  const courseIsCapstone = !!(selectedCourse && selectedCourse.is_capstone);
  const courseIsExternal = !!(selectedCourse && selectedCourse.is_external);

  // NEW-FU-275 (Phase 52 #6): single-day pattern is illegal for courses
  // whose credit hours need ≥150 min/week of lecture. A 50-min single-
  // day section would only deliver 50 min/week, tripping R-15. Mirror
  // the Suggest modal's validation table by disabling the Single day
  // pill when the course's credits make it infeasible. Lab sections are
  // exempt — labs default to once-weekly per spec.
  const singleDayBlocked = !!(
    selectedCourse &&
    form.sectionType === 'Lec' &&
    Number(selectedCourse.credits) >= 3 &&
    !courseIsExternal
  );

  useEffect(() => {
    // When the user picks a capstone course, blank out venueId so a
    // previously-typed venue doesn't sneak through on submit.
    if (courseIsCapstone && form.venueId) {
      setForm(f => ({ ...f, venueId: '' }));
    }
  }, [courseIsCapstone, form.venueId]);

  // NEW-FU-275 (Phase 52 #6): auto-flip dayMode to STT when the user
  // picks a course that makes Single day infeasible (3+ credit Lec).
  useEffect(() => {
    if (form.dayMode === 'single' && singleDayBlocked) {
      setForm(f => ({ ...f, dayMode: 'STT' }));
    }
  }, [singleDayBlocked, form.dayMode]);

  // NEW-FU-275 (Phase 52 #6): inline "+ New" creators for course /
  // instructor / venue. Each opens a tiny prompt; on submit the new
  // record is POSTed via the existing admin route, the result is added
  // to the reference list locally, and the new id is auto-selected so
  // the user can continue without re-opening the modal.
  // NEW-FU-277 (Phase 53 #4): client-side conflict preview. Walks the
  // current term's sections and flags the rules that would fire if the
  // form's currently-entered values were submitted as-is. Doesn't replace
  // the backend conflict engine — it just gives the user a heads-up so
  // they don't hit Submit blind. Each check mirrors one rule:
  //   • R-04 — same instructor at any overlapping (day, time) slot
  //   • R-05 — same venue at any overlapping (day, time) slot
  //   • R-10 — venue missing (non-capstone, non-external)
  //   • R-11/R-12 — section type vs venue type mismatch
  // Soft-vs-hard mirrors the backend severity table.
  const conflictPreview = React.useMemo(() => {
    if (mode !== 'add') return null;
    if (!form.courseId) return null;
    if (courseIsExternal) return null;
    const days = (() => {
      const tmpl = DAY_TEMPLATES[form.dayMode];
      if (tmpl?.days) return tmpl.days;
      return [form.day];
    })();
    const startMin = toMinutes(form.startTime);
    const endMin   = startMin + parseInt(form.duration || 0, 10);
    const findings = [];
    // R-04: instructor overlap
    if (form.instructorId) {
      const conflictsInstr = sections.filter(s =>
        s.instructorId === form.instructorId &&
        days.includes(s.day) &&
        toMinutes(s.startTime) < endMin && startMin < toMinutes(s.endTime)
      );
      if (conflictsInstr.length) {
        findings.push({
          rule: 'R-04', severity: 'Hard',
          msg: `Instructor already teaching ${conflictsInstr[0].courseCode} ${sectionLabel(conflictsInstr[0])} at this slot`,
        });
      }
    }
    // R-05: venue overlap (skip for capstone — venue rules don't apply)
    if (form.venueId && !courseIsCapstone) {
      const conflictsVen = sections.filter(s =>
        s.venueId === form.venueId &&
        days.includes(s.day) &&
        toMinutes(s.startTime) < endMin && startMin < toMinutes(s.endTime)
      );
      if (conflictsVen.length) {
        findings.push({
          rule: 'R-05', severity: 'Hard',
          msg: `Venue already occupied by ${conflictsVen[0].courseCode} ${sectionLabel(conflictsVen[0])} at this slot`,
        });
      }
    }
    // R-10: missing venue (non-capstone)
    if (!form.venueId && !courseIsCapstone) {
      findings.push({ rule: 'R-10', severity: 'Soft',
        msg: 'No venue assigned — soft warning' });
    }
    // R-11/R-12: type mismatch
    const selVenue = venues.find(v => v.id === form.venueId);
    if (selVenue && selVenue.type !== 'Multipurpose') {
      if (form.sectionType === 'Lab' && selVenue.type !== 'Laboratory') {
        findings.push({ rule: 'R-11', severity: 'Soft',
          msg: `Lab section in non-Lab venue (${selVenue.type})` });
      }
      if (form.sectionType === 'Lec' && selVenue.type === 'Laboratory') {
        findings.push({ rule: 'R-12', severity: 'Soft',
          msg: 'Lecture section in Laboratory venue' });
      }
    }
    return findings;
  }, [mode, form, sections, venues, courseIsExternal, courseIsCapstone]);

  // NEW-FU-277 (Phase 53 #3): partition instructors into "prior" (taught
  // the selected course in any prior term) and "other" so the dropdown
  // surfaces the most-likely candidates first. Without a selected course,
  // there's no notion of "prior" so the whole list goes in "other".
  const groupedInstructors = React.useMemo(() => {
    if (!form.courseId) return { prior: [], other: instructors };
    const priorIds = new Set(
      sections
        .filter(s => s.courseId === form.courseId && s.instructorId)
        .map(s => s.instructorId)
    );
    return {
      prior: instructors.filter(i => priorIds.has(i.id)),
      other: instructors.filter(i => !priorIds.has(i.id)),
    };
  }, [form.courseId, sections, instructors]);

  // NEW-FU-277 (Phase 53 #3): venue free/busy annotation. For the form's
  // current (day, time), compute which venues are busy in the current
  // term's sections. Rendered as a "(busy)" suffix on the option label.
  const venueBusyIds = React.useMemo(() => {
    if (mode !== 'add' || !form.startTime || !form.duration) return new Set();
    const days = (() => {
      const tmpl = DAY_TEMPLATES[form.dayMode];
      if (tmpl?.days) return tmpl.days;
      return [form.day];
    })();
    const startMin = toMinutes(form.startTime);
    const endMin   = startMin + parseInt(form.duration || 0, 10);
    const busy = new Set();
    for (const s of sections) {
      if (!s.venueId || !days.includes(s.day)) continue;
      if (toMinutes(s.startTime) < endMin && startMin < toMinutes(s.endTime)) {
        busy.add(s.venueId);
      }
    }
    return busy;
  }, [mode, form, sections]);

  // NEW-FU-280/281 (Phase 56): replaced the two window.prompt-based
  // quick-creators with launchers for AddInstructorModal / AddVenueModal.
  //
  // Why: window.prompt has no labels, no validation, no consistent
  // chrome — three modal dialogs popping up in sequence ("Name?",
  // "Email?", "Capacity?") is jarring next to the labelled, validated
  // section form right behind them. Worse, the venue prompts gave the
  // user no signal that the registrar XX-YYY naming convention applies
  // here too, so any free-form string slipped through.
  //
  // The new flow:
  //   1. User clicks "+ New" next to Instructor or Venue.
  //   2. Sub-modal mounts on top of the section modal (z-index handled
  //      by the .sm-overlay rule — both use position:fixed).
  //   3. On successful create, the sub-modal's onCreated callback fires
  //      with the new entity. We auto-select its id in the section form
  //      so the user can continue without re-opening a dropdown.
  //   4. Sub-modal closes itself (its internal onClose).
  function quickCreateInstructor() { setSubModal('instructor'); }
  function quickCreateVenue()      { setSubModal('venue'); }

  return (
    <>
    <div className="sm-overlay" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="sm-card">
        <div className="sm-header">
          <div>
            <h2 className="sm-title">
              {mode==='add' ? '+ Add Section'
                : `${existing?.courseCode??existing?.course_code} ${sectionLabel(existing)}`}
            </h2>
            {mode==='edit' && existingGroup && (
              <div className="sm-group-badge">
                {existingGroup==='STT' ? '📅 Sun / Tue / Thu group'
                  : existingGroup==='MW' ? '📅 Mon / Wed group'
                  : '📅 Single day'}
                <span className="sm-group-note"> — changes apply to all days in group</span>
              </div>
            )}
          </div>
          <button className="sm-close" onClick={onClose}>×</button>
        </div>

        {mode==='edit' && (
          <div className="sm-tabs">
            <button className={tab==='time'?'active':''} onClick={()=>setTab('time')}>📍 Time &amp; Day</button>
            <button className={tab==='info'?'active':''} onClick={()=>setTab('info')}>✏️ Info</button>
          </div>
        )}

        {/* ── ADD MODE or INFO tab ── */}
        {(mode==='add' || tab==='info') && (
          <form className="sm-form" onSubmit={handleSubmitInfo}>
            {mode==='add' && (
              <>
                <div className="sm-field">
                  <label>Course</label>
                  <select value={form.courseId} onChange={e=>setForm(f=>({...f,courseId:e.target.value}))} required>
                    <option value="">— Select course —</option>
                    {/* NEW-FU-275 (Phase 52 #6): badge capstone (◇) and
                        external (✈) courses inline so the user sees at a
                        glance which courses trigger the special behaviors. */}
                    {['Freshman','Sophomore','Junior','Senior','Graduate'].map(level => {
                      const cs = courses.filter(c=>c.academic_level===level);
                      if (!cs.length) return null;
                      return (
                        <optgroup key={level} label={level}>
                          {cs.map(c=>{
                            const tag = c.is_external ? ' ✈ external'
                                      : c.is_capstone ? ' ◇ capstone'
                                      : '';
                            return <option key={c.id} value={c.id}>{c.course_code} — {c.name}{tag}</option>;
                          })}
                        </optgroup>
                      );
                    })}
                  </select>
                  {/* NEW-FU-275 (Phase 52 #6): per-course notices */}
                  {courseIsCapstone && (
                    <small style={{color:'var(--slate-500)', fontSize:'.72rem'}}>
                      ◇ Capstone course — venue field is hidden; meets online or anywhere on campus.
                    </small>
                  )}
                  {courseIsExternal && (
                    <div className="sm-info-box" style={{marginTop:8}}>
                      ✈ <strong>{selectedCourse.course_code}</strong> is an off-campus
                      internship — no instructor, venue, schedule, or section needed.
                      The course already exists in the term sidebar; no section
                      record is required.
                    </div>
                  )}
                </div>

                {/* NEW-FU-277 (Phase 53 #2): Gender selector. KFUPM keeps
                    M and F sections as disjoint pools (same numeric range
                    01–49 / 50–99 but different audience). The display
                    layer reconstructs "F11" from gender='F' + number='11'. */}
                <div className="sm-field">
                  <label>Gender</label>
                  <div style={{display:'flex', gap:8}}>
                    {[['M','Male (§)'], ['F','Female (F)']].map(([g, lbl]) => (
                      <button key={g} type="button"
                        className={`sm-daymode-btn ${form.gender===g?'active':''}`}
                        onClick={()=>setForm(f=>({...f, gender: g}))}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="sm-field">
                  <label>Section #</label>
                  {/* NEW-FU-95 + NEW-FU-104 + NEW-FU-277 (Phase 53 #2):
                      placeholder + help text are now type-and-gender-aware.
                      Lec range is 01–49, Lab range is 50–99; the live preview
                      below shows the final display label ("§01" vs "F01"). */}
                  <input placeholder={form.sectionType === 'Lab' ? '50 (auto)' : '01 (auto)'}
                    value={form.sectionNumber}
                    pattern={form.sectionType === 'Lab' ? '[5-9][0-9]' : '0[1-9]|[1-4][0-9]'}
                    title={`${form.sectionType} range: ${form.sectionType === 'Lab' ? '50–99' : '01–49'} (two-digit, zero-padded)`}
                    onChange={e=>setForm(f=>({...f,sectionNumber:e.target.value}))} required />
                  <small style={{color:'var(--slate-500)',fontSize:'.72rem'}}>
                    {form.sectionType} range: <strong>{form.sectionType === 'Lab' ? '50–99' : '01–49'}</strong> &nbsp;·&nbsp;
                    {/* NEW-FU-282 (Phase 56): match the §F-XX (hyphenated)
                        convention used everywhere else. The old preview
                        used "F01" (no §, no hyphen) which mismatched the
                        sidebar + grid rendering — users saw the section
                        listed differently in three different places. */}
                    Display label: <strong>{sectionLabel({ gender: form.gender, sectionNumber: form.sectionNumber || '__' })}</strong>
                  </small>
                </div>

                {/* NEW-FU-104: Lec/Lab selector — only shown for courses
                    that have has_lab=true. For lecture-only courses the
                    field is hidden and the section is implicitly Lec. */}
                {courseHasLab && (
                  <div className="sm-field">
                    <label>Section type</label>
                    <div style={{display:'flex', gap:8}}>
                      {['Lec','Lab'].map(t => (
                        <button key={t} type="button"
                          className={`sm-daymode-btn ${form.sectionType===t?'active':''}`}
                          onClick={()=>setForm(f=>({...f,sectionType:t}))}>
                          {t === 'Lec' ? '📘 Lecture' : '🧪 Lab'}
                        </button>
                      ))}
                    </div>
                    <small style={{color:'var(--slate-500)',fontSize:'.72rem'}}>
                      Lab sections should go in Laboratory venues; lectures in Lecture Halls.
                    </small>
                  </div>
                )}

                {/* NEW-FU-277 (Phase 53 #1): full day-template pill grid.
                    Walks every key in DAY_TEMPLATES and renders one button
                    per. Patterns not legal for the chosen course's
                    (credits, hasLab, duration) combination render disabled
                    with a tooltip — visible-but-grayed lets the user
                    discover what shapes the system supports. Capstones
                    (is_capstone) collapse to a single "Capstone — flexible
                    meeting time" hint and disable the pattern picker
                    entirely (they meet wherever convenient). */}
                {!courseIsCapstone ? (
                  <div className="sm-field">
                    <label>Schedule type</label>
                    <div className="sm-daymode-group">
                      {Object.entries(DAY_TEMPLATES).map(([key, tmpl]) => {
                        const legal = selectedCourse
                          ? legalDayTemplatesForCourse({
                              credits: selectedCourse.credits,
                              hasLab: form.sectionType === 'Lab' && selectedCourse.has_lab,
                              duration: parseInt(form.duration, 10),
                            }).includes(key)
                          : true; // no course selected yet — leave all enabled
                        const disabled = !legal || (key === 'single' && singleDayBlocked);
                        const tip = !legal
                          ? `Not a legal pattern for ${selectedCourse?.course_code ?? 'this course'} (${selectedCourse?.credits ?? '?'}-credit ${form.sectionType}, ${form.duration} min)`
                          : (key === 'single' && singleDayBlocked
                              ? 'Single day insufficient for credit coverage (R-15)'
                              : undefined);
                        return (
                          <button key={key} type="button"
                            className={`sm-daymode-btn ${form.dayMode===key?'active':''}`}
                            disabled={disabled}
                            title={tip}
                            onClick={()=>setForm(f=>({...f, dayMode: key}))}>
                            {tmpl.label}
                          </button>
                        );
                      })}
                    </div>
                    {form.dayMode === 'single' && (
                      <select value={form.day} onChange={e=>setForm(f=>({...f,day:e.target.value}))}
                        style={{marginTop:6}}>
                        {DAYS.map(d=><option key={d} value={d}>{d}</option>)}
                      </select>
                    )}
                  </div>
                ) : (
                  <div className="sm-info-box" style={{marginTop:4}}>
                    ◇ <strong>Capstone</strong> — meeting time is flexible.
                    The Schedule Type pills are hidden; just pick a day +
                    start time below if the team has a fixed meeting slot.
                    Otherwise leave at defaults.
                  </div>
                )}

                <div className="sm-row">
                  <div className="sm-field">
                    <label>Start time</label>
                    <input type="time" value={form.startTime}
                      onChange={e=>setForm(f=>({...f,startTime:e.target.value}))} required />
                  </div>
                  <div className="sm-field">
                    <label>Duration (min)</label>
                    {/* NEW-FU-113: per-type quick-pick buttons followed by a
                        numeric input bounded to the type's legal range. Lec
                        offers 50/75; Lab offers 50/75/165. The numeric input
                        accepts any integer in [min, max] for the type — the
                        user can type any value the spec allows. */}
                    <div style={{display:'flex', gap:4, marginBottom:4}}>
                      {DURATION_DEFAULTS_BY_TYPE[form.sectionType].map(d => (
                        <button key={d} type="button"
                          className={`sm-daymode-btn ${form.duration===String(d)?'active':''}`}
                          style={{padding:'4px 8px', fontSize:'.75rem'}}
                          onClick={()=>setForm(f=>({...f, duration: String(d)}))}>
                          {d}m
                        </button>
                      ))}
                    </div>
                    <input type="number" value={form.duration}
                      min={DURATION_LIMITS_BY_TYPE[form.sectionType].min}
                      max={DURATION_LIMITS_BY_TYPE[form.sectionType].max}
                      onChange={e=>setForm(f=>({...f,duration:e.target.value}))} required />
                    <small style={{color:'var(--slate-500)', fontSize:'.7rem'}}>
                      {form.sectionType} range: {DURATION_LIMITS_BY_TYPE[form.sectionType].min}–{DURATION_LIMITS_BY_TYPE[form.sectionType].max} min
                    </small>
                  </div>
                  <div className="sm-field">
                    <label>End time</label>
                    <div className="sm-readonly">{computeEnd()}</div>
                  </div>
                </div>
              </>
            )}

            <div className="sm-field">
              <label>
                Instructor <span className="sm-optional">(soft warning if empty)</span>
                {/* NEW-FU-275 (Phase 52 #6): inline + New instructor */}
                <button type="button" className="sm-inline-add" onClick={quickCreateInstructor}
                  style={{marginLeft:8, fontSize:'.7rem', padding:'2px 8px',
                          background:'var(--slate-50)', border:'1px solid var(--slate-300)',
                          borderRadius:4, cursor:'pointer'}}>+ New</button>
              </label>
              {/* NEW-FU-277 (Phase 53 #3): split into prior (taught this
                  course before) and other. Prior pool lands first with a
                  header so the user picks the natural candidate. */}
              <select value={form.instructorId} onChange={e=>setForm(f=>({...f,instructorId:e.target.value}))}>
                <option value="">— No instructor —</option>
                {groupedInstructors.prior.length > 0 && (
                  <optgroup label="Taught this course before">
                    {groupedInstructors.prior.map(i =>
                      <option key={i.id} value={i.id}>{i.name}</option>
                    )}
                  </optgroup>
                )}
                <optgroup label={groupedInstructors.prior.length ? 'All other faculty' : 'All faculty'}>
                  {groupedInstructors.other.map(i =>
                    <option key={i.id} value={i.id}>{i.name}</option>
                  )}
                </optgroup>
              </select>
            </div>

            {/* NEW-FU-275 (Phase 52 #6): hide the venue field entirely when
                a capstone course is selected — venue doesn't apply. */}
            {!courseIsCapstone && (
              <div className="sm-field">
                <label>
                  Venue <span className="sm-optional">(optional)</span>
                  <button type="button" className="sm-inline-add" onClick={quickCreateVenue}
                    style={{marginLeft:8, fontSize:'.7rem', padding:'2px 8px',
                            background:'var(--slate-50)', border:'1px solid var(--slate-300)',
                            borderRadius:4, cursor:'pointer'}}>+ New</button>
                </label>
                {/* NEW-FU-277 (Phase 53 #3): group venues by type and
                    mark venues busy at the form's day/time slot. Busy
                    venues are still selectable (the user may want to
                    override) but the "(busy)" suffix warns them they'll
                    trigger an R-05 conflict. */}
                <select value={form.venueId} onChange={e=>setForm(f=>({...f,venueId:e.target.value}))}>
                  <option value="">— No venue —</option>
                  {['LectureHall', 'Multipurpose', 'Laboratory'].map(typeGroup => {
                    const vs = venues.filter(v => v.type === typeGroup);
                    if (!vs.length) return null;
                    return (
                      <optgroup key={typeGroup} label={typeGroup}>
                        {vs.map(v => {
                          const isBusy = venueBusyIds.has(v.id);
                          return (
                            <option key={v.id} value={v.id}>
                              {v.name}{isBusy ? '  · busy at this slot' : ''}
                            </option>
                          );
                        })}
                      </optgroup>
                    );
                  })}
                </select>
              </div>
            )}

            {/* NEW-FU-277 (Phase 53 #4): conflict preview. Shows the user
                which rules would fire if they submitted with the current
                form values. Doesn't block submit — same UX as the soft-
                confirm flow elsewhere. */}
            {conflictPreview && conflictPreview.length > 0 && (
              <div className="sm-info-box" style={{
                marginTop: 8,
                background: 'var(--amber-50, #fffbeb)',
                border: '1px solid var(--amber-200, #fde68a)',
              }}>
                <strong>Submitting would create {conflictPreview.length} conflict{conflictPreview.length !== 1 ? 's' : ''}:</strong>
                <ul style={{margin:'4px 0 0 16px', padding:0, fontSize:'.78rem'}}>
                  {conflictPreview.map((f, i) => (
                    <li key={i}>
                      <strong>{f.rule}</strong> ({f.severity}) — {f.msg}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {conflictPreview && conflictPreview.length === 0 && form.courseId && !courseIsExternal && (
              <div className="sm-info-box" style={{
                marginTop: 8,
                background: 'var(--green-50, #f0fdf4)',
                border: '1px solid var(--green-200, #bbf7d0)',
                fontSize:'.78rem',
              }}>
                ✓ No conflicts would be created.
              </div>
            )}

            {mode==='edit' && (
              <>
                <div className="sm-field">
                  <label>Section # <span className="sm-optional">(updates all days in group)</span></label>
                  <input value={form.sectionNumber}
                    pattern="0[1-9]|[1-9][0-9]" title="Two-digit zero-padded, 01–99"
                    onChange={e=>setForm(f=>({...f,sectionNumber:e.target.value}))} />
                </div>
                {/* NEW-FU-104: Lec/Lab selector for edit mode — only shown
                    when the underlying course has has_lab=true. Updates
                    propagate to all sibling days via updateSectionInfo. */}
                {courseHasLab && (
                  <div className="sm-field">
                    <label>Section type <span className="sm-optional">(updates all days in group)</span></label>
                    <div style={{display:'flex', gap:8}}>
                      {['Lec','Lab'].map(t => (
                        <button key={t} type="button"
                          className={`sm-daymode-btn ${form.sectionType===t?'active':''}`}
                          onClick={()=>setForm(f=>({...f,sectionType:t}))}>
                          {t === 'Lec' ? '📘 Lecture' : '🧪 Lab'}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {error && <div className="sm-error">{error}</div>}
            <div className="sm-actions">
              {mode==='edit' && (
                <button type="button" className="sm-btn-delete" onClick={handleDelete} disabled={busy}>Delete all</button>
              )}
              <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
              {/* NEW-FU-275 (Phase 52 #6) + NEW-FU-277 (Phase 53 #5):
                  external courses (SWE 399) need no section row. Submit
                  is wired to just close the modal — no API call, no DB
                  insert. Button label flips to "OK, course noted" to
                  match the no-op behavior. */}
              <button type="submit" className="sm-btn-save" disabled={busy}>
                {busy ? '…' : mode==='add'
                  ? (courseIsExternal ? 'OK, course noted' : 'Add Section')
                  : 'Save Info'}
              </button>
            </div>
          </form>
        )}

        {/* ── EDIT TIME tab ── */}
        {mode==='edit' && tab==='time' && (
          <form className="sm-form" onSubmit={handleSubmitTime}>
            <div className="sm-info-box">
              Moving the time will shift <strong>all days</strong> in this group to the same start/end time.
            </div>
            <div className="sm-row">
              <div className="sm-field">
                <label>Day</label>
                <select value={form.day} onChange={e=>setForm(f=>({...f,day:e.target.value}))}>
                  {existingGroup && existingGroup!=='single'
                    ? GROUP_DAYS[existingGroup].map(d=><option key={d} value={d}>{d}</option>)
                    : DAYS.map(d=><option key={d} value={d}>{d}</option>)
                  }
                </select>
              </div>
              <div className="sm-field">
                <label>Start time</label>
                <input type="time" value={form.startTime}
                  onChange={e=>setForm(f=>({...f,startTime:e.target.value}))} required />
              </div>
              <div className="sm-field">
                <label>Duration (min)</label>
                {/* NEW-FU-113: type-scoped quick-picks + bounded input on
                    edit too. The form.sectionType comes from the existing
                    section (so editing a Lab shows [50, 75, 165]). */}
                <div style={{display:'flex', gap:4, marginBottom:4}}>
                  {DURATION_DEFAULTS_BY_TYPE[form.sectionType].map(d => (
                    <button key={d} type="button"
                      className={`sm-daymode-btn ${form.duration===String(d)?'active':''}`}
                      style={{padding:'4px 8px', fontSize:'.75rem'}}
                      onClick={()=>setForm(f=>({...f, duration: String(d)}))}>
                      {d}m
                    </button>
                  ))}
                </div>
                <input type="number" value={form.duration}
                  min={DURATION_LIMITS_BY_TYPE[form.sectionType].min}
                  max={DURATION_LIMITS_BY_TYPE[form.sectionType].max}
                  onChange={e=>setForm(f=>({...f,duration:e.target.value}))} required />
              </div>
            </div>
            <div className="sm-field sm-end-preview">
              End time: <strong>{computeEnd()}</strong>
            </div>
            {error && <div className="sm-error">{error}</div>}
            <div className="sm-actions">
              <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
              <button type="submit" className="sm-btn-save" disabled={busy}>
                {busy ? '…' : 'Move All Days'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>

    {/* NEW-FU-280/281 (Phase 56): nested "+ New" sub-modals. They sit
        outside the main .sm-overlay so a click on the sub-modal's own
        backdrop closes only the sub-modal — not the entire section
        flow. On successful create, onCreated auto-selects the new id
        in the form. */}
    {subModal === 'instructor' && (
      <AddInstructorModal
        onClose={() => setSubModal(null)}
        showToast={showToast}
        onCreated={(instructor) =>
          setForm(f => ({ ...f, instructorId: instructor.id }))}
      />
    )}
    {subModal === 'venue' && (
      <AddVenueModal
        onClose={() => setSubModal(null)}
        showToast={showToast}
        onCreated={(venue) =>
          setForm(f => ({ ...f, venueId: venue.id }))}
      />
    )}
    </>
  );
}
