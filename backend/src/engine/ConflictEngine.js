/**
 * ConflictEngine
 *
 * Evaluates a single section change against all scheduling rules R-01 to R-06.
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
    const others = allSections.filter(s => s.id !== changed.id);

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

        // For two-section conflicts sort so A|B and B|A produce same key
        const key = c.sectionBId
          ? [idA, idB].sort().join('||') + '|' + c.ruleId
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
