const { query, getClient } = require('../config/db');
const Section = require('../domain/Section');

const SELECT_SECTION = `
  SELECT
    s.id, s.schedule_id, s.course_id, s.instructor_id, s.venue_id,
    s.section_number, s.day, s.start_time::text, s.end_time::text,
    s.created_at, s.updated_at,
    c.course_code, c.name  AS course_name,
    c.academic_level, c.category, c.num_sections,
    i.name AS instructor_name,
    v.name AS venue_name
  FROM sections s
  JOIN    courses     c ON c.id = s.course_id
  LEFT JOIN instructors i ON i.id = s.instructor_id
  LEFT JOIN venues      v ON v.id = s.venue_id
`;

function toSection(row) {
  return new Section({
    id: row.id, scheduleId: row.schedule_id,
    courseId: row.course_id, instructorId: row.instructor_id, venueId: row.venue_id,
    sectionNumber: row.section_number, day: row.day,
    startTime: row.start_time, endTime: row.end_time,
    courseCode: row.course_code, courseName: row.course_name,
    academicLevel: row.academic_level, category: row.category,
    numSections: row.num_sections, instructorName: row.instructor_name,
    venueName: row.venue_name, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

class SectionRepository {
  async findBySchedule(scheduleId) {
    const res = await query(`${SELECT_SECTION} WHERE s.schedule_id = $1`, [scheduleId]);
    return res.rows.map(toSection);
  }
  async findById(id) {
    const res = await query(`${SELECT_SECTION} WHERE s.id = $1`, [id]);
    return res.rows[0] ? toSection(res.rows[0]) : null;
  }
  async findByInstructor(scheduleId, instructorId) {
    const res = await query(`${SELECT_SECTION} WHERE s.schedule_id=$1 AND s.instructor_id=$2`, [scheduleId, instructorId]);
    return res.rows.map(toSection);
  }
  async findByVenue(scheduleId, venueId) {
    const res = await query(`${SELECT_SECTION} WHERE s.schedule_id=$1 AND s.venue_id=$2`, [scheduleId, venueId]);
    return res.rows.map(toSection);
  }
  async create({ scheduleId, courseId, instructorId, venueId, sectionNumber, day, startTime, endTime }) {
    const res = await query(`
      INSERT INTO sections (schedule_id,course_id,instructor_id,venue_id,section_number,day,start_time,end_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [scheduleId, courseId, instructorId??null, venueId??null, sectionNumber, day, startTime, endTime]);
    return this.findById(res.rows[0].id);
  }
  async update(id, { instructorId, venueId, day, startTime, endTime }) {
    await query(`
      UPDATE sections SET instructor_id=$2, venue_id=$3, day=$4, start_time=$5, end_time=$6, updated_at=NOW()
      WHERE id=$1
    `, [id, instructorId??null, venueId??null, day, startTime, endTime]);
    return this.findById(id);
  }
  async delete(id) { await query(`DELETE FROM sections WHERE id=$1`, [id]); }

  /**
   * No instructor → SOFT warning (allowed to save with confirmation)
   * Returns { severity, message } or null if OK
   */
  validateOneInstructor(section) {
    if (!section.instructorId) {
      return {
        severity: 'Soft',
        message: `Section ${section.sectionNumber} of ${section.courseCode ?? section.courseId} has no instructor assigned. Consider assigning an instructor.`,
      };
    }
    return null;
  }
}

module.exports = SectionRepository;
