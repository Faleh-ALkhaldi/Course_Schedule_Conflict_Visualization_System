/**
 * exportScope — shared scope helpers for the combined export + import.
 *
 * NEW-FU-660: an instructor- or venue-scoped export must carry ONLY that entity's
 * data — its sections, its office hours, and just the venues/instructors it actually
 * touches — NOT the whole term. (FU-657 deliberately put the whole-term table into
 * every file so a scoped file could rebuild the entire term; FU-660 reverses that:
 * scoped files are now a self-contained, merge-into-the-current-term artifact.)
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

// The section-set predicate for a filter, as a SQL fragment + bound params. params[0]
// is always scheduleId so the reference queries below can append it directly.
function sectionScopeClause(scheduleId, filter = { type: 'full' }) {
  const scope = scopeOf(filter);
  if (scope === 'instructor') return { clause: 's.schedule_id = $1 AND s.instructor_id = $2', params: [scheduleId, filter.id] };
  if (scope === 'venue')      return { clause: 's.schedule_id = $1 AND s.venue_id = $2',      params: [scheduleId, filter.id] };
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
    return (await query(`${SELECT} WHERE oh.instructor_id = $1 ORDER BY oh.day, oh.start_time`, [filter.id])).rows;
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
    return (await query(`SELECT name, email FROM instructors WHERE id = $1`, [filter.id])).rows;
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
    return (await query(`SELECT name, type, capacity FROM venues WHERE id = $1`, [filter.id])).rows;
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
  if (/venue\s+schedule/i.test(t))      return 'venue';
  if (/instructor\s+schedule/i.test(t)) return 'instructor';
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
  'class). This is expected, not an error.';

module.exports = {
  scopeOf, sectionScopeClause, fetchOfficeHours, fetchInstructorsRef,
  fetchVenuesRef, fetchScopeEntity, tableTitle, detectScopeFromText, VENUE_EXPORT_NOTE,
};
