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
    // NEW-FU-93: forward new domain fields so R-11/R-12 tests can probe them.
    sectionType:    overrides.sectionType,
    venueType:      overrides.venueType,
    hasLab:         overrides.hasLab,
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

  // ───────────────────────────────────────────────────────────────────────
  // Batch 5 Issue 1 — NO false positive: R-02 must NOT fire when the two
  // courses meet at genuinely non-overlapping times. The reported symptom was
  // "a conflict shows even though the classes are not at the same time." These
  // lock the overlap gate (R02Rule.logicalOverlaps) against regression — every
  // case below has a real time/day separation and MUST yield zero R-02.
  // ───────────────────────────────────────────────────────────────────────
  describe('Batch 5 Issue 1 — no false-positive overlaps', () => {
    test('same-level, different time slots (no overlap) → no R-02', () => {
      const a = sec({ courseId:'c1', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Sunday', startTime:'08:00', endTime:'08:50' });
      const b = sec({ courseId:'c2', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Sunday', startTime:'10:00', endTime:'10:50' });
      expect(R02Rule.evaluate(a, [b]).filter(c => c.ruleId === 'R-02')).toHaveLength(0);
    });

    test('same-level, back-to-back (A ends exactly when B starts) → no R-02', () => {
      const a = sec({ courseId:'c1', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Sunday', startTime:'09:00', endTime:'10:00' });
      const b = sec({ courseId:'c2', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Sunday', startTime:'10:00', endTime:'10:50' });
      expect(R02Rule.evaluate(a, [b]).filter(c => c.ruleId === 'R-02')).toHaveLength(0);
    });

    test('adjacent-level, different days, same clock time → no R-02', () => {
      const a = sec({ courseId:'c1', academicLevel:'Junior',    sectionNumber:'01', numSections:1, day:'Monday',  startTime:'12:00', endTime:'12:50' });
      const b = sec({ courseId:'c2', academicLevel:'Sophomore', sectionNumber:'01', numSections:1, day:'Tuesday', startTime:'12:00', endTime:'12:50' });
      expect(R02Rule.evaluate(a, [b]).filter(c => c.ruleId === 'R-02')).toHaveLength(0);
    });

    test('multi-day logical section: fires ONLY on the overlapping day, not the free one', () => {
      // A is one logical section meeting Sun 08:00 AND Tue 08:00. B (same level)
      // meets only Tue 08:00. They overlap on Tue → exactly ONE R-02. The Sunday
      // meeting (where B has nothing) must not manufacture a second/phantom hit.
      const aSun = sec({ courseId:'c1', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Sunday',  startTime:'08:00', endTime:'08:50' });
      const aTue = sec({ courseId:'c1', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Tuesday', startTime:'08:00', endTime:'08:50' });
      const bTue = sec({ courseId:'c2', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Tuesday', startTime:'08:00', endTime:'08:50' });
      const cs = R02Rule.evaluate(aSun, [aTue, bTue]).filter(c => c.ruleId === 'R-02');
      expect(cs).toHaveLength(1);
      expect(cs[0].severity).toBe(SEVERITY.HARD); // single section each, no escape
    });

    test('multi-day logical section with NO shared day → no R-02', () => {
      // A meets Sun+Tue; B meets Mon+Wed. No common day at all → no overlap.
      const aSun = sec({ courseId:'c1', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Sunday',    startTime:'08:00', endTime:'08:50' });
      const aTue = sec({ courseId:'c1', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Tuesday',   startTime:'08:00', endTime:'08:50' });
      const bMon = sec({ courseId:'c2', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Monday',    startTime:'08:00', endTime:'08:50' });
      const bWed = sec({ courseId:'c2', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Wednesday', startTime:'08:00', endTime:'08:50' });
      expect(R02Rule.evaluate(aSun, [aTue, bMon, bWed]).filter(c => c.ruleId === 'R-02')).toHaveLength(0);
    });

    test('malformed time on one side cannot fabricate an overlap (FU-468)', () => {
      const a = sec({ courseId:'c1', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Sunday', startTime:'09:00', endTime:'09:50' });
      const b = sec({ courseId:'c2', academicLevel:'Senior', sectionNumber:'01', numSections:1, day:'Sunday', startTime:'',      endTime:''      });
      expect(R02Rule.evaluate(a, [b]).filter(c => c.ruleId === 'R-02')).toHaveLength(0);
    });
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

  test('TC-15b: UG course ending 17:11 → Hard (UG window ends 17:10)', () => {
    const a = sec({ category:'UG', startTime:'16:11', endTime:'17:11' });
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

  test('GR starting exactly 17:20 → no conflict (inclusive lower boundary)', () => {
    const a = sec({ category:'GR', academicLevel:'Graduate', startTime:'17:20', endTime:'18:10' });
    expect(R06Rule.evaluate(a).filter(c => c.ruleId === 'R-06')).toHaveLength(0);
  });

  test('GR in the 17:10–17:20 gap (e.g. 17:00) → Hard', () => {
    const a = sec({ category:'GR', academicLevel:'Graduate', startTime:'17:00', endTime:'17:50' });
    expect(R06Rule.evaluate(a).filter(c => c.ruleId === 'R-06')).toHaveLength(1);
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
// R-10 — No venue assigned (NEW-FU-91)
// Parallel to R-09 (missing instructor). Some sections legitimately run in
// regular departmental classrooms not tracked in the venues table — so the
// constraint is Soft, not Hard. The user can save anyway via soft-confirm.
// ─────────────────────────────────────────────────────────────────────────────

describe('R10 — One Venue Per Section (NEW-FU-91)', () => {
  test('TC-28: no venue → Soft advisory (not Hard blocking)', () => {
    const a = sec({ courseCode:'SWE301', sectionNumber:'B', venueId:null });
    const result = sectionRepo.validateOneVenue(a);
    expect(result).not.toBeNull();
    expect(result.severity).toBe(SEVERITY.SOFT);
    expect(result.message).toMatch(/no venue/i);
  });

  test('TC-28b: venue assigned → no R-10 warning', () => {
    const a = sec({ venueId:'venue-X' });
    expect(sectionRepo.validateOneVenue(a)).toBeNull();
  });

  test('TC-29: warning present before assignment and absent after', () => {
    const before = sec({ venueId:null });
    const after  = sec({ ...before, id:`sec-${_id++}`, venueId:'venue-X' });
    expect(sectionRepo.validateOneVenue(before)).not.toBeNull();
    expect(sectionRepo.validateOneVenue(after)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section-number format helper (NEW-FU-95 / NEW-FU-510)
// The DB CHECK + controller regex agree on '01'..'99' (two-digit, zero-padded).
// NEW-FU-510 (Batch 1): a bare single digit ("2") is now ACCEPTED — the
// controller normalizes it to its padded form ("02") before validating and
// storing. We mirror padSectionNumber() here (same logic as
// backend/src/controllers/index.js + frontend/src/utils/sectionNumber.js) and
// exercise the normalize-then-validate path so the new behavior is locked in.
// ─────────────────────────────────────────────────────────────────────────────

describe('Section number format (NEW-FU-95 / NEW-FU-510)', () => {
  const SECTION_NUM_RE = /^(0[1-9]|[1-9][0-9])$/;
  // Mirror of padSectionNumber: a single 0–9 digit is zero-padded; anything
  // else is returned trimmed and unchanged.
  const pad = s => { const t = String(s ?? '').trim(); return /^[0-9]$/.test(t) ? t.padStart(2,'0') : t; };
  const accepts = s => SECTION_NUM_RE.test(pad(s));
  test('TC-30: "01" through "09" are valid', () => {
    for (const n of ['01','02','03','04','05','06','07','08','09']) {
      expect(SECTION_NUM_RE.test(n)).toBe(true);
    }
  });
  test('TC-30b: "10" through "99" are valid', () => {
    for (const n of ['10','42','77','99']) {
      expect(SECTION_NUM_RE.test(n)).toBe(true);
    }
  });
  test('TC-31: "00" is invalid (no zero section)', () => {
    expect(SECTION_NUM_RE.test('00')).toBe(false);
  });
  test('TC-31b: single digits 1–9 are accepted (normalized to "01"–"09")', () => {
    for (const n of ['1','2','3','4','5','6','7','8','9']) {
      expect(pad(n)).toBe('0' + n);
      expect(accepts(n)).toBe(true);
    }
  });
  test('TC-31b2: "0" normalizes to "00" and is still rejected; triple-digit invalid', () => {
    expect(pad('0')).toBe('00');
    expect(accepts('0')).toBe(false);
    expect(accepts('100')).toBe(false);
  });
  test('TC-31c: letters/symbols are invalid', () => {
    expect(accepts('A')).toBe(false);
    expect(accepts('1A')).toBe(false);
    expect(accepts('01a')).toBe(false);
    // A leading/trailing space around a two-digit value is trimmed then valid…
    expect(accepts(' 01')).toBe(true);
    // …but the raw regex (no normalization) still rejects the spaced form.
    expect(SECTION_NUM_RE.test(' 01')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R-11, R-12 — venue-type mismatch predicates (NEW-FU-97 / NEW-FU-98)
// The rules live inline in ScheduleService._evaluateSchedule; here we
// exercise the predicate logic on Section domain objects.
// ─────────────────────────────────────────────────────────────────────────────

function isR11Hit(s) { return !!s.venueId && s.sectionType === 'Lab' && s.venueType && s.venueType !== 'Laboratory'; }
function isR12Hit(s) { return !!s.venueId && s.sectionType === 'Lec' && s.venueType === 'Laboratory'; }

describe('R11 — Lab section in non-Lab venue (NEW-FU-97)', () => {
  test('TC-32: Lab section in LectureHall → R-11 fires', () => {
    const a = sec({ sectionType:'Lab', venueId:'v-1', venueType:'LectureHall' });
    expect(isR11Hit(a)).toBe(true);
    expect(isR12Hit(a)).toBe(false);
  });
  test('TC-32b: Lab section in Laboratory → R-11 does NOT fire', () => {
    const a = sec({ sectionType:'Lab', venueId:'v-1', venueType:'Laboratory' });
    expect(isR11Hit(a)).toBe(false);
  });
  test('TC-32c: no venue assigned → R-11 deferred to R-10 (does NOT fire)', () => {
    const a = sec({ sectionType:'Lab', venueId:null, venueType:null });
    expect(isR11Hit(a)).toBe(false);
  });
});

describe('R12 — Lecture section in Lab venue (NEW-FU-98)', () => {
  test('TC-33: Lec section in Laboratory → R-12 fires', () => {
    const a = sec({ sectionType:'Lec', venueId:'v-1', venueType:'Laboratory' });
    expect(isR12Hit(a)).toBe(true);
    expect(isR11Hit(a)).toBe(false);
  });
  test('TC-33b: Lec section in LectureHall → R-12 does NOT fire', () => {
    const a = sec({ sectionType:'Lec', venueId:'v-1', venueType:'LectureHall' });
    expect(isR12Hit(a)).toBe(false);
  });
  test('TC-33c: no venue assigned → R-12 deferred to R-10 (does NOT fire)', () => {
    const a = sec({ sectionType:'Lec', venueId:null, venueType:null });
    expect(isR12Hit(a)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R-13 — Instructor with no office hours (NEW-FU-99)
// Predicate: instructor assigned to a section, ohMap has no entry (or
// empty array) for that instructor.
// ─────────────────────────────────────────────────────────────────────────────

function isR13Hit(s, ohMap) {
  if (!s.instructorId) return false;
  return !ohMap.has(s.instructorId);
}

describe('R13 — Instructor with no office hours (NEW-FU-99)', () => {
  test('TC-34: instructor teaching with no OH entries → R-13 fires', () => {
    const a = sec({ instructorId:'instr-X' });
    const oh = new Map(); // no OH for anyone
    expect(isR13Hit(a, oh)).toBe(true);
  });
  test('TC-34b: instructor with at least one OH → R-13 does NOT fire', () => {
    const a = sec({ instructorId:'instr-X' });
    const oh = new Map([['instr-X', [{ day:'Monday', startTime:'09:00', endTime:'10:00' }]]]);
    expect(isR13Hit(a, oh)).toBe(false);
  });
  test('TC-34c: section without instructor → R-13 does NOT fire (R-09 handles)', () => {
    const a = sec({ instructorId:null });
    expect(isR13Hit(a, new Map())).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R-14 — has_lab course must have both Lec AND Lab sections (NEW-FU-107)
// The rule lives inline in ScheduleService._evaluateSchedule; here we
// exercise the predicate logic over Section domain objects.
// ─────────────────────────────────────────────────────────────────────────────

function r14CourseStatus(sections) {
  const status = new Map();
  for (const s of sections) {
    if (!s.hasLab) continue;
    let st = status.get(s.courseId);
    if (!st) { st = { hasLec:false, hasLab:false }; status.set(s.courseId, st); }
    if (s.sectionType === 'Lec') st.hasLec = true;
    if (s.sectionType === 'Lab') st.hasLab = true;
  }
  return status;
}
function isR14Missing(status) {
  return [...status.values()].filter(s => !(s.hasLec && s.hasLab));
}

describe('R14 — has_lab course missing Lec or Lab (NEW-FU-107)', () => {
  test('TC-35: has_lab course with both Lec AND Lab → no R-14', () => {
    const ss = [
      sec({ courseId:'C1', sectionType:'Lec', hasLab:true }),
      sec({ courseId:'C1', sectionType:'Lab', hasLab:true }),
    ];
    expect(isR14Missing(r14CourseStatus(ss)).length).toBe(0);
  });
  test('TC-35b: has_lab course with only Lec → R-14 fires (missing Lab)', () => {
    const ss = [
      sec({ courseId:'C1', sectionType:'Lec', hasLab:true }),
      sec({ courseId:'C1', sectionType:'Lec', hasLab:true, sectionNumber:'02' }),
    ];
    const missing = isR14Missing(r14CourseStatus(ss));
    expect(missing.length).toBe(1);
    expect(missing[0].hasLec).toBe(true);
    expect(missing[0].hasLab).toBe(false);
  });
  test('TC-35c: has_lab course with only Lab → R-14 fires (missing Lec)', () => {
    const ss = [
      sec({ courseId:'C1', sectionType:'Lab', hasLab:true, sectionNumber:'50' }),
    ];
    const missing = isR14Missing(r14CourseStatus(ss));
    expect(missing.length).toBe(1);
    expect(missing[0].hasLec).toBe(false);
    expect(missing[0].hasLab).toBe(true);
  });
  test('TC-35d: has_lab=false course → R-14 does NOT fire regardless of types', () => {
    const ss = [
      sec({ courseId:'C2', sectionType:'Lec', hasLab:false }),
    ];
    expect(r14CourseStatus(ss).size).toBe(0);
  });
  test('TC-35e: two has_lab courses, one complete + one missing Lab → 1 R-14', () => {
    const ss = [
      sec({ courseId:'C1', sectionType:'Lec', hasLab:true }),
      sec({ courseId:'C1', sectionType:'Lab', hasLab:true }),
      sec({ courseId:'C2', sectionType:'Lec', hasLab:true }),
    ];
    const missing = isR14Missing(r14CourseStatus(ss));
    expect(missing.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Type-scoped section-number format (NEW-FU-105 / NEW-FU-108)
// The DB CHECK and controller regex agree:
//   Lec: ^(0[1-9]|[1-4][0-9])$  → '01'..'49'
//   Lab: ^[5-9][0-9]$           → '50'..'99'
// ─────────────────────────────────────────────────────────────────────────────

describe('Type-scoped section number format (NEW-FU-105/108)', () => {
  const LEC_RE = /^(0[1-9]|[1-4][0-9])$/;
  const LAB_RE = /^[5-9][0-9]$/;
  test('TC-36: Lec range accepts 01..49', () => {
    for (const n of ['01','09','10','25','49']) expect(LEC_RE.test(n)).toBe(true);
  });
  test('TC-36b: Lec range rejects 50..99', () => {
    for (const n of ['50','75','99']) expect(LEC_RE.test(n)).toBe(false);
  });
  test('TC-37: Lab range accepts 50..99', () => {
    for (const n of ['50','75','99']) expect(LAB_RE.test(n)).toBe(true);
  });
  test('TC-37b: Lab range rejects 01..49', () => {
    for (const n of ['01','25','49']) expect(LAB_RE.test(n)).toBe(false);
  });
  test('TC-37c: both ranges reject 00, 100, A, "1", " 50"', () => {
    for (const n of ['00','100','A','1',' 50']) {
      expect(LEC_RE.test(n)).toBe(false);
      expect(LAB_RE.test(n)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Type-scoped duration validation (NEW-FU-106 / NEW-FU-109)
//   Lec: 50..75 minutes
//   Lab: 50..160 minutes
// ─────────────────────────────────────────────────────────────────────────────

function durationMinutes(start, end) {
  const [h1, m1] = start.split(':').map(Number);
  const [h2, m2] = end.split(':').map(Number);
  return (h2*60+m2) - (h1*60+m1);
}
function isLecDurationOk(d) { return d >= 50 && d <= 75; }
function isLabDurationOk(d) { return d >= 50 && d <= 160; }

describe('Per-type duration validation (NEW-FU-106/109)', () => {
  test('TC-38: Lec accepts 50, 60, 75; rejects 30, 90, 165', () => {
    expect(isLecDurationOk(50)).toBe(true);
    expect(isLecDurationOk(60)).toBe(true);
    expect(isLecDurationOk(75)).toBe(true);
    expect(isLecDurationOk(30)).toBe(false);
    expect(isLecDurationOk(90)).toBe(false);
    expect(isLecDurationOk(165)).toBe(false);
  });
  test('TC-39: Lab accepts 50, 75, 100, 160; rejects 30, 165, 200', () => {
    expect(isLabDurationOk(50)).toBe(true);
    expect(isLabDurationOk(75)).toBe(true);
    expect(isLabDurationOk(100)).toBe(true);
    expect(isLabDurationOk(160)).toBe(true);
    expect(isLabDurationOk(30)).toBe(false);
    expect(isLabDurationOk(165)).toBe(false);
    expect(isLabDurationOk(200)).toBe(false);
  });
  test('TC-40: durationMinutes computes correctly from HH:MM strings', () => {
    expect(durationMinutes('08:00', '09:15')).toBe(75);
    expect(durationMinutes('13:00', '15:40')).toBe(160);
    expect(durationMinutes('09:00', '09:50')).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SuggestService — smarter algorithm helpers (NEW-FU-115 / NEW-FU-116)
// The helpers are pure functions extracted/reused here for testing.
// ─────────────────────────────────────────────────────────────────────────────

// Mirror of FU-115's tertiary-key candidate sort. Tier order:
//   1) preferred (same-course) instructor first
//   2) instructors with at least one OH first (avoids R-13)
//   3) least loaded
function sortCandidates(instructors, ohMap, preferredId, instrLoad) {
  return [...instructors].sort((a, b) => {
    if (a.id === preferredId) return -1;
    if (b.id === preferredId) return  1;
    const aHasOH = ohMap.has(a.id);
    const bHasOH = ohMap.has(b.id);
    if (aHasOH !== bHasOH) return aHasOH ? -1 : 1;
    return (instrLoad.get(a.id) ?? 0) - (instrLoad.get(b.id) ?? 0);
  });
}

// Mirror of FU-116's deterministic shuffle so we can test reproducibility.
function seededShuffle(arr, seed) {
  const result = [...arr];
  let t = (seed * 2654435761) >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    t = (t * 1664525 + 1013904223) >>> 0;
    const j = t % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

describe('SuggestService.sortCandidates (NEW-FU-115)', () => {
  const instructors = [
    { id: 'A', name: 'Dr. A' },
    { id: 'B', name: 'Dr. B' },
    { id: 'C', name: 'Dr. C' },
  ];
  const loadEqual = new Map([['A',0],['B',0],['C',0]]);

  test('TC-41: instructor with OHs ranks above instructor without OHs', () => {
    const oh = new Map([['B', [{ day:'Mon', startTime:'09:00', endTime:'10:00' }]]]);
    const ordered = sortCandidates(instructors, oh, null, loadEqual);
    // B has OH; A and C have none → B first
    expect(ordered[0].id).toBe('B');
  });
  test('TC-41b: preferred (same-course) wins over has-OH', () => {
    const oh = new Map([['B', [{}]]]);
    const ordered = sortCandidates(instructors, oh, 'A', loadEqual);
    // Preferred A first (even though A has no OH)
    expect(ordered[0].id).toBe('A');
  });
  test('TC-41c: load is tertiary key (after OH presence)', () => {
    const oh = new Map([['A',[{}]],['B',[{}]],['C',[{}]]]); // all have OH
    const load = new Map([['A',5],['B',1],['C',3]]);
    const ordered = sortCandidates(instructors, oh, null, load);
    expect(ordered.map(i => i.id)).toEqual(['B','C','A']);
  });
  test('TC-41d: when nobody has OHs, load takes over', () => {
    const oh = new Map();
    const load = new Map([['A',2],['B',5],['C',1]]);
    const ordered = sortCandidates(instructors, oh, null, load);
    expect(ordered.map(i => i.id)).toEqual(['C','A','B']);
  });
});

describe('SuggestService.seededShuffle (NEW-FU-116)', () => {
  test('TC-42: same seed → same shuffle (reproducible)', () => {
    const arr = [1,2,3,4,5];
    expect(seededShuffle(arr, 1)).toEqual(seededShuffle(arr, 1));
    expect(seededShuffle(arr, 42)).toEqual(seededShuffle(arr, 42));
  });
  test('TC-42b: different seeds → different shuffles (statistical)', () => {
    const arr = [1,2,3,4,5,6,7,8,9,10];
    const a = seededShuffle(arr, 1);
    const b = seededShuffle(arr, 2);
    const c = seededShuffle(arr, 7);
    // At least 2 of 3 should differ from each other (not all equal)
    expect(JSON.stringify(a) === JSON.stringify(b) &&
           JSON.stringify(b) === JSON.stringify(c)).toBe(false);
  });
  test('TC-42c: shuffle preserves all elements (no loss, no duplicates)', () => {
    const arr = [1,2,3,4,5];
    const shuffled = seededShuffle(arr, 99);
    expect([...shuffled].sort()).toEqual([...arr].sort());
  });
  test('TC-42d: shuffle does not mutate the input array', () => {
    const arr = [1,2,3,4,5];
    const snapshot = [...arr];
    seededShuffle(arr, 5);
    expect(arr).toEqual(snapshot);
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
    const swe501 = sec({ courseId:'c3', academicLevel:'Graduate', category:'GR', day:'Sunday', startTime:'17:20', endTime:'18:10', instructorId:'i3', venueId:'v3' });
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
