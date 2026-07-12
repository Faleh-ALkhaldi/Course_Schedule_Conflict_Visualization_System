import React, { useState, useEffect, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
// NEW-FU-503 (Phase 123): shared SVG icons replace emoji glyphs.
import Ico from '../shared/Icons.jsx';
import { useApp, LEVEL_COLORS, isInfoOnlyCourse } from '../../context/AppContext.jsx';
import { suggestRecommend, getCourses } from '../../api/index.js';
import './SectionModal.css';
import './SuggestModal.css';

const LEVEL_ORDER  = ['Freshman','Sophomore','Junior','Senior','Graduate'];

// NEW-FU-249: two-axis pattern model mirrored from
// backend/src/domain/sectionPattern.js (FU-247). Keep in sync when
// the backend table changes — drift would surface as 400s on submit.
// The frontend doesn't import from backend, so this is the pragmatic
// choice over wiring a new endpoint. The integration test in FU-250
// hits the API with both shapes so drift surfaces quickly.
const DAY_TEMPLATE_LABELS = {
  STT:     'Sun / Tue / Thu',
  MW:      'Mon / Wed',
  ST:      'Sun / Tue',
  TT:      'Tue / Thu',
  ONE_DAY: 'Any day',
};
// NEW-FU-648: this mirror had DRIFTED badly from backend legalPatternsForCourse — it offered
// 75 min for 2-credit, the 3-day STT for 3-credit-with-lab @ 50, STT+2-day for 4-credit, and
// had no 0-credit case. Rewritten to reproduce the canonical OFFERING set EXACTLY (decomposed
// into the duration → day-template two-step the modal renders), so every course shows only the
// legal options for its (credits × has-lab × activity flag) and an illegal duration/pattern can't be picked:
//   0/1 cr ............... 50 → Any day (single meeting)
//   2 cr ................. 50 → Sun/Tue, Mon/Wed, Tue/Thu   (no 75)
//   3 cr (no lab) ....... 50 → Sun/Tue/Thu  |  75 → Mon/Wed, Sun/Tue, Tue/Thu
//   3 cr (WITH lab) ..... 50 → Sun/Tue, Mon/Wed, Tue/Thu  |  75 → Mon/Wed, Sun/Tue, Tue/Thu
//   4 cr (always lab) ... 50 → Sun/Tue/Thu  |  75 → Mon/Wed, Sun/Tue, Tue/Thu
//   Seminar ............. 75 → Any day (single meeting)
// Accepts camelCase or the API's raw snake_case flags so every call site works unchanged.
function legalDurationsForCourse({ credits, hasLab, has_lab, isSeminar, is_seminar }) {
  if (isSeminar ?? is_seminar) return [75];
  const c = Number(credits);
  if (c === 0 || c === 1 || c === 2) return [50];
  if (c === 3 || c === 4) return [50, 75];
  return [];
}
function legalDayTemplatesForCourse({ credits, hasLab, has_lab, duration, isSeminar, is_seminar }) {
  const c = Number(credits);
  const lab = hasLab ?? has_lab ?? false;
  const d = Number(duration);
  if (isSeminar ?? is_seminar) return d === 75 ? ['ONE_DAY'] : [];
  if (d === 75) return (c === 3 || c === 4) ? ['MW', 'ST', 'TT'] : [];
  // d === 50
  if (c === 0 || c === 1) return ['ONE_DAY'];
  if (c === 2)            return ['ST', 'MW', 'TT'];
  if (c === 3)            return lab ? ['ST', 'MW', 'TT'] : ['STT'];
  if (c === 4)            return ['STT'];
  return [];
}
// Default duration per course: the "canonical" one for its credits.
// 3-credit defaults to 50 (most-common STT pattern at KFUPM); 2-credit
// defaults to 50 (3 two-day options is more flexibility than 1
// single-day option).
function defaultDurationFor(course) {
  const opts = legalDurationsForCourse(course);
  return opts[0] ?? 50;
}
function defaultDayTemplateFor(course, duration) {
  const opts = legalDayTemplatesForCourse({
    credits: course.credits,
    hasLab: course.has_lab,
    isSeminar: isSeminarCourse(course),
    duration,
  });
  return opts[0] ?? 'STT';
}

// Lab section options — fixed across all hasLab courses. The
// user picks BOTH the duration AND the specific day (FU-254
// replaces the prior "Any day" placeholder with explicit per-day
// buttons so the choice is unambiguous).
const LAB_DURATIONS = [50, 75, 160];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
// Short labels for the day buttons to keep the row compact.
const DAY_SHORT = { Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu' };

function isSuggestableCourse(course) {
  return !isInfoOnlyCourse(course) && !(course?.isCapstone ?? course?.is_capstone);
}

function isSeminarCourse(course) {
  return !!(course?.isSeminar ?? course?.is_seminar);
}

export default function SuggestModal({ scheduleId, onConfirm, onClose }) {
  useFocusTrap();
  // NEW-FU-35: Escape dismisses the modal, matching the pattern used by the
  // other modals (SoftConflictModal / OfficeHourModal / GroupChangeModal).
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // NEW-FU-374 (Phase 98 item 4): the Suggest panel must offer the FULL program
  // catalog — including the GRADUATE tier (e.g. SWE 503 / 587) — not only the
  // courses that already have sections in the current term. useApp().courses is
  // term-scoped (a course surfaces only if it already has a section this term),
  // which is exactly why a sparse term like 271 showed no Graduate tier at all.
  // Seed the working list with the term-scoped courses (so the modal paints
  // instantly) and replace it with the un-scoped catalog once it loads (effect
  // below). The backend already schedules GR courses in their own 17:00–22:00
  // evening window, so once they're offered here the rest works end-to-end.
  const { courses: termCourses, schedule } = useApp();
  const termCode = schedule?.semester ?? null;   // NEW-FU-650: scope the course list to THIS term
  const schedulableTermCourses = termCourses.filter(isSuggestableCourse);
  const [courses, setCourses] = useState(schedulableTermCourses);

  // NEW-FU-264 / FU-266: smart auto-suggester state.
  //   • loading           — pre-flight call to /suggest-recommend is in
  //                          flight. We block the Run button (and the
  //                          per-course controls feel "live" but the user
  //                          can't submit until we know what the greedy
  //                          recommended). Cheap UX guard against a
  //                          double-click race.
  //   • recommendError    — surfaces if the recommend endpoint fails. The
  //                          modal stays usable (hardcoded defaults still
  //                          work) but we show an inline note so the user
  //                          knows the recommendation step was skipped.
  //   • capacityWarnings  — per-course messages from the recommend pass
  //                          (e.g., "no conflict-free slot found"). Rendered
  //                          inline on the matching course card (FU-266).
  //   • applyToCourseIds  — Set<courseId>. Default: every course is on.
  //                          User can uncheck rows they don't want the run
  //                          to touch (FU-265). The full set is passed to
  //                          the backend as `applyToCourseIds` ONLY when
  //                          the user has unchecked something — otherwise
  //                          we omit the field so the backend takes the
  //                          legacy "apply to all" path.
  const [loading,         setLoading]         = useState(true);
  const [recommendError,  setRecommendError]  = useState(null);
  const [capacityWarnings, setCapacityWarnings] = useState([]); // [{ courseId, courseCode, message }]
  const [labError,        setLabError]        = useState(null); // NEW-FU-651: per-gender R-14 block messages
  // NEW-FU-231 (Phase 97): "auto-choose" toggle (items 7/8). When ON (default),
  // changing a course's section count makes Suggest automatically re-pick the
  // best duration / day-pattern for the affected courses to avoid conflicts.
  // That live adjustment is helpful but was invisible — users were confused
  // when their picks "changed by themselves". The toggle (with a tooltip) makes
  // it explicit and lets a user turn it OFF to keep every manual choice fixed.
  const [autoChoose, setAutoChoose] = useState(true);
  // NEW-FU-655: apply MODE — how a Suggest run reconciles with the term's
  // CURRENT schedule for the courses it generates:
  //   • 'replace' — the generated sections REPLACE the term's existing sections
  //                 for those courses (cleared and rebuilt from the selection).
  //                 This is the historical behaviour, so it's the DEFAULT —
  //                 nothing silently changes for existing users.
  //   • 'add'     — the generated sections are ADDED alongside the term's
  //                 existing sections (existing KEPT; Suggest only appends the
  //                 newly generated ones, renumbered so they don't collide).
  // The value rides on each per-course payload entry in handleSubmit (the only
  // channel that survives SchedulerPage.runSuggest's preview/relax/apply chain).
  const [mode, setMode] = useState('replace');
  // NEW-FU-374 (Phase 98 item 4): default the apply-set to the courses ALREADY in
  // this term (termCourses), NOT the whole catalog. Catalog-only courses (grad /
  // not-yet-scheduled) appear in the panel but start UNCHECKED, so a default
  // "Run Suggest" regenerates exactly the term's existing courses — unchanged
  // behaviour for populated terms (251/262). The user opts a grad course in by
  // ticking it; the run then places it in the GR evening window.
  const [applyToCourseIds, setApplyToCourseIds] = useState(() => new Set(schedulableTermCourses.map(c => c.id)));
  // NEW-FU-381 (Phase 99 items 2/3): user-intent tracking for the live solver.
  //   • userEditedRef           — courseIds the user manually changed (sections /
  //                               duration / day-pattern). The live auto-choose
  //                               LOCKS these (honours the user's pick) and only
  //                               re-solves the OTHER selected courses around them.
  //   • userTouchedSelectionRef — flips true once the user toggles any apply
  //                               checkbox, so the catalog load (which defaults
  //                               EVERY course on, item 3) doesn't re-check rows
  //                               the user just started unchecking.
  const userEditedRef = useRef(new Set());
  const userTouchedSelectionRef = useRef(false);
  // NEW-FU-223 (Phase 96): the upfront "conflict tolerance per section" knob
  // (and its Advanced disclosure) were removed. Asking the user how many
  // conflicts to tolerate is backwards — nobody wants conflicts. Suggest now
  // runs CLEAN-FIRST and, only if the user's exact picks can't fit, explains
  // the clashes and asks how to proceed (see SchedulerPage.runSuggest).

  // NEW-FU-312 (Phase 28): build-mismatch state. The frontend was built
  // with a specific git sha (injected via Vite's `define` — see
  // vite.config.js). If the running backend reports a DIFFERENT sha
  // via /health/build-match, the user is in the "EADDRINUSE-stuck"
  // state: their new `npm run dev` crashed because port 4000 was
  // already taken, and the OLD backend kept serving. Without this
  // detection, the user would see "everything still broken" across
  // multiple phases (which is exactly what kept happening from the
  // Phase-25-onward bug reports).
  //
  // Probed once on mount via /health/build-match. The endpoint accepts
  // ?frontendSha=... and returns { match: true|false|null }. null
  // means indeterminate (e.g., no git in the build env) — we treat
  // that as "no warning" to avoid false positives.
  const [buildMismatch, setBuildMismatch] = useState(false);

  // NEW-FU-312 (Phase 28): probe /health/build-match once on mount.
  // The endpoint compares our injected VITE_GIT_SHA against the running
  // backend's git sha. If they differ, the user is in the "old backend
  // still serving" state described in Phase 28's diagnosis. We set
  // buildMismatch=true to show the EADDRINUSE-aware banner with the
  // exact kill-and-restart command.
  useEffect(() => {
    // NEW-FU-524 (Batch 7 Issue 3): suppress this SHA-mismatch banner in DEV.
    // Both VITE_GIT_SHA (baked at vite start) and the backend gitSha (read at
    // backend start) freeze at process startup, so ANY commit makes them drift and
    // the banner false-positives — even though nodemon keeps the routes current.
    // The banner exists for the stale-process EADDRINUSE footgun, which the
    // self-cleaning `npm run dev` (frees the port before starting) now prevents.
    // In a production build the SHA mismatch is a real bad-deploy signal → keep it.
    if (import.meta.env.DEV) return;
    const frontendSha = import.meta.env.VITE_GIT_SHA;
    if (!frontendSha || frontendSha === 'unknown') return; // can't compare
    let cancelled = false;
    fetch(`/api/v1/health/build-match?frontendSha=${encodeURIComponent(frontendSha)}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        // `match === false` is the only state we react to. `null`
        // means indeterminate (no git in build env) — leave the
        // banner suppressed to avoid false positives.
        if (data.match === false) setBuildMismatch(true);
      })
      .catch(() => { /* probe failed — banner stays suppressed */ });
    return () => { cancelled = true; };
  }, []);

  // NEW-FU-286 (Phase 24): the "Apply all" header checkbox should show
  // an indeterminate state when the user has partial selection (some
  // courses checked, some not). React doesn't accept `indeterminate`
  // as a JSX prop — it's a DOM-only property — so we set it via a ref
  // in a useEffect that fires whenever the selection size changes.
  const applyAllCheckboxRef = useRef(null);
  useEffect(() => {
    if (!applyAllCheckboxRef.current) return;
    const total    = courses.length;
    const selected = applyToCourseIds.size;
    applyAllCheckboxRef.current.indeterminate = selected > 0 && selected < total;
  }, [applyToCourseIds, courses.length]);

  // courseConfig: { [courseId]: { sections, duration, dayPattern, labDuration } }
  // NEW-FU-249: per-course state now carries the two-axis form
  // (duration + dayPattern) instead of the single PATTERN_NAME. Lab
  // courses also carry a labDuration. GR courses still bias toward
  // 75-min slots since graduate students prefer longer evening blocks.
  const [config, setConfig] = useState(() => {
    const init = {};
    for (const c of courses) {
      let duration = defaultDurationFor(c);
      // GR preference (carried over from M-5 / FU-242): pick 75-min
      // when legal for this course.
      if (c.category === 'GR' && legalDurationsForCourse(c).includes(75)) {
        duration = 75;
      }
      const dayPattern = defaultDayTemplateFor(c, duration);
      // NEW-FU-254: default lecture day (only used when dayPattern is
      // ONE_DAY) and lab day default to Sunday — Option A from the
      // Phase 19 prompt. Predictable; later phases can promote this
      // to a capacity-aware default once /suggest-recommend exists.
      init[c.id] = {
        // NEW-FU-649/650: per-gender counts default to 1 Male + 1 Female.
        maleSections:   1,
        femaleSections: 1,
        duration,
        dayPattern,
        day:         'Sunday',
        labDuration: c.has_lab ? 50 : null,
        labDay:      c.has_lab ? 'Sunday' : null,
        // NEW-FU-651: per-gender lab counts (1 each by default for a lab course; null otherwise).
        maleLabSections:   c.has_lab ? 1 : null,
        femaleLabSections: c.has_lab ? 1 : null,
      };
    }
    return init;
  });

  // NEW-FU-650 (per-term isolation): load THIS TERM's OWN courses (owner_semester = term),
  // including just-created section-less ones (e.g. SWE 485). This REPLACES the old
  // scope=catalog load, which pulled the global TEMPLATE library (owner NULL) — that showed
  // courses NOT added to the term and MISSED the term's own courses, and Running Suggest would
  // then create other terms' courses. The panel now reflects exactly the active term's courses.
  // Retried with backoff (transient pool saturation shouldn't drop the list); falls back to the
  // term-scoped seed on failure.
  useEffect(() => {
    if (!termCode) return;
    let cancelled = false;
    async function loadTermCourses() {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const all = await getCourses(termCode);   // term-scoped: owner=term (+ any sectioned)
          if (Array.isArray(all) && all.length > 0) return all;
          lastErr = new Error('empty term course list');
        } catch (err) { lastErr = err; }
        if (cancelled) return null;
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
      throw lastErr ?? new Error('term course load failed');
    }
    (async () => {
      try {
        const all = await loadTermCourses();
        if (cancelled || !all) return;
          const schedulable = all.filter(isSuggestableCourse);
          setCourses(schedulable);
          setConfig(prev => {
            const next = { ...prev };
            for (const c of schedulable) {
              if (next[c.id]) continue; // keep any value the term init / recommend set
            let duration = defaultDurationFor(c);
            if (c.category === 'GR' && legalDurationsForCourse(c).includes(75)) duration = 75;
            next[c.id] = {
              maleSections:   1,   // NEW-FU-649: per-gender counts (M 1 / F 1 default — see init)
              femaleSections: 1,
              duration,
              dayPattern:  defaultDayTemplateFor(c, duration),
              day:         'Sunday',
              labDuration: c.has_lab ? 50 : null,
              labDay:      c.has_lab ? 'Sunday' : null,
              maleLabSections:   c.has_lab ? 1 : null,   // NEW-FU-651
              femaleLabSections: c.has_lab ? 1 : null,
            };
          }
          return next;
        });
        // Default EVERY course in the term ON (they're all this term's own courses now).
        if (!userTouchedSelectionRef.current) {
          setApplyToCourseIds(new Set(schedulable.map(c => c.id)));
        }
      } catch { /* retries failed — keep the term-scoped seed; modal still works */ }
    })();
    return () => { cancelled = true; };
  }, [termCode]);

  // NEW-FU-264: pre-flight to /suggest-recommend on mount. The backend runs
  // the greedy in dry-run mode (no DB writes) and returns:
  //   • recommendations[] — per-course {sections, duration, dayPattern, day,
  //                                      labDuration, labDay}
  //   • capacityWarnings[] — per-course "no conflict-free slot" notes
  //
  // We overwrite the hardcoded defaults with the recommendations. If the
  // call fails (network blip, archived term, etc.) we keep the hardcoded
  // defaults and surface a small banner. The modal is still usable.
  //
  // Why an effect (not a Suspense or sync load): we want the modal to
  // appear immediately with sensible defaults — the user sees something
  // is happening rather than a blank screen. The recommendations swap
  // in when ready, but the layout doesn't reflow.
  useEffect(() => {
    if (!scheduleId) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const result = await suggestRecommend(scheduleId);
        if (cancelled) return;
        // Merge each recommended placement into the current config. We
        // overwrite ALL fields (not just empty ones) because the user
        // hasn't had time to click anything yet — the modal is locked
        // while loading is true (Run button disabled). After this
        // setState, the controls become "live" with the recommended
        // values pre-selected.
        setConfig(prev => {
          const next = { ...prev };
          for (const r of result.recommendations ?? []) {
            const cur = prev[r.courseId];
            if (!cur) continue; // course gone — skip silently
            next[r.courseId] = {
              ...cur,
              // NEW-FU-649: the recommend returns a single count → seed it as Male sections
              // (all-Male default, unchanged behaviour); the user adds Female sections explicitly.
              maleSections: r.sections   ?? cur.maleSections,
              duration:    r.duration    ?? cur.duration,
              dayPattern:  r.dayPattern  ?? cur.dayPattern,
              day:         r.day         ?? cur.day,
              labDuration: r.labDuration ?? cur.labDuration,
              labDay:      r.labDay      ?? cur.labDay,
            };
          }
          return next;
        });
        setCapacityWarnings(result.capacityWarnings ?? []);
      } catch (err) {
        if (cancelled) return;
        // 4xx/5xx — show a banner but let the user proceed with the
        // hardcoded defaults. Most likely cause: term is archived (409),
        // schedule was just deleted (404), OR the backend is running
        // stale code without the Phase 21+ route (also 404).
        //
        // NEW-FU-298 (Phase 26): when the error LOOKS like a missing-
        // route 404 (server still alive but route absent), probe the
        // diagnostic endpoint to confirm and surface a more actionable
        // message. The user told us the modal kept saying "Route not
        // found" through multiple phases despite the route existing
        // in source; this loop closes that diagnostic gap.
        let message = err.response?.data?.error ?? err.message ?? 'Failed to compute recommendations';
        const looksLikeMissingRoute = err.response?.status === 404
          && /Route .* not found/i.test(err.response?.data?.error ?? '');
        if (looksLikeMissingRoute) {
          try {
            const probe = await fetch('/api/v1/health/routes').then(r => r.json());
            const hasRoute = (probe.routes ?? []).some(line =>
              line === 'GET /api/v1/schedules/:scheduleId/suggest-recommend'
            );
            if (!hasRoute) {
              message = 'The scheduling service is not using the same application version as this page. Restart the local CSCVS services, then refresh.';
            }
          } catch { /* probe failed — keep the original message */ }
        }
        setRecommendError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scheduleId]);

  function setField(courseId, field, value) {
    // NEW-FU-381 (Phase 99 item 2): the user just made an explicit choice for
    // this course — LOCK it so the live auto-choose honours it and re-solves the
    // OTHER courses around it (rather than overwriting the value they just set).
    userEditedRef.current.add(courseId);
    setConfig(prev => {
      const next = { ...prev, [courseId]: { ...prev[courseId], [field]: value } };
      // NEW-FU-249: when duration changes, the dayPattern may become
      // illegal (e.g., user was on STT @ 50min for a 3-cr course,
      // then switches to 75min — STT only exists at 50min). Auto-
      // reset to the first legal template for the new duration.
      if (field === 'duration') {
        const course = courses.find(c => c.id === courseId);
        const legalDayTemplates = legalDayTemplatesForCourse({
          credits: course.credits,
          hasLab: course.has_lab,
          isSeminar: isSeminarCourse(course),
          duration: value,
        });
        if (!legalDayTemplates.includes(next[courseId].dayPattern)) {
          next[courseId].dayPattern = legalDayTemplates[0] ?? next[courseId].dayPattern;
        }
      }
      return next;
    });
  }

  // NEW-FU-347 (Phase 33): re-recommend when the user changes any
  // course's section count. Debounced 200ms so rapid arrow-key
  // increments don't fire 5 requests. The hint sends ALL courses'
  // current section counts so the backend's saturation calculation
  // sees the same picture the user is looking at — not just the one
  // changed course in isolation. We only update fields the recommend
  // response returned and ONLY for the changed course (we don't want
  // to clobber the user's manual edits to OTHER courses).
  // NEW-FU-381 (Phase 99 item 2): LIVE auto-choose cross-optimizer.
  // The trigger key changes when the user edits ANY course — sections, duration
  // OR day-pattern — not just the section count (the old behaviour). To avoid a
  // feedback loop, the key includes the full pattern ONLY for LOCKED (user-
  // edited) courses; the section count is included for every course. The solver
  // only rewrites UNLOCKED courses, whose pattern is NOT in the key, so its own
  // writes never re-trigger it.
  const configKey = React.useMemo(() => {
    const locked = userEditedRef.current;
    return Object.entries(config).map(([id, c]) => {
      const base = `${id}:m${c.maleSections}f${c.femaleSections}`;   // NEW-FU-649: per-gender counts
      return locked.has(id)
        ? `${base}:d${c.duration}:p${c.dayPattern}:${c.day ?? ''}:l${c.labDuration ?? ''}:${c.labDay ?? ''}`
        : base;
    }).sort().join('|');
  }, [config]);
  React.useEffect(() => {
    if (!scheduleId) return;
    // OFF → keep every value exactly as the user set it (no live adjustment).
    if (!autoChoose) return;
    // Only run AFTER the user has actually edited something — the mount
    // recommend + catalog load also setConfig, and we must not "auto-adjust"
    // those initial values out from under the user.
    if (userEditedRef.current.size === 0) return;

    // Snapshot the current panel state to send to the fast (greedy-skipping)
    // recommend: the LOCKED courses are honoured; the others are re-picked to
    // spread around them.
    const lockedCourseIds = [...userEditedRef.current].filter(id => config[id]);
    const configs = Object.entries(config).map(([courseId, c]) => ({
      courseId,
      // NEW-FU-649: the recommend's saturation model is gender-agnostic — feed it the TOTAL.
      sections:    (Number(c.maleSections) || 0) + (Number(c.femaleSections) || 0) || 1,
      maleSections:   Number(c.maleSections) || 0,
      femaleSections: Number(c.femaleSections) || 0,
      duration:    c.duration,
      dayPattern:  c.dayPattern,
      day:         c.day,
      labDuration: c.labDuration,
      labDay:      c.labDay,
    }));
    const sectionsHint = {};
    for (const [id, cfg] of Object.entries(config)) {
      const n = (Number(cfg.maleSections) || 0) + (Number(cfg.femaleSections) || 0);
      if (Number.isFinite(n) && n >= 1) sectionsHint[id] = n;
    }

    const controller = new AbortController();
    let cancelled = false;
    // Debounced 300ms; the AbortController cancels any superseded in-flight
    // call so rapid edits don't pile up heavy requests (item 5).
    const t = setTimeout(async () => {
      try {
        const result = await suggestRecommend(scheduleId, {
          sectionsHint, configs, lockedCourseIds, fast: true, signal: controller.signal,
        });
        if (cancelled) return;
        const lockedSet = userEditedRef.current;
        setConfig(prev => {
          const next = { ...prev };
          for (const r of result.recommendations ?? []) {
            const cur = prev[r.courseId];
            if (!cur) continue;
            // Respect the user's explicit picks: only the courses they have NOT
            // locked get auto-adjusted toward a conflict-free spread.
            if (lockedSet.has(r.courseId)) continue;
            next[r.courseId] = {
              ...cur,
              duration:    r.duration    ?? cur.duration,
              dayPattern:  r.dayPattern  ?? cur.dayPattern,
              day:         r.day         ?? cur.day,
              labDuration: r.labDuration ?? cur.labDuration,
              labDay:      r.labDay      ?? cur.labDay,
            };
          }
          return next;
        });
      } catch {
        // Aborted (superseded) or failed — keep the current config; the user
        // can still Run. The mount recommend handles loud failures.
      }
    }, 300);
    return () => { cancelled = true; controller.abort(); clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey, autoChoose]);

  // NEW-FU-265: per-course apply checkbox. The Set wrapper makes
  // toggle/has/size cheap and avoids the "filtered list" rebuild on
  // every keystroke. Default: all courses checked (legacy behavior).
  function toggleApply(courseId) {
    userTouchedSelectionRef.current = true; // (Phase 99 item 3) stop the catalog default-on from clobbering
    setApplyToCourseIds(prev => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else                    next.add(courseId);
      return next;
    });
  }

  function handleSubmit() {
    // NEW-FU-265: payload is filtered to ONLY the courses the user
    // wants the run to touch. Unchecked rows are dropped entirely —
    // the backend's applyToCourseIds filter scopes the wipe to those
    // ids, so existing sections of unchecked courses are preserved.
    // Build the request payload using the new two-axis shape. Belt-and-suspenders: if a course
    // somehow has no config entry yet, fall back to the canonical defaults.
    // NEW-FU-649: a course the user zeroed on BOTH genders (Male 0 + Female 0) is dropped from the
    // run — neither regenerated nor wiped (its existing sections are preserved), exactly like an
    // unchecked row. targetIds is derived from the surviving payload (below) so the backend wipe
    // never touches a course we aren't regenerating.
    const totalFor = (id) => {
      const cc = config[id];
      return (Number(cc?.maleSections) || 0) + (Number(cc?.femaleSections) || 0);
    };
    const payload = courses
      .filter(c => applyToCourseIds.has(c.id) && totalFor(c.id) >= 1)
      .map(c => {
        const cfg = config[c.id] ?? {
          maleSections: 1,
          femaleSections: 1,
          duration: defaultDurationFor(c),
          dayPattern: defaultDayTemplateFor(c, defaultDurationFor(c)),
          day: 'Sunday',
        };
        // NEW-FU-649: per-gender counts drive section generation; `sections` (the total) still
        // rides along for the gender-agnostic saturation/legacy backend paths.
        const male   = Math.max(0, parseInt(cfg.maleSections, 10)   || 0);
        const female = Math.max(0, parseInt(cfg.femaleSections, 10) || 0);
        return {
          courseId:   c.id,
          courseCode: c.course_code,
          maleSections:   male,
          femaleSections: female,
          sections:   (male + female) || 1,
          dayPattern: cfg.dayPattern,
          duration:   cfg.duration,
          // NEW-FU-655: carry the apply mode ('replace' default | 'add') on each
          // config so it survives SchedulerPage.runSuggest's preview/relax/apply
          // chain (which forwards courseConfigs verbatim). The API lifts it to a
          // single top-level body field; the backend reads it there.
          mode,
          // NEW-FU-254: include `day` only when the dayPattern is
          // ONE_DAY — for multi-day templates (STT/MW/ST/TT) the days
          // are implicit and the field is ignored. The backend
          // (FU-252) treats absent `day` as "let greedy pick" so this
          // omission preserves the multi-day path.
          ...(cfg.dayPattern === 'ONE_DAY' ? { day: cfg.day } : {}),
          // Lab fields included only when relevant. Backend treats
          // null/undefined as "no lab spec" — handled by existing FU-111
          // lab task spawning logic.
          ...(c.has_lab && cfg.labDuration ? {
            labDuration: cfg.labDuration,
            labDay:      cfg.labDay,
            // NEW-FU-651: per-gender lab counts.
            maleLabSections:   Math.max(0, parseInt(cfg.maleLabSections, 10)   || 0),
            femaleLabSections: Math.max(0, parseInt(cfg.femaleLabSections, 10) || 0),
          } : {}),
        };
      });
    // NEW-FU-651: proactive R-14 enforcement — a has-lab course must, FOR EACH GENDER, have a lab
    // section whenever it has a lecture section, and a lecture whenever it has a lab. A Male lab
    // never covers Female lectures and vice versa. Block the Run with a precise message (the backend
    // throws the same as a backstop) so Suggest can never emit a lecture-without-lab / lab-without-
    // lecture R-14. (Applied courses are wiped + regenerated, so the panel config is authoritative;
    // an unapplied course is left untouched and isn't in `payload`.)
    const r14Errors = [];
    for (const p of payload) {
      const c = courses.find(x => x.id === p.courseId);
      if (!c || !c.has_lab) continue;
      const ml = Math.max(0, parseInt(config[c.id]?.maleLabSections, 10)   || 0);
      const fl = Math.max(0, parseInt(config[c.id]?.femaleLabSections, 10) || 0);
      if (p.maleSections   > 0 && ml === 0) r14Errors.push(`${c.course_code}: add a Male lab section (it has ${p.maleSections} Male lecture${p.maleSections > 1 ? 's' : ''}).`);
      if (ml > 0 && p.maleSections   === 0) r14Errors.push(`${c.course_code}: add a Male lecture section (it has a Male lab).`);
      if (p.femaleSections > 0 && fl === 0) r14Errors.push(`${c.course_code}: add a Female lab section (it has ${p.femaleSections} Female lecture${p.femaleSections > 1 ? 's' : ''}).`);
      if (fl > 0 && p.femaleSections === 0) r14Errors.push(`${c.course_code}: add a Female lecture section (it has a Female lab).`);
    }
    if (r14Errors.length) { setLabError(r14Errors); return; }
    setLabError(null);
    // NEW-FU-649: derive targetIds from the SURVIVING payload (courses with ≥1 section), so the
    // backend wipe is scoped to exactly what we regenerate. null = "apply to all" only when every
    // course is in the payload.
    const payloadIds = new Set(payload.map(p => p.courseId));
    const targetIds  = payloadIds.size === courses.length ? null : [...payloadIds];
    // NEW-FU-223 (Phase 96): no tolerance argument — runSuggest is clean-first
    // and negotiates conflicts after the dry-run, not via an upfront knob.
    onConfirm(payload, targetIds);
  }

  // NEW-FU-266: courseId → warning message lookup. We build it once
  // per render to keep the JSX below readable — the alternative is
  // a `.find(w => w.courseId === ...)` scan inside every row.
  const warningsByCourseId = new Map(
    capacityWarnings.map(w => [w.courseId, w])
  );

  const grouped = LEVEL_ORDER.map(level => ({
    level,
    courses: courses.filter(c => c.academic_level === level),
  })).filter(g => g.courses.length > 0);

  return (
    <div className="sm-overlay" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="sm-card suggest-card" role="dialog" aria-modal="true" aria-label="Suggest schedule">
        <div className="sm-header">
          <h2 className="sm-title"><Ico name="sparkles" /> Auto-Suggest Schedule</h2>
          <button className="sm-close" onClick={onClose}>×</button>
        </div>

        <p className="suggest-desc">
          Configure how many sections each course needs and which day pattern to use.
          The system will find the best time slots to minimize conflicts.
          {/* NEW-FU-264: signal that the values are pre-computed from a
              dry-run of the greedy. Users were previously confused why
              defaults sometimes "felt off" — now they know the system
              picked them. */}
          {!loading && !recommendError && capacityWarnings.length === 0 && (
            <span className="suggest-recommend-badge"><Ico name="sparkles" /> Recommendations pre-filled</span>
          )}
        </p>

        {/* NEW-FU-231 (Phase 97): the auto-choose toggle + tooltip (items 7/8).
            Makes the previously-invisible "auto-adjust my other picks" behaviour
            explicit and controllable, so a user is never surprised by their
            options changing on their own. */}
        <div className="suggest-autochoose">
          <button
            type="button"
            role="switch"
            aria-checked={autoChoose}
            className={`suggest-autochoose-toggle ${autoChoose ? 'on' : 'off'}`}
            onClick={() => setAutoChoose(v => !v)}
            title="When ON, Suggest automatically re-picks the best duration and day pattern for a course whenever you change its number of sections, keeping your choices as conflict-free as possible. Turn OFF to keep every value exactly as you set it."
          >
            <span className="suggest-autochoose-track"><span className="suggest-autochoose-knob" /></span>
            <span className="suggest-autochoose-label">
              Auto-choose best options · <strong>{autoChoose ? 'On' : 'Off'}</strong>
            </span>
          </button>
          <span
            className="suggest-autochoose-help"
            tabIndex={0}
            title="Auto-choose keeps the rest of each course's settings optimal as you edit. When ON, changing a course's section count auto-adjusts its duration / day-pattern to avoid clashes. When OFF, nothing changes unless you change it."
          ><Ico name="info" /></span>

          {/* NEW-FU-655: Replace vs Add to schedule — how the generated sections
              reconcile with the term's CURRENT schedule. Two labelled segmented
              buttons, each with a tooltip. Default 'Replace' = today's behaviour. */}
          <div
            className="suggest-mode"
            role="radiogroup"
            aria-label="How to apply the suggested sections"
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'replace'}
              className={`suggest-mode-btn ${mode === 'replace' ? 'active' : ''}`}
              onClick={() => setMode('replace')}
              title="Replace the term's current schedule for the courses you generate — their existing sections are cleared and rebuilt from your selections. (Default.)"
            >Replace</button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'add'}
              className={`suggest-mode-btn ${mode === 'add' ? 'active' : ''}`}
              onClick={() => setMode('add')}
              title="Add to the term's current schedule — existing sections are kept, and Suggest only appends the newly generated ones (numbered so they don't collide)."
            >Add to</button>
            <span
              className="suggest-mode-help"
              tabIndex={0}
              title="Replace rebuilds each generated course from scratch (existing sections cleared). Add to keeps every existing section and only appends the new ones. Choose Add to when you want to grow the schedule without losing what's already there."
            ><Ico name="info" /></span>
          </div>
        </div>

        {/* NEW-FU-264: pre-flight banners. Loading is brief (one DB
            query + a greedy pass over ~30 courses), so we show a thin
            inline pill rather than a full-screen spinner. */}
        {loading && (
          <div className="suggest-banner suggest-banner-info">
            Computing recommendations…
          </div>
        )}
        {/* NEW-FU-312 (Phase 28): EADDRINUSE-aware build-mismatch banner.
            Shown when /health/build-match reports the running backend's
            git sha doesn't match the frontend's VITE_GIT_SHA — the
            "stuck on old backend" state. Surfaces the recommended
            `dev:fresh` script (FU-309) so the user has a one-line
            kill-and-restart they can copy-paste. */}
        {buildMismatch && (
          <div className="suggest-banner suggest-banner-warn">
            <div>
              <Ico name="alert" /> The scheduling service is not using the same application version as this page.
              Restart the local CSCVS services, then refresh this page.
            </div>
            <div style={{marginTop: 8, fontSize: '.82em'}}>
              <div>If this appears during a demonstration, ask the system maintainer to restart CSCVS.</div>
              <div style={{marginTop: 6}}>
                <a
                  href="/api/v1/health/version"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{textDecoration: 'underline', color: 'inherit'}}
                >Open service status</a>
                {' · '}
                <a
                  href="/api/v1/health/routes"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{textDecoration: 'underline', color: 'inherit'}}
                >Open service route check</a>
              </div>
            </div>
          </div>
        )}
        {recommendError && (
          <div className="suggest-banner suggest-banner-warn">
            <div>
              <Ico name="alert" /> Could not pre-compute recommendations ({recommendError}). Defaults shown — you can still run Suggest.
            </div>
            {/* NEW-FU-303 (Phase 27): when the failure is the "older build"
                signature, give the user a copy-pasteable restart command
                + a one-click "Verify routes loaded" link that opens the
                diagnostic in a new tab. The user has hit this banner
                across multiple phases despite the route being in code;
                actionable next-steps shortens the time-to-fix. */}
            {/application version|older build/i.test(recommendError) && (
              <div style={{marginTop: 8, fontSize: '.82em'}}>
                <div>Ask the system maintainer to restart CSCVS, then refresh this page.</div>
                <a
                  href="/api/v1/health/routes"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{textDecoration: 'underline', color: 'inherit'}}
                >Open service route check</a>
                {' · '}
                <a
                  href="/api/v1/health/version"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{textDecoration: 'underline', color: 'inherit'}}
                >Open service status</a>
              </div>
            )}
          </div>
        )}
        {!loading && capacityWarnings.length > 0 && (
          <div className="suggest-banner suggest-banner-warn">
            <Ico name="alert" /> {capacityWarnings.length} course{capacityWarnings.length === 1 ? '' : 's'} could not be placed without conflicts. See per-course notes below.
          </div>
        )}
        {/* NEW-FU-651: per-gender Lec/Lab coexistence (R-14) block — Run is refused until fixed. */}
        {labError && labError.length > 0 && (
          <div className="suggest-banner suggest-banner-warn">
            <Ico name="alert" /> Each gender needs both a lecture and a lab:
            <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
              {labError.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          </div>
        )}

        <div className="suggest-table-wrap">
          {/* NEW-FU-224 (Phase 96): a sticky "select all" bar replaces the old
              table header, and the single-column table becomes a balanced
              multi-COLUMN card list (CSS columns) so a full course list fits
              without vertical scrolling. The per-column headers (Course / Level
              / # Sections / Schedule pattern) are dropped — each course card is
              self-labelling. */}
          <div className="suggest-apply-bar">
            <label className="suggest-apply-all-label" title="Toggle all courses on / off">
              <input
                ref={applyAllCheckboxRef}
                type="checkbox"
                checked={applyToCourseIds.size === courses.length && courses.length > 0}
                onChange={() => {
                  userTouchedSelectionRef.current = true; // (Phase 99 item 3)
                  if (applyToCourseIds.size === courses.length) {
                    setApplyToCourseIds(new Set());
                  } else {
                    setApplyToCourseIds(new Set(courses.map(c => c.id)));
                  }
                }}
              />
              <span>
                {applyToCourseIds.size === courses.length && courses.length > 0
                  ? 'Deselect all'
                  : 'Select all'}
              </span>
            </label>
          </div>

          <div className="suggest-list">
              {grouped.map(({ level, courses: cs }) => (
                <React.Fragment key={level}>
                  <div className="suggest-level-row" style={{
                    background: LEVEL_COLORS[level]?.bg,
                    color: LEVEL_COLORS[level]?.border,
                  }}>
                    {level}
                  </div>
                  {cs.map(course => {
                    const cfg = config[course.id] ?? {
                      sections: 1,
                      duration: defaultDurationFor(course),
                      dayPattern: defaultDayTemplateFor(course, defaultDurationFor(course)),
                      labDuration: course.has_lab ? 50 : null,
                    };
                    // NEW-FU-249: 2-axis legal set — durations first,
                    // then day templates filtered by the chosen
                    // duration. The user moves left→right:
                    //   [50][75]  →  [STT][MW][ST][TT][Any day]
                    const legalDurs  = legalDurationsForCourse(course);
                    const legalDays  = legalDayTemplatesForCourse({
                      credits: course.credits, hasLab: course.has_lab,
                      isSeminar: isSeminarCourse(course),
                      duration: cfg.duration,
                    });
                    // Hide the duration toggle when only one is legal
                    // (1-credit courses) so it doesn't look pickable.
                    const showDurationToggle = legalDurs.length > 1;
                    // NEW-FU-265: rows that the user has unchecked are
                    // still rendered (so they can flip back) but visually
                    // dimmed so the apply set is glanceable.
                    const isApplied = applyToCourseIds.has(course.id);
                    const warning   = warningsByCourseId.get(course.id);
                    return (
                      <div key={course.id}
                        className={`suggest-course-card ${isApplied ? '' : 'suggest-course-row-skipped'}`}
                        style={{ '--row-accent': LEVEL_COLORS[level]?.border ?? '#cbd5e1' }}>
                        <div className="suggest-card-head">
                          {/* NEW-FU-265: apply checkbox — disabled while the
                              recommend dry-run is in flight. */}
                          <input
                            className="suggest-apply-cb"
                            type="checkbox"
                            checked={isApplied}
                            onChange={() => toggleApply(course.id)}
                            disabled={loading}
                            title={isApplied ? 'Will be regenerated' : 'Skipped — existing sections preserved'}
                          />
                          <span className="suggest-card-title">
                            <span className="suggest-code">{course.course_code}</span>
                            <span className="suggest-name">{course.name}</span>
                            <span className="suggest-credits">
                              {course.credits} cr{course.has_lab ? ' · lab' : isSeminarCourse(course) ? ' · seminar' : ''}
                            </span>
                          </span>
                          <span className="suggest-cat"
                            style={{color: LEVEL_COLORS[level]?.border}}>
                            {course.category}
                          </span>
                          {/* NEW-FU-649: per-gender counters replace the single "# Sec". Each clamps
                              to [0,10]; the total (M+F) must be ≥1 to generate (a course zeroed on
                              BOTH genders is left untouched — see handleSubmit). Female lectures get
                              their own gender-matched lab(s) automatically (one lab per 3 lectures). */}
                          <span className="suggest-sections-field" title="Male / Female lecture sections to generate (total must be ≥ 1)">
                            <label className="suggest-gender-counter" title="Male sections">
                              <span className="suggest-sections-label">M</span>
                              <input
                                type="number" min="0" max="10"
                                value={cfg.maleSections ?? 0}
                                onChange={e => {
                                  const r = parseInt(e.target.value, 10);
                                  setField(course.id, 'maleSections', Number.isFinite(r) ? Math.max(0, Math.min(10, r)) : 0);
                                }}
                                className="suggest-num-input"
                              />
                            </label>
                            <label className="suggest-gender-counter" title="Female sections">
                              <span className="suggest-sections-label">F</span>
                              <input
                                type="number" min="0" max="10"
                                value={cfg.femaleSections ?? 0}
                                onChange={e => {
                                  const r = parseInt(e.target.value, 10);
                                  setField(course.id, 'femaleSections', Number.isFinite(r) ? Math.max(0, Math.min(10, r)) : 0);
                                }}
                                className="suggest-num-input"
                              />
                            </label>
                          </span>
                        </div>
                        {/* NEW-FU-266: per-course capacity warning from the
                            recommend dry-run — text comes verbatim from the
                            backend ("No conflict-free slot found…"). */}
                        {warning && (
                          <div className="suggest-capacity-warning" title="From dry-run greedy pass">
                            <Ico name="alert" /> {warning.message}
                          </div>
                        )}
                        <div className="suggest-card-body">
                          <div className="suggest-section-block suggest-lec-block">
                            {course.has_lab && (
                              <div className="suggest-section-heading suggest-lec-heading">
                                Lecture section
                              </div>
                            )}
                          {/* NEW-FU-249: 2-step layout —
                              Step 1: duration toggle (hidden when only
                                one duration is legal).
                              Step 2: day-template buttons filtered to
                                those legal for the chosen duration. */}
                          {/* NEW-FU-650: ALWAYS show the duration. With a real choice → clickable
                              buttons; when the course's credits/flags mandate exactly ONE duration →
                              show it as a DISABLED button with a tooltip explaining why it's fixed,
                              so the user still sees the duration (instead of the toggle being hidden). */}
                          {legalDurs.length > 0 && (
                            <div className="suggest-step suggest-duration-step">
                              <span className="suggest-step-label">Duration</span>
                              <div className="suggest-pattern-group suggest-duration-group">
                                {showDurationToggle ? (
                                  legalDurs.map(d => (
                                    <label key={d} className={`suggest-pattern-btn ${cfg.duration === d ? 'active' : ''}`}>
                                      <input type="radio" name={`dur-${course.id}`}
                                        value={d} checked={cfg.duration === d}
                                        onChange={() => setField(course.id, 'duration', d)} />
                                      <span>{d} min</span>
                                    </label>
                                  ))
                                ) : (
                                  <span
                                    className="suggest-pattern-btn active suggest-pattern-btn-fixed"
                                    aria-disabled="true"
                                    title={isSeminarCourse(course)
                                      ? 'A seminar meets once per week for 75 minutes.'
                                      : `A ${course.credits}-credit${course.has_lab ? ' with-lab' : ''} course meets only in ${legalDurs[0]}-minute sessions — its credits and flags fix the lecture duration, so there's nothing to choose here.`}
                                  >{legalDurs[0]} min</span>
                                )}
                              </div>
                            </div>
                          )}
                          <div className="suggest-step suggest-days-step">
                            <span className="suggest-step-label">Days</span>
                            <div className="suggest-pattern-group">
                              {/* NEW-FU-335 (Phase 31): duration was
                                  redundantly repeated on every day-
                                  pattern button (e.g., "Mon / Wed 75
                                  min/class"). The duration row right
                                  above already shows the selected
                                  value, so showing it again was noise.
                                  Day-pattern buttons now show ONLY
                                  the day label. */}
                              {legalDays.map(tpl => (
                                <label key={tpl} className={`suggest-pattern-btn ${cfg.dayPattern === tpl ? 'active' : ''}`}>
                                  <input type="radio" name={`day-${course.id}`}
                                    value={tpl} checked={cfg.dayPattern === tpl}
                                    onChange={() => setField(course.id, 'dayPattern', tpl)} />
                                  <span>{DAY_TEMPLATE_LABELS[tpl]}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                          {/* NEW-FU-254: when the chosen template is
                              ONE_DAY (1-credit, 2-cr 75min), render an
                              explicit 5-button row so the user picks
                              the actual weekday. The synthetic "Any day"
                              placeholder is gone; cfg.day flows directly
                              into the suggester request. */}
                          {cfg.dayPattern === 'ONE_DAY' && (
                            <div className="suggest-step suggest-day-step">
                              <span className="suggest-step-label">Pick day</span>
                              <div className="suggest-pattern-group">
                                {WEEKDAYS.map(d => (
                                  <label key={d} className={`suggest-pattern-btn suggest-weekday-btn ${cfg.day === d ? 'active' : ''}`}>
                                    <input type="radio" name={`weekday-${course.id}`}
                                      value={d} checked={cfg.day === d}
                                      onChange={() => setField(course.id, 'day', d)} />
                                    <span>{DAY_SHORT[d]}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          )}
                          </div>{/* close .suggest-lec-block */}
                          {/* NEW-FU-249 (item 2): lab sub-block — only
                              for courses with has_lab. The lab day is
                              chosen by the suggester (FU-241 expands
                              ONE_DAY to 5 single-day combos for the
                              greedy phase). The user picks the lab
                              duration only. */}
                          {/* NEW-FU-254 + FU-255: lab sub-block now has
                              TWO steps (duration + explicit day) and a
                              header parallel to LECTURE SECTION so the
                              visual hierarchy reads cleanly. */}
                          {course.has_lab && (
                            <div className="suggest-section-block suggest-lab-block">
                              <div className="suggest-section-heading suggest-lab-heading">
                                <span>Lab section</span>
                                {/* NEW-FU-651: per-gender lab counters (parallel to the lecture M/F
                                    counters). A gender with ≥1 lecture must have ≥1 lab of that gender
                                    and vice versa (R-14) — enforced before Run + on the backend. */}
                                <span className="suggest-lab-counters">
                                  <label className="suggest-gender-counter" title="Male lab sections">
                                    <span className="suggest-sections-label">M</span>
                                    <input type="number" min="0" max="10" value={cfg.maleLabSections ?? 0}
                                      onChange={e => { const r = parseInt(e.target.value, 10); setField(course.id, 'maleLabSections', Number.isFinite(r) ? Math.max(0, Math.min(10, r)) : 0); }}
                                      className="suggest-num-input" />
                                  </label>
                                  <label className="suggest-gender-counter" title="Female lab sections">
                                    <span className="suggest-sections-label">F</span>
                                    <input type="number" min="0" max="10" value={cfg.femaleLabSections ?? 0}
                                      onChange={e => { const r = parseInt(e.target.value, 10); setField(course.id, 'femaleLabSections', Number.isFinite(r) ? Math.max(0, Math.min(10, r)) : 0); }}
                                      className="suggest-num-input" />
                                  </label>
                                </span>
                              </div>
                              <div className="suggest-step">
                                <span className="suggest-step-label">Duration</span>
                                <div className="suggest-pattern-group">
                                  {LAB_DURATIONS.map(d => (
                                    <label key={d} className={`suggest-pattern-btn suggest-lab-btn ${cfg.labDuration === d ? 'active' : ''}`}>
                                      <input type="radio" name={`lab-dur-${course.id}`}
                                        value={d} checked={cfg.labDuration === d}
                                        onChange={() => setField(course.id, 'labDuration', d)} />
                                      <span>{d === 160 ? '2h 40m' : `${d} min`}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                              <div className="suggest-step">
                                <span className="suggest-step-label">Pick day</span>
                                <div className="suggest-pattern-group">
                                  {WEEKDAYS.map(d => (
                                    <label key={d} className={`suggest-pattern-btn suggest-weekday-btn ${cfg.labDay === d ? 'active' : ''}`}>
                                      <input type="radio" name={`lab-day-${course.id}`}
                                        value={d} checked={cfg.labDay === d}
                                        onChange={() => setField(course.id, 'labDay', d)} />
                                      <span>{DAY_SHORT[d]}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>{/* close .suggest-card-body */}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
          </div>{/* close .suggest-list */}
        </div>

        {/* NEW-FU-223 (Phase 96): the "Advanced → conflict tolerance" knob was
            removed. Asking the user to pre-pick how many conflicts to allow is
            backwards. A one-line note now sets the expectation; the real
            decision happens after the run, only if needed (see runSuggest). */}
        <p className="suggest-foot-note">
          Suggest aims for a <strong>conflict-free</strong> schedule. If your choices
          can’t all fit, it’ll show you what clashes and offer to adjust them for you.
        </p>

        <div className="sm-actions" style={{padding:'0 24px 20px'}}>
          <button className="sm-btn-cancel" onClick={onClose}>Cancel</button>
          {/* NEW-FU-264/265: button is disabled while the recommend pass
              is in flight (we don't know yet what defaults to send), and
              also when the user has unchecked every row (nothing to do).
              The applied-count badge tells the user "yes, the button
              will only touch N of M courses." */}
          <button className="sm-btn-save" onClick={handleSubmit}
            disabled={courses.length === 0 || loading || applyToCourseIds.size === 0}>
            <Ico name="sparkles" /> Run Suggest
            {applyToCourseIds.size < courses.length && courses.length > 0 && (
              <span className="suggest-apply-badge">
                {applyToCourseIds.size} of {courses.length}
              </span>
            )}
            {' →'}
          </button>
        </div>
      </div>
    </div>
  );
}
