const { query, getClient } = require('../config/db');
const Conflict  = require('../domain/Conflict');
// NEW-FU-25: import the status-enum constant so SQL parameter bindings
// reference a single source of truth instead of hardcoded literals.
const { SCHEDULE_STATUS } = require('../config/constants');

// ── ConflictRepository ────────────────────────────────────────────────────────
class ConflictRepository {
  async findBySchedule(scheduleId) {
    const res = await query(`
      SELECT c.*
      FROM conflicts c
      WHERE c.schedule_id = $1
      ORDER BY c.created_at
    `, [scheduleId]);
    return res.rows.map(r => new Conflict({
      id: r.id, scheduleId: r.schedule_id, ruleId: r.rule_id,
      severity: r.severity, description: r.description,
      sectionAId: r.section_a_id, sectionBId: r.section_b_id,
      confirmed: r.confirmed, createdAt: r.created_at,
    }));
  }

  async replaceAll(scheduleId, conflicts, client) {
    const db = client ?? { query: (t,p) => query(t,p) };

    // NEW-FU-87: preserve `confirmed=true` across replaceAll by snapshotting
    // the existing confirmed signatures BEFORE the wipe, then carrying them
    // forward to matching newly-evaluated conflicts. Without this, every
    // revalidation (which calls replaceAll) reset all softs to confirmed=
    // false — so after a user clicked "Save Anyway" and the schedule was
    // un-finalized (e.g., by an admin via SQL to allow further edits), the
    // previously-acknowledged softs reappeared as pending. The signature is
    // ruleId|sectionAId|sectionBId|description — content-derived and stable
    // across saves (FU-80 made R-01/R-02 descriptions deterministic).
    const sigOf = (c) =>
      `${c.ruleId}|${c.sectionAId ?? ''}|${c.sectionBId ?? ''}|${c.description ?? ''}`;
    const prevConfirmedRes = await db.query(
      `SELECT rule_id, section_a_id, section_b_id, description
       FROM conflicts
       WHERE schedule_id = $1 AND severity = 'Soft' AND confirmed = TRUE`,
      [scheduleId]
    );
    const previouslyConfirmedSigs = new Set(
      prevConfirmedRes.rows.map(r =>
        `${r.rule_id}|${r.section_a_id ?? ''}|${r.section_b_id ?? ''}|${r.description ?? ''}`
      )
    );

    await db.query(`DELETE FROM conflicts WHERE schedule_id = $1`, [scheduleId]);
    // NEW-FU-60: replace the N+1 loop with one multi-row INSERT. For a
    // schedule with K conflicts this drops K+1 round-trips to 2 (DELETE +
    // batched INSERT). Order of RETURNING id matches the order of supplied
    // rows so the caller's id-assignment loop still aligns.
    if (conflicts.length === 0) return conflicts;
    const cols = 7;
    const placeholders = conflicts
      .map((_, i) => `($${i*cols+1},$${i*cols+2},$${i*cols+3},$${i*cols+4},$${i*cols+5},$${i*cols+6},$${i*cols+7})`)
      .join(',');
    const params = [];
    for (const c of conflicts) {
      // NEW-FU-87: carry forward confirmed=true when the same conflict
      // (by signature) was confirmed in the prior state.
      const carriedConfirmed = (c.severity === 'Soft' && previouslyConfirmedSigs.has(sigOf(c)))
        ? true
        : (c.confirmed ?? false);
      if (carriedConfirmed) c.confirmed = true;
      params.push(c.scheduleId, c.ruleId, c.severity, c.description,
                  c.sectionAId, c.sectionBId ?? null, carriedConfirmed);
    }
    const res = await db.query(`
      INSERT INTO conflicts
        (schedule_id, rule_id, severity, description, section_a_id, section_b_id, confirmed)
      VALUES ${placeholders}
      RETURNING id
    `, params);
    for (let i = 0; i < conflicts.length; i++) {
      conflicts[i].id = res.rows[i].id;
    }
    return conflicts;
  }

  async confirmSoft(scheduleId) {
    await query(
      `UPDATE conflicts SET confirmed = TRUE WHERE schedule_id = $1 AND severity = 'Soft'`,
      [scheduleId]
    );
  }
}

// ── ScheduleRepository ────────────────────────────────────────────────────────
class ScheduleRepository {
  async findById(id) {
    const res = await query(
      `SELECT id, department_id, semester, status, created_by, created_at, updated_at
       FROM schedules WHERE id = $1`, [id]
    );
    return res.rows[0] ?? null;
  }

  async findByDeptSemester(departmentId, semester) {
    const res = await query(
      `SELECT id, department_id, semester, status, created_by, created_at, updated_at
       FROM schedules WHERE department_id = $1 AND semester = $2`,
      [departmentId, semester]
    );
    return res.rows[0] ?? null;
  }

  async listByDept(departmentId) {
    // NEW-FU-203: expose archived_at so the frontend can render the
    // read-only banner when the user's active schedule is archived.
    const res = await query(
      `SELECT id, department_id, semester, status, archived_at, created_at, updated_at
       FROM schedules WHERE department_id = $1 ORDER BY semester DESC`,
      [departmentId]
    );
    return res.rows;
  }

  async create({ departmentId, semester, createdBy }) {
    const res = await query(
      `INSERT INTO schedules (department_id, semester, created_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (department_id, semester) DO UPDATE SET updated_at=NOW()
       RETURNING id`,
      [departmentId, semester, createdBy ?? null]
    );
    return this.findById(res.rows[0].id);
  }

  async updateStatus(id, status) {
    await query(
      `UPDATE schedules SET status = $2, updated_at = NOW() WHERE id = $1`,
      [id, status]
    );
  }
}

// ── VenueRepository ───────────────────────────────────────────────────────────
class VenueRepository {
  /**
   * NEW-FU-274 (Phase 51 #5): optional term-scoped filter. Same shape as
   * InstructorRepository.findAll — only venues with sections in the given
   * term's schedule are returned. Empty terms produce empty lists.
   */
  async findAll(termCode = null) {
    if (termCode) {
      const res = await query(
        `SELECT DISTINCT v.id, v.name, v.type, v.capacity, v.is_dummy, v.created_at,
                (SUBSTRING(v.name FROM '^[0-9]+'))::int          AS sort_bldg,
                (SUBSTRING(v.name FROM '^[0-9]+-([0-9]+)'))::int AS sort_room
         FROM venues v
         JOIN sections s   ON s.venue_id   = v.id
         JOIN schedules sc ON sc.id        = s.schedule_id
         WHERE sc.semester = $1
         -- NEW-FU-462 (Phase 110): order by building number then room number,
         -- NUMERICALLY (so "7-220" sorts before "22-119", rooms ascend within a
         -- building). SELECT DISTINCT requires the sort keys in the SELECT list, so
         -- they ride along as harmless sort_bldg/sort_room columns the frontend ignores.
         ORDER BY sort_bldg NULLS LAST, sort_room NULLS LAST, v.name`,
        [termCode]
      );
      return res.rows;
    }
    const res = await query(
      `SELECT id, name, type, capacity, is_dummy, created_at FROM venues WHERE is_dummy = false
       -- NEW-FU-462 (Phase 110): numeric building-then-room order (see findAll term-scoped).
       ORDER BY (SUBSTRING(name FROM '^[0-9]+'))::int NULLS LAST,
                (SUBSTRING(name FROM '^[0-9]+-([0-9]+)'))::int NULLS LAST, name`
    );
    return res.rows;
  }

  async findById(id) {
    const res = await query(
      `SELECT id, name, type, capacity FROM venues WHERE id = $1`, [id]
    );
    return res.rows[0] ?? null;
  }

  async create({ name, type, capacity }) {
    const res = await query(
      `INSERT INTO venues (name, type, capacity) VALUES ($1,$2,$3) RETURNING id`,
      [name, type, parseInt(capacity, 10) /* NEW-L2 */]
    );
    return this.findById(res.rows[0].id);
  }

  async update(id, { name, type, capacity }) {
    await query(
      `UPDATE venues SET name=$2, type=$3, capacity=$4, updated_at=NOW() WHERE id=$1`,
      [id, name, type, parseInt(capacity, 10) /* NEW-L2 */]
    );
    return this.findById(id);
  }

  async delete(id) {
    await query(`DELETE FROM venues WHERE id = $1`, [id]);
  }
}

// ── CourseRepository ──────────────────────────────────────────────────────────
// NEW-FU-94: `has_lab` flows through every read+write so the frontend can
// gate the Lec/Lab section-type selector and the backend can validate that
// a 'Lab' section_type is only legal on a course that actually has labs.
class CourseRepository {
  /**
   * NEW-FU-274 (Phase 51 #5): optional term-scoped filter. When provided,
   * only returns courses that have at least one section in the given
   * term's schedule. The SWE 101 dummy is in term 251 only, so a 252
   * call will not surface it — keeping the per-term sidebars clean.
   *
   * Without `termCode` returns every course (backward-compatible for the
   * admin/global course-management UI).
   */
  async findAll(termCode = null) {
    if (termCode) {
      const res = await query(
        `SELECT DISTINCT c.id, c.course_code, c.name, c.credits, c.academic_level,
                         c.category, c.num_sections, c.has_lab, c.is_capstone, c.is_external
         FROM courses c
         JOIN sections s   ON s.course_id  = c.id
         JOIN schedules sc ON sc.id        = s.schedule_id
         WHERE sc.semester = $1
         ORDER BY c.academic_level, c.course_code`,
        [termCode]
      );
      return res.rows;
    }
    const res = await query(
      `SELECT id, course_code, name, credits, academic_level, category, num_sections, has_lab, is_capstone, is_external
       FROM courses ORDER BY academic_level, course_code`
    );
    return res.rows;
  }

  async findById(id) {
    const res = await query(
      `SELECT id, course_code, name, credits, academic_level, category, num_sections, has_lab,
              is_capstone, is_external
       FROM courses WHERE id = $1`, [id]
    );
    return res.rows[0] ?? null;
  }

  // NEW-FU-278 (Phase 54): create() now accepts isCapstone + isExternal so
  // admins can mark new courses at creation time. Both default to FALSE.
  async create({ courseCode, name, credits, academicLevel, category, numSections, hasLab,
                 isCapstone, isExternal }) {
    const res = await query(
      `INSERT INTO courses (course_code, name, credits, academic_level, category, num_sections, has_lab,
                            is_capstone, is_external)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [courseCode, name, parseInt(credits, 10) /* NEW-L2 */, academicLevel, category,
       parseInt(numSections, 10) || 1 /* NEW-L2 */,
       Boolean(hasLab) /* NEW-FU-94 */,
       Boolean(isCapstone), Boolean(isExternal)]
    );
    return this.findById(res.rows[0].id);
  }

  async update(id, { courseCode, name, credits, academicLevel, category, numSections, hasLab }) {
    // NEW-FU-94: COALESCE-style — only update has_lab when it was provided
    // (hasLab can be undefined for partial updates from older clients).
    const hasLabClause = hasLab === undefined ? '' : ', has_lab=$8';
    const params = [id, courseCode, name, parseInt(credits, 10), academicLevel, category, parseInt(numSections, 10) || 1];
    if (hasLab !== undefined) params.push(Boolean(hasLab));
    await query(
      `UPDATE courses SET course_code=$2, name=$3, credits=$4,
       academic_level=$5, category=$6, num_sections=$7${hasLabClause}, updated_at=NOW() WHERE id=$1`,
      params
    );
    return this.findById(id);
  }

  async delete(id) {
    // NEW-H3: sections-then-course must be atomic. If the second DELETE fails
    // (lock contention, future FK from a related table, network), the first
    // DELETE leaves the schedule course-less but its rows still exist as
    // orphans — wrap in a transaction so we either remove both or neither.
    const client = await getClient();
    try {
      await client.query('BEGIN');
      // NEW-FU-22 + NEW-FU-29: refuse if any section of this course belongs
      // to a Finalized schedule, AND hold a row lock on every schedule we
      // inspect so a concurrent saveSchedule can't finalize one of them
      // between this check and our DELETE.
      //
      // The FU-22 fix did the right check but unlocked, leaving a race:
      //   T1: DELETE course X  (check passes — no Finalized schedule yet)
      //   T2: saveSchedule S   (FOR UPDATE on S, set Finalized, commit)
      //   T1: DELETE FROM sections WHERE course_id = X  (wipes S's sections)
      // Locking every candidate schedule row in a single FOR UPDATE closes
      // that window for all schedules our DELETE could touch. Same lock-then-
      // check idiom as FU-2 / FU-20 / FU-21, applied to multiple rows.
      //
      // pg doesn't allow FOR UPDATE + DISTINCT in one query, so we SELECT
      // from `schedules` directly (PK-unique by definition) using an IN
      // subquery instead of joining `sections`. Returns one row per affected
      // schedule with its current (locked) status.
      const lockedSchedules = await client.query(`
        SELECT id, status FROM schedules
        WHERE id IN (SELECT schedule_id FROM sections WHERE course_id = $1)
        FOR UPDATE
      `, [id]);
      const finalizedHit = lockedSchedules.rows.find(r => r.status === SCHEDULE_STATUS.FINALIZED);
      if (finalizedHit) {
        await client.query('ROLLBACK').catch(() => {});
        const err = new Error('Cannot delete: course is referenced by a finalized schedule.');
        err.status = 409;
        throw err;
      }

      await client.query(`DELETE FROM sections WHERE course_id = $1`, [id]);
      await client.query(`DELETE FROM courses  WHERE id = $1`, [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // NEW-FU-48 + NEW-FU-66: destroy a possibly-bad connection; wrap so a
      // release-throws can't mask the original error.
      try { client.release(err); } catch { /* ignore */ }
      throw err;
    } finally {
      try { client.release(); } catch { /* already released via catch path */ }
    }
  }
}

module.exports = { ConflictRepository, ScheduleRepository, VenueRepository, CourseRepository };
