/**
 * NEW-FU-669 — import-engine hardening. Pure unit tests for the value/structure gates closed
 * in this pass (no DB; honours SKIP_TEST_DB=1). Control/zero-width/space chars are written as
 * \uXXXX escapes (never literal) so the source file can't be corrupted by them.
 */
const { assertDocxStructureSafe } = require('../../src/services/ImportParserService');
const { instructorNameError }     = require('../../src/domain/instructorFormat');
const { prohibitedCharsError }    = require('../../src/domain/importFieldValidation');

describe('FU-669 #1 — DOCX structure guard (ReDoS / event-loop DoS)', () => {
  test('rejects unclosed <table> openers in milliseconds (was O(n²), 28s freeze)', () => {
    const t0 = Date.now();
    expect(() => assertDocxStructureSafe('<table>'.repeat(150000))).toThrow(/malformed/i);
    expect(Date.now() - t0).toBeLessThan(500);   // bounded — no quadratic scan
  });
  test('rejects imbalanced <tr> tags and an absurd table count', () => {
    expect(() => assertDocxStructureSafe('<table><tr></table>')).toThrow(/malformed/i);       // tr open≠close
    expect(() => assertDocxStructureSafe('<table></table>'.repeat(600))).toThrow(/malformed/i); // >500 tables
  });
  test('rejects an over-large rendered body', () => {
    expect(() => assertDocxStructureSafe('x'.repeat(17 * 1024 * 1024))).toThrow(/too large/i);
  });
  test('accepts a balanced, sane table and returns the <tr> count', () => {
    expect(assertDocxStructureSafe('<table><tr><td>a</td></tr><tr><td>b</td></tr></table>')).toBe(2);
  });
  test('the thrown error carries a 400 status and no raw internals', () => {
    try { assertDocxStructureSafe('<table>'.repeat(600)); }
    catch (e) { expect(e.status).toBe(400); expect(e.message).not.toMatch(/regex|matchAll|stack/i); }
  });
});

describe('FU-669 #2 — instructor name rejects Unicode spaces / BOM (homograph + look-alike dup)', () => {
  const NBSP = '\u00A0', EM = '\u2003', IDSP = '\u3000', BOM = '\uFEFF', ZWSP = '\u200B';
  test.each([
    ['NBSP',              `John${NBSP}Smith`],
    ['em-space',          `John${EM}Smith`],
    ['ideographic space', `John${IDSP}Smith`],
    ['interior BOM',      `John${BOM}Smith`],
    ['zero-width space',  `John${ZWSP}Smith`],
  ])('rejects %s', (_label, name) => {
    expect(instructorNameError(name)).toBeTruthy();
  });
  test('still accepts a plain ASCII full name and the seeded placeholder', () => {
    expect(instructorNameError('John Smith')).toBeNull();
    expect(instructorNameError('AHMED AL-NAZER')).toBeNull();
    expect(instructorNameError("O'Brien Stark")).toBeNull();
    expect(instructorNameError('NEW INSTRUCTOR 3')).toBeNull();
  });
  test('an NBSP variant is a DISTINCT string from the ASCII-space name (the dup vector)', () => {
    expect(`John${NBSP}Smith` === 'John Smith').toBe(false);
    expect(instructorNameError('John Smith')).toBeNull();            // one is allowed…
    expect(instructorNameError(`John${NBSP}Smith`)).toBeTruthy();    // …its look-alike is not
  });
});

describe('FU-669 #5 — prohibitedCharsError formula check is trim-anchored', () => {
  test.each([' =1+1', '  @SUM(A1)', '\t=cmd', ' =evil'])('rejects leading-blank formula %j', (v) => {
    expect(prohibitedCharsError(v)).toMatch(/formula/i);
  });
  test('still accepts ordinary text and still rejects a bare leading formula char', () => {
    expect(prohibitedCharsError('Software Engineering 1')).toBeNull();
    expect(prohibitedCharsError('=1+1')).toMatch(/formula/i);
    expect(prohibitedCharsError('A minus - in the middle is fine')).toBeNull();
  });
});
