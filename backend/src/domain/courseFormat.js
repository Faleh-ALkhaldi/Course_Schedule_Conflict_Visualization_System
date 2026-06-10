// NEW-FU-422 (Phase 104 items 3+4): course code/name format + single-flag rule.
// SINGLE SOURCE OF TRUTH shared by the API (create/update) and the cleanup; the
// frontend mirrors the same regex for live validation.

// Code: exactly "SWE " + a 3-digit number in 101..599. The department is always
// SWE (this is a Software Engineering scheduler), so no other prefix is allowed.
const COURSE_CODE_RE = /^SWE (\d{3})$/;

function courseCodeError(code) {
  const c = String(code ?? '').trim();
  const m = COURSE_CODE_RE.exec(c);
  if (!m) return 'Course code must be "SWE" + space + a 3-digit number, e.g. "SWE 206".';
  const n = parseInt(m[1], 10);
  if (n < 101 || n > 599) return `Course number must be 101–599 (got ${m[1]}).`;
  return null;
}
function isValidCourseCode(code) { return courseCodeError(code) === null; }

// Name: a real title — start with a letter, ≥3 chars, only letters / digits /
// spaces / basic title punctuation. NEW-FU-455 (Phase 108): also reject gibberish
// the old charset-only rule let through ("hhhhhhhhhhhhhh", "h......"):
//   (?!.*(.)\1{3})   — no run of 4+ identical characters
//   (?=.*[A-Za-z]{2}) — must contain at least one real 2-letter word
const COURSE_NAME_RE = /^(?!.*(.)\1{3})(?=.*[A-Za-z]{2})[A-Za-z][A-Za-z0-9 .,&()/+\-]{2,}$/;

function courseNameError(name) {
  const n = String(name ?? '').trim();
  if (n.length < 3) return 'Course name must be at least 3 characters.';
  if (!COURSE_NAME_RE.test(n)) return 'Course name must be a real title (letters, spaces, and basic punctuation only).';
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

module.exports = {
  COURSE_CODE_RE, COURSE_NAME_RE,
  isValidCourseCode, courseCodeError,
  isValidCourseName, courseNameError,
  courseFlagError,
};
