/**
 * R-06 – UG / GR Time Allocation Rule (Hard)
 *
 * Undergraduate (UG) courses: 07:00 – 17:10 only
 * Graduate     (GR) courses: 17:20 – 22:00 only
 */
const { SEVERITY, RULE_IDS, TIME_WINDOWS, R06_TIME_EXEMPT_COURSES } = require('../../config/constants');
const Conflict = require('../../domain/Conflict');
const Section  = require('../../domain/Section');

// Render a window as "07:00–17:10" from {start,end} minutes-from-midnight.
const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function evaluate(changed) {
  if (!changed.category) return [];
  // NEW-FU-497 (Phase 121): SWE 412 is registrar-scheduled in the evening
  // (Tue 17:20–20:00) and is the one capstone exempt from the R-06 window.
  if (R06_TIME_EXEMPT_COURSES.has(changed.courseCode)) return [];
  // NEW-FU-495 (Phase 120): capstone courses are NO LONGER time-exempt.
  // The prior Phase-51 logic let capstone meet any time (full day); that was
  // wrong. Every capstone is an Undergraduate Senior course, so it follows the
  // UG window (07:00–17:10) here — there is no longer a capstone early-return.
  // Capstone remains VENUE-exempt (see R05Rule, which keeps its isCapstone
  // early-return). External courses have no section row, so R-06 never runs.

  const window = TIME_WINDOWS[changed.category];
  if (!window) return [];

  const start = changed.startMinutes;
  const end   = changed.endMinutes;

  const withinWindow = start >= window.start && end <= window.end;
  if (withinWindow) return [];

  // Factual window string derived from the authoritative TIME_WINDOWS.
  const windowStr = `${fmt(window.start)}–${fmt(window.end)}`;

  return [new Conflict({
    id: null, scheduleId: changed.scheduleId,
    ruleId: RULE_IDS.R06, severity: SEVERITY.HARD,
    description:
      `${changed.courseCode} is an ${changed.category === 'UG' ? 'undergraduate' : 'graduate'} course ` +
      `but is scheduled at ${changed.startTime}–${changed.endTime} on ${changed.day}. ` +
      `${changed.category === 'UG' ? 'Undergraduate' : 'Graduate'} courses must run within ${windowStr}.`,
    sectionAId: changed.id, sectionBId: null,
  })];
}

module.exports = { evaluate };
