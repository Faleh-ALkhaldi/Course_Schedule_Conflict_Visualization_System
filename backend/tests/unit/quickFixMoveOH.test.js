/**
 * NEW-FU-635 (issue #3) — Quick Fix resolves an OH↔class overlap (R-04, office-hour variant)
 * by MOVING the office hour to a free slot, preferred over reassigning the whole class.
 * Unit-tests the two pure helpers the resolver uses: freeOfficeHourSlot (relocation finder)
 * and applyOhOpToMap (simulation/commit of the move into the ohMap). No DB.
 */
const svc = require('../../src/services/QuickFixService');
const freeOfficeHourSlot = svc._freeOfficeHourSlot;
const applyOhOpToMap = svc._applyOhOpToMap;

const toMin = (h) => { const [a, b] = String(h).slice(0, 5).split(':').map(Number); return a * 60 + b; };
const overlaps = (aS, aE, bS, bE) => toMin(aS) < toMin(bE) && toMin(bS) < toMin(aE);

describe('freeOfficeHourSlot (issue #3 / FU-635)', () => {
  const oh = { id: 'oh1', day: 'Sunday', startTime: '11:00:00', endTime: '12:00:00' };

  test('relocates the OH off the overlapping class to a free, in-window slot', () => {
    const classes = [{ day: 'Sunday', startTime: '11:00:00', endTime: '12:15:00' }]; // overlaps oh
    const slot = freeOfficeHourSlot(oh, classes, [oh]);
    expect(slot).toBeTruthy();
    // 60-min slot, inside 08:00–16:00, NOT overlapping the class
    expect(toMin(slot.startTime)).toBeGreaterThanOrEqual(8 * 60);
    expect(toMin(slot.endTime)).toBeLessThanOrEqual(16 * 60);
    expect(overlaps(slot.startTime, slot.endTime, '11:00', '12:15')).toBe(false);
  });

  test('avoids the instructor\'s OTHER office hours too', () => {
    const classes = [{ day: 'Sunday', startTime: '11:00:00', endTime: '12:15:00' }];
    const otherOH = { id: 'oh2', day: 'Sunday', startTime: '08:00:00', endTime: '10:00:00' };
    const slot = freeOfficeHourSlot(oh, classes, [oh, otherOH]);
    expect(slot).toBeTruthy();
    expect(overlaps(slot.startTime, slot.endTime, '11:00', '12:15')).toBe(false);  // not on the class
    expect(overlaps(slot.startTime, slot.endTime, '08:00', '10:00')).toBe(false);  // not on the other OH
  });

  test('returns null when the day is fully blocked 08:00–16:00', () => {
    const classes = [{ day: 'Sunday', startTime: '08:00:00', endTime: '16:00:00' }];
    expect(freeOfficeHourSlot(oh, classes, [oh])).toBeNull();
  });
});

describe('applyOhOpToMap (issue #3 / FU-635)', () => {
  test('move-office-hour relocates the right OH in a COPY, leaving the original map intact', () => {
    const original = new Map([['i1', [
      { id: 'oh1', day: 'Sunday', startTime: '11:00:00', endTime: '12:00:00' },
      { id: 'oh2', day: 'Monday', startTime: '09:00:00', endTime: '10:00:00' },
    ]]]);
    const op = { type: 'move-office-hour', instructorId: 'i1', officeHourId: 'oh1', toStart: '14:00', toEnd: '15:00' };
    const next = applyOhOpToMap(original, op);
    expect(next).not.toBe(original);                                  // a copy
    expect(original.get('i1')[0].startTime).toBe('11:00:00');         // original untouched
    const moved = next.get('i1').find(o => o.id === 'oh1');
    expect(moved.startTime).toBe('14:00');
    expect(moved.endTime).toBe('15:00');
    expect(next.get('i1').find(o => o.id === 'oh2').startTime).toBe('09:00:00'); // sibling untouched
  });

  test('a non-OH op returns the same map reference (no needless copy)', () => {
    const m = new Map([['i1', []]]);
    expect(applyOhOpToMap(m, { type: 'reassign-instructor', sectionId: 's1' })).toBe(m);
  });

  test('handles a compound op carrying a move-office-hour sub-op', () => {
    const m = new Map([['i1', [{ id: 'oh1', day: 'Sunday', startTime: '11:00:00', endTime: '12:00:00' }]]]);
    const op = { type: 'compound', subOps: [
      { type: 'move', sectionId: 's1', newStartTime: '13:00', newEndTime: '13:50' },
      { type: 'move-office-hour', instructorId: 'i1', officeHourId: 'oh1', toStart: '08:00', toEnd: '09:00' },
    ] };
    const next = applyOhOpToMap(m, op);
    expect(next.get('i1')[0].startTime).toBe('08:00');
  });
});
