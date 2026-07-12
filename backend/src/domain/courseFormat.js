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

// NEW-FU-671 (re-audit): the SINGLE academic-level resolver shared by every import commit path
// (ExportService.commitRows whole-term REPLACE and ScopedImportService scoped MERGE). It is
// whitespace-tolerant on purpose: the PDF export's narrow Academic-Level column char-wraps
// "Sophomore" → "Sophomor"+"e", which the positional parser rejoins as "Sophomor e"; collapsing
// internal whitespace before matching recovers it (no UG level word has an internal space, so this
// is loss-free). GR maps to Graduate regardless of the level text; an unrecognized level falls back
// to Freshman (the historical default — keeps known-code re-imports lossless). Keeping ONE copy is
// what stops the two paths from silently diverging again: the scoped copy had missed the
// whitespace fix, so a wrapped level there was still defaulting every such row to Freshman.
const ACADEMIC_LEVELS = ['Freshman', 'Sophomore', 'Junior', 'Senior'];
function resolveAcademicLevel(rawLevel, category) {
  if (String(category ?? '').toUpperCase() === 'GR') return 'Graduate';
  const norm = String(rawLevel ?? '').replace(/\s+/g, '').toLowerCase();
  return ACADEMIC_LEVELS.find((l) => l.toLowerCase() === norm) ?? 'Freshman';
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
  // NEW-FU-662: bound the length BEFORE the regex below. The DB column is VARCHAR(120), and
  // COURSE_NAME_RE's negative lookahead (`(?!.*(.)\1{3})`) is O(n²) on a long no-repeat string —
  // capping here both matches the DB limit and removes any ReDoS exposure on crafted input.
  if (n.length > 120) return 'Course name is too long (max 120 characters).';
  if (!/\s/.test(n)) return 'Course name needs at least two words (for example, “Software Architecture”).';
  if (!COURSE_NAME_RE.test(n))
    // NEW-FU-659: plain-language wording (the old message used jargon — "real English
    // title", "other scripts", "a character repeated 4+ times"). The regex still enforces
    // the same charset + anti-gibberish rules; only the user-facing text changed.
    return 'Course name should use only English letters, numbers, spaces, and basic punctuation (for example, “Software Engineering”).';
  return null;
}
function isValidCourseName(name) { return courseNameError(name) === null; }

// NEW-FU-597 (Batch 27): accurate English TITLE CASE for course names — the server-side
// mirror of the modal's live title-casing, so a name created via ANY path (direct API,
// import) is stored in the same canonical case. Capitalize each word; lowercase the small
// "minor" words unless they lead the title; keep Roman numerals upper ("Compilers II").
const COURSE_MINOR_WORDS = new Set(['a','an','the','and','or','nor','but','for','yet','so',
  'of','to','in','on','at','by','as','up','off','per','via','with','from','into']);
const COURSE_ROMAN_RE = /^(?=[ivx])x{0,3}(ix|iv|v?i{0,3})$/i;
function titleCaseCourseName(raw) {
  return String(raw ?? '').split(' ').map((w, i) => {
    if (w === '') return w;
    const lower = w.toLowerCase();
    if (COURSE_ROMAN_RE.test(lower)) return w.toUpperCase();
    if (i !== 0 && COURSE_MINOR_WORDS.has(lower)) return lower;
    return lower.replace(/(^|[-/'(])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  }).join(' ');
}

// At most ONE of has_lab / project(capstone) / external / thesis. A plain lecture course has none;
// these are mutually-exclusive course TYPES, not stackable attributes.
// NEW-FU-687: "Project" is the user-facing name of the stored is_capstone flag; "Thesis" is the
// new is_thesis flag. Both stay mutually exclusive with the others.
function courseFlagError({ hasLab, isCapstone, isExternal, isThesis, isResearch, isSeminar } = {}) {
  const count = [hasLab, isCapstone, isExternal, isThesis, isResearch, isSeminar].filter(Boolean).length;
  return count > 1
    ? 'A course can be only one of: Has-lab, Project, External, Thesis, Research, or Seminar (pick at most one).'
    : null;
}

function seminarFlagError({ courseCode, academicLevel, category, credits, isSeminar } = {}) {
  if (!isSeminar) return null;
  const m = COURSE_CODE_RE.exec(String(courseCode ?? '').trim());
  const n = m ? parseInt(m[1], 10) : NaN;
  if (category !== 'GR' || academicLevel !== 'Graduate' || n < 500 || n > 699) {
    return 'The Seminar flag is only allowed for Graduate SWE 500–699 courses.';
  }
  if (Number(credits) !== 1) {
    return 'Seminar courses must be exactly 1 credit.';
  }
  return null;
}

// NEW-FU-561 (audit P2-8): a 4-credit course MUST have a lab. sectionPattern enforces
// `credits === 4 && !hasLab` at SECTION create, but the course-level validators never
// did — so a 4-credit no-lab (or capstone/external) course was creatable and then could
// accept NO section (every section failed pattern validation). Enforce the invariant
// where the course is DEFINED. (capstone/external are mutually exclusive with hasLab via
// courseFlagError, so this also blocks a 4-credit capstone/external.)
function creditsFlagError({ credits, hasLab, isCapstone } = {}) {
  const c = Number(credits);
  if (c === 4 && !hasLab)
    return '4-credit courses must be marked “Has lab” — a 4-credit course requires a lab section.';
  // NEW-FU-600 (Batch 28): a lab only fits a 3- or 4-credit course. 0/1/2-credit courses meet
  // too few hours to carry a lab section — reject the Has-lab flag for them (the modal disables it).
  if ((c === 0 || c === 1 || c === 2) && hasLab)
    return 'Only 3- and 4-credit courses can have a lab section — remove the “Has lab” flag for a 0/1/2-credit course.';
  // NEW-FU-602 (Batch 28 item 3): a 0-credit course is a capstone part (e.g. SWE 413 Senior
  // Project I) — it carries no academic credit because it is the capstone itself. Enforce the
  // Capstone flag so a 0-credit plain lecture (which has no legal credit→pattern meaning) can
  // never be created. As a capstone it is venue-exempt but still instructor-required and
  // time-clash-checked (handled where the section/venue/window rules live).
  if (c === 0 && !isCapstone)
    return 'A 0-credit course must be a Project — set the Project flag (a 0-credit course is a capstone/project part, e.g. SWE 413).';
  return null;
}

module.exports = {
  COURSE_CODE_RE, COURSE_NAME_RE,
  isValidCourseCode, courseCodeError,
  isValidCourseName, courseNameError, titleCaseCourseName,
  courseFlagError, seminarFlagError, creditsFlagError,
  levelForCourseNumber, courseCodeLevelError, resolveAcademicLevel,
};
