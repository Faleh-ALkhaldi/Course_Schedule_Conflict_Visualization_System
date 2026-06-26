// NEW-FU-677 (re-audit round 6) — export-side adversarial fixes:
//   • DOCX grid lane cap: a term with hundreds of sections overlapping at one slot built ~86k
//     TableCell trees and OOM-killed the process under the 512 MB Render heap. gAssignLanes now
//     caps lanes, clamping overflow into the last lane (all data is still in the Half-B table).
//   • Scope-marker spoof: an entity literally named "Venue Schedule"/"Instructor Schedule" flipped
//     a whole-term PDF/Word file's detected scope (REPLACE → MERGE). detectScopeFromText now anchors
//     to the heading's "·" bullet, which no entity name can contain.
const { gAssignLanes, MAX_GRID_LANES } = require('../../src/services/DocxExportService');
const { detectScopeFromText } = require('../../src/services/exportScope');

describe('FU-677 — DOCX grid lane cap (export OOM guard)', () => {
  test('480 sections overlapping at one slot are capped to MAX_GRID_LANES lanes (no 480-column build)', () => {
    const entries = Array.from({ length: 480 }, () => ({ startSlot: 24, endSlot: 34 }));   // all overlap
    const lanes = gAssignLanes(entries);
    expect(lanes).toBeLessThanOrEqual(MAX_GRID_LANES);
    expect(entries.every(e => e.lane < MAX_GRID_LANES)).toBe(true);   // every section clamped into a real lane
  });
  test('a normal handful of concurrent sections is unaffected (one lane each)', () => {
    const entries = [{ startSlot: 0, endSlot: 10 }, { startSlot: 0, endSlot: 10 }, { startSlot: 0, endSlot: 10 }];
    expect(gAssignLanes(entries)).toBe(3);
    expect(entries.map(e => e.lane).sort()).toEqual([0, 1, 2]);
  });
  test('non-overlapping sections reuse a single lane', () => {
    const entries = [{ startSlot: 0, endSlot: 5 }, { startSlot: 5, endSlot: 10 }, { startSlot: 10, endSlot: 15 }];
    expect(gAssignLanes(entries)).toBe(1);
  });
});

describe('FU-677 — scope-marker spoof closed (detectScopeFromText)', () => {
  test('a bare entity name "Venue/Instructor Schedule" in body text does NOT flip a whole-term file', () => {
    expect(detectScopeFromText('Fall 2025 — Full Semester (all sections)  Instructor: Venue Schedule | SWE 211')).toBe('full');
    expect(detectScopeFromText('Instructor Schedule taught by Dr X')).toBe('full');   // no "·" bullet → not a heading
    expect(detectScopeFromText('a venue named Venue Schedule in room 22-120')).toBe('full');
  });
  test('a real scoped heading (phrase + "·" bullet) is still detected', () => {
    expect(detectScopeFromText('Fall 2025 — Venue Schedule · 22-120')).toBe('venue');
    expect(detectScopeFromText('Fall 2025 — Instructor Schedule · SAAD EZZINI')).toBe('instructor');
    expect(detectScopeFromText('Spring — Venue Schedule· 99-001')).toBe('venue');   // tolerant of missing space before bullet
  });
  test('a whole-term heading stays full', () => {
    expect(detectScopeFromText('Fall 2025 — Full Semester (all sections)')).toBe('full');
  });
});
