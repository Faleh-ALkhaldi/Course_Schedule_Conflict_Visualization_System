const { query, getClient } = require('../config/db');
const Conflict  = require('../domain/Conflict');

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
    await db.query(`DELETE FROM conflicts WHERE schedule_id = $1`, [scheduleId]);
    for (const c of conflicts) {
      const res = await db.query(`
        INSERT INTO conflicts
          (schedule_id, rule_id, severity, description, section_a_id, section_b_id, confirmed)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
      `, [c.scheduleId, c.ruleId, c.severity, c.description,
          c.sectionAId, c.sectionBId ?? null, c.confirmed ?? false]);
      c.id = res.rows[0].id;
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
    const res = await query(
      `SELECT id, department_id, semester, status, created_at, updated_at
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
  async findAll() {
    const res = await query(
      `SELECT id, name, type, capacity, created_at FROM venues ORDER BY name`
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
      [name, type, parseInt(capacity)]
    );
    return this.findById(res.rows[0].id);
  }

  async update(id, { name, type, capacity }) {
    await query(
      `UPDATE venues SET name=$2, type=$3, capacity=$4, updated_at=NOW() WHERE id=$1`,
      [id, name, type, parseInt(capacity)]
    );
    return this.findById(id);
  }

  async delete(id) {
    await query(`DELETE FROM venues WHERE id = $1`, [id]);
  }
}

// ── CourseRepository ──────────────────────────────────────────────────────────
class CourseRepository {
  async findAll() {
    const res = await query(
      `SELECT id, course_code, name, credits, academic_level, category, num_sections
       FROM courses ORDER BY academic_level, course_code`
    );
    return res.rows;
  }

  async findById(id) {
    const res = await query(
      `SELECT id, course_code, name, credits, academic_level, category, num_sections
       FROM courses WHERE id = $1`, [id]
    );
    return res.rows[0] ?? null;
  }

  async create({ courseCode, name, credits, academicLevel, category, numSections }) {
    const res = await query(
      `INSERT INTO courses (course_code, name, credits, academic_level, category, num_sections)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [courseCode, name, parseInt(credits), academicLevel, category, parseInt(numSections) || 1]
    );
    return this.findById(res.rows[0].id);
  }

  async update(id, { courseCode, name, credits, academicLevel, category, numSections }) {
    await query(
      `UPDATE courses SET course_code=$2, name=$3, credits=$4,
       academic_level=$5, category=$6, num_sections=$7, updated_at=NOW() WHERE id=$1`,
      [id, courseCode, name, parseInt(credits), academicLevel, category, parseInt(numSections) || 1]
    );
    return this.findById(id);
  }

  async delete(id) {
    // Delete all sections for this course first (FK constraint)
    await query(`DELETE FROM sections WHERE course_id = $1`, [id]);
    await query(`DELETE FROM courses  WHERE id = $1`, [id]);
  }
}

module.exports = { ConflictRepository, ScheduleRepository, VenueRepository, CourseRepository };
