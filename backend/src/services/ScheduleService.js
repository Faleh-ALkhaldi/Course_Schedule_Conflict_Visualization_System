/**
 * ScheduleService — orchestrates engine + repositories for all scheduling mutations.
 *
 * KEY POLICY:
 *   Section groups: A course section can be held on multiple days as a group:
 *     - SUN/TUE/THU group (50 min each)
 *     - MON/WED group (75 min each)
 *     - Single day (any duration)
 *   When a section is moved or edited, ALL sections in the same group
 *   (same courseId + sectionNumber + dayGroup) are updated together.
 *   When info (instructor, venue, sectionNumber) changes, ALL are updated.
 */
const ConflictEngine       = require('../engine/ConflictEngine');
const SectionRepository    = require('../repositories/SectionRepository');
const InstructorRepository = require('../repositories/InstructorRepository');
const { ConflictRepository, ScheduleRepository, VenueRepository } = require('../repositories/repositories');
const { getClient, query } = require('../config/db');
const Conflict             = require('../domain/Conflict');
const ConflictResult       = require('../domain/ConflictResult');
const { SEVERITY, SCHEDULE_STATUS } = require('../config/constants');
// NEW-FU-276: imported for extendSection — validates that EXISTING days
// + addDays at the section's time form a legal pattern. Without this
// gate, the quick-fix endpoint could create patterns the validator
// would reject at section creation time (e.g., adding a day to a group
// that lands at a tuple no row in the rule table accepts).
const sectionPattern       = require('../domain/sectionPattern');
const { CourseRepository } = require('../repositories/repositories');
const courseRepo           = new CourseRepository();

const engine       = new ConflictEngine();
const sectionRepo  = new SectionRepository();
const instrRepo    = new InstructorRepository();
const conflictRepo = new ConflictRepository();
const schedRepo    = new ScheduleRepository();
// NEW-FU-292 (Phase 25): used by R-04/R-05 fix computation to suggest
// alternative instructors / venues for conflict remediation.
const venueRepo    = new VenueRepository();

// ── Day group definitions ─────────────────────────────────────────────────────
const DAY_GROUPS = {
  Sunday:    'STT',   // Sun/Tue/Thu
  Tuesday:   'STT',
  Thursday:  'STT',
  Monday:    'MW',    // Mon/Wed
  Wednesday: 'MW',
};
const GROUP_DAYS = {
  STT: ['Sunday','Tuesday','Thursday'],
  MW:  ['Monday','Wednesday'],
};

function getDayGroup(day) { return DAY_GROUPS[day] ?? null; }

// NEW-FU-14: load a section with FOR UPDATE so the rest of the transaction
// sees a consistent, authoritative snapshot of its day/time/identifiers.
// Without this, callers were using a snapshot taken *outside* the schedule
// lock — vulnerable to concurrent assignSection / updateSectionInfo committed
// just before our transaction started. The schedule lock must already be
// held by the caller (lock order: schedule → section).
async function loadSectionLocked(client, sectionId) {
  // NEW-FU-96: include section_type in the locked snapshot so
  // updateSectionInfo's "only update if changed" check has the prior value.
  const r = await client.query(`
    SELECT schedule_id, course_id, instructor_id, venue_id, section_number,
           day, start_time::text AS start_time, end_time::text AS end_time,
           section_type
    FROM sections WHERE id = $1 FOR UPDATE
  `, [sectionId]);
  if (r.rowCount === 0) throw new Error(`Section ${sectionId} not found.`);
  const row = r.rows[0];
  return {
    id:            sectionId,
    scheduleId:    row.schedule_id,
    courseId:      row.course_id,
    instructorId:  row.instructor_id,
    venueId:       row.venue_id,
    sectionNumber: row.section_number,
    day:           row.day,
    startTime:     row.start_time,
    endTime:       row.end_time,
    sectionType:   row.section_type,
  };
}

// NEW-M6 + NEW-FU-2: reject mutations on a Finalized schedule.
// Must be called with a transactional client *after* BEGIN. It takes a row
// lock on the schedule via SELECT … FOR UPDATE so a concurrent saveSchedule
// cannot flip the status between this check and the subsequent mutation.
async function assertSchedulerEditableLocked(client, scheduleId) {
  // NEW-FU-201: also pull archived_at so we can refuse writes against
  // archived schedules. "Archive = read-only" is the contract we want to
  // enforce end-to-end; this single SELECT covers createSection,
  // updateSectionInfo, assignSection, deleteSection, and importFromExcel
  // because they all route through this helper.
  const res = await client.query(
    `SELECT status, archived_at FROM schedules WHERE id = $1 FOR UPDATE`,
    [scheduleId]
  );
  if (res.rowCount === 0) throw new Error(`Schedule ${scheduleId} not found.`);
  if (res.rows[0].archived_at !== null) {
    const err = new Error('Schedule is archived and cannot be modified. Unarchive its term first.');
    err.status = 409;
    throw err;
  }
  if (res.rows[0].status === SCHEDULE_STATUS.FINALIZED) {
    const err = new Error('Schedule is finalized and cannot be modified.');
    err.status = 409;
    throw err;
  }
}

/**
 * Find all sibling sections: same schedule, same courseId, same sectionNumber,
 * same dayGroup, AND same start/end time. Returns [] if single-day section.
 *
 * NEW-L12: time match is now part of the predicate. Two STT-grouped sections
 * that share course+sectionNumber but are scheduled at different times are no
 * longer (incorrectly) treated as part of the same group.
 *
 * Accepts an optional `db` (a transactional client) so callers running inside
 * a transaction can read with the same snapshot.
 */
async function findSiblings(scheduleId, courseId, sectionNumber, day, startTime, endTime, db = { query }) {
  const group = getDayGroup(day);
  if (!group) return [];
  const groupDays = GROUP_DAYS[group];
  const res = await db.query(`
    SELECT id, day FROM sections
    WHERE schedule_id=$1 AND course_id=$2 AND section_number=$3
      AND day = ANY($4)
      AND start_time = $5 AND end_time = $6
  `, [scheduleId, courseId, sectionNumber, groupDays, startTime, endTime]);
  return res.rows; // [{ id, day }]
}

class ScheduleService {

  /**
   * Move a section to a new time slot.
   * If the section is part of a Sun/Tue/Thu or Mon/Wed group,
   * all siblings are moved to the same start/end time on their respective days.
   *
   * NEW-H2: all section row updates run inside one transaction so a mid-loop
   * failure (constraint violation, network blip) rolls back the entire move
   * rather than leaving the group half-shifted.
   */
  async assignSection(sectionId, updates) {
    // Peek (unlocked) to learn scheduleId — immutable for a section, so this
    // is safe even though we re-read everything else under FOR UPDATE below.
    const peek = await sectionRepo.findById(sectionId);
    if (!peek) throw new Error(`Section ${sectionId} not found.`);
    const scheduleId = peek.scheduleId;

    const client = await getClient();
    try {
      await client.query('BEGIN');
      // NEW-M6 + NEW-FU-2: schedule row lock (status guard for the tx).
      await assertSchedulerEditableLocked(client, scheduleId);
      // NEW-FU-14: re-read the section under FOR UPDATE so all the values we
      // use below (day, start/end, sectionNumber) are the authoritative
      // snapshot under the schedule lock, not a stale read from before the tx.
      const section = await loadSectionLocked(client, sectionId);

      // NEW-FU-4 + NEW-FU-7: coerce a cross-day move into a time-only move
      // ONLY when an actual sibling already occupies the target day. The
      // collision check + the subsequent UPDATE both see the same snapshot.
      if (updates.day && updates.day !== section.day) {
        const collision = await client.query(
          `SELECT 1 FROM sections
           WHERE schedule_id = $1 AND course_id = $2 AND section_number = $3
             AND day = $4 AND id != $5
           LIMIT 1`,
          [section.scheduleId, section.courseId, section.sectionNumber,
           updates.day, sectionId]
        );
        if (collision.rowCount > 0) {
          updates = { ...updates, day: section.day };
        }
      }

      // Update the changed section
      await client.query(`
        UPDATE sections
        SET instructor_id=$2, venue_id=$3, day=$4, start_time=$5, end_time=$6, updated_at=NOW()
        WHERE id=$1
      `, [sectionId, updates.instructorId ?? null, updates.venueId ?? null,
          updates.day, updates.startTime, updates.endTime]);

      // Update siblings (same group, same original time → all get the new time).
      // findSiblings now uses the FRESH section snapshot (NEW-FU-14).
      const siblings = await findSiblings(
        section.scheduleId, section.courseId, section.sectionNumber,
        section.day, section.startTime, section.endTime,
        client
      );
      for (const sib of siblings) {
        if (sib.id === sectionId) continue;
        await client.query(`
          UPDATE sections
          SET instructor_id=$2, venue_id=$3, day=$4, start_time=$5, end_time=$6, updated_at=NOW()
          WHERE id=$1
        `, [sib.id, updates.instructorId ?? null, updates.venueId ?? null,
            sib.day, updates.startTime, updates.endTime]);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // NEW-FU-48 + NEW-FU-66: pass err so the M-11 release wrapper signals
      // pg to destroy the (possibly bad) connection. Wrapped in try/catch
      // so a release-throws (extremely rare, but possible on a disposed
      // client) doesn't suppress the original `throw err`. The release
      // wrapper's `released` flag makes the finally's bare release() a
      // safe no-op when this branch ran.
      try { client.release(err); } catch { /* ignore */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* already released via catch path */ }
    }

    return this._revalidateAndReturn(scheduleId);
  }

  /**
   * Update section info (instructor, venue, sectionNumber) —
   * applies to ALL sections in the same group.
   *
   * NEW-H2 + NEW-M14: the whole group update is now one transaction AND a
   * single UPDATE per field (no per-row findById round-trip), eliminating
   * both the partial-write hazard and the N+1 query pattern.
   */
  async updateSectionInfo(sectionId, { instructorId, venueId, sectionNumber, sectionType }) {
    // Peek (unlocked) to learn the immutable scheduleId.
    const peek = await sectionRepo.findById(sectionId);
    if (!peek) throw new Error(`Section ${sectionId} not found.`);
    const scheduleId = peek.scheduleId;

    const client = await getClient();
    try {
      await client.query('BEGIN');
      // NEW-FU-2: schedule row lock (status guard).
      await assertSchedulerEditableLocked(client, scheduleId);
      // NEW-FU-14: re-read under FOR UPDATE so findSiblings uses an
      // authoritative snapshot instead of the pre-lock peek.
      const section = await loadSectionLocked(client, sectionId);

      const siblings = await findSiblings(
        section.scheduleId, section.courseId, section.sectionNumber,
        section.day, section.startTime, section.endTime,
        client
      );
      const allIds = [sectionId, ...siblings.map(s => s.id).filter(id => id !== sectionId)];

      // Single batched UPDATE per editable field using COALESCE so undefined
      // arguments leave the existing value alone and explicit null clears it.
      if (instructorId !== undefined) {
        await client.query(
          `UPDATE sections SET instructor_id = $2, updated_at = NOW() WHERE id = ANY($1)`,
          [allIds, instructorId ?? null]
        );
      }
      if (venueId !== undefined) {
        await client.query(
          `UPDATE sections SET venue_id = $2, updated_at = NOW() WHERE id = ANY($1)`,
          [allIds, venueId ?? null]
        );
      }
      if (sectionNumber && sectionNumber !== section.sectionNumber) {
        await client.query(
          `UPDATE sections SET section_number = $2, updated_at = NOW() WHERE id = ANY($1)`,
          [allIds, sectionNumber]
        );
      }
      // NEW-FU-96: section_type updates propagate to all sibling rows of
      // the logical section (Lec/Lab is a course-level property of the
      // group, not a per-day property). The lab-only-on-has_lab-course
      // gate happens at the controller layer where the course's has_lab
      // is already in hand.
      if (sectionType && sectionType !== section.sectionType) {
        await client.query(
          `UPDATE sections SET section_type = $2, updated_at = NOW() WHERE id = ANY($1)`,
          [allIds, sectionType]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // NEW-FU-48 + NEW-FU-66: pass err so the M-11 release wrapper signals
      // pg to destroy the (possibly bad) connection. Wrapped in try/catch
      // so a release-throws (extremely rare, but possible on a disposed
      // client) doesn't suppress the original `throw err`. The release
      // wrapper's `released` flag makes the finally's bare release() a
      // safe no-op when this branch ran.
      try { client.release(err); } catch { /* ignore */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* already released via catch path */ }
    }

    return this._revalidateAndReturn(scheduleId);
  }

  /**
   * Create a new section — and optionally create siblings for the day group.
   * The client passes { days: ['Sunday','Tuesday','Thursday'] } or a single day.
   *
   * NEW-H2: all N inserts run inside one transaction so a mid-loop failure
   * (duplicate-day uniqueness, constraint violation) rolls back the whole
   * group rather than leaving stranded partial-group rows behind.
   */
  async createSection(scheduleId, data) {
    const daysToCreate = data.days ?? [data.day];
    let firstSectionId = null;

    const client = await getClient();
    try {
      await client.query('BEGIN');
      // NEW-FU-2: status check holds the schedule row lock for the tx.
      await assertSchedulerEditableLocked(client, scheduleId);

      for (const day of daysToCreate) {
        // NEW-FU-96: include section_type in the insert. Falls back to
        // 'Lec' for backward compatibility with the older create-section
        // call signature that didn't carry sectionType.
        // NEW-FU-277 (Phase 53 #2): include gender in the insert. The DB
        // column has DEFAULT 'M' (mig 014), so existing callers that
        // don't pass it still produce a male section — but the modal now
        // surfaces the choice explicitly.
        const res = await client.query(`
          INSERT INTO sections
            (schedule_id, course_id, instructor_id, venue_id, section_number,
             day, start_time, end_time, section_type, gender)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING id
        `, [
          scheduleId, data.courseId,
          data.instructorId ?? null, data.venueId ?? null,
          data.sectionNumber, day, data.startTime, data.endTime,
          data.sectionType ?? 'Lec',
          data.gender ?? 'M',
        ]);
        if (!firstSectionId) firstSectionId = res.rows[0].id;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // NEW-FU-48 + NEW-FU-66: pass err so the M-11 release wrapper signals
      // pg to destroy the (possibly bad) connection. Wrapped in try/catch
      // so a release-throws (extremely rare, but possible on a disposed
      // client) doesn't suppress the original `throw err`. The release
      // wrapper's `released` flag makes the finally's bare release() a
      // safe no-op when this branch ran.
      try { client.release(err); } catch { /* ignore */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* already released via catch path */ }
    }

    const firstSection = firstSectionId ? await sectionRepo.findById(firstSectionId) : null;
    return this._revalidateAndReturn(scheduleId, firstSection);
  }

  /**
   * Delete a section and all its siblings in the group.
   *
   * NEW-H2: section + siblings delete is now one transaction. Previously a
   * partial failure could leave dangling siblings whose representative had
   * already been removed.
   */
  /**
   * NEW-FU-271: deleteSectionRow — delete ONLY the queried row (one meeting
   * day), preserving the rest of the section group. The Phase-22 grid-block
   * ✕ quick-delete uses this so the user can shave a single day off a
   * section without scrapping the whole group. R-15 (NEW-FU-270) is the
   * downstream safety net for "you deleted too much".
   *
   * Same lock + revalidate flow as deleteSection — the only difference is
   * the absence of sibling expansion. We don't even call findSiblings; the
   * row's own DELETE is the entire effect.
   */
  async deleteSectionRow(sectionId) {
    const peek = await sectionRepo.findById(sectionId);
    if (!peek) throw new Error(`Section ${sectionId} not found`);
    const scheduleId = peek.scheduleId;

    const client = await getClient();
    try {
      await client.query('BEGIN');
      await assertSchedulerEditableLocked(client, scheduleId);
      // Re-read under FOR UPDATE so the row is locked while we delete it.
      // The lock matters because a concurrent update on the same row would
      // otherwise race the DELETE — pg would still serialize, but the
      // explicit lock keeps semantics aligned with the rest of this service.
      await loadSectionLocked(client, sectionId);
      await client.query(`DELETE FROM sections WHERE id = $1`, [sectionId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      try { client.release(err); } catch { /* ignore */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* already released via catch path */ }
    }

    await this.revalidateSchedule(scheduleId);
    // NEW-FU-288: return the deletedIds so the frontend can update its
    // local state precisely (removing only these rows) rather than
    // clearing all sections and waiting for a refetch — the prior
    // CLEAR_SECTIONS hack caused the schedule to blank out visually
    // between the delete and the reload (Phase 24 critical bug).
    return { deletedIds: [sectionId], scheduleId };
  }

  async deleteSection(sectionId) {
    // Peek (unlocked) to learn the immutable scheduleId.
    const peek = await sectionRepo.findById(sectionId);
    if (!peek) throw new Error(`Section ${sectionId} not found`);
    const scheduleId = peek.scheduleId;
    let allIds = [];

    const client = await getClient();
    try {
      await client.query('BEGIN');
      // NEW-FU-2: schedule row lock (status guard).
      await assertSchedulerEditableLocked(client, scheduleId);
      // NEW-FU-14: authoritative snapshot before computing siblings.
      const section = await loadSectionLocked(client, sectionId);

      // NEW-FU-305 (Phase 27): true section-group delete by (courseId,
      // sectionNumber) — no longer filters on day-group + time. The old
      // `findSiblings` query was time-strict, so if a section group's
      // rows had different times per day (rare but possible — e.g., a
      // user-edited section), only the matching-time row would be
      // deleted. From the user's perspective the side-panel ✕ then
      // appeared to "remove only one card". The side panel's
      // groupSections groups purely by (courseId, sectionNumber) — the
      // backend must match that semantic for the user-facing "delete
      // the entire section" action.
      //
      // Move semantics (assignSection) STILL use time-strict findSiblings
      // because moving means "all siblings sharing this time go to the
      // new time" — that's a different operation with a different
      // grouping concept.
      const groupRes = await client.query(`
        SELECT id FROM sections
        WHERE schedule_id = $1 AND course_id = $2 AND section_number = $3
      `, [scheduleId, section.courseId, section.sectionNumber]);
      allIds = groupRes.rows.map(r => r.id);
      if (allIds.length === 0) allIds = [sectionId]; // defensive — should not happen
      await client.query(`DELETE FROM sections WHERE id = ANY($1)`, [allIds]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // NEW-FU-48 + NEW-FU-66: pass err so the M-11 release wrapper signals
      // pg to destroy the (possibly bad) connection. Wrapped in try/catch
      // so a release-throws (extremely rare, but possible on a disposed
      // client) doesn't suppress the original `throw err`. The release
      // wrapper's `released` flag makes the finally's bare release() a
      // safe no-op when this branch ran.
      try { client.release(err); } catch { /* ignore */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* already released via catch path */ }
    }

    await this.revalidateSchedule(scheduleId);
    // NEW-FU-288: surface the deleted IDs to the controller so the
    // response payload tells the frontend exactly what to remove from
    // local state — replaces the CLEAR_SECTIONS hack.
    return { deletedIds: allIds, scheduleId };
  }

  /**
   * NEW-FU-276: extendSection — add one or more new meeting days to an existing
   * section group, mirroring the surviving rows' time/instructor/venue.
   *
   * Different from createSection: the pattern validator runs against the
   * COMBINED day-set (existing days + addDays), not just the new days.
   * This is necessary because a single-day addition alone wouldn't pass
   * validateSectionPattern (e.g., adding "Thursday" by itself isn't any
   * legal 3-credit pattern; "Sun + Tue + Thu" IS).
   *
   * Used by the R-15 quick-fix UI: when a section becomes under-covered
   * (Phase 22 per-day delete), the conflict carries `fixes` proposals;
   * each fix maps to one call to this method.
   *
   * @param {string}   sectionId  Any row id from the section group (we read
   *                              its (courseId, sectionNumber, time) and
   *                              fan out to all sibling rows from there).
   * @param {string[]} addDays    Days to add. Each must not already exist
   *                              in the group; combined with existing days
   *                              the result must satisfy validateSectionPattern.
   * @returns {{section, conflictResult}}  Same shape createSection returns.
   */
  async extendSection(sectionId, addDays) {
    if (!Array.isArray(addDays) || addDays.length === 0) {
      const err = new Error('extendSection requires a non-empty addDays array.');
      err.status = 400;
      throw err;
    }
    const peek = await sectionRepo.findById(sectionId);
    if (!peek) throw new Error(`Section ${sectionId} not found`);
    const scheduleId = peek.scheduleId;

    let firstNewId = null;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      // Same lock pattern as createSection — schedule row locked for tx duration.
      await assertSchedulerEditableLocked(client, scheduleId);

      // Load ALL rows of this section group under FOR UPDATE so the
      // pattern validation sees a consistent snapshot of existing days.
      // We key by (courseId, sectionNumber) — the same logical grouping
      // findSiblings uses, but without filtering by time (a section
      // group is defined by course + number, not by time).
      const groupRes = await client.query(`
        SELECT id, day, start_time::text AS start_time, end_time::text AS end_time,
               instructor_id, venue_id, section_type, course_id, section_number
        FROM sections
        WHERE schedule_id = $1 AND course_id = $2 AND section_number = $3
        FOR UPDATE
      `, [scheduleId, peek.courseId, peek.sectionNumber]);
      const existing = groupRes.rows;
      if (existing.length === 0) {
        // Could only happen if the row was deleted between peek and lock.
        const err = new Error(`Section group not found`);
        err.status = 404;
        throw err;
      }

      // Use the FIRST surviving row as the template — addDays inherit its
      // time / instructor / venue / sectionType. (All existing rows share
      // the same time in practice; if they didn't, the validator would
      // already have rejected the original creation.)
      const template = existing[0];

      // Reject adds that duplicate an existing day in the group.
      const existingDays = new Set(existing.map(r => r.day));
      for (const d of addDays) {
        if (existingDays.has(d)) {
          const err = new Error(`Day ${d} already exists in this section group.`);
          err.status = 409;
          throw err;
        }
      }

      // Fetch course for the validator (credits + has_lab).
      const courseRow = await courseRepo.findById(template.course_id);
      if (!courseRow) {
        const err = new Error(`Course ${template.course_id} not found`);
        err.status = 404;
        throw err;
      }

      // The pattern validator's contract: given the FULL day set (existing
      // ∪ added) and the time/credits/sectionType, return ok or an error.
      // We pass the union so it sees a complete tuple.
      const combinedDays = [...existingDays, ...addDays];
      const patternCheck = sectionPattern.validateSectionPattern({
        credits:     Number(courseRow.credits),
        hasLab:      Boolean(courseRow.has_lab),
        sectionType: template.section_type,
        days:        combinedDays,
        startTime:   template.start_time,
        endTime:     template.end_time,
      });
      if (!patternCheck.ok) {
        const err = new Error(patternCheck.error);
        err.status = 400;
        throw err;
      }

      // Insert one row per added day, mirroring the template row.
      for (const day of addDays) {
        const res = await client.query(`
          INSERT INTO sections
            (schedule_id, course_id, instructor_id, venue_id, section_number,
             day, start_time, end_time, section_type)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id
        `, [
          scheduleId, template.course_id,
          template.instructor_id, template.venue_id,
          template.section_number, day,
          template.start_time, template.end_time,
          template.section_type,
        ]);
        if (!firstNewId) firstNewId = res.rows[0].id;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      try { client.release(err); } catch { /* ignore */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* already released via catch path */ }
    }

    const firstSection = firstNewId ? await sectionRepo.findById(firstNewId) : null;
    return this._revalidateAndReturn(scheduleId, firstSection);
  }

  /**
   * Internal: run the full evaluator against the schedule using the given DB
   * handle (a pool wrapper or a transactional client). Returns the populated
   * ConflictResult. Persistence is the caller's responsibility — this lets
   * `saveSchedule` reuse the exact result it just persisted under one lock.
   */
  async _evaluateSchedule(scheduleId, db) {
    // NEW-FU-93/94: pull section_type, venue type, course has_lab into the
    // snapshot so R-11/R-12 can fire on type mismatches without extra
    // queries. Mirrors SectionRepository.SELECT_SECTION exactly so the
    // domain mapping is identical wherever sections are loaded.
    const secRes = await db.query(`
      SELECT
        s.id, s.schedule_id, s.course_id, s.instructor_id, s.venue_id,
        s.section_number, s.day, s.start_time::text, s.end_time::text,
        s.section_type, s.gender,
        c.course_code, c.name AS course_name,
        c.academic_level, c.category, c.num_sections, c.has_lab, c.credits,
        c.is_capstone, c.is_external,
        i.name AS instructor_name,
        v.name AS venue_name, v.type AS venue_type
      FROM sections s
      JOIN    courses     c ON c.id = s.course_id
      LEFT JOIN instructors i ON i.id = s.instructor_id
      LEFT JOIN venues      v ON v.id = s.venue_id
      WHERE s.schedule_id = $1
    `, [scheduleId]);

    const Section = require('../domain/Section');
    const sections = secRes.rows.map(row => new Section({
      id: row.id, scheduleId: row.schedule_id,
      courseId: row.course_id, instructorId: row.instructor_id, venueId: row.venue_id,
      sectionNumber: row.section_number, day: row.day,
      startTime: row.start_time, endTime: row.end_time,
      courseCode: row.course_code, courseName: row.course_name,
      academicLevel: row.academic_level, category: row.category,
      numSections: row.num_sections, instructorName: row.instructor_name,
      venueName: row.venue_name,
      // NEW-FU-93/94
      sectionType: row.section_type, venueType: row.venue_type, hasLab: row.has_lab,
      // NEW-FU-270: credits joined for R-15.
      credits: row.credits,
      // NEW-FU-272 (Phase 50): is_capstone drives the new venue-rule skip path.
      isCapstone: row.is_capstone,
      // NEW-FU-272 (Phase 50 #3): gender enables the M/F sibling exception
      // in R-04 and R-05.
      gender: row.gender,
      // NEW-FU-275 (Phase 52 #5): external (SWE 399) — every rule skips
      // these sections in the conflict engine.
      isExternal: row.is_external,
    }));

    const instrIds = [...new Set(sections.map(s => s.instructorId).filter(Boolean))];
    let ohMap = new Map();
    if (instrIds.length) {
      const ohRes = await db.query(`
        SELECT instructor_id, day, start_time::text AS start_time, end_time::text AS end_time
        FROM office_hours WHERE instructor_id = ANY($1)
      `, [instrIds]);
      for (const row of ohRes.rows) {
        if (!ohMap.has(row.instructor_id)) ohMap.set(row.instructor_id, []);
        ohMap.get(row.instructor_id).push({
          day: row.day, startTime: row.start_time, endTime: row.end_time,
        });
      }
    }

    const result = engine.evaluateAll(sections, ohMap);

    // NEW-FU-291/292 (Phase 25): augment R-04 (instructor double-booked)
    // and R-05 (venue double-booked) conflicts with `fixes` proposals —
    // concrete "reassign to X" buttons the user can click in the side
    // panel. Same channel R-15 uses (FU-278); the data shape differs
    // by `kind` ('reassign-instructor' / 'reassign-venue' / 'add-days').
    //
    // The fix targets sectionAId (the section in the conflict's "primary"
    // slot — the one the rule was "looking at" when it fired). User can
    // always reassign the other side manually if they prefer.
    //
    // We load instructors + venues once for the whole augmentation pass
    // and reuse for every conflict. Cheap — two SELECTs that the conflict
    // panel triggers anyway.
    const r04Conflicts = result.conflicts.filter(c => c.ruleId === 'R-04' && c.sectionBId);
    const r05Conflicts = result.conflicts.filter(c => c.ruleId === 'R-05' && c.sectionBId);
    if (r04Conflicts.length > 0 || r05Conflicts.length > 0) {
      const [allInstructors, allVenues] = await Promise.all([
        instrRepo.findAll(),
        venueRepo.findAll(),
      ]);

      // Build a quick "is instructor busy at this (day, time)?" lookup.
      // Returns true if any OTHER section uses this instructor and overlaps
      // the given (day, startTime, endTime).
      function instructorBusyAt(instructorId, day, startMin, endMin, excludeSectionId) {
        if (!instructorId) return false;
        for (const s of sections) {
          if (s.id === excludeSectionId) continue;
          if (s.instructorId !== instructorId) continue;
          if (s.day !== day) continue;
          const sStart = Section.toMinutes(s.startTime);
          const sEnd   = Section.toMinutes(s.endTime);
          if (sStart < endMin && startMin < sEnd) return true;
        }
        // Also check office hours — an instructor with OH at this slot
        // counts as busy. Otherwise we'd suggest moving the section onto
        // the instructor's own OH, which R-04 would just immediately fire on.
        const oh = ohMap.get(instructorId) ?? [];
        for (const o of oh) {
          if (o.day !== day) continue;
          const ohStart = Section.toMinutes(o.startTime);
          const ohEnd   = Section.toMinutes(o.endTime);
          if (ohStart < endMin && startMin < ohEnd) return true;
        }
        return false;
      }
      function venueBusyAt(venueId, day, startMin, endMin, excludeSectionId) {
        if (!venueId) return false;
        for (const s of sections) {
          if (s.id === excludeSectionId) continue;
          if (s.venueId !== venueId) continue;
          if (s.day !== day) continue;
          const sStart = Section.toMinutes(s.startTime);
          const sEnd   = Section.toMinutes(s.endTime);
          if (sStart < endMin && startMin < sEnd) return true;
        }
        return false;
      }

      // Per-instructor and per-venue load (count of sections in this
      // schedule). Used to rank fix proposals: spread load by suggesting
      // the lowest-loaded free option first.
      const instrLoad = new Map();
      const venueLoad = new Map();
      for (const s of sections) {
        if (s.instructorId) instrLoad.set(s.instructorId, (instrLoad.get(s.instructorId) ?? 0) + 1);
        if (s.venueId)      venueLoad.set(s.venueId,      (venueLoad.get(s.venueId)      ?? 0) + 1);
      }

      const sectionsById = new Map(sections.map(s => [s.id, s]));

      for (const conflict of r04Conflicts) {
        const target = sectionsById.get(conflict.sectionAId);
        if (!target || !target.day || !target.startTime || !target.endTime) continue;
        const startMin = Section.toMinutes(target.startTime);
        const endMin   = Section.toMinutes(target.endTime);
        // Candidates: instructors who are NOT busy at this slot AND aren't
        // the section's current instructor (no-op reassignment).
        const candidates = allInstructors
          .filter(i => i.id !== target.instructorId)
          .filter(i => !instructorBusyAt(i.id, target.day, startMin, endMin, target.id))
          .map(i => ({ ...i, load: instrLoad.get(i.id) ?? 0 }))
          .sort((a, b) => a.load - b.load || a.name.localeCompare(b.name));
        const fixes = candidates.slice(0, 3).map(i => ({
          kind:           'reassign-instructor',
          sectionId:      target.id,
          instructorId:   i.id,
          instructorName: i.name,
          label:          `+ Reassign to ${i.name}`,
        }));
        if (fixes.length > 0) conflict.fixes = fixes;
      }

      for (const conflict of r05Conflicts) {
        const target = sectionsById.get(conflict.sectionAId);
        if (!target || !target.day || !target.startTime || !target.endTime) continue;
        const startMin = Section.toMinutes(target.startTime);
        const endMin   = Section.toMinutes(target.endTime);
        // Candidate venues must match the section's type (Lab → Laboratory,
        // Lec → LectureHall). The pattern validator enforces this on writes;
        // we mirror it here so fix suggestions don't trigger R-11/R-12.
        const desiredType = target.sectionType === 'Lab' ? 'Laboratory' : 'LectureHall';
        const candidates = allVenues
          .filter(v => v.id !== target.venueId)
          .filter(v => v.type === desiredType)
          .filter(v => !venueBusyAt(v.id, target.day, startMin, endMin, target.id))
          .map(v => ({ ...v, load: venueLoad.get(v.id) ?? 0 }))
          .sort((a, b) => a.load - b.load || a.name.localeCompare(b.name));
        const fixes = candidates.slice(0, 3).map(v => ({
          kind:      'reassign-venue',
          sectionId: target.id,
          venueId:   v.id,
          venueName: v.name,
          label:     `+ Reassign to ${v.name}`,
        }));
        if (fixes.length > 0) conflict.fixes = fixes;
      }
    }

    // R-09: missing instructor → soft (deduplicated by courseId+sectionNumber)
    const f09Seen = new Set();
    for (const sec of sections) {
      const check = sectionRepo.validateOneInstructor(sec);
      if (check) {
        const key = `${sec.courseId}|${sec.sectionNumber}`;
        if (f09Seen.has(key)) continue;
        f09Seen.add(key);
        result.add(new Conflict({
          id: null, scheduleId,
          ruleId: 'R-09', severity: check.severity,
          description: check.message,
          sectionAId: sec.id, sectionBId: null,
        }));
      }
    }
    // NEW-FU-91: R-10 — missing venue → soft (parallel to R-09 above).
    // Dedup is by courseId+sectionNumber so a single logical section that
    // spans Sun/Tue/Thu produces one warning, not three. The dedup tracks
    // a SEPARATE seen-set from R-09 so the two rules don't interfere
    // (a section can be missing both — the user sees both warnings).
    const f10Seen = new Set();
    for (const sec of sections) {
      const check = sectionRepo.validateOneVenue(sec);
      if (check) {
        const key = `${sec.courseId}|${sec.sectionNumber}`;
        if (f10Seen.has(key)) continue;
        f10Seen.add(key);
        result.add(new Conflict({
          id: null, scheduleId,
          ruleId: 'R-10', severity: check.severity,
          description: check.message,
          sectionAId: sec.id, sectionBId: null,
        }));
      }
    }

    // NEW-FU-97 + NEW-FU-98: R-11 + R-12 — venue-type mismatch.
    //   R-11: Lab section assigned to a non-Lab venue (Lecture Hall)
    //   R-12: Lecture section assigned to a Lab venue
    // Both fire only when a venue IS assigned (no venue → R-10 handles
    // that case; R-11/R-12 don't double-report). The two rules use
    // separate seen-sets so they don't cross-suppress, and each
    // dedupes by courseId+sectionNumber so STT/MW group siblings collapse.
    // NEW-FU-272 (Phase 50): R-11 / R-12 now also skip when:
    //   • course.is_capstone = true  → capstone, venue rules don't apply
    //   • venue.type = 'Multipurpose' → room genuinely hosts both Lec and
    //     Lab activity (e.g., 22-334). Treating it as either-or creates
    //     fake firings. Multipurpose satisfies both rules.
    const f11Seen = new Set();
    const f12Seen = new Set();
    for (const sec of sections) {
      if (!sec.venueId || !sec.venueType) continue; // R-10 covers missing venue
      if (sec.isCapstone) continue;                // Phase 50 #1
      if (sec.isExternal) continue;                // Phase 52 #5 (SWE 399)
      if (sec.venueType === 'Multipurpose') continue; // Phase 50 #3
      const key = `${sec.courseId}|${sec.sectionNumber}`;
      // R-11: Lab section in a non-Lab venue
      if (sec.sectionType === 'Lab' && sec.venueType !== 'Laboratory') {
        if (!f11Seen.has(key)) {
          f11Seen.add(key);
          result.add(new Conflict({
            id: null, scheduleId,
            ruleId: 'R-11', severity: 'Soft',
            description: `Lab section ${sec.sectionNumber} of ${sec.courseCode ?? sec.courseId} is assigned to ${sec.venueName ?? 'a non-lab venue'} (${sec.venueType}). Lab sections should be in a Laboratory.`,
            sectionAId: sec.id, sectionBId: null,
          }));
        }
      }
      // R-12: Lecture section in a Lab venue
      if (sec.sectionType === 'Lec' && sec.venueType === 'Laboratory') {
        if (!f12Seen.has(key)) {
          f12Seen.add(key);
          result.add(new Conflict({
            id: null, scheduleId,
            ruleId: 'R-12', severity: 'Soft',
            description: `Lecture section ${sec.sectionNumber} of ${sec.courseCode ?? sec.courseId} is assigned to ${sec.venueName ?? 'a lab venue'} (Laboratory). Lecture sections should be in a Lecture Hall.`,
            sectionAId: sec.id, sectionBId: null,
          }));
        }
      }
    }

    // NEW-FU-99: R-13 — an instructor teaching at least one section in the
    // schedule but with zero office-hour rows produces ONE soft warning
    // per instructor (deduped by instructor_id). Uses the already-loaded
    // ohMap so this is a free derivation. Empty ohMap entry (instructor in
    // map with []) and absent entry (not in map at all) both mean "no
    // OHs" — the map is populated only for instructors that DO have rows.
    //
    // The conflict is attached to whichever section the dedup loop
    // encounters first for that instructor (sectionAId is NOT NULL by
    // schema). The Conflict's description names the instructor so the
    // user knows which person needs OHs.
    const f13Seen = new Set();
    for (const sec of sections) {
      if (!sec.instructorId) continue;
      // NEW-FU-275 (Phase 52 #5): external (SWE 399) — no instructor by
      // design; R-09 already skips, R-13 must too for consistency.
      if (sec.isExternal) continue;
      if (f13Seen.has(sec.instructorId)) continue;
      if (!ohMap.has(sec.instructorId)) {
        f13Seen.add(sec.instructorId);
        result.add(new Conflict({
          id: null, scheduleId,
          ruleId: 'R-13', severity: 'Soft',
          description: `${sec.instructorName ?? 'An instructor'} is teaching but has no office hours assigned. Add at least one office hour slot.`,
          sectionAId: sec.id, sectionBId: null,
        }));
      }
    }

    // NEW-FU-107: R-14 — Lec/Lab coexistence for has_lab=true courses.
    // When the course has has_lab=true, the schedule must contain BOTH at
    // least one Lec section AND at least one Lab section. Missing one side
    // → one soft warning per course, identifying which side is missing.
    //
    // Only fires for courses that actually have SOME section in the
    // schedule — a has_lab course with zero sections at all is treated as
    // "not scheduled yet", not as a violation.
    //
    // Dedup is by courseId so a course with N Lec sections but no Labs
    // produces exactly one R-14, not N. The conflict attaches to the
    // first encountered section as the carrier.
    const f14CourseStatus = new Map(); // courseId → { hasLec, hasLab, anySec, courseCode }
    for (const sec of sections) {
      if (!sec.hasLab) continue; // course doesn't require both
      if (sec.isExternal) continue; // Phase 52 #5
      let status = f14CourseStatus.get(sec.courseId);
      if (!status) {
        status = { hasLec: false, hasLab: false, anySec: sec, courseCode: sec.courseCode };
        f14CourseStatus.set(sec.courseId, status);
      }
      if (sec.sectionType === 'Lec') status.hasLec = true;
      if (sec.sectionType === 'Lab') status.hasLab = true;
    }
    for (const { hasLec, hasLab, anySec, courseCode } of f14CourseStatus.values()) {
      if (hasLec && hasLab) continue;
      const missing = !hasLec ? 'Lecture' : 'Lab';
      result.add(new Conflict({
        id: null, scheduleId,
        ruleId: 'R-14', severity: 'Soft',
        description: `${courseCode ?? 'A course'} is set up to have both lectures and labs, but it's missing a ${missing} section. Add at least one ${missing} section, or change the course so it no longer includes a lab.`,
        sectionAId: anySec.id, sectionBId: null,
      }));
    }

    // NEW-FU-270: R-15 — InsufficientCreditCoverage.
    //
    // Phase 22 introduces per-day delete on grid blocks. Before this,
    // a section's day pattern was set at creation time and the
    // sectionPattern validator enforced the legal-pattern table. The
    // per-day delete bypasses that validator (it just removes one row),
    // so a section that was originally a legal STT pattern (3 × 50min
    // = 150 min/week, satisfies 3-credit requirement) can decay to ST
    // (2 × 50min = 100 min/week) without going through the validator.
    //
    // R-15 closes that gap: for each LECTURE section_group, sum total
    // weekly minutes across its surviving meetings and compare against
    // the course's required minutes. Required = credits × 50 (KFUPM
    // "credit hour" convention). For has_lab courses, one credit is
    // covered by the lab so the lecture requirement drops by 1 credit.
    //
    // We only check lecture sections — lab integrity is handled by R-14
    // (must exist) and pattern-table policy at write time. The KFUPM
    // rule table only specifies legal lecture patterns; lab durations
    // (50/75/165 min) span a wider range and don't follow the same
    // credit-hour math.
    //
    // Dedup by section_group (courseId + sectionNumber). A single group
    // with 2 surviving days produces ONE R-15, not 2.
    const f15Groups = new Map(); // key: courseId|sectionNumber → { meetings, course details }
    for (const sec of sections) {
      if (sec.sectionType !== 'Lec') continue;
      if (!sec.credits) continue;       // courses without credits — defensive
      if (sec.isExternal) continue;     // Phase 52 #5 (SWE 399 off-campus)
      if (!sec.startTime || !sec.endTime) continue;
      // NEW-FU-272 (Phase 50 #3): capstone-style courses (is_capstone=true)
      // legitimately meet once a week for project supervision — the credit-
      // coverage rule that demands 50 min/credit-hour is inappropriate noise.
      // SWE 412/413/414 (1cr lecture + 6 lab hrs = "project") would otherwise
      // fire R-15 every term they're scheduled.
      if (sec.isCapstone) continue;
      const key = `${sec.courseId}|${sec.sectionNumber}`;
      let group = f15Groups.get(key);
      if (!group) {
        group = {
          totalMinutes: 0,
          credits:      Number(sec.credits),
          hasLab:       Boolean(sec.hasLab),
          courseCode:   sec.courseCode,
          sectionNumber: sec.sectionNumber,
          anySec:       sec,
          dayCount:     0,
        };
        f15Groups.set(key, group);
      }
      const startMin = Section.toMinutes(sec.startTime);
      const endMin   = Section.toMinutes(sec.endTime);
      const dur      = endMin - startMin;
      if (dur > 0) {
        group.totalMinutes += dur;
        group.dayCount++;
      }
    }
    for (const group of f15Groups.values()) {
      // Required minutes — one credit hour = 50 min/week (KFUPM convention).
      // For has_lab courses, the lab covers one credit, so the lecture
      // section only needs to cover (credits - 1) × 50. Example: a 4-cr
      // course with has_lab=true requires 3 × 50 = 150 min of lecture
      // (typical STT 50 pattern) — the lab carries the extra credit.
      const effectiveCredits = group.hasLab
        ? Math.max(1, group.credits - 1)
        : group.credits;
      const requiredMinutes = effectiveCredits * 50;
      if (group.totalMinutes >= requiredMinutes) continue;

      // NEW-FU-278: compute quick-fix proposals — concrete "add a day"
      // remediations the user can apply with one click. The algorithm:
      //   1. Determine the surviving section's per-meeting duration.
      //   2. Look up which day-templates are legal for this course
      //      (credits + hasLab + duration) from the FU-240 rule table.
      //   3. For each template whose days SUPERSET the surviving days,
      //      compute the "missing days" = template days − surviving days.
      //   4. Each non-empty missing set becomes a fix proposal: applying
      //      it completes that template, restoring the legal pattern.
      //   5. Rank by smallest missing-set first (least intrusive fix).
      //   6. Cap at top 3 — the modal-free side-panel UI has limited room.
      //
      // Why surviving days must be a subset of the candidate template:
      // we're proposing ADDITIONS only — never proposing the user delete
      // a surviving day. If the user originally had STT but moved one
      // meeting to Friday (illegal), the surviving set won't be a subset
      // of any template, and we emit zero fixes. The R-15 description
      // still tells them what to do; the buttons are a convenience.
      const fixes = [];
      const survivingDays = new Set(
        // anySec carries one row's data — but we need ALL surviving
        // days. Walk f15Groups items differently: rebuild from sections
        // filtered to this group key.
        sections
          .filter(s =>
            s.sectionType === 'Lec' &&
            s.courseId === group.anySec.courseId &&
            s.sectionNumber === group.sectionNumber)
          .map(s => s.day)
      );
      // Per-meeting duration from any surviving row. All surviving rows
      // share time (validateSectionPattern requires it), so the first is
      // representative. The mini-rebuild above gives us a precise row.
      const survivingRow = sections.find(s =>
        s.sectionType === 'Lec' &&
        s.courseId === group.anySec.courseId &&
        s.sectionNumber === group.sectionNumber
      );
      const perMeetingDur = survivingRow
        ? (Section.toMinutes(survivingRow.endTime) - Section.toMinutes(survivingRow.startTime))
        : 0;
      if (perMeetingDur > 0) {
        const candidateTemplates = sectionPattern.legalDayTemplatesForCourse({
          credits: group.credits, hasLab: group.hasLab, duration: perMeetingDur,
        });
        // Map template name → concrete day list.
        const TEMPLATE_DAYS = {
          STT:    ['Sunday', 'Tuesday', 'Thursday'],
          MW:     ['Monday', 'Wednesday'],
          ST:     ['Sunday', 'Tuesday'],
          TT:     ['Tuesday', 'Thursday'],
          ONE_DAY: null,  // single-day patterns can't be "extended" to fix coverage
        };
        for (const tplName of candidateTemplates) {
          const tplDays = TEMPLATE_DAYS[tplName];
          if (!tplDays) continue;
          const tplSet = new Set(tplDays);
          // Surviving must be a subset of this template.
          let supersetOk = true;
          for (const d of survivingDays) if (!tplSet.has(d)) { supersetOk = false; break; }
          if (!supersetOk) continue;
          const missing = tplDays.filter(d => !survivingDays.has(d));
          if (missing.length === 0) continue; // template already satisfied (shouldn't happen — we're under-covered)
          fixes.push({
            kind:      'add-days',
            sectionId: group.anySec.id,
            template:  tplName,
            addDays:   missing,
            label:
              `+ Add ${missing.join(' + ')} at ${survivingRow.startTime}–${survivingRow.endTime}`,
          });
        }
        fixes.sort((a, b) => a.addDays.length - b.addDays.length);
        fixes.splice(3); // cap at 3 proposals
      }

      result.add(new Conflict({
        id: null, scheduleId,
        ruleId: 'R-15', severity: 'Soft',
        description:
          `${group.courseCode ?? 'A course'} §${group.sectionNumber} only meets ` +
          `${group.totalMinutes} min/week across ${group.dayCount} day${group.dayCount === 1 ? '' : 's'} — ` +
          `${group.credits}-credit course${group.hasLab ? ' (with lab)' : ''} needs at least ` +
          `${requiredMinutes} min of lecture per week. Add another meeting day or extend the existing one.`,
        sectionAId: group.anySec.id, sectionBId: null,
        fixes: fixes.length > 0 ? fixes : null,
      }));
    }

    return result;
  }

  /**
   * Run full conflict evaluation on the entire schedule and persist results.
   */
  async revalidateSchedule(scheduleId) {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const result = await this._evaluateSchedule(scheduleId, client);
      await conflictRepo.replaceAll(scheduleId, result.conflicts, client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // NEW-FU-48 + NEW-FU-66: pass err so the M-11 release wrapper signals
      // pg to destroy the (possibly bad) connection. Wrapped in try/catch
      // so a release-throws (extremely rare, but possible on a disposed
      // client) doesn't suppress the original `throw err`. The release
      // wrapper's `released` flag makes the finally's bare release() a
      // safe no-op when this branch ran.
      try { client.release(err); } catch { /* ignore */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* already released via catch path */ }
    }
  }

  async _revalidateAndReturn(scheduleId, section = null) {
    const conflictResult = await this.revalidateSchedule(scheduleId);
    if (section) return { section, conflictResult };
    return conflictResult;
  }

  /**
   * NEW-H9: revalidation, conflict persistence, and the status update all run
   * inside ONE transaction with `SELECT … FOR UPDATE` on the schedule row.
   * Concurrent section mutations that would introduce a hard conflict now
   * block until save completes (or commit after save and don't compromise
   * the snapshot we evaluated).
   *
   * NEW-FU-78: the second argument is now overloaded:
   *   - `true`            → legacy semantics: confirm ALL soft conflicts (kept
   *                         for backward-compat with older clients)
   *   - `false` / falsy   → don't confirm any softs (return saved:false if any)
   *   - `string[]`        → confirm ONLY these conflict ids; if the freshly
   *                         evaluated soft set has any id NOT in the list,
   *                         a new soft appeared between the user clicking
   *                         "save anyway" and the save tx — reject with
   *                         saved:false so the UI can re-render the modal.
   */
  async saveSchedule(scheduleId, confirmSoft = false) {
    // NEW-M7 + NEW-FU-78: distinguish boolean confirmSoft (legacy: confirm all)
    // from an array of explicit conflict ids the user authorised to dismiss.
    const confirmSoftIds = Array.isArray(confirmSoft) ? confirmSoft : null;
    confirmSoft = confirmSoftIds ? true : Boolean(confirmSoft);

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Lock the schedule row for the rest of the transaction.
      // NEW-FU-201: pull archived_at too — saveSchedule mutates state
      // (conflicts table) and the status field, so it must also refuse
      // archived schedules.
      const lockRes = await client.query(
        `SELECT id, status, archived_at FROM schedules WHERE id = $1 FOR UPDATE`,
        [scheduleId]
      );
      if (lockRes.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error(`Schedule ${scheduleId} not found.`);
      }
      if (lockRes.rows[0].archived_at !== null) {
        await client.query('ROLLBACK');
        const err = new Error('Schedule is archived and cannot be saved. Unarchive its term first.');
        err.status = 409;
        throw err;
      }

      const result = await this._evaluateSchedule(scheduleId, client);
      await conflictRepo.replaceAll(scheduleId, result.conflicts, client);

      if (result.hasHard) {
        await client.query('COMMIT'); // persist refreshed conflicts even though we won't save
        return { saved: false, conflictResult: result };
      }
      if (result.hasSoft && !confirmSoft) {
        await client.query('COMMIT');
        return { saved: false, conflictResult: result };
      }

      // NEW-FU-78: when the client supplied an explicit id list, reject if
      // the fresh soft set introduced any conflict the user hasn't seen.
      //
      // BUT: conflict.id is regenerated on every `replaceAll` (DELETE +
      // re-INSERT inside this same transaction), so the ids the client got
      // back from its prior `GET /conflicts` are *guaranteed* stale by the
      // time we reach here. We compare by a stable signature instead:
      //   ruleId | sectionAId | sectionBId | description
      // — every component is content-derived and identical across saves
      // for the same logical violation.
      const signatureOf = (c) =>
        `${c.ruleId}|${c.sectionAId ?? ''}|${c.sectionBId ?? ''}|${c.description ?? ''}`;
      if (result.hasSoft && confirmSoftIds) {
        const freshSoftSigs = new Set(result.softConflicts.map(signatureOf));
        // The client may have sent either persisted ids (legacy) OR
        // signatures. To stay backward-compatible we accept BOTH forms in
        // the list. Recognise signatures by their structural shape (`|`
        // separated, not a UUID).
        const isSig = s => typeof s === 'string' && s.includes('|');
        const authorisedSigs = new Set(confirmSoftIds.filter(isSig));
        const authorisedIds  = new Set(confirmSoftIds.filter(s => !isSig(s)));
        // For id-based authorisation, look up the corresponding signatures
        // among CURRENT softs (matches if the conflict survived as-is).
        for (const c of result.softConflicts) {
          if (c.id && authorisedIds.has(c.id)) authorisedSigs.add(signatureOf(c));
        }
        const newSoftSigs = [...freshSoftSigs].filter(s => !authorisedSigs.has(s));
        if (newSoftSigs.length > 0) {
          await client.query('COMMIT'); // persist refreshed conflicts
          // Return the matching conflicts (not raw signatures) so the UI
          // can repopulate the modal.
          // NEW-FU-82: Set lookup (O(1)) instead of Array.includes (O(K))
          // for each filter element. Same correctness, O(M+K) instead of
          // O(M*K) — matches the perf-discipline pattern from FU-60
          // (multi-row INSERT) and consistent with the use of Sets for
          // `freshSoftSigs` / `authorisedSigs` above.
          const newSoftSigsSet = new Set(newSoftSigs);
          const newSoftConflicts = result.softConflicts.filter(c =>
            newSoftSigsSet.has(signatureOf(c))
          );
          return { saved: false, conflictResult: result, newSoftConflicts };
        }
      }

      if (result.hasSoft && confirmSoft) {
        // NEW-FU-78: scope the UPDATE to the user-authorised set when an
        // explicit list was provided. Match by signature so it still works
        // even though replaceAll regenerated the persisted ids.
        if (confirmSoftIds && confirmSoftIds.length > 0) {
          const idsToConfirm = result.softConflicts
            .filter(c => {
              const sig = signatureOf(c);
              // Authorised if its signature matches OR its (current) id is
              // in the list — covers both forms.
              return confirmSoftIds.includes(sig) || (c.id && confirmSoftIds.includes(c.id));
            })
            .map(c => c.id)
            .filter(Boolean);
          if (idsToConfirm.length > 0) {
            await client.query(
              `UPDATE conflicts SET confirmed = true
               WHERE schedule_id = $1 AND severity = 'Soft' AND id = ANY($2)`,
              [scheduleId, idsToConfirm]
            );
          }
        } else {
          await client.query(
            `UPDATE conflicts SET confirmed = true WHERE schedule_id = $1 AND severity = 'Soft'`,
            [scheduleId]
          );
        }
      }
      // NEW-FU-42: capture the refreshed schedule row in RETURNING so the
      // caller can hand it back to the frontend, which then dispatches
      // SET_SCHEDULE. Previously the frontend's local state.schedule.status
      // stayed at 'Draft' until the next page reload — the Save button
      // didn't re-disable, and follow-up edits hit 409 "finalized" with no
      // local signal explaining why.
      const updRes = await client.query(
        `UPDATE schedules SET status = $1, updated_at = NOW() WHERE id = $2
         RETURNING id, department_id, semester, status, created_by, created_at, updated_at`,
        [SCHEDULE_STATUS.FINALIZED, scheduleId]
      );
      await client.query('COMMIT');
      return { saved: true, conflictResult: result, schedule: updRes.rows[0] };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // NEW-FU-48 + NEW-FU-66: pass err so the M-11 release wrapper signals
      // pg to destroy the (possibly bad) connection. Wrapped in try/catch
      // so a release-throws (extremely rare, but possible on a disposed
      // client) doesn't suppress the original `throw err`. The release
      // wrapper's `released` flag makes the finally's bare release() a
      // safe no-op when this branch ran.
      try { client.release(err); } catch { /* ignore */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* already released via catch path */ }
    }
  }

  async getSectionsForSchedule(scheduleId) { return sectionRepo.findBySchedule(scheduleId); }
  async getSectionsForInstructor(scheduleId, instructorId) {
    const [sections, officeHours] = await Promise.all([
      sectionRepo.findByInstructor(scheduleId, instructorId),
      instrRepo.getOfficeHours(instructorId),
    ]);
    return { sections, officeHours };
  }
  async getSectionsForVenue(scheduleId, venueId) {
    return sectionRepo.findByVenue(scheduleId, venueId);
  }
}

// NEW-FU-21: expose the canonical "lock schedule + reject if Finalized"
// helper so the other section-writing path (ExportService.importFromExcel)
// can use the same idiom rather than duplicating the SQL. Keeps a single
// source of truth for the finalize-immutability contract.
const svc = new ScheduleService();
svc.assertSchedulerEditableLocked = assertSchedulerEditableLocked;
module.exports = svc;
