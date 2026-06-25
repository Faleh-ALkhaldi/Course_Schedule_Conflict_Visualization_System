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
const SECTION_TYPE = { Lec: 'Lecture', Lab: 'Laboratory', Prj: 'Project', Ths: 'Thesis' };
const SECTION_SHORT= { Lec: 'Lec', Lab: 'Lab', Prj: 'Prj', Ths: 'Ths' };   // grid cards stay compact
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

// Course Type is a DERIVED, mutually-exclusive label (not a stored enum). The importer only
// keys on the substrings "capstone"/"external" (has_lab is re-derived from the Lab sections),
// so these full-word labels keep those substrings and round-trip unchanged.
function courseTypeLabel(sec) {
  if (sec.isCapstone) return 'Capstone';
  if (sec.isExternal) return 'External';
  return sec.hasLab ? 'Has Laboratory' : 'Regular';
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
  VENUE_TYPE, CATEGORY, SECTION_TYPE, GENDER,
};
