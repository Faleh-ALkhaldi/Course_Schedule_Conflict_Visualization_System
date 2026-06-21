/**
 * NEW-FU-621 (audit #2) — teachingWindowFor is the single R-06-aware teaching-window
 * resolver shared by previewConflicts, autoFixAround, RescheduleAroundService and
 * QuickFixService. Before it, those five sites each hand-rolled the same UG/GR ternary
 * and NONE consulted R06_TIME_EXEMPT_COURSES, so a Quick Fix moving SWE 412 (the one
 * R-06-time-exempt course) clamped it to the 07:00–17:10 UG day and could refuse a legal
 * evening slot the engine would have accepted. An exempt course must scan the full
 * 07:00–22:00 teaching day; every other course keeps its strict R-06 window.
 */
const { teachingWindowFor, TIME_WINDOWS } = require('../../src/config/constants');

const UG = { start: 7 * 60, end: 17 * 60 + 10 };          // 07:00–17:10
const GR = { start: 17 * 60 + 20, end: 22 * 60 };         // 17:20–22:00
const FULL = { start: 7 * 60, end: 22 * 60 };             // 07:00–22:00 (R-06-exempt)

describe('teachingWindowFor (audit #2 / FU-621)', () => {
  test('UG / GR / capstone map to the strict R-06 windows (unchanged behavior)', () => {
    expect(teachingWindowFor({ category: 'UG', courseCode: 'SWE 363' })).toEqual(UG);
    expect(teachingWindowFor({ category: 'GR', courseCode: 'SWE 511' })).toEqual(GR);
    // capstone is venue-exempt but NOT time-exempt → bound to the UG day
    expect(teachingWindowFor({ category: 'UG', isCapstone: true, courseCode: 'SWE 414' })).toEqual(UG);
    // a GR capstone is still bound to the UG day, not the evening
    expect(teachingWindowFor({ category: 'GR', isCapstone: true, courseCode: 'SWE 413' })).toEqual(UG);
  });

  test('SWE 412 (the R-06-time-exempt course) scans the FULL teaching day', () => {
    expect(teachingWindowFor({ category: 'UG', isCapstone: true, courseCode: 'SWE 412' })).toEqual(FULL);
    // exemption wins regardless of the category/capstone flags passed in
    expect(teachingWindowFor({ category: 'GR', isCapstone: false, courseCode: 'SWE 412' })).toEqual(FULL);
  });

  test('no courseCode → falls back to the category window (no accidental exemption)', () => {
    expect(teachingWindowFor({ category: 'UG' })).toEqual(UG);
    expect(teachingWindowFor({ category: 'GR' })).toEqual(GR);
  });

  test('windows are sourced from constants.TIME_WINDOWS (single source of truth)', () => {
    expect(teachingWindowFor({ category: 'UG', courseCode: 'X' }).end).toBe(TIME_WINDOWS.UG.end);
    expect(teachingWindowFor({ category: 'GR', courseCode: 'X' }).start).toBe(TIME_WINDOWS.GR.start);
  });
});
