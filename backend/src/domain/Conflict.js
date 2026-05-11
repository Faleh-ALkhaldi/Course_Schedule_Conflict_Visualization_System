const { SEVERITY } = require('../config/constants');

class Conflict {
  constructor({
    id, scheduleId, ruleId, severity, description,
    sectionAId, sectionBId = null, confirmed = false,
    createdAt,
    // Optional joined section data for API responses
    sectionA = null, sectionB = null,
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
    this.sectionA    = sectionA;
    this.sectionB    = sectionB;
  }

  get isHard() { return this.severity === SEVERITY.HARD; }
  get isSoft() { return this.severity === SEVERITY.SOFT; }

  toJSON() {
    return {
      id: this.id,
      scheduleId: this.scheduleId,
      ruleId: this.ruleId,
      severity: this.severity,
      description: this.description,
      sectionAId: this.sectionAId,
      sectionBId: this.sectionBId,
      confirmed: this.confirmed,
      sectionA: this.sectionA,
      sectionB: this.sectionB,
    };
  }
}

module.exports = Conflict;
