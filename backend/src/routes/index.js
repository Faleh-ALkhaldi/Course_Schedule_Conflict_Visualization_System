const router = require('express').Router();
const ctrl   = require('../controllers/index');
const { authenticate } = require('../middleware/auth');

// Public
router.get ('/health',     (req, res) => res.json({ status: 'ok' }));
router.post('/auth/login', ctrl.login);

// All routes below require JWT
router.use(authenticate);

// ── Courses ───────────────────────────────────────────────────────────────────
router.get   ('/courses',          ctrl.getCourses);
router.post  ('/courses',          ctrl.createCourse);
router.put   ('/courses/:courseId',ctrl.updateCourse);
router.delete('/courses/:courseId',ctrl.deleteCourse);

// ── Instructors ───────────────────────────────────────────────────────────────
router.get   ('/instructors',                               ctrl.getInstructors);
router.post  ('/instructors',                               ctrl.createInstructor);
router.put   ('/instructors/:instructorId',                 ctrl.updateInstructor);
router.delete('/instructors/:instructorId',                 ctrl.deleteInstructor);
router.get   ('/instructors/:instructorId/office-hours',    ctrl.getOfficeHours);
router.post  ('/instructors/:instructorId/office-hours',    ctrl.addOfficeHour);
router.delete('/instructors/:instructorId/office-hours/:ohId', ctrl.deleteOfficeHour);

// ── Venues ────────────────────────────────────────────────────────────────────
router.get   ('/venues',         ctrl.getVenues);
router.post  ('/venues',         ctrl.createVenue);
router.put   ('/venues/:venueId',ctrl.updateVenue);
router.delete('/venues/:venueId',ctrl.deleteVenue);

// ── Schedules ─────────────────────────────────────────────────────────────────
router.get ('/departments/:departmentId/schedules', ctrl.listSchedules);
router.post('/schedules',                           ctrl.createSchedule);

// ── Sections ──────────────────────────────────────────────────────────────────
router.get   ('/schedules/:scheduleId/sections', ctrl.getSections);
router.post  ('/schedules/:scheduleId/sections', ctrl.createSection);
router.put   ('/sections/:sectionId',            ctrl.updateSection);
router.delete('/sections/:sectionId',            ctrl.deleteSection);

// ── Conflict & Save ───────────────────────────────────────────────────────────
router.get ('/schedules/:scheduleId/conflicts', ctrl.getConflicts);
router.post('/schedules/:scheduleId/suggest',   ctrl.suggestSchedule);
router.post('/schedules/:scheduleId/save',      ctrl.saveSchedule);

// ── Export ────────────────────────────────────────────────────────────────────
router.get ('/schedules/:scheduleId/export', ctrl.exportSchedule);
router.post('/schedules/:scheduleId/import', ctrl.upload.single('file'), ctrl.importSchedule);

module.exports = router;
