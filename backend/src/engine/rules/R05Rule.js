/**
 * R-05 – Venue Conflict Rule (Hard)
 *
 * A venue (lecture hall or laboratory) cannot host two sections at the same time.
 * Applies ONLY to tracked venues — regular departmental classrooms are excluded.
 */
const { SEVERITY, RULE_IDS } = require('../../config/constants');
const Conflict = require('../../domain/Conflict');

function evaluate(changed, allSections) {
  if (!changed.venueId) return [];  // no venue assigned, rule does not apply

  const conflicts = [];

  for (const other of allSections) {
    if (other.id === changed.id) continue;
    // Skip siblings (same course+section on different days of a group)
    if (other.courseId === changed.courseId && other.sectionNumber === changed.sectionNumber) continue;
    if (other.venueId !== changed.venueId) continue;
    if (!changed.overlaps(other)) continue;

    conflicts.push(new Conflict({
      id: null, scheduleId: changed.scheduleId,
      ruleId: RULE_IDS.R05, severity: SEVERITY.HARD,
      description:
        `Venue ${changed.venueName ?? 'unknown'} is already occupied by ` +
        `${other.courseCode} (§${other.sectionNumber}) at ${other.startTime}–${other.endTime} on ${changed.day}. ` +
        `${changed.courseCode} (§${changed.sectionNumber}) is scheduled at the same time.`,
      sectionAId: changed.id, sectionBId: other.id,
    }));
  }

  return conflicts;
}

module.exports = { evaluate };
