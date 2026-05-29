/**
 * R-01 — Same academic level overlap (Hard)
 *
 * Applies ONLY when BOTH courses have multiple sections in the schedule.
 * (Single-section course conflicts are handled by R-02.)
 *
 * Fires when every logical section of course A overlaps every logical section
 * of course B — meaning students have no escape route.
 */
const { SEVERITY, RULE_IDS } = require('../../config/constants');
const Conflict = require('../../domain/Conflict');
// NEW-FU-282 (Phase 56): shared label helper for §F-XX rendering.
const { sectionLabel } = require('../../domain/sectionLabel');

function toMin(t) {
  if (!t) return 0;
  const [h, m] = t.substring(0,5).split(':').map(Number);
  return h*60+m;
}

function logicalOverlaps(rowsA, rowsB) {
  for (const a of rowsA) {
    for (const b of rowsB) {
      if (!a.day || !b.day || a.day !== b.day) continue;
      if (toMin(a.startTime) < toMin(b.endTime) &&
          toMin(b.startTime) < toMin(a.endTime)) return true;
    }
  }
  return false;
}

function buildCourseMap(sections) {
  const courses = new Map();
  for (const sec of sections) {
    if (!courses.has(sec.courseId)) courses.set(sec.courseId, new Map());
    const secMap = courses.get(sec.courseId);
    if (!secMap.has(sec.sectionNumber)) secMap.set(sec.sectionNumber, []);
    secMap.get(sec.sectionNumber).push(sec);
  }
  return courses;
}

function evaluate(changed, allSections) {
  if (!changed.academicLevel) return [];

  const all       = [changed, ...allSections];
  const courseMap = buildCourseMap(all);

  const changedSecMap  = courseMap.get(changed.courseId);
  const changedLogical = Array.from(changedSecMap?.values() ?? []);

  // R-01 only applies when the changed course has MULTIPLE sections
  if (changedLogical.length <= 1) return [];

  const conflicts    = [];
  const reportedPairs = new Set();

  for (const [otherCourseId, otherSecMap] of courseMap.entries()) {
    if (otherCourseId === changed.courseId) continue;

    const otherLogical = Array.from(otherSecMap.values());
    if (!otherLogical.length) continue;

    // R-01 only applies when the OTHER course also has multiple sections
    // Single-section other course conflicts are handled by R-02 when evaluated from that course
    if (otherLogical.length <= 1) continue;

    const otherLevel = otherLogical[0][0]?.academicLevel;
    if (otherLevel !== changed.academicLevel) continue;

    const pairKey = [changed.courseId, otherCourseId].sort().join('|');
    if (reportedPairs.has(pairKey)) continue;

    // Escape exists if ANY logicalA + ANY logicalB do NOT overlap
    let hasEscape = false;
    outer:
    for (const logA of changedLogical) {
      for (const logB of otherLogical) {
        if (!logicalOverlaps(logA, logB)) { hasEscape = true; break outer; }
      }
    }

    if (!hasEscape) {
      reportedPairs.add(pairKey);

      const changedCode = changed.courseCode ?? changed.courseId;
      const otherCode   = otherLogical[0][0]?.courseCode ?? otherCourseId;
      const totalA      = changedLogical.length;
      const totalB      = otherLogical.length;
      // NEW-FU-80: sort section numbers alphanumerically before joining so
      // the description is deterministic across saves. Prior code's list
      // order tracked Map insertion order, which tracked the result-set
      // order from `SELECT … FROM sections WHERE schedule_id=$1` (no
      // ORDER BY). pg can reorder rows after UPDATEs, so the same
      // conflict could produce two different descriptions across saves —
      // and the FU-78 signature scheme (description-keyed) would then
      // falsely flag the post-edit conflict as "new" even though no
      // logical violation changed.
      // NEW-FU-282 (Phase 56): iterate entries (not keys) so we can read
      // the section row's gender and render "§F-XX" for female sections
      // (display-only; rule logic unchanged). All rows in a logical-
      // section bucket share the same gender, so rows[0] is canonical.
      const sortSecs = m => Array.from(m.entries())
        .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
        .map(([, rows]) => sectionLabel(rows[0])).join(', ');
      // NEW-FU-80 (extended): canonicalize the course-pair order too.
      // R-01 is symmetric (the violation belongs to a course pair, not to
      // a "first" course), but the evaluator fires once per section in
      // the schedule — so the description's "X and Y" order depends on
      // which section gets evaluated first. The evaluateAll dedup keeps
      // whichever orientation fires first, which still varies with the
      // section-array iteration order. Forcing the alphabetically-smaller
      // courseCode to appear first makes the surviving conflict's
      // description AND the FU-78 signature stable end-to-end.
      const pair = [
        { code: changedCode, secMap: changedSecMap, total: totalA },
        { code: otherCode,   secMap: otherSecMap,   total: totalB },
      ].sort((a, b) => String(a.code).localeCompare(String(b.code)));
      const secListA    = sortSecs(pair[0].secMap);
      const secListB    = sortSecs(pair[1].secMap);
      const repB        = otherLogical[0].find(r =>
        changedLogical.some(logA => logicalOverlaps(logA, [r]))
      ) ?? otherLogical[0][0];

      conflicts.push(new Conflict({
        id: null, scheduleId: changed.scheduleId,
        ruleId: RULE_IDS.R01, severity: SEVERITY.HARD,
        description:
          `${pair[0].code} (${pair[0].total} sections: ${secListA}) and ` +
          `${pair[1].code} (${pair[1].total} sections: ${secListB}) ` +
          `are both ${changed.academicLevel}-level and every section combination overlaps — ` +
          `students have no way to take both courses.`,
        sectionAId: changed.id,
        sectionBId: repB?.id ?? null,
      }));
    }
  }

  return conflicts;
}

module.exports = { evaluate };
