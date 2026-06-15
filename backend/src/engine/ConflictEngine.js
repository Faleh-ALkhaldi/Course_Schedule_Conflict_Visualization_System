/**
 * ConflictEngine
 *
 * Evaluates a single section change against rules R-01, R-02, R-04, R-05, R-06.
 * Single-section advisory rules are produced separately by
 * ScheduleService.revalidateSchedule:
 *   - R-09 (no instructor)                  — SectionRepository.validateOneInstructor
 *   - R-10 (no venue)                       — SectionRepository.validateOneVenue   [NEW-FU-91]
 *   - R-11 (Lab section in non-Lab venue)   — inline in _evaluateSchedule          [NEW-FU-97]
 *   - R-12 (Lec section in Lab venue)       — inline in _evaluateSchedule          [NEW-FU-98]
 *   - R-13 (instructor has no office hours) — inline in _evaluateSchedule          [NEW-FU-99]
 *   - R-14 (has_lab course missing Lec/Lab) — inline in _evaluateSchedule          [NEW-FU-107]
 * Rules R-07 and R-08 are auto-suggest-only structural rules enforced in SuggestService.
 * Each rule is an independent strategy; adding a new rule means adding one file
 * and registering it here — no other changes required.
 *
 * Usage:
 *   const engine = new ConflictEngine();
 *   const result = engine.evaluate(changedSection, allSections, officeHours);
 *   // result.canSave           → no hard conflicts
 *   // result.requiresConfirmation → soft conflicts only
 *   // result.conflicts         → full list for frontend highlighting
 */
const R01Rule = require('./rules/R01Rule');
const R02Rule = require('./rules/R02Rule');
const R04Rule = require('./rules/R04Rule');
const R05Rule = require('./rules/R05Rule');
const R06Rule = require('./rules/R06Rule');
const ConflictResult = require('../domain/ConflictResult');

class ConflictEngine {
  /**
   * @param {import('../domain/Section')}   changed      The section being assigned or moved
   * @param {import('../domain/Section')[]} allSections  All other sections in the schedule
   * @param {{ day, startTime, endTime }[]} officeHours  The changed section's instructor's OH
   * @returns {ConflictResult}
   */
  evaluate(changed, allSections, officeHours = []) {
    const result = new ConflictResult();
    // NEW-FU-275 (Phase 52 #5): external sections (SWE 399 internship)
    // are off-campus by design — instructor, venue, schedule, and even
    // the time-window check (R-06) don't apply. Short-circuit before any
    // rule runs.
    if (changed.isExternal) return result;
    // Also strip external siblings from the comparison set so a non-
    // external section doesn't fire R-01/R-02/R-04/R-05 against them.
    const others = allSections.filter(s => s.id !== changed.id && !s.isExternal);

    // R-06 first: if the time window itself is wrong, flag immediately
    for (const c of R06Rule.evaluate(changed)) result.add(c);

    // R-01: same-level overlap (hard)
    for (const c of R01Rule.evaluate(changed, others)) result.add(c);

    // R-02: single-section adjacent-level soft conflict
    //       (same-level hard already covered by R-01, still included in R02Rule for completeness)
    for (const c of R02Rule.evaluate(changed, others)) result.add(c);

    // R-04: instructor double-booking + office hours
    for (const c of R04Rule.evaluate(changed, others, officeHours)) result.add(c);

    // R-05: venue double-booking
    for (const c of R05Rule.evaluate(changed, others)) result.add(c);

    return result;
  }

  /**
   * Evaluate ALL sections in a schedule against each other.
   * Used on full-schedule load / re-validation.
   *
   * @param {import('../domain/Section')[]} sections
   * @param {Map<string, object[]>} officeHoursMap  instructorId → [{ day, startTime, endTime }]
   * @returns {ConflictResult}
   */
  evaluateAll(sections, officeHoursMap = new Map()) {
    const result = new ConflictResult();
    const seen   = new Set();   // deduplicate A+B / B+A pairs

    for (const section of sections) {
      const officeHours = officeHoursMap.get(section.instructorId) ?? [];
      const partial = this.evaluate(section, sections, officeHours);

      for (const c of partial.conflicts) {
        // Deduplicate using courseId+sectionNumber as canonical identifier
        // so that grouped sections (same course+section on Sun/Tue/Thu)
        // don't produce the same conflict multiple times.
        const secA = sections.find(s => s.id === c.sectionAId);
        const secB = c.sectionBId ? sections.find(s => s.id === c.sectionBId) : null;

        // Canonical ID for a section = courseId|sectionNumber (groups all days together)
        const idA = secA
          ? `${secA.courseId}|${secA.sectionNumber}`
          : c.sectionAId;
        const idB = secB
          ? `${secB.courseId}|${secB.sectionNumber}`
          : (c.sectionBId ?? 'none');

        // NEW-FU-54: for R-04 single-section conflicts (OH overlaps), each
        // OH the section overlaps is a distinct problem; the prior key
        // `idA + '|' + ruleId` collapsed them all into one entry, hiding
        // the second-and-onward OH overlaps. We include the description as
        // a per-OH discriminator ONLY for R-04 — for other single-section
        // rules (R-06, R-09) the conflict is a single group-level violation
        // (e.g., "this whole STT group is scheduled after 17:00 — UG must
        // be before 17:00") and the existing canonical-ID dedup correctly
        // collapses sibling days into one user-visible message.
        //
        // For two-section conflicts, the [idA, idB].sort() already gives
        // good dedup since pair semantics hold; no description needed.
        const isR04OhOverlap = c.ruleId === 'R-04' && !c.sectionBId;
        // NEW-FU-561 (audit P1-1): R-01 is a COURSE-pair violation, but each emitted
        // Conflict carries the per-call `changed` section as sectionAId, so the
        // section-pair key [idA,idB] varies across evaluate() calls and the SAME
        // course-pair conflict was admitted once per section — 3-9x duplicate HARD
        // cards (count = sectionsA + sectionsB - 1). Dedup R-01 by the unordered
        // COURSE pair (its description is already canonical per FU-80) so it
        // collapses to exactly one.
        const isR01Pair = c.ruleId === 'R-01' && c.sectionBId;
        const key = isR01Pair
          ? 'R-01|' + [secA?.courseId ?? c.sectionAId, secB?.courseId ?? c.sectionBId].sort().join('||')
          : c.sectionBId
            ? [idA, idB].sort().join('||') + '|' + c.ruleId
            : isR04OhOverlap
              ? idA + '|' + c.ruleId + '|' + (c.description ?? '')
              : idA + '|' + c.ruleId;

        if (!seen.has(key)) {
          seen.add(key);
          result.add(c);
        }
      }
    }

    return result;
  }
}

module.exports = ConflictEngine;
