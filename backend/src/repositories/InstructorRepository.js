const { query } = require('../config/db');

class InstructorRepository {
  /**
   * NEW-FU-274 (Phase 51 #5): optional term-scoped filter. When `termCode`
   * is supplied, only return instructors who have at least one section in
   * a schedule for that term — avoids showing 251-only instructors in a
   * 252 sidebar. Empty terms (no sections) return an empty list.
   */
  async findAll(termCode = null) {
    if (termCode) {
      // Term-scoped: instructors ASSIGNED to a section in this term, OR OWNED by
      // this term (owner_semester) even if not yet assigned — so a just-created
      // instructor stays visible in its term before any section references it.
      const res = await query(
        `SELECT DISTINCT i.id, i.name, i.email, i.is_dummy, i.created_at, i.updated_at
         FROM instructors i
         WHERE i.id IN (
                 SELECT s.instructor_id FROM sections s
                 JOIN schedules sc ON sc.id = s.schedule_id
                 WHERE sc.semester = $1
               )
            OR i.owner_semester = $1
         ORDER BY i.name`,
        [termCode]
      );
      return res.rows;
    }
    const res = await query(
      `SELECT id, name, email, is_dummy, created_at, updated_at FROM instructors WHERE is_dummy = false ORDER BY name`
    );
    return res.rows;
  }

  /**
   * NEW-FU-520 (Batch 6): the ASSIGNABLE pool for a term — what an auto-resolver
   * (Quick Fix / Suggest / inline R-04 fixes) is allowed to assign to a section
   * in `termCode`. A resource is assignable iff it is GLOBAL/legacy shared infra
   * (owner_semester IS NULL) OR OWNED by this term. A resource owned by ANOTHER
   * term is excluded — assigning it would be cross-term contamination (the
   * reported `01-0001` bug). Differs from findAll(termCode): the pool INCLUDES
   * shared global resources (so tools stay functional) but never another term's
   * private rows. With no termCode it degrades to the global non-dummy list.
   */
  async findAssignable(termCode = null) {
    if (!termCode) return this.findAll();
    const res = await query(
      `SELECT id, name, email, is_dummy, created_at, updated_at
       FROM instructors
       WHERE is_dummy = false
         AND (owner_semester IS NULL OR owner_semester = $1)
       ORDER BY name`,
      [termCode]
    );
    return res.rows;
  }

  async findById(id) {
    const res = await query(
      `SELECT id, name, email, created_at, updated_at FROM instructors WHERE id = $1`,
      [id]
    );
    return res.rows[0] ?? null;
  }

  /** Load office hours for a single instructor (used by R-04 rule). */
  async getOfficeHours(instructorId) {
    const res = await query(
      `SELECT id, day, start_time::text AS start_time, end_time::text AS end_time
       FROM office_hours WHERE instructor_id = $1 ORDER BY day, start_time`,
      [instructorId]
    );
    return res.rows;
  }

  /**
   * Build a map of instructorId → officeHours[] for a set of instructor IDs.
   * Used by ConflictEngine.evaluateAll() to batch-load office hours.
   */
  async getOfficeHoursMap(instructorIds) {
    if (!instructorIds.length) return new Map();
    const res = await query(
      `SELECT instructor_id, day, start_time::text AS start_time, end_time::text AS end_time
       FROM office_hours WHERE instructor_id = ANY($1)`,
      [instructorIds]
    );
    const map = new Map();
    for (const row of res.rows) {
      if (!map.has(row.instructor_id)) map.set(row.instructor_id, []);
      map.get(row.instructor_id).push({
        day: row.day, startTime: row.start_time, endTime: row.end_time,
      });
    }
    return map;
  }

  async create({ name, email, ownerSemester = null }) {
    // ownerSemester stamps the row as owned by the creating term, so it stays
    // visible in that term's list even before a section references it.
    const res = await query(
      `INSERT INTO instructors (name, email, owner_semester) VALUES ($1,$2,$3) RETURNING id`,
      [name, email, ownerSemester]
    );
    return this.findById(res.rows[0].id);
  }

  async addOfficeHour(instructorId, { day, startTime, endTime }, client = null) {
    // NEW-FU-27: return the complete row so the frontend's
    // `setOhList(prev => [...prev, oh])` can render the new entry
    // immediately. Previously RETURNING only `id` produced a row that
    // rendered as just "–" until the next loadView refresh.
    // start_time / end_time are cast to text to match the shape returned
    // by getOfficeHours() (HH:MM:SS strings, not pg TIME objects).
    // NEW-FU-64: accept an optional transactional client so callers can
    // perform the write inside a SELECT … FOR UPDATE lock on the instructor
    // row, eliminating the TOCTOU window vs. the overlap pre-check.
    const db = client ?? { query: (t, p) => query(t, p) };
    const res = await db.query(
      `INSERT INTO office_hours (instructor_id, day, start_time, end_time)
       VALUES ($1,$2,$3,$4)
       RETURNING id, day, start_time::text AS start_time, end_time::text AS end_time`,
      [instructorId, day, startTime, endTime]
    );
    return res.rows[0];
  }

  async deleteOfficeHour(ohId, instructorId = null) {
    // NEW-FU-619 (audit P3): scope the delete to the owning instructor when the URL provides one,
    // so a mismatched :instructorId can't delete another instructor's office hour (and then leave
    // that real owner's schedules un-revalidated). Backward-compatible when instructorId omitted.
    if (instructorId) {
      await query(`DELETE FROM office_hours WHERE id = $1 AND instructor_id = $2`, [ohId, instructorId]);
    } else {
      await query(`DELETE FROM office_hours WHERE id = $1`, [ohId]);
    }
  }

  /**
   * NEW-FU-41: atomic single-row update for an office hour. Replaces the
   * frontend's previous "create new + delete old" pattern, which left a
   * duplicate row in the DB whenever the delete failed (network blip, 5xx).
   * One UPDATE keeps the same OH row id, so any joined data referencing it
   * stays consistent — and conflict revalidation sees exactly one row.
   *
   * Returns the updated row in the same shape as addOfficeHour() so the
   * frontend can splice it into its local OH list without reshaping. Null
   * when no row matched (404 territory for the caller).
   */
  async updateOfficeHour(ohId, { day, startTime, endTime }, client = null, instructorId = null) {
    // NEW-FU-64: accept transactional client for callers performing the
    // update inside an instructor-row lock (closes the TOCTOU window).
    // NEW-FU-624 (audit #2): scope the update to the owning instructor when the URL
    // provides one — the exact sibling of the FU-619 deleteOfficeHour fix, which was
    // applied to delete but missed on update. Without it a mismatched
    // PUT /instructors/A/office-hours/{ohId-of-B} rewrote instructor B's office hour
    // (the overlap pre-check ran against A, and A's — not B's — schedules were revalidated).
    const db = client ?? { query: (t, p) => query(t, p) };
    const res = await db.query(
      `UPDATE office_hours
       SET day = $2, start_time = $3, end_time = $4
       WHERE id = $1 AND ($5::uuid IS NULL OR instructor_id = $5)
       RETURNING id, day, start_time::text AS start_time, end_time::text AS end_time`,
      [ohId, day, startTime, endTime, instructorId]
    );
    return res.rows[0] ?? null;
  }
}

module.exports = InstructorRepository;
