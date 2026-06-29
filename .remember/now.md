# CSCVS Session Memory - Read Before Acting

This file is a compact memory checkpoint for Codex/Claude continuity. It is not a replacement for `HANDOFF.md`, `CLAUDE.md`/`AGENTS.md`, `README.md`, or `PER_TERM_ISOLATION_PLAN.md`; read those first when starting a new session.

## Current Repo State

- Repo: `/Users/livyw/Downloads/SWE_412/Course_Schedule_Conflict_Visualization_System`
- Branch at last memory update: `codex/info-only-regression`
- Memory checkpoint was first committed as `11e98b7 docs(handoff): add continuity memory checkpoint`; run `git log --oneline -12` for the current latest commit.
- Remote verified during prior session: `origin https://github.com/Faleh-ALkhaldi/Course_Schedule_Conflict_Visualization_System.git`
- Git identity verified during prior session: `FALEH AL KHALDI <voidn49@gmail.com>`
- There is a large dirty working tree. Do not assume `git status` is clean.

## Non-Negotiable Guardrails

- Do not run `git stash`, `git reset --hard`, `git checkout -- .`, or `git clean`.
- Do not reseed/reset the dev database.
- Do not mutate protected terms `251` or `252`. Term `282` is the owner's and should stay consistent.
- The FU-680 to FU-690 feature arc plus follow-up fixes are mostly uncommitted and interleaved with later work. Do not stage broad source files unless the owner explicitly authorizes committing the feature blob.
- If a safe scoped commit is needed, stage only the exact docs or hunks that belong to that task.
- Do not invent behavior outside the prompt, repo docs, SRS/SDD, or `HANDOFF.md`. If unclear, add an open question to `HANDOFF.md`.
- Use clean professional commit messages only. Do not include AI/tool attribution.
- Before pushing, verify the remote is under `Faleh-ALkhaldi`, not `Valonyx`.

## Database / Migration State

- Migrations `024_phase125_thesis_flag.js`, `025_phase126_registrar_flags.js`, `026_phase127_seminar_course_flag.js`, and `027_phase128_info_only_backfill.js` exist in the working tree and were applied to the dev DB/private test flow during prior work, but are untracked until the FU blob or a scoped source slice is committed.
- On 2026-06-29, `026_phase127_seminar_course_flag.js` was applied to live dev DB `scheduler_db` with `npm run migrate` to repair the runtime error `column c.is_seminar does not exist`. This was additive only and did not reseed/reset data.
- On 2026-06-29, `027_phase128_info_only_backfill.js` was applied to live dev DB `scheduler_db` with `npm run migrate` to repair stale non-protected Thesis / Research / Summer Training / Internship rows that were being treated as scheduled lecture rows. This was additive/idempotent data repair and did not reseed/reset data.
- Protected data remained intact after the info-only repair: term 251 = 81 sections, term 252 = 97 sections. Term 253 is now 37 sections; term 282 is now 76 after stale scheduled `SWE 610` thesis artifacts were collapsed into side-panel info-only instructor rows.
- Dev DB has manual, non-seeded data: real UG thesis courses `SWE 494` and `SWE 496` inserted into protected terms `251` and `252`. A reseed would erase them.
- Use `DB_NAME_TEST=scheduler_db_modz` for integration tests. The default shared test DB can produce spurious failures when sessions overlap.
- Use `npm run test:int:isolated`, not the shared `npm run test:int`.

## Major Work Completed

### FU-688 to FU-690 Registrar Activity Flag Arc

- Registrar-style activity flags were added/refined:
  - `ST` / `INT`: existing `is_external`, display derived by term season (`ST` in summer, `INT` otherwise).
  - `RES`: new `courses.is_research`, behaves like thesis.
  - `THS`: `courses.is_thesis`, information-only thesis activity.
  - `PRJ`: `is_capstone` project activity, now conflict-exempt and time-optional.
  - `SEM`: Seminar activity, stored as section type `Sem`, display label `SEM`.
- `Section.isConflictExempt` covers external, thesis, research, and project/capstone activities.
- `effectiveSectionType` is display/derivation logic and must stay mirrored between backend `backend/src/domain/exportLabels.js` and frontend `frontend/src/context/AppContext.jsx`.
- Info-only NULL-time rows are preserved in import/export round trips.
- Sidebar/grid code was hardened for NULL `day`, `start_time`, and `end_time`.

### Full-System Audit Fixes

- Graphify was used to map blast radius. Existing graph output lives under `graphify-out/` and is ignored.
- Removed dead frontend helpers:
  - `frontend/src/hooks/useRenderStrategy.js`
  - `frontend/src/utils/renderStrategy.js`
  - `frontend/src/utils/motion.js`
- Hardened direct R-06 conflict checks to honor conflict-exempt activity families.
- Fixed frontend drag/drop mirrors so Project/info-only conflict exemptions agree with backend.
- Fixed scoped import in-memory conflict modeling to carry thesis/research flags.
- Expanded import validation mutual-exclusion tests and guards.

### Information-Only and Project Semantics

- Information-only activities are Thesis, Research, Summer Training, and Internship.
- Information-only sections:
  - exist in the side panel/course list only;
  - are not draggable to the grid;
  - do not create grid blocks;
  - do not have day/start/end/duration/pattern/venue;
  - persist meeting fields as `NULL` where applicable;
  - only allow instructor and section number edits.
- Project sections:
  - may have no time/no venue;
  - may have time without venue;
  - may have time with venue;
  - may not have venue without time;
  - clearing time must also clear venue;
  - timed projects meet on exactly one day;
  - timed project duration options are 50, 75, 100, and 160 minutes;
  - untimed projects stay out of the grid.

### UX / Content / Export Audit

- Reworded scheduler-facing copy to avoid internal terms like "round-trip", "lossless", raw rule codes, backend port errors, or developer commands.
- Standardized "venue" wording instead of "room" where appropriate.
- Improved import/export, quick-fix, suggest/build mismatch, and validation copy.
- Seed source now gives synthetic `SWE 101` the formal title "Introduction to Software Engineering" for future seeds; the protected dev DB was not reseeded.
- Export artifacts were generated and inspected for full-term, instructor, and venue scopes in PDF/XLSX/DOCX/PNG during prior audits.

### Scoped Export Accuracy

- Scoped instructor/venue exports are focused views, not "only this instructor/venue".
- Scoped exports may include complementary lecture/lab sections, instructors, venues, and resources needed for schedule completeness and safe re-import.
- UI and generated export wording was updated to avoid "nothing else from the term".
- Shared carried-complement heading: "Carried complementary sections - included for schedule completeness".

### Course Flag / Section-Type / Suggest Semantics

- Added course-level Seminar support via `courses.is_seminar` and migration `026_phase127_seminar_course_flag.js`.
- Seminar rules:
  - Graduate only.
  - SWE course code must be `500-699`.
  - Mutually exclusive with Has-lab, Project, Thesis, Research, External/ST/INT, and other exclusive activity flags.
  - Exactly one day.
  - Exactly 75 minutes.
  - Section/activity type derives as `Sem`; UI display is `SEM`.
- Course/activity flags are fixed after creation. To change a flag, the user must delete and recreate the course/activity.
- The section-type selector now appears only for Has-lab courses and only offers Lecture/Lab.
- Lecture-only courses derive Lecture automatically.
- Project, Thesis, Research, ST/INT, and Seminar derive their section/activity type from the course flag.
- Auto-Suggest now excludes information-only and Project courses, constrains Seminar to one-day/75-minute patterns, and avoids invalid controls for Thesis/Research/ST/INT/Project.

### 2026-06-29 Full-System Audit/Fix Pass

- Branch: `codex/full-system-audit`.
- Graphify was used before editing. The high-blast hubs were backend scheduling/conflict services (`ScheduleService`, `ConflictEngine`, rules, repositories), import/export services, `ScopedImportService`, `SuggestService`, `QuickFixService`, `SectionRepository`, and frontend mirrors (`AppContext`, `SchedulerPage`, grid, side panel, modals).
- Quick Fix in-memory evaluation now matches authoritative instructor-warning behavior for information-only activities and dedupes R-09/R-10/R-12 by course, section number, and gender.
- Import section-type error text now lists all accepted round-trip activity labels, including Summer Training, Internship, and Research; tests confirm those labels are accepted.
- Suggest forced-capacity warning wording now checks stored section-type codes (`Lec`, `Lab`, `Sem`) correctly.
- The next-section-number endpoint now echoes valid requested section types instead of coercing all non-lab requests to `Lec`.
- Direct API misuse with a private course row from another term is now rejected for manual section creation and Suggest when `owner_semester` is non-null and mismatched.
- Catalog/template course IDs with `owner_semester IS NULL` are still accepted for backward compatibility. Stricter template-to-local resolution is an open owner decision because it changes persisted/returned `courseId` expectations.
- Source edits from this audit are interleaved with the inherited dirty FU blob; do not stage broad source files unless B1 is approved.

### 2026-06-29 Seminar Schema Hotfix

- Branch: `codex/fix-seminar-schema`.
- Symptom: term 251 / Fall 2025 rendered empty Courses and Sections with toast `column c.is_seminar does not exist`.
- Root cause: backend code selected `courses.is_seminar`, but live dev DB `scheduler_db` had applied migrations only through `025_phase126_registrar_flags.js`; the untracked additive migration `026_phase127_seminar_course_flag.js` was pending.
- Fix: ran `cd backend && npm run migrate`, applying `026_phase127_seminar_course_flag.js` only. This added `courses.is_seminar BOOLEAN NOT NULL DEFAULT false`.
- Protected data remained intact before and after: term 251 = 81 sections, term 252 = 97 sections, term 282 = 80 sections. Manual protected thesis rows `SWE 494` and `SWE 496` remained present in 251/252 and now have `is_seminar = false`.
- API smoke after fix: backend `/health` returned 200; `GET /api/v1/courses?term=251` returned 200 with 16 courses; `GET /api/v1/schedules/c2536f22-4003-4a79-9794-0089d05a73ac/sections?view=course` returned 200 with restored section data.
- Browser smoke after fix: `http://localhost:3000/?term=251`, login `admin1` / `password123`, showed Fall 2025 / 251 with populated Courses and Sections, no `c.is_seminar` toast, and no console errors.
- No source edit was needed. The applied migration file is still part of the inherited untracked FU blob; do not stage it alone unless the owner approves committing that feature slice/B1.

### 2026-06-29 Info-Only Activity Regression Repair

- Branch: `codex/info-only-regression`.
- Symptom: Thesis, Research, Internship, and Summer Training were being treated like scheduled Lecture sections. In term 253, `SWE 610 - Thesis` could appear as a grid/scheduled activity and opened lecture-style controls; `SWE 399` had a stale scheduled placeholder row.
- Root cause: the frontend/backend info-only paths mostly obeyed course flags, but the active DB and seed source had stale registrar activity rows with lecture-like flags/meeting fields. Seed ingestion tracked raw registrar activity values such as `THS` and `ST`, but did not persist the corresponding course flags for seeded UG/GR courses, and the old `SWE 399` placeholder used sentinel day/time fields from pre-nullable days.
- Graphify was used before editing. Blast radius included frontend `AppContext`, `SchedulerPage`, `SidePanel`, `ScheduleGrid`, `SectionModal`; backend controllers, `seed.js`, repositories, `ScheduleService`, `ConflictEngine`, `QuickFixService`, `SuggestService`, import/export/scoped import, import validators, migrations, and tests.
- Source fixes in the dirty working tree:
  - `backend/src/db/seed.js` now carries registrar activity flags into seeded course rows (`THS` thesis, `RES` research, `ST`/`INT` external, `SEM` seminar), inserts info-only rows with NULL meeting fields when the raw activity has no meeting time, and stops creating the old scheduled `SWE 399` sentinel row.
  - `backend/src/db/migrations/027_phase128_info_only_backfill.js` repairs existing stale non-protected info-only rows by setting flags, collapsing stale multi-day artifacts, and clearing day/start/end/venue fields.
  - `frontend/src/components/modals/SectionModal.jsx` keeps info-only add/edit UI minimal and removes stale scheduling labels from info-only edit panels.
  - `backend/tests/integration/fu688Registrar.test.js` covers seeded info-only rows and direct scheduled-payload rejection.
- Live API/UI state after repair: `SWE 399` and `SWE 610` in term 253 show only as `No fixed time` sidebar rows, have no grid blocks, are not draggable, and expose only course/activity identity, section number, and instructor in Add Section. Existing `SWE 610 §01` edit exposes only instructor and section number.
- Live API misuse check: POSTing a scheduled `SWE 610` payload for term 253 returned 400 `Information-only activities must not have meeting days or times.` and left scheduled info-only row count at 0.
- Verification: targeted `fu688Registrar.test.js` passed (1 suite / 7 tests); backend unit passed (34 suites / 479 tests); isolated backend integration passed (45 files / 0 failed); frontend build passed after final UI copy cleanup with only existing Vite warnings; `git diff --check` clean.
- Commit/staging note: source/migration/test changes are interleaved with the inherited dirty FU blob and migration `027` depends on the untracked `024`/`025`/`026` stack. Commit only continuity docs unless the owner authorizes staging the source/migration/test slice.

## Verification History

Most recent semantic checkpoint:

- Info-only activity repair on `codex/info-only-regression`: targeted `fu688Registrar.test.js` passed (1 suite / 7 tests); backend unit tests passed (34 suites / 479 tests); full isolated backend integration passed (45 files / 0 failed); frontend build passed with only existing Vite warnings; browser/API smoke for term 253 passed.

- Seminar schema hotfix on `codex/fix-seminar-schema`: backend unit tests passed (34 suites / 479 tests); full isolated backend integration passed (45 files / 0 failed); frontend build passed with only existing Vite warnings; browser smoke for term 251 passed.

- Full-system audit/fix pass on `codex/full-system-audit`: `git diff --check` clean; backend unit tests passed (34 suites / 479 tests); focused `batch6TermIsolation` passed (1 suite / 2 tests); focused `suggestPatterns` passed (1 suite / 7 tests); full isolated backend integration passed (45 files / 0 failed); frontend build passed with only existing Vite warnings.
- Browser/UI smoke was not rerun during this pass because no frontend behavior changed. Export/import artifact inspection was not rerun because output-generation code was not changed; isolated integration covered the FU export/import/round-trip suites.

- Targeted backend unit tests for registrar/import/export labels: 3 suites passed, 119 tests passed.
- Targeted backend integration `fu688Registrar.test.js`: 1 suite passed, 6 tests passed. Existing duplicate-key console noise from old test setup did not fail the suite.
- Full backend unit tests: 34 suites passed, 473 tests passed.
- Full isolated backend integration: 45 files passed, 0 failed.
- Frontend build: built successfully in about 967 ms; only existing Vite dynamic-import/chunk-size warnings.
- `git diff --check`: clean.

Earlier related checkpoints:

- Info-only/project semantics: backend unit 34 suites / 464 tests passed; isolated integration 45 files / 0 failed; frontend build passed.
- UX/output audit: backend unit 34 suites / 464 tests passed; isolated integration 45 files / 0 failed; frontend build passed; representative exports inspected.
- Scoped export audit: backend unit 34 suites / 465 tests passed; isolated integration 45 files / 0 failed; frontend build passed; representative scoped exports inspected.

Known residual notes:

- Chrome DevTools MCP browser automation was once blocked by a locked Chrome profile. Do not kill the user's browser just to clear that.
- Backend `npm audit --omit=dev` previously reported 2 moderate production advisories through `exceljs -> uuid`; `npm audit fix` suggested a risky major downgrade, so it was left as an owner decision.
- Some isolated integration files have historical timing flakes but pass standalone/harness retry.

## Running Services

As of the last service restart, the app was running in detached `tmux` sessions:

- Backend session: `cscvs-backend`
- Frontend session: `cscvs-frontend`
- Frontend URL: `http://127.0.0.1:3000/`
- Backend health: `http://127.0.0.1:4000/health`
- Backend health returned `{"status":"ok"}`.
- Frontend returned HTTP 200.
- Dev login: `admin1` / `password123`

Useful commands:

```bash
tmux capture-pane -pt cscvs-backend -S -80
tmux capture-pane -pt cscvs-frontend -S -80
tmux kill-session -t cscvs-backend
tmux kill-session -t cscvs-frontend
```

## Current Open Decisions

- B1: Owner must decide whether/how to commit the large FU-680 to FU-690 dirty feature blob. Do not commit it accidentally.
- B2: Graded SRS/SDD/Test Plan/User Manual predate the June feature arc; owner must decide whether to update docs or constrain behavior.
- B3: Confirm author/remote before any push.
- B4: Decide what to do about backend `exceljs -> uuid` audit advisory.
- B5: Decide whether ST and INT should remain season-derived from `is_external` or become separate stored DB flags.
- B6: Decide whether catalog/template course IDs (`owner_semester IS NULL`) should continue to be accepted by term APIs, or whether a coordinated API/test update should map them to term-owned rows.

## First Actions for a New Session

1. Read `HANDOFF.md` top to bottom.
2. Read `CLAUDE.md` / `AGENTS.md`.
3. Read `README.md` and `PER_TERM_ISOLATION_PLAN.md`.
4. Read this file: `.remember/now.md`.
5. Run `git status --short --branch`, `git log --oneline -12`, `git remote -v`, and `git config user.name && git config user.email`.
6. If architecture/blast radius matters, use graphify at `/Users/livyw/.agents/skills/graphify/SKILL.md`.
7. Only then start the requested work.
