/**
 * SuggestService — assign time slots AND instructors to minimize conflicts.
 *
 * Constraints:
 *   - Max 4 courses in the same time slot (5 acceptable, 6+ rejected)
 *   - Instructor must be free at the assigned time (no double booking)
 *   - Instructor must not have office hours at the assigned time
 *   - GR courses: 17:00–21:00 only
 *   - UG courses: 07:00–17:00 only
 *
 * Algorithm: greedy + instructor assignment
 *   1. Delete all existing sections
 *   2. Build task list (one per section group)
 *   3. Sort by most constrained
 *   4. For each task: score each (slot × instructor) combination
 *   5. Pick best combo, write to DB
 */
const { query }            = require('../config/db');
const ConflictEngine       = require('../engine/ConflictEngine');
const SectionRepository    = require('../repositories/SectionRepository');
const InstructorRepository = require('../repositories/InstructorRepository');
const Section              = require('../domain/Section');

const engine      = new ConflictEngine();
const sectionRepo = new SectionRepository();
const instrRepo   = new InstructorRepository();

const STT_DAYS = ['Sunday','Tuesday','Thursday'];
const MW_DAYS  = ['Monday','Wednesday'];
const DURATION  = { STT: 50, MW: 75 };
const MAX_PARALLEL_HARD = 4; // 5+ not allowed (hard reject); 4 = max ideal

function fromMin(m) {
  return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
}
function toMin(t) {
  if (!t) return 0;
  const [h,m] = t.substring(0,5).split(':').map(Number);
  return h*60+m;
}
function timesOverlap(s1, e1, s2, e2) {
  return toMin(s1) < toMin(e2) && toMin(s2) < toMin(e1);
}

function generateSlots(pattern, category) {
  const days  = pattern === 'STT' ? STT_DAYS : MW_DAYS;
  const dur   = DURATION[pattern];
  const startH = category === 'GR' ? 17 : 7;
  const endH   = category === 'GR' ? 21 : 17;
  const slots  = [];
  for (let start = startH*60; start + dur <= endH*60; start += 30) {
    slots.push({ days, startTime: fromMin(start), endTime: fromMin(start+dur) });
  }
  return slots;
}

/** Count how many distinct courses are already placed in the same time window on the same days */
function countParallelCourses(slot, working) {
  const courseIds = new Set();
  for (const sec of working) {
    if (!slot.days.includes(sec.day)) continue;
    if (timesOverlap(slot.startTime, slot.endTime, sec.startTime, sec.endTime)) {
      courseIds.add(sec.courseId);
    }
  }
  return courseIds.size;
}

/** Check if instructor is free at the given slot (no sections, no office hours) */
function instructorIsFree(instructor, slot, working, ohMap) {
  if (!instructor) return true;

  // Check existing sections
  for (const sec of working) {
    if (sec.instructorId !== instructor.id) continue;
    if (!slot.days.includes(sec.day)) continue;
    if (timesOverlap(slot.startTime, slot.endTime, sec.startTime, sec.endTime)) return false;
  }

  // Check office hours
  const ohs = ohMap.get(instructor.id) ?? [];
  for (const oh of ohs) {
    if (!slot.days.includes(oh.day)) continue;
    const ohStart = oh.start_time ?? oh.startTime;
    const ohEnd   = oh.end_time   ?? oh.endTime;
    if (timesOverlap(slot.startTime, slot.endTime, ohStart, ohEnd)) return false;
  }

  return true;
}

function makeVirtualRows(task, slot, scheduleId, instructorId) {
  return slot.days.map(day => new Section({
    id:            `v-${task.courseId}-${task.sectionNumber}-${day}`,
    scheduleId,
    courseId:      task.courseId,
    instructorId:  instructorId ?? null,
    venueId:       null,
    sectionNumber: task.sectionNumber,
    day,
    startTime:     slot.startTime,
    endTime:       slot.endTime,
    courseCode:    task.courseCode,
    academicLevel: task.academicLevel,
    category:      task.category,
    numSections:   task.totalSections,
  }));
}

/** Count how many sections of the SAME course are already at this slot */
function countSameCourseAtSlot(task, slot, working) {
  let count = 0;
  for (const sec of working) {
    if (sec.courseId !== task.courseId) continue;
    if (!slot.days.includes(sec.day)) continue;
    if (timesOverlap(slot.startTime, slot.endTime, sec.startTime, sec.endTime)) count++;
  }
  return count; // number of sibling sections already placed here
}

/** Score a (slot, instructor) combination */
function scoreCombo(task, slot, instructorId, working, ohMap) {
  const parallel       = countParallelCourses(slot, working);
  const sameCourseHere = countSameCourseAtSlot(task, slot, working);

  // Hard reject: already 4+ distinct courses in same slot (would make 5th)
  if (parallel >= MAX_PARALLEL_HARD) return null;

  // Hard reject: already 2 sections of the same course at this time
  // (max 2 sections of the same course per time slot — spread them out)
  if (sameCourseHere >= 2) return null;

  const virtualRows = makeVirtualRows(task, slot, task.scheduleId, instructorId);
  let hard = 0, soft = 0;

  for (const row of virtualRows) {
    const others = working.filter(s =>
      !(s.courseId === row.courseId && s.sectionNumber === row.sectionNumber)
    );
    const oh     = ohMap.get(row.instructorId) ?? [];
    const result = engine.evaluate(row, others, oh);
    hard += result.hardConflicts?.length ?? 0;
    soft += result.softConflicts?.length ?? 0;
  }

  // Soft penalty: 3 parallel courses (close to max)
  if (parallel >= MAX_PARALLEL_HARD - 1) soft += 1;

  // Soft penalty: 1 sibling section already at this time (prefer 0)
  if (sameCourseHere === 1) soft += 2;

  return { hard, soft, parallel, sameCourseHere };
}

class SuggestService {
  async suggest(scheduleId, courseConfigs) {
    // ── Step 1: delete all existing sections ──────────────────────────────
    await query(`DELETE FROM sections WHERE schedule_id = $1`, [scheduleId]);

    // ── Step 2: load course info ────────────────────────────────────────
    const courseRows = await query(
      `SELECT id, course_code, academic_level, category FROM courses WHERE id = ANY($1)`,
      [courseConfigs.map(c => c.courseId)]
    );
    const courseInfo = {};
    for (const r of courseRows.rows) {
      courseInfo[r.id] = {
        courseId:      r.id,
        scheduleId,
        courseCode:    r.course_code,
        academicLevel: r.academic_level,
        category:      r.category,
      };
    }

    // ── Step 3: load instructors and office hours ───────────────────────
    const instructors = await instrRepo.findAll();
    const instrIds    = instructors.map(i => i.id);
    const ohMap       = await instrRepo.getOfficeHoursMap(instrIds);

    // ── Step 4: build task list ─────────────────────────────────────────
    const tasks = [];
    for (const cfg of courseConfigs) {
      const info = courseInfo[cfg.courseId];
      if (!info) continue;
      const slots = generateSlots(cfg.pattern, info.category);
      for (let sec = 1; sec <= cfg.sections; sec++) {
        tasks.push({
          ...info,
          sectionNumber:  String(sec),
          totalSections:  cfg.sections,
          pattern:        cfg.pattern,
          slots,
        });
      }
    }

    // Sort: fewest slots first (most constrained)
    tasks.sort((a,b) => a.slots.length - b.slots.length);

    // ── Step 5: greedy assignment ──────────────────────────────────────
    const working      = [];
    const assignments  = [];
    // Track how many section-groups each instructor is assigned to
    const instrLoad    = new Map(instructors.map(i => [i.id, 0]));
    // Track which instructor is already assigned to each course (for consistency)
    const courseInstructor = new Map(); // courseId → instructor (for same-course preference)

    for (const task of tasks) {
      let bestSlot       = null;
      let bestInstructor = null;
      let bestScore      = { hard: Infinity, soft: Infinity, parallel: Infinity, load: Infinity };

      // Preferred instructor for this course (if already assigned to another section)
      const preferredInstr = courseInstructor.get(task.courseId) ?? null;

      // Min load among available instructors — used to penalize overloading
      const minLoad = Math.min(...Array.from(instrLoad.values()), 0);

      for (const slot of task.slots) {
        // Build candidate list: prefer preferred instructor, then sort by load (least loaded first)
        const freeInstrs = instructors
          .filter(i => instructorIsFree(i, slot, working, ohMap))
          .sort((a, b) => {
            // Preferred instructor for this course goes first
            if (a.id === preferredInstr?.id) return -1;
            if (b.id === preferredInstr?.id) return  1;
            // Then sort by load ascending
            return (instrLoad.get(a.id) ?? 0) - (instrLoad.get(b.id) ?? 0);
          });

        // Try: preferred first, then least-loaded, then no instructor
        const candidateInstrs = [...freeInstrs, null];

        for (const instr of candidateInstrs) {
          const score = scoreCombo(task, slot, instr?.id ?? null, working, ohMap);
          if (!score) continue;

          // Load penalty: how much above the minimum this instructor is
          const load = instr
            ? (instrLoad.get(instr.id) ?? 0) - minLoad
            : 999; // no instructor = worst case

          // Is this the preferred instructor for the same course?
          const isSameCourseInstr = instr && preferredInstr && instr.id === preferredInstr.id;
          // Bonus: slightly prefer same-course instructor (reduce soft by 1 virtually)
          const effectiveSoft = isSameCourseInstr ? Math.max(0, score.soft - 1) : score.soft;

          const curLoad = bestInstructor ? (instrLoad.get(bestInstructor.id) ?? 0) - minLoad : 999;

          // Ranking: hard → soft → parallel → load → has instructor
          const better =
            score.hard < bestScore.hard ||
            (score.hard === bestScore.hard && effectiveSoft < bestScore.soft) ||
            (score.hard === bestScore.hard && effectiveSoft === bestScore.soft &&
             score.parallel < bestScore.parallel) ||
            (score.hard === bestScore.hard && effectiveSoft === bestScore.soft &&
             score.parallel === bestScore.parallel && load < curLoad) ||
            (score.hard === bestScore.hard && effectiveSoft === bestScore.soft &&
             score.parallel === bestScore.parallel && load === curLoad && instr && !bestInstructor);

          if (better) {
            bestScore      = { ...score, soft: effectiveSoft, load };
            bestSlot       = slot;
            bestInstructor = instr ?? null;
          }

          if (bestScore.hard === 0 && bestScore.soft === 0 && bestInstructor) break;
        }
        if (bestScore.hard === 0 && bestScore.soft === 0 && bestInstructor) break;
      }

      if (!bestSlot) bestSlot = task.slots[0];

      assignments.push({ task, slot: bestSlot, instructor: bestInstructor });

      // Update load and course-instructor mapping
      if (bestInstructor) {
        instrLoad.set(bestInstructor.id, (instrLoad.get(bestInstructor.id) ?? 0) + 1);
        // Record first instructor assigned to this course (for same-course preference)
        if (!courseInstructor.has(task.courseId)) {
          courseInstructor.set(task.courseId, bestInstructor);
        }
      }

      // Add to working set
      const placed = makeVirtualRows(task, bestSlot, scheduleId, bestInstructor?.id ?? null);
      working.push(...placed);
    }

    // ── Step 6: write to database ─────────────────────────────────────
    for (const { task, slot, instructor } of assignments) {
      for (const day of slot.days) {
        await query(`
          INSERT INTO sections
            (schedule_id, course_id, instructor_id, venue_id,
             section_number, day, start_time, end_time)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [
          scheduleId, task.courseId,
          instructor?.id ?? null,
          null,
          task.sectionNumber, day, slot.startTime, slot.endTime,
        ]);
      }
    }

    // ── Step 7: revalidate ────────────────────────────────────────────
    const ScheduleService = require('./ScheduleService');
    return ScheduleService.revalidateSchedule(scheduleId);
  }
}

module.exports = new SuggestService();
