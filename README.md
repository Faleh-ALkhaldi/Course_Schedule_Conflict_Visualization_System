# Course Schedule Conflict Visualization System (CSCVS)

A full-stack web application for academic-department schedule construction. Schedulers
build a weekly section grid by drag-and-drop while the system detects nine kinds of
scheduling conflicts in real time and visualises them in a Course / Teacher / Venue view.
Schedules can be exported to Excel in three formats and imported back by an administrator.

---

## Project Information

| Field   | Value |
|---------|-------|
| Course  | SWE 412 — Software Engineering Senior Project II |
| Team    | Faleh Alkhaldi and Abdulkarim Althani |
| System  | CSCVS  (front-end label: SchedulerSWE) |
| License | Academic project — not for external distribution |

---

## Documentation

The full project documentation is in the `/docs` folder. Read the documents in the
order below; each builds on the previous one.

| Order | Document | File | Date |
|-------|----------|------|------|
| 1 | Software Requirements Specification | `SWE412-SRS.docx`            | 9 March 2026  |
| 2 | Software Design Document            | `SWE412-SDD.docx`            | 29 March 2026 |
| 3 | Software Test Plan                  | `SWE412-Test_Plan.docx`      | 13 April 2026 |
| 4 | Software Test Findings              | `SWE412-Test_Findings.docx`  | 7 May 2026    |
| 5 | User Manual                         | `SWE412-User_Manual.docx`    | 15 May 2026   |

---

## Technology Stack

| Layer    | Technology       | Version |
|----------|------------------|---------|
| Frontend | React + Vite     | React 18, Vite 6 |
| Backend  | Node.js + Express| Node.js 22, Express 4 |
| Database | PostgreSQL       | 18 |
| Auth     | JWT + bcryptjs   | jsonwebtoken 9, bcryptjs 2 |
| Drag-and-drop | dnd-kit     | latest |
| Excel    | ExcelJS          | 4.x |
| HTTP     | Axios            | latest |
| Testing  | Jest + supertest | Jest 29 |

The frontend runs on **port 3000**; the backend API on **port 4000**.
Vite proxies `/api/*` from 3000 to 4000 during development.

---

## Prerequisites

Before you begin, the following must be installed on the machine that will run the app:

1. **Node.js 22 LTS** — https://nodejs.org (the LTS download is what you want)
2. **PostgreSQL 18** — https://www.postgresql.org/download/
3. **Git** — only if you are cloning from a repository (skip if you already have the folder)
4. **A code editor** (recommended: Visual Studio Code) — only if you intend to read the code

You will also need a terminal:
- **Windows**: PowerShell or Windows Terminal
- **macOS / Linux**: the built-in Terminal application

---

## First-Time Setup (step by step)

These steps take a fresh machine to a running CSCVS in about 10 minutes.

### Step 1 — Install Node.js dependencies

Open a terminal in the project root folder (the folder that contains `backend/` and `frontend/`) and run:

```bash
npm run install:all
```

This installs all dependencies for both the backend and the frontend. If that script
is not available in your copy, install each side separately:

```bash
cd backend  && npm install
cd ../frontend && npm install
cd ..
```

### Step 2 — Configure the backend environment

The backend reads database settings from a file called `.env` inside the `backend/`
folder. Copy the example file and edit the values to match your local PostgreSQL:

```bash
cp backend/.env.example backend/.env
```

Open `backend/.env` and fill in:

```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=scheduler_db
DB_USER=scheduler_user
DB_PASSWORD=your_password_here
JWT_SECRET=any_long_random_string_you_choose
PORT=4000
```

### Step 3 — Create the database and load the schema

In a terminal, create the PostgreSQL database, run the migrations (which create all
tables) and seed it with starter data:

```bash
createdb scheduler_db
npm run migrate
npm run seed
```

After seeding the database contains:
- 2 users (`scheduler1`, `admin1`)
- 9 instructors with their office hours
- 5 venues (3 lecture halls + 2 labs)
- 9 courses across academic levels (Freshman through Graduate)
- 1 schedule for `Fall-2025` with 9 baseline sections

### Step 4 — Start the application

You will need two terminal windows because the backend and frontend run as two
separate processes.

**Terminal 1 — backend (port 4000):**

```bash
npm run dev:backend
```

You should see something like `Listening on port 4000`.

**Terminal 2 — frontend (port 3000):**

```bash
npm run dev:frontend
```

You should see the Vite dev-server URL printed.

### Step 5 — Open the application

Open a web browser and go to:

```
http://localhost:3000
```

You should see the SchedulerSWE login screen.

### Default Credentials

| Username    | Password      | Role      |
|-------------|---------------|-----------|
| `scheduler1`| `password123` | Scheduler |
| `admin1`    | `password123` | Admin     |

Use `scheduler1` for normal day-to-day scheduling work. Use `admin1` for the
destructive operations (deleting courses, instructors, or venues) and for importing
an Excel file back into the system.

---

## Project Structure

```
scheduler-app/
├── README.md                       This file
├── package.json                    Monorepo scripts (install:all, dev:backend, dev:frontend)
├── docs/                           Project documentation (5 .docx files)
│
├── backend/                        Node.js + Express REST API
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.js                Entry point
│       ├── app.js                  Express app setup
│       ├── config/
│       │   ├── db.js               PostgreSQL connection pool
│       │   └── constants.js        Academic levels, severities, rule IDs
│       ├── db/
│       │   ├── migrate.js          Migration runner
│       │   ├── seed.js             Demo-data seeder
│       │   └── migrations/         Sequential SQL migrations (001 to 008)
│       ├── domain/                 Section, Conflict, ConflictResult models
│       ├── engine/
│       │   ├── ConflictEngine.js   Evaluates rules in order R-06 → R-01 → R-02 → R-04 → R-05
│       │   └── rules/              R01Rule, R02Rule, R04Rule, R05Rule, R06Rule
│       ├── repositories/           SectionRepository, InstructorRepository, ...
│       │   └── SectionRepository.validateOneInstructor → emits R-09 SOFT
│       ├── services/
│       │   ├── ScheduleService.js  Orchestrates engine + repos for every mutation
│       │   ├── SuggestService.js   Auto-suggest with R-07 / R-08 caps
│       │   └── ExportService.js    Excel workbook builder (table + visual-grid formats)
│       ├── controllers/            HTTP handlers
│       ├── routes/                 Route table + JWT + role guards
│       └── middleware/auth.js      JWT verification + requireRole
│
├── frontend/                       React 18 SPA
│   ├── package.json
│   ├── vite.config.js              Dev server, proxy /api to localhost:4000
│   └── src/
│       ├── index.jsx               React entry
│       ├── App.jsx                 Login gate + main page
│       ├── index.css               Design tokens, system-font stack
│       ├── api/                    Axios client (JWT attached automatically)
│       ├── context/AppContext.jsx  Reducer-based global state
│       ├── pages/
│       │   ├── LoginPage.jsx
│       │   └── SchedulerPage.jsx
│       └── components/
│           ├── shared/TopBar.jsx           Brand, view tabs, Save / Suggest / Export
│           ├── panels/SidePanel.jsx        Left sidebar: conflicts + context list
│           ├── grid/ScheduleGrid.jsx       30-min slots, 5-min drag-snap (dnd-kit)
│           ├── grid/SectionBlock.jsx       Draggable card, level color, conflict pulse
│           ├── grid/OfficeHourBlock.jsx    Gray hatched, Teacher View only
│           └── modals/                     Section, GroupChange, Suggest, SoftConflict, Export
│
└── backend/tests/
    └── unit/conflictEngine.test.js         Conflict-engine unit tests (Jest)
```

---

## Conflict Rules (Implemented)

The system implements **nine** conflict rules. See SDD §5 and SRS §4 for the full
definitions and ConflictEngine call order.

| Rule | Description | Severity | Where implemented |
|------|-------------|----------|--------------------|
| R-01 | Same academic level overlap                            | Hard | `backend/src/engine/rules/R01Rule.js` |
| R-02 | Single-section course vs same / adjacent level         | Hard / Soft | `R02Rule.js` |
| R-03 | Senior-course exemption from R-01 and R-02             | Modifier | Applied inside `R02Rule.js` |
| R-04 | Instructor double-booking or office-hour overlap       | Hard | `R04Rule.js` |
| R-05 | Venue (lecture-hall or laboratory) double-booking      | Hard | `R05Rule.js` |
| R-06 | UG outside 07:00–17:10 or GR outside 17:20–22:00      | Hard | `R06Rule.js` |
| R-07 | Parallel-course-per-slot cap (auto-suggest only)       | Constraint | `services/SuggestService.js` |
| R-08 | Same-course sections in same slot cap (auto-suggest)   | Constraint | `services/SuggestService.js` |
| R-09 | Section saved without an instructor                    | Soft warning | `repositories/SectionRepository.validateOneInstructor` |

---

## Export Formats

The system exports schedules to Excel (`.xlsx`) in three user-facing formats:

| Format         | Description                                                                          |
|----------------|--------------------------------------------------------------------------------------|
| Full Semester  | One row per section group on a single sheet named `Sections`; this is also the format used by the admin import workflow. |
| Teacher Grid   | Visual weekly grid for a selected instructor, with their office hours marked.        |
| Venue Grid     | Visual weekly grid for a selected lecture hall or laboratory.                        |

Visual-grid exports use 5-minute time slots from 07:00 to 22:00 (the in-app grid uses
30-minute slots with 5-minute drag-snap).

---

## API Reference (Summary)

Authentication: all endpoints except `POST /api/v1/auth/login` require an
`Authorization: Bearer <token>` header obtained at login.

| Method | Endpoint | Role required | Description |
|--------|----------|---------------|-------------|
| POST   | `/api/v1/auth/login`                                                | (none)     | Returns a JWT |
| GET    | `/api/v1/courses`                                                   | any        | List courses |
| GET    | `/api/v1/instructors`                                               | any        | List instructors (with office hours) |
| GET    | `/api/v1/venues`                                                    | any        | List tracked venues |
| GET    | `/api/v1/departments/:deptId/schedules`                             | any        | List schedules |
| POST   | `/api/v1/schedules`                                                 | scheduler  | Create a schedule |
| GET    | `/api/v1/schedules/:id/sections?view=course`                        | any        | Course View |
| GET    | `/api/v1/schedules/:id/sections?view=teacher&instructorId=`         | any        | Teacher View |
| GET    | `/api/v1/schedules/:id/sections?view=venue&venueId=`                | any        | Venue View |
| POST   | `/api/v1/schedules/:id/sections`                                    | scheduler  | Add a section |
| PUT    | `/api/v1/sections/:id`                                              | scheduler  | Update or drag-drop reschedule a section |
| GET    | `/api/v1/schedules/:id/conflicts`                                   | any        | Re-evaluate and return all conflicts |
| POST   | `/api/v1/schedules/:id/save`                                        | scheduler  | Save (Draft → PendingApproval) |
| GET    | `/api/v1/schedules/:id/export?view=full`                            | any        | Download Full Semester (.xlsx) |
| GET    | `/api/v1/schedules/:id/export?view=teacher&instructorId=`           | any        | Download Teacher Grid (.xlsx) |
| GET    | `/api/v1/schedules/:id/export?view=venue&venueId=`                  | any        | Download Venue Grid (.xlsx) |
| POST   | `/api/v1/schedules/:id/import`                                      | **admin**  | Import a Full Semester .xlsx back into the schedule |
| DELETE | `/api/v1/courses/:id`                                               | **admin**  | Permanently delete a course |
| DELETE | `/api/v1/instructors/:id`                                           | **admin**  | Permanently delete an instructor |
| DELETE | `/api/v1/venues/:id`                                                | **admin**  | Permanently delete a venue |

Any request to an admin-only endpoint by a scheduler returns HTTP `403` with the
body `{ "error": "Insufficient permissions." }`.

---

## Running the Tests

```bash
npm test
```

The Jest suite covers the conflict engine end-to-end (every conflict rule). The
broader 42-case verification (TC-01 through TC-42 in the Software Test Plan) includes
these unit tests plus integration tests, manual end-to-end tests, and one k6 load
test; see `SWE412-Test_Findings.docx` for the complete verdict register.

Useful sub-commands:

```bash
npm run test:unit      # unit tests only (no database required)
npm run test:int       # integration tests (requires running database)
```

---

## Re-Seeding the Database

If you want to reset to a clean known state at any time:

```bash
npm run migrate:rollback    # drop all tables
npm run migrate             # recreate the schema
npm run seed                # reload demo data
```

The seed script is idempotent — running it a second time will not duplicate rows.

---

## Troubleshooting

**`createdb: command not found`**
The PostgreSQL command-line tools are not on your PATH. On macOS the easiest fix is
to add Postgres.app's `bin` to PATH. On Windows, use the Stack Builder utility to
include the command-line tools, then re-open your terminal.

**`Error: connect ECONNREFUSED 127.0.0.1:5432`**
The PostgreSQL server is not running. Start it from your operating system services
panel or with `pg_ctl start` (the exact command depends on how you installed it).

**`role "scheduler_user" does not exist`**
Create the database user manually:
```bash
psql -d postgres -c "CREATE USER scheduler_user WITH PASSWORD 'your_password_here';"
psql -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE scheduler_db TO scheduler_user;"
```

**The frontend opens but says `Network Error` after login**
The backend is not running. Open a second terminal and run `npm run dev:backend`.

**`Port 3000 is already in use`**
Another process is holding port 3000 (or 4000 for the backend). Stop it, or change
the port in `frontend/vite.config.js` (frontend) or `backend/.env` (backend).

**`Insufficient permissions.`**
You tried to call an admin-only endpoint while logged in as a scheduler. Log out
and log back in as `admin1` to retry.

---

## Notes for Evaluators

- The Software Test Findings document (dated 7 May 2026) reports 40 clean Pass, 1 Pass with capture caveat (TC-29), and 1 Runtime verification required (TC-42), out of 42 total cases.
- The conflict-engine evaluation order is `R-06 → R-01 → R-02 → R-04 → R-05`; R-07/R-08 are auto-suggest-only constraints; R-09 is produced separately by the section repository when an instructor is missing.
- All admin-only routes are guarded by `requireRole('admin')` and return HTTP 403 to schedulers; see SDD §13 for the full role-based-access design.
- The semester display in the top bar maps the backend value `Fall-2025` to the user-visible label `Term 252` via `frontend/src/components/shared/TopBar.jsx` lines 8–11.
- Department and semester are configured per deployment via the Vite environment variables `VITE_DEPT_ID` (default `SWE-DEPT`) and `VITE_SEMESTER` (default `Fall-2025`).
