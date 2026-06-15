// NEW-FU-318 (Phase 29): Quick Fix resolver — holistic conflict
// remediation that proposes (and optionally applies) a sequence of
// minimally-destructive operations to resolve as many conflicts as
// possible.
//
// ALGORITHM: greedy, strict-monotone, sync (rationale documented in
// Phase 29's plan). Each call:
//   1. Loads current sections + conflicts.
//   2. Iterates conflicts in order (hard first, then soft).
//   3. For each conflict, generates candidate ops (move / reassign /
//      add-day / drop) using helpers reused from Phase 23 (R-15
//      extend) and Phase 25 (R-04/R-05 reassign generators).
//   4. Simulates each op against an in-memory copy of the schedule.
//      Picks the op that maximizes (conflicts_resolved -
//      conflicts_created), with the priority order serving as a
//      tie-break.
//   5. If a candidate would lower the total conflict count, ADD it to
//      the plan, apply against the in-memory state, recompute
//      conflicts, continue. If no op would lower the count, move to
//      the next conflict.
//   6. Stops at MAX_OPS (currently 20) or when no progress can be made.
//
// The plan is RETURNED but NOT APPLIED. Apply happens via a separate
// /quick-fix/apply endpoint inside a transaction. This split lets the
// frontend show a preview modal where the user can opt out of
// specific ops (e.g., drops) before committing.

const ConflictEngine = require('../engine/ConflictEngine');
const { ConflictRepository, ScheduleRepository, VenueRepository } = require('../repositories/repositories');
const InstructorRepository = require('../repositories/InstructorRepository');
const Section = require('../domain/Section');
const sectionPattern = require('../domain/sectionPattern');
const { query, getClient } = require('../config/db');
const { pickDummyOfficeHours, nextDummyVenueName } = require('../domain/dummyResources'); // NEW-FU-429/431 (Phase 106)

const engine = new ConflictEngine();
const instrRepo = new InstructorRepository();
const venueRepo = new VenueRepository();

// Scoring weights — exposed as constants so test code or future
// tuning passes can tweak them without rewriting the algorithm.
// HIGH absolute value = strong preference.
const SCORE = {
  RESOLVE_HARD:    +20,
  RESOLVE_SOFT:    +10,
  CREATE_HARD:     -25,   // creating a new hard is worse than resolving one
  CREATE_SOFT:     -3,
  OP_MOVE:         -2,    // moderate disruption
  OP_REASSIGN:     -5,    // people-facing change
  OP_ADD_DAY:      -3,    // additive, mild
  OP_DROP:         -25,   // last resort
  // NEW-FU-272 (Phase 50): metadata-flip ops. Slightly worse than a
  // section-level reassign because they mutate course / venue records
  // (broader scope) but a lot better than a drop. Greedy will prefer
  // reassign / move when those work, fall back to these when not.
  OP_FLAG_FLIP:    -10,
  // NEW-FU-426 (Phase 105): create a term-local placeholder instructor/venue.
  // Ordering (higher = preferred): reassign (-5) > compound move+reassign (-7)
  // > DUMMY (-8) > flag-flips like mark-venue-exempt / reclassify-venue (-10)
  // > drop (-25). A placeholder is costlier than reusing an existing free
  // resource, but for a genuine capacity bind it is the honest fix the user
  // asked for (Phase 104) — and LESS invasive than a flag-flip, which mutates a
  // course/venue record GLOBALLY (every term) to make the conflict "not apply"
  // and thereby HIDES the shortage. So a term-local placeholder is preferred
  // over those flips, and always far ahead of destroying the offering (drop).
  OP_DUMMY:        -8,
};
const MAX_OPS = 20;       // bound on plan size (defensive against runaway loops)

// NEW-FU-380 (Phase 36): per-rule weights for the weighted-monotone
// gate. Strict-count gating rejected ops that "swap one R-13 for one
// R-02" — a strict win on weighted cost. Match SuggestService's
// `RULE_WEIGHTS` so the two services agree on the relative cost of
// each conflict.
const RULE_WEIGHTS = {
  'R-01': 100,
  'R-02':  50,
  'R-04':  80,
  'R-05':  80,
  'R-06':  60,
  'R-09':  20,
  'R-10':  20,
  'R-11':  15,
  'R-12':  15,
  'R-13':   5,
  'R-14':  30,
  'R-15':  40,
};
function weightedCost(conflicts) {
  let total = 0;
  for (const c of conflicts) total += RULE_WEIGHTS[c.ruleId] ?? 10;
  return total;
}

// NEW-FU-381 (Phase 36): canonical, human-readable reasons for the
// `unresolvedReasons` map. Generators populate this when they cannot
// produce a valid op for a given conflict — the modal renders it as
// the per-rule explanation row. Keep messages short and actionable.
const UNRESOLVED_REASONS = {
  'R-01': 'No alternative instructor or venue is free at this slot, and no in-window move clears the overlap.',
  'R-02': 'No move slot clears the overlap with the conflicting course AND keeps the instructor + venue free across the section\'s meeting days.',
  'R-04': 'No alternative instructor is free at this slot (every other instructor either has another section here or an office hour overlap).',
  'R-05': 'No alternative venue of the required type is free at this slot.',
  'R-06': 'No slot in the section\'s allowed time window (UG: 07:00–17:10, GR: 17:20–22:00) is free for the section\'s instructor and venue across all meeting days.',
  'R-09': 'No instructor is free at this slot.',
  'R-10': 'No venue of the required type is free at this slot.',
  'R-11': 'No laboratory venue is free at this slot.',
  'R-12': 'No lecture hall is free at this slot.',
  'R-13': 'No alternative instructor with configured office hours is free at this slot.',
  'R-14': 'Quick Fix cannot fabricate the missing Lec or Lab section without picking a time, instructor, and venue — please add it manually via the Add Section button.',
  'R-15': 'No further legal day-template extension is available for this section group.',
};

// Helper: deep-clone the sections array as plain JS objects so we can
// simulate mutations without touching the source array.
function cloneSections(sections) {
  return sections.map(s => ({ ...s }));
}

// Helper: re-evaluate conflicts on an in-memory section array.
// Mirrors what ScheduleService._evaluateSchedule does but in-memory
// (no DB read). Phase 29 only emitted ConflictEngine rules (R-01,
// R-02, R-04, R-05, R-06). Phase 30 (FU-325) extends this with the
// inline rules R-09/R-10/R-11/R-12/R-15 so the simulator can recognize
// when an op resolves these conflicts. The inline logic mirrors
// ScheduleService._evaluateSchedule exactly — keep them in sync if
// you change one.
function evaluateInMemory(sections, ohMap) {
  const sectionDomain = sections.map(s => new Section(s));
  const result = engine.evaluateAll(sectionDomain, ohMap);
  const conflicts = [...result.conflicts];

  // R-09: missing instructor (dedup by courseId|sectionNumber)
  const f09Seen = new Set();
  for (const sec of sections) {
    if (sec.instructorId) continue;
    const key = `${sec.courseId}|${sec.sectionNumber}`;
    if (f09Seen.has(key)) continue;
    f09Seen.add(key);
    conflicts.push({
      ruleId: 'R-09', severity: 'Soft',
      sectionAId: sec.id, sectionBId: null,
      description: `Section ${sec.sectionNumber} of ${sec.courseCode ?? sec.courseId} has no instructor.`,
    });
  }

  // R-10: missing venue (dedup by courseId|sectionNumber)
  // NEW-FU-272 (Phase 50 #1): skip venue-exempt courses (capstones).
  const f10Seen = new Set();
  for (const sec of sections) {
    if (sec.venueId) continue;
    if (sec.isCapstone) continue;
    const key = `${sec.courseId}|${sec.sectionNumber}`;
    if (f10Seen.has(key)) continue;
    f10Seen.add(key);
    conflicts.push({
      ruleId: 'R-10', severity: 'Soft',
      sectionAId: sec.id, sectionBId: null,
      description: `Section ${sec.sectionNumber} of ${sec.courseCode ?? sec.courseId} has no venue.`,
    });
  }

  // R-11 / R-12: venue-type mismatch (only when a venue IS assigned).
  // NEW-FU-272 (Phase 50): skip venue-exempt courses AND 'Multipurpose'
  // venues — both are valid for either section type.
  const f11Seen = new Set();
  const f12Seen = new Set();
  for (const sec of sections) {
    if (!sec.venueId || !sec.venueType) continue;
    if (sec.isCapstone) continue;
    if (sec.venueType === 'Multipurpose') continue;
    const key = `${sec.courseId}|${sec.sectionNumber}`;
    if (sec.sectionType === 'Lab' && sec.venueType !== 'Laboratory') {
      if (!f11Seen.has(key)) {
        f11Seen.add(key);
        conflicts.push({
          ruleId: 'R-11', severity: 'Soft',
          sectionAId: sec.id, sectionBId: null,
          description: `Lab section in non-lab venue.`,
        });
      }
    }
    if (sec.sectionType === 'Lec' && sec.venueType === 'Laboratory') {
      if (!f12Seen.has(key)) {
        f12Seen.add(key);
        conflicts.push({
          ruleId: 'R-12', severity: 'Soft',
          sectionAId: sec.id, sectionBId: null,
          description: `Lecture section in lab venue.`,
        });
      }
    }
  }

  // R-15: insufficient credit coverage (LECTURE groups only)
  const f15Groups = new Map();
  for (const sec of sections) {
    if (sec.sectionType !== 'Lec') continue;
    if (!sec.credits) continue;
    if (!sec.startTime || !sec.endTime) continue;
    const key = `${sec.courseId}|${sec.sectionNumber}`;
    let group = f15Groups.get(key);
    if (!group) {
      group = {
        totalMinutes: 0,
        credits:  Number(sec.credits),
        hasLab:   Boolean(sec.hasLab),
        anySec:   sec,
      };
      f15Groups.set(key, group);
    }
    const dur = Section.toMinutes(sec.endTime) - Section.toMinutes(sec.startTime);
    if (dur > 0) group.totalMinutes += dur;
  }
  for (const group of f15Groups.values()) {
    const effectiveCredits = group.hasLab
      ? Math.max(1, group.credits - 1)
      : group.credits;
    const requiredMinutes = effectiveCredits * 50;
    if (group.totalMinutes >= requiredMinutes) continue;
    conflicts.push({
      ruleId: 'R-15', severity: 'Soft',
      sectionAId: group.anySec.id, sectionBId: null,
      description: `Insufficient credit coverage.`,
    });
  }

  // NEW-FU-374 (Phase 36): R-13 detection — section assigned to an
  // instructor who has NO office hours at all. Mirrors the rule fired
  // by ScheduleService at save time (FU-99). Dedup per instructor so
  // we don't generate N copies for an instructor with N sections.
  const f13Seen = new Set();
  for (const sec of sections) {
    if (!sec.instructorId) continue;
    if (f13Seen.has(sec.instructorId)) continue;
    if (sec._ohAssigned) { f13Seen.add(sec.instructorId); continue; } // NEW-FU-460: OH assigned in this plan → no R-13
    const ohList = ohMap.get(sec.instructorId) ?? [];
    if (ohList.length === 0) {
      f13Seen.add(sec.instructorId);
      conflicts.push({
        ruleId: 'R-13', severity: 'Soft',
        sectionAId: sec.id, sectionBId: null,
        description: `Instructor has no office hours configured.`,
      });
    }
  }

  // NEW-FU-375 (Phase 36): R-14 detection — has_lab=true course missing
  // either its Lec sections or its Lab sections. We collect per-course
  // section-type presence and emit one R-14 per course missing a half.
  const f14CourseTypes = new Map(); // courseId → { hasLec, hasLab, anySec, courseCode, hasLabFlag }
  for (const sec of sections) {
    if (!sec.hasLab) continue;          // R-14 only applies to has_lab=true courses
    let entry = f14CourseTypes.get(sec.courseId);
    if (!entry) {
      entry = { hasLec: false, hasLab: false, anySec: sec,
                courseCode: sec.courseCode ?? sec.courseId };
      f14CourseTypes.set(sec.courseId, entry);
    }
    if (sec.sectionType === 'Lec') entry.hasLec = true;
    if (sec.sectionType === 'Lab') entry.hasLab = true;
  }
  for (const [courseId, e] of f14CourseTypes) {
    if (e.hasLec && e.hasLab) continue;
    const missing = !e.hasLec ? 'Lec' : 'Lab';
    conflicts.push({
      ruleId: 'R-14', severity: 'Soft',
      sectionAId: e.anySec.id, sectionBId: null,
      description: `Course ${e.courseCode} is set up to have both lectures and labs, but is missing its ${missing === 'Lec' ? 'lecture' : 'lab'} section(s).`,
      missingType: missing,
    });
  }

  // NEW-FU-426 (Phase 105): term-local DUMMY instructors are placeholders the
  // registrar will staff later — they intentionally carry no office hours, so
  // any R-13 raised against a `__dummy` instructor (by the ConflictEngine OR
  // the inline check above) must be dropped. Mirrors SuggestService's
  // exemption so the two resolvers agree placeholders never trip R-13.
  return conflicts.filter(c => {
    if (c.ruleId !== 'R-13') return true;
    const sec = sections.find(s => s.id === c.sectionAId);
    if (!sec) return true;
    // Skip R-13 for placeholders: synthetic in-memory ids (__dummy*) during a
    // solve AND persisted dummy instructors (is_dummy, loaded as
    // instructorIsDummy) after apply — a placeholder has no OH by design.
    return !(String(sec.instructorId).startsWith('__dummy') || sec.instructorIsDummy);
  });
}

// Helper: count conflict severities for scoring.
function countConflicts(conflicts) {
  let hard = 0, soft = 0;
  for (const c of conflicts) {
    if (c.severity === 'Hard') hard++;
    else if (c.severity === 'Soft') soft++;
  }
  return { hard, soft };
}

// NEW-FU-333 (Phase 31): enumerate candidate startTime slots for a
// section that would NOT conflict with the section's current
// instructor or venue. Used by the R-02 generator (move to a non-
// overlapping slot) and the compound move-aware generators for
// saturated R-10/R-11/R-12.
//
// Returns an array of { newStartTime, newEndTime } objects sorted by
// closeness to the section's CURRENT startTime — moving 50 minutes
// is preferred over moving 4 hours.
function moveCandidatesFor(sectionA, sections) {
  if (!sectionA?.startTime || !sectionA?.endTime) return [];
  const durMin = Section.toMinutes(sectionA.endTime) - Section.toMinutes(sectionA.startTime);
  if (durMin <= 0) return [];
  // KFUPM lecture window: 07:00–17:10 for UG, 17:20–22:00 for GR (see TIME_WINDOWS).
  // NEW-FU-360 (Phase 35): respect the section's CATEGORY when
  // proposing move slots. Moving a graduate course to 09:00 would
  // create R-06 (graduate time-window violation), which the
  // strict-monotone gate would reject — so no candidate gets
  // accepted and R-02 stays unresolved (the screenshot 2 case).
  // Pinning the window by category keeps every emitted candidate
  // viable for the strict-monotone path.
  // NEW-FU-441 (Phase 107 M2): derive the move window from the engine's R-06
  // TIME_WINDOWS so every emitted candidate is R-06-viable.
  // NEW-FU-495 (Phase 120): UG 07:00–17:10, GR 17:20–22:00. Capstone is now
  // bound to the UG window (venue-exempt but NOT time-exempt) — no longer full day.
  const isGraduate = sectionA.category === 'GR';
  const isCapstone = sectionA.isCapstone === true;
  const WINDOW_START = isCapstone ? 7 * 60 : (isGraduate ? 17 * 60 + 20 : 7 * 60);
  const WINDOW_END   = isCapstone ? 17 * 60 + 10 : (isGraduate ? 22 * 60 : 17 * 60 + 10);
  const STEP = 30;               // half-hour granularity
  // Compute the instructor + venue + group keys we need to keep clear.
  const groupKey = `${sectionA.courseId}|${sectionA.sectionNumber}`;
  const startMinCurrent = Section.toMinutes(sectionA.startTime);
  const candidates = [];
  for (let t = WINDOW_START; t + durMin <= WINDOW_END; t += STEP) {
    if (t === startMinCurrent) continue; // skip current slot
    const newStart = t;
    const newEnd   = t + durMin;
    // Check: at the new slot, is the section's instructor still free
    // on ALL of the group's meeting days? Same for venue.
    const groupRows = sections.filter(s =>
      `${s.courseId}|${s.sectionNumber}` === groupKey
    );
    let allFree = true;
    for (const row of groupRows) {
      const conflictingInstr = sectionA.instructorId && sections.some(s =>
        `${s.courseId}|${s.sectionNumber}` !== groupKey &&
        s.instructorId === sectionA.instructorId &&
        s.day === row.day &&
        Section.toMinutes(s.startTime) < newEnd &&
        newStart < Section.toMinutes(s.endTime)
      );
      const conflictingVenue = sectionA.venueId && sections.some(s =>
        `${s.courseId}|${s.sectionNumber}` !== groupKey &&
        s.venueId === sectionA.venueId &&
        s.day === row.day &&
        Section.toMinutes(s.startTime) < newEnd &&
        newStart < Section.toMinutes(s.endTime)
      );
      if (conflictingInstr || conflictingVenue) { allFree = false; break; }
    }
    if (!allFree) continue;
    candidates.push({
      newStartTime: `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`,
      newEndTime:   `${String(Math.floor(newEnd/60)).padStart(2,'0')}:${String(newEnd%60).padStart(2,'0')}`,
      distance:     Math.abs(t - startMinCurrent),
    });
  }
  // Closest-first so the greedy prefers least-disruptive moves.
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates;
}

// Generate candidate ops for a single conflict.
// Each op is a JS object describing the proposed mutation. The
// simulator below applies them by mutating the cloned sections array.
// NEW-FU-385 (Phase 37): drop is destructive — removing a section
// means the course offering no longer exists. The Phase 36 auto-pick
// of drop "resolved" conflicts by deletion, which is unacceptable.
// candidateOps now accepts `allowDrop` (default false). The /quick-fix
// endpoint sets it false; an explicit opt-in flag would let a future
// "delete-with-confirm" workflow surface drop deliberately.
function candidateOps(conflict, sections, instructors, venues, ohMap, opts = {}) {
  const allowDrop = opts.allowDrop === true;

  // NEW-FU-426 (Phase 105): build a "create term-local placeholder" op for a
  // section group when NO real free instructor/venue exists — the same tier
  // SuggestService gained in Phase 104. Instead of leaving the conflict for a
  // last-resort drop, we mint a clearly-labelled placeholder the registrar
  // staffs later. The synthetic id carries a `__dummy` prefix so the in-memory
  // R-13 check skips it (placeholders have no office hours yet); the venue op
  // carries the required type so R-11/R-12 stay clear. apply() turns these
  // into real is_dummy rows tagged with the owning term.
  // NEW-FU-548 (Batch 15 Issue 4): tag placeholder ops with `dummy: true` so the
  // planner can hold them back to a LATER tier — real move/reassign solutions are
  // exhausted first; minting a dummy instructor/venue is a resort, not a first move.
  const dummyInstrOp = (sec) => ({
    type:      'add-dummy-instructor',
    sectionId: sec.id,
    dummyId:   `__dummy_instr_${sec.courseId}_${sec.sectionNumber}__`,
    dummyName: 'NEW INSTRUCTOR',
    priority:  SCORE.OP_DUMMY,
    dummy:     true,
    label:     `Add a NEW placeholder instructor for ${sec.courseCode} §${sec.sectionNumber} (no existing instructor is free — staff it later)`,
  });
  const dummyVenueOp = (sec, wantType) => ({
    type:      'add-dummy-venue',
    sectionId: sec.id,
    dummyId:   `__dummy_venue_${sec.courseId}_${sec.sectionNumber}__`,
    dummyName: '22-900',
    venueType: wantType === 'Laboratory' ? 'Laboratory' : 'LectureHall',
    priority:  SCORE.OP_DUMMY,
    dummy:     true,
    label:     `Add a NEW placeholder ${wantType === 'Laboratory' ? 'lab' : 'room'} for ${sec.courseCode} §${sec.sectionNumber} (no existing venue is free — assign it later)`,
  });
  const ops = [];
  const sectionAId = conflict.sectionAId;
  const sectionBId = conflict.sectionBId;
  const sectionA   = sectionAId ? sections.find(s => s.id === sectionAId) : null;
  if (!sectionA) return ops;

  // NEW-FU-333 (Phase 31): R-02 adjacent-level soft conflict.
  // R-02 fires when sectionA and sectionB overlap in time but are
  // from ADJACENT academic levels (e.g., Sophomore + Junior). The
  // resolution is to move sectionA (or sectionB) to a non-overlapping
  // slot. Propose the 3 closest free slots — the greedy picks the
  // one that maximizes resolution.
  if (conflict.ruleId === 'R-02') {
    const simpleR02OpsBefore = ops.length;
    const candidates = moveCandidatesFor(sectionA, sections);
    // NEW-FU-370 (Phase 35): filter out candidates that still overlap
    // with the CONFLICTING section in time. moveCandidatesFor only
    // checks instructor + venue freeness; for R-02 we additionally
    // need the new slot to NOT overlap with sectionB's time on either
    // of sectionB's meeting days. Without this, the closest-first
    // candidates (30-min step around current) all keep overlapping
    // sectionB and the strict-monotone gate rejects every one of them
    // — exactly the "No automatic fix for R-02" symptom from
    // screenshot 2.
    const sectionB = conflict.sectionBId
      ? sections.find(s => s.id === conflict.sectionBId)
      : null;
    const sectionBGroupKey = sectionB
      ? `${sectionB.courseId}|${sectionB.sectionNumber}`
      : null;
    const sectionBRows = sectionBGroupKey
      ? sections.filter(s => `${s.courseId}|${s.sectionNumber}` === sectionBGroupKey)
      : [];
    const groupRows = sections.filter(s =>
      s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber
    );
    const groupDays = new Set(groupRows.map(s => s.day));
    const candidatesClearingSectionB = candidates.filter(cand => {
      if (!sectionBRows.length) return true; // no B to clear → keep all
      const newStartMin = Section.toMinutes(cand.newStartTime);
      const newEndMin   = Section.toMinutes(cand.newEndTime);
      return !sectionBRows.some(b =>
        groupDays.has(b.day) &&
        Section.toMinutes(b.startTime) < newEndMin &&
        newStartMin < Section.toMinutes(b.endTime)
      );
    });
    // Use the filtered candidates if any exist; otherwise fall back
    // to the raw closest-first list so the compound branch below has
    // SOME candidate to widen from.
    const chosen = candidatesClearingSectionB.length ? candidatesClearingSectionB : candidates;
    for (const cand of chosen.slice(0, 5)) {
      ops.push({
        type:         'move',
        sectionId:    sectionA.id,
        newStartTime: cand.newStartTime,
        newEndTime:   cand.newEndTime,
        priority:     SCORE.OP_MOVE,
        label:        `Move ${sectionA.courseCode} §${sectionA.sectionNumber} to ${cand.newStartTime}–${cand.newEndTime}`,
      });
    }

    // NEW-FU-361 (Phase 35): if NO simple `move` slot was free (the
    // Graduate-band saturation case — screenshot 2), the conflict's
    // instructor is busy across every viable slot. Try the compound
    // `move + reassign-instructor` fallback: scan candidate slots,
    // and at each slot find a DIFFERENT instructor who's free across
    // the whole section group (all meeting days). This mirrors the
    // Phase 33 (FU-348) compound-venue pattern for R-11/R-12.
    //
    // We emit the compound op only when the simple move slot enumerator
    // found candidates ignoring the instructor constraint — meaning
    // the time window has free space but the original instructor is
    // unavailable there. Without this fallback the resolver returns
    // "No automatic fix for R-02" exactly as in the screenshot.
    if (ops.length === simpleR02OpsBefore) {
      const groupKey  = `${sectionA.courseId}|${sectionA.sectionNumber}`;
      const groupRows = sections.filter(s =>
        `${s.courseId}|${s.sectionNumber}` === groupKey
      );
      // NEW-FU-441 (Phase 107 M2): align with R-06 TIME_WINDOWS (see moveCandidatesFor).
      // NEW-FU-495 (Phase 120): UG 07:00–17:10, GR 17:20–22:00; capstone = UG window.
      const isGraduate   = sectionA.category === 'GR';
      const isCapstoneB  = sectionA.isCapstone === true;
      const WINDOW_START = isCapstoneB ? 7 * 60 : (isGraduate ? 17 * 60 + 20 : 7 * 60);
      const WINDOW_END   = isCapstoneB ? 17 * 60 + 10 : (isGraduate ? 22 * 60 : 17 * 60 + 10);
      const STEP         = 30;
      const durMin       = Section.toMinutes(sectionA.endTime) - Section.toMinutes(sectionA.startTime);
      const currentMin   = Section.toMinutes(sectionA.startTime);

      // Per-instructor load — pick the least-loaded eligible candidate
      // so the fallback doesn't make the load distribution worse.
      const load = new Map();
      for (const s of sections) {
        if (s.instructorId) load.set(s.instructorId, (load.get(s.instructorId) ?? 0) + 1);
      }
      const ranked = [...instructors]
        .filter(i => i.id !== sectionA.instructorId)
        .sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));

      outer:
      for (let t = WINDOW_START; t + durMin <= WINDOW_END; t += STEP) {
        if (t === currentMin) continue;
        const newStart = t;
        const newEnd   = t + durMin;

        // Venue must be free at this slot across the whole group.
        const venueBusy = sectionA.venueId && groupRows.some(row =>
          sections.some(s =>
            `${s.courseId}|${s.sectionNumber}` !== groupKey &&
            s.venueId === sectionA.venueId &&
            s.day === row.day &&
            Section.toMinutes(s.startTime) < newEnd &&
            newStart < Section.toMinutes(s.endTime)
          )
        );
        if (venueBusy) continue;

        // Find an alternative instructor free at this slot across the
        // whole group AND not booked into an office hour collision.
        for (const instr of ranked) {
          const instrBusy = groupRows.some(row =>
            sections.some(s =>
              `${s.courseId}|${s.sectionNumber}` !== groupKey &&
              s.instructorId === instr.id &&
              s.day === row.day &&
              Section.toMinutes(s.startTime) < newEnd &&
              newStart < Section.toMinutes(s.endTime)
            )
          );
          if (instrBusy) continue;
          const oh = ohMap.get(instr.id) ?? [];
          const ohBusy = groupRows.some(row =>
            oh.some(o =>
              o.day === row.day &&
              Section.toMinutes(o.startTime) < newEnd &&
              newStart < Section.toMinutes(o.endTime)
            )
          );
          if (ohBusy) continue;

          const newStartTime = `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`;
          const newEndTime   = `${String(Math.floor(newEnd/60)).padStart(2,'0')}:${String(newEnd%60).padStart(2,'0')}`;
          ops.push({
            type:      'compound',
            sectionId: sectionA.id,
            subOps: [
              { type: 'move',                sectionId: sectionA.id,
                newStartTime, newEndTime },
              { type: 'reassign-instructor', sectionId: sectionA.id,
                newInstructorId: instr.id },
            ],
            priority: SCORE.OP_MOVE + SCORE.OP_REASSIGN,
            label:
              `Move ${sectionA.courseCode} §${sectionA.sectionNumber} to ${newStartTime} ` +
              `+ reassign to ${instr.name}`,
          });
          if (ops.length - simpleR02OpsBefore >= 3) break outer;
          break; // one instructor per slot
        }
      }
    }
  }

  // NEW-FU-326 (Phase 30): R-09 missing instructor → propose
  // reassign-instructor with current=null. Same op type as R-04 fix;
  // the only difference is the "current" value (null vs. some id).
  // Picks the least-loaded instructor who's free at this slot to keep
  // distribution balanced (load = count of sections already assigned).
  if (conflict.ruleId === 'R-09') {
    const startMin = Section.toMinutes(sectionA.startTime);
    const endMin   = Section.toMinutes(sectionA.endTime);
    // Compute per-instructor load to pick the least-loaded free one.
    const load = new Map();
    for (const s of sections) {
      if (s.instructorId) load.set(s.instructorId, (load.get(s.instructorId) ?? 0) + 1);
    }
    const ranked = [...instructors].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));
    for (const instr of ranked) {
      const busy = sections.some(s =>
        s.id !== sectionA.id &&
        s.instructorId === instr.id &&
        s.day === sectionA.day &&
        Section.toMinutes(s.startTime) < endMin &&
        startMin < Section.toMinutes(s.endTime)
      );
      if (busy) continue;
      const oh = ohMap.get(instr.id) ?? [];
      const ohBusy = oh.some(o =>
        o.day === sectionA.day &&
        Section.toMinutes(o.startTime) < endMin &&
        startMin < Section.toMinutes(o.endTime)
      );
      if (ohBusy) continue;
      ops.push({
        type:       'reassign-instructor',
        sectionId:  sectionA.id,
        newInstructorId: instr.id,
        priority:   SCORE.OP_REASSIGN,
        label:      `Assign ${sectionA.courseCode} §${sectionA.sectionNumber} to ${instr.name}`,
      });
      if (ops.length >= 3) break;
    }
    // NEW-FU-426 (Phase 105): ALWAYS offer a placeholder instructor; greedy
    // prefers a real reassign when one is free, else the placeholder keeps the
    // section staffed instead of dropping it.
    ops.push(dummyInstrOp(sectionA));
  }

  // NEW-FU-326: R-10 missing venue → propose reassign-venue with
  // current=null. Pick a venue matching the section type (Lab vs.
  // LectureHall), free at this slot, with capacity > 0.
  if (conflict.ruleId === 'R-10') {
    const startMin = Section.toMinutes(sectionA.startTime);
    const endMin   = Section.toMinutes(sectionA.endTime);
    const desiredType = sectionA.sectionType === 'Lab' ? 'Laboratory' : 'LectureHall';
    const simpleR10Before = ops.length;
    // NEW-FU-389 (Phase 37): R-10 busy check must scan ALL group meeting
    // days, not just sectionA.day — the Phase 36 single-day check let
    // the resolver propose venues that were busy on Tuesday when the
    // group meets Sun/Tue/Thu, so the apply created a new R-05.
    const groupRows = sections.filter(s =>
      s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber
    );
    const groupDays = new Set(groupRows.map(s => s.day));
    for (const v of venues) {
      if (v.type !== desiredType) continue;
      const busy = sections.some(s => {
        if (s.id === sectionA.id) return false;
        if (s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber) return false;
        if (s.venueId !== v.id) return false;
        if (!groupDays.has(s.day)) return false;
        return Section.toMinutes(s.startTime) < endMin &&
               startMin < Section.toMinutes(s.endTime);
      });
      if (busy) continue;
      ops.push({
        type:      'reassign-venue',
        sectionId: sectionA.id,
        newVenueId: v.id,
        priority:  SCORE.OP_REASSIGN,
        label:     `Assign ${sectionA.courseCode} §${sectionA.sectionNumber} to ${v.name}`,
      });
      if (ops.length >= 3) break;
    }
    // NEW-FU-389 (Phase 37): R-10 compound fallback — if no same-slot
    // venue of the required type is free across all group days, try
    // moving the section to a different slot where one IS free. Mirrors
    // the R-11/R-12 compound pattern from Phase 33.
    if (ops.length === simpleR10Before) {
      const moveSlots = moveCandidatesFor(sectionA, sections);
      for (const slot of moveSlots) {
        const newStartMin = Section.toMinutes(slot.newStartTime);
        const newEndMin   = Section.toMinutes(slot.newEndTime);
        const freeVenue = venues.find(v => {
          if (v.type !== desiredType) return false;
          // Free across ALL meeting days at the new slot.
          for (const day of groupDays) {
            const busy = sections.some(s =>
              s.id !== sectionA.id &&
              `${s.courseId}|${s.sectionNumber}` !== `${sectionA.courseId}|${sectionA.sectionNumber}` &&
              s.venueId === v.id && s.day === day &&
              Section.toMinutes(s.startTime) < newEndMin &&
              newStartMin < Section.toMinutes(s.endTime)
            );
            if (busy) return false;
          }
          return true;
        });
        if (!freeVenue) continue;
        ops.push({
          type:      'compound',
          sectionId: sectionA.id,
          subOps: [
            { type: 'move',           sectionId: sectionA.id,
              newStartTime: slot.newStartTime, newEndTime: slot.newEndTime },
            { type: 'reassign-venue', sectionId: sectionA.id,
              newVenueId: freeVenue.id },
          ],
          priority: SCORE.OP_MOVE + SCORE.OP_REASSIGN,
          label:    `Move ${sectionA.courseCode} §${sectionA.sectionNumber} to ${slot.newStartTime} + assign ${freeVenue.name}`,
        });
        if (ops.length - simpleR10Before >= 3) break;
      }
    }
    // NEW-FU-426 (Phase 105): ALWAYS offer a placeholder venue (see note above);
    // greedy prefers a real reassign/compound when valid, else the placeholder.
    ops.push(dummyVenueOp(sectionA, desiredType));
  }

  // NEW-FU-326: R-11 lab in non-lab venue → reassign to a Laboratory.
  // R-12 lec in lab venue → reassign to a LectureHall. Same shape as
  // R-05 (venue conflict) but the filter is type-driven, not avoidance.
  if (conflict.ruleId === 'R-11' || conflict.ruleId === 'R-12') {
    const startMin = Section.toMinutes(sectionA.startTime);
    const endMin   = Section.toMinutes(sectionA.endTime);
    const desiredType = conflict.ruleId === 'R-11' ? 'Laboratory' : 'LectureHall';
    const simpleOpsCountBefore = ops.length;
    for (const v of venues) {
      if (v.id === sectionA.venueId) continue;
      if (v.type !== desiredType) continue;
      // NEW-FU-350 (Phase 33): the busy check used to look only at
      // sectionA.day — but reassign-venue updates the ENTIRE section
      // group atomically, so the new venue must be free on ALL the
      // group's meeting days, not just sectionA's. Without this we'd
      // happily propose a hall that's already used on Tuesday by
      // another course and the apply would create R-05 hard conflicts.
      const groupRows = sections.filter(s =>
        s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber
      );
      const groupDays = new Set(groupRows.map(s => s.day));
      const busy = sections.some(s => {
        if (s.id === sectionA.id) return false;
        if (s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber) return false;
        if (s.venueId !== v.id) return false;
        if (!groupDays.has(s.day)) return false;
        return Section.toMinutes(s.startTime) < endMin &&
               startMin < Section.toMinutes(s.endTime);
      });
      if (busy) continue;
      ops.push({
        type:      'reassign-venue',
        sectionId: sectionA.id,
        newVenueId: v.id,
        priority:  SCORE.OP_REASSIGN,
        label:     `Move ${sectionA.courseCode} §${sectionA.sectionNumber} to ${v.name} (${v.type})`,
      });
      if (ops.length >= 3) break;
    }
    // NEW-FU-348 (Phase 33): if NO same-slot venue of the correct
    // type is free, propose compound (move + reassign-venue) ops.
    // For each candidate move slot, find a free venue of the right
    // type at that slot. Emit ONE compound op per (slot, venue)
    // combination, capped at 3 total to keep the plan tight.
    if (ops.length === simpleOpsCountBefore) {
      const moveSlots = moveCandidatesFor(sectionA, sections);
      for (const slot of moveSlots) {
        const newStartMin = Section.toMinutes(slot.newStartTime);
        const newEndMin   = Section.toMinutes(slot.newEndTime);
        // NEW-FU-442 (Phase 107 M1): check ALL the group's meeting days (not just
        // sectionA.day) and exclude the group's own rows — reassign-venue moves the
        // WHOLE group, so a hall busy on a sibling day would apply into an R-05.
        const compGroupDays = new Set(sections
          .filter(s => s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber)
          .map(s => s.day));
        const freeVenue = venues.find(v => {
          if (v.id === sectionA.venueId) return false;
          if (v.type !== desiredType) return false;
          return !sections.some(s =>
            `${s.courseId}|${s.sectionNumber}` !== `${sectionA.courseId}|${sectionA.sectionNumber}` &&
            s.venueId === v.id &&
            compGroupDays.has(s.day) &&
            Section.toMinutes(s.startTime) < newEndMin &&
            newStartMin < Section.toMinutes(s.endTime)
          );
        });
        if (!freeVenue) continue;
        ops.push({
          type:      'compound',
          sectionId: sectionA.id,
          subOps: [
            { type: 'move',           sectionId: sectionA.id,
              newStartTime: slot.newStartTime, newEndTime: slot.newEndTime },
            { type: 'reassign-venue', sectionId: sectionA.id,
              newVenueId: freeVenue.id },
          ],
          priority: SCORE.OP_MOVE + SCORE.OP_REASSIGN,
          label:    `Move ${sectionA.courseCode} §${sectionA.sectionNumber} to ${slot.newStartTime} + reassign to ${freeVenue.name}`,
        });
        if (ops.length >= 3) break;
      }
    }
    // NEW-FU-426 (Phase 105): ALWAYS offer a placeholder venue of the required
    // type as a fallback (see note above) instead of risking a drop.
    ops.push(dummyVenueOp(sectionA, desiredType));
  }

  // NEW-FU-326: R-15 insufficient credit coverage → propose add-day.
  // Mirrors the FU-278 fix-proposal logic from ScheduleService inline.
  // Find which template days are missing from the surviving group and
  // propose the smallest extension (least intrusive).
  if (conflict.ruleId === 'R-15') {
    const groupRows = sections.filter(s =>
      s.sectionType === 'Lec' &&
      s.courseId === sectionA.courseId &&
      s.sectionNumber === sectionA.sectionNumber
    );
    if (groupRows.length > 0) {
      const survivingDays = new Set(groupRows.map(s => s.day));
      const survivingRow  = groupRows[0];
      const perMeetingDur =
        Section.toMinutes(survivingRow.endTime) - Section.toMinutes(survivingRow.startTime);
      if (perMeetingDur > 0) {
        const candidateTemplates = sectionPattern.legalDayTemplatesForCourse({
          credits: Number(sectionA.credits),
          hasLab:  Boolean(sectionA.hasLab),
          duration: perMeetingDur,
        });
        const TEMPLATE_DAYS = {
          STT: ['Sunday', 'Tuesday', 'Thursday'],
          MW:  ['Monday', 'Wednesday'],
          ST:  ['Sunday', 'Tuesday'],
          TT:  ['Tuesday', 'Thursday'],
        };
        const fixProposals = [];
        for (const tplName of candidateTemplates) {
          const tplDays = TEMPLATE_DAYS[tplName];
          if (!tplDays) continue;
          // Surviving must be a subset of this template.
          let supersetOk = true;
          for (const d of survivingDays) if (!tplDays.includes(d)) { supersetOk = false; break; }
          if (!supersetOk) continue;
          const missing = tplDays.filter(d => !survivingDays.has(d));
          if (missing.length === 0) continue;
          fixProposals.push({ template: tplName, addDays: missing });
        }
        fixProposals.sort((a, b) => a.addDays.length - b.addDays.length);
        // Emit ONE op per fix (cap 2 — first is the least-intrusive).
        for (const fix of fixProposals.slice(0, 2)) {
          ops.push({
            type:      'add-day',
            sectionId: survivingRow.id,
            addDays:   fix.addDays,
            priority:  SCORE.OP_ADD_DAY,
            label:     `Add ${fix.addDays.join(' + ')} meeting${fix.addDays.length > 1 ? 's' : ''} to ${sectionA.courseCode} §${sectionA.sectionNumber}`,
          });
        }
      }
    }
  }

  // R-04 / R-05 → reassign (instructor / venue)
  if (conflict.ruleId === 'R-04' && sectionA.instructorId) {
    const startMin = Section.toMinutes(sectionA.startTime);
    const endMin   = Section.toMinutes(sectionA.endTime);
    const simpleR04Before = ops.length;
    // NEW-FU-390 (Phase 37): R-04 busy check must scan ALL group days.
    const groupRows = sections.filter(s =>
      s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber);
    const groupDays = new Set(groupRows.map(s => s.day));
    for (const instr of instructors) {
      if (instr.id === sectionA.instructorId) continue;
      // Free across ALL group meeting days?
      const busy = sections.some(s => {
        if (s.id === sectionA.id) return false;
        if (s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber) return false;
        if (s.instructorId !== instr.id) return false;
        if (!groupDays.has(s.day)) return false;
        return Section.toMinutes(s.startTime) < endMin &&
               startMin < Section.toMinutes(s.endTime);
      });
      if (busy) continue;
      const oh = ohMap.get(instr.id) ?? [];
      const ohBusy = [...groupDays].some(d => oh.some(o =>
        o.day === d &&
        Section.toMinutes(o.startTime) < endMin &&
        startMin < Section.toMinutes(o.endTime)
      ));
      if (ohBusy) continue;
      ops.push({
        type:       'reassign-instructor',
        sectionId:  sectionA.id,
        newInstructorId: instr.id,
        priority:   SCORE.OP_REASSIGN,
        label:      `Reassign ${sectionA.courseCode} §${sectionA.sectionNumber} to ${instr.name}`,
      });
      if (ops.length - simpleR04Before >= 3) break;
    }
    // NEW-FU-390 (Phase 37): R-04 compound fallback — move + reassign-instructor.
    if (ops.length === simpleR04Before) {
      const moveSlots = moveCandidatesFor(sectionA, sections);
      for (const slot of moveSlots) {
        const newStartMin = Section.toMinutes(slot.newStartTime);
        const newEndMin   = Section.toMinutes(slot.newEndTime);
        const freeInstr = instructors.find(i => {
          if (i.id === sectionA.instructorId) return false;
          for (const day of groupDays) {
            const busy = sections.some(s =>
              s.id !== sectionA.id &&
              `${s.courseId}|${s.sectionNumber}` !== `${sectionA.courseId}|${sectionA.sectionNumber}` &&
              s.instructorId === i.id && s.day === day &&
              Section.toMinutes(s.startTime) < newEndMin &&
              newStartMin < Section.toMinutes(s.endTime));
            if (busy) return false;
            const oh = ohMap.get(i.id) ?? [];
            if (oh.some(o => o.day === day &&
                Section.toMinutes(o.startTime) < newEndMin &&
                newStartMin < Section.toMinutes(o.endTime))) return false;
          }
          return true;
        });
        if (!freeInstr) continue;
        ops.push({
          type:      'compound',
          sectionId: sectionA.id,
          subOps: [
            { type: 'move', sectionId: sectionA.id,
              newStartTime: slot.newStartTime, newEndTime: slot.newEndTime },
            { type: 'reassign-instructor', sectionId: sectionA.id,
              newInstructorId: freeInstr.id },
          ],
          priority: SCORE.OP_MOVE + SCORE.OP_REASSIGN,
          label: `Move ${sectionA.courseCode} §${sectionA.sectionNumber} to ${slot.newStartTime} + assign ${freeInstr.name}`,
        });
        if (ops.length - simpleR04Before >= 3) break;
      }
    }
    // NEW-FU-426 (Phase 105): ALWAYS offer a placeholder instructor as a
    // fallback candidate. The greedy prefers a real reassign/compound (better
    // priority) when one is VALID; it falls to the placeholder only when none
    // is — INCLUDING when the only "free" slot would violate another rule
    // (e.g. R-06), a case the emit-only-when-empty guard missed (→ drop).
    ops.push(dummyInstrOp(sectionA));
  }
  if (conflict.ruleId === 'R-05' && sectionA.venueId) {
    const startMin = Section.toMinutes(sectionA.startTime);
    const endMin   = Section.toMinutes(sectionA.endTime);
    const desiredType = sectionA.sectionType === 'Lab' ? 'Laboratory' : 'LectureHall';
    const simpleR05Before = ops.length;
    // NEW-FU-390 (Phase 37): R-05 busy check must scan ALL group days.
    const groupRows = sections.filter(s =>
      s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber);
    const groupDays = new Set(groupRows.map(s => s.day));
    for (const v of venues) {
      if (v.id === sectionA.venueId) continue;
      if (v.type !== desiredType) continue;
      const busy = sections.some(s => {
        if (s.id === sectionA.id) return false;
        if (s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber) return false;
        if (s.venueId !== v.id) return false;
        if (!groupDays.has(s.day)) return false;
        return Section.toMinutes(s.startTime) < endMin &&
               startMin < Section.toMinutes(s.endTime);
      });
      if (busy) continue;
      ops.push({
        type:      'reassign-venue',
        sectionId: sectionA.id,
        newVenueId: v.id,
        priority:  SCORE.OP_REASSIGN,
        label:     `Move ${sectionA.courseCode} §${sectionA.sectionNumber} to ${v.name}`,
      });
      if (ops.length - simpleR05Before >= 3) break;
    }
    // NEW-FU-390 (Phase 37): R-05 compound fallback — move + reassign-venue.
    if (ops.length === simpleR05Before) {
      const moveSlots = moveCandidatesFor(sectionA, sections);
      for (const slot of moveSlots) {
        const newStartMin = Section.toMinutes(slot.newStartTime);
        const newEndMin   = Section.toMinutes(slot.newEndTime);
        const freeVenue = venues.find(v => {
          if (v.id === sectionA.venueId) return false;
          if (v.type !== desiredType) return false;
          for (const day of groupDays) {
            const busy = sections.some(s =>
              s.id !== sectionA.id &&
              `${s.courseId}|${s.sectionNumber}` !== `${sectionA.courseId}|${sectionA.sectionNumber}` &&
              s.venueId === v.id && s.day === day &&
              Section.toMinutes(s.startTime) < newEndMin &&
              newStartMin < Section.toMinutes(s.endTime));
            if (busy) return false;
          }
          return true;
        });
        if (!freeVenue) continue;
        ops.push({
          type:      'compound',
          sectionId: sectionA.id,
          subOps: [
            { type: 'move', sectionId: sectionA.id,
              newStartTime: slot.newStartTime, newEndTime: slot.newEndTime },
            { type: 'reassign-venue', sectionId: sectionA.id,
              newVenueId: freeVenue.id },
          ],
          priority: SCORE.OP_MOVE + SCORE.OP_REASSIGN,
          label: `Move ${sectionA.courseCode} §${sectionA.sectionNumber} to ${slot.newStartTime} + assign ${freeVenue.name}`,
        });
        if (ops.length - simpleR05Before >= 3) break;
      }
    }
    // NEW-FU-426 (Phase 105): ALWAYS offer a placeholder venue as a fallback
    // (see add-dummy-instructor note above); greedy prefers a real reassign /
    // compound when valid, else falls to the placeholder instead of a drop.
    ops.push(dummyVenueOp(sectionA, desiredType));
  }

  // NEW-FU-385 (Phase 37): drop is gated behind opts.allowDrop. The
  // resolver was previously auto-picking drop ops, which "resolved"
  // conflicts by destroying the user's course offering. Phase 37 G2
  // forbids drop as an auto-pick — it's only emitted when the caller
  // explicitly opts in. The plan endpoint defaults allowDrop=false.
  if (allowDrop && conflict.severity === 'Hard') {
    ops.push({
      type:      'drop',
      sectionId: sectionA.id,
      priority:  SCORE.OP_DROP,
      label:     `Drop ${sectionA.courseCode} §${sectionA.sectionNumber} (last resort)`,
    });
  }

  // NEW-FU-376 (Phase 36): R-01 → instructor or venue double-book hard.
  // The conflict shape is two sections sharing instructor OR venue at
  // overlapping times. We try in order:
  //   1. reassign-instructor to a free alternative
  //   2. reassign-venue to a free alternative
  //   3. move sectionA to a non-overlapping slot
  if (conflict.ruleId === 'R-01') {
    const startMin = Section.toMinutes(sectionA.startTime);
    const endMin   = Section.toMinutes(sectionA.endTime);

    // 1) Reassign-instructor — pick the least-loaded free instructor.
    if (sectionA.instructorId) {
      const load = new Map();
      for (const s of sections) {
        if (s.instructorId) load.set(s.instructorId, (load.get(s.instructorId) ?? 0) + 1);
      }
      const ranked = [...instructors]
        .filter(i => i.id !== sectionA.instructorId)
        .sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));
      for (const instr of ranked) {
        const busy = sections.some(s =>
          s.id !== sectionA.id && s.instructorId === instr.id &&
          s.day === sectionA.day &&
          Section.toMinutes(s.startTime) < endMin &&
          startMin < Section.toMinutes(s.endTime)
        );
        if (busy) continue;
        const oh = ohMap.get(instr.id) ?? [];
        const ohBusy = oh.some(o =>
          o.day === sectionA.day &&
          Section.toMinutes(o.startTime) < endMin &&
          startMin < Section.toMinutes(o.endTime)
        );
        if (ohBusy) continue;
        ops.push({
          type:       'reassign-instructor',
          sectionId:  sectionA.id, newInstructorId: instr.id,
          priority:   SCORE.OP_REASSIGN,
          label:      `Reassign ${sectionA.courseCode} §${sectionA.sectionNumber} to ${instr.name}`,
        });
        if (ops.length >= 4) break;
      }
    }

    // 2) Reassign-venue — same shape.
    if (sectionA.venueId) {
      const desiredType = sectionA.sectionType === 'Lab' ? 'Laboratory' : 'LectureHall';
      for (const v of venues) {
        if (v.id === sectionA.venueId) continue;
        if (v.type !== desiredType) continue;
        const busy = sections.some(s =>
          s.id !== sectionA.id && s.venueId === v.id &&
          s.day === sectionA.day &&
          Section.toMinutes(s.startTime) < endMin &&
          startMin < Section.toMinutes(s.endTime)
        );
        if (busy) continue;
        ops.push({
          type:       'reassign-venue',
          sectionId:  sectionA.id, newVenueId: v.id,
          priority:   SCORE.OP_REASSIGN,
          label:      `Reassign ${sectionA.courseCode} §${sectionA.sectionNumber} venue to ${v.name}`,
        });
        if (ops.length >= 6) break;
      }
    }

    // 3) Move to a free slot — uses the same R-02-style filter so we
    //    don't emit candidates that still overlap sectionB.
    const candidates = moveCandidatesFor(sectionA, sections);
    const sectionB = conflict.sectionBId ? sections.find(s => s.id === conflict.sectionBId) : null;
    const sectionBKey = sectionB ? `${sectionB.courseId}|${sectionB.sectionNumber}` : null;
    const sectionBRows = sectionBKey
      ? sections.filter(s => `${s.courseId}|${s.sectionNumber}` === sectionBKey)
      : [];
    const groupRows = sections.filter(s =>
      s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber);
    const groupDays = new Set(groupRows.map(s => s.day));
    const filtered = sectionBRows.length
      ? candidates.filter(cand => {
          const ns = Section.toMinutes(cand.newStartTime);
          const ne = Section.toMinutes(cand.newEndTime);
          return !sectionBRows.some(b =>
            groupDays.has(b.day) &&
            Section.toMinutes(b.startTime) < ne &&
            ns < Section.toMinutes(b.endTime)
          );
        })
      : candidates;
    for (const cand of filtered.slice(0, 3)) {
      ops.push({
        type:         'move',
        sectionId:    sectionA.id,
        newStartTime: cand.newStartTime, newEndTime: cand.newEndTime,
        priority:     SCORE.OP_MOVE,
        label:        `Move ${sectionA.courseCode} §${sectionA.sectionNumber} to ${cand.newStartTime}–${cand.newEndTime}`,
      });
    }
  }

  // NEW-FU-377 (Phase 36): R-06 → academic-level / time-window violation.
  // UG sections placed in the 17:00+ Graduate band, or GR sections
  // placed in the 08:00-16:00 UG band. The fix: move the section into
  // its category's allowed window. moveCandidatesFor already respects
  // category — we just need to filter candidates that aren't still in
  // the violating band.
  if (conflict.ruleId === 'R-06') {
    const candidates = moveCandidatesFor(sectionA, sections);
    for (const cand of candidates.slice(0, 5)) {
      ops.push({
        type:         'move',
        sectionId:    sectionA.id,
        newStartTime: cand.newStartTime, newEndTime: cand.newEndTime,
        priority:     SCORE.OP_MOVE,
        label:        `Move ${sectionA.courseCode} §${sectionA.sectionNumber} to ${cand.newStartTime}–${cand.newEndTime} (in-window)`,
      });
    }
  }

  // NEW-FU-378 (Phase 36): R-13 → instructor has no office hours. Fix:
  // reassign the section group to an instructor who DOES have OH and
  // is free at this slot across all the group's meeting days.
  if (conflict.ruleId === 'R-13' && sectionA) {
    const startMin = Section.toMinutes(sectionA.startTime);
    const endMin   = Section.toMinutes(sectionA.endTime);
    const simpleR13Before = ops.length;
    // NEW-FU-460 (Phase 109): the PREFERRED R-13 fix is to give the REAL instructor
    // office hours (keep them teaching) — not reassign or swap in a placeholder.
    // Pushed before the dummy-fallback check below, so the placeholder path is no
    // longer reached for a real instructor.
    if (sectionA.instructorId) {
      const busy = sections.filter(s => s.instructorId === sectionA.instructorId)
        .map(s => ({ day: s.day, start: s.startTime, end: s.endTime }));
      const oh = pickDummyOfficeHours(busy);
      ops.push({
        type:         'assign-office-hours',
        instructorId: sectionA.instructorId,
        officeHours:  oh,
        priority:     SCORE.OP_REASSIGN,
        label:        `Add office hours for ${sectionA.instructorName ?? 'this instructor'} (${oh.day} ${oh.startTime.slice(0,5)}–${oh.endTime.slice(0,5)})`,
      });
    }
    const groupRows = sections.filter(s =>
      s.courseId === sectionA.courseId && s.sectionNumber === sectionA.sectionNumber);
    // Filter to instructors WITH at least one OH entry.
    const ranked = [...instructors]
      .filter(i => i.id !== sectionA.instructorId)
      .filter(i => (ohMap.get(i.id) ?? []).length > 0);
    for (const instr of ranked) {
      const busy = groupRows.some(row => sections.some(s =>
        s.id !== row.id && s.instructorId === instr.id &&
        s.day === row.day &&
        Section.toMinutes(s.startTime) < endMin &&
        startMin < Section.toMinutes(s.endTime)
      ));
      if (busy) continue;
      const oh = ohMap.get(instr.id) ?? [];
      const ohBusy = groupRows.some(row => oh.some(o =>
        o.day === row.day &&
        Section.toMinutes(o.startTime) < endMin &&
        startMin < Section.toMinutes(o.endTime)
      ));
      if (ohBusy) continue;
      ops.push({
        type:       'reassign-instructor',
        sectionId:  sectionA.id, newInstructorId: instr.id,
        priority:   SCORE.OP_REASSIGN,
        label:      `Reassign ${sectionA.courseCode} §${sectionA.sectionNumber} to ${instr.name} (has OH)`,
      });
      if (ops.length >= 3) break;
    }
    // NEW-FU-443 (Phase 107 M6): if no real OH-equipped instructor is free, offer a
    // placeholder instructor (parity with R-09/R-04) — a placeholder carries valid OH,
    // so it resolves R-13 cleanly instead of degrading to a destructive DROP.
    if (ops.length === simpleR13Before) ops.push(dummyInstrOp(sectionA));
  }

  // NEW-FU-395 (Phase 38): R-14 → course has has_lab=true but missing
  // the Lec or the Lab half. Quick Fix cannot fabricate a new section
  // (time / instructor / venue are policy decisions the user must own),
  // so the ONLY non-fabricating resolution is to DROP the orphan
  // section. We emit it as a `lastResort: true` drop op — the resolver
  // gate accepts it because no other op type can resolve R-14, and the
  // UI keeps it unchecked by default (per the existing "Drops are
  // unchecked by default — they're the last resort" pattern in the
  // QuickFixModal).
  //
  // This honors the Phase 37 rule "drop is never silently auto-picked"
  // — the user must explicitly opt in — while giving them a one-click
  // resolution path that didn't exist before.
  if (conflict.ruleId === 'R-14') {
    // NEW-FU-272 (Phase 50 #3): untag-has-lab alternative. When the
    // course is configured has_lab=true but the registrar / user only
    // scheduled Lec sections (e.g., SWE 412 PRJ courses where the project
    // IS the lab), the cleanest resolution is to flip has_lab on the
    // course instead of dropping the section. Always offered for R-14;
    // the user can opt out in the modal if they really want the drop.
    // NEW-FU-562 (audit-2 P2-2): never offer "lectures only" for a 4-credit course — the
    // 4-credit⇒has-lab invariant would then brick it (no section could be created/validated).
    if (Number(sectionA.credits) !== 4) {
      ops.push({
        type:      'untag-has-lab',
        courseId:  sectionA.courseId,
        priority:  SCORE.OP_FLAG_FLIP,
        label:     `Change ${sectionA.courseCode} to lectures only (remove its lab requirement — fixes this without removing the section)`,
      });
    }
    ops.push({
      type:       'drop',
      sectionId:  sectionA.id,
      priority:   SCORE.OP_DROP,
      label:      `Remove ${sectionA.courseCode} §${sectionA.sectionNumber} (deletes this leftover ${sectionA.sectionType === 'Lec' ? 'lecture' : 'lab'} section)`,
      lastResort: true,
    });
  }

  // NEW-FU-272 (Phase 50 #1+#3): two metadata-flip alternatives for
  // venue-related soft rules. Always offered as low-priority candidates
  // so the greedy can fall back to them when no in-schedule reassign /
  // move resolves the conflict.
  //
  // mark-venue-exempt: applies to R-05 / R-10 / R-11 / R-12 by tagging
  //   the course (capstone semantics — venue is irrelevant).
  // reclassify-venue:  applies to R-11 / R-12 when the venue is genuinely
  //   dual-use — flip to 'Multipurpose' so both Lec and Lab sections fit.
  //
  // NEW-FU-492 (Phase 119 item 2): gate mark-venue-exempt to ONLY truly
  // exempt courses (is_capstone or is_external). Regular lecture courses
  // genuinely need a room; the greedy could previously pick this op when
  // it resolves 2+ venue conflicts at once (2×RESOLVE_SOFT−FLAG_FLIP >
  // 1×RESOLVE_SOFT−DUMMY), silently setting is_capstone=TRUE on a
  // normal course and hiding a real venue shortage. Capstone/external
  // courses are by definition room-independent, so the flip is correct
  // for them. For all other courses, dummyVenueOp is already always
  // emitted by the R-05/R-10/R-11/R-12 handlers above — the greedy
  // picks that when no real venue is free.
  if (['R-05', 'R-10', 'R-11', 'R-12'].includes(conflict.ruleId)
      && sectionA.courseId
      && (sectionA.isCapstone || sectionA.isExternal)) {
    ops.push({
      type:      'mark-venue-exempt',
      courseId:  sectionA.courseId,
      priority:  SCORE.OP_FLAG_FLIP,
      label:     `Mark ${sectionA.courseCode} as not needing a fixed room (capstone/external — can meet anywhere)`,
    });
  }
  if (['R-11', 'R-12'].includes(conflict.ruleId) && sectionA.venueId && sectionA.venueType) {
    // Only suggest reclassify when the venue is genuinely dual-use —
    // i.e., the schedule contains BOTH Lec and Lab sections in this
    // venue. Otherwise reclassifying would hide a real mismatch.
    const inVenue = sections.filter(s => s.venueId === sectionA.venueId);
    const hasLec = inVenue.some(s => s.sectionType === 'Lec');
    const hasLab = inVenue.some(s => s.sectionType === 'Lab');
    if (hasLec && hasLab && sectionA.venueType !== 'Multipurpose') {
      ops.push({
        type:      'reclassify-venue',
        venueId:   sectionA.venueId,
        newType:   'Multipurpose',
        priority:  SCORE.OP_FLAG_FLIP,
        label:     `Reclassify ${sectionA.venueName ?? sectionA.venueId} as Multipurpose (room is used for both Lec and Lab in this schedule)`,
      });
    }
  }

  return ops;
}

// NEW-FU-386 (Phase 37): diagnose a specific unresolved conflict with
// concrete data — course code, instructor name, venue name, time slot,
// meeting days. The Phase 36 static reason table said things like "no
// venue of the required type is free at this slot" without naming the
// venue type, the slot, or the section. Phase 37 demands the user can
// look at the message and immediately know WHICH conflict and WHY.
function diagnoseUnresolved(conflict, sections, instructors, venues, ohMap) {
  const sec = conflict.sectionAId
    ? sections.find(s => s.id === conflict.sectionAId)
    : null;
  const label = sec
    ? `${sec.courseCode} §${sec.sectionNumber} (${sec.day} ${(sec.startTime ?? '').substring(0,5)}–${(sec.endTime ?? '').substring(0,5)})`
    : 'this section';

  const startMin = sec ? Section.toMinutes(sec.startTime) : 0;
  const endMin   = sec ? Section.toMinutes(sec.endTime)   : 0;
  const groupKey = sec ? `${sec.courseId}|${sec.sectionNumber}` : '';
  const groupDays = sec
    ? new Set(sections.filter(s => `${s.courseId}|${s.sectionNumber}` === groupKey).map(s => s.day))
    : new Set();

  // Count free instructors at the section's time slot across all
  // meeting days. Pre-Phase-37 this was hidden in a static string.
  function freeInstructorCount(filter) {
    if (!sec) return 0;
    return instructors.filter(filter).filter(i => {
      for (const day of groupDays) {
        const busy = sections.some(s =>
          s.id !== sec.id && s.instructorId === i.id && s.day === day &&
          Section.toMinutes(s.startTime) < endMin &&
          startMin < Section.toMinutes(s.endTime)
        );
        if (busy) return false;
        const oh = ohMap.get(i.id) ?? [];
        const ohBusy = oh.some(o =>
          o.day === day &&
          Section.toMinutes(o.startTime) < endMin &&
          startMin < Section.toMinutes(o.endTime)
        );
        if (ohBusy) return false;
      }
      return true;
    }).length;
  }

  function freeVenueCount(filter) {
    if (!sec) return 0;
    return venues.filter(filter).filter(v => {
      for (const day of groupDays) {
        const busy = sections.some(s =>
          s.id !== sec.id && s.venueId === v.id && s.day === day &&
          Section.toMinutes(s.startTime) < endMin &&
          startMin < Section.toMinutes(s.endTime)
        );
        if (busy) return false;
      }
      return true;
    }).length;
  }

  const allInstr = instructors.length;
  const allVenues = venues.length;
  const days = [...groupDays].join('/');

  // NEW-FU-396 (Phase 39): every rule's reason now ends with a pointer
  // to the universal last-resort drop opt-in, since the appendix loop
  // emits one for every unresolved conflict. R-14 already has its own
  // two-path narrative and so opts out of this generic suffix.
  const dropSuffix = (sec && conflict.ruleId !== 'R-14')
    ? ` Last resort: use the remove option below to take ${sec.courseCode} §${sec.sectionNumber} out entirely (it won't be offered on these days).`
    : '';

  switch (conflict.ruleId) {
    case 'R-01': {
      return `R-01 (hard, same-level): ${label} overlaps another same-level course's sections with no escape combination. Consider moving one section to a different time, reducing section count, or splitting the courses across non-overlapping day patterns.${dropSuffix}`;
    }
    case 'R-02': {
      const free = freeInstructorCount(i => i.id !== sec?.instructorId);
      return `R-02 (soft, single-section adjacent-level overlap): ${label} cannot be moved to a non-overlapping slot — ${free} alternative instructor(s) are free in the section's window. Consider expanding the day pattern or accepting the soft overlap.${dropSuffix}`;
    }
    case 'R-04': {
      const free = freeInstructorCount(i => i.id !== sec?.instructorId);
      const total = allInstr - 1;
      return `R-04 (hard, instructor double-book): ${label} — ${free} of ${total} alternative instructor(s) are free across ${days} at ${(sec?.startTime ?? '').substring(0,5)}. ${free === 0 ? 'All instructors are busy or have office-hour collisions.' : 'But none cleared the strict-monotone gate during planning.'}${dropSuffix}`;
    }
    case 'R-05': {
      const desiredType = sec?.sectionType === 'Lab' ? 'Laboratory' : 'LectureHall';
      const free = freeVenueCount(v => v.type === desiredType && v.id !== sec?.venueId);
      const totalOfType = venues.filter(v => v.type === desiredType).length - 1;
      return `R-05 (hard, venue double-book): ${label} — ${free} of ${totalOfType} alternative ${desiredType}(s) are free across ${days} at ${(sec?.startTime ?? '').substring(0,5)}.${dropSuffix}`;
    }
    case 'R-06': {
      const cat = sec?.category;
      // NEW-FU-495 (Phase 120): UG 07:00–17:10, GR 17:20–22:00.
      const window = cat === 'GR' ? '17:20–22:00' : '07:00–17:10';
      return `R-06 (hard, time-window violation): ${label} is ${cat || '?'} but scheduled outside its allowed window (${window}). Move the section to within the window.${dropSuffix}`;
    }
    case 'R-09': {
      const free = freeInstructorCount(() => true);
      return `R-09 (soft, no instructor): ${label} has no instructor assigned — ${free} instructor(s) free across ${days} at ${(sec?.startTime ?? '').substring(0,5)}. Pick one via the section editor or expand the candidate pool.${dropSuffix}`;
    }
    case 'R-10': {
      const desiredType = sec?.sectionType === 'Lab' ? 'Laboratory' : 'LectureHall';
      const free = freeVenueCount(v => v.type === desiredType);
      const totalOfType = venues.filter(v => v.type === desiredType).length;
      return `R-10 (soft, no venue): ${label} has no venue assigned — ${free} of ${totalOfType} ${desiredType}(s) free across ${days} at ${(sec?.startTime ?? '').substring(0,5)}.${dropSuffix}`;
    }
    case 'R-11': {
      const free = freeVenueCount(v => v.type === 'Laboratory');
      const total = venues.filter(v => v.type === 'Laboratory').length;
      return `R-11 (soft, lab in non-lab venue): ${label} is a Lab section in venue "${sec?.venueName || '?'}" (${sec?.venueType || '?'}). ${free} of ${total} Laboratory venue(s) are free across ${days} at ${(sec?.startTime ?? '').substring(0,5)}.${dropSuffix}`;
    }
    case 'R-12': {
      const free = freeVenueCount(v => v.type === 'LectureHall');
      const total = venues.filter(v => v.type === 'LectureHall').length;
      return `R-12 (soft, lec in lab venue): ${label} is a Lec section in venue "${sec?.venueName || '?'}" (${sec?.venueType || '?'}). ${free} of ${total} LectureHall venue(s) are free across ${days} at ${(sec?.startTime ?? '').substring(0,5)}.${dropSuffix}`;
    }
    case 'R-13': {
      const withOH = instructors.filter(i => (ohMap.get(i.id) ?? []).length > 0).length;
      return `${sec?.instructorName || 'This instructor'} (teaching ${label}) has no office hours set. Either add office hours for them, or assign the section to a different instructor.${dropSuffix}`;
    }
    case 'R-14': {
      const missing = conflict.missingType
        || (sec?.sectionType === 'Lec' ? 'Lab' : 'Lec');
      return `Course "${sec?.courseCode || '?'}" is set up to have both lectures and labs, but has no ${missing === 'Lec' ? 'lecture' : 'lab'} section in this schedule. Two ways to fix it: (1) add the missing section with "+ Add Section" (recommended — you choose the time, instructor, and room), or (2) remove the leftover ${sec?.sectionType === 'Lec' ? 'lecture' : 'lab'} section (this takes the course out of the schedule).`;
    }
    case 'R-15': {
      return `R-15 (soft, insufficient credit coverage): ${label}'s surviving meeting days × duration don't cover the credit hours. Consider extending the day pattern (add a day) or moving to a longer-duration slot.${dropSuffix}`;
    }
    default:
      return `${conflict.ruleId}: no auto-fix available at the current schedule state. ${conflict.description ?? ''}${dropSuffix}`.trim();
  }
}

// Apply an op to an in-memory sections clone. Returns the new array.
//
// NEW-FU-318: reassign ops MUST update the ENTIRE section group (all
// sibling rows sharing courseId + sectionNumber), not just the one row
// whose id matches op.sectionId. The DB-level updateSectionInfo path
// in ScheduleService.js does the same — when an instructor is changed,
// every meeting day of the section gets the new instructor.
// Without group-wide propagation, the simulation thought reassigning
// one row resolved the conflict, but the sibling rows still had the
// old instructor → conflict persisted → score stayed flat → no progress.
// NEW-FU-348 (Phase 33): the venue cache lets applyOpInMemory keep
// venueType in sync when we change venueId. The original Phase 29
// reassign-venue only set venueId — so the simulator's R-11/R-12 check
// (which looks at venueType) thought the conflict still fired even
// after the reassign. That gave score=0 for resolving R-12, the
// strict-monotone gate rejected, and R-12 stayed unresolved forever.
let _venueCache = null;
function setVenueCache(venues) {
  _venueCache = new Map(venues.map(v => [v.id, v]));
}

function applyOpInMemory(sections, op) {
  if (op.type === 'reassign-instructor' || op.type === 'reassign-venue') {
    const target = sections.find(s => s.id === op.sectionId);
    if (!target) return sections;
    const groupKey = (s) =>
      s.courseId === target.courseId && s.sectionNumber === target.sectionNumber;
    if (op.type === 'reassign-instructor') {
      return sections.map(s => groupKey(s)
        ? { ...s, instructorId: op.newInstructorId }
        : s
      );
    }
    // reassign-venue: also update venueType from the venue cache so
    // R-11/R-12 evaluations in the simulator see the new type.
    const newVenue = _venueCache?.get(op.newVenueId);
    return sections.map(s => groupKey(s)
      ? { ...s, venueId: op.newVenueId, venueType: newVenue?.type ?? s.venueType }
      : s
    );
  }
  if (op.type === 'assign-office-hours') {
    // NEW-FU-460 (Phase 109): simulate giving the real instructor office hours by
    // tagging their sections so the in-memory R-13 check treats them as having OH.
    // Returns a NEW array, so trialing this op never pollutes other candidate trials.
    return sections.map(s => s.instructorId === op.instructorId ? { ...s, _ohAssigned: true } : s);
  }
  if (op.type === 'drop') {
    // Drop the WHOLE section group (all rows sharing courseId +
    // sectionNumber). Matches Phase 27's deleteSection semantics.
    const target = sections.find(s => s.id === op.sectionId);
    if (!target) return sections;
    return sections.filter(s =>
      !(s.courseId === target.courseId && s.sectionNumber === target.sectionNumber));
  }
  if (op.type === 'add-day') {
    // NEW-FU-325 (Phase 30): extend a section group by appending new
    // meeting rows. Same metadata as the surviving rows except `day`.
    // Mirrors ScheduleService.extendSection's semantics. The simulator
    // assigns synthetic IDs so subsequent ops can reference these rows
    // by id — real INSERT happens in apply() below, returning real IDs.
    const target = sections.find(s => s.id === op.sectionId);
    if (!target) return sections;
    let synthIdCounter = 0;
    const newRows = (op.addDays ?? []).map(day => ({
      ...target,
      id:  `synthetic-${op.sectionId}-${day}-${synthIdCounter++}`,
      day,
    }));
    return [...sections, ...newRows];
  }
  if (op.type === 'move') {
    // NEW-FU-333 (Phase 31): shift the section group's startTime/endTime.
    // Like reassign, the move updates the WHOLE section group (all rows
    // sharing courseId + sectionNumber) so the new time applies to every
    // meeting day. The R-02 generator and the compound move+reassign
    // generators (R-10/R-11/R-12 in saturated schedules) both rely on
    // this op as their atomic primitive.
    const target = sections.find(s => s.id === op.sectionId);
    if (!target) return sections;
    const groupKey = (s) =>
      s.courseId === target.courseId && s.sectionNumber === target.sectionNumber;
    return sections.map(s => groupKey(s)
      ? { ...s, startTime: op.newStartTime, endTime: op.newEndTime }
      : s
    );
  }
  if (op.type === 'compound') {
    // NEW-FU-348 (Phase 33): fold each subOp through applyOpInMemory.
    // Used when no single op resolves a conflict — e.g., R-11 in a
    // saturated schedule needs a move PLUS a reassign-venue. The
    // simulator sees the final state; the greedy scores against that.
    let acc = sections;
    for (const sub of (op.subOps ?? [])) {
      acc = applyOpInMemory(acc, sub);
    }
    return acc;
  }
  // NEW-FU-272 (Phase 50): three new ops that mutate course/venue metadata
  // rather than individual section rows. The simulator updates ALL sections
  // referencing the same course/venue so the rule re-evaluation sees the
  // post-change state.
  if (op.type === 'mark-venue-exempt') {
    // Flip courses.is_capstone = true. Every section of the course
    // becomes isCapstone → R-05/R-10/R-11/R-12 stop firing for them.
    return sections.map(s =>
      s.courseId === op.courseId ? { ...s, isCapstone: true } : s
    );
  }
  if (op.type === 'reclassify-venue') {
    // Flip venues.type. Every section using this venue picks up the new
    // type so R-11 / R-12 re-evaluation sees the change.
    return sections.map(s =>
      s.venueId === op.venueId ? { ...s, venueType: op.newType } : s
    );
  }
  if (op.type === 'untag-has-lab') {
    // Flip courses.has_lab = false. R-14 stops firing for the course.
    return sections.map(s =>
      s.courseId === op.courseId ? { ...s, hasLab: false } : s
    );
  }
  // NEW-FU-426 (Phase 105): assign a synthetic placeholder instructor/venue to
  // the WHOLE section group. The `__dummy` id keeps R-13 quiet and the
  // venueType lets R-11/R-12 see the right type; apply() turns these into real
  // is_dummy rows tagged with the owning term.
  if (op.type === 'add-dummy-instructor') {
    const target = sections.find(s => s.id === op.sectionId);
    if (!target) return sections;
    const groupKey = (s) =>
      s.courseId === target.courseId && s.sectionNumber === target.sectionNumber;
    return sections.map(s => groupKey(s)
      ? { ...s, instructorId: op.dummyId, instructorName: op.dummyName }
      : s
    );
  }
  if (op.type === 'add-dummy-venue') {
    const target = sections.find(s => s.id === op.sectionId);
    if (!target) return sections;
    const groupKey = (s) =>
      s.courseId === target.courseId && s.sectionNumber === target.sectionNumber;
    return sections.map(s => groupKey(s)
      ? { ...s, venueId: op.dummyId, venueName: op.dummyName, venueType: op.venueType }
      : s
    );
  }
  return sections;
}

class QuickFixService {

  /**
   * Plan: load schedule state, iterate conflicts, greedily pick the
   * best op per conflict, return the plan. NO DB writes.
   */
  async plan(scheduleId) {
    // Load sections (full Section join needed for the engine)
    const secRes = await query(`
      SELECT
        s.id, s.schedule_id, s.course_id, s.instructor_id, s.venue_id,
        s.section_number, s.day, s.start_time::text, s.end_time::text,
        s.section_type, s.gender,
        c.course_code, c.name AS course_name, c.academic_level, c.category,
        c.num_sections, c.has_lab, c.credits, c.is_capstone, c.is_external,
        i.name AS instructor_name, i.is_dummy AS instructor_is_dummy,
        v.name AS venue_name, v.type AS venue_type
      FROM sections s
      JOIN courses c ON c.id = s.course_id
      LEFT JOIN instructors i ON i.id = s.instructor_id
      LEFT JOIN venues v ON v.id = s.venue_id
      WHERE s.schedule_id = $1
    `, [scheduleId]);

    let sections = secRes.rows.map(row => ({
      id:             row.id,
      scheduleId:     row.schedule_id,
      courseId:       row.course_id,
      instructorId:   row.instructor_id,
      venueId:        row.venue_id,
      sectionNumber:  row.section_number,
      day:            row.day,
      startTime:      row.start_time,
      endTime:        row.end_time,
      sectionType:    row.section_type,
      gender:         row.gender, // NEW-FU-435 (Phase 107 H1): needed for the R-04/R-05 M/F paired-section exemption
      courseCode:     row.course_code,
      courseName:     row.course_name,
      academicLevel:  row.academic_level,
      category:       row.category,
      numSections:    row.num_sections,
      hasLab:         row.has_lab,
      credits:        row.credits,
      isCapstone:    row.is_capstone,
      isExternal:    row.is_external,
      instructorName: row.instructor_name,
      instructorIsDummy: row.instructor_is_dummy === true,
      venueName:      row.venue_name,
      venueType:      row.venue_type,
    }));

    // NEW-FU-520 (Batch 6): TERM-SCOPE the candidate pool. Sourcing fixes from
    // the GLOBAL resource list let Quick Fix assign a venue/instructor owned by a
    // DIFFERENT term into this one (the reported `01-0001` contamination: a 271
    // venue assigned to 261 sections). findAll(termCode) returns only resources
    // owned by this term or already assigned in it, so a fix can never reach
    // across terms. Falls back to global only when the schedule has no term code.
    const termRes  = await query('SELECT semester FROM schedules WHERE id = $1', [scheduleId]);
    const termCode = termRes.rows[0]?.semester ?? null;
    const instructors = await instrRepo.findAssignable(termCode);
    const venues      = await venueRepo.findAssignable(termCode);
    // NEW-FU-348 (Phase 33): seed the venue cache so applyOpInMemory
    // can update venueType in addition to venueId during simulated
    // reassigns. Without this, the simulator under-reports R-11/R-12
    // resolution and the greedy never accepts a fix.
    setVenueCache(venues);

    // OH map for the engine
    const instrIds = [...new Set(sections.map(s => s.instructorId).filter(Boolean))];
    const ohMap = new Map();
    if (instrIds.length) {
      const ohRes = await query(`
        SELECT instructor_id, day, start_time::text AS start_time, end_time::text AS end_time
        FROM office_hours WHERE instructor_id = ANY($1)
      `, [instrIds]);
      for (const row of ohRes.rows) {
        if (!ohMap.has(row.instructor_id)) ohMap.set(row.instructor_id, []);
        ohMap.get(row.instructor_id).push({
          day: row.day, startTime: row.start_time, endTime: row.end_time,
        });
      }
    }

    let conflicts = evaluateInMemory(sections, ohMap);
    const initialCount = countConflicts(conflicts);

    const ops = [];
    let opId = 0;

    // NEW-FU-548 (Batch 15 Issue 4): TIERED escalation so destructive/placeholder ops
    // are TRUE last resorts. Tier 0 resolves everything it can using ONLY real
    // move/reassign/add-day ops (no dummies); only when that's exhausted does Tier 1
    // permit placeholder (dummy) instructors/venues. Last-resort DROPS are emitted
    // after BOTH tiers (below). This guarantees the resolver never mints a dummy — or
    // drops a course — while a real reschedule/reassign would have worked, and keeps
    // the count of dummies/drops to the minimum the schedule actually forces.
    for (const allowDummy of [false, true]) {
      let progressMade = true;
      while (ops.length < MAX_OPS && progressMade) {
      progressMade = false;
      // Process hard conflicts first, then soft.
      const sorted = [...conflicts].sort((a, b) =>
        (a.severity === 'Hard' ? 0 : 1) - (b.severity === 'Hard' ? 0 : 1)
      );
      for (const conflict of sorted) {
        const allCands = candidateOps(conflict, sections, instructors, venues, ohMap);
        // NEW-FU-395 (Phase 38): exclude lastResort drops from the
        // greedy's optimization loop — they're presented as opt-in
        // bonus ops in the UI (default unchecked). Including them in
        // simulation would cause summary.remaining* to assume drops
        // are applied, breaking the simulator/runtime parity contract
        // when the user leaves the drop checkbox off.
        // NEW-FU-548 (Batch 15 Issue 4): in Tier 0, also hold back dummy ops so real
        // reschedules/reassigns are exhausted before any placeholder is considered.
        const cands = allCands.filter(op => !op.lastResort && (allowDummy || !op.dummy));
        if (cands.length === 0) continue;

        // Simulate each candidate; pick the one with the best score.
        let bestOp     = null;
        let bestScore  = -Infinity;
        let bestPostConflicts = null;
        for (const op of cands) {
          const simSections = applyOpInMemory(sections, op);
          const postConflicts = evaluateInMemory(simSections, ohMap);
          const pre  = countConflicts(conflicts);
          const post = countConflicts(postConflicts);
          // Score: progress + op cost. Only positive when conflicts
          // actually go down on net.
          const score =
              (pre.hard - post.hard) * SCORE.RESOLVE_HARD
            + (pre.soft - post.soft) * SCORE.RESOLVE_SOFT
            + Math.max(0, post.hard - pre.hard) * SCORE.CREATE_HARD
            + Math.max(0, post.soft - pre.soft) * SCORE.CREATE_SOFT
            + op.priority;
          if (score > bestScore) {
            bestScore = score;
            bestOp = op;
            bestPostConflicts = postConflicts;
          }
        }

        // NEW-FU-380 (Phase 36): WEIGHTED-monotone gate. The previous
        // strict-monotone gate (hard*2 + soft strictly decreasing)
        // rejected ops that trade one HIGH-weight conflict for one
        // LOW-weight conflict — e.g., swapping an R-02 (weight 50) for
        // an R-13 (weight 5) registers as 0 change in count but a 45
        // drop in weighted cost. The weighted gate accepts such trades.
        if (bestOp && bestPostConflicts) {
          const beforeWeighted = weightedCost(conflicts);
          const afterWeighted  = weightedCost(bestPostConflicts);
          const preCount       = countConflicts(conflicts);
          const postCount      = countConflicts(bestPostConflicts);
          // Accept if EITHER: weighted cost drops, OR strict-count drops
          // (the latter as a fallback for rules without weights).
          const accepted =
            afterWeighted < beforeWeighted ||
            (postCount.hard * 2 + postCount.soft) < (preCount.hard * 2 + preCount.soft);
          if (accepted) {
            ops.push({
              id: `op-${++opId}`,
              ...bestOp,
              resolves: [conflict.ruleId],
              willResolveCount: { hard: preCount.hard - postCount.hard, soft: preCount.soft - postCount.soft },
              weightedDelta: afterWeighted - beforeWeighted,
            });
            sections  = applyOpInMemory(sections, bestOp);
            conflicts = bestPostConflicts;
            progressMade = true;
            break; // restart the loop with fresh conflict ordering
          }
        }
      }
      } // end while (this tier)
    }   // end for (allowDummy tier)

    const final = countConflicts(conflicts);
    // NEW-FU-327 (Phase 30): expose the rule IDs of conflicts that
    // remain unresolved + had no candidate ops. The modal uses this to
    // render a more informative empty-state ("Conflicts present: R-13,
    // R-14 — these rules have no auto-fix yet") instead of the generic
    // "no automatic fixes available" message that previously left the
    // user guessing whether Quick Fix was broken or just inapplicable.
    // NEW-FU-396 (Phase 39): generalize Phase 38's R-14-only lastResort
    // drop to ANY remaining unresolved conflict. The principle the user
    // articulated: "drop is the only honest resolution when no non-
    // destructive path exists." For R-14 this means dropping the
    // orphan Lec/Lab. For R-04/R-05/R-10/R-11/R-12/R-13/R-15 in
    // saturated schedules, this means dropping the section that the
    // resolver couldn't move/reassign.
    //
    // Two emission paths:
    //   (a) candidateOps emitted a `lastResort: true` drop itself
    //       (R-14 — uses the section-specific label crafted there)
    //   (b) candidateOps emitted no non-drop alternative — synthesize
    //       a generic last-resort drop tagged with the failing ruleId
    //
    // Either way the drop is appended AFTER summary.remaining* is
    // computed so summary reflects the no-drop world. The UI keeps
    // these unchecked by default; the user explicitly opts in.
    const droppedSectionIds = new Set();
    for (const c of conflicts) {
      const sec = sections.find(s => s.id === c.sectionAId);
      if (!sec) continue;
      // Dedup: multiple conflicts on the same section share ONE drop.
      if (droppedSectionIds.has(sec.id)) continue;
      // Also dedup against any drop already in ops[] (e.g. compound
      // sub-ops or future generators).
      if (ops.some(o => o.type === 'drop' && o.sectionId === sec.id)) {
        droppedSectionIds.add(sec.id);
        continue;
      }
      // Prefer the rule-specific lastResort drop (with its tailored
      // label) when candidateOps emitted one; otherwise synthesize.
      const cands = candidateOps(c, sections, instructors, venues, ohMap);
      let dropOp = cands.find(op => op.lastResort === true);
      if (!dropOp) {
        // NEW-FU-512 (Batch 5 Issue 2): synthesize a last-resort drop for EVERY
        // residual conflict — HARD *and* SOFT. The owner directive is explicit:
        // Quick Fix "must always drive the schedule to 0 hard + 0 soft conflicts …
        // only as a last resort, drop/delete — until no conflicts remain. It must
        // never finish while conflicts still exist." This overrides FU-444's
        // Phase-107 hard-only stance (which left a saturated soft conflict — one
        // the greedy can't move/reassign away — with no path to zero at all).
        //
        // The drop stays opt-in: lastResort:true, default-unchecked in the UI, and
        // appended AFTER summary.remaining* is computed (so summary still reflects
        // the no-drop world). Non-destructive ops are always tried first by the
        // greedy above; this only fires when nothing else can clear the conflict.
        // The label flags soft drops so the user knows it's optional over a
        // scheduling *preference*, not a hard requirement.
        const overPref = c.severity !== 'Hard'
          ? ' — optional: clears a soft scheduling preference'
          : ' — nothing else could fix this automatically';
        dropOp = {
          type:       'drop',
          sectionId:  sec.id,
          priority:   SCORE.OP_DROP,
          label:      `Remove ${sec.courseCode} §${sec.sectionNumber} (last resort${overPref})`,
          lastResort: true,
        };
      }
      droppedSectionIds.add(sec.id);
      ops.push({
        id: `op-${++opId}`,
        ...dropOp,
        resolves: [c.ruleId],
        willResolveCount: { hard: c.severity === 'Hard' ? 1 : 0, soft: c.severity === 'Soft' ? 1 : 0 },
      });
    }

    const unresolvedRuleIds = Array.from(new Set(
      conflicts.map(c => c.ruleId).filter(Boolean)
    )).sort();
    // NEW-FU-386 (Phase 37): dynamic unresolvedReasons. The Phase 36
    // implementation pulled from a static UNRESOLVED_REASONS table —
    // each message described the rule class generically ("no venue
    // free at this slot") with no reference to the specific course,
    // instructor, venue, or time slot the user was looking at. This
    // version diagnoses every unresolved conflict using the current
    // sections / instructors / venues / ohMap so the message
    // references concrete data the user can act on.
    const unresolvedReasons = {};
    for (const c of conflicts) {
      if (unresolvedReasons[c.ruleId]) continue;   // first reason per rule
      unresolvedReasons[c.ruleId] = diagnoseUnresolved(
        c, sections, instructors, venues, ohMap,
      );
    }
    return {
      ops,
      summary: {
        initialHard:    initialCount.hard,
        initialSoft:    initialCount.soft,
        remainingHard:  final.hard,
        remainingSoft:  final.soft,
        resolvedHard:   initialCount.hard - final.hard,
        resolvedSoft:   initialCount.soft - final.soft,
      },
      unresolvedRuleIds,
      unresolvedReasons,
      // List the op types this resolver knows how to generate. The
      // modal pairs this with `unresolvedRuleIds` to explain why a
      // particular conflict wasn't auto-fixable.
      supportedOpTypes: [
        'reassign-instructor', 'reassign-venue', 'add-day', 'move', 'drop', 'compound',
        // NEW-FU-272 (Phase 50)
        'mark-venue-exempt', 'reclassify-venue', 'untag-has-lab',
        // NEW-FU-426 (Phase 105): placeholder-resource tier (parity with Suggest)
        'add-dummy-instructor', 'add-dummy-venue',
        // NEW-FU-460 (Phase 109): give a real OH-less instructor office hours
        'assign-office-hours',
      ],
    };
  }

  /**
   * Apply a list of op IDs from a previously-generated plan. Runs
   * atomically: a single transaction, all-or-nothing. If any op fails
   * mid-apply (e.g., pattern validator rejects a reassign), the whole
   * batch rolls back.
   */
  async apply(scheduleId, opsToApply) {
    if (!Array.isArray(opsToApply) || opsToApply.length === 0) {
      return { applied: 0 };
    }
    const client = await getClient();
    // NEW-FU-426 (Phase 105): placeholders need the owning term (for
    // owner_semester) and a per-apply sequence so each minted instructor /
    // venue gets a distinct, readable name. ownerSemester is set after BEGIN.
    let ownerSemester = null;
    let dummyInstrSeq = 0;
    let dummyVenueSeq = 0;
    // NEW-FU-348 (Phase 33): extracted per-op DB application into a
    // helper so the compound op type can recursively apply its
    // subOps. The helper returns true if anything was applied,
    // false if the target section was missing (idempotent no-op).
    async function applyOneOp(op) {
      if (op.type === 'reassign-instructor' || op.type === 'reassign-venue') {
        const peek = await client.query(
          `SELECT course_id, section_number, gender FROM sections WHERE id = $1`,
          [op.sectionId]
        );
        if (peek.rowCount === 0) return false;
        // NEW-FU-562 (audit-2 P1-6): gender is part of section identity (UNIQUE includes
        // gender), so every group-resolving WHERE must include it — else an op on one
        // gender's §NN also rewrites/deletes the opposite gender's same-number sibling.
        const { course_id, section_number, gender } = peek.rows[0];
        const field = op.type === 'reassign-instructor' ? 'instructor_id' : 'venue_id';
        const value = op.type === 'reassign-instructor' ? op.newInstructorId : op.newVenueId;
        await client.query(
          `UPDATE sections SET ${field} = $1
           WHERE schedule_id = $2 AND course_id = $3 AND section_number = $4 AND gender = $5`,
          [value, scheduleId, course_id, section_number, gender]
        );
        return true;
      }
      if (op.type === 'drop') {
        const peek = await client.query(
          `SELECT course_id, section_number, gender FROM sections WHERE id = $1`,
          [op.sectionId]
        );
        if (peek.rowCount === 0) return false;
        await client.query(   // audit-2 P1-6: gender in WHERE — never drop the cross-gender sibling
          `DELETE FROM sections WHERE schedule_id = $1 AND course_id = $2 AND section_number = $3 AND gender = $4`,
          [scheduleId, peek.rows[0].course_id, peek.rows[0].section_number, peek.rows[0].gender]
        );
        return true;
      }
      if (op.type === 'move') {
        const peek = await client.query(
          `SELECT course_id, section_number, gender FROM sections WHERE id = $1`,
          [op.sectionId]
        );
        if (peek.rowCount === 0) return false;
        const { course_id, section_number, gender } = peek.rows[0];
        await client.query(   // audit-2 P1-6: gender in WHERE
          `UPDATE sections SET start_time = $1, end_time = $2
           WHERE schedule_id = $3 AND course_id = $4 AND section_number = $5 AND gender = $6`,
          [op.newStartTime, op.newEndTime, scheduleId, course_id, section_number, gender]
        );
        return true;
      }
      if (op.type === 'add-day') {
        const peek = await client.query(
          `SELECT course_id, section_number, instructor_id, venue_id,
                  start_time::text AS start_time, end_time::text AS end_time,
                  section_type, gender
           FROM sections WHERE id = $1`,
          [op.sectionId]
        );
        if (peek.rowCount === 0) return false;
        const tmpl = peek.rows[0];
        for (const day of (op.addDays ?? [])) {
          // NEW-FU-562 (audit-2 P1-3/P2-5): carry gender into the existence-check AND the
          // INSERT, else added meeting-days of a female group are inserted as 'M' (DB
          // default) — splitting it into F rows + a phantom male row, and a same-number
          // opposite-gender sibling on that day wrongly suppresses the insert.
          const exists = await client.query(
            `SELECT 1 FROM sections
             WHERE schedule_id = $1 AND course_id = $2
               AND section_number = $3 AND day = $4 AND gender = $5`,
            [scheduleId, tmpl.course_id, tmpl.section_number, day, tmpl.gender]
          );
          if (exists.rowCount > 0) continue;
          await client.query(
            `INSERT INTO sections
               (schedule_id, course_id, instructor_id, venue_id,
                section_number, day, start_time, end_time, section_type, gender)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [scheduleId, tmpl.course_id, tmpl.instructor_id, tmpl.venue_id,
             tmpl.section_number, day, tmpl.start_time, tmpl.end_time, tmpl.section_type, tmpl.gender]
          );
        }
        return true;
      }
      if (op.type === 'compound') {
        // NEW-FU-348 (Phase 33): apply each subOp in order inside
        // the SAME transaction. If any subOp throws (e.g., a
        // constraint violation on the second), the outer BEGIN/
        // COMMIT rolls everything back — both subOps undone.
        let any = false;
        for (const sub of (op.subOps ?? [])) {
          if (await applyOneOp(sub)) any = true;
        }
        return any;
      }
      // NEW-FU-272 (Phase 50): the three metadata-level ops. Each flips
      // a single boolean / enum on a courses or venues row. They affect
      // every section that references the course/venue, which is exactly
      // what the user wants when, say, marking SWE 414 venue-exempt
      // across all its meeting days.
      if (op.type === 'mark-venue-exempt') {
        const r = await client.query(
          `UPDATE courses SET is_capstone = TRUE WHERE id = $1`,
          [op.courseId]
        );
        return r.rowCount > 0;
      }
      if (op.type === 'reclassify-venue') {
        const r = await client.query(
          `UPDATE venues SET type = $1 WHERE id = $2`,
          [op.newType, op.venueId]
        );
        return r.rowCount > 0;
      }
      if (op.type === 'untag-has-lab') {
        // NEW-FU-562 (audit-2 P2-2): refuse for a 4-credit course (would brick it via the
        // 4cr⇒has-lab invariant). Defensive — emission already skips 4cr, but a client could
        // send the op directly; throwing rolls back the whole apply transaction.
        const c = await client.query(`SELECT credits FROM courses WHERE id = $1`, [op.courseId]);
        if (c.rowCount === 0) return false;
        if (Number(c.rows[0].credits) === 4) {
          const err = new Error('Cannot remove the lab requirement from a 4-credit course.');
          err.status = 409;
          throw err;
        }
        const r = await client.query(
          `UPDATE courses SET has_lab = FALSE WHERE id = $1`,
          [op.courseId]
        );
        return r.rowCount > 0;
      }
      // NEW-FU-460 (Phase 109): give a real OH-less instructor office hours — the
      // preferred R-13 fix (keeps them teaching instead of swapping in a placeholder).
      if (op.type === 'assign-office-hours') {
        await client.query(
          `INSERT INTO office_hours (instructor_id, day, start_time, end_time) VALUES ($1,$2,$3,$4)`,
          [op.instructorId, op.officeHours.day, op.officeHours.startTime, op.officeHours.endTime]
        );
        return true;
      }
      // NEW-FU-426 (Phase 105): mint a term-local placeholder instructor /
      // venue (is_dummy + owner_semester) and point the section group at it.
      // Mirrors SuggestService's apply-time persistence so the two resolvers
      // agree on how placeholders are stored, isolated, and displayed.
      if (op.type === 'add-dummy-instructor') {
        const peek = await client.query(
          `SELECT course_id, section_number, gender FROM sections WHERE id = $1`,
          [op.sectionId]
        );
        if (peek.rowCount === 0) return false;
        const { course_id, section_number, gender } = peek.rows[0];   // audit-2 P1-6: gender-scoped
        const name = `NEW INSTRUCTOR ${++dummyInstrSeq}`;
        const ins = await client.query(
          `INSERT INTO instructors (name, email, is_dummy, owner_semester)
           VALUES ($1, 'dummy-' || gen_random_uuid() || '@placeholder.local', TRUE, $2)
           RETURNING id`,
          [name, ownerSemester]
        );
        await client.query(
          `UPDATE sections SET instructor_id = $1
           WHERE schedule_id = $2 AND course_id = $3 AND section_number = $4 AND gender = $5`,
          [ins.rows[0].id, scheduleId, course_id, section_number, gender]
        );
        // NEW-FU-429 (Phase 106 item 4): give the placeholder a valid OH block
        // that avoids its own sections, so R-13 never fires against it (in any
        // evaluator) — superseding the need to rely only on the __dummy exemption.
        const slotRows = await client.query(
          `SELECT day, start_time::text AS s, end_time::text AS e
           FROM sections WHERE schedule_id = $1 AND course_id = $2 AND section_number = $3 AND gender = $4`,
          [scheduleId, course_id, section_number, gender]
        );
        const oh = pickDummyOfficeHours(slotRows.rows.map(r => ({ day: r.day, start: r.s, end: r.e })));
        await client.query(
          `INSERT INTO office_hours (instructor_id, day, start_time, end_time) VALUES ($1,$2,$3,$4)`,
          [ins.rows[0].id, oh.day, oh.startTime, oh.endTime]
        );
        return true;
      }
      if (op.type === 'add-dummy-venue') {
        const peek = await client.query(
          `SELECT course_id, section_number, gender FROM sections WHERE id = $1`,
          [op.sectionId]
        );
        if (peek.rowCount === 0) return false;
        const { course_id, section_number, gender } = peek.rows[0];   // audit-2 P1-6: gender-scoped
        const vtype = op.venueType === 'Laboratory' ? 'Laboratory' : 'LectureHall';
        const name  = await nextDummyVenueName(client); // NEW-FU-431: globally-unique name
        const ins = await client.query(
          `INSERT INTO venues (name, type, capacity, is_dummy, owner_semester)
           VALUES ($1, $2, 30, TRUE, $3)
           RETURNING id`,
          [name, vtype, ownerSemester]
        );
        await client.query(
          `UPDATE sections SET venue_id = $1
           WHERE schedule_id = $2 AND course_id = $3 AND section_number = $4 AND gender = $5`,
          [ins.rows[0].id, scheduleId, course_id, section_number, gender]
        );
        return true;
      }
      return false;
    }
    try {
      await client.query('BEGIN');
      // NEW-FU-469 (Phase 113): QuickFix apply was the ONLY section-mutating path
      // that skipped the finalize/archive lock every other writer enforces
      // (ScheduleService createSection/assignSection/deleteSection/suggest/import
      // all call it). A drop / reassign / move op could therefore permanently
      // mutate a FINALIZED or archived term. Take the same FOR UPDATE row-lock +
      // refuse, inside this transaction, before any op runs. Lazy require avoids
      // any module cycle with ScheduleService.
      const svc = require('./ScheduleService');
      await svc.assertSchedulerEditableLocked(client, scheduleId);
      // NEW-FU-569 (audit-2 Phase-11 P2): baseline HARD-conflict count BEFORE the
      // plan runs. plan() computed the ops against an UNLOCKED snapshot, so a
      // concurrent edit between plan() and apply() can make an op worse; we refuse
      // the whole batch below if the hard count rises (mirrors the TOCTOU hardening
      // ScheduleService.applyMovesRevalidated / FU-563 added to the move-only apply).
      const baselineHard = (await svc._evaluateSchedule(scheduleId, client)).hardConflicts.length;
      // NEW-FU-426 (Phase 105): resolve the owning term once so any minted
      // placeholder is tagged term-local (and never leaks to other terms).
      const semRes = await client.query(
        'SELECT semester FROM schedules WHERE id = $1', [scheduleId]
      );
      ownerSemester = semRes.rows[0]?.semester ?? null;
      let applied = 0;
      for (const op of opsToApply) {
        if (await applyOneOp(op)) applied++;
      }
      // NEW-FU-569 (audit-2 Phase-11 P2): re-validate the OUTCOME under the lock and
      // persist the refreshed conflict set, before COMMIT. (a) Refuse with 409 if the
      // applied plan RAISED the hard-conflict count — a stale plan must never
      // manufacture conflicts. (b) The quickFixApply controller does NOT revalidate
      // after apply, so without this the conflicts table (and the term hard/soft
      // badges) would describe the pre-fix world until the next GET /conflicts.
      const after = await svc._evaluateSchedule(scheduleId, client);
      if (after.hardConflicts.length > baselineHard) {
        const err = new Error('This fix set would introduce new conflicts and was not applied. Refresh the conflicts and try again.');
        err.status = 409;
        throw err;
      }
      const { ConflictRepository } = require('../repositories/repositories');
      await new ConflictRepository().replaceAll(scheduleId, after.conflicts, client);
      await client.query('COMMIT');
      return { applied };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      try { client.release(err); } catch { /* ignore */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* already released */ }
    }
  }
}

module.exports = new QuickFixService();
