// RescheduleAroundService (NEW-FU-541, Batch 13 Issue 2)
// ─────────────────────────────────────────────────────────────────────────────
// A CONSTRAINED, move-only resolver for the section EDIT / ADD panels. Unlike the
// grid Quick Fix (QuickFixService), this resolver:
//   • NEVER drops or deletes a section/course.
//   • NEVER assigns dummy/placeholder resources.
//   • ONLY reschedules AROUND the conflict — it shifts the START TIME of OTHER
//     existing section-groups (keeping their days, duration and pattern) so the
//     user's proposed change becomes conflict-free.
//
// It returns a plan of moves when a fully conflict-free arrangement is achievable
// purely by retiming other groups, or { feasible: false } when the schedule is too
// tight (the panel then blocks the change).
//
// CORRECTNESS INVARIANT — "never silently create a conflict":
//   We compute a BASELINE conflict set = the conflicts that already exist among the
//   other sections WITHOUT the proposed change. A candidate arrangement is accepted
//   only if EVERY conflict it contains is already in the baseline. Because the
//   proposed group's key is absent from the baseline, any conflict involving the
//   proposed section is automatically disqualifying — so a feasible plan guarantees
//   the proposed change is conflict-free AND no new conflict was introduced.
'use strict';

const { teachingWindowFor } = require('../config/constants'); // NEW-FU-621 (audit #2)

const SLOT_STEP_MIN     = 30;   // candidate start-time granularity
const MAX_MOVED_GROUPS  = 8;    // cap on how many OTHER groups one fix may relocate
const NODE_BUDGET       = 1400; // hard ceiling on repair-search nodes → bounded latency

function windowFor(category, isCapstone, courseCode) {
  // Mirrors the teaching windows used by previewConflicts / the conflict engine.
  // NEW-FU-621 (audit #2): delegate to the shared R-06-aware resolver so an exempt
  // course (SWE 412) being rescheduled-around can be retimed into the evening too.
  return teachingWindowFor({ category, isCapstone, courseCode });
}

/**
 * @param ctx {
 *   engine,                // ConflictEngine instance
 *   ohMap,                 // Map<instructorId, [{day,startTime,endTime}]>
 *   mk,                    // (row) => Section
 *   fromMin,               // (minutes) => 'HH:MM'
 *   proposedRows,          // rows for the proposed group, already at the desired time
 *   groups,                // [{ key, rows, startMin, durMin, category, isCapstone,
 *                          //    isExternal, courseCode }]  (courseCode → R-06 exemption)
 * }
 * @returns { feasible: boolean, moves?: [{ sectionId, courseCode, sectionNumber,
 *                                          day, fromStart, toStart, toEnd }] }
 */
function planRescheduleAround(ctx) {
  const { engine, ohMap, mk, fromMin, proposedRows, groups } = ctx;

  const byKey = new Map(groups.map(g => [g.key, g]));

  // id → group-key map (proposed sections collapse to the synthetic 'PROPOSED').
  // id → day map: under reschedule only the START TIME moves, so a section's day is
  // invariant — and the conflict key must carry it (see below).
  const keyOfId = new Map();
  const dayOfId = new Map();
  proposedRows.forEach(r => { keyOfId.set(r.id, 'PROPOSED'); dayOfId.set(r.id, r.day); });
  groups.forEach(g => g.rows.forEach(r => { keyOfId.set(r.id, g.key); dayOfId.set(r.id, r.day); }));

  // NEW-FU-561 (audit P1-3): the zero-new-conflict (baseline-subset) test masks a
  // candidate conflict whenever the baseline holds one with the SAME key. Keying by
  // (ruleId, groupA, groupB) ALONE dropped the day, so a brand-new clash between the
  // same two groups on a DIFFERENT day was wrongly treated as "already in baseline" →
  // the solver could declare an arrangement feasible while actually introducing a
  // conflict (invariant violation). Include the day so different-day clashes are
  // distinct. Strictly safer: a finer key can only ADD conflicts to the "new" set,
  // never mask a genuinely new one.
  const conflictKey = (c) => {
    const a = keyOfId.get(c.sectionAId);
    const b = keyOfId.get(c.sectionBId);
    const [x, y] = [a, b].sort();
    const day = dayOfId.get(c.sectionAId) ?? dayOfId.get(c.sectionBId) ?? '';
    return `${c.ruleId}|${x}|${y}|${day}`;
  };

  // Build the full section list for an assignment (group-key → startMin). Groups not
  // in the assignment stay at their original start. Proposed group is always fixed.
  const buildAll = (assignment) => {
    const secs = proposedRows.map(mk);
    for (const g of groups) {
      const st = assignment[g.key] != null ? assignment[g.key] : g.startMin;
      for (const r of g.rows) {
        secs.push(mk({ ...r, start_time: fromMin(st), end_time: fromMin(st + g.durMin) }));
      }
    }
    return secs;
  };
  const evalConf = (assignment) => engine.evaluateAll(buildAll(assignment), ohMap).conflicts;

  // Baseline: conflicts among the OTHER groups at their original times, no proposed.
  const baseSecs = [];
  for (const g of groups) {
    for (const r of g.rows) {
      baseSecs.push(mk({ ...r, start_time: fromMin(g.startMin), end_time: fromMin(g.startMin + g.durMin) }));
    }
  }
  const baselineKeys = new Set(engine.evaluateAll(baseSecs, ohMap).conflicts.map(conflictKey));

  // A conflict is "new" iff it isn't already present in the baseline (the schedule
  // WITHOUT the proposed change). The panel Quick Fix must introduce ZERO new
  // conflicts of ANY severity — it fixes, it never causes. Pre-existing baseline
  // conflicts elsewhere are out of scope (that's the grid Quick Fix's job).
  const newConflicts = (assignment) =>
    evalConf(assignment).filter(c => !baselineKeys.has(conflictKey(c)));

  // Nothing new with no moves → the proposed change is already clean (defensive: the
  // caller only invokes us on a conflict).
  if (newConflicts({}).length === 0) return { feasible: true, moves: [] };

  // Candidate start-times per group, ordered by least disruption (closest to the
  // group's current start first). Cached — windows/durations don't change.
  const slotCache = new Map();
  const slotsFor = (g) => {
    if (slotCache.has(g.key)) return slotCache.get(g.key);
    const win = windowFor(g.category, g.isCapstone, g.courseCode);
    const slots = [];
    for (let st = win.start; st + g.durMin <= win.end; st += SLOT_STEP_MIN) slots.push(st);
    slots.sort((a, b) => Math.abs(a - g.startMin) - Math.abs(b - g.startMin));
    slotCache.set(g.key, slots);
    return slots;
  };

  // Constraint-repair search with CASCADE. State = a partial map of group-key → new
  // start. At each step we look at the remaining NEW conflicts; if any new conflict
  // has no movable side (proposed-vs-immovable, or both immovable) it can never be
  // cleared → dead branch. Otherwise we pick the most-constrained new conflict
  // (fewest movable participants) and try relocating each of its movable groups —
  // which may in turn create new conflicts that later steps repair (the cascade).
  // Success = ZERO new conflicts. Bounded by node budget and a cap on moved groups.
  const assignment = {};
  const frozen = new Set();          // groups already relocated on the current path
  let budget = NODE_BUDGET;

  const dfs = () => {
    if (budget-- <= 0) return false;
    const nc = newConflicts(assignment);
    if (nc.length === 0) return true;
    if (frozen.size >= MAX_MOVED_GROUPS) return false;   // audit P3: was `>` → allowed MAX_MOVED_GROUPS+1 relocations

    // Choose the most-constrained NEW conflict whose movable participants aren't all
    // already frozen. A conflict with NO movable participant (proposed-vs-immovable,
    // or both immovable) can never be cleared → dead branch.
    let pick = null;
    for (const c of nc) {
      const sides = [keyOfId.get(c.sectionAId), keyOfId.get(c.sectionBId)]
        .filter(k => k && k !== 'PROPOSED');
      const movable = sides.map(k => byKey.get(k)).filter(g => g && g.movable);
      if (movable.length === 0) return false;          // unfixable conflict → dead branch
      const free = movable.filter(g => !frozen.has(g.key));
      // NEW-FU-577 (Batch 23): a NEW conflict whose only movable participants are all
      // FROZEN can never be cleared on THIS path — a frozen group won't relocate again
      // until we backtrack, and moving any group NOT party to this conflict cannot
      // separate the two overlapping sections. So this branch is dead → prune it.
      // The old `continue` (skip this conflict, work another) kept the branch alive: it
      // chased unrelated cascades until the NODE_BUDGET was exhausted, then reported
      // `feasible:false` for schedules that DO have a clean reschedule — the panel's
      // false "Schedule is tight". Pruning here lets the responsible (shallower) group
      // try its remaining slots instead of burning the budget on a doomed subtree.
      // Strictly safe: the `continue` path could never reach 0 new conflicts while this
      // conflict stood, so no feasible plan is lost — only wasted search.
      if (free.length === 0) return false;             // only mover(s) frozen → doomed branch, prune
      if (!pick || free.length < pick.length) pick = free;
      if (pick.length === 1) break;
    }
    if (!pick) return false;                           // every new conflict is stuck → backtrack

    // Relocate ONE participant per path step. Each group is placed at most once per
    // path (frozen), and we scan ALL its candidate slots here — so a single group's
    // resolution never ping-pongs across recursion levels.
    for (const g of pick) {
      frozen.add(g.key);
      const prev = assignment[g.key];
      for (const s of slotsFor(g)) {
        if (s === g.startMin) continue;                // a relocation must leave the original slot
        assignment[g.key] = s;
        if (dfs()) return true;
      }
      if (prev === undefined) delete assignment[g.key]; else assignment[g.key] = prev;
      frozen.delete(g.key);
    }
    return false;
  };

  if (!dfs()) return { feasible: false };

  const moves = [];
  for (const g of groups) {
    const s = assignment[g.key];
    if (s == null || s === g.startMin) continue;       // unchanged → not a move
    for (const r of g.rows) {
      moves.push({
        sectionId: r.id,
        courseCode: r.course_code,
        sectionNumber: r.section_number,
        day: r.day,
        fromStart: fromMin(g.startMin),
        toStart: fromMin(s),
        toEnd: fromMin(s + g.durMin),
      });
    }
  }
  return { feasible: true, moves };
}

module.exports = { planRescheduleAround, windowFor };
