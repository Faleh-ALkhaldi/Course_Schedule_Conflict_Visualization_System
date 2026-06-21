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
const { COURSE_TERM_RULES, isCourseAllowedInTerm } = require('../domain/courseTermValidity');
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
 * NEW-FU-590 (Batch 25): the ACTIVE term CAN now be archived in place — the
 * client switches the app to another non-archived term first (TermPicker archive
 * handler), so there's no mid-edit confusion. Unarchive simply nulls archived_at.
 */
async function archiveTerm({ code, activeCode, departmentId = DEFAULT_DEPT }) {
  // NEW-FU-590: the old `code === activeCode` 409 guard forced a manual switch-away
  // first; it's gone. activeCode is still accepted for API compatibility.
  void activeCode;
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
        AND s.archived_at IS NULL                    -- NEW-FU-440 (Phase 107 L1): never seed a copy from an archived term
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
      // NEW-FU-415 (Phase 103 item 1): do NOT carry forward sections of courses
      // that aren't offered in the NEW term (e.g. copying a ≤252 template into a
      // >252 term must drop SWE 412; SWE 399 only survives into Summer terms).
      // disallowedCodes is the set of course codes barred from `code`.
      const disallowedCodes = Object.keys(COURSE_TERM_RULES).filter(cc => !isCourseAllowedInTerm(cc, code));
      // NEW-FU-430 (Phase 106 item 7): CARRY the template's term-local DUMMY
      // instructors/venues into the new term instead of nulling them (reverses
      // NEW-FU-425). They're still placeholders the copied term needs to stay
      // conflict-free, so each is re-minted as a NEW row owned by the NEW term
      // (own owner_semester +, for instructors, a fresh non-conflicting OH), and
      // the copied sections are remapped onto these new rows — keeping every
      // placeholder strictly term-local (a copy never shares a dummy with its
      // source). Dummies that only served a term-disallowed course are skipped
      // (those sections aren't copied) so no orphans are minted.
      const { pickDummyOfficeHours, nextDummyVenueName } = require('../domain/dummyResources');
      const dInstrMap = new Map(), dVenueMap = new Map();
      const srcDInstr = await client.query(
        `SELECT DISTINCT i.id, i.name
           FROM sections s
           JOIN instructors i ON i.id = s.instructor_id
           JOIN courses c     ON c.id = s.course_id
          WHERE s.schedule_id = $1 AND i.is_dummy = true
            AND NOT (c.course_code = ANY($2::text[]))`,
        [templateId, disallowedCodes]);
      for (const row of srcDInstr.rows) {
        const r = await client.query(
          `INSERT INTO instructors (name, email, is_dummy, owner_semester)
           VALUES ($1, 'dummy-' || gen_random_uuid() || '@placeholder.local', true, $2) RETURNING id`,
          [row.name, code]);
        dInstrMap.set(row.id, r.rows[0].id);
        const slots = await client.query(
          `SELECT day, start_time::text AS s, end_time::text AS e
             FROM sections WHERE schedule_id = $1 AND instructor_id = $2`,
          [templateId, row.id]);
        const oh = pickDummyOfficeHours(slots.rows.map(x => ({ day: x.day, start: x.s, end: x.e })));
        await client.query(
          `INSERT INTO office_hours (instructor_id, day, start_time, end_time) VALUES ($1,$2,$3,$4)`,
          [r.rows[0].id, oh.day, oh.startTime, oh.endTime]);
      }
      const srcDVenue = await client.query(
        `SELECT DISTINCT v.id, v.name, v.type
           FROM sections s
           JOIN venues v  ON v.id = s.venue_id
           JOIN courses c ON c.id = s.course_id
          WHERE s.schedule_id = $1 AND v.is_dummy = true
            AND NOT (c.course_code = ANY($2::text[]))`,
        [templateId, disallowedCodes]);
      for (const row of srcDVenue.rows) {
        const vname = await nextDummyVenueName(client); // NEW-FU-431: globally-unique name (venues.name is UNIQUE)
        const r = await client.query(
          `INSERT INTO venues (name, type, capacity, is_dummy, owner_semester) VALUES ($1,$2,30,true,$3) RETURNING id`,
          [vname, row.type, code]);
        dVenueMap.set(row.id, r.rows[0].id);
      }
      const copied = await client.query(`
        INSERT INTO sections
          (schedule_id, course_id, instructor_id, venue_id,
           section_number, section_type, day, start_time, end_time, gender)
        SELECT $1, s.course_id, s.instructor_id, s.venue_id,
               s.section_number, s.section_type, s.day, s.start_time, s.end_time, s.gender
        FROM sections s
        JOIN courses c ON c.id = s.course_id
        WHERE s.schedule_id = $2
          AND NOT (c.course_code = ANY($3::text[]))
        RETURNING id
      `, [newId, templateId, disallowedCodes]);
      // NEW-FU-435 (Phase 107 H1): carry gender on copy. Without it, copied female
      // sections defaulted to 'M', breaking the M/F paired-section exemption in
      // R-04/R-05 and injecting phantom hard conflicts into every copied term.
      if (copied.rowCount > 0) seededSections = true;
      // Remap the carried dummy refs onto the NEW term's own placeholder rows.
      for (const [oldId, newDId] of dInstrMap)
        await client.query(`UPDATE sections SET instructor_id = $1 WHERE schedule_id = $2 AND instructor_id = $3`, [newDId, newId, oldId]);
      for (const [oldId, newDId] of dVenueMap)
        await client.query(`UPDATE sections SET venue_id = $1 WHERE schedule_id = $2 AND venue_id = $3`, [newDId, newId, oldId]);
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
      let { conflicts } = await schedSvc().revalidateSchedule(result.scheduleId);
      // NEW-FU-229 (Phase 97): a copied term must NOT open with conflicts. The
      // seed copies the source term's sections verbatim, so any conflict the
      // source carried (or that fresh re-detection surfaces) lands in the new
      // term. Auto-run the Quick Fix resolver and apply every NON-DESTRUCTIVE
      // fix (reassign instructor/venue, add a meeting day, retime, mark
      // venue-exempt, …). Drops are the agreed last resort and are NOT applied
      // automatically — if a conflict can ONLY be cleared by a drop, the term
      // opens with that minimal residual and the user resolves it via Quick Fix
      // (which surfaces the drop as an explicit, opt-in choice). Best-effort:
      // swallow on failure so term creation still succeeds.
      if (conflicts.length > 0) {
        try {
          const quickFix = require('./QuickFixService');
          // NEW-FU-446 (Phase 107 H4): ITERATE plan→apply→revalidate. A single pass
          // often can't clear an interdependent conflict cluster (resolving A
          // surfaces B that needs another round), so a copied term could open with
          // residual HARD conflicts despite "success". Loop until no non-destructive
          // op remains or a small cap — placeholders included — so the copy genuinely
          // lands at 0. Drops stay opt-in (never auto-applied).
          for (let round = 0; round < 6 && conflicts.length > 0; round++) {
            const plan = await quickFix.plan(result.scheduleId);
            // NEW-FU-450 (Phase 107 D4): also exclude the GLOBAL-metadata flips
            // (mark-venue-exempt → courses.is_capstone, reclassify-venue → venues.type,
            // untag-has-lab → courses.has_lab) from the SILENT post-copy auto-resolve.
            // Each mutates a course/venue row across ALL terms — too invasive to apply
            // without the user seeing it. They stay available in interactive Quick Fix.
            const GLOBAL_FLIPS = new Set(['mark-venue-exempt', 'reclassify-venue', 'untag-has-lab']);
            const nonDestructive = (plan.ops || []).filter(
              op => op.type !== 'drop'
                && !GLOBAL_FLIPS.has(op.type)
                && !(Array.isArray(op.subOps) && op.subOps.some(s => s.type === 'drop'))
            );
            if (nonDestructive.length === 0) break;
            await quickFix.apply(result.scheduleId, nonDestructive);
            ({ conflicts } = await schedSvc().revalidateSchedule(result.scheduleId));
          }
        } catch (rfErr) {
          console.error('FU-229 post-copy auto-resolve failed:', rfErr.message);
        }
      }
      // Surface the (post-resolve) conflict count in the create response so the
      // UI can toast "Created term X · 47 sections · 0 conflicts".
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
 * NEW-FU-590 (Batch 25): the currently-active term CAN be deleted in place —
 * the client auto-switches to another term the moment delete returns. The old
 * "switch away first" 409 guard is gone.
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
 * with an existing term (409). The ACTIVE term CAN be renamed in place
 * (NEW-FU-584, Batch 25): rename changes only the code, not the schedule id,
 * and the client follows to the new code.
 *
 * Returns the renamed term with refreshed stats.
 */
async function renameTerm({ code, newCode, activeCode, departmentId = DEFAULT_DEPT }) {
  // NEW-FU-584 (Batch 25): renaming the ACTIVE term is now allowed. A rename only
  // changes the schedule's `semester` code — the schedule id is unchanged, so sections,
  // conflicts, and office hours (all keyed by schedule id) are untouched. The client
  // follows the rename to the new code (onRenamed → onSwitchTerm), so there is no
  // dangling-URL hazard. The old "switch away first" guard was pure friction. `activeCode`
  // is retained in the signature for backward-compat but is no longer used to block.
  void activeCode;
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
  // NEW-FU-590 (Batch 25): the ACTIVE term can now be deleted in place. Terms are
  // keyed by schedule id, so removing the schedule the user is viewing is safe — the
  // client auto-switches to another term (TermPicker onDeleted → onSwitchTerm) the
  // moment the delete returns. The old `code === activeCode` 409 guard forced a manual
  // switch-away first; it's gone. activeCode is still accepted for API compatibility.
  void activeCode;

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

    // NEW-FU-447 (Phase 107 M7): capture exactly which courses/instructors/venues
    // THIS term referenced, BEFORE the cascade, so the prune only removes resources
    // this term used (and that nobody else uses now). The old global
    // `NOT IN (SELECT … FROM sections)` could delete ANOTHER term's transiently-
    // unreferenced placeholder, or a real resource that's merely unassigned at the
    // moment — neither of which this term's deletion should touch.
    const refRows = await client.query(`
      SELECT ARRAY(SELECT DISTINCT course_id     FROM sections WHERE schedule_id=$1) AS courses,
             ARRAY(SELECT DISTINCT instructor_id FROM sections WHERE schedule_id=$1 AND instructor_id IS NOT NULL) AS instructors,
             ARRAY(SELECT DISTINCT venue_id       FROM sections WHERE schedule_id=$1 AND venue_id IS NOT NULL) AS venues
    `, [scheduleId]);
    const refCourses = refRows.rows[0].courses     || [];
    const refInstr   = refRows.rows[0].instructors || [];
    const refVenues  = refRows.rows[0].venues      || [];

    // Cascade the schedule (sections + conflicts cascade via FK).
    await client.query(`DELETE FROM schedules WHERE id = $1`, [scheduleId]);

    // Prune ONLY the resources this term referenced that are now orphaned.
    const prunedCourses = refCourses.length === 0 ? { rowCount: 0 } : await client.query(`
      DELETE FROM courses WHERE id = ANY($1::uuid[])
        AND id NOT IN (SELECT DISTINCT course_id FROM sections) RETURNING id`, [refCourses]);
    const prunedInstructors = refInstr.length === 0 ? { rowCount: 0 } : await client.query(`
      DELETE FROM instructors WHERE id = ANY($1::uuid[])
        AND id NOT IN (SELECT DISTINCT instructor_id FROM sections WHERE instructor_id IS NOT NULL) RETURNING id`, [refInstr]);
    const prunedVenues = refVenues.length === 0 ? { rowCount: 0 } : await client.query(`
      DELETE FROM venues WHERE id = ANY($1::uuid[])
        AND id NOT IN (SELECT DISTINCT venue_id FROM sections WHERE venue_id IS NOT NULL) RETURNING id`, [refVenues]);
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
    // NEW-FU-568 (audit-2 P3): guard the ROLLBACK so a rollback-throws (broken
    // connection) can't mask the original error, and release(e) so a poisoned
    // client is destroyed rather than returned to the pool. Mirrors the hardened
    // idiom in ScheduleService.revalidateSchedule / ConflictRepository.replaceAll.
    await client.query('ROLLBACK').catch(() => {});
    try { client.release(e); } catch { /* ignore */ }
    throw e;
  } finally {
    try { client.release(); } catch { /* already released via catch path */ }
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
    // NEW-FU-569 (audit-2 Phase-11 P1): lock the schedule row FOR UPDATE for the
    // whole evaluate-then-finalize window. Without it, the FU-562 in-tx re-eval
    // below is a TOCTOU — a concurrent section writer (which DOES take FOR UPDATE
    // via assertSchedulerEditableLocked) could commit a fresh HARD conflict
    // between our re-eval and the status UPDATE, finalizing a term with a hidden
    // conflict. Brings setTermStatus in line with every other finalize-class
    // writer (saveSchedule, SuggestService apply) that locks the row.
    const sched = await client.query(
      `SELECT id, archived_at FROM schedules WHERE department_id = $1 AND semester = $2 FOR UPDATE`,
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
      // NEW-FU-562 (audit-2 P1-4/P1-8): RE-EVALUATE the engine NOW instead of trusting the
      // persisted conflicts table. That table is only as fresh as the last revalidation, so a
      // change that didn't revalidate THIS schedule (e.g. an office-hours edit on a shared
      // instructor in another term) could leave a hidden HARD conflict and let the term
      // finalize anyway. _evaluateSchedule reads via the SAME transaction client (no persist,
      // no nested transaction), giving an authoritative count.
      const fresh = await schedSvc()._evaluateSchedule(scheduleId, client);
      const hardCount = (fresh.conflicts || []).filter(c => String(c.severity).toLowerCase() === 'hard').length;
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

// NEW-FU-582 (Batch 24): content search for the term picker. Returns the set of term
// codes (semesters) whose REGISTERED CONTENT matches `q` — course code/name, instructor
// name, venue name, or section number — so the picker can surface "every term that has
// SWE 412 / Omar Hammad / 24-137 registered". ONE indexed query (no N+1); the picker keeps
// the instant client-side code/label/season match and unions these content matches in.
async function searchTermCodes({ departmentId = DEFAULT_DEPT, q, includeArchived = false } = {}) {
  const needle = String(q ?? '').trim();
  if (!needle) return [];
  const like = `%${needle}%`;
  const res = await query(`
    SELECT DISTINCT s.semester AS code
    FROM schedules s
    JOIN sections sec   ON sec.schedule_id = s.id
    JOIN courses co     ON co.id = sec.course_id
    LEFT JOIN instructors i ON i.id = sec.instructor_id
    LEFT JOIN venues      v ON v.id = sec.venue_id
    WHERE s.department_id = $1
      ${includeArchived ? '' : 'AND s.archived_at IS NULL'}
      AND (
        co.course_code ILIKE $2 OR
        co.name        ILIKE $2 OR
        i.name         ILIKE $2 OR
        v.name         ILIKE $2 OR
        sec.section_number ILIKE $2 OR
        (co.course_code || ' ' || co.name) ILIKE $2
      )
  `, [departmentId, like]);
  return res.rows.map(r => r.code);
}

module.exports = { listTerms, searchTermCodes, createTerm, deleteTerm, renameTerm, setTermStatus, archiveTerm, unarchiveTerm };
