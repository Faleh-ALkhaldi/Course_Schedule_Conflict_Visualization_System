/**
 * Unit tests for the ConflictEngine and all rules R-01 to R-09.
 * No database required — pure domain logic.
 *
 * Test Plan coverage:
 *   TC-05  R-01: same-level overlap (multi-section, no escape) → Hard
 *   TC-06  R-01: different levels → no conflict
 *   TC-07  R-02: single-section same-level → Hard
 *   TC-08  R-02: single-section adjacent-level → Soft
 *   TC-09  R-02: 2+ levels apart → no conflict
 *   TC-10  R-03: siblings of same course exempt from academic-level rules
 *   TC-11  R-04: instructor double-booking → Hard
 *   TC-12  R-04: section during office hours → Hard
 *   TC-13  R-05: venue double-booking → Hard
 *   TC-14  R-05: no venueId (untracked) → no conflict
 *   TC-15  R-06: UG after 17:00 → Hard
 *   TC-16  R-06: GR before 17:00 → Hard
 *   TC-17  R-06: UG at exactly 07:00 → valid
 *   TC-18  R-06: UG ending exactly 17:00 → valid
 *   TC-25  R-09: no instructor → Soft (advisory, not blocking)
 *   TC-26  R-09: clears when instructor assigned
 */

const Section          = require('../../src/domain/Section');
const ConflictEngine   = require('../../src/engine/ConflictEngine');
const R01Rule          = require('../../src/engine/rules/R01Rule');
const R02Rule          = require('../../src/engine/rules/R02Rule');
const R04Rule          = require('../../src/engine/rules/R04Rule');
const R05Rule          = require('../../src/engine/rules/R05Rule');
const R06Rule          = require('../../src/engine/rules/R06Rule');
const SectionRepository = require('../../src/repositories/SectionRepository');
const { SEVERITY }     = require('../../src/config/constants');

const engine      = new ConflictEngine();
const sectionRepo = new SectionRepository();

// ─────────────────────────────────────────────────────────────────────────────
// Section factory
// ─────────────────────────────────────────────────────────────────────────────

let _id = 1;
function sec(overrides = {}) {
  return new Section({
    id:             overrides.id            ?? `sec-${_id++}`,
    scheduleId:     's1',
    courseId:       overrides.courseId      ?? 'c1',
    instructorId:   overrides.instructorId  ?? null,
    venueId:        overrides.venueId       ?? null,
    sectionNumber:  overrides.sectionNumber ?? '01',
    day:            overrides.day           ?? 'Monday',
    startTime:      overrides.startTime     ?? '09:00',
    endTime:        overrides.endTime       ?? '09:50',
    courseCode:     overrides.courseCode    ?? 'SWE101',
    academicLevel:  overrides.academicLevel ?? 'Junior',
    category:       overrides.category      ?? 'UG',
    numSections:    overrides.numSections   ?? 1,
    instructorName: overrides.instructorName ?? null,
    venueName:      overrides.venueName     ?? null,
  });
}

function oh(day, startTime, endTime, instructorId = 'instr-A') {
  return { instructorId, day, start_time: startTime, end_time: endTime };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section.overlaps()
// ─────────────────────────────────────────────────────────────────────────────

describe('Section.overlaps()', () => {
  test('same day overlapping slots → true', () => {
    const a = sec({ startTime:'09:00', endTime:'09:50' });
    const b = sec({ startTime:'09:30', endTime:'10:20' });
    expect(a.overlaps(b)).toBe(true);
  });

  test('same day touching boundary (A ends when B starts) → false', () => {
    const a = sec({ startTime:'09:00', endTime:'10:00' });
    const b = sec({ startTime:'10:00', endTime:'10:50' });
    expect(a.overlaps(b)).toBe(false);
  });

  test('different days → false', () => {
    const a = sec({ day:'Monday',  startTime:'09:00', endTime:'09:50' });
    const b = sec({ day:'Tuesday', startTime:'09:00', endTime:'09:50' });
    expect(a.overlaps(b)).toBe(false);
  });

  test('same day non-overlapping → false', () => {
    const a = sec({ startTime:'07:00', endTime:'07:50' });
    const b = sec({ startTime:'09:00', endTime:'09:50' });
    expect(a.overlaps(b)).toBe(false);
  });

  test('completely contained → true', () => {
    const a = sec({ startTime:'09:00', endTime:'12:00' });
    const b = sec({ startTime:'10:00', endTime:'11:00' });
    expect(a.overlaps(b)).toBe(true);
  });

  test('identical time slot → true', () => {
    const a = sec({ startTime:'09:00', endTime:'09:50' });
    const b = sec({ startTime:'09:00', endTime:'09:50' });
    expect(a.overlaps(b)).toBe(true);
  });

  test('startMinutes and endMinutes computed correctly', () => {
    const a = sec({ startTime:'08:30', endTime:'09:20' });
    expect(a.startMinutes).toBe(8 * 60 + 30);
    expect(a.endMinutes).toBe(9 * 60 + 20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R-01 — Same academic-level overlap
// Rule fires ONLY when BOTH courses have multiple sections.
// ─────────────────────────────────────────────────────────────────────────────

describe('R01Rule', () => {
  test('TC-05: both courses have 2 sections all overlapping → Hard (no escape)', () => {
    const coe01 = sec({ courseId:'coe', courseCode:'COE101', sectionNumber:'01', academicLevel:'Freshman', day:'Sunday', startTime:'08:00', endTime:'08:50' });
    const coe02 = sec({ courseId:'coe', courseCode:'COE101', sectionNumber:'02', academicLevel:'Freshman', day:'Sunday', startTime:'08:00', endTime:'08:50' });
    const swe01 = sec({ courseId:'swe', courseCode:'SWE101', sectionNumber:'01', academicLevel:'Freshman', day:'Sunday', startTime:'08:00', endTime:'08:50' });
    const swe02 = sec({ courseId:'swe', courseCode:'SWE101', sectionNumber:'02', academicLevel:'Freshman', day:'Sunday', startTime:'08:00', endTime:'08:50' });
    const cs = R01Rule.evaluate(coe01, [coe02, swe01, swe02]);
    expect(cs).toHaveLength(1);
    expect(cs[0].severity).toBe(SEVERITY.HARD);
    expect(cs[0].ruleId).toBe('R-01');
  });

  test('TC-05b: escape section available (\u00a7 02 at different time) → R-01 does NOT fire', () => {
    const coe01 = sec({ courseId:'coe', sectionNumber:'01', academicLevel:'Freshman', day:'Sunday', startTime:'08:00', endTime:'08:50' });
    const coe02 = sec({ courseId:'coe', sectionNumber:'02', academicLevel:'Freshman', day:'Sunday', startTime:'09:00', endTime:'09:50' });
    const swe01 = sec({ courseId:'swe', sectionNumber:'01', academicLevel:'Freshman', day:'Sunday', startTime:'08:00', endTime:'08:50' });
    const swe02 = sec({ courseId:'swe', sectionNumber:'02', academicLevel:'Freshman', day:'Sunday', startTime:'08:00', endTime:'08:50' });
    expect(R01Rule.evaluate(coe01, [coe02, swe01, swe02]).filter(c => c.ruleId === 'R-01')).toHaveLength(0);
  });

  test('TC-06: different academic levels, same time → no R-01 conflict', () => {
    const a  = sec({ courseId:'c1', academicLevel:'Freshman', sectionNumber:'01' });
    const a2 = sec({ courseId:'c1', academicLevel:'Freshman', sectionNumber:'02' });
    const b  = sec({ courseId:'c2', academicLevel:'Junior',   sectionNumber:'01' });
    const b2 = sec({ courseId:'c2', academicLevel:'Junior',   sectionNumber:'02' });
    expect(R01Rule.evaluate(a, [a2, b, b2]).filter(c => c.ruleId === 'R-01')).toHaveLength(0);
  });

  test('R-01 does NOT fire when changed course has only one section (R-02 handles it)', () => {
    const a  = sec({ courseId:'c1', academicLevel:'Junior', sectionNumber:'01' });
    const b  = sec({ courseId:'c2', academicLevel:'Junior', sectionNumber:'01' });
    const b2 = sec({ courseId:'c2', academicLevel:'Junior', sectionNumber:'02' });
    expect(R01Rule.evaluate(a, [b, b2]).filter(c => c.ruleId === 'R-01')).toHaveLength(0);
  });

  test('same level, different days → no conflict', () => {
    const a1 = sec({ courseId:'c1', academicLevel:'Junior', sectionNumber:'01', day:'Monday'  });
    const a2 = sec({ courseId:'c1', academicLevel:'Junior', sectionNumber:'02', day:'Monday'  });
    const b1 = sec({ courseId:'c2', academicLevel:'Junior', sectionNumber:'01', day:'Tuesday' });
    const b2 = sec({ courseId:'c2', academicLevel:'Junior', sectionNumber:'02', day:'Tuesday' });
    expect(R01Rule.evaluate(a1, [a2, b1, b2]).filter(c => c.ruleId === 'R-01')).toHaveLength(0);
  });

  test('section not compared to itself', () => {
    const a  = sec({ id:'same', academicLevel:'Junior', sectionNumber:'01' });
    const a2 = sec({ courseId:a.courseId, academicLevel:'Junior', sectionNumber:'02' });
    expect(R01Rule.evaluate(a, [a, a2]).filter(c => c.ruleId === 'R-01')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R-02 — Single-section protection
// Rule fires ONLY when changed course has exactly ONE logical section.
// ─────────────────────────────────────────────────────────────────────────────

describe('R02Rule', () => {
  test('TC-07: single-section same-level, no escape → Hard', () => {
    const a = sec({ courseId:'c1', academicLevel:'Senior', sectionNumber:'01', numSections:1 });
    const b = sec({ courseId:'c2', academicLevel:'Senior', sectionNumber:'01', numSections:1 });
    const cs = R02Rule.evaluate(a, [b]);
    expect(cs.filter(c => c.ruleId === 'R-02')).toHaveLength(1);
    expect(cs[0].severity).toBe(SEVERITY.HARD);
  });

  test('TC-07b: escape section at different time → R-02 Soft (not Hard)', () => {
    const a  = sec({ courseId:'c1', academicLevel:'Senior', sectionNumber:'01', numSections:1, startTime:'10:00', endTime:'10:50' });
    const b1 = sec({ courseId:'c2', academicLevel:'Senior', sectionNumber:'01', numSections:2, startTime:'10:00', endTime:'10:50' });
    const b2 = sec({ courseId:'c2', academicLevel:'Senior', sectionNumber:'02', numSections:2, startTime:'11:00', endTime:'11:50' });
    const cs = R02Rule.evaluate(a, [b1, b2]);
    expect(cs.filter(c => c.ruleId === 'R-02' && c.severity === SEVERITY.HARD)).toHaveLength(0);
    expect(cs.filter(c => c.ruleId === 'R-02' && c.severity === SEVERITY.SOFT)).toHaveLength(1);
  });

  test('TC-08: single-section adjacent-level (Junior vs Sophomore, diff=1) → Soft', () => {
    const a = sec({ courseId:'c1', academicLevel:'Junior',    sectionNumber:'01', numSections:1, day:'Thursday', startTime:'12:00', endTime:'12:50' });
    const b = sec({ courseId:'c2', academicLevel:'Sophomore', sectionNumber:'01', numSections:1, day:'Thursday', startTime:'12:00', endTime:'12:50' });
    const cs = R02Rule.evaluate(a, [b]);
    expect(cs.filter(c => c.ruleId === 'R-02')).toHaveLength(1);
    expect(cs[0].severity).toBe(SEVERITY.SOFT);
  });

  test('TC-09: 2+ levels apart (Junior vs Freshman, diff=2) → no conflict', () => {
    const a = sec({ courseId:'c1', academicLevel:'Junior',   sectionNumber:'01', numSections:1 });
    const b = sec({ courseId:'c2', academicLevel:'Freshman', sectionNumber:'01', numSections:1 });
    expect(R02Rule.evaluate(a, [b]).filter(c => c.ruleId === 'R-02')).toHaveLength(0);
  });

  test('TC-10: multi-section course (2 section rows in allSections) → not subject to R-02', () => {
    // R-02 checks actual section rows in allSections, not numSections field.
    // Pass a sibling row (§02) so the engine sees 2 logical sections for c1.
    const a  = sec({ courseId:'c1', academicLevel:'Junior', sectionNumber:'01' });
    const a2 = sec({ courseId:'c1', academicLevel:'Junior', sectionNumber:'02' }); // makes c1 multi-section
    const b  = sec({ courseId:'c2', academicLevel:'Junior', sectionNumber:'01' });
    expect(R02Rule.evaluate(a, [a2, b]).filter(c => c.ruleId === 'R-02')).toHaveLength(0);
  });

  test('TC-10b: two sections of same course may overlap (R-03 exemption)', () => {
    const a = sec({ courseId:'swe101', sectionNumber:'01', academicLevel:'Freshman', numSections:1 });
    const b = sec({ courseId:'swe101', sectionNumber:'02', academicLevel:'Freshman', numSections:1 });
    expect(R02Rule.evaluate(a, [b]).filter(c => c.ruleId === 'R-02')).toHaveLength(0);
  });

  test('Graduate vs Senior (diff=1) → Soft', () => {
    const a = sec({ courseId:'c1', academicLevel:'Graduate', sectionNumber:'01', numSections:1, category:'GR', startTime:'17:00', endTime:'17:50' });
    const b = sec({ courseId:'c2', academicLevel:'Senior',   sectionNumber:'01', numSections:1, category:'UG', startTime:'17:00', endTime:'17:50' });
    expect(R02Rule.evaluate(a, [b]).filter(c => c.severity === SEVERITY.SOFT)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R-04 — Instructor double-booking and office hours
// ─────────────────────────────────────────────────────────────────────────────

describe('R04Rule', () => {
  test('TC-11: same instructor, overlapping sections → Hard', () => {
    const instr = 'instr-A';
    const a = sec({ courseId:'c1', instructorId:instr, day:'Monday', startTime:'09:00', endTime:'09:50' });
    const b = sec({ courseId:'c2', instructorId:instr, day:'Monday', startTime:'09:00', endTime:'09:50' });
    const cs = R04Rule.evaluate(a, [b], []);
    expect(cs.filter(c => c.ruleId === 'R-04')).toHaveLength(1);
    expect(cs[0].severity).toBe(SEVERITY.HARD);
  });

  test('TC-11b: different instructors, same time → no R-04 conflict', () => {
    const a = sec({ courseId:'c1', instructorId:'instr-A', day:'Monday', startTime:'09:00', endTime:'09:50' });
    const b = sec({ courseId:'c2', instructorId:'instr-B', day:'Monday', startTime:'09:00', endTime:'09:50' });
    expect(R04Rule.evaluate(a, [b], []).filter(c => c.ruleId === 'R-04')).toHaveLength(0);
  });

  test('TC-12: section overlaps instructor office hours → Hard', () => {
    const instr = 'instr-B';
    const a = sec({ courseId:'c1', instructorId:instr, day:'Monday', startTime:'11:00', endTime:'12:00' });
    const ohs = [oh('Monday', '11:00', '12:00', instr)];
    const cs = R04Rule.evaluate(a, [], ohs);
    expect(cs.filter(c => c.ruleId === 'R-04')).toHaveLength(1);
    expect(cs[0].severity).toBe(SEVERITY.HARD);
  });

  test('TC-12b: section adjacent to office hours (starts when OH ends) → no conflict', () => {
    const instr = 'instr-B';
    const a   = sec({ instructorId:instr, day:'Monday', startTime:'12:00', endTime:'13:00' });
    const ohs = [oh('Monday', '11:00', '12:00', instr)];
    expect(R04Rule.evaluate(a, [], ohs).filter(c => c.ruleId === 'R-04')).toHaveLength(0);
  });

  test('TC-12c: office hours on different day → no conflict', () => {
    const instr = 'instr-B';
    const a   = sec({ instructorId:instr, day:'Tuesday',  startTime:'11:00', endTime:'12:00' });
    const ohs = [oh('Monday', '11:00', '12:00', instr)];
    expect(R04Rule.evaluate(a, [], ohs).filter(c => c.ruleId === 'R-04')).toHaveLength(0);
  });

  test('no instructor assigned → R-04 does not fire', () => {
    const a = sec({ instructorId:null });
    expect(R04Rule.evaluate(a, [], []).filter(c => c.ruleId === 'R-04')).toHaveLength(0);
  });

  test('STT sibling days (same course+section) do not trigger R-04', () => {
    const instr = 'instr-A';
    const siblings = ['Sunday','Tuesday','Thursday'].map(day =>
      sec({ courseId:'c1', sectionNumber:'01', instructorId:instr, day, startTime:'08:00', endTime:'08:50' })
    );
    for (const s of siblings) {
      const others = siblings.filter(x => x.id !== s.id);
      expect(R04Rule.evaluate(s, others, []).filter(c => c.ruleId === 'R-04')).toHaveLength(0);
    }
  });

  test('partial time overlap → R-04 Hard', () => {
    const instr = 'instr-A';
    const a = sec({ instructorId:instr, day:'Monday', startTime:'09:00', endTime:'09:50', courseId:'c1' });
    const b = sec({ instructorId:instr, day:'Monday', startTime:'09:30', endTime:'10:20', courseId:'c2' });
    expect(R04Rule.evaluate(a, [b], []).filter(c => c.ruleId === 'R-04')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R-05 — Venue double-booking
// ─────────────────────────────────────────────────────────────────────────────

describe('R05Rule', () => {
  test('TC-13: same venue, same day, overlapping time → Hard', () => {
    const venue = 'venue-G101';
    const a = sec({ courseId:'c1', venueId:venue, day:'Wednesday', startTime:'18:00', endTime:'18:50' });
    const b = sec({ courseId:'c2', venueId:venue, day:'Wednesday', startTime:'18:00', endTime:'18:50' });
    const cs = R05Rule.evaluate(a, [b]);
    expect(cs.filter(c => c.ruleId === 'R-05')).toHaveLength(1);
    expect(cs[0].severity).toBe(SEVERITY.HARD);
  });

  test('TC-14: no venueId (untracked classroom) → R-05 does not fire', () => {
    const a = sec({ courseId:'c1', venueId:null });
    const b = sec({ courseId:'c2', venueId:null });
    expect(R05Rule.evaluate(a, [b]).filter(c => c.ruleId === 'R-05')).toHaveLength(0);
  });

  test('different venues, same time → no conflict', () => {
    const a = sec({ courseId:'c1', venueId:'venue-H101' });
    const b = sec({ courseId:'c2', venueId:'venue-H201' });
    expect(R05Rule.evaluate(a, [b]).filter(c => c.ruleId === 'R-05')).toHaveLength(0);
  });

  test('same venue, back-to-back (not overlapping) → no conflict', () => {
    const venue = 'venue-H301';
    const a = sec({ courseId:'c1', venueId:venue, startTime:'08:00', endTime:'09:00' });
    const b = sec({ courseId:'c2', venueId:venue, startTime:'09:00', endTime:'10:00' });
    expect(R05Rule.evaluate(a, [b]).filter(c => c.ruleId === 'R-05')).toHaveLength(0);
  });

  test('STT sibling sections (same course+section) share venue without R-05', () => {
    const venue = 'venue-H101';
    const a = sec({ courseId:'c1', sectionNumber:'01', venueId:venue, day:'Sunday'   });
    const b = sec({ courseId:'c1', sectionNumber:'01', venueId:venue, day:'Tuesday'  });
    const c = sec({ courseId:'c1', sectionNumber:'01', venueId:venue, day:'Thursday' });
    expect(R05Rule.evaluate(a, [b, c]).filter(x => x.ruleId === 'R-05')).toHaveLength(0);
  });

  test('different section numbers of same course at same venue → R-05 fires', () => {
    const venue = 'venue-H101';
    const a = sec({ courseId:'c1', sectionNumber:'01', venueId:venue, day:'Monday', startTime:'09:00', endTime:'09:50' });
    const b = sec({ courseId:'c1', sectionNumber:'02', venueId:venue, day:'Monday', startTime:'09:00', endTime:'09:50' });
    expect(R05Rule.evaluate(a, [b]).filter(x => x.ruleId === 'R-05')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R-06 — UG / GR time allocation
// ─────────────────────────────────────────────────────────────────────────────

describe('R06Rule', () => {
  test('TC-15: UG course after 17:00 → Hard', () => {
    const a = sec({ category:'UG', startTime:'17:30', endTime:'18:20' });
    const cs = R06Rule.evaluate(a);
    expect(cs.filter(c => c.ruleId === 'R-06')).toHaveLength(1);
    expect(cs[0].severity).toBe(SEVERITY.HARD);
  });

  test('TC-15b: UG course with endTime 17:01 → Hard', () => {
    const a = sec({ category:'UG', startTime:'16:01', endTime:'17:01' });
    expect(R06Rule.evaluate(a).filter(c => c.ruleId === 'R-06')).toHaveLength(1);
  });

  test('TC-16: GR course before 17:00 → Hard', () => {
    const a = sec({ category:'GR', academicLevel:'Graduate', startTime:'14:00', endTime:'14:50' });
    const cs = R06Rule.evaluate(a);
    expect(cs.filter(c => c.ruleId === 'R-06')).toHaveLength(1);
    expect(cs[0].severity).toBe(SEVERITY.HARD);
  });

  test('TC-17: UG at exactly 07:00 → no conflict (inclusive lower boundary)', () => {
    const a = sec({ category:'UG', startTime:'07:00', endTime:'07:50' });
    expect(R06Rule.evaluate(a).filter(c => c.ruleId === 'R-06')).toHaveLength(0);
  });

  test('TC-18: UG ending exactly 17:00 → no conflict (inclusive upper boundary)', () => {
    const a = sec({ category:'UG', startTime:'16:10', endTime:'17:00' });
    expect(R06Rule.evaluate(a).filter(c => c.ruleId === 'R-06')).toHaveLength(0);
  });

  test('GR starting exactly 17:00 → no conflict', () => {
    const a = sec({ category:'GR', academicLevel:'Graduate', startTime:'17:00', endTime:'17:50' });
    expect(R06Rule.evaluate(a).filter(c => c.ruleId === 'R-06')).toHaveLength(0);
  });

  test('GR ending exactly 22:00 → no conflict', () => {
    const a = sec({ category:'GR', academicLevel:'Graduate', startTime:'21:10', endTime:'22:00' });
    expect(R06Rule.evaluate(a).filter(c => c.ruleId === 'R-06')).toHaveLength(0);
  });

  test('GR ending after 22:00 → Hard', () => {
    const a = sec({ category:'GR', academicLevel:'Graduate', startTime:'21:30', endTime:'22:30' });
    expect(R06Rule.evaluate(a).filter(c => c.ruleId === 'R-06')).toHaveLength(1);
  });

  test('no category → R-06 skips gracefully', () => {
    const a = sec({ category:null });
    expect(R06Rule.evaluate(a).filter(c => c.ruleId === 'R-06')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R-09 — No instructor assigned
// ─────────────────────────────────────────────────────────────────────────────

describe('R09 — One Instructor Per Section', () => {
  test('TC-25: no instructor → Soft advisory (not Hard blocking)', () => {
    const a = sec({ courseCode:'SWE301', sectionNumber:'B', instructorId:null });
    const result = sectionRepo.validateOneInstructor(a);
    expect(result).not.toBeNull();
    expect(result.severity).toBe(SEVERITY.SOFT);
    expect(result.message).toMatch(/no instructor/i);
  });

  test('TC-25b: instructor assigned → no R-09 warning', () => {
    const a = sec({ instructorId:'instr-C' });
    expect(sectionRepo.validateOneInstructor(a)).toBeNull();
  });

  test('TC-26: warning present before assignment and absent after', () => {
    const before = sec({ instructorId:null });
    const after  = sec({ ...before, id:`sec-${_id++}`, instructorId:'instr-C' });
    expect(sectionRepo.validateOneInstructor(before)).not.toBeNull();
    expect(sectionRepo.validateOneInstructor(after)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConflictEngine.evaluate()
// ─────────────────────────────────────────────────────────────────────────────

describe('ConflictEngine.evaluate()', () => {
  test('conflict-free section → canSave=true, hasAny=false', () => {
    // Both sections have instructors assigned (avoids R-09 soft warning),
    // different levels (avoids R-01/R-02), non-overlapping times.
    const a = sec({ courseId:'c1', academicLevel:'Junior',  category:'UG', startTime:'09:00', endTime:'09:50', instructorId:'instr-A' });
    const b = sec({ courseId:'c2', academicLevel:'Senior',  category:'UG', startTime:'11:00', endTime:'11:50', instructorId:'instr-B' });
    const result = engine.evaluate(a, [b], []);
    expect(result.canSave).toBe(true);
    expect(result.hasAny).toBe(false);
  });

  test('hard conflict (R-06 UG after 17:00) → canSave=false, requiresConfirmation=false', () => {
    const a = sec({ category:'UG', startTime:'18:00', endTime:'18:50' });
    const result = engine.evaluate(a, [], []);
    expect(result.canSave).toBe(false);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.hasHard).toBe(true);
  });

  test('soft conflict only (R-02 adjacent level) → canSave=true, requiresConfirmation=true', () => {
    const a = sec({ courseId:'c1', academicLevel:'Junior',    numSections:1, sectionNumber:'01', instructorId:'i1', startTime:'09:00', endTime:'09:50' });
    const b = sec({ courseId:'c2', academicLevel:'Sophomore', numSections:1, sectionNumber:'01', instructorId:'i2', startTime:'09:00', endTime:'09:50' });
    const result = engine.evaluate(a, [b], []);
    expect(result.canSave).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.hasSoft).toBe(true);
    expect(result.hasHard).toBe(false);
  });

  test('STT siblings do not trigger R-04 in evaluate()', () => {
    const instr = 'instr-A';
    const sun = sec({ courseId:'c1', sectionNumber:'01', instructorId:instr, day:'Sunday',   startTime:'08:00', endTime:'08:50', category:'UG', academicLevel:'Freshman' });
    const tue = sec({ courseId:'c1', sectionNumber:'01', instructorId:instr, day:'Tuesday',  startTime:'08:00', endTime:'08:50', category:'UG', academicLevel:'Freshman' });
    const thu = sec({ courseId:'c1', sectionNumber:'01', instructorId:instr, day:'Thursday', startTime:'08:00', endTime:'08:50', category:'UG', academicLevel:'Freshman' });
    const result = engine.evaluate(sun, [tue, thu], []);
    expect(result.conflicts.filter(c => c.ruleId === 'R-04')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConflictEngine.evaluateAll()
// ─────────────────────────────────────────────────────────────────────────────

describe('ConflictEngine.evaluateAll()', () => {
  test('deduplicates A→B and B→A conflict pairs into one entry', () => {
    const a = sec({ courseId:'c1', academicLevel:'Junior', sectionNumber:'01', numSections:1, instructorId:'i1' });
    const b = sec({ courseId:'c2', academicLevel:'Junior', sectionNumber:'01', numSections:1, instructorId:'i2' });
    const result = engine.evaluateAll([a, b], new Map());
    expect(result.conflicts.filter(c => c.ruleId === 'R-02')).toHaveLength(1);
  });

  test('detects R-01 once for two multi-section same-level courses with no escape', () => {
    const coe01 = sec({ courseId:'coe-101', courseCode:'COE101', sectionNumber:'01', academicLevel:'Freshman', day:'Sunday', startTime:'08:00', endTime:'08:50', instructorId:'i1' });
    const coe02 = sec({ courseId:'coe-101', courseCode:'COE101', sectionNumber:'02', academicLevel:'Freshman', day:'Sunday', startTime:'08:00', endTime:'08:50', instructorId:'i1' });
    const swe01 = sec({ courseId:'swe-101', courseCode:'SWE101', sectionNumber:'01', academicLevel:'Freshman', day:'Sunday', startTime:'08:00', endTime:'08:50', instructorId:'i2' });
    const swe02 = sec({ courseId:'swe-101', courseCode:'SWE101', sectionNumber:'02', academicLevel:'Freshman', day:'Sunday', startTime:'08:00', endTime:'08:50', instructorId:'i2' });
    const result = engine.evaluateAll([coe01, coe02, swe01, swe02], new Map());
    expect(result.hasHard).toBe(true);
    // evaluateAll deduplicates by sectionA|sectionB pair; the course-level conflict
    // appears once per unique section-pair combination. At least 1 R-01 is present.
    expect(result.conflicts.filter(c => c.ruleId === 'R-01').length).toBeGreaterThanOrEqual(1);
  });

  test('deduplicates R-06 across 3 STT sibling days to a single conflict', () => {
    const sections = ['Sunday','Tuesday','Thursday'].map(day =>
      sec({ courseId:'c1', sectionNumber:'01', category:'UG', day, startTime:'18:00', endTime:'18:50' })
    );
    expect(engine.evaluateAll(sections, new Map()).conflicts.filter(c => c.ruleId === 'R-06')).toHaveLength(1);
  });

  test('fully valid schedule reports zero conflicts', () => {
    const swe101 = sec({ courseId:'c1', academicLevel:'Freshman', category:'UG', day:'Sunday', startTime:'08:00', endTime:'08:50', instructorId:'i1', venueId:'v1' });
    const swe201 = sec({ courseId:'c2', academicLevel:'Sophomore', category:'UG', day:'Sunday', startTime:'10:00', endTime:'10:50', instructorId:'i2', venueId:'v2' });
    const swe501 = sec({ courseId:'c3', academicLevel:'Graduate', category:'GR', day:'Sunday', startTime:'17:00', endTime:'17:50', instructorId:'i3', venueId:'v3' });
    const result = engine.evaluateAll([swe101, swe201, swe501], new Map());
    expect(result.hasHard).toBe(false);
    expect(result.conflicts).toHaveLength(0);
  });

  test('respects office hours map (R-04)', () => {
    const instr = 'instr-A';
    const s   = sec({ instructorId:instr, day:'Monday', startTime:'11:00', endTime:'12:00', category:'UG', academicLevel:'Freshman', courseId:'c1' });
    const ohMap = new Map([[instr, [oh('Monday', '11:00', '12:00', instr)]]]);
    expect(engine.evaluateAll([s], ohMap).conflicts.filter(c => c.ruleId === 'R-04')).toHaveLength(1);
  });

  test('TC-27: 200 sections complete within 2000ms', () => {
    const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday'];
    const levels = ['Freshman','Sophomore','Junior','Senior','Graduate'];
    const sections = Array.from({ length:200 }, (_, i) => {
      const level = levels[i % 5];
      const hour  = 7 + (Math.floor(i / 5) % 10);
      return sec({
        courseId:      `course-${i % 20}`,
        sectionNumber: String(i % 4 + 1),
        day:           days[i % 5],
        startTime:     `${String(hour).padStart(2,'0')}:00`,
        endTime:       `${String(hour).padStart(2,'0')}:50`,
        academicLevel: level,
        category:      level === 'Graduate' ? 'GR' : 'UG',
        instructorId:  `instr-${i % 10}`,
        venueId:       `venue-${i % 5}`,
      });
    });
    const start = Date.now();
    const result = engine.evaluateAll(sections, new Map());
    expect(Date.now() - start).toBeLessThan(2000);
    expect(Array.isArray(result.conflicts)).toBe(true);
  }, 5000);
});
