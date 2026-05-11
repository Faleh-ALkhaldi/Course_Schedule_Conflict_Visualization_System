# Course Schedule Conflict Visualization System

A full-stack web application for academic department scheduling. Detects and visualizes hard/soft conflicts across courses, instructors, and venues in a shared interactive weekly grid.

---

## Project Structure

```
scheduler-app/
├── package.json              Root monorepo scripts
├── .gitignore
├── README.md
│
├── backend/                  Node.js + Express REST API
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.js          Entry point (starts server)
│       ├── app.js            Express app setup (importable for tests)
│       ├── config/
│       │   ├── db.js         PostgreSQL connection pool
│       │   └── constants.js  ACADEMIC_LEVELS, SEVERITY, RULE_IDS, etc.
│       ├── db/
│       │   ├── migrate.js    Sequential migration runner
│       │   ├── seed.js       Demo data seeder
│       │   └── migrations/
│       │       ├── 001_users.js
│       │       ├── 002_courses.js
│       │       ├── 003_instructors.js   (includes office_hours table)
│       │       ├── 004_venues.js
│       │       ├── 005_schedules.js
│       │       ├── 006_sections.js
│       │       └── 007_conflicts.js
│       ├── domain/
│       │   ├── Section.js        Section model + overlaps() method
│       │   ├── Conflict.js       Conflict model
│       │   └── ConflictResult.js Result value object (canSave, requiresConfirmation)
│       ├── engine/
│       │   ├── ConflictEngine.js Orchestrates all rules; evaluate() + evaluateAll()
│       │   └── rules/
│       │       ├── R01Rule.js    Academic level conflict (Hard)
│       │       ├── R02Rule.js    Single-section protection (Hard + Soft)
│       │       ├── R04Rule.js    Instructor double-booking + office hours (Hard)
│       │       ├── R05Rule.js    Venue double-booking (Hard)
│       │       └── R06Rule.js    UG/GR time allocation (Hard)
│       ├── repositories/
│       │   ├── SectionRepository.js     CRUD + view filters
│       │   ├── InstructorRepository.js  Includes office hours loading
│       │   └── repositories.js          Conflict, Schedule, Venue, Course repos
│       ├── services/
│       │   ├── ScheduleService.js   Orchestrates engine + repos for all mutations
│       │   └── ExportService.js     Builds context-aware Excel workbook (ExcelJS)
│       ├── controllers/
│       │   └── index.js         All HTTP handlers (auth, schedules, sections, export)
│       ├── routes/
│       │   └── index.js         All route definitions with JWT middleware
│       └── middleware/
│           └── auth.js          JWT verify + role guard
│
├── frontend/                 React 18 SPA
│   ├── package.json
│   └── src/
│       ├── index.js          ReactDOM.createRoot entry
│       ├── App.jsx           Root: login gate to scheduler page
│       ├── index.css         Design tokens, fonts (Syne + DM Mono + DM Sans)
│       ├── api/
│       │   └── index.js      Axios client, all API calls, JWT attach, 401 redirect
│       ├── context/
│       │   └── AppContext.jsx Global state reducer (auth, schedule, sections, conflicts)
│       ├── pages/
│       │   ├── LoginPage.jsx/.css       Animated login screen
│       │   └── SchedulerPage.jsx/.css   Main page, boots schedule, wires all components
│       └── components/
│           ├── shared/
│           │   └── TopBar.jsx/.css      Nav: brand, view tabs, Save/Suggest/Export
│           ├── panels/
│           │   └── SidePanel.jsx/.css   Left sidebar: conflict summary + context list
│           ├── grid/
│           │   ├── ScheduleGrid.jsx/.css   DnD grid (dnd-kit), day x time-slot cells
│           │   ├── SectionBlock.jsx/.css   Draggable card, level color, conflict pulse
│           │   └── OfficeHourBlock.jsx/.css Hatched gray, Teacher View only
│           └── modals/
│               └── SoftConflictModal.jsx/.css  Soft conflict confirm/cancel popup
│
└── backend/tests/
    └── unit/
        └── conflictEngine.test.js   30 unit tests (no DB required)
```

---

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 15+

### 1. Install all dependencies
```bash
npm run install:all
```

### 2. Configure the backend
```bash
cp backend/.env.example backend/.env
# Edit backend/.env and fill in DB_HOST, DB_NAME, DB_USER, DB_PASSWORD, JWT_SECRET
```

### 3. Create the database and run migrations
```bash
createdb scheduler_db
npm run migrate
npm run seed
```

### 4. Start both servers

Terminal 1 — Backend (port 4000):
```bash
npm run dev:backend
```

Terminal 2 — Frontend (port 3000):
```bash
npm run dev:frontend
```

Open http://localhost:3000

### Default credentials
- scheduler1 / password123  (scheduler role)
- admin1 / password123      (admin role)

---

## API Reference

All endpoints except login require: Authorization: Bearer <token>

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/v1/auth/login | Returns JWT |
| GET  | /api/v1/courses | All courses |
| GET  | /api/v1/instructors | All instructors |
| GET  | /api/v1/venues | Tracked venues only (halls + labs) |
| GET  | /api/v1/departments/:deptId/schedules | List schedules |
| POST | /api/v1/schedules | Create schedule |
| GET  | /api/v1/schedules/:id/sections?view=course | Course View |
| GET  | /api/v1/schedules/:id/sections?view=teacher&instructorId= | Teacher View |
| GET  | /api/v1/schedules/:id/sections?view=venue&venueId= | Venue View |
| POST | /api/v1/schedules/:id/sections | Create section |
| PUT  | /api/v1/sections/:id | Update section (drag-drop or edit) |
| GET  | /api/v1/schedules/:id/conflicts | Re-evaluate and return all conflicts |
| POST | /api/v1/schedules/:id/save | Save with conflict gate |
| GET  | /api/v1/schedules/:id/export?view=full | Download Excel (.xlsx) |
| GET  | /api/v1/schedules/:id/export?view=teacher&instructorId= | Filtered teacher export |
| GET  | /api/v1/schedules/:id/export?view=venue&venueId= | Filtered venue export |

---

## Conflict Rules

| Rule | Description | Severity |
|------|-------------|----------|
| R-01 | Same academic level overlap | Hard |
| R-02 same level | Single-section course vs same level | Hard |
| R-02 adjacent | Single-section course vs +/-1 level | Soft |
| R-04 | Instructor double-booking | Hard |
| R-04 | Section during instructor office hours | Hard |
| R-05 | Venue (hall/lab) double-booking | Hard |
| R-06 | UG course outside 07:00-17:00 | Hard |
| R-06 | GR course before 17:00 | Hard |

---

## Running Tests
```bash
npm test
# Expected: 30 passed, 0 failed
```
