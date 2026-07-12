/**
 * ScopedImportService — NEW-FU-660
 *
 * Importing an INSTRUCTOR- or VENUE-scoped file MERGES that entity into the CURRENT
 * term (it does NOT replace the term — that's ExportService.commitRows, used only for
 * whole-term files). The merge:
 *   • adds the scoped entity and its courses / venues / instructors if they aren't
 *     already in the term (term-private copies, per the FU-645 isolation model),
 *   • keeps every existing section of the current term untouched,
 *   • and, if placing the scoped sections would create a conflict, defers to the
 *     caller (the 3-option dialog) instead of silently merging.
 *
 * Three commit modes mirror the dialog (the controller passes `mode`):
 *   'entity-only'    → add ONLY the instructor (+ its office hours) / venue (+ its
 *                      capacity & type). No courses, no sections. Always conflict-free.
 *   'with-conflicts' → add the entity + its courses + venues/instructors + ALL its
 *                      sections at their original times, even where they conflict.
 *   'conflict-free'  → add the entity + its courses + venues/instructors, but RETIME
 *                      each conflicting section to a conflict-free slot in its teaching
 *                      window (nothing is ever dropped); non-conflicting ones stay put.
 *
 * With no explicit mode (the first, "preview" call) the merge runs as a clean add and
 * COMMITS when it introduces no new conflict; if it WOULD introduce one, it rolls back
 * and returns { needsDecision } so the controller can surface the 3 options.
 */
const { getClient } = require('../config/db');
const Section        = require('../domain/Section');
const ConflictEngine = require('../engine/ConflictEngine');
const { teachingWindowFor } = require('../config/constants');
const { sectionLabel } = require('../domain/sectionLabel');
// NEW-FU-660: a scoped merge carries PARTIAL course data (an instructor's Lec without
// the Lab a colleague teaches), so the whole-course completeness validator (R-15 pattern
// legality) wrongly rejects legitimate rows. We derive has_lab from whatever Lab rows the
// file carries; any residual pattern issue surfaces as a CONFLICT, not a pre-reject.
const { deriveHasLabByCourse } = require('../domain/importValidation');
const { courseNameError, courseCodeLevelError, resolveAcademicLevel } = require('../domain/courseFormat');
// NEW-FU-661: the SAME strict per-field gate the whole-term path runs (code, level↔number,
// credits, flags, gender, type/number, days, times+window, venue type, email, capacity).
const { validateImportFields } = require('../domain/importFieldValidation');
const InstructorRepository = require('../repositories/InstructorRepository');
const schedSvc = require('./ScheduleService');

const instrRepo = new InstructorRepository();
const engine = new ConflictEngine();

const SNAPSHOT_SQL = `
  SELECT s.id, s.schedule_id, s.course_id, s.instructor_id, s.venue_id,
         s.section_number, s.day, s.start_time::text, s.end_time::text,
         s.section_type, s.gender,
         c.course_code, c.name AS course_name, c.academic_level, c.category,
         c.num_sections, c.has_lab, c.credits, c.is_capstone, c.is_external,
         c.is_thesis, c.is_research, c.is_seminar,
         i.name AS instructor_name, v.name AS venue_name, v.type AS venue_type
    FROM sections s
    JOIN courses c ON c.id = s.course_id
    LEFT JOIN instructors i ON i.id = s.instructor_id
    LEFT JOIN venues v ON v.id = s.venue_id
   WHERE s.schedule_id = $1`;

const hm     = t => { const [h, m] = String(t).slice(0, 5).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fromMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function rowToSection(row) {
  return new Section({
    id: row.id, scheduleId: row.schedule_id, courseId: row.course_id,
    instructorId: row.instructor_id, venueId: row.venue_id,
    sectionNumber: row.section_number, day: row.day,
    startTime: row.start_time, endTime: row.end_time,
    courseCode: row.course_code, courseName: row.course_name,
    academicLevel: row.academic_level, category: row.category,
    numSections: row.num_sections, instructorName: row.instructor_name,
    venueName: row.venue_name, sectionType: row.section_type, venueType: row.venue_type,
    hasLab: row.has_lab, credits: row.credits, isCapstone: row.is_capstone,
    gender: row.gender, isExternal: row.is_external,
    isThesis: row.is_thesis, isResearch: row.is_research, isSeminar: row.is_seminar,
  });
}

// Load every section of the term as Section domain objects, plus the OH map the
// ConflictEngine needs (instructorId → [{day,startTime,endTime}]).
async function loadTermState(client, scheduleId) {
  const secRes = await client.query(SNAPSHOT_SQL, [scheduleId]);
  const sections = secRes.rows.map(rowToSection);
  const instrIds = [...new Set(sections.map(s => s.instructorId).filter(Boolean))];
  const ohMap = new Map();
  if (instrIds.length) {
    const ohRes = await client.query(
      `SELECT instructor_id, day, start_time::text AS start_time, end_time::text AS end_time
         FROM office_hours WHERE instructor_id = ANY($1)`, [instrIds]);
    for (const r of ohRes.rows) {
      if (!ohMap.has(r.instructor_id)) ohMap.set(r.instructor_id, []);
      ohMap.get(r.instructor_id).push({ day: r.day, startTime: r.start_time, endTime: r.end_time });
    }
  }
  return { sections, ohMap };
}

// Canonical conflict key (rule + canonical description) — stable across the section-id
// churn an insert causes, so baseline-vs-merged diffing finds the conflicts the merge ADDS.
// HARD rules only (R-01/02/04/05/06) by design — see the dialog-decision note in mergeScopedImport.
function conflictKeys(sections, ohMap) {
  return new Set(engine.evaluateAll(sections, ohMap).conflicts.map(c => `${c.ruleId}|${c.description}`));
}

// Additive entity upsert — REUSE existing term-private courses/instructors/venues by
// code/name, CREATE the missing ones (stamped owner_semester = this term). Never
// deletes. Returns lookup maps + which instructors were freshly created (so we add
// THEIR office hours only, never duplicating an existing instructor's).
async function upsertEntities(client, scheduleId, ownerSemester, rowData, refs, opts = {}) {
  const { instructorsRef = [], venuesRef = [] } = refs;
  const refEmailByInstr = new Map(instructorsRef.filter(i => i.name && i.email).map(i => [i.name.trim().toLowerCase(), i.email.trim()]));
  const refVenueByName  = new Map(venuesRef.filter(v => v.name).map(v => [v.name.trim().toLowerCase(), v]));

  // Courses ──────────────────────────────────────────────────────────────────
  const courseByCode = new Map();
  const cRes = await client.query(
    `SELECT id, course_code, name, academic_level, category, num_sections,
            has_lab, is_capstone, is_external, is_thesis, is_research, is_seminar
       FROM courses WHERE owner_semester = $1`,
    [ownerSemester]);
  for (const c of cRes.rows) courseByCode.set(c.course_code?.toLowerCase(), c);

  const hasLabByCourse = opts.skipRowEntities ? new Map() : deriveHasLabByCourse(rowData);
  const isCapstoneByCourse = new Map(), isExternalByCourse = new Map(), isThesisByCourse = new Map(), isResearchByCourse = new Map(), isSeminarByCourse = new Map();  // NEW-FU-687/688
  const sectionCountByCourse = new Map();
  for (const r of rowData) {
    const k = String(r.courseCode ?? '').toLowerCase();
    if (r.isCapstone) isCapstoneByCourse.set(k, true);
    if (r.isExternal) isExternalByCourse.set(k, true);
    if (r.isThesis)   isThesisByCourse.set(k, true);   // NEW-FU-687
    if (r.isResearch) isResearchByCourse.set(k, true); // NEW-FU-688
    if (r.isSeminar)  isSeminarByCourse.set(k, true);
    sectionCountByCourse.set(k, (sectionCountByCourse.get(k) || 0) + 1);
  }

  for (const [key, course] of courseByCode.entries()) {
    if (!sectionCountByCourse.has(key)) continue;
    const existingFlag =
      course.is_capstone ? 'Project' :
      course.is_external ? 'External' :
      course.is_thesis ? 'Thesis' :
      course.is_research ? 'Research' :
      course.is_seminar ? 'Seminar' :
      'Lecture';
    const importedFlag =
      isCapstoneByCourse.get(key) ? 'Project' :
      isExternalByCourse.get(key) ? 'External' :
      isThesisByCourse.get(key) ? 'Thesis' :
      isResearchByCourse.get(key) ? 'Research' :
      isSeminarByCourse.get(key) ? 'Seminar' :
      'Lecture';
    if (existingFlag !== importedFlag) {
      const e = new Error(`${course.course_code}: course type is fixed as ${existingFlag}; delete and recreate the course before importing it as ${importedFlag}.`);
      e.status = 400;
      throw e;
    }
  }

  if (!opts.skipRowEntities) {
    for (const row of rowData) {
      const key = row.courseCode.toLowerCase();
      if (courseByCode.has(key)) continue;
      const isGR = row.category?.toUpperCase() === 'GR';
      // NEW-FU-671 (re-audit): use the SHARED whitespace-tolerant resolver (domain/courseFormat).
      // This scoped-merge copy had MISSED FU-671's whitespace fix, so a PDF-wrapped "Sophomor e"
      // silently became "Freshman" here. One shared resolver keeps both import paths in lockstep.
      const level = resolveAcademicLevel(row.academicLevel, row.category);
      // NEW-FU-661: a 4-credit course ALWAYS has a lab (domain invariant). A partial scoped
      // file may carry only the Lec, so force has_lab=true for 4cr on creation — otherwise the
      // merge would mint an invalid 4-credit no-lab course that no later UI add-section accepts.
      const hasLab = hasLabByCourse.get(key) || Number(row.credits) === 4;
      const res = await client.query(
        `INSERT INTO courses (course_code, name, credits, academic_level, category, num_sections, has_lab, is_capstone, is_external, is_thesis, is_research, is_seminar, owner_semester)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, course_code, name, academic_level, category, num_sections,
                   has_lab, is_capstone, is_external, is_thesis, is_research, is_seminar`,
        [row.courseCode, row.courseName, row.credits, level, isGR ? 'GR' : 'UG',
         sectionCountByCourse.get(key) || 1, hasLab,
         isCapstoneByCourse.get(key) || false, isExternalByCourse.get(key) || false,
         isThesisByCourse.get(key) || false, isResearchByCourse.get(key) || false,
         isSeminarByCourse.get(key) || false, ownerSemester]);   // NEW-FU-687/688
      courseByCode.set(key, res.rows[0]);
    }

    // NEW-FU-682: a scoped MERGE often adds sections to a course that ALREADY exists in the term —
    // seeded from the template term (createTerm copies the prior term's courses) or added by an earlier
    // partial import — so the create loop above SKIPS it and its has_lab is whatever the seed/earlier
    // import left. When THIS file's rows now imply a lab (a Lab section, the "Has Laboratory" course
    // type via deriveHasLabByCourse, or a 4-credit course), the completed lecture+lab course would
    // false-fire R-15 if has_lab were stale-false (a 3-credit has_lab lecture legitimately meets only
    // 100 min, but a plain 3-credit course "needs" 150). Reconcile has_lab UP — never down (a partial
    // file that omits the lab must not strip the flag). This makes the FU-682 re-import conflict-free
    // regardless of the pre-existing course state.
    const needLab = new Set();
    for (const r of rowData) {
      const k = String(r.courseCode ?? '').toLowerCase();
      if (hasLabByCourse.get(k) || Number(r.credits) === 4) needLab.add(k);
    }
    for (const k of needLab) {
      await client.query(
        `UPDATE courses SET has_lab = true WHERE owner_semester = $1 AND LOWER(course_code) = $2 AND has_lab = false`,
        [ownerSemester, k]);
    }
  }

  // Instructors ──────────────────────────────────────────────────────────────
  const iRes = await client.query(`SELECT id, name FROM instructors WHERE owner_semester = $1`, [ownerSemester]);
  const instrByName = new Map(iRes.rows.map(i => [i.name?.toLowerCase(), i]));
  const newInstrNames = new Set();

  // Names to ensure exist: those carried in the Instructors reference (entity-only for
  // an instructor file relies on this) plus those used by the section rows.
  const wantedInstr = new Set([
    ...instructorsRef.map(i => i.name?.trim()).filter(Boolean),
    ...rowData.map(r => r.instructorName?.trim()).filter(Boolean),
  ].map(n => n.toLowerCase()));

  for (const name of wantedInstr) {
    if (instrByName.has(name)) continue;
    const display = instructorsRef.find(i => i.name?.toLowerCase() === name)?.name
      ?? rowData.find(r => r.instructorName?.toLowerCase() === name)?.instructorName ?? name;
    const slug = display.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase() || 'instructor';
    const taken = async (e) => (await client.query(
      `SELECT 1 FROM instructors WHERE email = $1 AND owner_semester = $2`, [e, ownerSemester])).rowCount > 0;
    let email = refEmailByInstr.get(name) || `${slug}@dept.edu`;
    if (await taken(email)) { email = `${slug}@dept.edu`; for (let i = 2; i < 1000 && await taken(email); i++) email = `${slug}_${i}@dept.edu`; }
    const res = await client.query(
      `INSERT INTO instructors (name, email, owner_semester) VALUES ($1,$2,$3) RETURNING id, name`,
      [display, email, ownerSemester]);
    instrByName.set(name, res.rows[0]);
    newInstrNames.add(name);
  }

  // Venues ─────────────────────────────────────────────────────────────────────
  const vRes = await client.query(`SELECT id, name FROM venues WHERE owner_semester = $1`, [ownerSemester]);
  const venueByName = new Map(vRes.rows.map(v => [v.name?.toLowerCase(), v]));
  const VENUE_TYPES = ['Laboratory', 'LectureHall', 'Multipurpose'];
  const venueTypeByName = new Map();
  for (const r of rowData) {
    const vn = r.venueName?.trim().toLowerCase();
    if (!vn || venueTypeByName.has(vn)) continue;
    const match = VENUE_TYPES.find(t => t.toLowerCase() === String(r.venueType ?? '').trim().toLowerCase());
    if (match) venueTypeByName.set(vn, match);
  }
  const wantedVenues = new Set([
    ...venuesRef.map(v => v.name?.trim()).filter(Boolean),
    ...rowData.map(r => r.venueName?.trim()).filter(Boolean),
  ].map(n => n.toLowerCase()));

  for (const name of wantedVenues) {
    if (venueByName.has(name)) continue;
    const display = venuesRef.find(v => v.name?.toLowerCase() === name)?.name
      ?? rowData.find(r => r.venueName?.toLowerCase() === name)?.venueName ?? name;
    const vref = refVenueByName.get(name) || {};
    const vType = VENUE_TYPES.find(t => t.toLowerCase() === String(vref.type ?? '').toLowerCase())
      || venueTypeByName.get(name) || 'LectureHall';
    const vCap = Number.isFinite(vref.capacity) ? vref.capacity : 30;
    const res = await client.query(
      `INSERT INTO venues (name, type, capacity, owner_semester) VALUES ($1,$2,$3,$4) RETURNING id, name`,
      [display, vType, vCap, ownerSemester]);
    venueByName.set(name, res.rows[0]);
  }

  return { courseByCode, instrByName, venueByName, newInstrNames };
}

// Insert the new instructors' office hours (only the freshly-created ones — an existing
// term instructor keeps the OH it already has, so we never duplicate).
async function addNewInstructorOH(client, officeHours, instrByName, newInstrNames) {
  if (!Array.isArray(officeHours)) return;
  for (const oh of officeHours) {
    const name = oh.instructorName?.trim().toLowerCase();
    if (!name || !newInstrNames.has(name) || !oh.day || !oh.startTime || !oh.endTime) continue;
    const instr = instrByName.get(name);
    if (!instr) continue;
    try { await instrRepo.addOfficeHour(instr.id, { day: oh.day, startTime: oh.startTime, endTime: oh.endTime }, client); }
    catch (err) {
      // NEW-FU-665: the field gate already validated every OH (shape, window, day, known
      // instructor) BEFORE this transaction, so a throw here means a real DB-level problem on
      // an otherwise-clean file. ABORT the merge (the caller's outer catch rolls back) instead
      // of silently swallowing — the old empty catch let a malformed/odd OH vanish while the
      // rest of the merge committed, a non-atomic partial import. Clean message, no raw leak.
      console.error('[scoped import] office-hour insert failed:', oh.instructorName, oh.day, err.message);
      const e = new Error('Import canceled — the office hours could not be saved, so nothing was changed.');
      e.status = 400;
      throw e;
    }
  }
}

// Group the scoped import rows into logical sections (course|section#|gender), each
// carrying its day-set and a single start/end (the export writes one time per group).
function groupRows(rowData) {
  const map = new Map();
  for (const r of rowData) {
    const key = `${r.courseCode.toLowerCase()}|${r.sectionNumber}|${r.gender ?? 'M'}`;
    if (!map.has(key)) map.set(key, { ...r, days: [...r.days] });
    else for (const d of r.days) if (!map.get(key).days.includes(d)) map.get(key).days.push(d);
  }
  return [...map.values()];
}

function groupHasMeetingTime(group) {
  return Array.isArray(group.days) && group.days.length > 0 && !!group.startTime && !!group.endTime;
}

function effectiveImportedSectionType(group, course) {
  if (group.sectionType === 'Sem' || group.isSeminar || course?.is_seminar) return 'Sem';
  if (group.sectionType === 'Prj' || group.isCapstone || course?.is_capstone) return 'Prj';
  return group.sectionType ?? 'Lec';
}

// Build the proposed Section objects for one group at a given start minute.
function proposeGroup(group, scheduleId, course, instructor, venue, startMin) {
  const sectionType = effectiveImportedSectionType(group, course);
  if (!groupHasMeetingTime(group)) {
    return [new Section({
      id: `__imp__${course.id}_${group.sectionNumber}_${group.gender}_unscheduled_0`,
      scheduleId, courseId: course.id,
      instructorId: instructor?.id ?? null, venueId: null,
      sectionNumber: String(group.sectionNumber), day: null,
      startTime: null, endTime: null,
      courseCode: course.course_code, courseName: course.name,
      academicLevel: course.academic_level, category: course.category,
      numSections: course.num_sections, instructorName: instructor?.name ?? null,
      venueName: null, sectionType,
      venueType: null, hasLab: false, credits: group.credits,
      isCapstone: group.isCapstone, gender: group.gender, isExternal: group.isExternal,
      isThesis: group.isThesis, isResearch: group.isResearch, isSeminar: group.isSeminar || course?.is_seminar,
    })];
  }
  const dur = hm(group.endTime) - hm(group.startTime);
  return group.days.map((day, i) => new Section({
    id: `__imp__${course.id}_${group.sectionNumber}_${group.gender}_${day}_${i}`,
    scheduleId, courseId: course.id,
    instructorId: instructor?.id ?? null, venueId: venue?.id ?? null,
    sectionNumber: String(group.sectionNumber), day,
    startTime: fromMin(startMin), endTime: fromMin(startMin + dur),
    courseCode: course.course_code, courseName: course.name,
    academicLevel: course.academic_level, category: course.category,
    numSections: course.num_sections, instructorName: instructor?.name ?? null,
    venueName: venue?.name ?? null, sectionType,
    venueType: venue?.type ?? null, hasLab: false, credits: group.credits,
    isCapstone: group.isCapstone, gender: group.gender, isExternal: group.isExternal,
    isThesis: group.isThesis, isResearch: group.isResearch, isSeminar: group.isSeminar || course?.is_seminar,
  }));
}

// Does adding `proposed` to `placed` introduce a NEW conflict (one not already present
// among `placed`)? Baseline-diff so a pre-existing term conflict isn't blamed on the merge.
function introducesConflict(placed, proposed, ohMap, baseKeys) {
  const after = engine.evaluateAll([...placed, ...proposed], ohMap);
  return after.conflicts.some(c => !baseKeys.has(`${c.ruleId}|${c.description}`));
}

// Insert one proposed group's day-rows; returns the inserted Section objects (real ids)
// so later groups see them in `placed`.
async function insertGroup(client, scheduleId, proposed) {
  const out = [];
  for (const sec of proposed) {
    const ins = await client.query(
      `INSERT INTO sections (schedule_id,course_id,instructor_id,venue_id,section_number,day,start_time,end_time,section_type,gender)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
      [scheduleId, sec.courseId, sec.instructorId, sec.venueId, sec.sectionNumber, sec.day,
       sec.startTime, sec.endTime, sec.sectionType ?? 'Lec', sec.gender === 'F' ? 'F' : 'M']);
    if (ins.rowCount > 0) { sec.id = ins.rows[0].id; out.push(sec); }
  }
  return out;
}

/**
 * Merge a scoped (instructor/venue) import into the current term.
 * @param {string} scheduleId
 * @param {{scope, rows, officeHours, instructors, venues}} parsed
 * @param {'entity-only'|'with-conflicts'|'conflict-free'|undefined} mode
 */
async function mergeScopedImport(scheduleId, parsed, mode) {
  const { scope, rows = [], officeHours = [], instructors = [], venues = [] } = parsed;
  const entity = scope === 'venue' ? (venues[0]?.name || 'venue') : (instructors[0]?.name || 'instructor');

  // NEW-FU-661: strict FIELD gate (pure, no DB) — reject any malformed value/cell with a
  // precise message before opening a transaction. The same gate the whole-term replace path
  // runs; here it also makes the additive merge's inserts safe (no mid-tx DB-CHECK abort).
  // NEW-FU-665: officeHours go through the SAME gate so a malformed OH in a scoped instructor
  // file is rejected up front (atomic) instead of being silently swallowed by addNewInstructorOH.
  const fieldCheck = validateImportFields({ rows, instructors, venues, officeHours });
  if (fieldCheck.errors.length) {
    const e = new Error(`Import canceled — ${fieldCheck.errors.length} value(s) don't match the expected format, so nothing was changed:\n• ${fieldCheck.errors.slice(0, 12).join('\n• ')}`);
    e.status = 400; throw e;
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await schedSvc.assertSchedulerEditableLocked(client, scheduleId);
    const ownerSemester = (await client.query('SELECT semester FROM schedules WHERE id = $1', [scheduleId])).rows[0]?.semester ?? null;

    // Baseline (pre-merge) conflict set + current sections, for new-conflict diffing
    // and conflict-free placement.
    const base = await loadTermState(client, scheduleId);
    // The dialog decision diffs on the HARD rules only (engine.evaluateAll = R-01/02/04/05/06).
    // NEW-FU-673 (examined, INTENTIONAL — not the "bug" a round-3 auditor flagged): a scoped merge
    // carries PARTIAL course data (an instructor's Lec without the Lab a colleague teaches), so the
    // SOFT rules R-11..R-15 — missing-lab (R-14), credit-coverage (R-15), no-office-hours (R-13) —
    // are EXPECTED artifacts of that partiality and must NOT block the merge (they'd prompt on every
    // normal partial import). They still surface to the user: the controller runs revalidateSchedule
    // right after the merge, so they appear in the conflict panel. Only HARD conflicts (double-book,
    // same-level overlap, teaching-window) pause for the 3-option dialog. The whole-term path DOES
    // block on soft conflicts because a whole-term file is COMPLETE — there a soft conflict means a
    // genuinely broken schedule, not expected partiality. The asymmetry is the complete-vs-partial
    // distinction, by design.
    const baseKeys = conflictKeys(base.sections, base.ohMap);

    let created = 0, skipped = 0, moved = 0;
    const errors = [];
    const placed = [...base.sections];      // grows as we place groups (conflict-free needs it)

    // ENTITY-ONLY: add just the scoped entity (+ its OH for an instructor file). No rows.
    if (mode === 'entity-only') {
      const ent = await upsertEntities(client, scheduleId, ownerSemester, [], { instructorsRef: instructors, venuesRef: venues }, { skipRowEntities: true });
      await addNewInstructorOH(client, officeHours, ent.instrByName, ent.newInstrNames);
      await client.query('COMMIT');
      return { mode, scope, entity, created: 0, skipped: 0, moved: 0, errors,
               message: scope === 'venue'
                 ? `Added venue "${entity}" (capacity & type) — no courses assigned.`
                 : `Added instructor "${entity}" with office hours — no courses assigned.` };
    }

    // NEW-FU-661: course-NAME gate with the SAME re-import leniency as the whole-term path —
    // a genuinely NEW course code must carry a real English title; a code already known to
    // the system keeps whatever name the file labels it (re-import of seed names / a PDF-
    // clipped name). The code, range, level, etc. were already checked by the field gate.
    {
      const known = await client.query('SELECT LOWER(course_code) AS code, LOWER(name) AS name FROM courses');
      const knownCodes = new Set(known.rows.map(r => r.code));
      const knownNames = new Set(known.rows.map(r => `${r.code}|${r.name}`));
      const bad = [];
      for (const r of rows) {
        const codeLc = String(r.courseCode ?? '').toLowerCase();
        const isKnown = knownCodes.has(codeLc) || knownNames.has(`${codeLc}|${String(r.courseName ?? '').toLowerCase()}`);
        if (!isKnown) {
          // NEW-FU-661: a genuinely NEW course must carry a real title AND a level matching
          // its number; a known code (re-import) tolerates legacy name/level mismatches.
          const ne = courseNameError(r.courseName) || courseCodeLevelError(r.courseCode, r.academicLevel, r.category);
          if (ne) bad.push(`"${r.courseCode} — ${r.courseName}": ${ne}`);
        }
      }
      if (bad.length) {
        const e = new Error(`Import canceled — ${bad.length} course name(s) are invalid, so nothing was changed:\n• ${[...new Set(bad)].slice(0, 10).join('\n• ')}`);
        e.status = 400; throw e;
      }
    }

    // Add the entity + its courses/venues/instructors (additive), then place its sections.
    const ent = await upsertEntities(client, scheduleId, ownerSemester, rows, { instructorsRef: instructors, venuesRef: venues });
    await addNewInstructorOH(client, officeHours, ent.instrByName, ent.newInstrNames);

    // Rebuild the OH map to include the just-added new instructors' OH (needed for R-04 in placement).
    const merged0 = await loadTermState(client, scheduleId);
    const ohMap = merged0.ohMap;

    const groups = groupRows(rows);
    for (const g of groups) {
      const course     = ent.courseByCode.get(g.courseCode.toLowerCase());
      if (!course) { errors.push(`Course "${g.courseCode}" could not be created.`); continue; }
      const instructor = g.instructorName ? ent.instrByName.get(g.instructorName.trim().toLowerCase()) : null;
      const venue      = g.venueName ? ent.venueByName.get(g.venueName.trim().toLowerCase()) : null;
      const hasMeeting = groupHasMeetingTime(g);
      const origMin    = hasMeeting ? hm(g.startTime) : 0;
      const dur        = hasMeeting ? hm(g.endTime) - hm(g.startTime) : 0;

      let startMin = origMin;
      if (mode === 'conflict-free' && hasMeeting) {
        const atOrig = proposeGroup(g, scheduleId, course, instructor, venue, origMin);
        if (introducesConflict(placed, atOrig, ohMap, baseKeys)) {
          // Scan the teaching window (R-06-aware) for the nearest conflict-free start.
          const win = teachingWindowFor({ category: course.category, isCapstone: course.is_capstone, courseCode: course.course_code });
          let best = null;
          for (let st = win.start; st + dur <= win.end; st += 30) {
            if (st === origMin) continue;
            const cand = proposeGroup(g, scheduleId, course, instructor, venue, st);
            if (!introducesConflict(placed, cand, ohMap, baseKeys)) {
              const dist = Math.abs(st - origMin);
              if (best === null || dist < best.dist) best = { st, dist };
            }
          }
          if (best) { startMin = best.st; moved++; }
          else errors.push(`${g.courseCode} ${sectionLabel(g)} kept at ${g.startTime} — no conflict-free slot was available (nothing was dropped).`);
        }
      }

      const proposed = proposeGroup(g, scheduleId, course, instructor, venue, startMin);
      const inserted = await insertGroup(client, scheduleId, proposed);
      created += inserted.length;
      skipped += proposed.length - inserted.length;
      placed.push(...inserted);
    }

    // New-conflict count after the merge (for the caller's report and the auto decision).
    const after = await loadTermState(client, scheduleId);
    const afterKeys = conflictKeys(after.sections, after.ohMap);
    const newConflicts = [...afterKeys].filter(k => !baseKeys.has(k));

    // PREVIEW (no explicit mode): commit only when the clean add introduced no conflict;
    // otherwise roll back and let the caller present the 3 options.
    if (!mode) {
      if (newConflicts.length > 0) {
        await client.query('ROLLBACK');
        try { client.release(); } catch { /* */ }
        return {
          needsDecision: true, scope, entity,
          conflictCount: newConflicts.length,
          conflictSummaries: newConflicts.slice(0, 6).map(k => k.split('|').slice(1).join('|')),
          courseCount: groups.length,
        };
      }
      // clean merge → fall through to commit
    }

    await client.query('COMMIT');
    return { mode: mode || 'merge-clean', scope, entity, created, skipped, moved, errors, newConflicts: newConflicts.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    try { client.release(err); } catch { /* */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* already released */ }
  }
}

module.exports = { mergeScopedImport };
