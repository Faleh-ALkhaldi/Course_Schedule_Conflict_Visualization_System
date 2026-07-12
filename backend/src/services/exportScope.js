/**
 * exportScope — shared scope helpers for the combined export + import.
 *
 * NEW-FU-660/FU-682: an instructor- or venue-scoped export is a focused file, not a
 * whole-term snapshot. It carries the selected entity's own schedule plus any
 * complementary Lecture/Lab sections and reference rows required to keep the file
 * valid and safely re-importable. (FU-657 deliberately put the whole-term table into
 * every file so a scoped file could rebuild the entire term; FU-660 reversed that,
 * then FU-682 added the missing complementary half of lab courses.)
 *
 * These helpers compute the scoped reference sets ONCE, in SQL, so all three export
 * builders (Excel / PDF / Word) stay byte-for-byte consistent, and they stamp each
 * file with a machine-readable SCOPE the importer reads to pick the matching
 * behavior (full → replace the term; instructor/venue → merge into the term).
 */
const { query } = require('../config/db');

// Which of the three scopes a filter denotes. A filter with no id (or an unknown
// type) is the whole-term ('full') export — the safe default.
function scopeOf(filter = { type: 'full' }) {
  if (filter && filter.type === 'instructor' && filter.id) return 'instructor';
  if (filter && filter.type === 'venue'      && filter.id) return 'venue';
  return 'full';
}

// NEW-FU-682: a LAB course has a Lecture AND a Lab section, usually taught by DIFFERENT instructors /
// in DIFFERENT venues — so a scoped (instructor/venue) export covers only ONE half, and re-importing
// it rebuilt an INCOMPLETE course (missing-section / coverage conflicts). The scope now also matches
// the COMPLEMENTARY half: every section of the scope's OWN has_lab courses, even those taught by
// someone else / held elsewhere. This `s.course_id IN (…the scope's has_lab courses…)` subquery is
// self-contained (it only references `s.course_id`, so it composes into any query that joins
// `sections s` — the OH / instructor / venue reference fetchers all pick the complement up for free,
// so the re-import gets the complement's instructor + venue + office hours too).
function complementSub(col) {
  // The complement is the MISSING TYPE only: a section of one of the scope's has_lab courses whose
  // section_type the scope does NOT itself provide for that course (the Lab when this file holds the
  // Lecture, or the Lecture when it holds the Lab). The `NOT IN (…types the scope covers…)` clause keeps
  // it from dragging in same-type siblings (another instructor's Lecture of the same course) — only the
  // half needed to complete the Lec/Lab pairing rides along.
  return `(s.course_id IN (
             SELECT s2.course_id FROM sections s2 JOIN courses c2 ON c2.id = s2.course_id
              WHERE s2.schedule_id = $1 AND s2.${col} = $2 AND c2.has_lab = true)
           AND s.section_type NOT IN (
             SELECT s3.section_type FROM sections s3
              WHERE s3.schedule_id = $1 AND s3.${col} = $2 AND s3.course_id = s.course_id))`;
}

// The section-set predicate for a filter, as a SQL fragment + bound params. params[0]
// is always scheduleId so the reference queries below can append it directly.
function sectionScopeClause(scheduleId, filter = { type: 'full' }) {
  const scope = scopeOf(filter);
  if (scope === 'instructor') return { clause: `s.schedule_id = $1 AND (s.instructor_id = $2 OR ${complementSub('instructor_id')})`, params: [scheduleId, filter.id] };
  if (scope === 'venue')      return { clause: `s.schedule_id = $1 AND (s.venue_id = $2 OR ${complementSub('venue_id')})`,           params: [scheduleId, filter.id] };
  return { clause: 's.schedule_id = $1', params: [scheduleId] };
}

// Office hours for the export (snake_case rows, matching what every renderer consumes).
//   • instructor scope → exactly that instructor's OH (even with no sections — the
//     modal-blocked edge case, so the scoped file is still self-contained);
//   • full scope → EVERY office hour the term owns;
//   • venue scope → the OH of every instructor who teaches in the venue.
// NEW-FU-665b: full scope was previously restricted to instructors who teach a section, which
// silently DROPPED the office hours of a term-owned instructor with no sections (sabbatical /
// admin) — so a whole-term export didn't round-trip every OH. A complete term snapshot must
// carry them all; scope to the term's OWN instructors (per-term isolation, FU-645).
async function fetchOfficeHours(scheduleId, filter) {
  const scope = scopeOf(filter);
  const SELECT = `SELECT i.name AS instructor_name, oh.day,
            oh.start_time::text AS start_time, oh.end_time::text AS end_time
       FROM office_hours oh JOIN instructors i ON i.id = oh.instructor_id`;
  if (scope === 'instructor') {
    // NEW-FU-682: the scoped instructor's OH PLUS the office hours of every instructor who teaches a
    // CARRIED COMPLEMENT section (the lab's teacher when this file holds the lecture, and vice versa) —
    // so a re-import recreates those instructors WITH their office hours and the completed course raises
    // no R-13 ("teaching but no office hours"). `oh.instructor_id = $2` also covers the modal-blocked
    // edge case of the scoped instructor having OH but no sections.
    const { clause, params } = sectionScopeClause(scheduleId, filter);
    return (await query(
      `${SELECT} WHERE oh.instructor_id = $2
          OR oh.instructor_id IN (SELECT DISTINCT s.instructor_id FROM sections s WHERE ${clause} AND s.instructor_id IS NOT NULL)
        ORDER BY i.name, oh.day, oh.start_time`, params)).rows;
  }
  if (scope === 'full') {
    return (await query(
      `${SELECT} WHERE i.owner_semester = (SELECT semester FROM schedules WHERE id = $1)
        ORDER BY i.name, oh.day, oh.start_time`, [scheduleId])).rows;
  }
  const { clause, params } = sectionScopeClause(scheduleId, filter);
  return (await query(
    `${SELECT} WHERE oh.instructor_id IN (
        SELECT DISTINCT s.instructor_id FROM sections s
         WHERE ${clause} AND s.instructor_id IS NOT NULL)
      ORDER BY i.name, oh.day, oh.start_time`, params)).rows;
}

// Instructor reference rows. For instructor scope, EXACTLY the one instructor — read
// from the instructor record directly so option (a) ("add the instructor only") works
// even in the (modal-blocked) edge case of an instructor with no sections. For venue
// scope, every instructor appearing in the scoped section set.
// NEW-FU-665b: full scope returns EVERY instructor the term owns (not just those teaching a
// section), so a term-owned instructor with office hours but no sections is carried in the
// Instructors sheet — its OH (now exported, see fetchOfficeHours) therefore round-trips, and
// the importer's OH gate recognizes it as one of the file's own instructors.
async function fetchInstructorsRef(scheduleId, filter) {
  const scope = scopeOf(filter);
  if (scope === 'instructor') {
    // NEW-FU-682: the scoped instructor (always — even with no sections, the modal-blocked edge case)
    // PLUS every instructor of a carried complement section, so the Instructors reference matches the
    // sections actually in the file and each carried instructor re-imports with its real email.
    const { clause, params } = sectionScopeClause(scheduleId, filter);
    return (await query(
      `SELECT DISTINCT name, email FROM (
         SELECT name, email FROM instructors WHERE id = $2
         UNION
         SELECT i.name, i.email FROM instructors i JOIN sections s ON s.instructor_id = i.id WHERE ${clause}
       ) u ORDER BY name`, params)).rows;
  }
  if (scope === 'full') {
    return (await query(
      `SELECT name, email FROM instructors
        WHERE owner_semester = (SELECT semester FROM schedules WHERE id = $1) ORDER BY name`,
      [scheduleId])).rows;
  }
  const { clause, params } = sectionScopeClause(scheduleId, filter);
  const res = await query(
    `SELECT DISTINCT i.name, i.email FROM instructors i
       JOIN sections s ON s.instructor_id = i.id WHERE ${clause} ORDER BY i.name`, params);
  return res.rows;
}

// Venue reference rows. For venue scope, EXACTLY the one venue (read from the record,
// so its capacity/type are always present for option (a)). For instructor / full
// scope, every venue appearing in the scoped section set.
async function fetchVenuesRef(scheduleId, filter) {
  if (scopeOf(filter) === 'venue') {
    // NEW-FU-682: the scoped venue (always) PLUS every venue of a carried complement section, so the
    // Venues reference matches the sections in the file and each carried venue re-imports with its real
    // type + capacity (a Lab venue must come back typed 'Laboratory', or it would fire R-11/R-12).
    const { clause, params } = sectionScopeClause(scheduleId, filter);
    return (await query(
      `SELECT DISTINCT name, type, capacity FROM (
         SELECT name, type, capacity FROM venues WHERE id = $2
         UNION
         SELECT v.name, v.type, v.capacity FROM venues v JOIN sections s ON s.venue_id = v.id WHERE ${clause}
       ) u ORDER BY name`, params)).rows;
  }
  // NEW-FU-670: a WHOLE-TERM file now lists EVERY owner-term venue (like instructors), not only
  // the venues that back a section. A complete Venues reference makes section-less venues
  // round-trip losslessly AND lets the import safely PRUNE venues the new file no longer carries.
  if (scopeOf(filter) === 'full') {
    return (await query(
      `SELECT name, type, capacity FROM venues
        WHERE owner_semester = (SELECT semester FROM schedules WHERE id = $1) ORDER BY name`,
      [scheduleId])).rows;
  }
  const { clause, params } = sectionScopeClause(scheduleId, filter);
  const res = await query(
    `SELECT DISTINCT v.name, v.type, v.capacity FROM venues v
       JOIN sections s ON s.venue_id = v.id WHERE ${clause} ORDER BY v.name`, params);
  return res.rows;
}

// The scoped entity's display name (for headings + the Meta marker).
async function fetchScopeEntity(filter) {
  if (scopeOf(filter) === 'instructor')
    return (await query(`SELECT name FROM instructors WHERE id = $1`, [filter.id])).rows[0]?.name || 'Instructor';
  if (scopeOf(filter) === 'venue')
    return (await query(`SELECT name FROM venues WHERE id = $1`, [filter.id])).rows[0]?.name || 'Venue';
  return 'Full Semester';
}

// The section-table heading. It doubles as the PDF/Word scope MARKER the importer
// detects (the phrases "Instructor Schedule" / "Venue Schedule"); a whole-term file
// keeps the historical "Full Semester (all sections)" wording, so files exported
// before FU-660 still detect as 'full' (no behavior change for them).
function tableTitle(semester, scope, entity) {
  const sem = semester || 'Schedule';
  if (scope === 'instructor') return `${sem} — Instructor Schedule · ${entity}`;
  if (scope === 'venue')      return `${sem} — Venue Schedule · ${entity}`;
  return `${sem} — Full Semester (all sections)`;
}

// Detect the file's scope from rendered PDF/Word text (the table heading above). A
// file with neither phrase is a whole-term export → 'full'.
function detectScopeFromText(text) {
  const t = String(text || '');
  // NEW-FU-677: anchor to the heading's "·" (U+00B7) bullet separator ("… Venue Schedule · {entity}"),
  // NOT a bare phrase. A bare "venue schedule"/"instructor schedule" can be a legitimate ENTITY NAME
  // (an instructor literally named "Venue Schedule" passes the name gate), and that name renders into
  // the scanned body text — which flipped a WHOLE-TERM file's scope to 'venue'/'instructor', routing a
  // destructive REPLACE down the additive MERGE path. The export heading uniquely places a "·" right
  // after the phrase; no entity name can contain "·" (the name gates restrict the charset), so the
  // bullet makes the marker un-spoofable while still matching every real scoped export.
  if (/venue\s+schedule\s*[·•]/i.test(t))      return 'venue';
  if (/instructor\s+schedule\s*[·•]/i.test(t)) return 'instructor';
  return 'full';
}

// NEW-FU-667: a VENUE export deliberately also carries the instructors who teach in the venue and
// THEIR office hours — without them a re-import couldn't rebuild the venue's full context or detect
// an office-hour-vs-class clash. To the user, seeing instructors + office hours in a "venue" file
// looks like an error/afterthought, so every venue export shows this plain-language note. Shown for
// the venue scope ONLY (an instructor file listing instructors, or a whole-term file listing
// everything, needs no such explanation).
const VENUE_EXPORT_NOTE =
  'Why this venue file lists instructors and office hours: it also carries the instructors who ' +
  'teach in this venue and their office hours. They are included on purpose — re-importing this ' +
  'file re-creates the venue together with its courses, those instructors, and their office hours, ' +
  'so the system can detect every scheduling conflict (for example, an office hour that overlaps a ' +
  'class). This is expected and keeps the venue file complete and ready for re-import.';

// NEW-FU-682: a short inline tag stamped on every CARRIED COMPLEMENT section (a lab course's other half —
// its Lab when this file holds the Lecture, or its Lecture when this file holds the Lab) so the reader can
// tell it apart from the entity's own sections at a glance. ASCII-only so it renders in pdfkit's WinAnsi
// font, Word, and Excel identically; the importer ignores it (it lives in a non-data column / card label).
const COMPLEMENT_TAG = 'Carried - completes lab course';

// A compact form for the weekly-grid cards (where a long tag would shrink the card font); the noun
// "Carried" matches COMPLEMENT_TAG so the side note's explanation covers both.
const COMPLEMENT_TAG_SHORT = 'Carried (other half)';

const COMPLEMENT_EXPORT_TITLE =
  'Carried complementary sections - included for schedule completeness';

// The plain-language side note shown beside the carried complement sections — parallel to
// VENUE_EXPORT_NOTE — explaining why a per-instructor / per-venue file can contain sections that
// belong to the matching lab course but not to the selected instructor or selected venue. Shown only
// when the file actually carries one or more complement sections.
const COMPLEMENT_EXPORT_NOTE =
  'About the sections tagged "' + COMPLEMENT_TAG + '": a laboratory course has both a Lecture and a Lab, ' +
  'often taught by different instructors in different venues. A focused instructor or venue file may ' +
  'include only one part unless the matching part is carried with it. These tagged sections are included ' +
  'to keep the course complete when the file is imported back into a term. They are shown separately ' +
  "because they belong to the matching course, not to the selected instructor's teaching load or the " +
  "selected venue's usage. This is expected and keeps the exported file complete and ready for re-import.";

module.exports = {
  scopeOf, sectionScopeClause, fetchOfficeHours, fetchInstructorsRef,
  fetchVenuesRef, fetchScopeEntity, tableTitle, detectScopeFromText, VENUE_EXPORT_NOTE,
  COMPLEMENT_TAG, COMPLEMENT_TAG_SHORT, COMPLEMENT_EXPORT_TITLE, COMPLEMENT_EXPORT_NOTE,
};
