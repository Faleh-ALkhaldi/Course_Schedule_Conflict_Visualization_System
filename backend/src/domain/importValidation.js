// audit-2 Phase-11 P2: shared up-front validation for the IMPORT path.
//
// ExportService.commitRows historically inserted raw parsed rows, bypassing the
// domain-validation stack the manual createSection path enforces. Two concrete
// corruptions resulted:
//   • a 4-credit course imported with no lab section landed with has_lab=false,
//     which the app treats as impossible — every later UI add-section then failed
//     validateSectionPattern, leaving the course unschedulable; and
//   • out-of-range section numbers / illegal patterns were inserted verbatim, or
//     (when they tripped a DB CHECK) aborted the whole transaction mid-loop with a
//     cryptic "current transaction is aborted" pile.
//
// This module derives has_lab from the imported Lab sections (the file carries no
// explicit flag) and validates every row the SAME way createSection does, so
// commitRows can fail cleanly BEFORE its destructive DELETE. Pure (no DB / no I/O)
// so it is unit-testable in isolation.
const { creditsFlagError } = require('./courseFormat');
const { validateSectionPattern } = require('./sectionPattern');

// Type-scoped section_number ranges — mirrors SECTION_NUM_RE_BY_TYPE in
// controllers/index.js AND the DB CHECK `sections_section_number_type_scoped_chk`
// (migrations 010/020): Lec/Prj/Ths take 01–49, Lab takes 50–99. Because this set
// equals the DB constraint, validating it up front only converts a would-be
// mid-transaction abort into a clean message — it never rejects a row the DB
// would have accepted.
const RANGE_BY_TYPE = {
  Lec: /^(0[1-9]|[1-4][0-9])$/,
  Prj: /^(0[1-9]|[1-4][0-9])$/,
  Ths: /^(0[1-9]|[1-4][0-9])$/,
  Sem: /^(0[1-9]|[1-4][0-9])$/,
  Lab: /^[5-9][0-9]$/,
};

// A course "has a lab" iff any of its imported sections is a Lab OR its "Course Type" column says
// "Has Laboratory". This is the authoritative has_lab signal for import, persisted onto the course.
function deriveHasLabByCourse(rowData) {
  const map = new Map();
  for (const r of rowData) {
    const key = String(r.courseCode ?? '').toLowerCase();
    const isLab = (r.sectionType ?? 'Lec') === 'Lab';
    // NEW-FU-681: also honor the "Has Laboratory" Course Type label. The old derivation looked ONLY
    // at Lab sections, so a scoped / lecture-only import (the lab is taught by another instructor or
    // in another venue, and is absent from THIS file) dropped has_lab → the course re-imported as a
    // plain 3-credit course → R-15 wrongly demanded 150 min of lecture. A has_lab 3-credit lecture
    // legitimately meets only 100 min (the lab carries the 3rd credit), so reading the column keeps
    // the flag even with no Lab row present.
    map.set(key, (map.get(key) || false) || isLab || Boolean(r.courseTypeHasLab));
  }
  return map;
}

// Validate the whole row set. Returns { errors:[...deduped strings], hasLabByCourse:Map }.
// `errors` empty ⇒ safe to commit.
function validateImportRows(rowData) {
  const errors = [];
  const hasLabByCourse = deriveHasLabByCourse(rowData);

  // Per-course: the 4-credit ⇒ has-lab invariant. Import carries no
  // is_capstone/is_external signal, so only the has_lab axis is checkable here.
  // NEW-FU-657: capstone is a course-level flag carried in the import's Course Type
  // column (any row marks the course). A 0-credit course is legal ONLY as a capstone,
  // so creditsFlagError must see the flag or it wrongly rejects a re-imported capstone.
  const isCapstoneByCourse = new Map();
  for (const r of rowData) {
    if (r.isCapstone) isCapstoneByCourse.set(String(r.courseCode ?? '').toLowerCase(), true);
  }
  const seen = new Set();
  for (const r of rowData) {
    const key = String(r.courseCode ?? '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const ce = creditsFlagError({
      credits: r.credits,
      hasLab: hasLabByCourse.get(key) || false,
      isCapstone: isCapstoneByCourse.get(key) || false,
    });
    if (ce) errors.push(`${r.courseCode}: ${ce}`);
  }

  // Per-section: type-scoped number range (== the DB CHECK) + the full KFUPM
  // pattern gate (the same validateSectionPattern createSection applies).
  for (const r of rowData) {
    const type = r.sectionType ?? 'Lec';
    const num  = String(r.sectionNumber ?? '');
    const hasLab = hasLabByCourse.get(String(r.courseCode ?? '').toLowerCase()) || false;
    const re = RANGE_BY_TYPE[type];
    if (!re) {
      errors.push(`${r.courseCode} §${num}: invalid section type "${type}" (expected Lec, Lab, Prj, Ths, or Sem).`);
    } else if (!re.test(num)) {
      errors.push(`${r.courseCode} §${num} (${type}): section number must be ${type === 'Lab' ? '50–99' : '01–49'} for ${type} sections.`);
    }
    const pat = validateSectionPattern({
      credits: Number(r.credits), hasLab, sectionType: type,
      days: r.days, startTime: r.startTime, endTime: r.endTime,
    });
    if (!pat.ok) errors.push(`${r.courseCode} §${num}: ${pat.error}`);
  }

  return { errors: [...new Set(errors)], hasLabByCourse };
}

module.exports = { validateImportRows, deriveHasLabByCourse, RANGE_BY_TYPE };
