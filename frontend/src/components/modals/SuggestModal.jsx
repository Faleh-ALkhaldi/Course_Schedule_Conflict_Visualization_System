import React, { useState, useEffect, useRef } from 'react';
import { useApp, LEVEL_COLORS } from '../../context/AppContext.jsx';
import { suggestRecommend } from '../../api/index.js';
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
function legalDurationsForCourse({ credits }) {
  const c = Number(credits);
  if (c === 1) return [50];
  if (c >= 2 && c <= 4) return [50, 75];
  return [];
}
function legalDayTemplatesForCourse({ credits, hasLab, duration }) {
  const c = Number(credits);
  const d = Number(duration);
  if (c === 1 && d === 50) return ['ONE_DAY'];
  if (c === 2 && d === 50) return ['ST', 'MW', 'TT'];
  if (c === 2 && d === 75) return ['ONE_DAY'];
  if (c === 3 && d === 50) return hasLab ? ['STT', 'ST', 'MW', 'TT'] : ['STT'];
  if (c === 3 && d === 75) return ['MW', 'ST', 'TT'];
  if (c === 4 && d === 50) return ['STT', 'ST', 'MW', 'TT'];
  if (c === 4 && d === 75) return ['MW', 'ST', 'TT'];
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
    credits: course.credits, hasLab: course.has_lab, duration,
  });
  return opts[0] ?? 'STT';
}

// Lab section options — fixed across all hasLab courses. The
// user picks BOTH the duration AND the specific day (FU-254
// replaces the prior "Any day" placeholder with explicit per-day
// buttons so the choice is unambiguous).
const LAB_DURATIONS = [50, 75, 165];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
// Short labels for the day buttons to keep the row compact.
const DAY_SHORT = { Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu' };

export default function SuggestModal({ scheduleId, onConfirm, onClose }) {
  // NEW-FU-35: Escape dismisses the modal, matching the pattern used by the
  // other modals (SoftConflictModal / OfficeHourModal / GroupChangeModal).
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const { courses } = useApp();

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
  const [applyToCourseIds, setApplyToCourseIds] = useState(() => new Set(courses.map(c => c.id)));
  // NEW-FU-317 (Phase 29): tunable conflict tolerance dropdown in
  // Advanced. Default 'any' (legacy behavior). When the user picks 0/1/2,
  // the backend will SKIP placements that would create more conflicts
  // than the tolerance allows, returning them in placementSkipped[].
  // Sensible default for inexperienced users = 'any' (don't introduce
  // surprise refusals); strict modes are opt-in.
  const [maxConflictsPerSection, setMaxConflictsPerSection] = useState('any');
  const [showAdvanced, setShowAdvanced] = useState(false);

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
        sections:    1,
        duration,
        dayPattern,
        day:         'Sunday',
        labDuration: c.has_lab ? 50 : null,
        labDay:      c.has_lab ? 'Sunday' : null,
      };
    }
    return init;
  });

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
              sections:    r.sections    ?? cur.sections,
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
              message = 'The backend is running an older build that does not have the /suggest-recommend route. Restart the dev server and refresh.';
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
    setConfig(prev => {
      const next = { ...prev, [courseId]: { ...prev[courseId], [field]: value } };
      // NEW-FU-249: when duration changes, the dayPattern may become
      // illegal (e.g., user was on STT @ 50min for a 3-cr course,
      // then switches to 75min — STT only exists at 50min). Auto-
      // reset to the first legal template for the new duration.
      if (field === 'duration') {
        const course = courses.find(c => c.id === courseId);
        const legalDayTemplates = legalDayTemplatesForCourse({
          credits: course.credits, hasLab: course.has_lab, duration: value,
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
  const sectionsKey = React.useMemo(
    () => Object.entries(config).map(([id, c]) => `${id}:${c.sections}`).sort().join('|'),
    [config],
  );
  const isFirstRecommendRef = React.useRef(true);
  React.useEffect(() => {
    if (!scheduleId) return;
    if (isFirstRecommendRef.current) {
      // Skip the initial mount; the original useEffect at line ~206
      // handles the first /suggest-recommend call.
      isFirstRecommendRef.current = false;
      return;
    }
    const sectionsHint = {};
    for (const [id, cfg] of Object.entries(config)) {
      const n = Number(cfg.sections);
      if (Number.isFinite(n) && n >= 1) sectionsHint[id] = n;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const result = await suggestRecommend(scheduleId, { sectionsHint });
        if (cancelled) return;
        setConfig(prev => {
          const next = { ...prev };
          for (const r of result.recommendations ?? []) {
            const cur = prev[r.courseId];
            if (!cur) continue;
            // Only update duration / dayPattern / day / labDuration /
            // labDay — preserve the user's `sections` choice (that's
            // what triggered this re-recommend).
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
        // Silent failure — keep the user's current config and let them
        // proceed. The main recommend already handles loud failures.
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionsKey]);

  // NEW-FU-265: per-course apply checkbox. The Set wrapper makes
  // toggle/has/size cheap and avoids the "filtered list" rebuild on
  // every keystroke. Default: all courses checked (legacy behavior).
  function toggleApply(courseId) {
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
    const applyAll  = applyToCourseIds.size === courses.length;
    const targetIds = applyAll ? null : [...applyToCourseIds];

    // Build the request payload using the new two-axis shape. Belt-
    // and-suspenders: if a course somehow has no config entry yet,
    // fall back to the canonical defaults.
    const payload = courses
      .filter(c => applyToCourseIds.has(c.id))
      .map(c => {
        const cfg = config[c.id] ?? {
          sections: 1,
          duration: defaultDurationFor(c),
          dayPattern: defaultDayTemplateFor(c, defaultDurationFor(c)),
          day: 'Sunday',
        };
        return {
          courseId:   c.id,
          courseCode: c.course_code,
          sections:   parseInt(cfg.sections),
          dayPattern: cfg.dayPattern,
          duration:   cfg.duration,
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
          } : {}),
        };
      });
    // NEW-FU-317: pass maxConflictsPerSection through. 'any' = legacy
    // "force everything"; 0/1/2 = strict — sections that would
    // exceed the tolerance get skipped + reported in placementSkipped.
    onConfirm(payload, targetIds, maxConflictsPerSection);
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
      <div className="sm-card suggest-card">
        <div className="sm-header">
          <h2 className="sm-title">✦ Auto-Suggest Schedule</h2>
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
            <span className="suggest-recommend-badge">✦ Recommendations pre-filled</span>
          )}
        </p>

        {/* NEW-FU-264: pre-flight banners. Loading is brief (one DB
            query + a greedy pass over ~30 courses), so we show a thin
            inline pill rather than a full-screen spinner. */}
        {loading && (
          <div className="suggest-banner suggest-banner-info">
            ⏳ Computing recommendations…
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
              ⚠️ The backend on port 4000 is running an older build than this page.
              Your previous <code>npm run dev</code> likely hit <code>EADDRINUSE</code> and
              the new process crashed without replacing the old one.
            </div>
            <div style={{marginTop: 8, fontSize: '.82em', fontFamily: 'var(--font-mono)'}}>
              <div>One-line fix (kills any stale process, then starts fresh):</div>
              <pre style={{
                margin: '4px 0',
                padding: '6px 8px',
                background: 'rgba(0,0,0,0.06)',
                borderRadius: 4,
                fontSize: '.92em',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
{`cd backend && npm run dev:fresh`}
              </pre>
              <div style={{marginTop: 4}}>Or, manually:</div>
              <pre style={{
                margin: '4px 0',
                padding: '6px 8px',
                background: 'rgba(0,0,0,0.06)',
                borderRadius: 4,
                fontSize: '.92em',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
{`lsof -ti:4000 | xargs kill -9 && cd backend && npm run dev`}
              </pre>
              <div style={{marginTop: 4}}>Then hard-refresh this page (Cmd+Shift+R).</div>
              <div style={{marginTop: 6}}>
                <a
                  href="/api/v1/health/version"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{textDecoration: 'underline', color: 'inherit'}}
                >Check running backend version</a>
                {' · '}
                <a
                  href="/api/v1/health/routes"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{textDecoration: 'underline', color: 'inherit'}}
                >Verify routes loaded</a>
              </div>
            </div>
          </div>
        )}
        {recommendError && (
          <div className="suggest-banner suggest-banner-warn">
            <div>
              ⚠ Could not pre-compute recommendations ({recommendError}). Defaults shown — you can still run Suggest.
            </div>
            {/* NEW-FU-303 (Phase 27): when the failure is the "older build"
                signature, give the user a copy-pasteable restart command
                + a one-click "Verify routes loaded" link that opens the
                diagnostic in a new tab. The user has hit this banner
                across multiple phases despite the route being in code;
                actionable next-steps shortens the time-to-fix. */}
            {/older build/i.test(recommendError) && (
              <div style={{marginTop: 8, fontSize: '.82em', fontFamily: 'var(--font-mono)'}}>
                <div>To restart the backend:</div>
                <pre style={{
                  margin: '4px 0',
                  padding: '6px 8px',
                  background: 'rgba(0,0,0,0.06)',
                  borderRadius: 4,
                  fontSize: '.92em',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>
{`# In the terminal running the backend, hit Ctrl+C, then:
cd backend && npm run dev`}
                </pre>
                <a
                  href="/api/v1/health/routes"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{textDecoration: 'underline', color: 'inherit'}}
                >Verify routes loaded</a>
                {' · '}
                <a
                  href="/api/v1/health/version"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{textDecoration: 'underline', color: 'inherit'}}
                >Check running build version</a>
              </div>
            )}
          </div>
        )}
        {!loading && capacityWarnings.length > 0 && (
          <div className="suggest-banner suggest-banner-warn">
            ⚠ {capacityWarnings.length} course{capacityWarnings.length === 1 ? '' : 's'} could not be placed without conflicts. See per-course notes below.
          </div>
        )}

        <div className="suggest-table-wrap">
          <table className="suggest-table">
            <thead>
              <tr>
                {/* NEW-FU-265: apply checkbox column. Header has the
                    "all-or-none" toggle so a user wanting to run on
                    just 1-2 courses can flip everything off first
                    then pick.
                    NEW-FU-286 (Phase 24): the unlabeled checkbox in the
                    header was undiscoverable — users only realized it
                    toggled all rows by clicking it. Now wrapped in a
                    <label> with visible "Apply all" text, plus the
                    indeterminate state for partial selections (handled
                    via a ref + useEffect below since React doesn't
                    accept `indeterminate` as a JSX prop directly). */}
                {/* NEW-FU-297 (Phase 26): single-line label + dynamic
                    "Select all" / "Deselect all" text. The 92px width
                    was making the label wrap to two lines ("APPLY /
                    ALL") — bumped to 110px so the longer
                    "Deselect all" text also fits on one line. The
                    label SWAPS based on selection: "Select all" when
                    nothing/partial is checked (the action that would
                    apply), "Deselect all" when everything is checked. */}
                <th style={{textAlign:'center', width: 110, whiteSpace: 'nowrap'}} colSpan={1}>
                  <label className="suggest-apply-all-label" title="Toggle all courses on / off">
                    <input
                      ref={applyAllCheckboxRef}
                      type="checkbox"
                      checked={applyToCourseIds.size === courses.length && courses.length > 0}
                      onChange={() => {
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
                </th>
                <th>Course</th>
                <th>Level</th>
                <th style={{textAlign:'center'}}># Sections</th>
                <th>Schedule pattern</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(({ level, courses: cs }) => (
                <React.Fragment key={level}>
                  <tr className="suggest-level-row">
                    {/* NEW-FU-265: colSpan bumped 4→5 to account for the
                        new apply-checkbox column. */}
                    <td colSpan={5} style={{
                      background: LEVEL_COLORS[level]?.bg,
                      color: LEVEL_COLORS[level]?.border,
                      fontWeight: 700, fontSize: '.72rem',
                      textTransform: 'uppercase', letterSpacing: '.06em',
                      padding: '4px 12px',
                    }}>
                      {level}
                    </td>
                  </tr>
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
                      <tr key={course.id} className={`suggest-course-row ${isApplied ? '' : 'suggest-course-row-skipped'}`}
                          style={{
                            // NEW-FU-258: pass the level color through
                            // as a CSS custom property. Border-collapse
                            // separate mode (FU-258) doesn't render
                            // <tr> borders, so the first <td> reads
                            // --row-accent from this var and renders
                            // the 3px left stripe itself.
                            '--row-accent': LEVEL_COLORS[level]?.border ?? '#cbd5e1',
                          }}>
                        {/* NEW-FU-265: apply checkbox. Disabled while
                            the recommend call is in flight so the user
                            can't unintentionally untick what's still
                            being computed. */}
                        <td style={{textAlign:'center'}}>
                          <input
                            type="checkbox"
                            checked={isApplied}
                            onChange={() => toggleApply(course.id)}
                            disabled={loading}
                            title={isApplied ? 'Will be regenerated' : 'Skipped — existing sections preserved'}
                          />
                        </td>
                        <td>
                          <span className="suggest-code">{course.course_code}</span>
                          <span className="suggest-name">{course.name}</span>
                          <span className="suggest-credits">
                            {course.credits} cr{course.has_lab ? ' · lab' : ''}
                          </span>
                          {/* NEW-FU-266: per-course capacity warning,
                              inline under the course name so the cause
                              is obvious. The text comes verbatim from
                              the recommend pass — backend already
                              formats it ("No conflict-free slot
                              found…"). */}
                          {warning && (
                            <div className="suggest-capacity-warning" title="From dry-run greedy pass">
                              ⚠ {warning.message}
                            </div>
                          )}
                        </td>
                        <td>
                          <span className="suggest-cat"
                            style={{color: LEVEL_COLORS[level]?.border}}>
                            {course.category}
                          </span>
                        </td>
                        <td style={{textAlign:'center'}}>
                          <input
                            type="number" min="1" max="10"
                            value={cfg.sections}
                            onChange={e => setField(course.id, 'sections', e.target.value)}
                            className="suggest-num-input"
                          />
                        </td>
                        <td>
                          {/* NEW-FU-255: when the course has a lab,
                              wrap the lecture inputs in a labeled
                              section block so the two parts (lecture
                              vs lab) read as parallel sub-sections.
                              For courses WITHOUT a lab the heading
                              is suppressed — adding it for every row
                              would just be visual noise. */}
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
                          {showDurationToggle && (
                            <div className="suggest-step suggest-duration-step">
                              <span className="suggest-step-label">Duration</span>
                              <div className="suggest-pattern-group suggest-duration-group">
                                {legalDurs.map(d => (
                                  <label key={d} className={`suggest-pattern-btn ${cfg.duration === d ? 'active' : ''}`}>
                                    <input type="radio" name={`dur-${course.id}`}
                                      value={d} checked={cfg.duration === d}
                                      onChange={() => setField(course.id, 'duration', d)} />
                                    <span>{d} min</span>
                                  </label>
                                ))}
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
                                Lab section
                              </div>
                              <div className="suggest-step">
                                <span className="suggest-step-label">Duration</span>
                                <div className="suggest-pattern-group">
                                  {LAB_DURATIONS.map(d => (
                                    <label key={d} className={`suggest-pattern-btn suggest-lab-btn ${cfg.labDuration === d ? 'active' : ''}`}>
                                      <input type="radio" name={`lab-dur-${course.id}`}
                                        value={d} checked={cfg.labDuration === d}
                                        onChange={() => setField(course.id, 'labDuration', d)} />
                                      <span>{d === 165 ? '2h 45m' : `${d} min`}</span>
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
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* NEW-FU-317 (Phase 29): Advanced disclosure with the
            conflict-tolerance knob. Collapsed by default so it doesn't
            clutter the modal for the 95% of users who want default
            behavior. Power users with saturated schedules can dial in
            "skip placements that would create conflicts" mode to avoid
            silently shipping a schedule with R-02/R-04/R-05 warnings. */}
        <div style={{padding:'0 24px 8px', fontSize: '.78rem'}}>
          <button
            type="button"
            onClick={() => setShowAdvanced(s => !s)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--slate-500)',
              cursor: 'pointer',
              padding: 0,
              fontSize: '.78rem',
              fontWeight: 600,
              letterSpacing: '.02em',
            }}
            title="Advanced controls for power users"
          >
            {showAdvanced ? '▾ Advanced' : '▸ Advanced'}
          </button>
          {showAdvanced && (
            <div style={{marginTop: 8, padding: '8px 12px', background: 'var(--slate-50)', border: '1px solid var(--slate-200)', borderRadius: 6}}>
              <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                <span style={{minWidth: 180, color: 'var(--slate-700)'}}>Conflict tolerance per section:</span>
                <select
                  value={maxConflictsPerSection}
                  onChange={(e) => setMaxConflictsPerSection(
                    e.target.value === 'any' ? 'any' : parseInt(e.target.value, 10)
                  )}
                  style={{padding: '4px 8px', borderRadius: 4, border: '1px solid var(--slate-300)'}}
                >
                  <option value="any">Any (force-place everything, legacy)</option>
                  <option value="0">0 — skip any section that would create a conflict</option>
                  <option value="1">1 — allow up to 1 soft conflict per section</option>
                  <option value="2">2 — allow up to 2 soft conflicts per section</option>
                </select>
              </label>
              <div style={{marginTop: 6, color: 'var(--slate-500)', fontSize: '.72rem'}}>
                Strict modes (0/1/2) skip sections that the greedy can't fit cleanly. Skipped
                sections appear in a follow-up toast naming the course + reason.
              </div>
            </div>
          )}
        </div>

        <div className="sm-actions" style={{padding:'0 24px 20px'}}>
          <button className="sm-btn-cancel" onClick={onClose}>Cancel</button>
          {/* NEW-FU-264/265: button is disabled while the recommend pass
              is in flight (we don't know yet what defaults to send), and
              also when the user has unchecked every row (nothing to do).
              The applied-count badge tells the user "yes, the button
              will only touch N of M courses." */}
          <button className="sm-btn-save" onClick={handleSubmit}
            disabled={courses.length === 0 || loading || applyToCourseIds.size === 0}>
            ✦ Run Suggest
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
