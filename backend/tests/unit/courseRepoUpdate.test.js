/**
 * credit-audit follow-up — CourseRepository.update() must perform a PARTIAL update.
 *
 * The controller (updateCourse) passes `undefined` for every field the client did
 * not send and relies on the repo doing a "COALESCE-style update" to preserve the
 * existing columns. Before this fix the repo overwrote course_code/name/academic_
 * level/category directly (NULLing them on a partial PUT — a 409 on the NOT NULL +
 * UNIQUE course_code, or silent corruption) and ran parseInt(undefined,10) → NaN
 * for credits (pg rejects NaN on an integer column). num_sections fell back to `|| 1`,
 * silently resetting an unsent value.
 *
 * Pure unit test — the pg layer is mocked, so this never touches any database
 * (honours the "unit tests only, SKIP_TEST_DB=1" rule).
 */

// Mock the pg access layer BEFORE requiring the repo. The factory may only
// reference variables whose names start with `mock` (jest hoisting rule).
const mockQuery = jest.fn();
jest.mock('../../src/config/db', () => ({
  query: (...args) => mockQuery(...args),
  getClient: jest.fn(),
}));

const { CourseRepository } = require('../../src/repositories/repositories');

const ID = '11111111-1111-1111-1111-111111111111';
// The row findById() returns after the UPDATE (SWE 413 — the 0-credit capstone).
const EXISTING = {
  id: ID, course_code: 'SWE 413', name: 'Senior Design Project I', credits: 0,
  academic_level: 'Senior', category: 'UG', num_sections: 1,
  has_lab: false, is_capstone: true, is_external: false,
};

// update() issues two queries: the UPDATE, then a SELECT (via findById).
function programDb() {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql) => {
    if (/^\s*UPDATE/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/^\s*SELECT/i.test(sql)) return { rows: [EXISTING] };
    return { rows: [], rowCount: 0 };
  });
}

const updateCall = () => mockQuery.mock.calls.find((c) => /^\s*UPDATE/i.test(String(c[0])));

describe('CourseRepository.update (partial-update / COALESCE)', () => {
  const repo = new CourseRepository();
  beforeEach(programDb);

  test('partial PUT {credits} only — COALESCEs every column and sends NULL (not NaN) for unsent fields', async () => {
    await repo.update(ID, { credits: 2 });
    const call = updateCall();
    expect(call).toBeDefined();
    const [sql, params] = call;

    // Every column is preserved via COALESCE($n, col) so an unsent field keeps its value.
    expect(sql).toMatch(/course_code\s*=\s*COALESCE\(\$2,\s*course_code\)/i);
    expect(sql).toMatch(/name\s*=\s*COALESCE\(\$3,\s*name\)/i);
    expect(sql).toMatch(/credits\s*=\s*COALESCE\(\$4,\s*credits\)/i);
    expect(sql).toMatch(/academic_level\s*=\s*COALESCE\(\$5,\s*academic_level\)/i);
    expect(sql).toMatch(/category\s*=\s*COALESCE\(\$6,\s*category\)/i);
    expect(sql).toMatch(/num_sections\s*=\s*COALESCE\(\$7,\s*num_sections\)/i);

    // params = [id, courseCode($2), name($3), credits($4), academicLevel($5), category($6), numSections($7)]
    expect(params[0]).toBe(ID);
    expect(params[1]).toBeNull();   // courseCode unsent → NULL → COALESCE keeps course_code (no NOT NULL/UNIQUE violation)
    expect(params[2]).toBeNull();   // name unsent → NULL
    expect(params[3]).toBe(2);      // credits applied
    expect(params[4]).toBeNull();   // academicLevel unsent → NULL
    expect(params[5]).toBeNull();   // category unsent → NULL
    expect(params[6]).toBeNull();   // numSections unsent → NULL (NOT silently reset to 1)

    // Regression guard for the old parseInt(undefined,10) → NaN bug: no bound param is NaN.
    params.forEach((p) => expect(Number.isNaN(p)).toBe(false));

    // has_lab is omitted entirely when not provided (its existing conditional clause).
    expect(sql).not.toMatch(/has_lab/i);
  });

  test('unsent num_sections is preserved as NULL, never coerced to 1', async () => {
    await repo.update(ID, { name: 'Renamed Course' });
    const [, params] = updateCall();
    expect(params[2]).toBe('Renamed Course'); // name applied
    expect(params[6]).toBeNull();             // num_sections preserved (was the `|| 1` bug)
  });

  test('full update passes all fields through and includes has_lab when provided', async () => {
    await repo.update(ID, {
      courseCode: 'SWE 999', name: 'Capstone X', credits: 3,
      academicLevel: 'Senior', category: 'UG', numSections: 2, hasLab: true,
    });
    const [sql, params] = updateCall();
    expect(params[1]).toBe('SWE 999');
    expect(params[2]).toBe('Capstone X');
    expect(params[3]).toBe(3);
    expect(params[4]).toBe('Senior');
    expect(params[5]).toBe('UG');
    expect(params[6]).toBe(2);
    expect(sql).toMatch(/has_lab\s*=\s*\$8/i);
    expect(params[7]).toBe(true);
  });

  test('returns the refreshed row from findById', async () => {
    const out = await repo.update(ID, { credits: 2 });
    expect(out).toEqual(EXISTING);
  });
});
