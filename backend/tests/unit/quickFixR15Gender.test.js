/**
 * NEW-FU-652 — QuickFix R-15 add-day proposals must be PER-GENDER.
 *
 * The engine fires R-15 (insufficient credit coverage) per courseId|sectionNumber|gender,
 * so a Male §01 and a Female §01 each get their own conflict. The add-day candidate
 * generator's group-rows filter was gender-BLIND, so `survivingRow = groupRows[0]`
 * always resolved to the Male row. BOTH conflicts then proposed an add-day pointing at
 * the SAME Male row, the Female group never got its meeting day, the simulator saw no
 * improvement for it, and it fell through to a last-resort DROP — silently destroying the
 * Female section instead of fixing it. This locks in the per-gender targeting.
 *
 * Pure unit test — candidateOps is a pure function over an in-memory sections array.
 */
const qf = require('../../src/services/QuickFixService');
const candidateOps = qf._candidateOps;

// A 3-credit no-lab lecture group meeting Sun+Tue × 50 min = 100 < 150 (R-15) for EACH gender.
const lec = (id, gender, day) => ({
  id, gender, day, sectionType: 'Lec',
  courseId: 'C1', sectionNumber: '01', courseCode: 'SWE 999',
  credits: 3, hasLab: false,
  startTime: '08:00', endTime: '08:50',
  instructorId: 'I1', venueId: 'V1',
});
const sections = [
  lec('m-sun', 'M', 'Sunday'), lec('m-tue', 'M', 'Tuesday'),
  lec('f-sun', 'F', 'Sunday'), lec('f-tue', 'F', 'Tuesday'),
];

describe('QuickFix R-15 add-day is per-gender (FU-652)', () => {
  test('Female R-15 proposes an add-day on a FEMALE row (never a male row → no forced drop)', () => {
    const femaleConflict = { ruleId: 'R-15', severity: 'Soft', sectionAId: 'f-sun' };
    const ops = candidateOps(femaleConflict, sections, [], [], new Map());
    const addDays = ops.filter(o => o.type === 'add-day');
    expect(addDays.length).toBeGreaterThan(0);
    for (const op of addDays) {
      const target = sections.find(s => s.id === op.sectionId);
      expect(target.gender).toBe('F'); // pre-fix this was 'M' (groupRows[0])
    }
    expect(addDays.some(o => (o.addDays || []).includes('Thursday'))).toBe(true);
  });

  test('Male R-15 proposes an add-day on a MALE row', () => {
    const maleConflict = { ruleId: 'R-15', severity: 'Soft', sectionAId: 'm-sun' };
    const ops = candidateOps(maleConflict, sections, [], [], new Map());
    const addDays = ops.filter(o => o.type === 'add-day');
    expect(addDays.length).toBeGreaterThan(0);
    for (const op of addDays) {
      const target = sections.find(s => s.id === op.sectionId);
      expect(target.gender).toBe('M');
    }
    expect(addDays.some(o => (o.addDays || []).includes('Thursday'))).toBe(true);
  });
});
