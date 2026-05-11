/**
 * ConflictResult — the output of ConflictEngine.evaluate().
 *
 * Contains all detected violations for a schedule or a single section change.
 * The API layer uses this to:
 *   - decide whether to block save (any hard conflict present)
 *   - decide whether to show a confirmation popup (soft conflicts only)
 *   - return the conflict list to the frontend for highlight rendering
 */
class ConflictResult {
  constructor() {
    /** @type {import('./Conflict')[]} */
    this.conflicts = [];
  }

  add(conflict) {
    this.conflicts.push(conflict);
    return this;
  }

  get hardConflicts() {
    return this.conflicts.filter(c => c.isHard);
  }

  get softConflicts() {
    return this.conflicts.filter(c => c.isSoft);
  }

  get hasHard() { return this.hardConflicts.length > 0; }
  get hasSoft() { return this.softConflicts.length > 0; }
  get hasAny()  { return this.conflicts.length > 0; }

  /** True when the schedule can be saved without user interaction. */
  get canSave() { return !this.hasHard; }

  /** True when saving requires confirmation (soft conflicts present, no hard). */
  get requiresConfirmation() { return !this.hasHard && this.hasSoft; }

  toJSON() {
    return {
      canSave:              this.canSave,
      requiresConfirmation: this.requiresConfirmation,
      hardCount:            this.hardConflicts.length,
      softCount:            this.softConflicts.length,
      conflicts:            this.conflicts.map(c => c.toJSON()),
    };
  }
}

module.exports = ConflictResult;
