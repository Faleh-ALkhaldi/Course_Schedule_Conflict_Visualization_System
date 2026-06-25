/**
 * NEW-FU-655 — Auto-Suggest "Replace" vs "Add to" apply mode.
 *
 * In 'add' mode the term's existing sections are KEPT and the generated sections
 * are APPENDED. The task-builder always numbers generated sections from the
 * bottom of each type range (Lec '01'.., Lab '50'..), so without renumbering an
 * appended section would collide with an already-scheduled one under the UNIQUE
 * key (schedule_id, course_id, section_number, day, gender).
 *
 * nextAddModeSectionNumber hands out the next FREE number per (course, gender,
 * type) group, climbing from the highest existing number, staying inside the
 * type-scoped CHECK (Lec 01–49, Lab 50–99). This exercises that pure helper
 * directly (no DB), which is the collision-avoidance core of add mode.
 */
const svc = require('../../src/services/SuggestService');
const next = svc._nextAddModeSectionNumber;

const COURSE = 'c-1';

describe('SuggestService add-mode section renumbering (FU-655)', () => {
  test('an empty group starts Lec at 01 and climbs, zero-padded', () => {
    const base = new Map();
    expect(next(base, COURSE, 'M', 'Lec')).toBe('01');
    expect(next(base, COURSE, 'M', 'Lec')).toBe('02');
    expect(next(base, COURSE, 'M', 'Lec')).toBe('03');
  });

  test('an empty Lab group starts at 50 (the type range floor), not 01', () => {
    const base = new Map();
    expect(next(base, COURSE, 'M', 'Lab')).toBe('50');
    expect(next(base, COURSE, 'M', 'Lab')).toBe('51');
  });

  test('existing sections push appended ones past the highest used number', () => {
    // Seed: course already has Male Lec §01,§02 (max 2) and Male Lab §50 (max 50).
    const base = new Map([
      [`${COURSE}|M|Lec`, 2],
      [`${COURSE}|M|Lab`, 50],
    ]);
    expect(next(base, COURSE, 'M', 'Lec')).toBe('03'); // not 01 → no collision
    expect(next(base, COURSE, 'M', 'Lec')).toBe('04');
    expect(next(base, COURSE, 'M', 'Lab')).toBe('51'); // not 50 → no collision
  });

  test('Male and Female of the same course are numbered independently', () => {
    // Both genders legitimately coexist at the same number (gender is part of the
    // UNIQUE key), so each gender climbs from its OWN existing max.
    const base = new Map([
      [`${COURSE}|M|Lec`, 3],   // Male already up to §03
      // Female has none yet → starts fresh at 01.
    ]);
    expect(next(base, COURSE, 'M', 'Lec')).toBe('04');
    expect(next(base, COURSE, 'F', 'Lec')).toBe('01');
    expect(next(base, COURSE, 'F', 'Lec')).toBe('02');
    // Male continues unaffected by the Female allocations.
    expect(next(base, COURSE, 'M', 'Lec')).toBe('05');
  });

  test('Lec and Lab of the same course/gender use disjoint ranges', () => {
    const base = new Map();
    expect(next(base, COURSE, 'M', 'Lec')).toBe('01');
    expect(next(base, COURSE, 'M', 'Lab')).toBe('50');
    expect(next(base, COURSE, 'M', 'Lec')).toBe('02');
    expect(next(base, COURSE, 'M', 'Lab')).toBe('51');
  });
});
