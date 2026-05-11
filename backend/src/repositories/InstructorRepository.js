const { query } = require('../config/db');

class InstructorRepository {
  async findAll() {
    const res = await query(
      `SELECT id, name, email, created_at, updated_at FROM instructors ORDER BY name`
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

  async create({ name, email }) {
    const res = await query(
      `INSERT INTO instructors (name, email) VALUES ($1,$2) RETURNING id`,
      [name, email]
    );
    return this.findById(res.rows[0].id);
  }

  async addOfficeHour(instructorId, { day, startTime, endTime }) {
    const res = await query(
      `INSERT INTO office_hours (instructor_id, day, start_time, end_time)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [instructorId, day, startTime, endTime]
    );
    return res.rows[0];
  }

  async deleteOfficeHour(ohId) {
    await query(`DELETE FROM office_hours WHERE id = $1`, [ohId]);
  }
}

module.exports = InstructorRepository;
