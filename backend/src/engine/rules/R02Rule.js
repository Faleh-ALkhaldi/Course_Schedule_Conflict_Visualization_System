/**
 * R-02 — Single-Section Course Conflict
 *
 * Applies when the changed course has exactly ONE logical section in the schedule.
 * Since students have no alternative slot, any overlap with another same-level
 * course is always flagged.
 *
 * Severity depends on whether an escape exists in the OTHER course:
 *   - No escape (all sections of other course overlap) → HARD, blocks save
 *   - Escape exists (some sections of other course are free) → HARD but dismissible
 *     (user can acknowledge and save, since students CAN take both via the free section)
 *
 * Adjacent level (±1): always SOFT (scheduling preference, not requirement).
 * 2+ levels apart: no conflict.
 *
 * The conflict description always explains the escape situation clearly.
 */
const { SEVERITY, RULE_IDS, ACADEMIC_LEVELS } = require('../../config/constants');
const Conflict = require('../../domain/Conflict');
// NEW-FU-282 (Phase 56): use the shared label helper so female sections
// show up as "§F-XX" in conflict description text (display-only, no
// rule-logic change).
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

  const changedLevel = ACADEMIC_LEVELS[changed.academicLevel?.toUpperCase()];
  if (!changedLevel) return [];

  const all       = [changed, ...allSections];
  const courseMap = buildCourseMap(all);

  // R-02 ONLY applies when this course has exactly 1 logical section
  const changedSecMap  = courseMap.get(changed.courseId);
  const changedLogical = Array.from(changedSecMap?.values() ?? []);
  if (changedLogical.length !== 1) return [];

  const changedRows = changedLogical[0];
  const changedCode = changed.courseCode ?? changed.courseId;
  const conflicts   = [];

  for (const [otherCourseId, otherSecMap] of courseMap.entries()) {
    if (otherCourseId === changed.courseId) continue;

    const otherLogical = Array.from(otherSecMap.values());
    if (!otherLogical.length) continue;

    const otherLevel = ACADEMIC_LEVELS[otherLogical[0][0]?.academicLevel?.toUpperCase()];
    if (!otherLevel) continue;

    // NEW-FU-275 (Phase 52 #2): grad-grad overlap is allowed per user
    // directive — at the Graduate tier students elect between courses,
    // so a same-slot overlap is a choice, not a blocker. Skip when BOTH
    // sides are Graduate. Adjacent-level Senior↔Graduate still fires.
    if (changed.academicLevel === 'Graduate' &&
        otherLogical[0][0]?.academicLevel === 'Graduate') continue;

    const diff = Math.abs(changedLevel - otherLevel);
    if (diff > 1) continue;

    const overlapping = otherLogical.filter(logB => logicalOverlaps(changedRows, logB));
    if (overlapping.length === 0) continue;

    const freeOther  = otherLogical.filter(logB => !logicalOverlaps(changedRows, logB));
    const otherCode  = otherLogical[0][0]?.courseCode ?? otherCourseId;
    const otherLvl   = otherLogical[0][0]?.academicLevel ?? '';
    const repB       = overlapping[0][0];
    // NEW-FU-80: sort section numbers so the description is deterministic
    // across saves (see R01Rule for full rationale; same iteration-order
    // dependency on pg's unordered section result-set affects R-02).
    //
    // NEW-FU-282 (Phase 56): iterate entries (not keys) so we have the
    // section rows on hand — sectionLabel needs the gender field to pick
    // between "§XX" and "§F-XX". All rows in a logical-section bucket
    // share the same gender, so reading from rows[0] is safe.
    const secListAll = Array.from(otherSecMap.entries())
      .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
      .map(([, rows]) => sectionLabel(rows[0])).join(', ');

    if (diff === 0) {
      // Same level — Hard conflict
      // Whether it blocks save depends on escape availability (handled in AppContext/ScheduleService)
      // We mark it with a custom field so frontend knows

      let escapeMsg;
      const hasEscape = freeOther.length > 0;

      if (hasEscape) {
        // Escape exists → Soft warning (students CAN take both via free sections)
        // NEW-FU-80: sort the free-sections list by section number so the
        // description is deterministic across saves (same reason as
        // secListAll above — FU-78 signatures depend on description stability).
        const freeSecs = freeOther
          .map(logB => logB[0])
          .sort((a, b) => String(a?.sectionNumber ?? '').localeCompare(String(b?.sectionNumber ?? ''), undefined, { numeric: true }))
          .map(row => `${sectionLabel(row)} (${row?.day} ${(row?.startTime ?? '').substring(0,5)})`)
          .join(', ');
        conflicts.push(new Conflict({
          id: null, scheduleId: changed.scheduleId,
          ruleId: RULE_IDS.R02, severity: SEVERITY.SOFT,
          description:
            `${changedCode} (1 section, ${sectionLabel(changed)}) overlaps with ` +
            `${overlapping.length} of ${otherLogical.length} section${otherLogical.length>1?'s':''} ` +
            `of ${otherCode} (${otherLvl}, sections: ${secListAll}). ` +
            `Escape available: students can enroll in ${otherCode} ${freeSecs} to avoid the conflict.`,
          sectionAId: changed.id,
          sectionBId: repB?.id ?? null,
        }));
      } else {
        // No escape → Hard conflict, blocks save
        conflicts.push(new Conflict({
          id: null, scheduleId: changed.scheduleId,
          ruleId: RULE_IDS.R02, severity: SEVERITY.HARD,
          description:
            `${changedCode} has only 1 section (${sectionLabel(changed)}) and all ` +
            `${otherLogical.length} section${otherLogical.length>1?'s':''} of ${otherCode} ` +
            `(${otherLvl}, sections: ${secListAll}) overlap with it. ` +
            `Students cannot take both courses — no escape route exists.`,
          sectionAId: changed.id,
          sectionBId: repB?.id ?? null,
        }));
      }

    } else {
      // Adjacent level — always Soft
      const freeSecs = freeOther.length > 0
        ? ` ${otherCode} has ${freeOther.length} free section${freeOther.length>1?'s':''}.`
        : ` All sections of ${otherCode} overlap.`;

      conflicts.push(new Conflict({
        id: null, scheduleId: changed.scheduleId,
        ruleId: RULE_IDS.R02, severity: SEVERITY.SOFT,
        description:
          `${changedCode} (${changed.academicLevel}, 1 section) overlaps with ` +
          `${overlapping.length} of ${otherLogical.length} section${otherLogical.length>1?'s':''} ` +
          `of ${otherCode} (${otherLvl}).` +
          freeSecs +
          ` These levels are adjacent — consider scheduling them apart when possible.`,
        sectionAId: changed.id,
        sectionBId: repB?.id ?? null,
      }));
    }
  }

  return conflicts;
}

module.exports = { evaluate };
