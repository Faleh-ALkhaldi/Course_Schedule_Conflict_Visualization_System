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
const { ConflictRepository, ScheduleRepository } = require('../repositories/repositories');
const { getClient, query } = require('../config/db');
const Conflict             = require('../domain/Conflict');
const ConflictResult       = require('../domain/ConflictResult');
const { SEVERITY }         = require('../config/constants');

const engine       = new ConflictEngine();
const sectionRepo  = new SectionRepository();
const instrRepo    = new InstructorRepository();
const conflictRepo = new ConflictRepository();
const schedRepo    = new ScheduleRepository();

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

/**
 * Find all sibling sections: same schedule, same courseId, same sectionNumber,
 * same dayGroup. Returns [] if single-day section.
 */
async function findSiblings(scheduleId, courseId, sectionNumber, day) {
  const group = getDayGroup(day);
  if (!group) return [];
  const groupDays = GROUP_DAYS[group];
  const res = await query(`
    SELECT id, day FROM sections
    WHERE schedule_id=$1 AND course_id=$2 AND section_number=$3
      AND day = ANY($4)
  `, [scheduleId, courseId, sectionNumber, groupDays]);
  return res.rows; // [{ id, day }]
}

class ScheduleService {

  /**
   * Move a section to a new time slot.
   * If the section is part of a Sun/Tue/Thu or Mon/Wed group,
   * all siblings are moved to the same start/end time on their respective days.
   */
  async assignSection(sectionId, updates) {
    const section = await sectionRepo.findById(sectionId);
    if (!section) throw new Error(`Section ${sectionId} not found.`);

    // Update the changed section
    await sectionRepo.update(sectionId, updates);

    // Update siblings (same time, different days in group)
    const siblings = await findSiblings(
      section.scheduleId, section.courseId, section.sectionNumber, updates.day
    );
    for (const sib of siblings) {
      if (sib.id === sectionId) continue;
      await sectionRepo.update(sib.id, {
        ...updates,
        day: sib.day, // keep each sibling on its own day
      });
    }

    return this._revalidateAndReturn(section.scheduleId);
  }

  /**
   * Update section info (instructor, venue, sectionNumber) —
   * applies to ALL sections in the same group.
   */
  async updateSectionInfo(sectionId, { instructorId, venueId, sectionNumber }) {
    const section = await sectionRepo.findById(sectionId);
    if (!section) throw new Error(`Section ${sectionId} not found.`);

    // Find all siblings (including self) in the group
    const siblings = await findSiblings(
      section.scheduleId, section.courseId,
      section.sectionNumber, section.day
    );
    const allIds = [sectionId, ...siblings.map(s=>s.id).filter(id=>id!==sectionId)];

    // Update all of them
    for (const id of allIds) {
      const cur = await sectionRepo.findById(id);
      await sectionRepo.update(id, {
        // Use explicit undefined check so passing null clears the field
        instructorId: instructorId !== undefined ? instructorId : cur.instructorId,
        venueId:      venueId      !== undefined ? venueId      : cur.venueId,
        day:          cur.day,
        startTime:    cur.startTime,
        endTime:      cur.endTime,
      });
      // Also update sectionNumber if changed
      if (sectionNumber && sectionNumber !== section.sectionNumber) {
        await query(
          `UPDATE sections SET section_number=$2, updated_at=NOW() WHERE id=$1`,
          [id, sectionNumber]
        );
      }
    }

    return this._revalidateAndReturn(section.scheduleId);
  }

  /**
   * Create a new section — and optionally create siblings for the day group.
   * The client passes { days: ['Sunday','Tuesday','Thursday'] } or a single day.
   */
  async createSection(scheduleId, data) {
    const daysToCreate = data.days ?? [data.day];
    let firstSection = null;

    for (const day of daysToCreate) {
      const sec = await sectionRepo.create({
        scheduleId,
        courseId:      data.courseId,
        instructorId:  data.instructorId ?? null,
        venueId:       data.venueId      ?? null,
        sectionNumber: data.sectionNumber,
        day,
        startTime:     data.startTime,
        endTime:       data.endTime,
      });
      if (!firstSection) firstSection = sec;
    }

    return this._revalidateAndReturn(scheduleId, firstSection);
  }

  /**
   * Delete a section and all its siblings in the group.
   */
  async deleteSection(sectionId) {
    const section = await sectionRepo.findById(sectionId);
    if (!section) throw new Error(`Section ${sectionId} not found`);
    const siblings = await findSiblings(
      section.scheduleId, section.courseId, section.sectionNumber, section.day
    );
    // Delete siblings first, then the section itself
    for (const sib of siblings) {
      if (sib.id !== sectionId) await sectionRepo.delete(sib.id);
    }
    await sectionRepo.delete(sectionId);
    await this.revalidateSchedule(section.scheduleId);
  }

  /**
   * Run full conflict evaluation on entire schedule and persist results.
   * Always runs evaluateAll — never just a partial check.
   */
  async revalidateSchedule(scheduleId) {
    const sections = await sectionRepo.findBySchedule(scheduleId);
    const instrIds = [...new Set(sections.map(s => s.instructorId).filter(Boolean))];
    const ohMap    = await instrRepo.getOfficeHoursMap(instrIds);

    // Full cross-section conflict check
    const result = engine.evaluateAll(sections, ohMap);

    // Soft warnings for sections without instructors
    // Deduplicate by courseId+sectionNumber so grouped days don't repeat
    const f09Seen = new Set();
    for (const sec of sections) {
      const check = sectionRepo.validateOneInstructor(sec);
      if (check) {
        const f09Key = `${sec.courseId}|${sec.sectionNumber}`;
        if (f09Seen.has(f09Key)) continue;
        f09Seen.add(f09Key);
        result.add(new Conflict({
          id: null, scheduleId,
          ruleId: 'R-09', severity: check.severity,
          description: check.message,
          sectionAId: sec.id, sectionBId: null,
        }));
      }
    }

    // Persist (replace) conflict records
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await conflictRepo.replaceAll(scheduleId, result.conflicts, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK'); throw err;
    } finally { client.release(); }

    return result;
  }

  async _revalidateAndReturn(scheduleId, section = null) {
    const conflictResult = await this.revalidateSchedule(scheduleId);
    if (section) return { section, conflictResult };
    return conflictResult;
  }

  async saveSchedule(scheduleId, confirmSoft = false) {
    const result = await this.revalidateSchedule(scheduleId);
    if (result.hasHard) return { saved: false, conflictResult: result };
    if (result.hasSoft && !confirmSoft) return { saved: false, conflictResult: result };
    if (result.hasSoft && confirmSoft) await conflictRepo.confirmSoft(scheduleId);
    return { saved: true, conflictResult: result };
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

module.exports = new ScheduleService();
