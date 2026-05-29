/**
 * R-06 – UG / GR Time Allocation Rule (Hard)
 *
 * Undergraduate (UG) courses: 07:00 – 17:00 only
 * Graduate     (GR) courses: 17:00 – 22:00 only
 */
const { SEVERITY, RULE_IDS, COURSE_CATEGORY, TIME_WINDOWS } = require('../../config/constants');
const Conflict = require('../../domain/Conflict');
const Section  = require('../../domain/Section');

function evaluate(changed) {
  if (!changed.category) return [];
  // NEW-FU-273 (Phase 51 #1): capstone-style courses (SWE 411/412/413/414)
  // legitimately meet in the evening because students prefer that window
  // after their daytime classes. The UG-window check is inappropriate
  // for them. Same flag that suppresses venue rules.
  if (changed.isCapstone) return [];

  const window = TIME_WINDOWS[changed.category];
  if (!window) return [];

  const start = changed.startMinutes;
  const end   = changed.endMinutes;

  const withinWindow = start >= window.start && end <= window.end;
  if (withinWindow) return [];

  const windowStr = changed.category === COURSE_CATEGORY.UG
    ? '7:00 AM – 5:00 PM'
    : 'after 5:00 PM (17:00 – 22:00)';

  return [new Conflict({
    id: null, scheduleId: changed.scheduleId,
    ruleId: RULE_IDS.R06, severity: SEVERITY.HARD,
    description:
      `${changed.courseCode} is an ${changed.category === 'UG' ? 'undergraduate' : 'graduate'} course ` +
      `but is scheduled at ${changed.startTime}–${changed.endTime} on ${changed.day}. ` +
      `${changed.category === 'UG' ? 'Undergraduate courses must be between 7:00 AM and 5:00 PM.' : 'Graduate courses must be after 5:00 PM.'}`,
    sectionAId: changed.id, sectionBId: null,
  })];
}

module.exports = { evaluate };
