// NEW-FU-161..163: TermService — list/create/delete academic terms.
//
// A "term" is just a `schedules` row whose `semester` column matches the
// YYT code pattern (251, 252, ..., 313). This service translates between
// the term-code domain (term.js decoder) and the schedules table, and
// provides the stat counts used by the frontend term picker dropdown.
//
// Shared resources (courses, instructors, venues) are GLOBAL tables in
// this codebase — they're not scoped per schedule. So:
//   • GET /terms counts use DISTINCT ... FROM sections WHERE schedule_id
//   • DELETE /terms cascades the schedule row (sections/conflicts/OH
//     cascade via existing FKs) AND prunes any course/instructor/venue
//     that's no longer referenced by ANY remaining schedule.
//   • POST /terms with seed = copies the most-recent non-summer schedule's
//     sections + OH bindings into the new schedule. Course/instructor/
//     venue IDs are shared by reference (no row copy).

const { query, getClient } = require('../config/db');
const { decodeTerm, TERM_CODE_RE, assertTermCodeInRange, hasTermDateOverride, validateTermDateWindow } = require('../domain/term');
// NEW-FU-180: lazy-required to avoid the circular import that would
// happen if TermService and ScheduleService loaded at the same module
// resolution step. ScheduleService is a singleton so this is cheap.
let _schedSvc = null;
function schedSvc() {
  if (!_schedSvc) _schedSvc = require('./ScheduleService');
  return _schedSvc;
}

// Matches the seed's department_id (see backend/src/db/seed.js line ~130).
const DEFAULT_DEPT = 'SWE-DEPT';

/**
 * List every term in the DB joined with per-term stats.
 *
 * Returns:
 *   [{ code, label, season, startsAt, endsAt, isSummer, isActive,
 *      scheduleId, status,
 *      courseCount, sectionCount, instructorCount, venueCount }]
 *
 * `isActive` is the term whose code matches `activeCode`, if provided.
 * Sort: newest first by code DESC.
 */
async function listTerms({ departmentId = DEFAULT_DEPT, activeCode, includeArchived = false } = {}) {
  // NEW-FU-184: second LEFT JOIN on conflicts so each row surfaces its
  // current hard/soft conflict counts. The conflict table is kept in
  // sync by FU-180 (eval on seed-copy) + the existing save-schedule
  // path, so these counts accurately reflect each term's state at any
  // moment without forcing a re-evaluation.
  const res = await query(`
    SELECT
      s.id              AS schedule_id,
      s.semester        AS code,
      s.status          AS status,
      s.created_at      AS created_at,
      s.archived_at     AS archived_at,
      -- NEW-FU-231: surface per-row dates so decodeTerm can prefer
      -- them over the override / template fallback.
      s.starts_at       AS row_starts_at,
      s.ends_at         AS row_ends_at,
      COALESCE(c.section_count,    0) AS section_count,
      COALESCE(c.course_count,     0) AS course_count,
      COALESCE(c.instructor_count, 0) AS instructor_count,
      COALESCE(c.venue_count,      0) AS venue_count,
      COALESCE(x.hard_count, 0) AS hard_conflict_count,
      COALESCE(x.soft_count, 0) AS soft_conflict_count
    FROM schedules s
    LEFT JOIN (
      SELECT
        schedule_id,
        COUNT(*)                                 AS section_count,
        COUNT(DISTINCT course_id)                AS course_count,
        COUNT(DISTINCT instructor_id)
          FILTER (WHERE instructor_id IS NOT NULL) AS instructor_count,
        COUNT(DISTINCT venue_id)
          FILTER (WHERE venue_id      IS NOT NULL) AS venue_count
      FROM sections
      GROUP BY schedule_id
    ) c ON c.schedule_id = s.id
    LEFT JOIN (
      SELECT
        schedule_id,
        COUNT(*) FILTER (WHERE severity = 'Hard') AS hard_count,
        COUNT(*) FILTER (WHERE severity = 'Soft') AS soft_count
      FROM conflicts
      GROUP BY schedule_id
    ) x ON x.schedule_id = s.id
    WHERE s.department_id = $1
      ${includeArchived ? '' : 'AND s.archived_at IS NULL'}
    -- NEW-FU-221: chronological order (ASC by code) so the picker
    -- reads top→bottom the way the calendar reads earliest→latest.
    -- Active partition first (archived_at IS NULL evaluates false in
    -- the bool sort, so it comes first); archived terms partition to
    -- the bottom. Within each partition, ASC by code = chronological
    -- because the YYT scheme already encodes that order
    -- (251 → 252 → 253 → 261 → 262 → ... → 303).
    ORDER BY s.archived_at IS NOT NULL, s.semester ASC
  `, [departmentId]);

  return res.rows.map(r => {
    // Only decode if the semester string matches the YYT regex — defensive
    // fallback for any legacy rows seeded with non-canonical labels.
    let decoded = null;
    if (TERM_CODE_RE.test(r.code)) {
      try {
        // NEW-FU-231: pass the row's per-schedule dates as the
        // top-precedence context. decodeTerm uses them verbatim when
        // both are present; falls through to the override map / template
        // otherwise. Result: admin-entered dates surface from the API
        // exactly as stored, while known overrides keep working for
        // rows that never had per-schedule dates filled in.
        decoded = decodeTerm(r.code, {
          startsAt: r.row_starts_at,
          endsAt:   r.row_ends_at,
        });
      } catch { /* ignore */ }
    }
    return {
      code:        r.code,
      label:       decoded ? decoded.label : r.code,
      season:      decoded ? decoded.season : null,
      startsAt:    decoded ? decoded.startsAt : null,
      endsAt:      decoded ? decoded.endsAt   : null,
      isSummer:    decoded ? decoded.isSummer : null,
      isActive:    r.code === activeCode,
      scheduleId:       r.schedule_id,
      status:           r.status,
      // NEW-FU-178: surface created_at so the dropdown row can show
      // "Created: <date>" in a tooltip. Useful for admins triaging
      // many terms.
      createdAt:        r.created_at ? r.created_at.toISOString() : null,
      sectionCount:     Number(r.section_count),
      courseCount:      Number(r.course_count),
      instructorCount:  Number(r.instructor_count),
      venueCount:       Number(r.venue_count),
      hardConflictCount: Number(r.hard_conflict_count),
      softConflictCount: Number(r.soft_conflict_count),
      archivedAt:        r.archived_at ? r.archived_at.toISOString() : null,
      isArchived:        !!r.archived_at,
    };
  });
}

/**
 * NEW-FU-193: archive / unarchive a term. Archiving hides it from the
 * default picker view (`includeArchived=false`) without losing data.
 * Refuses to archive the active term — the user must switch first to
 * avoid mid-edit confusion. Unarchive simply nulls archived_at.
 */
async function archiveTerm({ code, activeCode, departmentId = DEFAULT_DEPT }) {
  if (code === activeCode) {
    const err = new Error(`Cannot archive the active term ${code}. Switch to another term first.`);
    err.code = 'CONFLICT';
    throw err;
  }
  return _setArchive({ code, departmentId, archive: true });
}

async function unarchiveTerm({ code, departmentId = DEFAULT_DEPT }) {
  return _setArchive({ code, departmentId, archive: false });
}

async function _setArchive({ code, departmentId, archive }) {
  return withTransaction(async (client) => {
    const sched = await client.query(
      `SELECT id, archived_at FROM schedules WHERE department_id = $1 AND semester = $2`,
      [departmentId, code]
    );
    if (sched.rowCount === 0) {
      const err = new Error(`Term ${code} not found.`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    const wasArchived = sched.rows[0].archived_at !== null;
    if (archive && wasArchived) {
      return { code, isArchived: true, alreadyArchived: true };
    }
    if (!archive && !wasArchived) {
      return { code, isArchived: false, alreadyUnarchived: true };
    }
    await client.query(
      archive
        ? `UPDATE schedules SET archived_at = NOW(),  updated_at = NOW() WHERE id = $1`
        : `UPDATE schedules SET archived_at = NULL, updated_at = NOW() WHERE id = $1`,
      [sched.rows[0].id]
    );
    return { code, isArchived: archive };
  });
}

/**
 * Create a new term. Validates the regex via decodeTerm (throws on bad
 * code). For Fall/Spring, copies sections + office-hour bindings from a
 * template schedule. For Summer, creates a blank schedule.
 *
 * The "template" is the most-recent non-summer schedule in the same
 * department. If none exists (e.g. fresh DB), the new schedule is created
 * blank regardless of season — the caller can subsequently seed via the
 * existing /sections POST endpoints.
 *
 * Returns the newly-created term row (same shape as listTerms entry).
 */
async function createTerm({ code, createdBy, departmentId = DEFAULT_DEPT, startsAt, endsAt }) {
  const decoded = decodeTerm(code); // throws on invalid; bubbles to controller
  // NEW-FU-217: range guard. Throws BAD_INPUT with a clear message that
  // surfaces the legal range so the user knows what to type instead.
  assertTermCodeInRange(code);

  // NEW-FU-232: handle admin-supplied dates. Three paths:
  //   (a) The code has a known override → ignore any startsAt/endsAt
  //       on the body (override wins). Tested in FU-233.
  //   (b) The code has no override AND the caller supplied both
  //       startsAt + endsAt → validate the season window, persist to
  //       the new schedule row.
  //   (c) The code has no override AND nothing supplied → store NULL
  //       and let decodeTerm fall back to the template. The
  //       AddTermModal should make this case impossible in practice;
  //       backend stays permissive for curl / scripts.
  let persistDates = null;
  if (!hasTermDateOverride(code) && startsAt && endsAt) {
    const check = validateTermDateWindow(code, startsAt, endsAt);
    if (!check.ok) {
      const err = new Error(check.error);
      err.code = 'BAD_INPUT';
      throw err;
    }
    persistDates = { startsAt, endsAt };
  }

  // Track whether we seeded sections — if yes, we evaluate conflicts AFTER
  // the create transaction commits (revalidateSchedule opens its own
  // transaction; calling it inside ours would read pre-commit data from a
  // different pg connection that can't see our uncommitted inserts).
  let seededSections = false;

  const result = await withTransaction(async (client) => {
    // 1. Uniqueness check (schedules has UNIQUE(department_id, semester)
    //    but we want a clean 409 instead of a Postgres constraint error).
    const exists = await client.query(
      `SELECT id FROM schedules WHERE department_id = $1 AND semester = $2`,
      [departmentId, code]
    );
    if (exists.rowCount > 0) {
      const err = new Error(`Term ${code} already exists.`);
      err.code = 'CONFLICT';
      throw err;
    }

    // 2. Insert the new schedule row.
    // NEW-FU-232: persistDates is set only when (a) no override applies
    // AND (b) caller supplied valid dates. Otherwise columns stay NULL
    // and decodeTerm falls back to override/template.
    const ins = await client.query(
      `INSERT INTO schedules (department_id, semester, created_by, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        departmentId, code, createdBy ?? null,
        persistDates ? persistDates.startsAt : null,
        persistDates ? persistDates.endsAt   : null,
      ]
    );
    const newId = ins.rows[0].id;

    // 3. NEW-FU-234: seed sections from the NEAREST existing term in
    //    the SAME season family (T digit). Reasoning:
    //      • Course offerings differ between Fall / Spring / Summer
    //        (many courses are season-specific, instructor availability
    //        shifts in summer, etc.) so cross-season seeds create more
    //        cleanup than blank.
    //      • "Nearest" = smallest absolute distance in YY. On ties,
    //        prefer the earlier neighbor (past data is more complete
    //        than projected future data).
    //      • Summer now also seeds from nearest summer (was always
    //        blank pre-FU-234) — the season constancy makes the seed
    //        useful even when most courses aren't offered.
    //    Falls back to blank when the season family has no other
    //    members (e.g., fresh DB with only the seed Fall term and
    //    you're creating a Summer).
    const seasonDigit = code[2];                            // '1' | '2' | '3'
    const newYY = parseInt(code.slice(0, 2), 10);
    const tpl = await client.query(`
      SELECT s.id, s.semester FROM schedules s
      WHERE s.department_id = $1
        AND s.id != $2
        AND s.semester ~ ('^\\d{2}' || $3 || '$')   -- same season digit
      ORDER BY
        ABS(CAST(SUBSTRING(s.semester FROM 1 FOR 2) AS INT) - $4) ASC,
        s.semester ASC                              -- tie: prefer earlier
      LIMIT 1
    `, [departmentId, newId, seasonDigit, newYY]);
    if (tpl.rowCount > 0) {
      const templateId = tpl.rows[0].id;
      // Copy sections — same course/instructor/venue refs, new ids,
      // new schedule_id. Conflicts are NOT copied here (template's
      // conflicts reference template's section ids); we re-evaluate
      // them post-commit against the new section ids — see the
      // revalidate call after withTransaction returns.
      const copied = await client.query(`
        INSERT INTO sections
          (schedule_id, course_id, instructor_id, venue_id,
           section_number, section_type, day, start_time, end_time)
        SELECT $1, course_id, instructor_id, venue_id,
               section_number, section_type, day, start_time, end_time
        FROM sections
        WHERE schedule_id = $2
        RETURNING id
      `, [newId, templateId]);
      if (copied.rowCount > 0) seededSections = true;
    }

    // Re-query with stats so the response reflects whatever the seed copy
    // produced (rather than hardcoded 0s). Same query shape as listTerms.
    const stats = await client.query(`
      SELECT
        COUNT(*)                                  AS section_count,
        COUNT(DISTINCT course_id)                 AS course_count,
        COUNT(DISTINCT instructor_id)
          FILTER (WHERE instructor_id IS NOT NULL) AS instructor_count,
        COUNT(DISTINCT venue_id)
          FILTER (WHERE venue_id      IS NOT NULL) AS venue_count
      FROM sections
      WHERE schedule_id = $1
    `, [newId]);
    return {
      code,
      label:        decoded.label,
      season:       decoded.season,
      startsAt:     decoded.startsAt,
      endsAt:       decoded.endsAt,
      isSummer:     decoded.isSummer,
      isActive:     false,
      scheduleId:   newId,
      status:       'Draft',
      sectionCount:    Number(stats.rows[0].section_count),
      courseCount:     Number(stats.rows[0].course_count),
      instructorCount: Number(stats.rows[0].instructor_count),
      venueCount:      Number(stats.rows[0].venue_count),
    };
  });

  // NEW-FU-180: post-commit conflict evaluation. Only fires when sections
  // were actually seeded (summer terms are blank → no conflicts to find).
  // Best-effort: log + swallow on failure so the create response always
  // succeeds. The user can hit save/suggest to retry conflict eval.
  if (seededSections) {
    try {
      const { conflicts } = await schedSvc().revalidateSchedule(result.scheduleId);
      // Surface the conflict count in the create response so the UI can
      // toast "Created term X · 47 sections · 2 hard conflicts detected".
      result.hardConflictCount = conflicts.filter(c => c.severity === 'Hard').length;
      result.softConflictCount = conflicts.filter(c => c.severity === 'Soft').length;
    } catch (e) {
      console.error('FU-180 post-create conflict eval failed:', e.message);
      result.hardConflictCount = null;
      result.softConflictCount = null;
    }
  } else {
    result.hardConflictCount = 0;
    result.softConflictCount = 0;
  }

  return result;
}

/**
 * Delete a term and cascade orphaned shared resources.
 *
 * Refuses to delete the currently-active term (passed by the controller)
 * — the user must switch to another term first. Returns 409.
 *
 * After the schedule row is removed (its sections/conflicts/OH cascade
 * via FK), any course/instructor/venue that's no longer referenced by
 * ANY remaining schedule gets pruned. This matches the prompt's "Shared
 * resources survive only if used by another term" rule.
 *
 * Transactional: all-or-nothing.
 *
 * Returns:
 *   { deleted: { sections, conflicts, officeHours, courses, instructors, venues } }
 */
/**
 * NEW-FU-185: rename a term's code. Validates the new code via decodeTerm
 * (throws on invalid format). Refuses to rename if the new code collides
 * with an existing term (409). Refuses to rename the active term — the
 * caller must switch away first to avoid a mid-edit UX where the URL
 * still references the old code.
 *
 * Returns the renamed term with refreshed stats.
 */
async function renameTerm({ code, newCode, activeCode, departmentId = DEFAULT_DEPT }) {
  if (code === activeCode) {
    const err = new Error(`Cannot rename the active term ${code}. Switch to another term first.`);
    err.code = 'CONFLICT';
    throw err;
  }
  // newCode must pass the YYT regex via decodeTerm (throws on invalid).
  decodeTerm(newCode);
  // NEW-FU-217: rename to an out-of-range code is blocked for the same
  // reason create is — historical out-of-range codes stay readable, but
  // we don't let anyone *introduce* a fresh one through a rename either.
  assertTermCodeInRange(newCode);

  return withTransaction(async (client) => {
    // Target must exist; new code must not.
    const target = await client.query(
      `SELECT id FROM schedules WHERE department_id = $1 AND semester = $2`,
      [departmentId, code]
    );
    if (target.rowCount === 0) {
      const err = new Error(`Term ${code} not found.`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    const collision = await client.query(
      `SELECT id FROM schedules WHERE department_id = $1 AND semester = $2`,
      [departmentId, newCode]
    );
    if (collision.rowCount > 0) {
      const err = new Error(`Term ${newCode} already exists.`);
      err.code = 'CONFLICT';
      throw err;
    }
    await client.query(
      `UPDATE schedules SET semester = $2, updated_at = NOW()
       WHERE department_id = $1 AND semester = $3`,
      [departmentId, newCode, code]
    );
    return { code: newCode };
  });
}

async function deleteTerm({ code, activeCode, departmentId = DEFAULT_DEPT }) {
  if (code === activeCode) {
    const err = new Error(`Cannot delete the active term ${code}. Switch to another term first.`);
    err.code = 'CONFLICT';
    throw err;
  }

  return withTransaction(async (client) => {
    const sched = await client.query(
      `SELECT id FROM schedules WHERE department_id = $1 AND semester = $2`,
      [departmentId, code]
    );
    if (sched.rowCount === 0) {
      const err = new Error(`Term ${code} not found.`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    const scheduleId = sched.rows[0].id;

    // Count what's about to be deleted (informational, returned to client).
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM sections      WHERE schedule_id = $1) AS section_count,
        (SELECT COUNT(*) FROM conflicts     WHERE schedule_id = $1) AS conflict_count
    `, [scheduleId]);

    // Office hours are keyed to instructors, not schedules — only delete
    // OH rows for instructors that ONLY existed for this schedule (see
    // shared-resource pruning below).

    // Cascade the schedule (sections + conflicts cascade via FK).
    await client.query(`DELETE FROM schedules WHERE id = $1`, [scheduleId]);

    // Prune orphaned shared resources. A course/instructor/venue is
    // orphaned when no remaining `sections` row references it.
    const prunedCourses     = await client.query(`
      DELETE FROM courses
      WHERE id NOT IN (SELECT DISTINCT course_id FROM sections)
      RETURNING id
    `);
    const prunedInstructors = await client.query(`
      DELETE FROM instructors
      WHERE id NOT IN (
        SELECT DISTINCT instructor_id FROM sections WHERE instructor_id IS NOT NULL
      )
      RETURNING id
    `);
    const prunedVenues      = await client.query(`
      DELETE FROM venues
      WHERE id NOT IN (
        SELECT DISTINCT venue_id FROM sections WHERE venue_id IS NOT NULL
      )
      RETURNING id
    `);
    // OH rows cascade with their parent instructor (FK ON DELETE CASCADE).

    return {
      deleted: {
        sections:    Number(counts.rows[0].section_count),
        conflicts:   Number(counts.rows[0].conflict_count),
        courses:     prunedCourses.rowCount,
        instructors: prunedInstructors.rowCount,
        venues:      prunedVenues.rowCount,
      },
    };
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function loadTermById(client, scheduleId, departmentId, code) {
  const decoded = decodeTerm(code);
  return {
    code,
    label:        decoded.label,
    season:       decoded.season,
    startsAt:     decoded.startsAt,
    endsAt:       decoded.endsAt,
    isSummer:     decoded.isSummer,
    isActive:     false,
    scheduleId,
    status:       'Draft',
    sectionCount: 0, courseCount: 0, instructorCount: 0, venueCount: 0,
  };
}

async function withTransaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * NEW-FU-189: change a term's status (Draft / PendingApproval / Finalized).
 * Guardrail: cannot transition to Finalized if any hard conflicts exist
 * for this term. Returns 422 with detail in that case — the user must
 * resolve the conflicts before locking the schedule.
 *
 * Caller passes `code` (term identifier) + `newStatus`. We translate
 * to schedules.id behind the scenes.
 */
const VALID_STATUSES = new Set(['Draft', 'PendingApproval', 'Finalized']);

async function setTermStatus({ code, newStatus, departmentId = DEFAULT_DEPT }) {
  if (!VALID_STATUSES.has(newStatus)) {
    const err = new Error(`Invalid status "${newStatus}". Expected one of: Draft, PendingApproval, Finalized.`);
    err.code = 'BAD_INPUT';
    throw err;
  }
  return withTransaction(async (client) => {
    // NEW-FU-199: pull archived_at alongside id so we can refuse status
    // changes on archived terms. Archived = frozen-in-time; Draft↔Finalized
    // mutations on an archived row violate the read-only semantic the UI
    // already enforces by hiding the lock button.
    const sched = await client.query(
      `SELECT id, archived_at FROM schedules WHERE department_id = $1 AND semester = $2`,
      [departmentId, code]
    );
    if (sched.rowCount === 0) {
      const err = new Error(`Term ${code} not found.`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    const scheduleId = sched.rows[0].id;

    // NEW-FU-199: archived terms reject status mutations with 409.
    if (sched.rows[0].archived_at !== null) {
      const err = new Error(`Cannot change status of archived term ${code}. Unarchive it first.`);
      err.code = 'CONFLICT';
      throw err;
    }

    // Guardrail: refuse Draft → Finalized when hard conflicts exist.
    if (newStatus === 'Finalized') {
      const hard = await client.query(
        `SELECT COUNT(*)::int AS n FROM conflicts WHERE schedule_id = $1 AND severity = 'Hard'`,
        [scheduleId]
      );
      const hardCount = hard.rows[0].n;
      if (hardCount > 0) {
        const err = new Error(`Cannot finalize Term ${code}: ${hardCount} hard conflict${hardCount === 1 ? '' : 's'} must be resolved first.`);
        err.code = 'UNPROCESSABLE';
        err.details = { hardCount };
        throw err;
      }
    }

    await client.query(
      `UPDATE schedules SET status = $2, updated_at = NOW() WHERE id = $1`,
      [scheduleId, newStatus]
    );
    return { code, status: newStatus };
  });
}

module.exports = { listTerms, createTerm, deleteTerm, renameTerm, setTermStatus, archiveTerm, unarchiveTerm };
