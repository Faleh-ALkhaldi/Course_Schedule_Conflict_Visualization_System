// NEW-FU-282 (Phase 56): canonical display label for a section, server side.
//
// Mirrors the frontend `sectionLabel` exported from AppContext.jsx so
// the same "§F-XX" (hyphenated) notation appears in:
//   • Conflict descriptions returned by the conflict engine
//   • Export CSV / PDF / Excel cell strings
//   • Any future server-rendered surface (email digests, etc.)
//
// IMPORTANT: This helper is a DISPLAY-ONLY utility — it doesn't touch
// rule logic, severity classification, or section relationships. The
// Phase 56 "don't touch conflict engine" constraint is about preserving
// rule semantics; updating the human-readable label in description
// strings is exactly the kind of standardization the phase calls for.
//
// Male / unset gender → "§01"
// Female ('F')        → "§F-01"
//
// Accepts either camelCase (`sectionNumber`) or snake_case
// (`section_number`) so callers don't have to remember which layer
// produced the row.
function sectionLabel(section, { withSection = true } = {}) {
  const num    = (section?.sectionNumber ?? section?.section_number ?? '').toString();
  const gender = section?.gender ?? 'M';
  const prefix = withSection ? '§' : '';
  return gender === 'F' ? `${prefix}F-${num}` : `${prefix}${num}`;
}

module.exports = { sectionLabel };
