/**
 * R-05 – Venue Conflict Rule (Hard)
 *
 * A venue (lecture hall or laboratory) cannot host two sections at the same time.
 * Applies ONLY to tracked venues — regular departmental classrooms are excluded.
 */
const { SEVERITY, RULE_IDS } = require('../../config/constants');
const Conflict = require('../../domain/Conflict');
// NEW-FU-282 (Phase 56): shared label helper for §F-XX rendering.
const { sectionLabel } = require('../../domain/sectionLabel');

function evaluate(changed, allSections) {
  if (!changed.venueId) return [];  // no venue assigned, rule does not apply
  // NEW-FU-272 (Phase 50 #1): capstone-style courses are venue-exempt.
  // Even if a venue is assigned (e.g., admin manually set one for a
  // capstone), don't treat that venue as locking out other sections —
  // these courses meet wherever convenient and don't truly occupy a room.
  if (changed.isCapstone) return [];

  const conflicts = [];

  for (const other of allSections) {
    if (other.id === changed.id) continue;
    // Skip siblings (same course+section on different days of a group)
    if (other.courseId === changed.courseId && other.sectionNumber === changed.sectionNumber) continue;
    // NEW-FU-272 (Phase 50 #3): KFUPM convention — a male section and the
    // female-pool sibling of the SAME course at the SAME slot share the
    // physical classroom. The venue isn't double-booked, just dual-audience.
    if (other.courseId === changed.courseId &&
        other.gender && changed.gender && other.gender !== changed.gender &&
        other.startTime === changed.startTime && other.endTime === changed.endTime) continue;
    if (other.venueId !== changed.venueId) continue;
    if (!changed.overlaps(other)) continue;

    conflicts.push(new Conflict({
      id: null, scheduleId: changed.scheduleId,
      ruleId: RULE_IDS.R05, severity: SEVERITY.HARD,
      description:
        `Venue ${changed.venueName ?? 'unknown'} is already occupied by ` +
        `${other.courseCode} (${sectionLabel(other)}) at ${other.startTime}–${other.endTime} on ${changed.day}. ` +
        `${changed.courseCode} (${sectionLabel(changed)}) is scheduled at the same time.`,
      sectionAId: changed.id, sectionBId: other.id,
    }));
  }

  return conflicts;
}

module.exports = { evaluate };
