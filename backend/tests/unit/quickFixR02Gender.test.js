/**
 * NEW-FU-655 — QuickFix R-01/R-02 (course-cohort) fixes must address the WHOLE logical section
 * across genders. The sim op-applier must (a) gender-SCOPE move/drop by default so it matches the
 * gender-scoped DB apply, and (b) honor op.allGenders to relocate/remove EVERY gender of the logical
 * section — otherwise fixing one gender just shifts the overlap onto the other (the "Applied 1 fix but
 * still 1 soft" whack-a-mole the user hit on SWE 316 ↔ SWE 402).
 *
 * Pure unit test — applyOpInMemory is a pure (sections, op) → sections' function.
 */
const qf = require('../../src/services/QuickFixService');
const applyOpInMemory = qf._applyOpInMemory;

// A gender-split logical section §01: Male rows (Sun/Tue) + Female rows (Sun/Tue), distinct times.
const grp = () => [
  { id: 'm-sun', courseId: 'C1', sectionNumber: '01', gender: 'M', day: 'Sunday',  startTime: '09:30', endTime: '10:20', instructorId: 'IM', venueId: 'VM' },
  { id: 'm-tue', courseId: 'C1', sectionNumber: '01', gender: 'M', day: 'Tuesday', startTime: '09:30', endTime: '10:20', instructorId: 'IM', venueId: 'VM' },
  { id: 'f-sun', courseId: 'C1', sectionNumber: '01', gender: 'F', day: 'Sunday',  startTime: '10:30', endTime: '11:20', instructorId: 'IF', venueId: 'VF' },
  { id: 'f-tue', courseId: 'C1', sectionNumber: '01', gender: 'F', day: 'Tuesday', startTime: '10:30', endTime: '11:20', instructorId: 'IF', venueId: 'VF' },
];

describe('QuickFix sim is gender-aware (FU-655)', () => {
  test('default move is gender-SCOPED — only the target gender shifts', () => {
    const out = applyOpInMemory(grp(), { type: 'move', sectionId: 'm-sun', newStartTime: '07:00', newEndTime: '07:50' });
    const byId = Object.fromEntries(out.map(s => [s.id, s]));
    expect(byId['m-sun'].startTime).toBe('07:00');
    expect(byId['m-tue'].startTime).toBe('07:00');           // same gender moves together
    expect(byId['f-sun'].startTime).toBe('10:30');           // Female untouched (gender-scoped)
    expect(byId['f-tue'].startTime).toBe('10:30');
  });

  test('allGenders move relocates the WHOLE logical section (both genders) — clears a cohort overlap', () => {
    const out = applyOpInMemory(grp(), { type: 'move', sectionId: 'm-sun', allGenders: true, newStartTime: '07:00', newEndTime: '07:50' });
    expect(out.every(s => s.startTime === '07:00')).toBe(true); // M and F both moved
  });

  test('default drop is gender-SCOPED — Female sibling survives', () => {
    const out = applyOpInMemory(grp(), { type: 'drop', sectionId: 'm-sun' });
    expect(out.some(s => s.gender === 'M')).toBe(false);     // Male gone
    expect(out.filter(s => s.gender === 'F').length).toBe(2); // Female kept
  });

  test('allGenders drop removes the WHOLE logical section (both genders)', () => {
    const out = applyOpInMemory(grp(), { type: 'drop', sectionId: 'm-sun', allGenders: true });
    expect(out.length).toBe(0);                               // every gender of §01 removed
  });
});
