// NEW-FU-415 (Phase 103 item 1): course → term validity (curriculum rules).
//
// SINGLE SOURCE OF TRUTH for "may this course exist / be offered in this term?".
// Backend filtering (catalog, recommend, section create/update, term copy) and
// the cleanup migration all import THIS predicate so the rule lives in one place.
//
// Term codes are 3-digit "YYS": the first two digits order the academic year and
// the last digit is the season — 1 = Fall, 2 = Spring, 3 = Summer (KFUPM
// convention). So a plain integer compare orders terms (253 > 252), and the last
// character identifies the season.
//
// Current rules:
//   • SWE 412 (Software Engineering Project II) — retired after 252; valid only
//     in terms whose code is ≤ 252.
//   • SWE 399 (Summer Training) — a summer internship course; valid only in
//     Summer terms (season digit === '3').

function termCodeNum(semester) {
  const n = parseInt(String(semester ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function seasonDigit(semester) {
  return String(semester ?? '').trim().slice(-1);
}

// Course-code → { valid(semester) → bool, reason } map. Add future curriculum
// constraints here and every enforcement point picks them up automatically.
const COURSE_TERM_RULES = {
  'SWE 412': {
    reason: 'SWE 412 is offered only up to term 252.',
    valid: (semester) => {
      const n = termCodeNum(semester);
      return n != null && n <= 252;
    },
  },
  'SWE 399': {
    reason: 'SWE 399 (Summer Training) is offered only in Summer terms.',
    valid: (semester) => seasonDigit(semester) === '3',
  },
};

/** True unless a course-specific rule forbids this course in this term. */
function isCourseAllowedInTerm(courseCode, semester) {
  const rule = COURSE_TERM_RULES[courseCode];
  if (!rule) return true;
  return rule.valid(semester);
}

/** Human-readable reason a course is disallowed (or null if allowed). */
function disallowReason(courseCode, semester) {
  if (isCourseAllowedInTerm(courseCode, semester)) return null;
  return COURSE_TERM_RULES[courseCode]?.reason ?? `${courseCode} is not offered in this term.`;
}

/** Filter an array of course rows (each with .course_code) for a given term. */
function filterCoursesForTerm(courses, semester) {
  if (semester == null) return courses;
  return courses.filter((c) => isCourseAllowedInTerm(c.course_code ?? c.courseCode, semester));
}

module.exports = {
  COURSE_TERM_RULES,
  isCourseAllowedInTerm,
  disallowReason,
  filterCoursesForTerm,
  termCodeNum,
  seasonDigit,
};
