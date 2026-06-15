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
    // NEW-FU-555 (Batch 18): minutes, not raw strings — the preview's "HH:MM" vs the
    // snapshot's "HH:MM:SS" broke this exemption and surfaced false instructor clashes.
    if (other.courseId === changed.courseId &&
        other.gender && changed.gender && other.gender !== changed.gender &&
        other.startMinutes === changed.startMinutes && other.endMinutes === changed.endMinutes) continue;
    if (other.instructorId !== changed.instructorId) continue;
    if (!other.startTime || !other.endTime) continue;
    if (!changed.overlaps(other)) continue;

    conflicts.push(new Conflict({
      id: null, scheduleId: changed.scheduleId,
      ruleId: RULE_IDS.R04, severity: SEVERITY.HARD,
      description:
        // NEW-FU-472 (Phase 113): drop the raw "Hard Conflict (R-04):" code prefix
        // — plain-language mandate, no internal rule codes in user-facing text.
        `${changed.instructorName ?? changed.instructorId} ` +
        `is assigned to two overlapping sections at the same time: ${changed.label} and ${other.label}.`,
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
