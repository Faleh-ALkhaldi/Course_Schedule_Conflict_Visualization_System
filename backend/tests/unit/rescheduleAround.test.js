/**
 * Batch 23 (FU-577) — the panel/Add-Section move-only Quick Fix (RescheduleAroundService)
 * must HONOR an anchored section by rescheduling the OTHER sections around it, and must not
 * report "Schedule is tight" when a clean reschedule exists.
 *
 * Regression for the false-infeasible bug: the cascade DFS, after trying the conflicting
 * mover at its NEAREST (still-clashing) slot, froze that mover; the anchor↔mover conflict
 * then had only a frozen mover, so the old code `continue`d and chased unrelated decoy
 * cascades until NODE_BUDGET was exhausted — returning feasible:false even though moving the
 * mover one slot farther clears everything. Pruning that doomed branch (return false) lets
 * the mover try its remaining slots. This fixture has enough venue-sharing decoys to exhaust
 * the old budget; the fixed solver finds a clean plan.
 */
'use strict';
const Section = require('../../src/domain/Section');
const ConflictEngine = require('../../src/engine/ConflictEngine');
const { planRescheduleAround } = require('../../src/services/RescheduleAroundService');

const fm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hm = t => { const [h, m] = String(t).slice(0, 5).split(':').map(Number); return h * 60 + m; };
// snake_case rows (what buildAll overrides) → Section, exactly like the controller's mk.
const mk = r => new Section({
  id: r.id, scheduleId: r.schedule_id, courseId: r.course_id, instructorId: r.instructor_id, venueId: r.venue_id,
  sectionNumber: r.section_number, day: r.day, startTime: r.start_time, endTime: r.end_time,
  courseCode: r.course_code, courseName: r.course_name, academicLevel: r.academic_level, category: r.category,
  numSections: r.num_sections, instructorName: r.instructor_name, venueName: r.venue_name, sectionType: r.section_type,
  venueType: r.venue_type, hasLab: r.has_lab, credits: r.credits, isCapstone: r.is_capstone, gender: r.gender, isExternal: r.is_external,
});
const row = (o) => ({
  schedule_id: 's', course_id: o.course, instructor_id: o.instr, venue_id: o.venue, section_number: o.sec,
  day: o.day, start_time: o.start, end_time: o.end, course_code: o.course, course_name: o.course,
  academic_level: 'Junior', category: 'UG', num_sections: 2, instructor_name: o.instr, venue_name: o.venue,
  section_type: 'Lec', venue_type: 'classroom', has_lab: false, credits: 3, is_capstone: false, gender: 'M', is_external: false, id: o.id,
});

// Anchor CP §01 @ Mon/Wed 09:00 (instructor IP) is fixed. Mover CP §02 shares instructor IP
// (→ clash at 09:00) and venue VM. K decoys share venue VM at the mover's nearest slots, so
// the doomed "freeze mover at a near slot, chase decoys" branch is wide enough to exhaust the
// old budget. Moving the mover to an earlier slot (e.g. 07:30) clears the anchor cleanly.
function buildScenario(K) {
  const proposedRows = ['Monday', 'Wednesday'].map((d, i) =>
    row({ id: `__prop${i}`, course: 'CP', sec: '01', instr: 'IP', venue: 'VP', day: d, start: '09:00', end: '10:15' }));
  const groups = [];
  groups.push({
    key: 'CP|02|M', startMin: 540, durMin: 75, category: 'UG', isCapstone: false, isExternal: false, movable: true,
    rows: ['Monday', 'Wednesday'].map((d, i) => row({ id: `m${i}`, course: 'CP', sec: '02', instr: 'IP', venue: 'VM', day: d, start: '09:00', end: '10:15' })),
  });
  const near = ['08:30', '09:30', '08:00', '10:00', '10:30', '11:00', '11:30', '12:00'];
  for (let k = 0; k < K; k++) {
    const s = near[k % near.length];
    groups.push({
      key: `D${k}|01|M`, startMin: hm(s), durMin: 75, category: 'UG', isCapstone: false, isExternal: false, movable: true,
      rows: ['Monday', 'Wednesday'].map((d, i) => row({ id: `d${k}_${i}`, course: `D${k}`, sec: '01', instr: `ID${k}`, venue: 'VM', day: d, start: s, end: fm(hm(s) + 75) })),
    });
  }
  return { proposedRows, groups };
}

describe('RescheduleAroundService — honor anchored slot without false "tight" (Batch 23 / FU-577)', () => {
  const engine = new ConflictEngine();
  const ohMap = new Map();

  test('finds a clean reschedule when the mover must skip its nearest (still-clashing) slots', () => {
    const { proposedRows, groups } = buildScenario(6); // enough decoys to exhaust the OLD budget
    const plan = planRescheduleAround({ engine, ohMap, mk, fromMin: fm, proposedRows, groups: groups.map(g => ({ ...g, rows: [...g.rows] })) });
    expect(plan.feasible).toBe(true);
    expect(Array.isArray(plan.moves)).toBe(true);
    expect(plan.moves.length).toBeGreaterThan(0);

    // The plan must be VALID per the solver's contract: the anchored section ends up
    // conflict-free, and the plan introduces NO conflict beyond the pre-existing baseline.
    const key = c => `${c.ruleId}|${[c.sectionAId, c.sectionBId].sort().join('|')}`;
    const baselineKeys = new Set(engine.evaluateAll(groups.flatMap(g => g.rows.map(mk)), ohMap).conflicts.map(key));
    const moved = new Map(plan.moves.map(m => [m.sectionId, m]));
    const finalSecs = [
      ...proposedRows.map(mk),
      ...groups.flatMap(g => g.rows.map(r => {
        const m = moved.get(r.id);
        return mk(m ? { ...r, start_time: m.toStart, end_time: m.toEnd } : r);
      })),
    ];
    const final = engine.evaluateAll(finalSecs, ohMap).conflicts;
    const proposedIds = new Set(proposedRows.map(r => r.id));
    // (a) the anchored (proposed) section is fully conflict-free
    expect(final.filter(c => proposedIds.has(c.sectionAId) || proposedIds.has(c.sectionBId))).toHaveLength(0);
    // (b) no NEW conflict was introduced anywhere (every remaining conflict pre-existed)
    expect(final.filter(c => !baselineKeys.has(key(c)))).toHaveLength(0);
  });

  test('still reports infeasible (honestly) when no reschedule exists', () => {
    // Anchor CP §01 immovable; mover CP §02 shares instructor IP AND is the ONLY other group,
    // but pin it immovable → genuinely nothing can move → honest infeasible (no false hope).
    const { proposedRows, groups } = buildScenario(0);
    groups.forEach(g => { g.movable = false; });
    const plan = planRescheduleAround({ engine, ohMap, mk, fromMin: fm, proposedRows, groups });
    expect(plan.feasible).toBe(false);
  });
});
