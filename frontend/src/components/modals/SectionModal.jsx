import React, { useState, useEffect } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useApp, DAYS, DAY_DURATION, fromMinutes, toMinutes, sectionLabel, TIME_WINDOWS } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
// NEW-FU-280/281 (Phase 56): replace window.prompt-based "+ New"
// shortcuts with proper modals. SectionModal nests them so the user
// stays in flow — the new entity is auto-selected on close.
import AddInstructorModal from './AddInstructorModal.jsx';
import AddVenueModal      from './AddVenueModal.jsx';
// NEW-FU-510 (Batch 1): shared section-number normalize + range validation,
// so a single-digit "2" is accepted and treated as "02" everywhere.
import { padSectionNumber, isValidSectionNumber } from '../../utils/sectionNumber.js';
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
// NEW-FU-532 (Batch 11): MIRROR of backend sectionPattern.legalDayTemplatesForCourse —
// keep these two in lock-step. 75 min → 3/4-credit 2-day only; 50-min meetings-per-week
// is dictated by credits; 3-credit-with-lab is a 2-day lecture (3-day Sun/Tue/Thu is the
// no-lab 3-credit pattern); 4-credit is a 3-day lecture (+ lab); 0-credit (capstone
// SWE 413) is a single 50-min meeting.
function legalDayTemplatesForCourse({ credits, hasLab, duration }) {
  const c = Number(credits);
  const d = Number(duration);
  if (d === 75) return (c === 3 || c === 4) ? ['MW', 'ST', 'TT'] : [];
  if (c === 0) return ['single'];
  if (c === 1) return ['single'];
  if (c === 2) return ['ST', 'MW', 'TT'];
  if (c === 3) return hasLab ? ['ST', 'MW', 'TT'] : ['STT'];
  if (c === 4) return ['STT'];
  return [];
}

// NEW-FU-532 (Batch 11): MIRROR of backend legalDurationsForCourse. 75 min is reserved
// for 3- and 4-credit courses; 0/1/2-credit are 50 min only.
function legalDurationsForCourse({ credits, hasLab }) {
  const c = Number(credits);
  if (c === 0 || c === 1 || c === 2) return [50];
  if (c === 3 || c === 4) return [50, 75];
  return [50];  // fallback
}

// NEW-FU-530 (Batch 10 Issue 1): identify a section group's pattern from its ACTUAL
// day-set, not a single ambiguous anchor day. The old DAY_GROUPS[day] map read one
// day → one pattern, but a day can belong to several patterns (Sunday is in both
// Sun/Tue/Thu AND Sun/Tue), so a Sun/Tue group was mis-read as Sun/Tue/Thu — wrong
// selector, wrong validation message, and a corrupting restructure. Match the sorted
// day-set against DAY_TEMPLATES.
function patternFromDays(days) {
  const key = [...new Set(days)].sort().join('|');
  for (const [name, t] of Object.entries(DAY_TEMPLATES)) {
    if (t.days && [...t.days].sort().join('|') === key) return name;
  }
  return 'single';
}

// NEW-FU-531 (Batch 10 Issue 4): every day-pattern that EXISTS for a course's
// credits, across all its legal durations — so the picker can SHOW the full set and
// disable the ones illegal for the current duration (with a reason) rather than
// hiding them. 3–4 cr → 2-day + 3-day; 2 cr → 2-day (+ 1-day at 75 min); 1/0 cr →
// single day only. A 2-credit course never sees a 3-day pattern.
function creditPatterns({ credits, hasLab }) {
  const set = new Set([
    ...legalDayTemplatesForCourse({ credits, hasLab, duration: 50 }),
    ...legalDayTemplatesForCourse({ credits, hasLab, duration: 75 }),
  ]);
  // stable display order
  return ['STT', 'MW', 'ST', 'TT', 'single'].filter(p => set.has(p));
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
  Lab: [50, 75, 160],
  // NEW-FU-498 (Phase 122): Project/Thesis meet in long single blocks.
  Prj: [75, 100, 160],
  Ths: [75, 100, 160],
};
const DURATION_LIMITS_BY_TYPE = {
  Lec: { min: 50, max: 75  },
  Lab: { min: 50, max: 160 },
  Prj: { min: 50, max: 180 },
  Ths: { min: 50, max: 180 },
};

// NEW-FU-505 (Phase 123): display-only formatter for the computed end time.
// The native <input type="time"> start picker renders in the OS locale
// ("10:00 AM" on a 12-hour macOS), while computeEnd() returns the raw 24h
// "10:50" — the modal showed two formats side by side. This formats the END
// display through the same locale (toLocaleTimeString with no explicit
// locale = the user's), so both fields read identically. The raw 24h value
// is still what Save submits — payloads are untouched.
function fmtTimeForDisplay(t) {
  const [h, m] = String(t).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return t;
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// NEW-FU-401 (Phase 101): inline SVG icon set (Lucide-style, currentColor) that
// replaces the emoji glyphs the old modal used (📅 📍 ✏️ 📘 🧪 ◇ ✈ ✓). SVG icons
// inherit text colour, scale crisply, and match the rest of the modernised
// system. Each is a 24×24 stroked path; size + colour come from CSS (.sm-ico).
const ICONS = {
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  clock:    'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  info:     'M12 16v-4M12 8h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  user:     'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  pin:      'M12 21s-6-5.7-6-10a6 6 0 1 1 12 0c0 4.3-6 10-6 10zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  hash:     'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  book:     'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  flask:    'M9 3h6M10 3v6.5L5 18a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-8.5V3M7.5 14h9',
  trash:    'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
  alert:    'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  check:    'M20 6 9 17l-5-5',
  plus:     'M12 5v14M5 12h14',
  edit:     'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  layers:   'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
};
function Ico({ name, className }) {
  const d = ICONS[name];
  if (!d) return null;
  return (
    <svg className={`sm-ico ${className || ''}`} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

export default function SectionModal({ mode, initial, onClose, showToast }) {
  useFocusTrap();
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
  // NEW-FU-510 (Batch 1): `conflicts` (backend snapshot) is no longer read here —
  // the edit banner is now driven by the live, form-derived `conflictPreview`.
  const { courses, instructors, venues, schedule, sections,
          addSection, moveSection, removeSection, loadView, view, filterId,
          recordMutation,   // NEW-FU-549 (Batch 16): record restructure as one undo step
        } = useApp();

  // NEW-FU-280/281 (Phase 56): tracks which "+ New" sub-modal is open.
  // Null = no sub-modal; 'instructor' or 'venue' = the corresponding
  // AddXModal is mounted. Auto-clears on the sub-modal's onClose.
  const [subModal, setSubModal] = useState(null);

  const existing = initial?.section;

  // ── Determine existing group ──────────────────────────────────────────────
  // NEW-FU-530 (Batch 10 Issue 1): derive the pattern from the section group's REAL
  // day-set (all linked rows), not the single anchor day — DAY_GROUPS[day] was
  // ambiguous (Sunday → Sun/Tue/Thu even for a Sun/Tue group), which mis-labelled
  // the selector, the validation message, and the restructure.
  const existingGroup = existing
    ? patternFromDays(
        sections
          .filter(s => (s.courseId ?? s.course_id) === (existing.courseId ?? existing.course_id)
                    && (s.sectionNumber ?? s.section_number) === (existing.sectionNumber ?? existing.section_number))
          .map(s => s.day)
      )
    : null;

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
  // NEW-FU-533 (Batch 10 Issue 2): explicit acknowledgement to save a change that
  // creates a conflict — ONLY offered when no conflict-free slot exists ("schedule is
  // tight"). When a conflict-free alternative exists, the save stays blocked instead.
  const [overrideConflict, setOverrideConflict] = useState(false);
  // NEW-FU-541 (Batch 13 Issue 2): constrained, move-only Quick Fix. status:
  // 'idle' | 'planning' | 'ready' (feasible w/ moves) | 'applying' | 'infeasible' | 'error'.
  const [autoFix, setAutoFix] = useState({ status: 'idle', moves: [], error: '' });
  // Invalidation token: bumped whenever the proposed change inputs change, so an
  // in-flight plan that resolves AFTER an edit is dropped instead of showing stale moves.
  const autoFixToken = React.useRef(0);
  // Bumped after an auto-fix is applied to force the conflict preview to re-fetch.
  const [previewNonce, setPreviewNonce] = useState(0);
  // NEW-FU-417 (Phase 103 items 3+4): LIVE, runtime section-number validation.
  // Recomputed every render from the current input, so an out-of-range value is
  // flagged the instant it is typed — no waiting for Save, and no bare native
  // HTML5 validation bubble (the forms are noValidate). The message is specific
  // and tells the user the exact valid range for the section's type/gender.
  const sectionNumError = (() => {
    const num  = String(form.sectionNumber ?? '').trim();
    const type = form.sectionType === 'Lab' ? 'Lab' : 'Lecture';
    if (!num) return null; // emptiness is handled by the "required" submit guard
    // NEW-FU-510 (Batch 1): normalize a single digit ("2" → "02") before the
    // range check, so 1–9 is accepted; the shared util keeps this in lockstep
    // with the submit guard and the backend.
    if (isValidSectionNumber(num, form.sectionType)) return null;
    const pfx  = form.gender === 'F' ? 'F-' : '';
    const lo   = form.sectionType === 'Lab' ? '50' : '01';
    const hi   = form.sectionType === 'Lab' ? '99' : '49';
    const shown = padSectionNumber(num);
    return `${type} sections use ${pfx}${lo}–${pfx}${hi}. “${pfx}${shown}” is out of range — use a ${pfx}${lo}–${pfx}${hi} number.`;
  })();
  // NEW-FU-401 (Phase 101): in-app delete confirmation replaces the jarring
  // native window.confirm() — a styled confirm step inside the same modal
  // chassis, consistent with the rest of the system's in-app dialogs.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
  //     per spec) and pick 160 min (the typical lab block) if the current
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
          // Default Lab to 160 unless the user has already typed a value
          // that fits and isn't one of the Lec defaults.
          next.duration = '160';
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
    // NEW-FU-453 (Phase 108): clamp the total so a bad/huge duration can never
    // overflow into a garbage end time — fromMinutes only formats a valid
    // minute-of-day. durationError/timeError block submit on out-of-range input.
    const total = (h||0)*60 + (m||0) + (parseInt(form.duration,10) || 0);
    return fromMinutes(Math.max(0, Math.min(total, 24*60 - 1)));
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

  async function handleSubmitInfo(e, opts = {}) {
    e.preventDefault();
    // NEW-FU-411 (Phase 102 item 4): enforce the type-scoped section-number range
    // client-side (the backend also rejects, but a clear inline message beats a
    // round-trip "constraint violation"). External courses have no section row.
    if (!(mode === 'add' && courseIsExternal)) {
      // NEW-FU-510 (Batch 1): a single digit ("2") normalizes to "02" and is
      // accepted; only a genuinely out-of-range value is rejected here.
      if (form.sectionNumber && !isValidSectionNumber(form.sectionNumber, form.sectionType)) {
        const lo = form.sectionType === 'Lab' ? '50' : '01';
        const hi = form.sectionType === 'Lab' ? '99' : '49';
        const pfx = form.gender === 'F' ? 'F-' : '';
        setError(`Section number must be ${pfx}${lo}–${pfx}${hi} for a ${form.sectionType === 'Lab' ? 'Lab' : 'Lecture'} section.`);
        return;
      }
    }
    // NEW-FU-453 (Phase 108): hard block submit on an out-of-range duration or an
    // out-of-window time, even if the button guard were bypassed (defense in depth).
    if (durationError || timeError) { setError(durationError || timeError); return; }
    // NEW-FU-482 (Phase 116): a finalized/archived term is read-only.
    if (scheduleLocked) { setError(lockedMsg); return; }
    // NEW-FU-481 (Phase 116): course + section number are required (defense in depth).
    if (courseMissing)        { setError('Choose a course before adding this section.'); return; }
    if (sectionNumberMissing) { setError('Enter a section number before adding this section.'); return; }
    // NEW-FU-475 (Phase 114): instructor + venue are required (defense in depth — the
    // Save button is already disabled, this also blocks a bypassed submit).
    if (instructorMissing) { setError('Choose an instructor before adding this section.'); return; }
    if (venueMissing)      { setError('Choose a venue before adding this section.'); return; }
    // NEW-FU-510 (Batch 1): UI-level venue-type gate (defense in depth — the
    // Save button is already disabled while mismatched). Applies to add + edit-info.
    if (venueTypeMismatch) {
      setError(`A ${form.sectionType === 'Lab' ? 'Lab' : 'Lecture'} section needs a ${form.sectionType === 'Lab' ? 'Laboratory' : 'Lecture Hall'} (or Multipurpose) venue.`);
      return;
    }
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
          // NEW-FU-510 (Batch 1): submit the canonical two-digit value ("2" → "02")
          // so the stored value — and the UNIQUE (schedule, course, number, day)
          // duplicate check — operate on the padded form.
          sectionNumber: padSectionNumber(form.sectionNumber),
          // NEW-FU-104: forward sectionType. Backend validates that 'Lab'
          // is only legal on a course with has_lab=true.
          sectionType:   form.sectionType,
          // NEW-FU-277 (Phase 53 #2): forward gender so the M/F pool
          // distinction makes it to the DB row instead of always defaulting
          // to 'M'. Controller validates 'M'|'F'.
          gender:        form.gender,
          days,
          day:           days[0],
          // NEW-FU-573 (Batch 20): opts.startTime/endTime override the form for the
          // one-click "move this section to a conflict-free slot" action (applyMoveSelf).
          startTime:     opts.startTime ?? form.startTime,
          endTime:       opts.endTime   ?? computeEnd(),
        });
        showToast(`✓ Section added (${days.length} day${days.length>1?'s':''}).`, 'success');
      } else {
        // Edit info only — propagates to all siblings
        await api.updateSection(existing.id, {
          infoOnly:      true,
          instructorId:  form.instructorId  || null,
          venueId:       form.venueId       || null,
          // NEW-FU-510 (Batch 1): canonical two-digit value on edit too.
          sectionNumber: padSectionNumber(form.sectionNumber),
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

  async function handleSubmitTime(e, opts = {}) {
    e.preventDefault();
    if (!existing) return;
    if (scheduleLocked) { setError(lockedMsg); return; }
    // NEW-FU-478 (Phase 115): block an out-of-window / out-of-range time on EDIT too
    // (this guard used to run only on the Add form). Show the clear window/duration
    // note instead of letting a bad time through to a confusing backend message.
    if (timeError || durationError) { setError(timeError || durationError); return; }
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
    // NEW-FU-528 (Batch 9 Issue 1): if the duration change forced a different day
    // pattern (e.g. 3-credit 50min Sun/Tue/Thu → 75min Mon/Wed), RESTRUCTURE the group.
    // NEW-FU-543 (Batch 14 Issue 2): DELETE the old group FIRST, then create the new
    // pattern. The previous create-first ordering collided with the section's OWN rows
    // on any day shared between the old and new pattern (e.g. Sun/Tue/Thu → Sun/Tue, or
    // single-Tue → Tue/Thu) — the UNIQUE (schedule, course, section_number, day) index
    // then surfaced as the PHANTOM "section number already used" error even though no
    // OTHER section was involved. Deleting first frees those days. To keep the original
    // create-first safety (no data loss on failure), we snapshot the old group and
    // restore it if the new create fails.
    const targetGroup = form.dayMode;
    const patternChanged = targetGroup && targetGroup !== existingGroup
      && !(targetGroup === 'single' && existingGroup === 'single');
    if (patternChanged) {
      const targetDays = (targetGroup !== 'single') ? DAY_TEMPLATES[targetGroup].days : [form.day];
      const origType  = existing.sectionType ?? existing.section_type;
      const origInstr = existing.instructorId ?? existing.instructor_id ?? null;
      const origVenue = existing.venueId ?? existing.venue_id ?? null;
      const origStart = String(existing.startTime ?? existing.start_time ?? form.startTime).slice(0, 5);
      const origEnd   = String(existing.endTime ?? existing.end_time ?? computeEnd()).slice(0, 5);
      const origDays  = sections
        .filter(s => (s.courseId ?? s.course_id) === existingCourseId
                  && (s.sectionNumber ?? s.section_number) === existingSecNum)
        .map(s => s.day);
      const restoreDays = origDays.length ? origDays : [existing.day];
      try {
        const { createSection, deleteSection } = await import('../../api/index.js');
        await deleteSection(existing.id);   // remove the whole old group FIRST
        try {
          await createSection(schedule.id, {
            courseId:      existingCourseId,
            instructorId:  form.instructorId || origInstr,
            venueId:       form.venueId      || origVenue,
            sectionNumber: existingSecNum,
            sectionType:   origType,
            // NEW-FU-560 (audit P1-5): preserve gender across a pattern restructure.
            // The delete+recreate dropped gender → createSection defaulted it to 'M',
            // silently turning a §F section male (data corruption). Mirror origType.
            gender:        existing.gender ?? form.gender ?? 'M',
            days:          targetDays,
            day:           targetDays[0],
            startTime:     form.startTime,
            endTime:       computeEnd(),
          });
        } catch (createErr) {
          // Restore the original group so nothing is lost.
          try {
            await createSection(schedule.id, {
              courseId: existingCourseId, instructorId: origInstr, venueId: origVenue,
              sectionNumber: existingSecNum, sectionType: origType,
              gender: existing.gender ?? form.gender ?? 'M',   // audit P1-5: preserve gender on restore
              days: restoreDays, day: restoreDays[0],
              startTime: origStart, endTime: origEnd,
            });
          } catch { /* best-effort restore */ }
          throw createErr;
        }
        recordMutation?.('change meeting pattern');   // NEW-FU-549: one undo step
        showToast('✓ Meeting pattern updated.', 'success');
        loadView(schedule.id, view, filterId);
        onClose();
      } catch(err) {
        setError(err.response?.data?.error || 'Failed to update the meeting pattern.');
      } finally { setBusy(false); }
      return;
    }
    try {
      await moveSection(existing.id, {
        instructorId: form.instructorId || null,
        venueId:      form.venueId      || existing.venueId      || existing.venue_id,
        day:          effectiveDay,
        // NEW-FU-573 (Batch 20): opts override for the one-click self-move (applyMoveSelf).
        startTime:    opts.startTime ?? form.startTime,
        endTime:      opts.endTime   ?? computeEnd(),
      });
      // NEW-FU-550 (Batch 16 fix): ALWAYS refetch from server after the edit, exactly
      // like the drag path. moveSection returns null for a GROUP update (no optimistic
      // UPSERT), so without this reload the grid kept showing the old positions — a
      // stale view that read as "the class was dropped". Reloading paints server truth.
      loadView(schedule.id, view, filterId);
      showToast('✓ Time updated for all linked days.', 'success');
      onClose();
    } catch(err) {
      // M-4: surface the API error message rather than a generic string
      setError(err.response?.data?.error || 'Failed to update time.');
    } finally { setBusy(false); }
  }

  // NEW-FU-401 (Phase 101): the actual delete now runs only after the in-app
  // confirm step (setConfirmingDelete) — no native window.confirm().
  async function handleDelete() {
    if (!existing) return;
    setConfirmingDelete(false);
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
  // changes to one without has_lab, force sectionType off 'Lab'
  // so a stale 'Lab' value doesn't reach the controller.
  // NEW-FU-498 (Phase 122): only 'Lab' requires has_lab; Lec/Prj/Ths are always
  // allowed (Prj/Ths offered on capstone courses), so don't reset those.
  const courseHasLab = !!(selectedCourse && selectedCourse.has_lab);
  useEffect(() => {
    if (!courseHasLab && form.sectionType === 'Lab') {
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
  // NEW-FU-475 (Phase 114): instructor AND venue are now REQUIRED for a real section
  // (previously a soft R-09/R-10 warning the user could save past). External courses
  // have no section row; capstone courses meet wherever convenient (no venue) — both
  // stay exempt. These gate Save + show an inline flag until both are chosen.
  const instructorMissing = !courseIsExternal && !form.instructorId;
  const venueMissing      = !courseIsExternal && !courseIsCapstone && !form.venueId;
  // NEW-FU-510 (Batch 1): venue-TYPE gate. A Lecture belongs in a LectureHall
  // (or the wildcard Multipurpose); a Lab in a Laboratory (or Multipurpose).
  // This is a UI-level gate only — it does NOT change the backend R-11/R-12
  // severity. `allowedVenueTypes` also drives the dropdown filter below; the
  // currently-selected venue is always kept selectable there so an existing
  // mismatched assignment can still be seen and corrected.
  const allowedVenueTypes = form.sectionType === 'Lab'
    ? ['Laboratory', 'Multipurpose']
    : ['LectureHall', 'Multipurpose'];
  const selectedVenue = venues.find(v => v.id === form.venueId);
  const venueTypeMismatch = !!(
    selectedVenue && !courseIsCapstone && !courseIsExternal &&
    !allowedVenueTypes.includes(selectedVenue.type)
  );
  // NEW-FU-481 (Phase 116): a section needs a COURSE and a SECTION NUMBER too — gate Save
  // on all four (course, section number, instructor, venue) so it can't be saved half-filled.
  // NEW-FU-493 (Phase 119 item 3): section-number check extended to edit mode as well.
  // courseMissing stays add-only (course is fixed on existing sections). sectionNumberMissing
  // now fires in both modes — matching the instructorMissing / venueMissing pattern — so that
  // if a user clears the number in edit mode the inline banner fires immediately rather than
  // surfacing only as a post-Save backend 400. Normal edit flow is unaffected because the
  // field is always pre-filled from the DB; the gate only triggers on deliberate clearing.
  const courseMissing        = mode === 'add' && !form.courseId;
  const sectionNumberMissing = !courseIsExternal && !String(form.sectionNumber || '').trim();
  // NEW-FU-482 (Phase 116): a finalized (or archived) term is read-only. The add/edit entry
  // points are disabled up front; this is the Save-level backstop with a plain message.
  const scheduleLocked = Boolean(schedule?.archived_at) || schedule?.status === 'Finalized';
  const lockedMsg = 'This term is finalized — unlock it first (Save → Unlock) to make changes.';

  // NEW-FU-453 (Phase 108): runtime guards for DURATION + teaching-WINDOW. An
  // out-of-range value is flagged inline + blocks submit — never accepted then
  // surfaced later as a conflict, and never overflowed into a garbage end time.
  // NEW-FU-478 (Phase 115): the DURATION + WINDOW guards now apply on EDIT too (were
  // add-only) — editing a section's time to e.g. 11:30 PM used to slip past every guard
  // and surface a confusing "duration got 29" from the clamped end. form.courseId /
  // sectionType are populated in edit mode, so the same rules apply cleanly there.
  const durLimits = DURATION_LIMITS_BY_TYPE[form.sectionType];
  const durNum    = parseInt(form.duration, 10);
  const durationError = (form.courseId && !courseIsExternal && form.duration !== '' &&
    (Number.isNaN(durNum) || durNum < durLimits.min || durNum > durLimits.max))
    ? `Duration must be ${durLimits.min}–${durLimits.max} minutes for a ${form.sectionType === 'Lab' ? 'Lab' : 'Lecture'} (got ${Number.isNaN(durNum) ? '—' : durNum}).`
    : null;
  // NEW-FU-495 (Phase 120): R-06 window. UG 07:00–17:10, GR 17:20–22:00.
  // Capstone is venue-exempt but NOT time-exempt → bound to the UG window
  // (every capstone is a UG Senior course). External courses have no section
  // row → fully exempt (timeWindow null → window check skipped).
  // NEW-FU-497 (Phase 121): SWE 412 is registrar-scheduled in the evening
  // (Tue 17:20–20:00) — the one capstone exempt from the R-06 window (timeWindow
  // null → no banner / no Save-block). Mirrors backend R06_TIME_EXEMPT_COURSES.
  const courseIsR06Exempt = selectedCourse?.course_code === 'SWE 412';
  const timeWindow = (courseIsExternal || courseIsR06Exempt)
    ? null
    : (selectedCourse?.category === 'GR' && !courseIsCapstone) ? TIME_WINDOWS.GR : TIME_WINDOWS.UG;
  const winLabel = courseIsCapstone ? 'Capstone'
    : (selectedCourse?.category === 'GR' ? 'Graduate' : 'Undergraduate');
  const startMinNow = toMinutes(form.startTime);
  const endMinNow   = startMinNow + (Number.isNaN(durNum) ? 0 : durNum);
  const timeError = (form.courseId && !courseIsExternal && timeWindow && form.startTime &&
    (startMinNow < timeWindow.start || endMinNow > timeWindow.end))
    ? `${winLabel} sections must run within ${fromMinutes(timeWindow.start)}–${fromMinutes(timeWindow.end)} (this is ${form.startTime}–${computeEnd()}).`
    : null;

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
    // NEW-FU-510 (Batch 1): the live preview now runs in EDIT mode too, not just
    // add. It recomputes from the CURRENT form on every change so the in-modal
    // banner reflects what the user is editing — replacing the stale, post-save
    // backend snapshot the edit banner used to show.
    if (!form.courseId) return null;
    if (courseIsExternal) return null;
    // NEW-FU-510 (Batch 1): in edit mode, exclude THIS section's own group
    // (every day-row sharing the section's course + number) so it never reports
    // a conflict against itself. Add mode has no own group → checks all sections.
    let pool = sections;
    if (mode === 'edit' && existing) {
      const cid = existing.courseId ?? existing.course_id;
      const num = existing.sectionNumber ?? existing.section_number;
      const ownIds = new Set(
        sections
          .filter(s => (s.courseId ?? s.course_id) === cid && (s.sectionNumber ?? s.section_number) === num)
          .map(s => s.id)
      );
      pool = sections.filter(s => !ownIds.has(s.id));
    }
    const days = (() => {
      const tmpl = DAY_TEMPLATES[form.dayMode];
      if (tmpl?.days) return tmpl.days;
      return [form.day];
    })();
    const startMin = toMinutes(form.startTime);
    const endMin   = startMin + parseInt(form.duration || 0, 10);
    // NEW-FU-560 (Batch 19): mirror the backend R-04/R-05 KFUPM dual-audience
    // exemption (R04Rule/R05Rule). A male section and the SAME course's female
    // sibling at the EXACT same slot share one physical room — same instructor and
    // venue by design, NOT a clash. This instant client preview was the one place
    // that still omitted the exemption Batch 18 added server-side, so on first open
    // (before the ~350 ms server round-trip) it fabricated a HARD self-conflict
    // (e.g. §F-12 vs §02) that the gender-aware server preview then cleared — the
    // "phantom" conflict that flashed in the panel. `toMinutes` trims seconds, so
    // the exact-slot compare is format-robust ("09:30" === "09:30:00").
    const isDualAudienceSibling = (s) =>
      (s.courseId ?? s.course_id) === form.courseId &&
      s.gender && form.gender && s.gender !== form.gender &&
      toMinutes(s.startTime) === startMin && toMinutes(s.endTime) === endMin;
    const findings = [];
    // R-04: instructor overlap
    if (form.instructorId) {
      const conflictsInstr = pool.filter(s =>
        s.instructorId === form.instructorId &&
        days.includes(s.day) &&
        toMinutes(s.startTime) < endMin && startMin < toMinutes(s.endTime) &&
        !isDualAudienceSibling(s)
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
      const conflictsVen = pool.filter(s =>
        s.venueId === form.venueId &&
        days.includes(s.day) &&
        toMinutes(s.startTime) < endMin && startMin < toMinutes(s.endTime) &&
        !isDualAudienceSibling(s)
      );
      if (conflictsVen.length) {
        findings.push({
          rule: 'R-05', severity: 'Hard',
          msg: `Venue already occupied by ${conflictsVen[0].courseCode} ${sectionLabel(conflictsVen[0])} at this slot`,
        });
      }
    }
    // NEW-FU-475 (Phase 114): the "no venue" soft warning is gone — a venue is now
    // REQUIRED (inline flag + disabled Save), so it can never be reached at submit.
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
  }, [mode, form, sections, venues, courseIsExternal, courseIsCapstone, existing]);

  // NEW-FU-521 (Batch 7 Issue 1): a HARD conflict in the live preview must BLOCK
  // Save — the modal used to only warn ("Submitting would create 2 conflicts")
  // while leaving Save enabled, so the user could commit a hard clash. Now Save is
  // disabled until the form is conflict-free (the busy pickers guide them to free
  // options). Soft findings (R-11/R-12 type hints) are advisory and do NOT block.
  // NEW-FU-534 (Batch 12): the AUTHORITATIVE conflict check runs the FULL engine on the
  // backend for the proposed change — catching student/academic-level overlaps (R-01/R-02),
  // the time window (R-06), etc., not just instructor/venue. Debounced; the client-side
  // conflictPreview gives instant feedback while the server round-trips. The endpoint also
  // reports whether ANY conflict-free start exists for the pattern → steer vs. override.
  const [serverPreview, setServerPreview] = useState({ conflicts: [], conflictFreeStartExists: true, conflictFreeStart: null, conflictFreeEnd: null, loaded: false, stale: false });
  useEffect(() => {
    if (!schedule?.id || !form.courseId || courseIsExternal) {
      setServerPreview({ conflicts: [], conflictFreeStartExists: true, conflictFreeStart: null, conflictFreeEnd: null, loaded: true, stale: false });
      return;
    }
    const days = (() => {
      const tmpl = DAY_TEMPLATES[form.dayMode];
      if (tmpl?.days) return tmpl.days;
      return form.day ? [form.day] : [];
    })();
    if (!days.length || !form.startTime || durationError || timeError) {
      setServerPreview(p => ({ ...p, stale: false }));
      return;
    }
    setServerPreview(p => ({ ...p, stale: true }));
    // Any change to the proposed section invalidates a prior move-only fix plan
    // (and drops any in-flight plan via the token bump).
    autoFixToken.current++;
    setAutoFix(a => (a.status === 'idle' ? a : { status: 'idle', moves: [], error: '' }));
    const change = {
      sectionId: existing?.id ?? null,
      courseId: form.courseId,
      instructorId: form.instructorId || null,
      venueId: form.venueId || null,
      sectionNumber: form.sectionNumber || '01',
      sectionType: form.sectionType || 'Lec',
      gender: form.gender || 'M',   // NEW-FU-555 (Batch 18): real gender → no false different-gender clashes
      days, startTime: form.startTime, endTime: computeEnd(),
    };
    const t = setTimeout(() => {
      api.previewConflicts(schedule.id, change)
        .then(data => setServerPreview({ conflicts: data.conflicts || [], conflictFreeStartExists: data.conflictFreeStartExists !== false, conflictFreeStart: data.conflictFreeStart ?? null, conflictFreeEnd: data.conflictFreeEnd ?? null, loaded: true, stale: false }))
        .catch(() => setServerPreview(p => ({ ...p, stale: false, loaded: true })));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule?.id, form.courseId, form.instructorId, form.venueId, form.sectionNumber, form.sectionType, form.dayMode, form.day, form.startTime, form.duration, courseIsExternal, durationError, timeError, previewNonce]);

  // Authoritative conflicts: the server's full-engine result once loaded, else the instant
  // client preview. Drives the conflict banner AND the Save block.
  const effectiveConflicts = serverPreview.loaded ? serverPreview.conflicts : (conflictPreview || []);
  const hasAnyConflict  = effectiveConflicts.length > 0;
  const conflictFreeAlt = serverPreview.conflictFreeStartExists;
  // NEW-FU-573 (Batch 20): a conflict has a CLEAN, one-click resolution iff either the
  // move-only Quick Fix is ready (reschedule OTHER sections) OR a conflict-free slot
  // exists for THIS section that we can actually move it to (the server now returns the
  // slot, so the "move this section" steer is a working button, not dead-end advice).
  const selfMoveAvailable  = conflictFreeAlt && !!serverPreview.conflictFreeStart;
  const cleanFixActionable = autoFix.status === 'ready' || selfMoveAvailable;

  // NEW-FU-534 (Batch 12): ANY conflict (hard OR soft) blocks Save, and while the server
  // re-check is pending Save is blocked too so nothing slips through before the full
  // engine confirms. NEW-FU-573 (Batch 20): only force a fix (block the dirty save) when a
  // fix is ACTUALLY actionable; when no clean fix exists the user may tick the explicit
  // "Save anyway" override — so Save is never blocked with no fix button offered (the old
  // dead-end where `conflictFreeAlt` alone blocked save but nothing could apply it).
  const conflictBlocksSave =
    (serverPreview.stale && !!form.courseId && !courseIsExternal)
    || (hasAnyConflict && (cleanFixActionable || !overrideConflict));

  // NEW-FU-541 (Batch 13 Issue 2): constrained, move-only Quick Fix handlers.
  // Builds the same proposed-change payload the preview uses, asks the backend for a
  // plan that reschedules OTHER groups (never drops sections, never assigns dummies),
  // and — only on explicit confirmation — applies just those time moves.
  function buildChange() {
    if (!schedule?.id || !form.courseId || courseIsExternal) return null;
    const tmpl = DAY_TEMPLATES[form.dayMode];
    const days = tmpl?.days ? tmpl.days : (form.day ? [form.day] : []);
    if (!days.length || !form.startTime || durationError || timeError) return null;
    return {
      sectionId: existing?.id ?? null,
      courseId: form.courseId,
      instructorId: form.instructorId || null,
      venueId: form.venueId || null,
      sectionNumber: form.sectionNumber || '01',
      sectionType: form.sectionType || 'Lec',
      gender: form.gender || 'M',   // NEW-FU-555 (Batch 18)
      days, startTime: form.startTime, endTime: computeEnd(),
    };
  }
  async function requestAutoFix() {
    const change = buildChange();
    if (!change) return;
    const myToken = autoFixToken.current;          // snapshot; dropped if inputs change
    setAutoFix({ status: 'planning', moves: [], error: '' });
    try {
      const data = await api.autoFixAround(schedule.id, change);
      if (autoFixToken.current !== myToken) return; // a newer edit superseded this plan
      if (data.feasible && data.moves && data.moves.length) {
        setAutoFix({ status: 'ready', moves: data.moves, error: '' });
      } else if (data.feasible) {
        // Feasible with no moves needed → nothing to reschedule; just refresh.
        setPreviewNonce(n => n + 1);
        setAutoFix({ status: 'idle', moves: [], error: '' });
      } else {
        setAutoFix({ status: 'infeasible', moves: [], error: '' });
      }
    } catch (e) {
      if (autoFixToken.current !== myToken) return;
      setAutoFix({ status: 'error', moves: [], error: 'Could not compute a fix right now.' });
    }
  }
  // NEW-FU-546 (Batch 15 Issue 2): ONE click = reschedule the other sections AND save
  // the user's own change, atomically. No leftover "now click Save" step, and never a
  // half-applied state (other sections moved but the user's section unchanged).
  async function applyAutoFix() {
    if (autoFix.status !== 'ready') return;
    setAutoFix(a => ({ ...a, status: 'applying' }));
    try {
      const moves = autoFix.moves.map(m => ({ sectionId: m.sectionId, startTime: m.toStart, endTime: m.toEnd }));
      await api.autoFixAroundApply(schedule.id, moves);
      // Immediately persist the user's own change in the SAME action. The save handler
      // (handleSubmitInfo for add, handleSubmitTime for edit) refreshes the grid, shows
      // its success toast, and closes the modal.
      setAutoFix({ status: 'idle', moves: [], error: '' });
      const noop = { preventDefault() {} };
      // Dispatch to the save handler of the ACTIVE form, not by mode: the conflict box
      // (and this offer) renders in the INFO form (add OR edit-Details) and in the TIME
      // form (edit-Time). The Time form alone uses handleSubmitTime; everything else
      // (add, edit-Details) uses handleSubmitInfo.
      const isTimeForm = mode === 'edit' && tab === 'time';
      if (isTimeForm) await handleSubmitTime(noop);
      else            await handleSubmitInfo(noop);
    } catch (e) {
      setAutoFix({ status: 'error', moves: autoFix.moves, error: e.response?.data?.error || 'Failed to reschedule the other sections.' });
    }
  }
  // NEW-FU-573 (Batch 20): the counterpart to applyAutoFix — apply the "move THIS section
  // to a conflict-free slot" resolution in ONE click. The server already verified
  // `conflictFreeStart` is clash-free for this section's exact pattern, so we simply save
  // the section at that start. Dispatches to the active form's save handler with the free
  // slot as an explicit override (no setState race), exactly like applyAutoFix. For an edit
  // this is always a same-pattern time move → handleSubmitTime; for add → handleSubmitInfo.
  async function applyMoveSelf() {
    const startTime = serverPreview.conflictFreeStart;
    const endTime   = serverPreview.conflictFreeEnd;
    if (!startTime || !endTime) return;
    const noop = { preventDefault() {} };
    if (mode === 'add') await handleSubmitInfo(noop, { startTime, endTime });
    else                await handleSubmitTime(noop, { startTime, endTime });
  }
  // Compact, de-duplicated summary of the planned moves for display.
  const autoFixMoveLines = React.useMemo(() => {
    const byUnit = new Map();
    for (const m of autoFix.moves) {
      const k = `${m.courseCode}|${m.sectionNumber}|${m.toStart}`;
      if (!byUnit.has(k)) byUnit.set(k, { courseCode: m.courseCode, sectionNumber: m.sectionNumber, toStart: m.toStart, days: [] });
      byUnit.get(k).days.push(m.day);
    }
    return [...byUnit.values()];
  }, [autoFix.moves]);

  // NEW-FU-542 (Batch 14 Issue 1): decide the move-only fix's feasibility UP FRONT.
  // As soon as the full-engine preview reports a conflict, request the plan once — so
  // the panel only ever offers a fix that truly exists (no bait-and-block dead end).
  useEffect(() => {
    if (!schedule?.id || courseIsExternal) return;
    if (!serverPreview.loaded || serverPreview.stale) return;
    if (!hasAnyConflict) return;
    if (autoFix.status !== 'idle') return;
    requestAutoFix();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule?.id, courseIsExternal, serverPreview.loaded, serverPreview.stale, hasAnyConflict, autoFix.status]);

  // Shared, self-contained conflict-resolution affordance for both conflict boxes.
  // Drives ALL of: the proactive "checking…" state, the move-only Quick-Fix offer (only
  // shown when a fix genuinely exists), the "move this section instead" steer, and the
  // last-resort "Schedule is tight … Save anyway" override. Only rendered when a
  // conflict is present (the caller gates on that).
  function renderAutoFix() {
    const s = autoFix.status;
    if (s === 'idle' || s === 'planning') {
      return <p className="sm-inline-hint">Checking whether other sections can be moved to fit…</p>;
    }
    if (s === 'applying') {
      return <p className="sm-inline-hint">Rescheduling other sections…</p>;
    }
    if (s === 'error') {
      return (
        <p className="sm-inline-error" role="alert">
          <Ico name="alert" /> <span>{autoFix.error}</span>{' '}
          <button type="button" className="sm-linkbtn" onClick={requestAutoFix}>Try again</button>
        </p>
      );
    }
    if (s === 'ready') {
      return (
        <div className="sm-autofix">
          <p className="sm-inline-hint">
            <strong>Quick Fix</strong> can keep this section's time by moving{' '}
            {autoFixMoveLines.length} other section{autoFixMoveLines.length !== 1 ? 's' : ''} to a free slot:
          </p>
          <ul className="sm-conflict-list">
            {autoFixMoveLines.map((u, i) => (
              <li key={i}>{u.courseCode} {sectionLabel({ sectionNumber: u.sectionNumber })} · {u.days.join(', ')} → <strong>{fmtTimeForDisplay(u.toStart)}</strong></li>
            ))}
          </ul>
          <div className="sm-autofix-actions">
            <button type="button" className="sm-btn-primary sm-btn-sm" onClick={applyAutoFix}>Reschedule &amp; save</button>
          </div>
          {selfMoveAvailable && (
            <p className="sm-inline-hint" style={{ marginTop: 6 }}>
              …or{' '}
              <button type="button" className="sm-linkbtn" onClick={applyMoveSelf}>
                move this section to {fmtTimeForDisplay(serverPreview.conflictFreeStart)}
              </button>{' '}instead.
            </p>
          )}
        </div>
      );
    }
    // s === 'infeasible' — moving OTHER sections can't make room. But if a conflict-free
    // slot exists for THIS section (the server returned it), offer a WORKING one-click move
    // — no more dead-end "a free time exists" advisory with no button (Batch 20 / FU-573).
    if (selfMoveAvailable) {
      return (
        <div className="sm-autofix">
          <p className="sm-inline-hint">A conflict-free time exists for this section.</p>
          <div className="sm-autofix-actions">
            <button type="button" className="sm-btn-primary sm-btn-sm" onClick={applyMoveSelf}>
              Move to {fmtTimeForDisplay(serverPreview.conflictFreeStart)} &amp; save
            </button>
          </div>
        </div>
      );
    }
    return (
      <>
        <p className="sm-inline-error" role="alert">
          <Ico name="alert" /> <span>Schedule is tight — no retiming of this or other sections clears the conflict.</span>
        </p>
        {/* NEW-FU-574 (Batch 21): the panel Quick Fix is RETIME-ONLY (a cascading
            move search — already exhausted here). For broader resolutions the panel
            intentionally doesn't attempt — reassigning instructors/venues or dropping a
            section — point the user at the grid resolver so "tight" is a path, not a
            dead end. */}
        <p className="sm-inline-hint">
          Try a different time or day-pattern — or save and use <strong>Quick&nbsp;Fix&nbsp;conflicts</strong> (in the Conflicts panel), which can also reassign instructors and venues.
        </p>
        <label className="sm-override-check">
          <input type="checkbox" checked={overrideConflict} onChange={e=>setOverrideConflict(e.target.checked)} />
          <span><strong>Save anyway</strong> (this will create a conflict).</span>
        </label>
      </>
    );
  }

  // NEW-FU-528 (Batch 9 Issue 1): the day pattern (and meetings-per-week) is a
  // function of the course's CREDITS and the meeting DURATION. A 3-credit Lec is
  // 50 min × 3 days (Sun/Tue/Thu) OR 75 min × 2 days (Mon/Wed, Sun/Tue, Tue/Thu);
  // a 2-credit Lec is 50 min × 2 days OR 75 min × 1 day; 1-credit is 50 min × 1 day.
  // These are the LEGAL patterns for the current course + duration — the Time tab
  // offers them as pills, and the effect below keeps the chosen pattern legal when
  // the duration changes. Lec only (Lab/Prj/Ths keep their single-meeting rule).
  const legalPatternsNow = React.useMemo(() => {
    if (!selectedCourse || form.sectionType !== 'Lec') return [];
    return legalDayTemplatesForCourse({ credits: selectedCourse.credits, hasLab: courseHasLab, duration: form.duration });
  }, [selectedCourse, courseHasLab, form.duration, form.sectionType]);

  // EDIT mode: when the user changes the duration so the current pattern is no longer
  // legal (e.g. 50→75 leaves a 3-day Sun/Tue/Thu group that must become 2-day),
  // auto-switch to the first legal pattern and move the anchor day onto it. Skips the
  // initial mount (reacts only to a real duration change). The add-mode pattern
  // effects above are gated to add mode, so this never double-fires.
  const durAutoRef = React.useRef(null);
  useEffect(() => {
    if (mode !== 'edit' || form.sectionType !== 'Lec') { durAutoRef.current = form.duration; return; }
    // NEW-FU-530 (Batch 10 Issue 1): react ONLY to a real duration change — never on
    // open. The previous version snapped an "illegal" section to a different pattern on
    // mount, which made the selector show the WRONG (auto-changed) pattern instead of
    // the section's real one. On open we just record the duration; the picker shows the
    // true current pattern and disables any pattern illegal for that duration (with a
    // reason). When the user actually changes the duration and the current pattern is no
    // longer legal, snap to the first legal one for the new duration.
    if (durAutoRef.current === null) { durAutoRef.current = form.duration; return; } // skip mount
    if (durAutoRef.current === form.duration) return;
    durAutoRef.current = form.duration;
    if (legalPatternsNow.length && !legalPatternsNow.includes(form.dayMode)) {
      const next = legalPatternsNow[0];
      setForm(f => ({ ...f, dayMode: next, day: DAY_TEMPLATES[next]?.days?.[0] ?? f.day }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.duration]);

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

  // NEW-FU-520 (Batch 6 Issue 3): busy-resource detection for the pickers — in
  // BOTH add and edit mode (was add-only). A resource (instructor OR venue) is
  // "busy" when another section IN THIS TERM overlaps the form's day(s)/time.
  // Busy options are DISABLED in the dropdowns below (visible + flagged, but not
  // selectable) so no edit can ever CREATE a conflict. The section being edited
  // is excluded from its own busy set so it never blocks itself.
  const busyResources = React.useMemo(() => {
    const empty = { instructors: new Set(), venues: new Set() };
    if (!form.startTime || !form.duration) return empty;
    const days = (() => {
      const tmpl = DAY_TEMPLATES[form.dayMode];
      if (tmpl?.days) return tmpl.days;
      return form.day ? [form.day] : [];
    })();
    if (!days.length) return empty;
    const startMin = toMinutes(form.startTime);
    const endMin   = startMin + parseInt(form.duration || 0, 10);
    // Exclude the edited section's OWN logical group (same course + section number)
    // so its existing meetings don't count as a self-conflict.
    const selfCourse = existing?.courseId ?? existing?.course_id ?? null;
    const selfNum    = existing?.sectionNumber ?? existing?.section_number ?? null;
    const instructors = new Set(), venues = new Set();
    for (const s of sections) {
      if (mode === 'edit' && selfCourse != null &&
          s.courseId === selfCourse && s.sectionNumber === selfNum) continue;
      // NEW-FU-560 (audit P1-6): KFUPM dual-audience exemption — a same-course
      // different-gender section at the EXACT same slot shares the room+instructor
      // by design, so it must NOT mark them "busy" (else the legitimate shared
      // instructor/venue become unpickable for the female sibling). Mirrors the
      // conflict-preview isDualAudienceSibling guard.
      if (s.courseId === form.courseId && s.gender && form.gender && s.gender !== form.gender
          && toMinutes(s.startTime) === startMin && toMinutes(s.endTime) === endMin) continue;
      if (!days.includes(s.day)) continue;
      if (toMinutes(s.startTime) < endMin && startMin < toMinutes(s.endTime)) {
        if (s.instructorId) instructors.add(s.instructorId);
        if (s.venueId)      venues.add(s.venueId);
      }
    }
    return { instructors, venues };
  }, [mode, form, sections, existing]);

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

  // NEW-FU-510 (Batch 1): EDIT-mode conflict awareness is now LIVE. It was a
  // stale snapshot of the backend `conflicts` array (only refreshed after a
  // save), so editing the time/instructor/venue inside the modal didn't update
  // the banner. We now drive the edit banner from `conflictPreview`, which
  // recomputes from the current form on every keystroke and excludes this
  // section's own group (so it never conflicts with itself). The backend
  // `conflicts` array stays the grid's source of truth and is untouched.
  const liveConflicts = mode === 'edit' ? effectiveConflicts : [];

  return (
    <>
    <div className="sm-overlay" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="sm-card" role="dialog" aria-modal="true"
        aria-label={mode==='add' ? 'Add section' : 'Edit section'}>
        <div className="sm-header">
          <div className="sm-header-text">
            <h2 className="sm-title">
              {mode==='add' ? 'Add section'
                : `${existing?.courseCode??existing?.course_code} ${sectionLabel(existing)}`}
            </h2>
            {mode==='edit' && existingGroup && (
              <div className="sm-group-badge">
                <Ico name="calendar" />
                <span>
                  {existingGroup==='STT' ? 'Sun / Tue / Thu group'
                    : existingGroup==='MW' ? 'Mon / Wed group'
                    : 'Single day'}
                  <span className="sm-group-note"> · changes apply to every day in the group</span>
                </span>
              </div>
            )}
          </div>
          <button className="sm-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {mode==='edit' && (
          <div className="sm-tabs" role="tablist">
            <button role="tab" aria-selected={tab==='time'} className={tab==='time'?'active':''} onClick={()=>setTab('time')}>
              <Ico name="clock" /> Time &amp; Day
            </button>
            <button role="tab" aria-selected={tab==='info'} className={tab==='info'?'active':''} onClick={()=>setTab('info')}>
              <Ico name="edit" /> Details
            </button>
          </div>
        )}

        {/* ── ADD MODE or INFO tab ── */}
        {/* NEW-FU-417 (Phase 103 item 4): the forms are noValidate so the bare
            native HTML5 validation bubble never appears — our styled, role=alert
            inline errors are the only feedback. */}
        {(mode==='add' || tab==='info') && (
          <form className="sm-form" noValidate onSubmit={handleSubmitInfo}>
            {mode==='add' && (
              <>
                <div className="sm-field">
                  <label htmlFor="sm-course">Course</label>
                  <select id="sm-course" value={form.courseId} onChange={e=>setForm(f=>({...f,courseId:e.target.value}))} required>
                    <option value="">— Select course —</option>
                    {['Freshman','Sophomore','Junior','Senior','Graduate'].map(level => {
                      const cs = courses.filter(c=>c.academic_level===level);
                      if (!cs.length) return null;
                      return (
                        <optgroup key={level} label={level}>
                          {cs.map(c=>{
                            const tag = c.is_external ? '  · external'
                                      : c.is_capstone ? '  · capstone'
                                      : '';
                            return <option key={c.id} value={c.id}>{c.course_code} — {c.name}{tag}</option>;
                          })}
                        </optgroup>
                      );
                    })}
                  </select>
                  {courseMissing && <p className="sm-inline-error" role="alert"><Ico name="alert" /> <span>Choose a course for this section.</span></p>}
                  {courseIsCapstone && (
                    <p className="sm-hint"><Ico name="info" /> Capstone course — the venue field is hidden; it meets online or anywhere on campus.</p>
                  )}
                  {courseIsExternal && (
                    <div className="sm-info-box sm-info-accent">
                      <Ico name="info" />
                      <span><strong>{selectedCourse.course_code}</strong> is an off-campus internship — no instructor, venue, schedule, or section row is needed. It already appears in the term sidebar.</span>
                    </div>
                  )}
                </div>

                {/* NEW-FU-277 (Phase 53 #2): Gender — KFUPM keeps M and F
                    sections as disjoint pools; the label rebuilds "F11" from
                    gender='F' + number='11'. */}
                <div className="sm-field">
                  <label>Gender</label>
                  <div className="sm-pill-group">
                    {[['M','Male'], ['F','Female']].map(([g, lbl]) => (
                      <button key={g} type="button"
                        className={`sm-pill ${form.gender===g?'active':''}`}
                        aria-pressed={form.gender===g}
                        onClick={()=>setForm(f=>({...f, gender: g}))}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>

                {/* NEW-FU-411 (Phase 102 item 4): gender + type aware. Female
                    sections show the F- prefix; the digits are range-scoped to the
                    type (Lec 01–49, Lab 50–99) for both genders. */}
                <div className="sm-field">
                  <label htmlFor="sm-secnum">Section number</label>
                  <div className={`sm-secnum-wrap${sectionNumError ? ' sm-secnum-wrap-invalid' : ''}`}>
                    {form.gender === 'F' && <span className="sm-secnum-prefix">F-</span>}
                    <input id="sm-secnum" className="sm-secnum-digits"
                      placeholder={form.sectionType === 'Lab' ? '50' : '01'}
                      value={form.sectionNumber} inputMode="numeric" maxLength={2}
                      aria-invalid={!!sectionNumError}
                      aria-describedby={sectionNumError ? 'sm-secnum-err' : 'sm-secnum-hint'}
                      onChange={e=>setForm(f=>({...f,sectionNumber:e.target.value.replace(/\D/g,'').slice(0,2)}))} />
                  </div>
                  {/* NEW-FU-417 (Phase 103 items 3+4): live, styled, role=alert error
                      the moment the value goes out of range — not on Save. */}
                  {sectionNumError
                    ? <p className="sm-inline-error" id="sm-secnum-err" role="alert"><Ico name="alert" /> <span>{sectionNumError}</span></p>
                    : sectionNumberMissing
                    ? <p className="sm-inline-error" role="alert"><Ico name="alert" /> <span>Enter a section number.</span></p>
                    : <p className="sm-hint" id="sm-secnum-hint">
                        {form.sectionType === 'Lab' ? 'Lab' : 'Lecture'} range <strong>{form.sectionType === 'Lab' ? (form.gender==='F'?'F-50–F-99':'50–99') : (form.gender==='F'?'F-01–F-49':'01–49')}</strong>
                        {' · shows as '}
                        <strong>{sectionLabel({ gender: form.gender, sectionNumber: form.sectionNumber || '__' })}</strong>
                      </p>}
                </div>

                {/* NEW-FU-104 / NEW-FU-498 (Phase 122): section-type selector.
                    Lec always; Lab for has_lab courses; Prj (Project) and Ths
                    (Thesis) for capstone courses. Shown only when >1 type applies. */}
                {(() => {
                  const TYPE_META = {
                    Lec: { icon: 'book',   label: 'Lecture' },
                    Lab: { icon: 'flask',  label: 'Lab' },
                    Prj: { icon: 'layers', label: 'Project' },
                    Ths: { icon: 'edit',   label: 'Thesis' },
                  };
                  const opts = ['Lec',
                    ...(courseHasLab ? ['Lab'] : []),
                    ...(courseIsCapstone ? ['Prj', 'Ths'] : [])];
                  if (opts.length < 2) return null;
                  return (
                    <div className="sm-field">
                      <label>Section type</label>
                      <div className="sm-pill-group">
                        {opts.map(t => (
                          <button key={t} type="button"
                            className={`sm-pill ${form.sectionType===t?'active':''}`}
                            aria-pressed={form.sectionType===t}
                            onClick={()=>setForm(f=>({...f,sectionType:t}))}>
                            <Ico name={TYPE_META[t].icon} /> {TYPE_META[t].label}
                          </button>
                        ))}
                      </div>
                      <p className="sm-hint">{courseIsCapstone
                        ? 'Projects/thesis meet in long blocks and can use any venue.'
                        : 'Labs go in Laboratory venues; lectures in Lecture Halls.'}</p>
                    </div>
                  );
                })()}

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
                    <label>Schedule pattern</label>
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
                            className={`sm-pill ${form.dayMode===key?'active':''}`}
                            aria-pressed={form.dayMode===key}
                            disabled={disabled}
                            title={tip}
                            onClick={()=>setForm(f=>({...f, dayMode: key}))}>
                            {tmpl.label}
                          </button>
                        );
                      })}
                    </div>
                    {form.dayMode === 'single' && (
                      <select className="sm-subselect" value={form.day} onChange={e=>setForm(f=>({...f,day:e.target.value}))}>
                        {DAYS.map(d=><option key={d} value={d}>{d}</option>)}
                      </select>
                    )}
                  </div>
                ) : (
                  <div className="sm-info-box sm-info-accent">
                    <Ico name="info" />
                    <span><strong>Capstone</strong> — meeting time is flexible. Pick a day + start time below if the team has a fixed slot; otherwise leave the defaults.</span>
                  </div>
                )}

                <div className="sm-row">
                  <div className="sm-field">
                    <label htmlFor="sm-start">Start time</label>
                    <input id="sm-start" type="time" value={form.startTime}
                      min={timeWindow ? fromMinutes(timeWindow.start) : undefined} max={timeWindow ? fromMinutes(timeWindow.end) : undefined}
                      aria-invalid={!!timeError}
                      onChange={e=>setForm(f=>({...f,startTime:e.target.value}))} required />
                    {timeError && <p className="sm-inline-error" role="alert"><Ico name="alert" /> <span>{timeError}</span></p>}
                  </div>
                  <div className="sm-field">
                    <label>Duration</label>
                    {/* NEW-FU-540 (Batch 13): duration is pills-only — the free-entry
                        numeric input was removed so an illegal value (e.g. 72 min) can
                        never be typed. The only selectable durations are the legal
                        per-type presets (Lec 50/75; Lab 50/75/160). */}
                    <div className="sm-pill-group sm-pill-group-sm">
                      {DURATION_DEFAULTS_BY_TYPE[form.sectionType].map(d => {
                        // NEW-FU-532 (Batch 11): durations are credit-aware — 75 min is
                        // 3/4-credit only, so it's disabled (with a reason) for a 0/1/2-credit course.
                        const okDur = form.sectionType !== 'Lec' || !selectedCourse
                          || legalDurationsForCourse({ credits: selectedCourse.credits, hasLab: courseHasLab }).includes(d);
                        return (
                        <button key={d} type="button" disabled={!okDur}
                          title={okDur ? undefined : `${d} min isn't allowed for a ${selectedCourse?.credits}-credit course (75 min is for 3- and 4-credit courses)`}
                          className={`sm-pill sm-pill-sm ${form.duration===String(d)?'active':''}`}
                          aria-pressed={form.duration===String(d)}
                          onClick={()=>setForm(f=>({...f, duration: String(d)}))}>
                          {d}m
                        </button>
                        );
                      })}
                    </div>
                    {durationError
                      ? <p className="sm-inline-error" role="alert"><Ico name="alert" /> <span>{durationError}</span></p>
                      : <p className="sm-hint">
                          {form.sectionType} {DURATION_LIMITS_BY_TYPE[form.sectionType].min}–{DURATION_LIMITS_BY_TYPE[form.sectionType].max} min
                        </p>}
                  </div>
                  <div className="sm-field">
                    <label>End time</label>
                    <div className="sm-readonly">{fmtTimeForDisplay(computeEnd())}</div>
                  </div>
                </div>
              </>
            )}

            <div className="sm-field">
              <label htmlFor="sm-instr" className="sm-label-row">
                <span>Instructor <span className="sm-optional">(required)</span></span>
                <button type="button" className="sm-inline-add" onClick={quickCreateInstructor}>
                  <Ico name="plus" /> New
                </button>
              </label>
              {/* NEW-FU-277 (Phase 53 #3): prior (taught this course) first, then other. */}
              <select id="sm-instr" value={form.instructorId} onChange={e=>setForm(f=>({...f,instructorId:e.target.value}))}>
                <option value="">— No instructor —</option>
                {/* NEW-FU-520 (Batch 6 Issue 3): disable instructors busy at this
                    slot (kept visible + flagged) so an edit can't create a clash.
                    The currently-selected instructor stays selectable so an
                    existing assignment is always shown and can be switched away. */}
                {groupedInstructors.prior.length > 0 && (
                  <optgroup label="Taught this course before">
                    {groupedInstructors.prior.map(i => {
                      const isBusy = busyResources.instructors.has(i.id) && i.id !== form.instructorId;
                      return (
                        <option key={i.id} value={i.id} disabled={isBusy}>
                          {i.name}{isBusy ? '  · busy at this slot' : ''}
                        </option>
                      );
                    })}
                  </optgroup>
                )}
                <optgroup label={groupedInstructors.prior.length ? 'All other faculty' : 'All faculty'}>
                  {groupedInstructors.other.map(i => {
                    const isBusy = busyResources.instructors.has(i.id) && i.id !== form.instructorId;
                    return (
                      <option key={i.id} value={i.id} disabled={isBusy}>
                        {i.name}{isBusy ? '  · busy at this slot' : ''}
                      </option>
                    );
                  })}
                </optgroup>
              </select>
              {instructorMissing && <p className="sm-inline-error" role="alert"><span>An instructor is required for every section.</span></p>}
            </div>

            {/* NEW-FU-275 (Phase 52 #6): venue hidden for capstone courses. */}
            {!courseIsCapstone && (
              <div className="sm-field">
                <label htmlFor="sm-venue" className="sm-label-row">
                  <span>Venue <span className="sm-optional">(required)</span></span>
                  <button type="button" className="sm-inline-add" onClick={quickCreateVenue}>
                    <Ico name="plus" /> New
                  </button>
                </label>
                {/* NEW-FU-277 (Phase 53 #3): grouped by type; busy venues flagged. */}
                <select id="sm-venue" value={form.venueId} onChange={e=>setForm(f=>({...f,venueId:e.target.value}))}
                  aria-invalid={venueTypeMismatch}>
                  <option value="">— No venue —</option>
                  {/* NEW-FU-510 (Batch 1): show only venue types valid for the
                      section type (Lec → LectureHall/Multipurpose; Lab →
                      Laboratory/Multipurpose). The currently-selected venue is
                      always kept visible — even if mismatched — so an existing
                      bad assignment can be seen and switched away from. */}
                  {['LectureHall', 'Multipurpose', 'Laboratory'].map(typeGroup => {
                    const vs = venues.filter(v =>
                      v.type === typeGroup &&
                      (allowedVenueTypes.includes(typeGroup) || v.id === form.venueId));
                    if (!vs.length) return null;
                    return (
                      <optgroup key={typeGroup} label={typeGroup}>
                        {vs.map(v => {
                          // NEW-FU-520 (Batch 6 Issue 3): disable busy venues (kept
                          // visible + flagged); the selected venue stays selectable.
                          const isBusy = busyResources.venues.has(v.id) && v.id !== form.venueId;
                          return (
                            <option key={v.id} value={v.id} disabled={isBusy}>
                              {v.name}{isBusy ? '  · busy at this slot' : ''}
                            </option>
                          );
                        })}
                      </optgroup>
                    );
                  })}
                </select>
                {venueMissing && <p className="sm-inline-error" role="alert"><span>A venue is required for every section.</span></p>}
                {/* NEW-FU-510 (Batch 1): block-and-explain a venue-type mismatch. */}
                {venueTypeMismatch && (
                  <p className="sm-inline-error" role="alert"><Ico name="alert" /> <span>
                    {form.sectionType === 'Lab' ? 'Lab' : 'Lecture'} sections need a {form.sectionType === 'Lab' ? 'Laboratory' : 'Lecture Hall'} (or Multipurpose) venue — “{selectedVenue?.name}” is a {selectedVenue?.type}. Pick a valid venue to save.
                  </span></p>
                )}
              </div>
            )}

            {/* NEW-FU-277 (Phase 53 #4): conflict preview. NEW-FU-574 (Batch 21): this is
                now the SINGLE conflict box for this form (add AND edit-Details). The header
                is mode-aware — "Submitting would create…" while adding (the section doesn't
                exist yet), "This section is in…" while editing — and the verbatim edit-only
                second box that used to render lower down was removed (it showed the same
                array: liveConflicts === effectiveConflicts in edit mode). */}
            {effectiveConflicts.length > 0 && (
              <div className="sm-info-box sm-info-warn">
                <strong><Ico name="alert" /> {mode === 'edit'
                  ? `This section is in ${effectiveConflicts.length} conflict${effectiveConflicts.length !== 1 ? 's' : ''}:`
                  : `Submitting would create ${effectiveConflicts.length} conflict${effectiveConflicts.length !== 1 ? 's' : ''}:`}</strong>
                <ul className="sm-conflict-list">
                  {effectiveConflicts.map((f, i) => (
                    <li key={i}>
                      <span className={`sm-sev sm-sev-${String(f.severity || '').toLowerCase()}`}>{f.severity}</span>
                      {/* plain message only — no raw rule code on screen. Server uses
                          `description`, the instant client preview uses `msg`. */}{f.msg ?? f.description}
                    </li>
                  ))}
                </ul>
                {/* NEW-FU-542 (Batch 14 Issue 1): one self-contained affordance — proactive
                    feasibility, the move-only Quick Fix (only when it truly exists), the
                    "move this section instead" steer, and the last-resort override. */}
                {renderAutoFix()}
              </div>
            )}
            {effectiveConflicts.length === 0 && !serverPreview.stale && form.courseId && !courseIsExternal && !durationError && !timeError && (
              <div className="sm-info-box sm-info-ok"><Ico name="check" /> <span>{mode === 'edit' ? 'No conflicts for this section.' : 'No conflicts would be created.'}</span></div>
            )}

            {mode==='edit' && (
              <>
                {/* NEW-FU-411 (Phase 102 item 4): gender + type aware section number.
                    Female sections carry the F- prefix; the digits are range-scoped
                    to the section's (now immutable) type — Lec 01–49, Lab 50–99. */}
                <div className="sm-field">
                  <label htmlFor="sm-secnum-e">Section number <span className="sm-optional">(updates all days in group)</span></label>
                  <div className={`sm-secnum-wrap${sectionNumError ? ' sm-secnum-wrap-invalid' : ''}`}>
                    {form.gender === 'F' && <span className="sm-secnum-prefix">F-</span>}
                    <input id="sm-secnum-e" className="sm-secnum-digits" value={form.sectionNumber}
                      inputMode="numeric" maxLength={2}
                      aria-invalid={!!sectionNumError}
                      aria-describedby={sectionNumError ? 'sm-secnum-e-err' : 'sm-secnum-e-hint'}
                      onChange={e=>setForm(f=>({...f,sectionNumber:e.target.value.replace(/\D/g,'').slice(0,2)}))} />
                  </div>
                  {/* NEW-FU-417 (Phase 103 items 3+4): live, styled, role=alert error.
                      NEW-FU-493 (Phase 119 item 3): also flag when field is cleared. */}
                  {sectionNumError
                    ? <p className="sm-inline-error" id="sm-secnum-e-err" role="alert"><Ico name="alert" /> <span>{sectionNumError}</span></p>
                    : sectionNumberMissing
                    ? <p className="sm-inline-error" role="alert"><Ico name="alert" /> <span>Enter a section number.</span></p>
                    : <p className="sm-hint" id="sm-secnum-e-hint">
                        {form.sectionType === 'Lab' ? 'Lab' : 'Lecture'} range <strong>{form.sectionType === 'Lab' ? (form.gender==='F'?'F-50–F-99':'50–99') : (form.gender==='F'?'F-01–F-49':'01–49')}</strong>
                        {' · shows as '}
                        <strong>{sectionLabel({ gender: form.gender, sectionNumber: form.sectionNumber || '__' })}</strong>
                      </p>}
                </div>
                {/* NEW-FU-410 (Phase 102 item 2): section TYPE is fixed at creation
                    and immutable here. Switching Lec↔Lab after creation broke the
                    type↔number range invariant (DB constraint errors), so it is now
                    a read-only display; change the type only by re-creating. */}
                {/* NEW-FU-498 (Phase 122): also display Prj/Ths for capstone sections
                    (still read-only — type is fixed at creation per FU-410). */}
                {(courseHasLab || courseIsCapstone) && (
                  <div className="sm-field">
                    <label>Section type</label>
                    <div className="sm-readonly sm-type-readonly">
                      <Ico name={form.sectionType==='Lab'?'flask':form.sectionType==='Prj'?'layers':form.sectionType==='Ths'?'edit':'book'} />
                      <span>{form.sectionType==='Lab'?'Lab':form.sectionType==='Prj'?'Project':form.sectionType==='Ths'?'Thesis':'Lecture'}</span>
                      <span className="sm-optional sm-type-fixed">· fixed for this section</span>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* NEW-FU-574 (Batch 21): removed the duplicate edit-only conflict box that
                used to render here ("This section is in N conflicts"). In edit mode
                liveConflicts === effectiveConflicts (see its definition), so the
                mode-aware box above already shows exactly these conflicts — this was a
                verbatim second copy that produced the doubled box in the Details tab. */}

            {error && <div className="sm-error" role="alert"><Ico name="alert" /> <span>{error}</span></div>}
            <div className="sm-actions">
              {mode==='edit' && (
                <button type="button" className="sm-btn-delete" onClick={()=>setConfirmingDelete(true)} disabled={busy}>
                  <Ico name="trash" /> Delete
                </button>
              )}
              <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
              {/* External courses (SWE 399) need no section row — submit just closes. */}
              <button type="submit" className="sm-btn-save"
                disabled={busy || scheduleLocked || courseMissing || sectionNumberMissing || !!sectionNumError || !!durationError || !!timeError || instructorMissing || venueMissing || venueTypeMismatch || conflictBlocksSave}
                title={scheduleLocked ? lockedMsg : courseMissing ? 'Choose a course first' : sectionNumberMissing ? 'Enter a section number first' : durationError || timeError || (instructorMissing ? 'Choose an instructor first' : venueMissing ? 'Choose a venue first' : venueTypeMismatch ? 'Pick a venue that matches the section type first' : sectionNumError ? 'Fix the section number first' : conflictBlocksSave ? (cleanFixActionable ? 'Resolve the conflict with the suggested fix above' : 'Schedule is tight — tick the box to save with a conflict') : undefined)}>
                {busy ? 'Saving…' : mode==='add'
                  ? (courseIsExternal ? 'OK, course noted' : 'Add section')
                  : 'Save'}
              </button>
            </div>
          </form>
        )}

        {/* ── EDIT TIME tab ── */}
        {mode==='edit' && tab==='time' && (
          <form className="sm-form" noValidate onSubmit={handleSubmitTime}>
            <div className="sm-info-box sm-info-accent">
              <Ico name="info" />
              <span>Moving the time shifts <strong>all days</strong> in this group to the same start/end time.</span>
            </div>
            <div className="sm-row">
              <div className="sm-field">
                <label htmlFor="sm-day">Day</label>
                {/* NEW-FU-528 (Batch 9 Issue 1): list the SELECTED pattern's days (form.dayMode),
                    not the original group's — so after the pattern auto-/manually changes the
                    anchor-day options stay consistent. */}
                <select id="sm-day" value={form.day} onChange={e=>setForm(f=>({...f,day:e.target.value}))}>
                  {form.dayMode && form.dayMode!=='single' && DAY_TEMPLATES[form.dayMode]
                    ? DAY_TEMPLATES[form.dayMode].days.map(d=><option key={d} value={d}>{d}</option>)
                    : DAYS.map(d=><option key={d} value={d}>{d}</option>)
                  }
                </select>
              </div>
              <div className="sm-field">
                <label htmlFor="sm-start-t">Start time</label>
                <input id="sm-start-t" type="time" value={form.startTime}
                  min={timeWindow ? fromMinutes(timeWindow.start) : undefined} max={timeWindow ? fromMinutes(timeWindow.end) : undefined}
                  aria-invalid={!!timeError}
                  onChange={e=>setForm(f=>({...f,startTime:e.target.value}))} required />
              </div>
              <div className="sm-field">
                <label>Duration</label>
                {/* NEW-FU-540 (Batch 13): duration is pills-only — the free-entry numeric
                    input was removed so an illegal value can never be typed. Pills are the
                    legal per-type presets (Lec 50/75; Lab 50/75/160) and stay credit-aware
                    (75 min disabled for 0/1/2-credit lectures), matching the Add panel. */}
                <div className="sm-pill-group sm-pill-group-sm">
                  {DURATION_DEFAULTS_BY_TYPE[form.sectionType].map(d => {
                    const okDur = form.sectionType !== 'Lec' || !selectedCourse
                      || legalDurationsForCourse({ credits: selectedCourse.credits, hasLab: courseHasLab }).includes(d);
                    return (
                    <button key={d} type="button" disabled={!okDur}
                      title={okDur ? undefined : `${d} min isn't allowed for a ${selectedCourse?.credits}-credit course (75 min is for 3- and 4-credit courses)`}
                      className={`sm-pill sm-pill-sm ${form.duration===String(d)?'active':''}`}
                      aria-pressed={form.duration===String(d)}
                      onClick={()=>setForm(f=>({...f, duration: String(d)}))}>
                      {d}m
                    </button>
                    );
                  })}
                </div>
              </div>
            </div>
            {/* NEW-FU-531 (Batch 10 Issue 4): the meeting-day pills are DYNAMIC per the
                course's credits. Show every multi-day pattern that EXISTS for the credits
                (a 2-credit course never sees a 3-day pattern); DISABLE the ones illegal for
                the current duration, with a reason tooltip (e.g. 3-credit Sun/Tue/Thu needs
                50 min). Picking an enabled pill restructures the group in place on Save. */}
            {selectedCourse && form.sectionType === 'Lec'
              && creditPatterns({ credits: selectedCourse.credits, hasLab: courseHasLab }).filter(p => p !== 'single').length > 0 && (
              <div className="sm-field">
                <label>Meeting days <span className="sm-optional">(set by this course's {selectedCourse.credits} credit{Number(selectedCourse.credits)===1?'':'s'})</span></label>
                <div className="sm-pill-group sm-pill-group-sm">
                  {creditPatterns({ credits: selectedCourse.credits, hasLab: courseHasLab })
                    .filter(p => p !== 'single')
                    .map(p => {
                      const legal  = legalPatternsNow.includes(p);
                      const okDur  = [50, 75].find(d => legalDayTemplatesForCourse({ credits: selectedCourse.credits, hasLab: courseHasLab, duration: d }).includes(p));
                      const reason = legal ? undefined
                        : `${DAY_TEMPLATES[p]?.label} requires ${okDur} min for a ${selectedCourse.credits}-credit course (you have ${form.duration} min)`;
                      return (
                        <button key={p} type="button" disabled={!legal} title={reason}
                          className={`sm-pill sm-pill-sm ${form.dayMode===p?'active':''}`}
                          aria-pressed={form.dayMode===p}
                          onClick={()=>setForm(f=>({...f, dayMode: p, day: DAY_TEMPLATES[p]?.days?.[0] ?? f.day }))}>
                          {DAY_TEMPLATES[p]?.label ?? p}{!legal ? '  · needs ' + okDur + 'm' : ''}
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
            <div className="sm-field sm-end-preview">
              End time: <strong>{fmtTimeForDisplay(computeEnd())}</strong>
            </div>
            {/* NEW-FU-478 (Phase 115): out-of-window / out-of-range time is flagged inline
                and blocks Save (the edit tab was previously unguarded). */}
            {(timeError || durationError) && (
              <p className="sm-inline-error" role="alert"><Ico name="alert" /> <span>{timeError || durationError}</span></p>
            )}
            {/* NEW-FU-510 (Batch 1): live conflict panel on the Time tab too —
                same live source, so moving the time updates it immediately. */}
            {liveConflicts.length > 0 && (
              <div className="sm-info-box sm-info-warn">
                <strong><Ico name="alert" /> This section is in {liveConflicts.length} conflict{liveConflicts.length!==1?'s':''}:</strong>
                <ul className="sm-conflict-list">
                  {liveConflicts.map((f, i) => (
                    <li key={i}>
                      <span className={`sm-sev sm-sev-${(f.severity||'').toLowerCase()}`}>{f.severity}</span>
                      {/* NEW-FU-472: plain message only — no raw rule code */}{f.msg ?? f.description}
                    </li>
                  ))}
                </ul>
                {/* NEW-FU-542 (Batch 14 Issue 1): proactive move-only Quick Fix + steer +
                    override, all in one. Only shown when there is a live conflict. */}
                {hasAnyConflict && renderAutoFix()}
              </div>
            )}
            {error && <div className="sm-error" role="alert"><Ico name="alert" /> <span>{error}</span></div>}
            <div className="sm-actions">
              <button type="button" className="sm-btn-delete" onClick={()=>setConfirmingDelete(true)} disabled={busy}>
                <Ico name="trash" /> Delete
              </button>
              <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
              {/* NEW-FU-412 (Phase 102 item 3): "Move all days" overstated the
                  action — the user is editing one section's meeting time. */}
              {/* NEW-FU-493 (Phase 119 item 3): add sectionNumberMissing so clearing
                  the section number in edit mode also disables Save (parity with add). */}
              <button type="submit" className="sm-btn-save"
                disabled={busy || scheduleLocked || sectionNumberMissing || !!timeError || !!durationError || conflictBlocksSave}
                title={scheduleLocked ? lockedMsg : sectionNumberMissing ? 'Enter a section number first' : timeError || durationError || (conflictBlocksSave ? (cleanFixActionable ? 'Resolve the conflict with the suggested fix above' : 'Schedule is tight — tick the box to save with a conflict') : undefined)}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}

        {/* NEW-FU-401 (Phase 101): in-app delete confirmation — replaces the
            native window.confirm(). Sits inside the card with the same chassis. */}
        {confirmingDelete && (
          <div className="sm-confirm-scrim" onClick={e=>e.target===e.currentTarget && setConfirmingDelete(false)}>
            <div className="sm-confirm-card" role="alertdialog" aria-modal="true" aria-label="Confirm delete">
              <div className="sm-confirm-icon"><Ico name="trash" /></div>
              <h3 className="sm-confirm-title">Delete this section?</h3>
              <p className="sm-confirm-text">
                <strong>{existing ? `${existing.courseCode??existing.course_code} ${sectionLabel(existing)}` : 'This section'}</strong>
                {' '}and all linked days in its group will be removed. This can’t be undone.
              </p>
              <div className="sm-confirm-actions">
                <button type="button" className="sm-btn-cancel" onClick={()=>setConfirmingDelete(false)} disabled={busy}>Keep it</button>
                <button type="button" className="sm-btn-delete sm-btn-delete-solid" onClick={handleDelete} disabled={busy}>
                  {busy ? 'Deleting…' : 'Delete section'}
                </button>
              </div>
            </div>
          </div>
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
