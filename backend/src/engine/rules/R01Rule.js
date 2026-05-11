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
      const secListA    = Array.from(changedSecMap.keys()).map(n=>`§${n}`).join(', ');
      const secListB    = Array.from(otherSecMap.keys()).map(n=>`§${n}`).join(', ');
      const repB        = otherLogical[0].find(r =>
        changedLogical.some(logA => logicalOverlaps(logA, [r]))
      ) ?? otherLogical[0][0];

      conflicts.push(new Conflict({
        id: null, scheduleId: changed.scheduleId,
        ruleId: RULE_IDS.R01, severity: SEVERITY.HARD,
        description:
          `${changedCode} (${totalA} sections: ${secListA}) and ` +
          `${otherCode} (${totalB} sections: ${secListB}) ` +
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
