// NEW-FU-682: the ONE shared mechanism behind "complete an orphan lab course instead of dropping it".
//
// A Has-Laboratory course must have BOTH a Lecture AND a Lab. When the fix engine meets an ORPHAN
// section (a Lab with no Lecture — the only direction R-14 flags, see ScheduleService/SuggestService/
// QuickFixService — or, generically, a Lecture with no Lab) it used to DROP the orphan. This planner
// instead finds a CONFLICT-FREE placement for the MISSING half:
//   • a window-valid time slot (the section's UG/GR teaching window, legal lecture pattern / lab length),
//   • a free, TYPE-APPROPRIATE venue (a lecture hall for a Lecture, a lab for a Lab),
//   • a free instructor — one who has PREVIOUSLY TAUGHT this course (teaches one of its sections in the
//     term) is preferred, and among those an instructor who already has office hours is preferred so the
//     completed course raises no R-13; otherwise any free real instructor.
// It returns the placement, or null when no slot / venue / instructor is free — the caller then drops
// the orphan as a genuine last resort. PURE (no DB / no I/O): it unit-tests directly, and every fix-
// engine entry point (Quick Fix, Suggest, Copy-term auto-fix, add-section fix, import-time fix) reuses
// the exact same logic through QuickFixService, so the behavior can never diverge across paths.
const { legalPatternsForCourse } = require('./sectionPattern');
const { teachingWindowFor } = require('../config/constants');

function toMin(t) {
  if (!t) return NaN;
  const [h, m] = String(t).substring(0, 5).split(':').map(Number);
  return (Number.isFinite(h) && Number.isFinite(m)) ? h * 60 + m : NaN;
}
function fromMin(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function overlaps(s1, e1, s2, e2) {
  return toMin(s1) < toMin(e2) && toMin(s2) < toMin(e1);
}

const ALL_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
// A legal single-day lab length that fits inside the UG teaching day — keeps the (rare) add-a-Lab
// direction bounded. The common direction is add-a-Lecture, which uses legalPatternsForCourse.
const LAB_DURATION = 110;

// instructor free across EVERY meeting day of the candidate slot — no class overlap, no office-hour overlap.
function instructorFreeAt(instrId, days, start, end, sections, ohMap) {
  for (const sec of sections) {
    if (sec.instructorId !== instrId) continue;
    if (!days.includes(sec.day)) continue;
    if (overlaps(start, end, sec.startTime, sec.endTime)) return false;
  }
  for (const oh of (ohMap.get(instrId) || [])) {
    if (!days.includes(oh.day)) continue;
    if (overlaps(start, end, oh.startTime, oh.endTime)) return false;
  }
  return true;
}
function venueFreeAt(venueId, days, start, end, sections) {
  for (const sec of sections) {
    if (sec.venueId !== venueId) continue;
    if (!days.includes(sec.day)) continue;
    if (overlaps(start, end, sec.startTime, sec.endTime)) return false;
  }
  return true;
}
// Cheap cohort guard so the placement doesn't obviously create R-01 (the same course meeting itself
// twice at one time) or R-02 (a same-academic-level overlap). The caller's full conflict-engine simulate
// is the FINAL gate; this just steers the search toward slots that will pass it.
function cohortFreeAt(orphan, days, start, end, sections) {
  for (const sec of sections) {
    if (!days.includes(sec.day)) continue;
    if (!overlaps(start, end, sec.startTime, sec.endTime)) continue;
    if (sec.courseId === orphan.courseId) return false;
    if (sec.academicLevel && orphan.academicLevel && sec.academicLevel === orphan.academicLevel) return false;
  }
  return true;
}

// The day-patterns to try for the missing section type.
function candidatePatterns(missingType, credits) {
  if (missingType === 'Lab') {
    // Labs meet once a week on any single weekday.
    return ALL_WEEKDAYS.map(d => ({ days: [d], duration: LAB_DURATION }));
  }
  // Lecture of a Has-Laboratory course: the lab carries one credit, so the lecture is the 2-day,
  // 2×50-min pattern (legalPatternsForCourse already encodes this for hasLab=true).
  return legalPatternsForCourse({ credits: Number(credits) || 3, hasLab: true })
    .map(p => ({ days: p.days, duration: p.duration }));
}

/**
 * @param orphan       the existing orphan section (has courseId, courseCode, credits, academicLevel,
 *                     category, gender, sectionType).
 * @param sections     every section currently in the term (in-memory plan() shape).
 * @param instructors  the term's ASSIGNABLE instructors ({id, name, ...}) — already non-dummy.
 * @param venues       the term's ASSIGNABLE venues ({id, name, type, ...}) — already non-dummy.
 * @param ohMap        Map instructorId -> [{day,startTime,endTime}].
 * @returns { sectionType, gender, instructorId, instructorName, venueId, venueName, venueType,
 *            priorInstructor, rows:[{day,startTime,endTime}] }  or null.
 */
function planComplementSection(orphan, sections, instructors, venues, ohMap) {
  if (!orphan || !orphan.courseId) return null;
  const missingType = orphan.sectionType === 'Lab' ? 'Lec' : 'Lab';
  const gender = orphan.gender ?? 'M';

  const okVenueTypes = missingType === 'Lab' ? ['Laboratory', 'Multipurpose'] : ['LectureHall', 'Multipurpose'];
  const candVenues = (venues || []).filter(v => okVenueTypes.includes(v.type));
  if (!candVenues.length) return null;

  // PREVIOUSLY TAUGHT this course → teaches one of its sections in this term. Preferred, and among those
  // the ones who already have office hours first (so the completed course raises no R-13). Then any other
  // free instructor (real — the assignable pool excludes placeholders). Within each tier, OH-holders lead.
  const priorIds = new Set((sections || []).filter(s => s.courseId === orphan.courseId && s.instructorId).map(s => s.instructorId));
  const hasOH = (id) => (ohMap.get(id) || []).length > 0;
  const rank = (arr) => [...arr.filter(i => hasOH(i.id)), ...arr.filter(i => !hasOH(i.id))];
  const orderedInstr = [
    ...rank((instructors || []).filter(i => priorIds.has(i.id))),
    ...rank((instructors || []).filter(i => !priorIds.has(i.id))),
  ];
  if (!orderedInstr.length) return null;

  const win = teachingWindowFor({ category: orphan.category, courseCode: orphan.courseCode });

  for (const pat of candidatePatterns(missingType, orphan.credits)) {
    const { days, duration } = pat;
    for (let s = win.start; s + duration <= win.end; s += 30) {
      const start = fromMin(s), end = fromMin(s + duration);
      if (!cohortFreeAt(orphan, days, start, end, sections)) continue;
      const venue = candVenues.find(v => venueFreeAt(v.id, days, start, end, sections));
      if (!venue) continue;
      const instr = orderedInstr.find(i => instructorFreeAt(i.id, days, start, end, sections, ohMap));
      if (!instr) continue;
      return {
        sectionType:    missingType,
        gender,
        instructorId:   instr.id,
        instructorName: instr.name,
        venueId:        venue.id,
        venueName:      venue.name,
        venueType:      venue.type,
        priorInstructor: priorIds.has(instr.id),
        rows: days.map(d => ({ day: d, startTime: start, endTime: end })),
      };
    }
  }
  return null;
}

module.exports = { planComplementSection };
