const { SEVERITY, RULE_IDS } = require('../../config/constants');
const Conflict = require('../../domain/Conflict');
const Section  = require('../../domain/Section');
// NEW-FU-282 (Phase 56): shared label helper for §F-XX rendering.
const { sectionLabel } = require('../../domain/sectionLabel');

function evaluate(changed, allSections, officeHours = []) {
  if (!changed.instructorId) return [];
  if (!changed.startTime || !changed.endTime) return [];

  const conflicts = [];

  // a) Double-booking
  for (const other of allSections) {
    if (other.id === changed.id) continue;
    // Skip siblings (same course+section on different days of a group)
    if (other.courseId === changed.courseId && other.sectionNumber === changed.sectionNumber) continue;
    // NEW-FU-272 (Phase 50 #3): KFUPM convention — a male section and the
    // female-pool sibling of the SAME course at the SAME slot share the
    // physical class. Same instructor here is intentional, not a conflict.
    if (other.courseId === changed.courseId &&
        other.gender && changed.gender && other.gender !== changed.gender &&
        other.startTime === changed.startTime && other.endTime === changed.endTime) continue;
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
    // NEW-L1: was `oh.day ?? oh.day` — dead nullish-coalesce of the same value.
    const ohDay   = oh.day;
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
          `${changed.courseCode} (${sectionLabel(changed)}) on ${changed.day} overlaps the office hours ` +
          `of ${changed.instructorName ?? 'the instructor'} (${ohDay} ${ohStart}–${ohEnd}). ` +
          `Classes cannot be scheduled during an instructor's office hours.`,
        sectionAId: changed.id, sectionBId: null,
      }));
    }
  }

  return conflicts;
}

module.exports = { evaluate };
