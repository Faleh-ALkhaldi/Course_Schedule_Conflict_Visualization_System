// NEW-FU-510 (Batch 1): single source of truth for section-number
// normalization + range validation on the client.
//
// The registrar writes section numbers as two-digit, zero-padded values
// (Lec/Prj/Ths 01–49, Lab 50–99). Users, however, naturally type a bare
// "2" for section 2. This util bridges the two: it pads a single digit to
// the canonical two-digit form ("2" → "02") BEFORE any range check, so the
// modal accepts "2" while still storing/validating "02". "0" → "00" is left
// for the range check to reject (there is no zero section).
//
// The backend mirrors padSectionNumber() inline in
// backend/src/controllers/index.js (kept inline there for hot-path perf —
// no cross-package import). Change one side, change both.

// Lab takes 50–99; every other section type (Lec / Prj / Ths) takes 01–49.
// Mirrors SECTION_NUMBER_RANGE in backend/src/config/constants.js and
// SECTION_NUM_RE_BY_TYPE in the controller.
const LAB_RANGE = /^[5-9][0-9]$/;
const LEC_RANGE = /^(0[1-9]|[1-4][0-9])$/;

// Canonical two-digit form. A single 0–9 digit is zero-padded ("2" → "02",
// "0" → "00"); anything else (already two digits, empty, "100", letters) is
// returned trimmed and unchanged so the range check below can reject it with
// a precise, type-specific message.
export function padSectionNumber(raw) {
  const s = String(raw ?? '').trim();
  return /^[0-9]$/.test(s) ? s.padStart(2, '0') : s;
}

// The legal-range regex for a section type. Anything that isn't 'Lab'
// (Lec / Prj / Ths, or an unknown/blank type) uses the 01–49 lecture range,
// matching the modal's own `sectionType === 'Lab' ? ... : ...` branching.
export function rangeRegexForType(sectionType) {
  return sectionType === 'Lab' ? LAB_RANGE : LEC_RANGE;
}

// True when `raw` (after padding) is a legal section number for the type.
// "2" with a Lec type → pads to "02" → valid; "0"/"00" → invalid (no zero
// section); "60" with a Lec type → invalid (out of the 01–49 range).
export function isValidSectionNumber(raw, sectionType) {
  return rangeRegexForType(sectionType).test(padSectionNumber(raw));
}
