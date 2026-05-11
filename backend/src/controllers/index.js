const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { query } = require('../config/db');
const schedSvc   = require('../services/ScheduleService');
const exportSvc  = require('../services/ExportService');
const multer     = require('multer');
const upload     = multer({ storage: multer.memoryStorage() });
const suggestSvc = require('../services/SuggestService');
const { ScheduleRepository, VenueRepository, CourseRepository } = require('../repositories/repositories');
const InstructorRepository = require('../repositories/InstructorRepository');
const SectionRepository    = require('../repositories/SectionRepository');

const schedRepo  = new ScheduleRepository();
const venueRepo  = new VenueRepository();
const courseRepo = new CourseRepository();
const instrRepo  = new InstructorRepository();
const sectRepo   = new SectionRepository();

// ── Auth ──────────────────────────────────────────────────────────────────────
async function login(req, res) {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password are required.' });
  const r = await query(
    `SELECT id, username, email, password_hash, role FROM users WHERE username = $1`,
    [username]
  );
  const user = r.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid credentials.' });
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
  return res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
}

// ── Schedules ─────────────────────────────────────────────────────────────────
async function listSchedules(req, res) {
  const schedules = await schedRepo.listByDept(req.params.departmentId);
  res.json(schedules);
}

async function createSchedule(req, res) {
  const { departmentId, semester } = req.body;
  if (!departmentId || !semester)
    return res.status(400).json({ error: 'departmentId and semester are required.' });
  const schedule = await schedRepo.create({ departmentId, semester, createdBy: req.user.id });
  res.status(201).json(schedule);
}

// ── Sections ──────────────────────────────────────────────────────────────────
async function getSections(req, res) {
  const { scheduleId } = req.params;
  const { view, instructorId, venueId } = req.query;
  if (view === 'teacher' && instructorId) {
    const data = await schedSvc.getSectionsForInstructor(scheduleId, instructorId);
    return res.json(data);
  }
  if (view === 'venue' && venueId) {
    const sections = await schedSvc.getSectionsForVenue(scheduleId, venueId);
    return res.json({ sections, officeHours: [] });
  }
  const sections = await schedSvc.getSectionsForSchedule(scheduleId);
  res.json({ sections, officeHours: [] });
}

async function createSection(req, res) {
  const { scheduleId } = req.params;
  const { courseId, instructorId, venueId, sectionNumber, day, days, startTime, endTime } = req.body;
  if (!courseId || !sectionNumber || !startTime || !endTime)
    return res.status(400).json({ error: 'courseId, sectionNumber, startTime, endTime required.' });
  try {
    const { section, conflictResult } = await schedSvc.createSection(scheduleId, {
      courseId, instructorId, venueId, sectionNumber,
      day: day ?? (days?.[0]),
      days: days ?? (day ? [day] : []),
      startTime, endTime,
    });
    res.status(201).json({ section, conflicts: conflictResult });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

async function updateSection(req, res) {
  const { sectionId } = req.params;
  const { instructorId, venueId, day, startTime, endTime, sectionNumber, infoOnly } = req.body;
  try {
    if (infoOnly) {
      // Info update (instructor, venue, sectionNumber) — propagates to all siblings
      const result = await schedSvc.updateSectionInfo(sectionId, { instructorId, venueId, sectionNumber });
      return res.json({ section: null, conflicts: result });
    }
    if (!day || !startTime || !endTime)
      return res.status(400).json({ error: 'day, startTime, endTime are required.' });
    const result = await schedSvc.assignSection(sectionId, { instructorId, venueId, day, startTime, endTime });
    res.json({ section: null, conflicts: result });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

async function deleteSection(req, res) {
  try {
    await schedSvc.deleteSection(req.params.sectionId);
    res.json({ deleted: true });
  } catch(err) {
    console.error('deleteSection error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function saveSchedule(req, res) {
  const { scheduleId } = req.params;
  const { confirmSoft = false } = req.body;
  const result = await schedSvc.saveSchedule(scheduleId, confirmSoft);
  res.status(result.saved ? 200 : 409).json(result);
}

// ── Conflicts ─────────────────────────────────────────────────────────────────
async function getConflicts(req, res) {
  const result = await schedSvc.revalidateSchedule(req.params.scheduleId);
  res.json(result);
}

// ── Export ────────────────────────────────────────────────────────────────────
async function importSchedule(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const result = await exportSvc.importWorkbook(req.file.buffer, req.params.scheduleId);
    // Revalidate conflicts after import
    const conflicts = await schedSvc.revalidateSchedule(req.params.scheduleId);
    res.json({ ...result, conflicts });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

async function exportSchedule(req, res) {
  const { scheduleId } = req.params;
  const { view, instructorId, venueId } = req.query;
  let filter = { type: 'full' };
  if (view === 'teacher' && instructorId) filter = { type: 'instructor', id: instructorId };
  if (view === 'venue'   && venueId)      filter = { type: 'venue',      id: venueId };
  const schedule = await schedRepo.findById(scheduleId);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found.' });
  const wb = await exportSvc.buildWorkbook(scheduleId, filter, schedule.semester);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${schedule.semester}-schedule.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

// ── Courses ───────────────────────────────────────────────────────────────────
async function getCourses(req, res) { res.json(await courseRepo.findAll()); }

async function createCourse(req, res) {
  const { courseCode, name, credits, academicLevel, category, numSections } = req.body;
  if (!courseCode || !name || !credits || !academicLevel || !category)
    return res.status(400).json({ error: 'courseCode, name, credits, academicLevel, category required.' });
  const course = await courseRepo.create({ courseCode, name, credits, academicLevel, category, numSections });
  res.status(201).json(course);
}

async function updateCourse(req, res) {
  const course = await courseRepo.update(req.params.courseId, req.body);
  res.json(course);
}

async function deleteCourse(req, res) {
  await courseRepo.delete(req.params.courseId);
  res.json({ deleted: true });
}

// ── Instructors ───────────────────────────────────────────────────────────────
async function getInstructors(req, res) { res.json(await instrRepo.findAll()); }

async function createInstructor(req, res) {
  const { name, email } = req.body;
  if (!name || !email)
    return res.status(400).json({ error: 'name and email are required.' });
  const instructor = await instrRepo.create({ name, email });
  res.status(201).json(instructor);
}

async function updateInstructor(req, res) {
  const { name, email } = req.body;
  await query(
    `UPDATE instructors SET name=$2, email=$3, updated_at=NOW() WHERE id=$1`,
    [req.params.instructorId, name, email]
  );
  const instructor = await instrRepo.findById(req.params.instructorId);
  res.json(instructor);
}

async function deleteInstructor(req, res) {
  await query(`DELETE FROM instructors WHERE id = $1`, [req.params.instructorId]);
  res.json({ deleted: true });
}

// ── Office Hours ──────────────────────────────────────────────────────────────
async function getOfficeHours(req, res) {
  const oh = await instrRepo.getOfficeHours(req.params.instructorId);
  res.json(oh);
}

async function addOfficeHour(req, res) {
  const { day, startTime, endTime } = req.body;
  if (!day || !startTime || !endTime)
    return res.status(400).json({ error: 'day, startTime, endTime required.' });
  const oh = await instrRepo.addOfficeHour(req.params.instructorId, { day, startTime, endTime });
  res.status(201).json(oh);
}

async function deleteOfficeHour(req, res) {
  await instrRepo.deleteOfficeHour(req.params.ohId);
  res.json({ deleted: true });
}

// ── Venues ────────────────────────────────────────────────────────────────────
async function getVenues(req, res) { res.json(await venueRepo.findAll()); }

async function createVenue(req, res) {
  const { name, type, capacity } = req.body;
  if (!name || !type || !capacity)
    return res.status(400).json({ error: 'name, type, capacity required.' });
  const venue = await venueRepo.create({ name, type, capacity });
  res.status(201).json(venue);
}

async function updateVenue(req, res) {
  const venue = await venueRepo.update(req.params.venueId, req.body);
  res.json(venue);
}

async function deleteVenue(req, res) {
  await venueRepo.delete(req.params.venueId);
  res.json({ deleted: true });
}

async function suggestSchedule(req, res) {
  try {
    const { courseConfigs } = req.body;
    if (!courseConfigs?.length)
      return res.status(400).json({ error: 'courseConfigs array required.' });
    const result = await suggestSvc.suggest(req.params.scheduleId, courseConfigs);
    res.json(result);
  } catch(err) {
    console.error('Suggest error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  login,
  listSchedules, createSchedule,
  getSections, createSection, updateSection, deleteSection,
  importSchedule, upload,
  suggestSchedule,
  saveSchedule, getConflicts, exportSchedule,
  getCourses, createCourse, updateCourse, deleteCourse,
  getInstructors, createInstructor, updateInstructor, deleteInstructor,
  getOfficeHours, addOfficeHour, deleteOfficeHour,
  getVenues, createVenue, updateVenue, deleteVenue,
};
