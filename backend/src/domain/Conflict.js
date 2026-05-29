const { SEVERITY } = require('../config/constants');

// NEW-FU-76: removed the long-unused `sectionA` / `sectionB` joined-data
// fields. They were declared in the constructor and emitted by toJSON as
// `null` on every response, but no producer (ConflictRepository, engine
// rules) populated them and no consumer (SidePanel, ScheduleGrid) read
// them. Pure dead infrastructure that shipped in every conflict payload.
class Conflict {
  constructor({
    id, scheduleId, ruleId, severity, description,
    sectionAId, sectionBId = null, confirmed = false,
    createdAt,
    // NEW-FU-278/279: optional transient `fixes` array — rule-specific
    // remediation proposals. Currently only R-15 populates this (Phase 23
    // R-15 quick-fix), but the shape is open for any future rule that
    // wants to suggest concrete actions in the UI. `fixes` is NOT
    // persisted to the conflicts table; the engine recomputes on every
    // revalidate, so the database row stays small and stable.
    fixes = null,
  }) {
    this.id          = id;
    this.scheduleId  = scheduleId;
    this.ruleId      = ruleId;
    this.severity    = severity;       // 'Hard' | 'Soft'
    this.description = description;
    this.sectionAId  = sectionAId;
    this.sectionBId  = sectionBId;
    this.confirmed   = confirmed;      // true = user saved anyway (soft only)
    this.createdAt   = createdAt;
    this.fixes       = fixes;          // null or [{ kind, addDays, sectionId, label }]
  }

  get isHard() { return this.severity === SEVERITY.HARD; }
  get isSoft() { return this.severity === SEVERITY.SOFT; }

  toJSON() {
    const out = {
      id: this.id,
      scheduleId: this.scheduleId,
      ruleId: this.ruleId,
      severity: this.severity,
      description: this.description,
      sectionAId: this.sectionAId,
      sectionBId: this.sectionBId,
      confirmed: this.confirmed,
    };
    // Only include `fixes` when populated — keeps the response payload
    // small for the 95% of conflicts that don't have remediation hints.
    if (Array.isArray(this.fixes) && this.fixes.length > 0) {
      out.fixes = this.fixes;
    }
    return out;
  }
}

module.exports = Conflict;
