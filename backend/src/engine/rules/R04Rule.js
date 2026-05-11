const { SEVERITY, RULE_IDS } = require('../../config/constants');
const Conflict = require('../../domain/Conflict');
const Section  = require('../../domain/Section');

function evaluate(changed, allSections, officeHours = []) {
  if (!changed.instructorId) return [];
  if (!changed.startTime || !changed.endTime) return [];

  const conflicts = [];

  // a) Double-booking
  for (const other of allSections) {
    if (other.id === changed.id) continue;
    // Skip siblings (same course+section on different days of a group)
    if (other.courseId === changed.courseId && other.sectionNumber === changed.sectionNumber) continue;
    if (other.instructorId !== changed.instructorId) continue;
    if (!other.startTime || !other.endTime) continue;
    if (!changed.overlaps(other)) continue;

    conflicts.push(new Conflict({
      id: null, scheduleId: changed.scheduleId,
      ruleId: RULE_IDS.R04, severity: SEVERITY.HARD,
      description:
        `Hard Conflict (R-04): ${changed.instructorName ?? changed.instructorId} ` +
        `is assigned to two overlapping sections: ${changed.label} and ${other.label}.`,
      sectionAId: changed.id, sectionBId: other.id,
    }));
  }

  // b) Office-hour overlap
  for (const oh of officeHours) {
    const ohDay   = oh.day        ?? oh.day;
    const ohStart = oh.start_time ?? oh.startTime;
    const ohEnd   = oh.end_time   ?? oh.endTime;

    if (!ohDay || !ohStart || !ohEnd) continue;
    if (ohDay !== changed.day) continue;

    const ohStartMin = Section.toMinutes(ohStart);
    const ohEndMin   = Section.toMinutes(ohEnd);

    if (changed.startMinutes < ohEndMin && ohStartMin < changed.endMinutes) {
      conflicts.push(new Conflict({
        id: null, scheduleId: changed.scheduleId,
        ruleId: RULE_IDS.R04, severity: SEVERITY.HARD,
        description:
          `${changed.courseCode} (§${changed.sectionNumber}) on ${changed.day} overlaps the office hours ` +
          `of ${changed.instructorName ?? 'the instructor'} (${ohDay} ${ohStart}–${ohEnd}). ` +
          `Classes cannot be scheduled during an instructor's office hours.`,
        sectionAId: changed.id, sectionBId: null,
      }));
    }
  }

  return conflicts;
}

module.exports = { evaluate };
