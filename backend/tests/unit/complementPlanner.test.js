// NEW-FU-682: unit tests for the pure orphan-completion planner (domain/complementPlanner.js).
// Verifies it places the MISSING half of a Has-Laboratory course in a conflict-free slot, prefers an
// instructor who has previously taught the course, prefers an OH-holder, and returns null (→ the fix
// engine drops as a last resort) when no venue / instructor / slot is free.
const { planComplementSection } = require('../../src/domain/complementPlanner');

// A 3-credit Has-Laboratory orphan: the Lab exists, the Lecture is missing.
function orphanLab(over = {}) {
  return {
    id: 'lab-1', courseId: 'C1', courseCode: 'SWE 206', credits: 3, hasLab: true,
    academicLevel: 'Sophomore', category: 'UG', gender: 'M', sectionType: 'Lab',
    day: 'Monday', startTime: '10:00', endTime: '11:50', instructorId: 'I-prior', venueId: 'V-lab',
    ...over,
  };
}
const lectureHall = (id) => ({ id, name: id, type: 'LectureHall' });
const labVenue    = (id) => ({ id, name: id, type: 'Laboratory' });
const ohMapWith   = (...ids) => new Map(ids.map(id => [id, [{ day: 'Wednesday', startTime: '09:00', endTime: '10:00' }]]));

describe('complementPlanner.planComplementSection', () => {
  test('adds the missing LECTURE for an orphan Lab in a free lecture hall with a free PRIOR instructor', () => {
    const orphan = orphanLab();
    const sections = [orphan]; // I-prior teaches the lab → has "previously taught" SWE 206
    const instructors = [{ id: 'I-prior', name: 'PRIOR' }, { id: 'I-other', name: 'OTHER' }];
    const venues = [labVenue('V-lab'), lectureHall('V-hall')];
    const out = planComplementSection(orphan, sections, instructors, venues, ohMapWith('I-prior', 'I-other'));

    expect(out).not.toBeNull();
    expect(out.sectionType).toBe('Lec');
    expect(out.priorInstructor).toBe(true);
    expect(out.instructorId).toBe('I-prior');          // prior teacher preferred
    expect(out.venueType).toBe('LectureHall');         // a lecture hall, never the lab
    expect(out.rows.length).toBeGreaterThanOrEqual(2); // 2-day 50-min lecture pattern for 3cr has_lab
    // The placement must not collide with the Monday 10:00–11:50 lab.
    for (const r of out.rows) {
      const clash = r.day === 'Monday' && !(r.endTime <= '10:00' || r.startTime >= '11:50');
      expect(clash).toBe(false);
    }
  });

  test('falls back to ANY free instructor when no prior teacher is free', () => {
    const orphan = orphanLab();
    // I-prior is busy every UG slot on the lecture days; I-other is free.
    const busyPrior = ['Sunday', 'Tuesday'].flatMap(day =>
      Array.from({ length: 13 }, (_, k) => ({
        id: `busy-${day}-${k}`, courseId: 'CX', instructorId: 'I-prior', venueId: 'VX',
        day, startTime: `${String(7 + k).padStart(2, '0')}:00`, endTime: `${String(7 + k).padStart(2, '0')}:55`,
        academicLevel: 'Junior',
      })));
    const sections = [orphan, ...busyPrior];
    const instructors = [{ id: 'I-prior', name: 'PRIOR' }, { id: 'I-other', name: 'OTHER' }];
    const venues = [lectureHall('V-hall')];
    const out = planComplementSection(orphan, sections, instructors, venues, ohMapWith('I-prior', 'I-other'));
    expect(out).not.toBeNull();
    expect(out.instructorId).toBe('I-other');
    expect(out.priorInstructor).toBe(false);
  });

  test('returns null when no lecture hall is available (→ caller drops as last resort)', () => {
    const orphan = orphanLab();
    const out = planComplementSection(orphan, [orphan],
      [{ id: 'I-prior', name: 'PRIOR' }], [labVenue('V-lab')], ohMapWith('I-prior'));
    expect(out).toBeNull();
  });

  test('returns null when no instructor is free at any slot', () => {
    const orphan = orphanLab();
    const out = planComplementSection(orphan, [orphan], [], [lectureHall('V-hall')], new Map());
    expect(out).toBeNull();
  });

  test('the mirror direction: an orphan Lecture asks for a Lab in a lab venue', () => {
    const orphan = orphanLab({ sectionType: 'Lec', id: 'lec-1', day: 'Sunday', startTime: '08:00', endTime: '08:50' });
    const out = planComplementSection(orphan, [orphan],
      [{ id: 'I-prior', name: 'PRIOR' }], [labVenue('V-lab'), lectureHall('V-hall')], ohMapWith('I-prior'));
    expect(out).not.toBeNull();
    expect(out.sectionType).toBe('Lab');
    expect(out.venueType).toBe('Laboratory');
  });
});
