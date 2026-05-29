/**
 * SuggestService — assign time slots AND instructors to minimize conflicts.
 *
 * Constraints:
 *   - Max 4 courses in the same time slot (5 acceptable, 6+ rejected)
 *   - Instructor must be free at the assigned time (no double booking)
 *   - Instructor must not have office hours at the assigned time
 *   - GR courses: 17:00–22:00 only
 *   - UG courses: 07:00–17:00 only
 *
 * Algorithm: greedy + instructor assignment
 *   1. Delete all existing sections
 *   2. Build task list (one per section group)
 *   3. Sort by most constrained
 *   4. For each task: score each (slot × instructor) combination
 *   5. Pick best combo, write to DB
 */
const { query, getClient } = require('../config/db');
const ConflictEngine       = require('../engine/ConflictEngine');
const SectionRepository    = require('../repositories/SectionRepository');
const InstructorRepository = require('../repositories/InstructorRepository');
const Section              = require('../domain/Section');
// NEW-FU-25: use the constant instead of the literal 'Finalized'. Same value
// today; insulates from a future status-enum rename.
const { SCHEDULE_STATUS, ACADEMIC_LEVELS: ACADEMIC_LEVEL_NUM }  = require('../config/constants');

const engine      = new ConflictEngine();
const sectionRepo = new SectionRepository();
const instrRepo   = new InstructorRepository();

// NEW-FU-241: pattern resolution moved into sectionPattern.js so the
// suggester, modal, and validator all share one source of truth.
// Legacy STT/MW constants kept for backward-compat with any caller
// that still passes the old short names.
const { resolvePattern } = require('../domain/sectionPattern');
const STT_DAYS = ['Sunday','Tuesday','Thursday'];
const MW_DAYS  = ['Monday','Wednesday'];
const DURATION  = { STT: 50, MW: 75 };
const MAX_PARALLEL_HARD = 4; // 5+ not allowed (hard reject); 4 = max ideal

function fromMin(m) {
  return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
}
function toMin(t) {
  if (!t) return 0;
  const [h,m] = t.substring(0,5).split(':').map(Number);
  return h*60+m;
}
function timesOverlap(s1, e1, s2, e2) {
  return toMin(s1) < toMin(e2) && toMin(s2) < toMin(e1);
}

// NEW-FU-241: pattern-aware slot generator. resolvePattern() returns
// a { dayCombos, duration } shape: an ARRAY of day-combos (so the
// ONE_DAY_* synthetic patterns can expand to 5 single-day candidates
// for the greedy phase) plus the fixed duration. For multi-day
// patterns dayCombos is just [days].
function generateSlots(pattern, category) {
  const resolved = resolvePattern(pattern);
  if (!resolved) {
    // Unknown pattern → empty slot list. The suggester will skip this
    // task with no candidates; caller should validate input upstream.
    return [];
  }
  const { dayCombos, duration } = resolved;
  const startH = category === 'GR' ? 17 : 7;
  const endH   = category === 'GR' ? 22 : 17;
  const slots = [];
  for (const days of dayCombos) {
    for (let start = startH * 60; start + duration <= endH * 60; start += 30) {
      slots.push({
        days,
        startTime: fromMin(start),
        endTime:   fromMin(start + duration),
      });
    }
  }
  return slots;
}

// NEW-FU-111: Lab-specific slot generator. Labs are once-a-week on any
// single day, with the standard 165-minute (2h45min) duration (Feature 3
// default — also the longest of the legal range so the slot is the most
// constrained, yielding the most predictable placement). The slot search
// covers every weekday so the greedy assigner has maximum room.
const LAB_DURATION = 165;
const ALL_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
// NEW-FU-252: generateLabSlots now accepts optional { day, duration }
// overrides. `day` constrains the slot search to a single weekday
// (when the user picks one in the modal); `duration` overrides the
// 165-min default (the modal lets the user pick 50/75/165).
// Defaults (no overrides) preserve pre-FU-252 behavior so legacy
// callers continue to work unchanged.
function generateLabSlots(category, { day, duration } = {}) {
  const dur = Number(duration) || LAB_DURATION;
  const days = day ? [day] : ALL_WEEKDAYS;
  const startH = category === 'GR' ? 17 : 7;
  const endH   = category === 'GR' ? 22 : 17;
  const slots = [];
  for (const d of days) {
    for (let start = startH * 60; start + dur <= endH * 60; start += 30) {
      slots.push({ days: [d], startTime: fromMin(start), endTime: fromMin(start + dur) });
    }
  }
  return slots;
}

/** Count how many distinct courses are already placed in the same time window on the same days */
function countParallelCourses(slot, working) {
  const courseIds = new Set();
  for (const sec of working) {
    if (!slot.days.includes(sec.day)) continue;
    if (timesOverlap(slot.startTime, slot.endTime, sec.startTime, sec.endTime)) {
      courseIds.add(sec.courseId);
    }
  }
  return courseIds.size;
}

/** Check if instructor is free at the given slot (no sections, no office hours) */
function instructorIsFree(instructor, slot, working, ohMap) {
  if (!instructor) return true;

  // Check existing sections
  for (const sec of working) {
    if (sec.instructorId !== instructor.id) continue;
    if (!slot.days.includes(sec.day)) continue;
    if (timesOverlap(slot.startTime, slot.endTime, sec.startTime, sec.endTime)) return false;
  }

  // Check office hours
  const ohs = ohMap.get(instructor.id) ?? [];
  for (const oh of ohs) {
    if (!slot.days.includes(oh.day)) continue;
    const ohStart = oh.start_time ?? oh.startTime;
    const ohEnd   = oh.end_time   ?? oh.endTime;
    if (timesOverlap(slot.startTime, slot.endTime, ohStart, ohEnd)) return false;
  }

  return true;
}

// NEW-FU-340 (Phase 32): per-rule weights. The Phase 21..31 algorithm
// counted every soft conflict as +1, so R-02 (single-section course
// blocked by a same-level peer — really bad for students) was tied
// with R-13 (instructor missing OHs — administrative annoyance). The
// greedy ended up accepting placements that traded R-13 for R-02, a
// bad trade. The weights below let the scorer treat R-02 as 5x worse
// than R-13.
//
// Heuristic tuning (not load-tested — adjust if Phase 32+ surfaces
// schedules the greedy can't resolve):
//   • HARD (R-01/R-04/R-05/R-06)     : 1000 — effectively reject
//   • R-02 adjacent-level / 1-sect    :   50 — strongly penalize
//   • R-11 / R-12 venue-type mismatch :   20 — moderate
//   • R-09 / R-10 missing instr/venue :   10 — fixable in side panel
//   • R-13 instructor no OH           :    5 — admin task, low priority
//   • R-14 lec/lab coexistence        :   30 — schedule structural issue
//   • R-15 credit coverage            :   30 — same
//   • unknown ruleIds                 :    1 — fallback so new rules
//                                              still contribute SOMETHING
const RULE_WEIGHTS = {
  'R-01': 1000,
  'R-02':   50,
  'R-04': 1000,
  'R-05': 1000,
  'R-06':  100,   // graduate time window — sometimes soft, sometimes hard
  'R-09':   10,
  'R-10':   10,
  'R-11':   20,
  'R-12':   20,
  'R-13':    5,
  'R-14':   30,
  'R-15':   30,
};
function ruleWeight(ruleId) {
  return RULE_WEIGHTS[ruleId] ?? 1;
}

// NEW-FU-116: count TOTAL conflicts that would fire on a given attempt's
// finished assignment set. Used by the multi-start outer loop to compare
// attempts. Mirrors the logic in ScheduleService._evaluateSchedule but
// runs in-memory (no DB) and uses the venue-enriched assignment shape
// produced by attemptPickVenue so R-11/R-12 fire authoritatively.
//
// Phase 32 (FU-340): returns BOTH a raw count and a weighted total. The
// raw count is used by tests; the weighted total drives multi-restart's
// "best attempt" comparison so an attempt with 1 R-02 isn't tied with
// an attempt that has 5 R-13s.
function countAttemptConflicts(assignments, scheduleId, ohMap, engine) {
  // Build venue-enriched virtual rows so the type-checked rules can see
  // venueId/venueType. The shape mirrors what makeVirtualRows produces
  // BUT with venue + type info layered on.
  const rows = [];
  for (const { task, slot, instructor, venue } of assignments) {
    for (const day of slot.days) {
      rows.push(new Section({
        id:             `v-${task.courseId}-${task.sectionNumber}-${day}`,
        scheduleId,
        courseId:       task.courseId,
        instructorId:   instructor?.id ?? null,
        venueId:        venue?.id      ?? null,
        sectionNumber:  task.sectionNumber,
        day,
        startTime:      slot.startTime,
        endTime:        slot.endTime,
        courseCode:     task.courseCode,
        academicLevel:  task.academicLevel,
        category:       task.category,
        numSections:    task.totalSections,
        sectionType:    task.sectionType,
        venueType:      venue?.type ?? null,
        hasLab:         task.hasLab,
        // NEW-FU-392 (Phase 37): include credits so the R-15 detector
        // in countAttemptConflicts can compute credit coverage.
        // Without this the suggester's preview missed R-15 entirely.
        credits:        task.credits,
      }));
    }
  }

  // R-01..R-06 via the engine's deduped traversal.
  const engineResult = engine.evaluateAll(rows, ohMap);
  let total = engineResult.conflicts.length;
  // NEW-FU-340 (Phase 32): also accumulate a weighted total so the
  // multi-restart loop prefers attempts that minimize the high-impact
  // rules (R-02, R-15) over attempts that just minimize the count.
  let weighted = 0;
  for (const c of engineResult.conflicts) weighted += ruleWeight(c.ruleId);

  // R-09 — no instructor (deduped by canonical course|section).
  const seen09 = new Set();
  for (const sec of rows) {
    if (sec.instructorId) continue;
    const k = `${sec.courseId}|${sec.sectionNumber}`;
    if (!seen09.has(k)) { seen09.add(k); total++; weighted += ruleWeight('R-09'); }
  }
  // R-10 — no venue.
  const seen10 = new Set();
  for (const sec of rows) {
    if (sec.venueId) continue;
    const k = `${sec.courseId}|${sec.sectionNumber}`;
    if (!seen10.has(k)) { seen10.add(k); total++; weighted += ruleWeight('R-10'); }
  }
  // R-11 — Lab section in non-Lab venue.
  const seen11 = new Set();
  for (const sec of rows) {
    if (!sec.venueId || !sec.venueType) continue;
    if (sec.sectionType !== 'Lab' || sec.venueType === 'Laboratory') continue;
    const k = `${sec.courseId}|${sec.sectionNumber}`;
    if (!seen11.has(k)) { seen11.add(k); total++; weighted += ruleWeight('R-11'); }
  }
  // R-12 — Lec section in Lab venue.
  const seen12 = new Set();
  for (const sec of rows) {
    if (!sec.venueId || !sec.venueType) continue;
    if (sec.sectionType !== 'Lec' || sec.venueType !== 'Laboratory') continue;
    const k = `${sec.courseId}|${sec.sectionNumber}`;
    if (!seen12.has(k)) { seen12.add(k); total++; weighted += ruleWeight('R-12'); }
  }
  // R-13 — instructor with no office hours.
  const seen13 = new Set();
  for (const sec of rows) {
    if (!sec.instructorId) continue;
    if (seen13.has(sec.instructorId)) continue;
    if (!ohMap.has(sec.instructorId)) { seen13.add(sec.instructorId); total++; weighted += ruleWeight('R-13'); }
  }
  // R-14 — has_lab course missing Lec or Lab.
  const courseStatus = new Map();
  for (const sec of rows) {
    if (!sec.hasLab) continue;
    let s = courseStatus.get(sec.courseId);
    if (!s) { s = { hasLec: false, hasLab: false }; courseStatus.set(sec.courseId, s); }
    if (sec.sectionType === 'Lec') s.hasLec = true;
    if (sec.sectionType === 'Lab') s.hasLab = true;
  }
  for (const s of courseStatus.values()) {
    if (!(s.hasLec && s.hasLab)) { total++; weighted += ruleWeight('R-14'); }
  }

  // NEW-FU-392 (Phase 37): R-15 detection — credit coverage. The
  // Phase 36 preview omitted R-15 entirely, so the relaxer thought
  // ONE_DAY × 50min × 3-credit was a zero-conflict placement. Then
  // when the plan was applied, ScheduleService.revalidate fired R-15
  // and the user saw the conflict reappear. Mirror the QuickFix
  // evaluateInMemory R-15 logic exactly so the suggester's preview
  // sees the same conflicts as the runtime evaluator.
  const grp15 = new Map();
  for (const sec of rows) {
    if (sec.sectionType !== 'Lec') continue;
    if (!sec.credits) continue;
    if (!sec.startTime || !sec.endTime) continue;
    const key = `${sec.courseId}|${sec.sectionNumber}`;
    let g = grp15.get(key);
    if (!g) {
      g = { totalMinutes: 0, credits: Number(sec.credits), hasLab: Boolean(sec.hasLab) };
      grp15.set(key, g);
    }
    const dur = Section.toMinutes(sec.endTime) - Section.toMinutes(sec.startTime);
    if (dur > 0) g.totalMinutes += dur;
  }
  for (const g of grp15.values()) {
    const effectiveCredits = g.hasLab ? Math.max(1, g.credits - 1) : g.credits;
    const required = effectiveCredits * 50;
    if (g.totalMinutes < required) { total++; weighted += ruleWeight('R-15'); }
  }

  return { total, weighted };
}

function makeVirtualRows(task, slot, scheduleId, instructorId) {
  return slot.days.map(day => new Section({
    id:            `v-${task.courseId}-${task.sectionNumber}-${day}`,
    scheduleId,
    courseId:      task.courseId,
    instructorId:  instructorId ?? null,
    venueId:       null,
    sectionNumber: task.sectionNumber,
    day,
    startTime:     slot.startTime,
    endTime:       slot.endTime,
    courseCode:    task.courseCode,
    academicLevel: task.academicLevel,
    category:      task.category,
    numSections:   task.totalSections,
  }));
}

/** Count how many sections of the SAME course are already at this slot */
function countSameCourseAtSlot(task, slot, working) {
  let count = 0;
  for (const sec of working) {
    if (sec.courseId !== task.courseId) continue;
    if (!slot.days.includes(sec.day)) continue;
    if (timesOverlap(slot.startTime, slot.endTime, sec.startTime, sec.endTime)) count++;
  }
  return count; // number of sibling sections already placed here
}

/** Score a (slot, instructor) combination */
function scoreCombo(task, slot, instructorId, working, ohMap) {
  const parallel       = countParallelCourses(slot, working);
  const sameCourseHere = countSameCourseAtSlot(task, slot, working);

  // Hard reject: already 4+ distinct courses in same slot (would make 5th)
  if (parallel >= MAX_PARALLEL_HARD) return null;

  // Hard reject: already 2 sections of the same course at this time
  // (max 2 sections of the same course per time slot — spread them out)
  if (sameCourseHere >= 2) return null;

  const virtualRows = makeVirtualRows(task, slot, task.scheduleId, instructorId);
  let hard = 0, soft = 0;
  // NEW-FU-340 (Phase 32): weighted score per-rule.
  let weighted = 0;

  for (const row of virtualRows) {
    const others = working.filter(s =>
      !(s.courseId === row.courseId && s.sectionNumber === row.sectionNumber)
    );
    const oh     = ohMap.get(row.instructorId) ?? [];
    const result = engine.evaluate(row, others, oh);
    hard += result.hardConflicts?.length ?? 0;
    soft += result.softConflicts?.length ?? 0;
    // Weight each conflict by its rule ID — R-02 (50) >> R-13 (5).
    for (const c of result.conflicts ?? []) weighted += ruleWeight(c.ruleId);
  }

  // NEW-FU-356 (Phase 34): REVERSE R-02 check. The per-row
  // engine.evaluate above only fires R-02 when the NEW row's course
  // has exactly 1 logical section. It MISSES the case where placing
  // a multi-section course (e.g., SWE206) creates an R-02 with a
  // previously-placed single-section adjacent-level course (e.g.,
  // SWE101). The full engine.evaluateAll catches it but is O(N²)
  // and too slow for saturated schedules. Targeted check here:
  // for each virtual row, scan working for adjacent-level single-
  // section courses overlapping in time; if found, add R-02 weight.
  if (task.totalSections && task.totalSections > 1) {
    // Build per-course logical section count for `working`. Sections
    // in `working` that share courseId + sectionNumber count as ONE
    // logical section — matches R02Rule's buildCourseMap semantics.
    const courseLogicalSet = new Map(); // courseId → Set<sectionNumber>
    for (const s of working) {
      if (!courseLogicalSet.has(s.courseId)) courseLogicalSet.set(s.courseId, new Set());
      courseLogicalSet.get(s.courseId).add(s.sectionNumber);
    }
    // The current task's course already has rows in `working` if it's
    // the 2nd/3rd section being placed; account for that.
    const myLevel = ACADEMIC_LEVEL_NUM[(task.academicLevel ?? '').toUpperCase()];
    if (myLevel !== undefined) {
      for (const row of virtualRows) {
        const rowStartMin = Section.toMinutes(row.startTime);
        const rowEndMin   = Section.toMinutes(row.endTime);
        const seenOtherCourses = new Set();
        for (const s of working) {
          if (s.courseId === row.courseId) continue;
          if (seenOtherCourses.has(s.courseId)) continue;
          // Adjacent-level only.
          const otherLevel = ACADEMIC_LEVEL_NUM[(s.academicLevel ?? '').toUpperCase()];
          if (otherLevel === undefined) continue;
          // NEW-FU-359 (Phase 35): R-02 fires for diff <= 1 (same-level
          // AND adjacent-level), not just adjacent. The Phase 34 check
          // `!== 1` excluded same-level (diff=0) — that's why Graduate↔
          // Graduate R-02s kept slipping through. `> 1` correctly catches
          // both diff=0 (same level + escape → soft) and diff=1 (adjacent
          // → soft). diff>=2 means courses aren't related enough for R-02.
          if (Math.abs(otherLevel - myLevel) > 1) continue;
          // Other course must be SINGLE-section (1 logical section).
          const otherSecCount = courseLogicalSet.get(s.courseId)?.size ?? 0;
          if (otherSecCount !== 1) continue;
          // Time overlap on same day for ANY of the other course's rows
          // — scan all working rows of that course.
          const otherCourseRows = working.filter(w => w.courseId === s.courseId);
          const overlaps = otherCourseRows.some(o =>
            o.day === row.day &&
            Section.toMinutes(o.startTime) < rowEndMin &&
            rowStartMin < Section.toMinutes(o.endTime)
          );
          if (!overlaps) continue;
          seenOtherCourses.add(s.courseId);
          // Add R-02 weight ONCE per (currentCourse × otherCourse)
          // pair, not per row — matches countAttemptConflicts dedup.
          soft++;
          weighted += ruleWeight('R-02');
        }
      }
    }
  }

  // Soft penalty: 3 parallel courses (close to max)
  if (parallel >= MAX_PARALLEL_HARD - 1) { soft += 1; weighted += 1; }

  // NEW-FU-315 (Phase 29): bumped from soft+2 → soft+10 for the
  // first sibling at the same slot.
  // NEW-FU-350 (Phase 33): QUADRATIC scaling so the penalty grows
  // sharply for multi-section courses. 1 sibling already here:
  // +10; 2 siblings: +40; 3 siblings: +90. Without this scaling,
  // a 3-section course would happily stack 3 at 07:00 because each
  // increment only added +10 — overwhelmed by other small
  // preferences. Quadratic makes stacking exponentially costly.
  if (sameCourseHere >= 1) {
    const stackPenalty = 10 * sameCourseHere * sameCourseHere;
    soft += stackPenalty;
    weighted += stackPenalty;
  }

  return { hard, soft, parallel, sameCourseHere, weighted };
}

// NEW-FU-260: imported for recommend() to synthesize sensible per-course
// defaults from the rule table — same source of truth the modal uses for
// its pattern catalog (FU-240).
const { legalDurationsForCourse, legalDayTemplatesForCourse } = require('../domain/sectionPattern');
const { CourseRepository } = require('../repositories/repositories');
const courseRepo = new CourseRepository();

class SuggestService {
  // NEW-FU-260: recommend(scheduleId, options?) — synthesizes default
  // per-course configs (sized to credits, picking the canonical
  // pattern per the FU-240 rule table) and runs the same greedy as
  // suggest() in READ-ONLY mode. Returns the per-course recommendation
  // + capacity warnings; never writes to the DB. Drives the
  // SuggestModal's pre-fill (FU-264) and warning rendering (FU-266).
  //
  // NEW-FU-346 (Phase 33): accepts `options.sectionsHint` —
  // { [courseId]: numSections } — so the modal can ask "if SWE301
  // has 3 sections, what pattern is best?" The hint multiplies the
  // course's saturation contribution by numSections (instead of the
  // default 1), pushing the rotation counter to a less-loaded
  // pattern when section count climbs.
  async recommend(scheduleId, options = {}) {
    const sectionsHint = options.sectionsHint && typeof options.sectionsHint === 'object'
      ? options.sectionsHint : {};
    // Load every course that lives in the same department as this
    // schedule. The suggester operates on the GLOBAL courses table
    // (courses aren't per-term in this schema), so we read them all
    // and let the user opt-out via the modal's per-course checkbox.
    const allCourses = await courseRepo.findAll();
    if (allCourses.length === 0) {
      return { recommendations: [], capacityWarnings: [] };
    }

    // NEW-FU-285 (Phase 24) + NEW-FU-322 (Phase 30) + NEW-FU-331
    // (Phase 31): smart pattern selection.
    //
    // Algorithm evolution:
    //   • Phase 24 — score each candidate against existing-section
    //     density, pick the lowest.
    //   • Phase 30 — incremental saturation: the map mutates as we
    //     recommend each course, so identical courses spread.
    //   • Phase 31 — replace the biased `(hash + candIdx) % 7`
    //     tiebreaker with a per-(credits, hasLab) ROTATION COUNTER.
    //     The Nth course of a given profile rotates to candidate
    //     index N mod #candidates among the score-minimum candidates.
    //     The OLD tiebreaker gave residue-0 (first listed) 4/7 of
    //     hash buckets in a 4-candidate list — that's why empty
    //     schedules defaulted everyone to STT/MW. The rotation
    //     counter guarantees fair spread across identical profiles.
    //
    // RAW-SUM scoring (NOT normalized per-day) — we WANT to penalize
    // patterns that touch already-loaded days. Normalizing by day
    // count would make STT (3 days × 3 load) tied with MW (2 days ×
    // 0 load) at "1.0 per-day," removing the very pressure to spread.
    //
    // The greedy still runs (in dry-run mode) afterward to surface
    // capacityWarnings.
    const existing = await query(`
      SELECT day, instructor_id, venue_id, start_time::text, end_time::text
      FROM sections WHERE schedule_id = $1
    `, [scheduleId]);
    const existingRows = existing.rows;

    // Working saturation map — MUTATES as we recommend each course
    // (Phase 30 FU-322). Seeded from existing DB sections.
    const workingSatPerDay = new Map();
    for (const row of existingRows) {
      workingSatPerDay.set(row.day, (workingSatPerDay.get(row.day) ?? 0) + 1);
    }

    // Template → days it covers. Used to score each candidate against
    // the per-day saturation map. ONE_DAY is special — we score each
    // weekday separately and pick the best day too.
    const TEMPLATE_DAYS = {
      STT:     ['Sunday', 'Tuesday', 'Thursday'],
      MW:      ['Monday', 'Wednesday'],
      ST:      ['Sunday', 'Tuesday'],
      TT:      ['Tuesday', 'Thursday'],
    };

    // Deterministic small-integer hash from a string. Used to break
    // genuine ties so identical courses don't all pick the first
    // option. Re-running recommend on the same schedule still returns
    // the same answer — the hash is pure.
    function courseHash(id) {
      let h = 0;
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
      return h;
    }

    // NEW-FU-339 (Phase 32): mixing function with avalanche so the
    // rotation index doesn't degenerate when inputs are correlated
    // (e.g., seed UUIDs that differ only in the last byte produce
    // courseHash values that differ by 1 — combined with a
    // counter that also increments by 1, the simple sum `counter +
    // courseHash` only generates 2 residues mod 4 for the common
    // 4-candidate 3-credit case). MurmurHash3-style finalizer
    // diffuses bits so consecutive inputs produce uncorrelated
    // outputs.
    function mixIndex(a, b, c) {
      let h = (a * 2654435761) >>> 0;
      h = (h ^ Math.imul(b, 1597334677)) >>> 0;
      h = (h ^ Math.imul(c, 1791398085)) >>> 0;
      h = (h ^ (h >>> 16)) >>> 0;
      h = Math.imul(h, 2246822507) >>> 0;
      h = (h ^ (h >>> 13)) >>> 0;
      return h;
    }

    /**
     * Score a (duration, dayPattern) candidate against the working
     * saturation map. LOWER score = better choice (less crowded).
     *
     * For ONE_DAY templates, we evaluate each weekday and return the
     * least-saturated day alongside the score.
     */
    function scoreCandidate(template) {
      if (template === 'ONE_DAY') {
        const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
        let bestDay = 'Sunday';
        let bestScore = Infinity;
        for (const d of weekdays) {
          const s = workingSatPerDay.get(d) ?? 0;
          if (s < bestScore) { bestScore = s; bestDay = d; }
        }
        return { score: bestScore, pickedDay: bestDay };
      }
      const days = TEMPLATE_DAYS[template] ?? [];
      let score = 0;
      for (const d of days) score += workingSatPerDay.get(d) ?? 0;
      return { score, pickedDay: null };
    }

    // NEW-FU-331 (Phase 31): per-(credits, hasLab) rotation counter.
    // The Nth course of a given profile rotates among score-minimum
    // candidates.
    // NEW-FU-339 (Phase 32): added per-schedule offset (hash of
    // scheduleId) to break "every empty schedule gets the same set
    // of defaults" — different schedules now produce different
    // starting rotations even with the same course set.
    const pickCountByProfile = new Map();
    function profileKey(c) {
      return `${Number(c.credits)}-${Boolean(c.has_lab) ? 'lab' : 'nolab'}`;
    }
    // Per-schedule hash bumps the starting rotation index so two
    // empty schedules (e.g., Fall 2025 vs. Fall 2026) don't both
    // give SWE301 (50, STT) as the first pick. Stable per-schedule
    // so re-opening the modal returns the same answer.
    const schedHash = courseHash(scheduleId);

    /**
     * Pick the best (duration, dayPattern, day?) tuple for a course.
     * Three-step:
     *   1. Score each candidate by SUM of saturation across its days.
     *      Lower is better (less crowded). Raw-sum (not per-day-norm)
     *      so heavily-loaded patterns are penalized.
     *   2. NEW-FU-339 (Phase 32): include NEAR-minimum candidates in
     *      the tied set, not just exact-minimum. epsilon = day count
     *      of the smallest pattern (typically 2) — so on an empty
     *      schedule where 50-STT scores 0 and 75-MW scores 0, both
     *      remain in the tied set even after a few picks shift one
     *      slightly. Without epsilon the tied set often shrinks to
     *      ONE candidate and the rotation counter has nothing to do.
     *   3. Among the tied set, rotate by per-profile counter + course
     *      hash + per-schedule hash. Course/schedule hashes give
     *      stability; the counter gives in-session spread.
     */
    function pickBestPattern(course) {
      const credits = Number(course.credits);
      const hasLab = Boolean(course.has_lab);
      const durations = legalDurationsForCourse({ credits, hasLab });
      const candidates = [];
      for (const duration of durations) {
        const templates = legalDayTemplatesForCourse({ credits, hasLab, duration });
        for (const tpl of templates) {
          const { score, pickedDay } = scoreCandidate(tpl);
          candidates.push({ duration, dayPattern: tpl, day: pickedDay, score });
        }
      }
      if (candidates.length === 0) {
        return { duration: 50, dayPattern: 'STT', day: null, score: 0 };
      }
      // Find the minimum score AND the near-minimum tied set.
      // Epsilon = 2 (the smaller dayCount across pattern types).
      // A 75-MW with load 2 (one prior course on Mon+Wed) is still
      // considered tied with 50-STT at load 0 — gives the rotation
      // counter more candidates to spread across.
      const minScore = Math.min(...candidates.map(c => c.score));
      const epsilon  = 2;
      const tied = candidates.filter(c => c.score <= minScore + epsilon);
      // Rotation index combines:
      //   • per-profile counter (in-session spread across courses)
      //   • per-course hash (stable course identity)
      //   • per-schedule hash (different schedules → different starts)
      const pkey = profileKey(course);
      const pickedSoFar = pickCountByProfile.get(pkey) ?? 0;
      pickCountByProfile.set(pkey, pickedSoFar + 1);
      // NEW-FU-339 (Phase 32): mixIndex diffuses bits so 4 courses
      // with sequential UUIDs (last-byte-incremented seed IDs) and a
      // sequential counter still produce distinct tieIndex values
      // mod 4. Without the mixer the empty-schedule case collapses
      // to 2 patterns per the seed UUID layout.
      const tieIndex = mixIndex(pickedSoFar, courseHash(course.id), schedHash) % tied.length;
      return tied[tieIndex];
    }

    // For the lab side: pick the least-saturated weekday for the lab
    // meeting. Lab patterns are single-day (50, 75, or 165 min); the
    // duration choice is independent of day saturation, so we keep the
    // 50min default but pick a smart day. Uses the SAME working map as
    // lectures, so labs and lectures together drive spread.
    function pickBestLabDay() {
      const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
      let bestDay = 'Sunday';
      let bestScore = Infinity;
      for (const d of weekdays) {
        const s = workingSatPerDay.get(d) ?? 0;
        if (s < bestScore) { bestScore = s; bestDay = d; }
      }
      return bestDay;
    }

    // NEW-FU-322 (Phase 30): iterate courses sequentially and MUTATE
    // the saturation map after each pick. This is what gives diversity:
    // after course A locks in STT, course B sees STT's days as +1
    // saturated and prefers MW (or any unsaturated alternative).
    //
    // NEW-FU-346 (Phase 33): when `sectionsHint[course.id]` is set, use
    // that count instead of the default 1 when bumping saturation. So
    // a 3-section course pushes saturation +3 per chosen day — which
    // makes subsequent courses see that pattern as much more loaded
    // and prefer a different one. Also reports the hinted section
    // count in the response so the modal can confirm what the
    // recommendation accounted for.
    const defaultConfigs = [];
    for (const c of allCourses) {
      const hintedSections = Number(sectionsHint[c.id]);
      const numSections = Number.isFinite(hintedSections) && hintedSections >= 1
        ? Math.floor(hintedSections) : 1;
      const best = pickBestPattern(c);
      const cfg = {
        courseId:   c.id,
        sections:   numSections,
        duration:   best.duration,
        dayPattern: best.dayPattern,
      };
      // ONE_DAY templates need an explicit day. The saturation scorer
      // already picked the least-busy weekday for us.
      if (best.dayPattern === 'ONE_DAY') cfg.day = best.day ?? 'Sunday';
      if (Boolean(c.has_lab)) {
        cfg.labDuration = 50;
        cfg.labDay = pickBestLabDay();
        // Bump saturation for the lab day BEFORE the next course
        // picks. Lab adds numSections sections on that day.
        workingSatPerDay.set(cfg.labDay,
          (workingSatPerDay.get(cfg.labDay) ?? 0) + numSections);
      }
      // Bump saturation for the lecture days BEFORE the next course
      // picks. Each section consumes 1 slot per template-day, so the
      // total contribution is numSections per day.
      const lectureDays = best.dayPattern === 'ONE_DAY'
        ? [cfg.day]
        : (TEMPLATE_DAYS[best.dayPattern] ?? []);
      for (const d of lectureDays) {
        workingSatPerDay.set(d, (workingSatPerDay.get(d) ?? 0) + numSections);
      }
      defaultConfigs.push(cfg);
    }

    // Run the same greedy as suggest() but in dry-run mode — no DB
    // writes, just the assignment + forcedPlacements count.
    const greedy = await this.suggest(scheduleId, defaultConfigs, { dryRun: true });

    // Map assignments back to per-course recommendation. Multiple
    // tasks (Lec + Lab) collapse into one recommendation entry. Field
    // names match the SuggestModal's config shape (sections/duration/
    // dayPattern/day/labDuration/labDay) so the frontend can spread
    // them directly into its useState — no rename layer needed.
    const courseById = new Map(allCourses.map(c => [c.id, c]));
    const recByCourse = new Map();
    for (const cfg of defaultConfigs) {
      recByCourse.set(cfg.courseId, {
        courseId:    cfg.courseId,
        courseCode:  courseById.get(cfg.courseId)?.course_code ?? null,
        sections:    cfg.sections,
        duration:    cfg.duration,
        dayPattern:  cfg.dayPattern,
        day:         cfg.day ?? null,
        labDuration: cfg.labDuration ?? null,
        labDay:      cfg.labDay ?? null,
      });
    }

    // NEW-FU-266: per-course capacity warnings. Walk the greedy's
    // assignments, find the ones flagged forced (FU-266 marker on
    // runOneAttempt) and aggregate by courseId. Multiple tasks for
    // one course (e.g., Lec + Lab) collapse into a single warning —
    // the user only needs to see "capacity issue on CS101" once.
    const forcedByCourse = new Map(); // courseId -> { count, sectionTypes:Set }
    for (const a of greedy.assignments ?? []) {
      if (!a.forced) continue;
      const cid = a.task.courseId;
      const entry = forcedByCourse.get(cid) ?? { count: 0, sectionTypes: new Set() };
      entry.count++;
      entry.sectionTypes.add(a.task.sectionType);
      forcedByCourse.set(cid, entry);
    }
    const capacityWarnings = [];
    for (const [courseId, info] of forcedByCourse) {
      const course = courseById.get(courseId);
      if (!course) continue;
      const sectionTypeText = info.sectionTypes.has('Lab')
        && info.sectionTypes.has('Lecture')
          ? 'section(s)'
          : info.sectionTypes.has('Lab')
            ? 'lab'
            : 'lecture';
      capacityWarnings.push({
        courseId,
        courseCode: course.course_code,
        message:
          `No conflict-free slot found — ${info.count} ${sectionTypeText} ` +
          `placed with overlapping conflicts. Try a different day pattern ` +
          `or add more instructors/venues.`,
      });
    }

    return {
      recommendations: Array.from(recByCourse.values()),
      capacityWarnings,
    };
  }

  async suggest(scheduleId, courseConfigs, options = {}) {
    // C-4: We defer the actual DB writes (delete + insert) to the end so they
    // can be wrapped in a single transaction.  The greedy assignment in steps
    // 2-5 is purely in-memory and does not touch the DB.

    // NEW-L10 + NEW-FU-25: do not wipe a finalized schedule via the auto-suggester.
    // NEW-FU-201: same for archived. Suggest replaces the entire sections set,
    // which is a destructive mutation an archived schedule must refuse.
    // NEW-FU-260: dry-run (read-only) suggestion skips these checks. The
    // archived/finalized gates exist to protect DB writes — dry-run never
    // writes, so it can safely operate on any schedule state. This is what
    // lets the SuggestModal open + show a recommendation for an archived
    // term without erroring.
    const stat = await query(`SELECT status, archived_at FROM schedules WHERE id = $1`, [scheduleId]);
    if (stat.rowCount === 0) throw new Error(`Schedule ${scheduleId} not found.`);
    if (!options.dryRun) {
      if (stat.rows[0].archived_at !== null) {
        const err = new Error('Schedule is archived and cannot be regenerated. Unarchive its term first.');
        err.status = 409;
        throw err;
      }
      if (stat.rows[0].status === SCHEDULE_STATUS.FINALIZED) {
        const err = new Error('Schedule is finalized and cannot be regenerated.');
        err.status = 409;
        throw err;
      }
    }

    // ── Step 1: load course info ────────────────────────────────────────
    // NEW-FU-111: include has_lab so the task-builder can spawn a paired
    // Lab task for has_lab=true courses (Feature 1 — Lec+Lab coexistence
    // requires both kinds to be present in the suggested output).
    // NEW-FU-392 (Phase 37): include `credits` so downstream R-15
    // detection in countAttemptConflicts has the data it needs.
    const courseRows = await query(
      `SELECT id, course_code, academic_level, category, has_lab, credits FROM courses WHERE id = ANY($1)`,
      [courseConfigs.map(c => c.courseId)]
    );
    const courseInfo = {};
    for (const r of courseRows.rows) {
      courseInfo[r.id] = {
        courseId:      r.id,
        scheduleId,
        courseCode:    r.course_code,
        academicLevel: r.academic_level,
        category:      r.category,
        hasLab:        r.has_lab,
        credits:       Number(r.credits),
      };
    }

    // NEW-FU-26: reject if ANY requested courseId is unknown. Previously the
    // unknown IDs were silently skipped — and if NO IDs resolved, the in-tx
    // wipe further down would still run, destroying the schedule's sections
    // for no useful work. Rejecting upfront also prevents partial wipes
    // when only some IDs are valid. The check runs BEFORE the in-memory
    // greedy phase so we don't burn CPU on a doomed request.
    const requestedIds = [...new Set(courseConfigs.map(c => c.courseId))];
    const knownIds     = new Set(courseRows.rows.map(r => r.id));
    const unknownIds   = requestedIds.filter(id => !knownIds.has(id));
    if (unknownIds.length > 0) {
      const err = new Error(
        `Unknown course ID${unknownIds.length > 1 ? 's' : ''}: ${unknownIds.join(', ')}`
      );
      err.status = 400;
      throw err;
    }

    // ── Step 2: load instructors and office hours ───────────────────────
    const instructors = await instrRepo.findAll();
    const instrIds    = instructors.map(i => i.id);
    const ohMap       = await instrRepo.getOfficeHoursMap(instrIds);

    // NEW-L9: load venues so we can attempt to assign one per section. We
    // partition by venue type loosely (LectureHall preferred for UG/GR; Lab
    // is left to manual assignment since the suggester has no category info
    // about which courses need lab time).
    const venueRows = await query(
      `SELECT id, name, type, capacity FROM venues ORDER BY type, name`
    );
    const venues = venueRows.rows;

    // NEW-FU-296 (Phase 26): when applyToCourseIds is set, the wipe
    // below only deletes sections of THOSE courses. Sections of other
    // courses survive — they're "immovable" and the greedy must respect
    // them. Load them now (with their full row data including time,
    // instructor, and venue) so runOneAttempt can pre-seed working[]
    // and the load balancers. Skipped when applyToCourseIds is absent
    // (legacy "wipe all" path — no immovables to seed).
    let existingSectionsForSeed = [];
    if (Array.isArray(options.applyToCourseIds)) {
      const existingRes = await query(`
        SELECT
          s.id, s.schedule_id, s.course_id, s.instructor_id, s.venue_id,
          s.section_number, s.day, s.start_time::text, s.end_time::text,
          s.section_type,
          c.course_code, c.academic_level, c.category, c.num_sections, c.has_lab
        FROM sections s
        JOIN courses c ON c.id = s.course_id
        WHERE s.schedule_id = $1
      `, [scheduleId]);
      // Convert to the same shape working[] expects (the Section domain
      // attributes the conflict engine reads — courseId, sectionNumber,
      // day, startTime, endTime, instructorId, venueId, sectionType,
      // courseCode, academicLevel). Skip courses in the apply set — the
      // wipe is about to delete them anyway.
      const applySet = new Set(options.applyToCourseIds);
      for (const row of existingRes.rows) {
        if (applySet.has(row.course_id)) continue;
        existingSectionsForSeed.push({
          id:            row.id,
          scheduleId:    row.schedule_id,
          courseId:      row.course_id,
          courseCode:    row.course_code,
          sectionNumber: row.section_number,
          day:           row.day,
          startTime:     row.start_time,
          endTime:       row.end_time,
          instructorId:  row.instructor_id,
          venueId:       row.venue_id,
          sectionType:   row.section_type,
          academicLevel: row.academic_level,
          category:      row.category,
          numSections:   row.num_sections,
          hasLab:        row.has_lab,
        });
      }
    }
    // venueId → array of busy { day, startTime, endTime }
    const venueBusy = new Map(venues.map(v => [v.id, []]));

    function venueIsFree(venueId, slot) {
      const busy = venueBusy.get(venueId) ?? [];
      for (const b of busy) {
        if (!slot.days.includes(b.day)) continue;
        if (timesOverlap(slot.startTime, slot.endTime, b.startTime, b.endTime)) return false;
      }
      return true;
    }
    function reserveVenue(venueId, slot) {
      const busy = venueBusy.get(venueId) ?? [];
      for (const day of slot.days) {
        busy.push({ day, startTime: slot.startTime, endTime: slot.endTime });
      }
      venueBusy.set(venueId, busy);
    }
    function pickVenue(slot, sectionType) {
      // NEW-FU-111: type-aware venue picking. Lab sections need Laboratory
      // venues (matching FU-97's R-11 check); Lec sections need anything
      // except Laboratory (matching FU-98's R-12 check). Falls back to ANY
      // free venue when no type-matching one is available — the resulting
      // R-11/R-12 warning is preferable to leaving a section venue-less
      // (R-10).
      const desiredType = sectionType === 'Lab' ? 'Laboratory' : 'LectureHall';
      for (const v of venues) {
        if (v.type === desiredType && venueIsFree(v.id, slot)) return v;
      }
      // Fallback: any free venue
      for (const v of venues) if (venueIsFree(v.id, slot)) return v;
      return null;
    }

    // ── Step 3: build task list ─────────────────────────────────────────
    // NEW-FU-111: per-task sectionType + zero-padded type-scoped numbering.
    //
    // Old behaviour (the FU-92 + FU-105 constraint violation site):
    //   sectionNumber: String(sec)  // produced "1", "2" — failed both the
    //                                 FU-92 format CHECK and FU-105 type-
    //                                 scoped CHECK.
    //
    // New behaviour:
    //   - Lec tasks numbered '01'..'49' (zero-padded)
    //   - Lab tasks numbered '50'..'99'
    //   - For has_lab=true courses, generate cfg.sections Lec tasks AND
    //     cfg.sections Lab tasks (one Lab per requested logical section).
    //     This satisfies Feature 1 (R-14 coexistence) by construction —
    //     the suggested output always pairs Lec with Lab when has_lab=true.
    //   - Lab tasks generate a single-day slot (Feature 3: Lab is once-
    //     weekly per spec, with duration 165 min by default — the longest
    //     standard lab block).
    const tasks = [];
    for (const cfg of courseConfigs) {
      const info = courseInfo[cfg.courseId];
      if (!info) continue;
      // NEW-FU-248: accept either the legacy single-name (cfg.pattern)
      // or the new two-axis form (cfg.dayPattern + cfg.duration). The
      // resolver handles both shapes; we pass whichever the caller sent.
      // NEW-FU-252: also thread cfg.day through to the resolver so
      // ONE_DAY templates can be pinned to a specific weekday when
      // the user picked one in the modal.
      const patternInput = cfg.dayPattern
        ? { dayPattern: cfg.dayPattern, duration: cfg.duration, day: cfg.day }
        : cfg.pattern;
      const lecSlots = generateSlots(patternInput, info.category);
      // Keep a string representation for the task's `pattern` field so
      // downstream observability (logs / records) stays string-typed.
      const patternStr = cfg.dayPattern
        ? `${cfg.dayPattern}_${cfg.duration}`
        : cfg.pattern;
      for (let sec = 1; sec <= cfg.sections; sec++) {
        tasks.push({
          ...info,
          sectionType:    'Lec',
          sectionNumber:  String(sec).padStart(2, '0'),         // '01'..'49'
          totalSections:  cfg.sections,
          pattern:        patternStr,
          slots:          lecSlots,
        });
      }
      // NEW-FU-111: spawn paired Lab tasks for has_lab=true courses.
      // Lab numbering starts at 50 and runs upward in the same N range
      // as the Lec sections (1 Lec → §01 + §50, 2 Lec → §01,§02 + §50,§51).
      if (info.hasLab) {
        // NEW-FU-252: honor cfg.labDay (single weekday) and
        // cfg.labDuration (50 / 75 / 165 min) when the modal sent them.
        // Defaults preserved when fields are absent.
        const labSlots = generateLabSlots(info.category, {
          day: cfg.labDay,
          duration: cfg.labDuration,
        });
        for (let sec = 1; sec <= cfg.sections; sec++) {
          tasks.push({
            ...info,
            sectionType:    'Lab',
            sectionNumber:  String(49 + sec).padStart(2, '0'),   // '50'..'99'
            totalSections:  cfg.sections,
            pattern:        'LAB',                                // synthetic pattern label
            slots:          labSlots,
          });
        }
      }
    }

    // Default sort: fewest slots first (most constrained). Used for
    // attempt 0 of the multi-start wrapper.
    //
    // NEW-FU-350 (Phase 33): when several tasks tie on slot count,
    // break the tie by MULTI-SECTION COUNT — tasks belonging to a
    // course with many sections place first. A 3-section course
    // placed late finds its preferred slots taken by earlier
    // 1-section courses, and the placer ends up stacking siblings
    // at the same slot (R-MS via sameCourseHere stack penalty).
    // Placing high-N courses first gives them prime slots and lets
    // their siblings naturally spread.
    tasks.sort((a, b) => {
      if (a.slots.length !== b.slots.length) return a.slots.length - b.slots.length;
      const aN = a.totalSections ?? 1;
      const bN = b.totalSections ?? 1;
      return bN - aN; // descending: more sections first
    });

    // ── Step 4: multi-start greedy assignment (in-memory, no DB) ────────
    //
    // NEW-FU-116: the prior single-pass greedy could paint itself into a
    // corner — placing course A at slot S forced course B (adjacent level,
    // same time) into an R-02 even when a zero-conflict assignment existed
    // with the opposite placement order. We now run the greedy MULTIPLE
    // TIMES with different task orderings and pick the result with the
    // fewest TOTAL conflicts (counted authoritatively after venue picking
    // is done, so R-11/R-12 and R-13/R-14 are reflected).
    //
    // Attempts:
    //   0           — constraint-first order (the historical FU-111 behavior)
    //   1..K-1      — random shuffles of the task list
    //
    // Early-exit: stop as soon as we find a zero-conflict assignment. The
    // K cap protects against pathological CPU blowup; realistic schedules
    // typically converge in 1–3 attempts.
    const MAX_ATTEMPTS = 10;

    // NEW-FU-115/116: the candidate-instructor sort is shared across all
    // greedy attempts. Hoisted here so the inner runOneAttempt can call
    // it cleanly with the attempt-local instrLoad map.
    function sortCandidateInstructors(slot, workingSet, preferredInstr, instrLoad) {
      return instructors
        .filter(i => instructorIsFree(i, slot, workingSet, ohMap))
        .sort((a, b) => {
          // Tier 1 — preferred (same-course) instructor wins.
          if (a.id === preferredInstr?.id) return -1;
          if (b.id === preferredInstr?.id) return  1;
          // NEW-FU-115: Tier 2 — prefer instructors WITH at least one OH
          // over instructors with zero OHs. The latter would fire R-13
          // (FU-99) if assigned a section, so we make them a last-resort
          // tie-breaker rather than the historical "first by load".
          const aHasOH = ohMap.has(a.id);
          const bHasOH = ohMap.has(b.id);
          if (aHasOH !== bHasOH) return aHasOH ? -1 : 1;
          // Tier 3 — load ascending (the historical primary key).
          return (instrLoad.get(a.id) ?? 0) - (instrLoad.get(b.id) ?? 0);
        });
    }

    // NEW-FU-116: run one full greedy pass over a given task ordering.
    // Returns { assignments, forcedPlacements } so the multi-start outer
    // loop can compare attempts by conflict count.
    function runOneAttempt(taskOrder) {
      const working          = [];
      const assignments      = [];
      let   forcedPlacements = 0;
      // NEW-FU-316 (Phase 29): when refuse-to-place fires for a task,
      // we record an entry here instead of inserting a virtual row.
      // Surfaced in the suggest response so the SuggestModal can show
      // a banner naming which sections couldn't be placed and why.
      const placementSkipped = [];
      const instrLoad        = new Map(instructors.map(i => [i.id, 0]));
      const venueLoad        = new Map(venues.map(v => [v.id, 0]));
      const courseInstructor = new Map();
      const venueBusyAttempt = new Map(venues.map(v => [v.id, []]));
      // NEW-FU-296 (Phase 26): track how many sections have been placed
      // at each (day, startTime) bucket so the scorer can penalize
      // further stacking there. Without this, every slot on an empty
      // schedule scores identically (hard=0, soft=0) and the FIRST
      // candidate wins — which is always 07:00. Result: the user sees
      // every section stacked from 07:00 upward. The bucket counter
      // forces the greedy to spread placements across the day.
      const slotUsage = new Map(); // key: `${day}|${startTime}` → count
      function slotBucketUsage(slot) {
        let max = 0;
        for (const day of slot.days) {
          const key = `${day}|${slot.startTime}`;
          const c = slotUsage.get(key) ?? 0;
          if (c > max) max = c;
        }
        return max;
      }
      function bumpSlotUsage(slot) {
        for (const day of slot.days) {
          const key = `${day}|${slot.startTime}`;
          slotUsage.set(key, (slotUsage.get(key) ?? 0) + 1);
        }
      }
      // Attempt-scoped venue helpers (override the outer module-level
      // mutations so each attempt starts with a clean venue calendar).
      function attemptVenueIsFree(venueId, slot) {
        const busy = venueBusyAttempt.get(venueId) ?? [];
        for (const b of busy) {
          if (!slot.days.includes(b.day)) continue;
          if (timesOverlap(slot.startTime, slot.endTime, b.startTime, b.endTime)) return false;
        }
        return true;
      }
      // NEW-FU-296 (Phase 26): venue picker now load-balanced. The prior
      // implementation took the FIRST matching-type free venue — so on
      // an empty schedule, EVERY section landed in H-101. Now we sort
      // free candidates by current load (least-loaded first) so usage
      // spreads across the available venues. Type match is preserved
      // (Lab→Laboratory, Lec→LectureHall) so we don't trigger R-11/R-12.
      function attemptPickVenue(slot, sectionType) {
        const desiredType = sectionType === 'Lab' ? 'Laboratory' : 'LectureHall';
        const typeMatches = venues
          .filter(v => v.type === desiredType && attemptVenueIsFree(v.id, slot))
          .sort((a, b) => (venueLoad.get(a.id) ?? 0) - (venueLoad.get(b.id) ?? 0));
        if (typeMatches.length > 0) return typeMatches[0];
        // Fallback: ANY free venue (still load-balanced). This kicks in
        // if there are no free venues of the matching type — the result
        // will trigger R-11/R-12 (type mismatch) but at least the slot
        // isn't orphaned.
        const anyMatches = venues
          .filter(v => attemptVenueIsFree(v.id, slot))
          .sort((a, b) => (venueLoad.get(a.id) ?? 0) - (venueLoad.get(b.id) ?? 0));
        return anyMatches[0] ?? null;
      }
      function attemptReserveVenue(venueId, slot) {
        const busy = venueBusyAttempt.get(venueId) ?? [];
        for (const day of slot.days) busy.push({ day, startTime: slot.startTime, endTime: slot.endTime });
        venueBusyAttempt.set(venueId, busy);
        // NEW-FU-296 (Phase 26): record the load so future picks spread
        // away from this venue.
        venueLoad.set(venueId, (venueLoad.get(venueId) ?? 0) + 1);
      }

      // NEW-FU-296 (Phase 26): pre-seed `working[]` with sections of
      // courses NOT in applyToCourseIds. Finishes the Phase 21 deferred
      // work — when the user runs Suggest with a subset of courses
      // selected, the immovable existing sections (the ones whose
      // courses are NOT in the apply set) should constrain placement
      // of the new sections. Without this, the greedy treats those
      // courses as if they didn't exist and happily places new sections
      // on top of their existing rooms / instructors / times.
      //
      // Reads `options.applyToCourseIds` from the outer closure. When
      // unset (the legacy "apply to all" path), nothing pre-seeds and
      // the greedy starts fresh — same as before this phase.
      const applySetForSeed = Array.isArray(options.applyToCourseIds)
        ? new Set(options.applyToCourseIds) : null;
      // NEW-FU-296 (Phase 26): existingSectionsForSeed is computed by
      // the outer suggest() closure and includes only courses NOT in
      // applyToCourseIds — i.e., the immovable ones. We thread it in
      // via the closure rather than as an explicit param to keep the
      // runOneAttempt signature small.
      if (applySetForSeed && existingSectionsForSeed.length > 0) {
        for (const sec of existingSectionsForSeed) {
          if (applySetForSeed.has(sec.courseId)) continue; // movable — skip
          // Treat as already-placed: feeds into the working[] set so
          // scoreCombo's conflict engine sees it, and bumps instrLoad /
          // venueLoad / slotUsage so the balancer knows about it.
          working.push(sec);
          if (sec.instructorId) {
            instrLoad.set(sec.instructorId, (instrLoad.get(sec.instructorId) ?? 0) + 1);
          }
          if (sec.venueId) {
            venueLoad.set(sec.venueId, (venueLoad.get(sec.venueId) ?? 0) + 1);
            // Also block the venue calendar for the section's day/time
            // so attemptPickVenue won't suggest it.
            const busy = venueBusyAttempt.get(sec.venueId) ?? [];
            busy.push({ day: sec.day, startTime: sec.startTime, endTime: sec.endTime });
            venueBusyAttempt.set(sec.venueId, busy);
          }
          if (sec.day && sec.startTime) {
            const key = `${sec.day}|${sec.startTime}`;
            slotUsage.set(key, (slotUsage.get(key) ?? 0) + 1);
          }
        }
      }

      for (const task of taskOrder) {
        let bestSlot       = null;
        let bestInstructor = null;
        // NEW-FU-340 (Phase 32): bestScore.weighted is the new primary
        // tie-break axis for soft conflicts. bestScore.soft kept for
        // logging/debug only.
        let bestScore      = { hard: Infinity, weighted: Infinity, soft: Infinity, parallel: Infinity, load: Infinity };
        const preferredInstr = courseInstructor.get(task.courseId) ?? null;
        const minLoad = Math.min(...Array.from(instrLoad.values()), 0);

        // NEW-FU-296 (Phase 26): track the lowest-saturation tie-break
        // alongside the score. Lower bucketUsage = a less-stacked time
        // slot. Used as a tertiary tie-breaker (after hard, after soft,
        // and reflected as a soft penalty too — see below).
        let bestSlotUsage = Infinity;

        for (const slot of task.slots) {
          const freeInstrs = sortCandidateInstructors(slot, working, preferredInstr, instrLoad);
          const candidateInstrs = [...freeInstrs, null];

          for (const instr of candidateInstrs) {
            const score = scoreCombo(task, slot, instr?.id ?? null, working, ohMap);
            if (!score) continue;
            const load = instr ? (instrLoad.get(instr.id) ?? 0) - minLoad : 999;
            const isSameCourseInstr = instr && preferredInstr && instr.id === preferredInstr.id;
            // NEW-FU-340 (Phase 32): apply the same-course-instructor
            // bonus to BOTH soft and weighted so the tie-break ladder
            // still prefers reusing the course's existing teacher when
            // all else is equal.
            const effectiveSoft     = isSameCourseInstr ? Math.max(0, score.soft - 1) : score.soft;
            const effectiveWeighted = isSameCourseInstr ? Math.max(0, score.weighted - 1) : score.weighted;
            const curLoad = bestInstructor ? (instrLoad.get(bestInstructor.id) ?? 0) - minLoad : 999;
            // NEW-FU-296: how saturated is THIS slot's time bucket?
            // When the schedule is empty all slots tie at 0 and 07:00
            // wins by accident; with this counter, the second task that
            // could go at 07:00 sees usage=1 there and goes to 07:30
            // (or wherever has usage=0) instead. Spreads start times.
            const sUsage = slotBucketUsage(slot);

            // NEW-FU-340 (Phase 32): tie-break ladder now uses WEIGHTED
            // soft score before raw soft. So 1 R-02 (50pt) loses to 5
            // R-13s (25pt) — matching the user's "R-02 must not exist"
            // expectation.
            const better =
              score.hard < bestScore.hard ||
              (score.hard === bestScore.hard && effectiveWeighted < bestScore.weighted) ||
              (score.hard === bestScore.hard && effectiveWeighted === bestScore.weighted &&
               effectiveSoft < bestScore.soft) ||
              (score.hard === bestScore.hard && effectiveWeighted === bestScore.weighted &&
               effectiveSoft === bestScore.soft && sUsage < bestSlotUsage) ||
              (score.hard === bestScore.hard && effectiveWeighted === bestScore.weighted &&
               effectiveSoft === bestScore.soft && sUsage === bestSlotUsage &&
               score.parallel < bestScore.parallel) ||
              (score.hard === bestScore.hard && effectiveWeighted === bestScore.weighted &&
               effectiveSoft === bestScore.soft && sUsage === bestSlotUsage &&
               score.parallel === bestScore.parallel && load < curLoad) ||
              (score.hard === bestScore.hard && effectiveWeighted === bestScore.weighted &&
               effectiveSoft === bestScore.soft && sUsage === bestSlotUsage &&
               score.parallel === bestScore.parallel && load === curLoad &&
               instr && !bestInstructor);

            if (better) {
              bestScore      = { ...score, soft: effectiveSoft, weighted: effectiveWeighted, load };
              bestSlotUsage  = sUsage;
              bestSlot       = slot;
              bestInstructor = instr ?? null;
            }

            if (bestScore.hard === 0 && bestScore.weighted === 0 && bestSlotUsage === 0 && bestInstructor) break;
          }
          if (bestScore.hard === 0 && bestScore.weighted === 0 && bestSlotUsage === 0 && bestInstructor) break;
        }

        // NEW-FU-266: track per-assignment forced flag so recommend()
        // can attribute capacity warnings to specific courses. Previously
        // we only kept an aggregate count; per-card UI needs the
        // attribution. `wasForced` is local to this iteration.
        let wasForced = false;
        if (!bestSlot) {
          const [relaxed] = [...task.slots]
            .map(s => ({ s, p: countParallelCourses(s, working) }))
            .sort((a, b) => a.p - b.p);
          bestSlot = relaxed?.s ?? task.slots[0];
          forcedPlacements++;
          wasForced = true;
        }

        // NEW-FU-316 (Phase 29): refuse-to-place check. If the user passed
        // `maxConflictsPerSection`, evaluate whether bestScore exceeds the
        // tolerance — and if so, SKIP the placement rather than forcing.
        // The user gets a structured `placementSkipped[]` entry naming
        // the course + reason, surfaced in the SuggestModal as a banner.
        //
        // Tolerance values:
        //   0      → no conflicts of any severity tolerated
        //   1 / 2  → up to N soft conflicts OK; any hard conflict skips
        //   'any'  → legacy behavior, never skip (force everything)
        // Default: 2 (matches pre-Phase-29 lenient behavior). Strict
        // values let the user opt into "ask me for more resources" mode.
        const tolerance = options.maxConflictsPerSection;
        let shouldSkip = false;
        let skipReason = null;
        if (tolerance != null && tolerance !== 'any') {
          const maxSoft = Number(tolerance);
          if (bestScore.hard > 0) {
            shouldSkip = true;
            skipReason = `Every available slot would create ${bestScore.hard} hard conflict${bestScore.hard === 1 ? '' : 's'} (instructor or venue double-booking, or same-level overlap).`;
          } else if (bestScore.soft > maxSoft) {
            shouldSkip = true;
            skipReason = `Every available slot would create ${bestScore.soft} soft conflict${bestScore.soft === 1 ? '' : 's'} (above the tolerance of ${maxSoft}).`;
          }
        }
        if (shouldSkip) {
          placementSkipped.push({
            courseId:      task.courseId,
            courseCode:    task.courseCode,
            sectionNumber: task.sectionNumber,
            sectionType:   task.sectionType,
            reason:        skipReason + ' Add more instructors / venues, lower the section count, or change the day pattern, then re-run Suggest.',
          });
          // Skip this task — don't insert a virtual row, don't bump
          // slotUsage. Move on to the next task.
          continue;
        }

        // NEW-FU-384 (Phase 36): if task.slots was empty (unknown
        // pattern / no eligible slots), `bestSlot` falls through as
        // undefined and attemptReserveVenue crashes on slot.days. Skip
        // the placement as "forced" with no venue rather than throwing.
        if (!bestSlot || !Array.isArray(bestSlot.days)) {
          placementSkipped.push({
            courseId:      task.courseId,
            courseCode:    task.courseCode,
            sectionNumber: task.sectionNumber,
            sectionType:   task.sectionType,
            reason:        'No legal slot available for this section (the resolved pattern produced no candidates). Try a different dayPattern or duration.',
          });
          continue;
        }
        const bestVenue = attemptPickVenue(bestSlot, task.sectionType);
        if (bestVenue) attemptReserveVenue(bestVenue.id, bestSlot);

        assignments.push({ task, slot: bestSlot, instructor: bestInstructor, venue: bestVenue, forced: wasForced });

        if (bestInstructor) {
          instrLoad.set(bestInstructor.id, (instrLoad.get(bestInstructor.id) ?? 0) + 1);
          if (!courseInstructor.has(task.courseId)) {
            courseInstructor.set(task.courseId, bestInstructor);
          }
        }
        // NEW-FU-296 (Phase 26): record this slot's usage so the next
        // task to score this bucket sees the bump. Critical for the
        // time-distribution behavior — otherwise the same slot always
        // ties as "0 usage" and 07:00 keeps winning.
        bumpSlotUsage(bestSlot);

        const placed = makeVirtualRows(task, bestSlot, scheduleId, bestInstructor?.id ?? null);
        working.push(...placed);
      }

      return { assignments, forcedPlacements, placementSkipped };
    }

    // NEW-FU-116: multi-start outer loop. Attempt 0 uses the existing
    // constraint-first sort; attempts 1..K-1 use deterministic shuffles
    // (seeded by the attempt index so results are reproducible across
    // runs of the same input).
    function seededShuffle(arr, seed) {
      const result = [...arr];
      let t = (seed * 2654435761) >>> 0;
      for (let i = result.length - 1; i > 0; i--) {
        t = (t * 1664525 + 1013904223) >>> 0;
        const j = t % (i + 1);
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    }

    // NEW-FU-341 (Phase 32): multi-restart now compares by WEIGHTED
    // conflict total, not raw count. So an attempt with 1 R-02 (50pts)
    // loses to an attempt with 5 R-13s (25pts) — matching student
    // impact. Also early-exit when weighted total hits zero.
    let bestRun = null;
    let bestConflictWeighted = Infinity;
    let bestConflictTotal = Infinity;
    let attemptsActuallyRun = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const orderedTasks = attempt === 0 ? tasks : seededShuffle(tasks, attempt);
      const run = runOneAttempt(orderedTasks);
      const { total, weighted } = countAttemptConflicts(run.assignments, scheduleId, ohMap, engine);
      attemptsActuallyRun++;
      if (weighted < bestConflictWeighted) {
        bestConflictWeighted = weighted;
        bestConflictTotal = total;
        bestRun = run;
        if (weighted === 0) break; // can't do better than zero
      }
    }
    const bestConflictCount = bestConflictTotal;

    const assignments      = bestRun.assignments;
    const forcedPlacements = bestRun.forcedPlacements;
    // NEW-FU-316 (Phase 29): structured "couldn't place" entries from
    // the refuse-to-place check inside runOneAttempt. Empty array when
    // `maxConflictsPerSection` was not set or all sections fit.
    const placementSkipped = bestRun.placementSkipped ?? [];

    // NEW-FU-260: dry-run mode (used by recommend()). Skip the DB
    // write phase entirely and return the in-memory assignment so
    // the caller can summarize it. No DB mutation, no archive/
    // status checks needed — those gates only matter when we'd
    // actually be writing.
    if (options.dryRun) {
      // NEW-FU-361 (Phase 35): also emit the unique rule IDs that fire
      // in the best attempt's final state. The frontend uses this to
      // build the warn-before-conflict dialog. Built by running the
      // full evaluateAll on the in-memory assignment.
      const dryRunRows = [];
      for (const { task, slot, instructor, venue } of (bestRun?.assignments ?? [])) {
        for (const day of slot.days) {
          dryRunRows.push(new Section({
            id: `dry-${task.courseId}-${task.sectionNumber}-${day}`,
            scheduleId, courseId: task.courseId,
            instructorId: instructor?.id ?? null, venueId: venue?.id ?? null,
            sectionNumber: task.sectionNumber, day,
            startTime: slot.startTime, endTime: slot.endTime,
            sectionType: task.sectionType, courseCode: task.courseCode,
            academicLevel: task.academicLevel, category: task.category,
            numSections: task.totalSections, hasLab: task.hasLab,
            venueType: venue?.type ?? null,
          }));
        }
      }
      const finalEval = engine.evaluateAll(dryRunRows, ohMap);
      const residualConflictRuleIds = Array.from(new Set(
        (finalEval.conflicts ?? []).map(c => c.ruleId).filter(Boolean)
      )).sort();
      return {
        assignments,
        forcedPlacements,
        placementSkipped,
        attemptsActuallyRun,
        residualConflicts: bestConflictCount,
        residualConflictRuleIds,
      };
    }

    // NEW-FU-262: applyToCourseIds — when supplied, only courses in
    // the list have their existing sections wiped + replaced; courses
    // NOT in the list keep their current sections untouched. This lets
    // the modal "Run Suggest only for selected courses" without
    // nuking the rest of the schedule.
    const applyToCourseIds = Array.isArray(options.applyToCourseIds)
      ? new Set(options.applyToCourseIds)
      : null;

    // ── Step 5: write to database (atomic: delete old + insert new) ───────
    // C-4: Both the delete and all inserts run in one transaction so a crash
    // mid-way cannot leave the schedule with zero sections.
    const client = await getClient();
    try {
      await client.query('BEGIN');
      // NEW-FU-20: re-check status UNDER FOR UPDATE inside the same tx that
      // performs the wipe + insert. The unlocked check at the top of suggest()
      // is just a fast-fail; this is the authoritative gate. Without this,
      // a concurrent saveSchedule could finalize during the (potentially
      // seconds-long) greedy phase above, after which we would happily wipe
      // and rewrite a finalized schedule — silently violating the contract
      // the admin saw at save time.
      // NEW-FU-201: pull archived_at along with status for the same reason
      // documented in the fast-fail above.
      const recheck = await client.query(
        `SELECT status, archived_at FROM schedules WHERE id = $1 FOR UPDATE`,
        [scheduleId]
      );
      if (recheck.rowCount === 0) {
        await client.query('ROLLBACK').catch(() => {});
        const err = new Error(`Schedule ${scheduleId} not found.`);
        err.status = 404;
        throw err;
      }
      if (recheck.rows[0].archived_at !== null) {
        await client.query('ROLLBACK').catch(() => {});
        const err = new Error('Schedule was archived; cannot regenerate.');
        err.status = 409;
        throw err;
      }
      // NEW-FU-25: use SCHEDULE_STATUS constant instead of literal.
      if (recheck.rows[0].status === SCHEDULE_STATUS.FINALIZED) {
        await client.query('ROLLBACK').catch(() => {});
        const err = new Error('Schedule was finalized; cannot regenerate.');
        err.status = 409;
        throw err;
      }

      // NEW-FU-262: when applyToCourseIds is set, scope the wipe to
      // ONLY those courses' sections. Other courses' sections stay
      // untouched. When applyToCourseIds is null (the legacy
      // "apply to all" case), preserve pre-FU-262 behavior — full
      // schedule wipe + complete replan.
      if (applyToCourseIds) {
        if (applyToCourseIds.size === 0) {
          // Empty filter == "apply nothing". Return early with
          // the current state's revalidation.
          await client.query('COMMIT');
          const ScheduleService = require('./ScheduleService');
          const conflictResult = await ScheduleService.revalidateSchedule(scheduleId);
          return Object.assign(conflictResult.toJSON(), {
            forcedPlacements: 0,
            residualConflicts: 0,
            attemptsTried: 0,
            applyToCourseIds: [],
          });
        }
        await client.query(
          `DELETE FROM sections WHERE schedule_id = $1 AND course_id = ANY($2)`,
          [scheduleId, [...applyToCourseIds]]
        );
      } else {
        await client.query(`DELETE FROM sections WHERE schedule_id = $1`, [scheduleId]);
      }
      for (const { task, slot, instructor, venue } of assignments) {
        // NEW-FU-262: skip tasks for courses not in the apply filter.
        if (applyToCourseIds && !applyToCourseIds.has(task.courseId)) continue;

        for (const day of slot.days) {
          // NEW-FU-111: include section_type so the inserted rows satisfy
          // FU-94's column constraint AND the FU-105 type-scoped section#
          // CHECK. Without section_type the insert defaults to 'Lec' from
          // FU-92's column default — which would fail the type-scoped
          // CHECK whenever a Lab task tried to write section_number='50'+
          // (since the default Lec range only accepts '01'..'49').
          await client.query(`
            INSERT INTO sections
              (schedule_id, course_id, instructor_id, venue_id,
               section_number, day, start_time, end_time, section_type)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `, [
            scheduleId, task.courseId,
            instructor?.id ?? null,
            venue?.id ?? null,
            task.sectionNumber, day, slot.startTime, slot.endTime,
            task.sectionType ?? 'Lec',
          ]);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      // NEW-FU-1: swallow rollback errors so the original error reaches the
      // caller. Bare `await client.query('ROLLBACK')` would mask the actual
      // failure if the connection was already in a broken state.
      await client.query('ROLLBACK').catch(() => {});
      // NEW-FU-48 + NEW-FU-66: pass err to release; wrap to defend against
      // release-throws masking the original error.
      try { client.release(err); } catch { /* ignore */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* already released via catch path */ }
    }

    // ── Step 6: revalidate ────────────────────────────────────────────
    const ScheduleService = require('./ScheduleService');
    const conflictResult = await ScheduleService.revalidateSchedule(scheduleId);
    // NEW-L8 + NEW-FU-117: include forcedPlacements AND residualConflicts
    // so the UI can distinguish "the suggester couldn't even fit the
    // section" from "the suggester fit everything but residual soft
    // conflicts remain (typically because input forced them)". The
    // residual count reflects the best multi-start attempt's authoritative
    // conflict total — what the schedule WILL show when reloaded.
    return Object.assign(conflictResult.toJSON(), {
      forcedPlacements,
      residualConflicts: bestConflictCount,
      attemptsTried:     attemptsActuallyRun,
      // NEW-FU-316 (Phase 29): structured "couldn't place these
      // sections without creating too many conflicts" array. Empty
      // when `maxConflictsPerSection` wasn't set or every section fit.
      placementSkipped,
    });
  }

  // NEW-FU-362 (Phase 35): preview the result of a suggest call WITHOUT
  // writing. Returns assignments + residual conflict info so the
  // SuggestModal can show a warn-before-conflict dialog before
  // committing.
  //
  // Shape mirrors suggest()'s dryRun return — adds nothing new — but
  // expressing it as a named entry point makes the controller-level
  // contract obvious and gives the test harness a stable surface to
  // exercise.
  async preview(scheduleId, courseConfigs, options = {}) {
    return this.suggest(scheduleId, courseConfigs, { ...options, dryRun: true });
  }

  // NEW-FU-372 (Phase 36): multi-pass exhaustive relaxation.
  //
  // The Phase 35 version had an 8-variant cap and a flat (duration ×
  // dayPattern) cartesian. That worked for shallow conflicts but
  // saturated schedules (e.g., 5 Graduate courses + 16:00–22:00 window)
  // never found a zero-conflict variant and silently returned a
  // non-zero `residualConflicts` plan — which the frontend then
  // persisted, violating the "find alternative must never create
  // conflicts" guarantee.
  //
  // The new contract: this function returns a plan with
  // `residualConflicts === 0` OR `{ feasible: false, ... }`. The
  // controller refuses to persist anything else.
  //
  // Passes (in order — each pass takes the survivors of the previous):
  //   Pass A: vary duration ∈ {50, 75} × dayPattern ∈ legal day-templates
  //           per course. Exhaustive cartesian, capped at 200 variants
  //           for runtime safety.
  //   Pass B: reduce per-course `sections` count by 1 (down to 1).
  //           Report which courses were down-sized.
  //   Pass C: relax labDay / labDuration overrides (clear them so the
  //           lab task uses the suggester's default placement).
  //   Pass D: declare infeasible. Return suggestedRemovals — the
  //           minimum set of courses whose removal would make the
  //           remainder solvable (greedy: drop the course with the
  //           highest per-course weighted conflict contribution).
  async suggestWithRelaxation(scheduleId, courseConfigs, options = {}) {
    const PASS_A_CAP = 200;   // ≤ 200 (duration × pattern) variants per attempt
    const ALT_DURATIONS    = [50, 75];
    const ALT_DAY_PATTERNS = ['STT', 'MW', 'ST', 'MWF', 'ONE_DAY'];

    // First attempt: the user's configs as-is. Zero-conflict → return.
    const base = await this.preview(scheduleId, courseConfigs, options);
    if ((base.residualConflicts ?? 0) === 0) {
      return { ...base, relaxed: false, relaxedConfigs: null, feasible: true, pass: 'base' };
    }

    // ── Pass A — exhaustive duration × dayPattern ──────────────────
    const passAVariants = [];
    for (const dur of ALT_DURATIONS) {
      for (const dp of ALT_DAY_PATTERNS) {
        if (passAVariants.length >= PASS_A_CAP) break;
        const sameAsOrig = courseConfigs.every(c =>
          (c.duration ?? 50) === dur && (c.dayPattern ?? 'STT') === dp
        );
        if (sameAsOrig) continue;
        passAVariants.push(courseConfigs.map(c => ({
          ...c,
          duration:   dur,
          dayPattern: dp,
        })));
      }
    }
    let best = { ...base, relaxed: false, relaxedConfigs: null, pass: 'base' };
    for (const variant of passAVariants) {
      try {
        const r = await this.preview(scheduleId, variant, options);
        if ((r.residualConflicts ?? 0) === 0) {
          return { ...r, relaxed: true, relaxedConfigs: variant, feasible: true, pass: 'A' };
        }
        if ((r.residualConflicts ?? Infinity) < (best.residualConflicts ?? Infinity)) {
          best = { ...r, relaxed: true, relaxedConfigs: variant, pass: 'A' };
        }
      } catch { /* validator rejected this variant — skip */ }
    }

    // ── Pass B — also reduce per-course sections count ─────────────
    // For each (duration, pattern) variant already considered, also try
    // reducing each course's section count by 1 (down to a floor of 1).
    // We prefer the variant with the fewest down-sized courses.
    const reductionLevels = courseConfigs.map(c => Math.max(0, (c.sections ?? 1) - 1));
    // Total reduction budget = sum of all per-course reductions. Try
    // budgets 1..maxBudget in ascending order (least disruptive first).
    const maxBudget = reductionLevels.reduce((s, n) => s + n, 0);
    outerB:
    for (let budget = 1; budget <= maxBudget; budget++) {
      // Generate per-course reductions that sum to `budget`. Round-
      // robin distribution keeps the changes shallow rather than
      // gutting one course.
      const reduceBy = courseConfigs.map(() => 0);
      let remaining = budget;
      while (remaining > 0) {
        let progressed = false;
        for (let i = 0; i < courseConfigs.length && remaining > 0; i++) {
          if (reduceBy[i] < reductionLevels[i]) {
            reduceBy[i]++;
            remaining--;
            progressed = true;
          }
        }
        if (!progressed) break; // can't reduce further at this budget
      }
      // For each (dur, dp) in pass A's cartesian, retry with the
      // reduced section counts.
      for (const dur of ALT_DURATIONS) {
        for (const dp of ALT_DAY_PATTERNS) {
          const variant = courseConfigs.map((c, i) => ({
            ...c,
            duration:   dur,
            dayPattern: dp,
            sections:   Math.max(1, (c.sections ?? 1) - reduceBy[i]),
          }));
          try {
            const r = await this.preview(scheduleId, variant, options);
            if ((r.residualConflicts ?? 0) === 0) {
              const downsized = courseConfigs
                .map((c, i) => reduceBy[i] > 0
                  ? { courseId: c.courseId, from: c.sections ?? 1, to: variant[i].sections }
                  : null)
                .filter(Boolean);
              return {
                ...r,
                relaxed: true, relaxedConfigs: variant,
                feasible: true, pass: 'B',
                downsized,
              };
            }
            if ((r.residualConflicts ?? Infinity) < (best.residualConflicts ?? Infinity)) {
              best = { ...r, relaxed: true, relaxedConfigs: variant, pass: 'B' };
            }
          } catch { /* skip rejected variant */ }
        }
      }
    }

    // ── Pass C — relax lab overrides ───────────────────────────────
    const hasLabOverrides = courseConfigs.some(c => c.labDay || c.labDuration);
    if (hasLabOverrides) {
      const cleared = courseConfigs.map(c => {
        const { labDay, labDuration, ...rest } = c;
        return rest;
      });
      for (const dur of ALT_DURATIONS) {
        for (const dp of ALT_DAY_PATTERNS) {
          const variant = cleared.map(c => ({ ...c, duration: dur, dayPattern: dp }));
          try {
            const r = await this.preview(scheduleId, variant, options);
            if ((r.residualConflicts ?? 0) === 0) {
              return { ...r, relaxed: true, relaxedConfigs: variant, feasible: true, pass: 'C' };
            }
            if ((r.residualConflicts ?? Infinity) < (best.residualConflicts ?? Infinity)) {
              best = { ...r, relaxed: true, relaxedConfigs: variant, pass: 'C' };
            }
          } catch { /* skip */ }
        }
      }
    }

    // ── Pass D — identify structural troublemakers ────────────────
    // Run the suggester per-course in isolation; the courses that
    // STILL produce conflicts alone are the "structural" blockers
    // (their requirements exceed time / venue / instructor capacity).
    const suggestedRemovals = [];
    for (const c of courseConfigs) {
      try {
        const r = await this.preview(scheduleId, [c], options);
        if ((r.residualConflicts ?? 0) > 0) {
          suggestedRemovals.push({
            courseId: c.courseId,
            residualConflicts: r.residualConflicts,
            ruleIds: r.residualConflictRuleIds ?? [],
          });
        }
      } catch { /* skip */ }
    }

    // ── Pass E (NEW-FU-397, Phase 39) — compute the last-resort
    // drop plan. Mirrors Quick Fix's Phase 39 generalization: when
    // no non-destructive resolution exists, present DROP as the
    // opt-in last-resort path. Strategy:
    //   1. Rank suggestedRemovals by impact (highest weighted
    //      conflicts first — those are the structural blockers).
    //   2. Iteratively exclude them until the remaining course set
    //      produces a feasible (zero-conflict) plan with the
    //      relaxed configs from Pass A.
    //   3. Stop at the minimum set that yields feasibility.
    //
    // The plan is RETURNED, not auto-applied. The controller leaves
    // feasible:false on the response so the frontend's existing
    // "no auto-persist on infeasibility" guard fires, but a sibling
    // `lastResortPlan` field gives the frontend an opt-in path to
    // present to the user.
    let lastResortPlan = null;
    if (suggestedRemovals.length > 0) {
      // Sort by residualConflicts desc — most disruptive first.
      const rankedRemovals = [...suggestedRemovals]
        .sort((a, b) => (b.residualConflicts ?? 0) - (a.residualConflicts ?? 0));
      const excluded = [];
      for (const removal of rankedRemovals) {
        excluded.push(removal.courseId);
        const remainingConfigs = courseConfigs.filter(c => !excluded.includes(c.courseId));
        if (remainingConfigs.length === 0) break;
        // Re-run Pass A on the reduced set: exhaustive duration ×
        // pattern. First zero-conflict variant wins.
        const baseTry = await this.preview(scheduleId, remainingConfigs, options).catch(() => null);
        if (baseTry && (baseTry.residualConflicts ?? 0) === 0) {
          lastResortPlan = {
            droppedCourseIds: [...excluded],
            keptConfigs: remainingConfigs,
            assignments: baseTry.assignments,
            residualConflicts: 0,
            pass: 'E-base',
          };
          break;
        }
        // Try the same Pass A cartesian on the reduced set.
        let bestReduced = null;
        for (const dur of ALT_DURATIONS) {
          for (const dp of ALT_DAY_PATTERNS) {
            const variant = remainingConfigs.map(c => ({
              ...c, duration: dur, dayPattern: dp,
            }));
            const r = await this.preview(scheduleId, variant, options).catch(() => null);
            if (!r) continue;
            if ((r.residualConflicts ?? 0) === 0) {
              bestReduced = { configs: variant, result: r };
              break;
            }
          }
          if (bestReduced) break;
        }
        if (bestReduced) {
          lastResortPlan = {
            droppedCourseIds: [...excluded],
            keptConfigs: bestReduced.configs,
            assignments: bestReduced.result.assignments,
            residualConflicts: 0,
            pass: 'E-relaxed',
          };
          break;
        }
      }
    }

    return {
      feasible: false,
      relaxed: false,
      relaxedConfigs: null,
      pass: 'D',
      reason:
        suggestedRemovals.length
          ? `No conflict-free plan exists even after relaxing all configs. ` +
            (lastResortPlan
              ? `Last-resort plan available: drop ${lastResortPlan.droppedCourseIds.length} course(s) and the remainder fits cleanly.`
              : `Consider removing ${suggestedRemovals.length} course(s) — their requirements cannot be satisfied within available capacity.`)
          : `No conflict-free plan exists with the given courses and constraints. ` +
            `The best attempt left ${best.residualConflicts} residual conflict(s) (${(best.residualConflictRuleIds ?? []).join(', ')}).`,
      suggestedRemovals,
      // NEW-FU-397 (Phase 39): opt-in last-resort plan.
      lastResortPlan,
      // Echo the best non-zero attempt so the UI can show what it
      // would have looked like — but the controller MUST refuse to
      // persist it because feasible === false.
      bestAttempt: best,
      assignments: best.assignments ?? [],
      residualConflicts: best.residualConflicts ?? 0,
      residualConflictRuleIds: best.residualConflictRuleIds ?? [],
    };
  }
}

module.exports = new SuggestService();
