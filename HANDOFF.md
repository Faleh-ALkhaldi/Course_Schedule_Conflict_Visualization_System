# HANDOFF.md — Live Session Baton (CSCVS (SWE 412 capstone))

> The single shared state file for **both Claude Code and Codex**.
> Whichever agent is working: **read this FIRST, update it LAST.**
> Static architecture/rules live in `CLAUDE.md` (= `AGENTS.md`). This file is *only live state*.

## 🟢 Current status
- **Active agent:** Codex  <!-- handing OVER from Claude to Codex -->
- **Branch:** `codex/info-project-semantics` (branched from `scheduler-modernization`; dirty FU-680→690 working tree carried over intact)
- **Last updated:** 2026-06-28 by Codex (info-only + Project scheduling semantics)
- **Where we are (one line):** Codex implemented and verified the requested scheduling-semantics correction for information-only activities and Project courses. The registrar "Activity flag" arc **FU-688 → FU-690 plus this follow-up** is still **code-complete but UNCOMMITTED** on top of `3c5859b` unless B1 is approved; only this handoff update is safe to commit separately without accidentally committing the inherited feature blob.

## ✅ Done (complete + verified this session)
Evidence runs (verified 2026-06-28):
- `cd backend && npm run test:unit` → **453 passed, 33 suites** (no DB needed). ✅
- `cd frontend && npm run build` → **✓ built** (vite). ✅
- `cd backend && DB_NAME_TEST=scheduler_db_modz npm run test:int:isolated` → **45 files, 0 failed** (verified earlier this session; re-run to re-confirm — needs Postgres, see 🧪). ✅
- Live browser (Playwright) earlier this session: terms 251 & 252 render with **no crash, 0 console errors**.

Codex re-verification (2026-06-28, branch `codex/checkpoint-verify`, no code edits):
- `cd backend && npm install` → up to date; npm audit still reports **20 moderate** backend vulnerabilities (unchanged by this checkpoint).
- `cd backend && npm run test:unit` → **33 suites passed, 453 tests passed**. ✅
- `cd frontend && npm install` → up to date; **0 vulnerabilities**.
- `cd frontend && npm run build` → **✓ built in 1.03s**, 533 modules transformed; Vite emitted existing chunking/dynamic-import warnings. ✅
- `cd backend && DB_NAME_TEST=scheduler_db_modz npm run test:int:isolated` full run #1 → **44 files passed, 1 failed** (`phase37PostApply.test.js`; 3 tests timed out at 5000 ms). Rerun of `phase37PostApply.test.js` standalone → **60 tests passed**. ⚠️
- `cd backend && DB_NAME_TEST=scheduler_db_modz npm run test:int:isolated` full rerun → **44 files passed, 1 failed** (`terms.test.js`; 2 archived-schedule tests failed). Rerun of `terms.test.js` standalone → **50 tests passed**. ⚠️ Known baton note already called out `terms.test.js` as an archived-schedule timing flake.

Codex full-system audit (2026-06-28, branch `codex/checkpoint-verify`):
- **Graphify:** loaded `/Users/livyw/.agents/skills/graphify/SKILL.md`; generated `graphify-out/graph.json`, `GRAPH_REPORT.md`, `graph.html` from deterministic AST/static extraction because no Gemini key was available for semantic labeling. Result: **2,018 nodes / 3,199 edges / 165 communities**. High-blast areas: DB/query/repositories/scheduling, import/export pipeline, and frontend `AppContext`/`SchedulerPage`/grid/sidebar state flow. `graphify-out/` is ignored and intentionally not committed.
- **Static audit:** import-resolution scan found no missing runtime imports. Confirmed real dead frontend helpers: `frontend/src/hooks/useRenderStrategy.js`, `frontend/src/utils/renderStrategy.js`, `frontend/src/utils/motion.js`.
- **Fixes applied:** removed those dead helpers; hardened `backend/src/engine/rules/R06Rule.js` so direct rule calls honor the same conflict-exempt family the engine already skips (`Project`, `Thesis`, `Research`, `External` / `Prj`, `Ths`, `Res`, `St`, `Int`); added `backend/tests/unit/r06ConflictExempt.test.js`; corrected stale architecture comments in dirty FU files (these comment-only edits remain in the uncommitted feature blob because staging the files wholesale would commit B1).
- **Verification:** `cd backend && npm run test:unit` → **34 suites passed, 454 tests passed**. `cd frontend && npm run build` → **✓ built**, existing Vite dynamic-import/chunk-size warnings only. `cd backend && DB_NAME_TEST=scheduler_db_modz npm run test:int:isolated` run #1 → **44 files passed, 1 failed** (`phase37PostApply.test.js` P-Q01); standalone `DB_NAME_TEST=scheduler_db_modz NODE_ENV=test npx jest tests/integration/phase37PostApply.test.js --runInBand --forceExit` → **60/60 passed**; full run #2 → **45 files passed, 0 failed**. `git diff --check` clean.

Codex follow-up full-system audit (2026-06-28, branch `codex/checkpoint-verify`):
- **Graphify:** reused the existing `graphify-out/graph.json` via `/Users/livyw/.local/share/uv/tools/graphifyy/bin/python -m graphify query ...` (the `graphify` shell shim is not on PATH). Queries confirmed the main blast zones: scheduling/conflict evaluation through `ScheduleService`/`ConflictEngine`, import/export/scoped import, and frontend `AppContext`/`SchedulerPage`/grid/sidebar mirrors.
- **Fixes applied in existing dirty FU files (not separately committed to avoid accidentally committing B1):**
  - `frontend/src/pages/SchedulerPage.jsx`: drag-drop R-06 guard now exempts the same conflict-exempt activity family as `SectionModal` and backend (`info-only` + Project/capstone + SWE 412). Root cause: stale frontend mirror only skipped `isExternal`/`SWE 412`, so timed Project sections could be blocked client-side even though backend permits them.
  - `backend/src/services/ScopedImportService.js`: scoped import snapshots/proposed `Section` objects now carry `is_thesis`/`is_research`, and term-course lookup rows return the full flag family. Root cause: FU-688 flags were omitted from this service's in-memory conflict model, risking false R-06/new-conflict decisions for thesis/research rows.
  - `backend/src/domain/importFieldValidation.js` + `backend/tests/unit/importFieldValidation.test.js`: import field gate now passes Has-lab/Project/External/Thesis/Research into `courseFlagError`; tests cover Thesis+Research and Has-lab+Thesis rejection. Root cause: the shared mutual-exclusion validator was expanded, but this import caller still passed only capstone/external.
- **Scans:** local import-resolution scan found no real missing imports (one JSX-text false positive); orphan scan now reports only intentional entry scripts (`backend/src/db/migrate.js`, `backend/src/db/seed.js`). `npm audit --omit=dev`: frontend **0 vulnerabilities**; backend **2 moderate production advisories** via `exceljs -> uuid`. NPM suggests `exceljs@3.4.0` (major downgrade), so left open rather than risking export/import regressions.
- **Verification:** `cd backend && npm run test:unit -- --runInBand tests/unit/importFieldValidation.test.js tests/unit/fu688Registrar.test.js tests/unit/r06ConflictExempt.test.js` → **34 suites passed, 456 tests passed** (script pattern ran all unit suites). `cd frontend && npm run build` → **✓ built**, existing Vite dynamic-import/chunk-size warnings only. `DB_NAME_TEST=scheduler_db_modz NODE_ENV=test npx jest tests/integration/fu683ImportScoping.test.js tests/integration/fu690Roundtrip.test.js --runInBand --forceExit` → **2 suites passed, 3 tests passed**. `cd backend && DB_NAME_TEST=scheduler_db_modz npm run test:int:isolated` → **45 files passed, 0 failed** (runner retried `fu687ReclassThesis`, `smartRecommend`, and `terms`). `git diff --check` clean.

Codex info-only / Project semantics fix (2026-06-28, branch `codex/info-project-semantics`):
- **Graphify:** reused the prior graphify map and direct graph queries to confirm the blast radius before editing. Hot paths were the expected coupled seams: backend `controllers/index.js`, `sectionPattern`, `importFieldValidation`, `SectionRepository`, `ScheduleService`, `ScopedImportService`, `SuggestService`, plus frontend `AppContext`, `SchedulerPage`, `SidePanel`, `ScheduleGrid`, `SectionModal`, and `SuggestModal`.
- **Fixes applied in existing dirty FU files (not separately committed to avoid accidentally committing B1):**
  - Information-only activities (`is_external` ST/INT family, `is_thesis`, `is_research`) now reject day/time/duration/venue at backend create/update/import, require instructor + section number, persist with NULL meeting fields, stay out of grid/suggest/conflict placement logic, and are non-draggable in the sidebar.
  - Project (`is_capstone` / `Prj`) sections now support the legal cases: no time/no venue, time without venue, and time with venue; venue without time is rejected; clearing time also clears venue; timed projects are one-day only; project durations are 50/75/100/160 minutes.
  - Section/activity type changes are blocked in-place on edit; Project edit UI shows fixed type, no Thesis toggle, optional venue, and a meeting-time toggle.
  - Suggest/recommend and scoped/full suggest replacement preserve info-only/project rows instead of deleting or auto-placing them; suggestion candidates exclude info-only and Project courses.
  - Import/scoped import validators and grouping now agree with the same info-only/project rules, including untimed project rows and info-only NULL meeting fields.
- **Test fixes/coverage:** added and adjusted regression coverage across `fu688Registrar`, `fu687ReclassThesis`, `phase33`, `smartRecommend`, `suggestPatterns`, `suggestConflictFree`, and resolver completeness to reflect the clarified semantics.
- **Verification:** `cd backend && npm run test:unit` → **34 suites passed, 464 tests passed**. `cd frontend && npm run build` → **✓ built in 930ms**, existing Vite dynamic-import/chunk-size warnings only. `cd backend && DB_NAME_TEST=scheduler_db_modz npm run test:int:isolated` → **45 files passed, 0 failed** (`fu683ImportScoping.test.js` retried once by the isolated runner, then passed). Targeted integrations also passed for `fu687ReclassThesis`, `batch5ResolverCompleteness`, `suggestConflictFree`, `phase33`, `smartRecommend`, and `suggestPatterns`.
- **Browser/UI smoke:** ran Playwright against frontend `127.0.0.1:3100` + isolated backend `127.0.0.1:4100` with `DB_NAME_TEST=scheduler_db_modz`. Created disposable isolated test course `SWE 489` (Thesis) only in the test DB. Confirmed its sidebar card has no drag role/tabindex, cursor is default, tooltip says information-only, and no grid block renders. Confirmed Add Section for the Thesis exposes only Course, Section number, and Instructor fields. Confirmed Project edit shows the meeting-time toggle, 50/75/100/160 duration controls, fixed Project type, no Thesis toggle, and optional venue.

Feature work landed in the working tree (all on top of `3c5859b`; see `git diff`):
- **FU-688 — registrar Activity flag set.** Section "activity" semantics mirroring the KFUPM registrar:
  - **ST / INT** = the existing `is_external` flag; label DERIVED from term season (code last digit `3`=summer→ST, `1`/`2`=fall/spring→INT). No new column.
  - **RES** = new additive column `courses.is_research` (behaves like thesis).
  - **PRJ (Project)** = the capstone, refined to **fully conflict-exempt + time-optional** (was venue-exempt + time-required).
  - **SEM (Seminar)** = new stored section type.
  - Unifying concepts: `Section.isConflictExempt` getter (`backend/src/domain/Section.js`) = external|thesis|research|capstone; `isInfoOnlyCourse()` (`backend/src/domain/exportLabels.js`) = external|thesis|research (grid-excluded). `effectiveSectionType(sec,{season})` derives the display label. Migrations **024** (`is_thesis`) + **025** (`is_research`, NULLABLE `day/start/end`, section_type CHECK adds `Sem`).
- **FU-689 — corrections.** Seminar → **Graduate-only + EXACTLY 75 min**; Thesis + Research → allowed **UG or GR** (removed the GR-only `createCourse` gates); external (ST/INT) confirmed **Junior-only** + season-derived.
  - **+ DB DATA INSERT (manual, NOT in git):** the real UG thesis courses **SWE 494 (Undergraduate Thesis I)** + **SWE 496 (Undergraduate Thesis II)** (3cr, Senior/UG, `is_thesis`, info-only NULL day/time) were inserted into the **dev-DB protected terms 251 & 252** via direct transactional SQL, additively (existing rows proven byte-identical). See ⚠️/🚧.
- **FU-690 — stabilization + wording + import round-trip.**
  - **Crash fix:** `null is not an object (evaluating 'd.substring')` when a term has info-only (NULL-day) sections. Root: `frontend/src/components/panels/SidePanel.jsx` `grp.days...map(d=>d.substring(0,3))`. Fixed with `.filter(Boolean)` + renders **"No fixed time"**; defensive `filter(Boolean)` also at `frontend/src/pages/SchedulerPage.jsx:780`.
  - **Wording:** corrected Project / External / Thesis / Research / Seminar descriptions across `AddCourseModal.jsx`, `SectionModal.jsx`, and the export legend (`exportLabels.js` `COURSE_TYPE_DEFS`/`SECTION_TYPE_DEFS`).
  - **Import round-trip (was lossy):** info-only NULL-time sections were dropped on re-import. Fixed across 3 layers — parser (`ExportService.parseExcelToRows` + `ImportParserService.normalizeRow`: keep a row on `courseCode+sectionNumber`, skip merged legend rows via `courseCode===sectionNumber`), validator (`importFieldValidation.js`: `timeOptional` rows may omit day/time), commit (`ExportService.commitRows`: `row.days.length ? row.days : [null]`, `startTime||null`). Regression test `backend/tests/integration/fu690Roundtrip.test.js`.

## 🔜 Next up (priority order)
> There is **no new feature request pending** — the human owner drives the next feature. The open work is:
1. **Owner decision → commit the feature blob.** Once authorized, commit the uncommitted FU-680→690 working tree in coherent chunks (kept uncommitted on purpose — see 🚧 B1). Files = everything in `git diff --stat` + the untracked migrations/tests listed in ⚠️1.
2. **Reconcile graded docs (owner decision).** SRS/SDD/Test Plan/User Manual predate this feature set (see 🚧 B2).
3. **(If desired) add a migration/seed for the 251/252 UG-thesis data** so a fresh DB reproduces the new protected baselines (251=81, 252=97). Currently dev-DB-only (see ⚠️2).

## ⚠️ In progress / half-done — READ CAREFULLY before continuing
**The code is done; the *git/DB state* is the loose end. This is the most important section.**

1. **HUGE UNCOMMITTED WORKING TREE — do NOT discard it.** Last commit is `3c5859b` (FU-672→679). **Everything FU-680 → FU-690 is uncommitted:**
   - **33 modified tracked files** (`git diff --stat`: ~+1389/-351), backend + frontend.
   - **Untracked (new) files** (`git status`):
     - `backend/src/db/migrations/024_phase125_thesis_flag.js`, `025_phase126_registrar_flags.js`
     - `backend/src/domain/complementPlanner.js`
     - tests: `backend/tests/integration/fu679Export…fu688Registrar.test.js`, `fu690Roundtrip.test.js`; `backend/tests/unit/complementPlanner.test.js`, `fu679ExportLayout.test.js`, `fu680ExportLayout.test.js`, `fu688Registrar.test.js`
     - docs: `CLAUDE.md`, `AGENTS.md` (symlink→CLAUDE.md), `HANDOFF.md` (these three are committed by this handoff)
   - **DANGER:** do **NOT** `git stash`, `git reset --hard`, `git checkout -- .`, or `git clean` — you will lose ~2 weeks of FU-680→690 work that is in **no commit**. To start a Codex branch: `git switch -c codex/<task>` — the working-tree changes carry over.
2. **DB has manual data NOT reproducible from git.** The FU-689 UG-thesis courses (SWE 494/496 in terms 251 & 252) were inserted by direct SQL, **not** by a migration or `seed.js`. A fresh DB from `npm run migrate && npm run seed` will **NOT** contain them, so the new "protected" section baselines (**251 = 81, 252 = 97**, 282 = 80) exist **only in the current dev DB**. Reset/reseed → that data vanishes and the invariant reverts to 251=78/252=95. (No code depends on the exact counts.)
3. **Migrations 024/025 are applied to the dev DB + private test DB this session but are untracked.** They auto-run via `npm run migrate` (discovered + sorted). A teammate pulling only committed code won't have them until the blob is committed.

## 🚧 Blockers / open decisions (need the human)
- **B1 — Authorize committing the feature blob.** Standing instruction all session was "do NOT commit/push until I tell you." This turn authorized committing only the **handoff docs**, so FU-680→690 plus the info-only/Project follow-up stays intentionally uncommitted. **Decision:** commit it (how to split?) and whether to push.
- **B2 — Graded-doc divergence.** `SWE412-SRS.docx`, `SWE412-SDD.docx/pdf`, `SWE412-Test_Plan.docx`, `SWE412-User_Manual.docx/pdf` in the parent `SWE_412/` folder are dated **May 23–24**; the entire June FU-559→690 arc (registrar Activity flags ST/INT/RES/PRJ/SEM, conflict-exemption, per-term isolation, …) **post-dates them and is not described in them.** `CLAUDE.md` says behavior must stay consistent with the graded artifacts. **Decision:** update the docs to match current behavior, or constrain behavior to the docs. *(UNVERIFIED whether the grader requires a match — the `.docx` are binary and were not opened; flagging the date gap as strong evidence of divergence.)*
- **B3 — Push/author convention.** Prior commits are on `scheduler-modernization`; confirm author identity + remote before any push. *(UNVERIFIED from git config.)*
- **B4 — Backend dependency advisory.** `npm audit --omit=dev` reports **2 moderate** production advisories through `exceljs -> uuid` (`GHSA-w5hq-g745-h8pq`). `npm audit fix` proposes `exceljs@3.4.0` (major downgrade from 4.4.0), which is risky for current workbook import/export behavior. Needs owner decision: accept risk, investigate an override/patch, or test a package change in a dedicated branch.
- **B5 — ST vs INT persistence.** Current implementation keeps Summer Training / Internship in the existing `is_external` family and derives the display label from term season (`ST` for summer terms, `INT` otherwise). If the product must distinguish ST and INT as separately stored flags in the DB, that is a schema/API change and needs explicit owner approval before implementation.

## 🧠 Context the next agent needs (gotchas, why-decisions, traps)
- **Protected terms = 251 and 252 ONLY** (282 is the owner's — keep consistent). Never mutate their existing rows; the FU-689 thesis INSERT was a one-time, owner-authorized, additive exception (existing rows proven byte-identical). All other terms (253/261/262/271/272/281 + scratch ≤343) are disposable.
- **Two-DB safety:** run integration tests on the **private** test DB `DB_NAME_TEST=scheduler_db_modz` — the default `scheduler_db_test` gets clobbered if two sessions run at once. `globalSetup` DROP+CREATE+migrate+seeds the test DB each `jest` run (the app role needs `CREATEDB`).
- **`npm run test:int` (shared DB) yields spurious failures** (files reuse term codes); the suite is meant to run **per-file isolated** via `npm run test:int:isolated`. `terms.test.js` has a known archived-schedule timing flake that passes standalone.
- **Info-only sections carry NULL `day/start_time/end_time`** (migration 025 made them nullable). Any code that slices/parses/sorts a day or time MUST tolerate null (this was the FU-690 crash class). The grid excludes info-only via `isInfoOnlyCourse`; the data table/sidebar include them.
- **`effectiveSectionType` is display-only** — never rewrites stored rows (protected terms stay byte-identical). The frontend mirror in `frontend/src/context/AppContext.jsx` MUST stay in lockstep with `backend/src/domain/exportLabels.js`.
- **Excel export legend rows are FULL-WIDTH MERGED cells** → every column returns the same text; the importer skips them via `courseCode === sectionNumber`. Don't replace that with a course-code-shape check or you'll silently drop malformed rows the validator should report.
- **Backend has NO hot reload for `npm start`** — restart after backend edits. Frontend is Vite (HMR auto-applies).

## 🧪 How to run / test right now (verified 2026-06-28)
```bash
# ---- BACKEND (cwd: backend/) ----
npm install                       # first time
npm run test:unit                 # → "Tests: 453 passed, 33 total"  (NO DB needed) ✅ verified
npm run migrate                   # apply migrations to the dev DB (incl 024/025)
npm run dev                       # dev server on :4000 (kills stale :4000 first); or: npm start
DB_NAME_TEST=scheduler_db_modz npm run test:int:isolated   # per-file isolated; needs Postgres + CREATEDB → "45 files passed, 0 failed" (this session)

# ---- FRONTEND (cwd: frontend/) ----
npm install
npm run build                     # → "✓ built"  ✅ verified
npm start                         # Vite dev server on :3000

# DB connectivity sanity (cwd: backend/): expect "dev DB OK: 1"
node -e "const{query}=require('./src/config/db');query('SELECT 1 AS ok').then(r=>console.log('dev DB OK:',r.rows[0].ok))"
```
- Login (dev): `admin1` / `password123` (also `scheduler1` / `password123`).
- API base `/api/v1`; JWT in `Authorization: Bearer …` + `X-Active-Term: <termCode>` header.
- **API contract changes this arc (additive only):** `courses.is_thesis` + `courses.is_research` flow through create/update/import/export; section `day/start/end` may be `null`; section_type adds `Sem`. No endpoint signatures changed. Frontend already mirrors all of it.

---

## 🟦 FOR CODEX — read this before writing any code
1. **Read, in order:** (1) this `HANDOFF.md` top-to-bottom, (2) `CLAUDE.md` (= `AGENTS.md`) — the operating brief, (3) `README.md` and `PER_TERM_ISOLATION_PLAN.md` (authoritative architecture). Then `git status` + `git log --oneline -12`.
2. **Do NOT touch / do NOT invent:**
   - Do **NOT** `git stash`/`reset --hard`/`checkout -- .`/`clean` — the FU-680→690 working tree is uncommitted and would be lost (⚠️1).
   - Do **NOT** mutate existing rows of terms **251/252** (protected); do **NOT** reseed the dev DB without owner say-so (you'd drop the 494/496 thesis data — ⚠️2).
   - Do **NOT** invent behavior absent from the SRS/SDD — add an open question to 🚧 instead.
   - Do **NOT** rewrite migrations `001…025` retroactively, the `effectiveSectionType` derivation contract, or the frontend↔backend API shape without recording it here.
3. **Branch + commits:** `git switch -c codex/<short-task-name>` (working-tree changes carry over — do not stash). Commit small with clear messages. Record the branch name here before you stop.
4. **Definition of done (immediate task = commit the blob, if owner authorizes):** `npm run test:unit` = 453 passed AND `DB_NAME_TEST=scheduler_db_modz npm run test:int:isolated` = 0 failed AND `cd frontend && npm run build` = ✓; FU-680→690 committed in coherent messages on a branch; this `HANDOFF.md` updated (statuses flipped, "Active agent: Codex", branch recorded) and committed. Then hand back.
