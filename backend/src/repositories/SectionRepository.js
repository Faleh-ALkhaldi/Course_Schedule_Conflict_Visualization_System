const { query } = require('../config/db');
const Section = require('../domain/Section');
// NEW-FU-23: dropped the unused `getClient` import that came in with the
// now-removed transactional write methods (create/update/delete). The
// repository is read-only after the FU-14 refactor; every section write
// goes through client.query() inside transactions in ScheduleService.

// NEW-FU-93 + NEW-FU-94: pull section_type, venue type, and course has_lab
// into the projection so R-11 / R-12 evaluations have everything they need
// without an extra round-trip, and the frontend can render Lec/Lab badges.
const SELECT_SECTION = `
  SELECT
    s.id, s.schedule_id, s.course_id, s.instructor_id, s.venue_id,
    s.section_number, s.day, s.start_time::text, s.end_time::text,
    s.section_type, s.gender,
    s.created_at, s.updated_at,
    c.course_code, c.name  AS course_name,
    c.academic_level, c.category, c.num_sections, c.has_lab, c.is_capstone, c.is_external, c.is_thesis, c.is_research, c.is_seminar,
    c.credits,
    i.name AS instructor_name,
    v.name AS venue_name, v.type AS venue_type
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
    // NEW-FU-657: credits now round-trip through the export tables — populate
    // them here (the conflict engine uses ScheduleService's own loader, so this
    // additive column doesn't change any conflict evaluation).
    credits: row.credits,
    numSections: row.num_sections, instructorName: row.instructor_name,
    venueName: row.venue_name,
    // NEW-FU-93/94: joined metadata for R-11/R-12 + frontend rendering
    sectionType: row.section_type,
    venueType: row.venue_type,
    hasLab: row.has_lab,
    // NEW-FU-272 (Phase 50 #1): so the conflict engine can skip venue
    // rules for capstone-style courses.
    isCapstone: row.is_capstone,
    // NEW-FU-272 (Phase 50 #3): KFUPM co-schedules M+F siblings — R-04
    // and R-05 use gender to recognize the pair as a single class.
    gender: row.gender,
    // NEW-FU-275 (Phase 52 #5): external = student is off-campus on an
    // internship; the conflict engine skips every rule for these.
    isExternal: row.is_external,
    // NEW-FU-687 (Phase 125): thesis = independent research; same full exemption.
    isThesis: row.is_thesis,
    // NEW-FU-688 (Phase 126): research = the Thesis sibling; same full exemption.
    isResearch: row.is_research,
    isSeminar: row.is_seminar,
    createdAt: row.created_at, updatedAt: row.updated_at,
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

  // NEW-FU-682: the scoped section set INCLUDING the COMPLEMENTARY half of each has_lab course (the
  // Lab when this scope has the Lecture, or vice versa) — every section of the scope's own has_lab
  // courses, even those taught by someone else / held elsewhere — so a scoped re-import rebuilds the
  // COMPLETE lecture+lab course (no missing-section / coverage conflict). Each complement section is
  // flagged `isComplement` (NOT taught by this instructor / not held in this venue) so the renderers
  // can mark it and the user can tell it apart. Full scope already has every section.
  async findScopedWithComplement(scheduleId, filter = { type: 'full' }) {
    // The complement is the MISSING TYPE only (the Lab when the scope holds the Lecture, or vice versa):
    // a section of one of the scope's has_lab courses whose section_type the scope does NOT itself
    // provide for that course — kept in sync with exportScope.complementSub.
    const complement = (col) =>
      `(s.course_id IN (SELECT s2.course_id FROM sections s2 JOIN courses c2 ON c2.id = s2.course_id
                         WHERE s2.schedule_id = $1 AND s2.${col} = $2 AND c2.has_lab = true)
        AND s.section_type NOT IN (SELECT s3.section_type FROM sections s3
                                    WHERE s3.schedule_id = $1 AND s3.${col} = $2 AND s3.course_id = s.course_id))`;
    let col = null;
    if (filter?.type === 'instructor' && filter.id) col = 'instructor_id';
    else if (filter?.type === 'venue' && filter.id) col = 'venue_id';
    if (!col) return this.findBySchedule(scheduleId);
    const res = await query(
      `${SELECT_SECTION} WHERE s.schedule_id = $1 AND (s.${col} = $2 OR ${complement(col)})`,
      [scheduleId, filter.id]);
    return res.rows.map((r) => { const s = toSection(r); s.isComplement = r[col] !== filter.id; return s; });
  }

  // NEW-FU-23: create/update/delete were removed. All section writes go
  // through client.query() inside transactions in ScheduleService — those
  // paths hold the schedule row lock and respect the finalize-immutability
  // contract. Keeping unlocked write methods here was a trap: a future
  // caller could use them and silently bypass the finalize lock. The
  // grep before this edit confirmed zero callers.

  /**
   * NEW-FU-95 + NEW-FU-110: find the next unused two-digit section number
   * for a course within a schedule, scoped to a section type.
   *
   *   sectionType='Lec' → searches 01..49 (Lec range, FU-106)
   *   sectionType='Lab' → searches 50..99 (Lab range, FU-106)
   *
   * Returns the lowest unused value in the type-scoped range, or null when
   * the entire range is exhausted (pathological — 49 sections of one type
   * per course).
   *
   * The "taken" set is built from ALL section_numbers of the course
   * regardless of type, because the type-scoped ranges are disjoint so a
   * Lec section can never clash with a Lab section anyway — but if a future
   * change ever loosens the ranges, this query still produces correct
   * results.
   */
  async getNextSectionNumber(scheduleId, courseId, sectionType = 'Lec') {
    const res = await query(
      `SELECT DISTINCT section_number
       FROM sections
       WHERE schedule_id = $1 AND course_id = $2`,
      [scheduleId, courseId]
    );
    const taken = new Set(res.rows.map(r => r.section_number));
    const range = sectionType === 'Lab' ? { min: 50, max: 99 } : { min: 1, max: 49 };
    for (let n = range.min; n <= range.max; n++) {
      const candidate = String(n).padStart(2, '0');
      if (!taken.has(candidate)) return candidate;
    }
    return null;
  }

  /**
   * No instructor → SOFT warning (allowed to save with confirmation)
   * Returns { severity, message } or null if OK
   */
  validateOneInstructor(section) {
    // Information-only activities still need an assigned/supervising instructor;
    // only their venue and meeting time are intentionally absent.
    if (!section.instructorId) {
      return {
        severity: 'Soft',
        message: `Section ${section.sectionNumber} of ${section.courseCode ?? section.courseId} has no instructor assigned. Consider assigning an instructor.`,
      };
    }
    return null;
  }

  /**
   * NEW-FU-91: No venue → SOFT warning (R-10).
   *
   * Parallel to validateOneInstructor (R-09). The DB schema makes
   * `venue_id` nullable on purpose — some sections legitimately run in
   * regular departmental classrooms which are NOT tracked in the venues
   * table (see migration 004's scope comment: "Only shared lecture halls
   * and laboratories that require explicit scheduling. Regular
   * departmental classrooms are NOT stored here"). So a missing venue is
   * advisory, not blocking — same severity contract as the missing-
   * instructor warning. The user can save anyway via the soft-confirm
   * flow (FU-78) after acknowledging the message.
   *
   * Returns { severity, message } or null if OK.
   */
  validateOneVenue(section) {
    // NEW-FU-272 (Phase 50 #1): venue-exempt courses (capstone projects)
    // legitimately don't have a venue — instructor and team meet online
    // or wherever convenient. Suppress R-10 for those.
    if (section.isCapstone) return null;
    // NEW-FU-275 (Phase 52 #5): external courses are off-campus; no venue
    // is the correct state. Suppress R-10 in addition to the capstone path.
    // NEW-FU-687/688: thesis + research are venue-exempt too (Project already handled above).
    if (section.isExternal || section.isThesis || section.isResearch) return null;
    // NEW-FU-567 (audit-2 P2-16 follow-up): Project/Thesis sections are
    // venue-optional BY TYPE — they meet online or in whatever room the
    // instructor and students agree on (the registrar rule confirmed while
    // resolving P2-16). The capstone exemption above only covers is_capstone
    // COURSES; a Prj/Ths SECTION on a non-capstone course is still venue-optional,
    // so suppress R-10 by section_type too. (Lectures and Labs still warn.)
    if (section.sectionType === 'Prj' || section.sectionType === 'Ths') return null;
    if (!section.venueId) {
      return {
        severity: 'Soft',
        message: `Section ${section.sectionNumber} of ${section.courseCode ?? section.courseId} has no venue assigned. Consider assigning a venue.`,
      };
    }
    return null;
  }
}

module.exports = SectionRepository;
