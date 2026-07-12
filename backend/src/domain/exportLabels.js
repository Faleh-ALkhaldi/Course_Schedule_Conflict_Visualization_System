// NEW-FU-666: the single source of truth for END-USER labels in every exported file
// (Excel / Word / PDF), plus the tolerant parsers that read those labels back on import.
//
// The database stores compact CODES (venue type "LectureHall", category "UG"/"GR", section
// type "Lec"/"Lab"/"Prj"/"Ths", gender "M"/"F"). Those codes are code-base jargon that must
// NEVER appear in an exported file — a department scheduler / instructor / admin reads
// "Lecture Hall", "Undergraduate", "Lecture", "Female", not "LectureHall"/"UG"/"Lec"/"M".
//
// Round-trip safety: the export emits the DISPLAY label; the importer's `*Code` parser accepts
// EITHER the display label OR the original code (case- and space-insensitive), so a freshly
// exported file AND any file produced before this change both re-import losslessly.

const VENUE_TYPE   = { Laboratory: 'Laboratory', LectureHall: 'Lecture Hall', Multipurpose: 'Multipurpose' };
const CATEGORY     = { UG: 'Undergraduate', GR: 'Graduate' };
// NEW-FU-688: the registrar's full Activity set. Sem (Seminar) is a stored section type; St (Summer
// Training) / Int (Internship) / Res (Research) are DERIVED activity labels for the off-campus-training
// (is_external) and research (is_research) course families — they never store as a section type, they
// are produced by effectiveSectionType from the course flags (+ term season for St/Int).
const SECTION_TYPE = { Lec: 'Lecture', Lab: 'Laboratory', Prj: 'Project', Ths: 'Thesis',
                       Sem: 'Seminar', St: 'Summer Training', Int: 'Internship', Res: 'Research' };
const SECTION_SHORT= { Lec: 'Lec', Lab: 'Lab', Prj: 'Prj', Ths: 'Ths',
                       Sem: 'SEM', St: 'ST', Int: 'INT', Res: 'RES' };   // grid cards stay compact
const GENDER       = { M: 'Male', F: 'Female' };

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');
const display = (map, code) => map[code] ?? (code ?? '');
// Accept the display label OR the raw code (any case/space variant) and return the CODE.
//   empty value      → `emptyFallback` (e.g. a legacy default, or '');
//   known label/code → the canonical code;
//   UNKNOWN value    → the trimmed original, UNCHANGED — so the strict import validators still
//                      reject a genuinely-bad value (it neither matched nor was silently dropped).
function toCode(map, value, emptyFallback = '') {
  const n = norm(value);
  if (!n) return emptyFallback;
  for (const [code, label] of Object.entries(map)) {
    if (norm(code) === n || norm(label) === n) return code;
  }
  return String(value).trim();
}

// Course Type is a DERIVED, mutually-exclusive label (not a stored enum). NEW-FU-687: the stored
// flag `is_capstone` is surfaced as "Project" (a capstone IS the senior project; "Project" is the
// accurate, broader name), and the new `is_thesis` flag surfaces as "Thesis". The importer keys on
// the substrings "project"/"capstone"/"thesis"/"external" (has_lab is re-derived from the Lab
// sections), and accepts the legacy "Capstone" label too, so these labels round-trip both ways.
function courseTypeLabel(sec) {
  if (sec.isThesis)   return 'Thesis';
  if (sec.isResearch) return 'Research';   // NEW-FU-688: the Research sibling of Thesis
  if (sec.isSeminar ?? sec.is_seminar) return 'Seminar';
  if (sec.isCapstone) return 'Project';
  if (sec.isExternal) return 'External';
  return sec.hasLab ? 'Has Laboratory' : 'Regular';
}

// NEW-FU-687: the EFFECTIVE section type — DISPLAY-ONLY (like sectionLabel, it never feeds rule
// logic; the conflict engine keeps reading the stored Lec/Lab so the lab-pairing semantics of
// R-14/R-15 never drift). A thesis course's non-lab meeting is a Thesis (Ths) session; a capstone/
// project course's non-lab meeting is a Project (Prj) session; a Lab stays a Lab; everything else
// (regular / external / seminar lecture) is a Lecture (Lec). A section already STORED as Prj/Ths
// (new data) is honoured as-is. This derives the correct label for legacy rows stored as 'Lec'
// WITHOUT rewriting them — so protected terms stay byte-identical while still exporting/displaying
// Project/Thesis correctly.
// NEW-FU-688: extended for the registrar Activity set. `season` (the term code's last digit, '1' Fall /
// '2' Spring / '3' Summer) is optional and only affects the off-campus-training family: an EXTERNAL
// course's session is "Summer Training" (St) in a Summer term and "Internship" (Int) otherwise — the
// SAME course, term-derived label, no stored change. Research rides like Thesis. A stored Sem is honoured.
function effectiveSectionType(sec, { season } = {}) {
  const stored = sec?.sectionType ?? sec?.section_type ?? 'Lec';
  if (['Lab', 'Prj', 'Ths', 'Sem', 'St', 'Int', 'Res'].includes(stored)) return stored;
  const isThesis   = (sec?.isThesis   ?? sec?.is_thesis)   === true;
  const isResearch = (sec?.isResearch ?? sec?.is_research) === true;
  const isSeminar  = (sec?.isSeminar  ?? sec?.is_seminar)  === true;
  const isCapstone = (sec?.isCapstone ?? sec?.is_capstone) === true;
  const isExternal = (sec?.isExternal ?? sec?.is_external) === true;
  if (isThesis)   return 'Ths';
  if (isResearch) return 'Res';
  if (isSeminar)  return 'Sem';
  if (isCapstone) return 'Prj';
  if (isExternal) return (String(season ?? '').slice(-1) === '3') ? 'St' : 'Int';
  return 'Lec';
}

// NEW-FU-688: which course families are INFO-ONLY — they exist as side-panel information and are NEVER
// drawn in the schedule grid and NEVER raise a conflict (off-campus training + thesis/research). Project
// is NOT here: it is conflict-exempt too but DOES appear in the grid when it has a time. This is the
// source of truth for grid-exclusion; Section.isConflictExempt owns the broader conflict-exempt set.
function isInfoOnlyCourse(sec) {
  return (sec?.isExternal ?? sec?.is_external) === true
      || (sec?.isThesis   ?? sec?.is_thesis)   === true
      || (sec?.isResearch ?? sec?.is_research) === true;
}

// NEW-FU-680: plain-language definitions of the two most-confused table columns, shown as a small
// legend beneath the section table in every PDF/Word/Excel export (all scopes). Users see
// "Course Type = Capstone" next to "Section Type = Lecture" and read it as a contradiction — but the
// two are INDEPENDENT: Course Type is the course's overall nature; Section Type is the kind of ONE
// meeting. "Regular" alone is also meaningless without a definition.
const COURSE_TYPE_DEFS = [
  ['Regular',        'a standard course with no special designation'],
  ['Project',        'a senior graduation (capstone) project; time and place optional, never raises a conflict'],
  ['Seminar',        'a graduate seminar course; one scheduled 75-minute meeting each week'],
  ['Thesis',         'an undergraduate or graduate thesis; independent study, no fixed time or place'],
  ['Research',       'an undergraduate or graduate research course; like Thesis, no fixed time or place'],
  ['Has Laboratory', 'a course that includes a required laboratory component'],
  ['External',       'off-campus training; Summer Training in summer terms, Internship in fall/spring; no time or place'],
];
const SECTION_TYPE_DEFS = [
  ['Lecture',         'a regular taught lecture session'],
  ['Laboratory',      'a hands-on laboratory session'],
  ['Seminar',         'a graduate one-day seminar session (75 minutes)'],
  ['Project',         'a project-supervision session; time and venue optional'],
  ['Thesis',          'a thesis-supervision session; no fixed time or place'],
  ['Research',        'a research-supervision session; no fixed time or place'],
  ['Summer Training', 'off-campus summer training; information only, not scheduled'],
  ['Internship',      'an off-campus internship; information only, not scheduled'],
];
const TYPE_LEGEND_TITLE = 'Column guide — Course Type vs. Section Type';
const TYPE_LEGEND_NOTE  = 'Course Type describes the whole course; Section Type describes this single meeting — the two are independent. For example, a Has Laboratory course has both Lecture and Laboratory sections.';
// Flat one-line-per-row strings for the renderers (PDF / Word / Excel) to print directly.
function typeLegendLines() {
  return [
    'Course Type — '  + COURSE_TYPE_DEFS.map(([k, v]) => `${k}: ${v}`).join('; ')  + '.',
    'Section Type — ' + SECTION_TYPE_DEFS.map(([k, v]) => `${k}: ${v}`).join('; ') + '.',
    TYPE_LEGEND_NOTE,
  ];
}

module.exports = {
  venueTypeDisplay:   (c) => display(VENUE_TYPE, c),
  venueTypeCode:      (v) => toCode(VENUE_TYPE, v, ''),       // '' → unknown (validator rejects)
  categoryDisplay:    (c) => display(CATEGORY, c),
  categoryCode:       (v) => toCode(CATEGORY, v, 'UG'),       // default UG (matches legacy import default)
  sectionTypeDisplay: (c) => display(SECTION_TYPE, c),        // full word — table cells
  sectionTypeCode:    (v) => toCode(SECTION_TYPE, v, ''),     // '' → unknown
  sectionTypeShort:   (c) => SECTION_SHORT[c] ?? (c ?? ''),   // short flag — grid cards
  genderDisplay:      (c) => display(GENDER, c),
  genderCode:         (v) => toCode(GENDER, v, ''),           // '' → unknown
  courseTypeLabel,
  effectiveSectionType,                                       // NEW-FU-687/688: display-only Lec→Prj/Ths/Sem/St/Int/Res derivation
  isInfoOnlyCourse,                                           // NEW-FU-688: external/thesis/research → grid-excluded + fully conflict-exempt
  VENUE_TYPE, CATEGORY, SECTION_TYPE, GENDER,
  // NEW-FU-680: the Course Type / Section Type legend (single source of truth for all 3 formats).
  COURSE_TYPE_DEFS, SECTION_TYPE_DEFS, TYPE_LEGEND_TITLE, TYPE_LEGEND_NOTE, typeLegendLines,
};
