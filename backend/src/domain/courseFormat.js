// NEW-FU-422 (Phase 104 items 3+4): course code/name format + single-flag rule.
// SINGLE SOURCE OF TRUTH shared by the API (create/update) and the cleanup; the
// frontend mirrors the same regex for live validation.

// Code: exactly "SWE " + a 3-digit number in 101..699. The department is always
// SWE (this is a Software Engineering scheduler), so no other prefix is allowed.
// NEW-FU-576 (Batch 22): upper bound raised 599 → 699 — graduate courses run 500–699
// (e.g. SWE 610 Thesis exists in the catalog), which the old 599 cap wrongly rejected.
const COURSE_CODE_RE = /^SWE (\d{3})$/;

function courseCodeError(code) {
  const c = String(code ?? '').trim();
  const m = COURSE_CODE_RE.exec(c);
  if (!m) return 'Course code must be "SWE" + space + a 3-digit number, e.g. "SWE 206".';
  const n = parseInt(m[1], 10);
  if (n < 101 || n > 699) return `Course number must be 101–699 (got ${m[1]}).`;
  return null;
}
function isValidCourseCode(code) { return courseCodeError(code) === null; }

// NEW-FU-576 (Batch 22): the course NUMBER fixes the academic level/category —
// 100–199 Freshman, 200–299 Sophomore, 300–399 Junior, 400–499 Senior, 500–699 Graduate.
function levelForCourseNumber(n) {
  if (n >= 100 && n <= 199) return { category: 'UG', level: 'Freshman' };
  if (n >= 200 && n <= 299) return { category: 'UG', level: 'Sophomore' };
  if (n >= 300 && n <= 399) return { category: 'UG', level: 'Junior' };
  if (n >= 400 && n <= 499) return { category: 'UG', level: 'Senior' };
  if (n >= 500 && n <= 699) return { category: 'GR', level: 'Graduate' };
  return null;
}
// Backstop for the frontend's live check: the chosen academic level/category must agree
// with what the course number implies. Returns null when the code is malformed
// (courseCodeError owns that) or when level + number already agree.
function courseCodeLevelError(code, academicLevel, category) {
  const m = COURSE_CODE_RE.exec(String(code ?? '').trim());
  if (!m) return null;
  const expected = levelForCourseNumber(parseInt(m[1], 10));
  if (!expected) return null;
  if (category === expected.category && academicLevel === expected.level) return null;
  const want = expected.category === 'GR' ? 'Graduate' : `Undergraduate ${expected.level}`;
  return `SWE ${m[1]} is a ${expected.level} course — its academic level must be ${want} to match the number.`;
}

// Name: a real, multi-word title in ENGLISH only — start with a letter, only
// English letters / digits / spaces / basic title punctuation (incl. apostrophe).
// NEW-FU-455 (Phase 108): reject gibberish the charset-only rule let through
// ("hhhhhhhhhhhhhh", "h......"):
//   (?!.*(.)\1{3})   — no run of 4+ identical characters
//   (?=.*[A-Za-z]{2}) — must contain at least one real 2-letter word
// NEW-FU-552 (Batch 17 Issue 1): the allowed CHARSET is the single source of truth
// for both the runtime input filter (frontend strips anything outside it) and this
// validator; non-English letters ($cript, Arabic, etc.) and junk symbols ($ # @ %)
// are excluded by construction. A real course name is never a single word (even a
// one-word title carries a Roman numeral, e.g. "Compilers II"), so a SPACE is required.
const COURSE_NAME_CHARSET = "A-Za-z0-9 .,&()/+'\\-";
const COURSE_NAME_RE = new RegExp(`^(?!.*(.)\\1{3})(?=.*[A-Za-z]{2})[A-Za-z][${COURSE_NAME_CHARSET}]+$`);

function courseNameError(name) {
  const n = String(name ?? '').trim();
  if (n.length < 3) return 'Course name must be at least 3 characters.';
  if (!/\s/.test(n)) return 'Course name needs at least two words (e.g. "Software Architecture").';
  if (!COURSE_NAME_RE.test(n))
    // NEW-FU-561 (audit P3): COURSE_NAME_RE also rejects gibberish (a char repeated 4+
    // times) and names with no real 2-letter word — the old "no symbols/other scripts"
    // message mis-described those valid-charset failures. Cover all of its conditions.
    return 'Course name must be a real English title (letters, digits, spaces, basic punctuation) — no symbols, other scripts, gibberish, or a character repeated 4+ times.';
  return null;
}
function isValidCourseName(name) { return courseNameError(name) === null; }

// At most ONE of has_lab / capstone / external. A plain lecture course has none;
// these three are mutually-exclusive course TYPES, not stackable attributes.
function courseFlagError({ hasLab, isCapstone, isExternal } = {}) {
  const count = [hasLab, isCapstone, isExternal].filter(Boolean).length;
  return count > 1
    ? 'A course can be only one of: Has-lab, Capstone, or External (pick at most one).'
    : null;
}

// NEW-FU-561 (audit P2-8): a 4-credit course MUST have a lab. sectionPattern enforces
// `credits === 4 && !hasLab` at SECTION create, but the course-level validators never
// did — so a 4-credit no-lab (or capstone/external) course was creatable and then could
// accept NO section (every section failed pattern validation). Enforce the invariant
// where the course is DEFINED. (capstone/external are mutually exclusive with hasLab via
// courseFlagError, so this also blocks a 4-credit capstone/external.)
function creditsFlagError({ credits, hasLab } = {}) {
  return (Number(credits) === 4 && !hasLab)
    ? '4-credit courses must be marked “Has lab” — a 4-credit course requires a lab section.'
    : null;
}

module.exports = {
  COURSE_CODE_RE, COURSE_NAME_RE,
  isValidCourseCode, courseCodeError,
  isValidCourseName, courseNameError,
  courseFlagError, creditsFlagError,
  levelForCourseNumber, courseCodeLevelError,
};
