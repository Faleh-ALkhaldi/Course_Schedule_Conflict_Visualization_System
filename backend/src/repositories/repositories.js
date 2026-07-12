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
    // NEW-FU-561 (audit P3): without a transaction client the old fallback ran DELETE then
    // INSERT as two separate AUTOCOMMIT statements — a crash between them left the conflicts
    // table wiped. Acquire our own client and wrap the whole op in ONE transaction so the
    // no-client path is atomic too. (All current callers pass a client; this hardens the
    // otherwise-latent path.)
    if (!client) {
      const own = await getClient();
      try {
        await own.query('BEGIN');
        const out = await this.replaceAll(scheduleId, conflicts, own);
        await own.query('COMMIT');
        return out;
      } catch (err) {
        await own.query('ROLLBACK').catch(() => {});
        try { own.release(err); } catch { /* ignore */ }
        throw err;
      } finally {
        try { own.release(); } catch { /* already released via catch path */ }
      }
    }
    const db = client;

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
         -- Term-scoped: venues ASSIGNED to a section in this term, OR OWNED by
         -- this term (owner_semester) even if not yet assigned — so a just-created
         -- venue stays visible in its term before any section references it.
         -- NEW-FU-593 (Batch 26): ALSO include GLOBAL/shared venues (owner_semester
         -- IS NULL). Rooms are shared infrastructure assignable in EVERY term — the
         -- seed venues are all global. Without this, the picker only listed venues
         -- already USED in the term, so a shared room (or a venue that ended up global)
         -- was un-selectable until it had a section — and a fresh term showed almost no
         -- venues. This matches findAssignable (the pool Suggest/Quick-Fix already use),
         -- so humans can pick exactly what the auto-resolvers can.
         -- NEW-FU-645 (per-term isolation): templates (owner_semester IS NULL) are NO LONGER
         -- included — each term has its own private venue copies (mig 023), so a term's list is
         -- ONLY its own venues. (The FU-593 global-NULL fallback was the cross-term bleed-through.)
         -- NEW-FU-666: the term's OWN venues only. The old "assigned to a section OR owned
         -- by the term" pair listed a venue TWICE whenever a section still pointed at a stale
         -- TEMPLATE row (owner NULL) while the term also owned a private copy of that same
         -- name — the exact duplicate the export picker showed. Post-FU-645 every section
         -- references a term-owned copy, so the section branch is redundant; scoping strictly
         -- to owner_semester guarantees each term shows exactly its own entities, once each.
         WHERE v.owner_semester = $1
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

  /**
   * NEW-FU-520 (Batch 6): the ASSIGNABLE venue pool for a term — see
   * InstructorRepository.findAssignable for the full rationale. A venue is
   * assignable to a section in `termCode` iff it is GLOBAL/legacy shared infra
   * (owner_semester IS NULL) OR OWNED by this term. Never another term's private
   * venue — which is exactly how `01-0001` (owned by 271) leaked into 261.
   */
  async findAssignable(termCode = null) {
    if (!termCode) return this.findAll();
    const res = await query(
      `SELECT id, name, type, capacity, is_dummy, created_at
       FROM venues
       WHERE is_dummy = false
         AND owner_semester = $1   -- NEW-FU-645: per-term only; templates (NULL) are not assignable
       ORDER BY (SUBSTRING(name FROM '^[0-9]+'))::int NULLS LAST,
                (SUBSTRING(name FROM '^[0-9]+-([0-9]+)'))::int NULLS LAST, name`,
      [termCode]
    );
    return res.rows;
  }

  async findById(id) {
    const res = await query(
      `SELECT id, name, type, capacity FROM venues WHERE id = $1`, [id]
    );
    return res.rows[0] ?? null;
  }

  async create({ name, type, capacity, ownerSemester = null }) {
    // ownerSemester stamps the row as owned by the creating term (see findAll).
    const res = await query(
      `INSERT INTO venues (name, type, capacity, owner_semester) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, type, parseInt(capacity, 10) /* NEW-L2 */, ownerSemester]
    );
    return this.findById(res.rows[0].id);
  }

  async update(id, { name, type, capacity }) {
    // NEW-FU-619 (audit P3): COALESCE so a PARTIAL update (e.g. just {capacity}) preserves the
    // other columns instead of NULLing them — name/type/capacity are all NOT NULL, so the old
    // direct overwrite made a partial PUT 400 (NULL violation) and `parseInt(undefined)→NaN` was
    // rejected by pg on the int column. Guard parseInt so an unsent capacity stays NULL→kept.
    // Mirrors the courseRepo.update fix.
    await query(
      `UPDATE venues SET name=COALESCE($2,name), type=COALESCE($3,type),
       capacity=COALESCE($4,capacity), updated_at=NOW() WHERE id=$1`,
      [id, name ?? null, type ?? null, capacity == null ? null : parseInt(capacity, 10)]
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
      // NEW-FU-650 (per-term isolation): a course is "in this term" when the term OWNS it
      // (owner_semester = term) — which now includes a just-created course that has NO sections
      // yet (e.g. SWE 485, added but not yet placed). The OR-clause also keeps any course that
      // has a section in the term (belt-and-suspenders; post-isolation every sectioned course is
      // already owner=term). This is the list the SidePanel COURSES tab AND the Suggest panel
      // show — exactly the term's own courses, never a template or another term's private course.
      const res = await query(
        `SELECT DISTINCT c.id, c.course_code, c.name, c.credits, c.academic_level,
                         c.category, c.num_sections, c.has_lab, c.is_capstone, c.is_external, c.is_thesis, c.is_research, c.is_seminar, c.owner_semester
         FROM courses c
         WHERE c.owner_semester = $1
            OR c.id IN (SELECT s.course_id FROM sections s
                        JOIN schedules sc ON sc.id = s.schedule_id
                        WHERE sc.semester = $1)
         ORDER BY c.academic_level, c.course_code`,
        [termCode]
      );
      return res.rows;
    }
    // NEW-FU-645 (per-term isolation): the no-term "catalog" read returns only the TEMPLATE
    // library (owner_semester IS NULL) — the program catalog to browse/copy from — NOT every
    // term's private copy. (Per-term lists come from the `termCode` branch above, which returns
    // the courses referenced by that term's sections = its own private copies.)
    const res = await query(
      `SELECT id, course_code, name, credits, academic_level, category, num_sections, has_lab, is_capstone, is_external, is_thesis, is_research, is_seminar, owner_semester
       FROM courses WHERE owner_semester IS NULL ORDER BY academic_level, course_code`
    );
    return res.rows;
  }

  async findById(id) {
    const res = await query(
      `SELECT id, course_code, name, credits, academic_level, category, num_sections, has_lab,
              is_capstone, is_external, is_thesis, is_research, is_seminar, owner_semester
       FROM courses WHERE id = $1`, [id]
    );
    return res.rows[0] ?? null;
  }

  // NEW-FU-278 (Phase 54): create() now accepts isCapstone + isExternal so
  // admins can mark new courses at creation time. Both default to FALSE.
  // NEW-FU-687/688: + isThesis + isResearch flags, also defaulting FALSE.
  async create({ courseCode, name, credits, academicLevel, category, numSections, hasLab,
                 isCapstone, isExternal, isThesis, isResearch, isSeminar, ownerSemester = null }) {
    // NEW-FU-645 (per-term isolation): stamp owner_semester so a course created in a term is that
    // term's PRIVATE copy (uniqueness is per-term now), never a global/shared row. Parity with
    // instructor/venue create. ownerSemester comes from the active term (controller).
    const res = await query(
      `INSERT INTO courses (course_code, name, credits, academic_level, category, num_sections, has_lab,
                            is_capstone, is_external, is_thesis, is_research, is_seminar, owner_semester)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [courseCode, name, parseInt(credits, 10) /* NEW-L2 */, academicLevel, category,
       parseInt(numSections, 10) || 1 /* NEW-L2 */,
       Boolean(hasLab) /* NEW-FU-94 */,
       Boolean(isCapstone), Boolean(isExternal), Boolean(isThesis), Boolean(isResearch) /* NEW-FU-688 */,
       Boolean(isSeminar), ownerSemester]
    );
    return this.findById(res.rows[0].id);
  }

  async update(id, { courseCode, name, credits, academicLevel, category, numSections, hasLab }) {
    // NEW-FU-94 + credit-audit follow-up: this is a PARTIAL update — the controller
    // (updateCourse) passes `undefined` for every field the client didn't send. So
    // each column must be COALESCE($n, col) to keep its current value instead of being
    // overwritten with NULL. has_lab already did this via a conditional clause (it only
    // appears in the SET list when provided); the remaining columns now match via COALESCE.
    // Without this, a partial PUT (e.g. {credits} only) sent NULL for course_code/name/
    // academic_level/category — failing on the NOT NULL + UNIQUE course_code (409) or
    // silently corrupting the row.
    //
    // Guard the integer parses: parseInt(undefined,10) is NaN, which pg rejects for an
    // integer column. Map "not provided" (null/undefined) to NULL so COALESCE preserves
    // credits / num_sections. (The old `parseInt(numSections,10) || 1` also silently reset
    // an unsent num_sections to 1.)
    const creditsVal     = credits     == null ? null : parseInt(credits, 10);
    const numSectionsVal = numSections == null ? null : parseInt(numSections, 10);
    const hasLabClause   = hasLab === undefined ? '' : ', has_lab=$8';
    const params = [
      id,                    // $1
      courseCode    ?? null, // $2
      name          ?? null, // $3
      creditsVal,            // $4
      academicLevel ?? null, // $5
      category      ?? null, // $6
      numSectionsVal,        // $7
    ];
    if (hasLab !== undefined) params.push(Boolean(hasLab));
    await query(
      `UPDATE courses SET
         course_code    = COALESCE($2, course_code),
         name           = COALESCE($3, name),
         credits        = COALESCE($4, credits),
         academic_level = COALESCE($5, academic_level),
         category       = COALESCE($6, category),
         num_sections   = COALESCE($7, num_sections),
         updated_at     = NOW()${hasLabClause}
       WHERE id=$1`,
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
        SELECT id, status, archived_at FROM schedules
        WHERE id IN (SELECT schedule_id FROM sections WHERE course_id = $1)
        FOR UPDATE
      `, [id]);
      // NEW-FU-562 (audit-2 P1-5/P1-7): refuse if any affected schedule is Finalized OR
      // ARCHIVED. This guard checked only Finalized, so deleting a course silently wiped
      // sections from an ARCHIVED (immutable) term — data loss on a protected term.
      // Mirrors deleteInstructor/deleteVenue. (conflicts.section_*_id is ON DELETE CASCADE,
      // so the editable-schedule case stays conflict-consistent automatically.)
      const lockedHit = lockedSchedules.rows.find(
        r => r.status === SCHEDULE_STATUS.FINALIZED || r.archived_at !== null);
      if (lockedHit) {
        await client.query('ROLLBACK').catch(() => {});
        const err = new Error('Cannot delete: course is referenced by a finalized or archived schedule.');
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
