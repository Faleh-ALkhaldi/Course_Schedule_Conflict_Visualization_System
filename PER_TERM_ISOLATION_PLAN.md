# Per-Term Data Isolation — Migration & Code-Change Plan

**Status:** PLAN ONLY. No schema/DB changes have been run. Goal = each term is a fully
independent sandbox: an instructor, their office hours, every course, every venue, and every
section belong to exactly ONE term and can never be read or mutated through another term.

---

## 1. Diagnosis (verified against live schema + a live two-term repro)

Today the system is a **shared catalog**:

| Entity | Scope today | Leak |
|---|---|---|
| `office_hours` (`003_instructors.js:15`) | **none** — only `instructor_id`, no term column | **PROVEN**: editing OH "in term A" appears in term B (read via A-header == read via B-header). Fully global per instructor. |
| `courses` (`002_courses.js`) | **none** — no `owner_semester`; `course_code` is GLOBALLY UNIQUE | one global row per code, shared by all terms; editing credits/name/level/has_lab leaks (and `revalidateSchedulesForResource` re-validates ALL terms). |
| `instructors` / `venues` | **partial** — `owner_semester` exists (mig 019/021); **seed rows = NULL = global** | seeded catalog shared across all terms; editing a seeded name/email/capacity leaks. Only *newly-created* rows (stamped `owner_semester`) are isolated. |
| `sections` (`006`) | **term** — `schedule_id` | already isolated ✓ |

**Key insight for the fix:** office hours, and every section FK, reference an *instructor/course/venue
id*. If those three entities become **per-term private copies**, then:
- `office_hours.instructor_id` already points at a term-specific instructor → **OH is per-term automatically** (no OH schema change, no copy-on-write).
- `sections.course_id/instructor_id/venue_id` point at term-private rows → sections stay isolated.

So the whole fix reduces to: **explode the shared catalog (instructors/courses/venues) into per-term
private copies, re-point each term's sections + office hours to its own copies, and scope every read
to the active term.**

---

## 2. Target architecture

Two viable models — **recommend (B)**:

- **(A) Pure isolation, no catalog.** Every instructor/course/venue is `owner_semester NOT NULL`.
  Adding an entity to a term always creates a fresh private row. Simple invariant, but loses the
  "pick an existing professor/course/room" convenience and forces re-typing across terms; the seed
  and Suggest's `scope=catalog` lose their source.
- **(B) Per-term private copies + a read-only TEMPLATE LIBRARY (recommended).** Keep the catalog rows
  as **templates** (`owner_semester IS NULL`), but templates are NEVER used directly in any term —
  they are excluded from every term-scoped read, every conflict evaluation, every coverage flag. They
  exist only as a *source to copy from* when a user adds an instructor/course/venue to a term, which
  always materialises a private `owner_semester = <term>` copy. This gives complete isolation
  (editing/deleting a term's copy touches nothing else) while preserving the seed, the "add existing"
  UX, and Suggest's catalog browsing. It is also the *least* disruptive to the current code, which
  already has the `owner_semester` machinery and `findAssignable(term)`.

The rest of this plan assumes **(B)**.

Invariants after the change:
- Every entity a term actually USES has `owner_semester = that term`. Templates (`NULL`) are inert.
- Term-scoped reads return ONLY `owner_semester = activeTerm` (drop the `OR owner_semester IS NULL`
  fallback for the *working* lists; the template library is a separate, explicit `scope=catalog` read).
- Office hours follow their (now term-private) instructor — no OH-table change required.

---

## 3. Schema migration (additive first, reversible)

New migration `023_per_term_courses.js` (+ a back-fill migration `024`):

```sql
-- 023: give courses a term scope + per-term uniqueness (alongside the existing global one).
ALTER TABLE courses ADD COLUMN IF NOT EXISTS owner_semester varchar(8);
-- per-term code uniqueness for the private copies; keep the global one for templates (owner NULL)
ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_course_code_key;       -- the global UNIQUE
CREATE UNIQUE INDEX IF NOT EXISTS uq_courses_code_template
  ON courses (course_code) WHERE owner_semester IS NULL;                     -- templates stay unique
CREATE UNIQUE INDEX IF NOT EXISTS uq_courses_code_per_term
  ON courses (course_code, owner_semester) WHERE owner_semester IS NOT NULL; -- one per code per term
CREATE INDEX IF NOT EXISTS idx_courses_owner ON courses (owner_semester);
-- instructors/venues already have owner_semester + the per-term uniques (mig 021); no DDL needed.
-- office_hours: NO change (instructor_id becomes term-private via the back-fill).
```

`down()` drops the new indexes/column and restores `courses_course_code_key` (clean on a fresh
install where every code is globally unique).

---

## 4. Back-fill (the high-risk step — do on a RESTORED COPY first, then dev)

Migration `024_explode_catalog_per_term.js`, ONE transaction, idempotent. For each schedule/term `T`
and each GLOBAL (owner NULL) entity referenced by `T`'s sections, create a private copy, re-point
`T`'s sections, and copy the instructor's office hours. Pseudocode/SQL:

```sql
-- For every (term, global-instructor used by that term): make a private copy + remap sections + OH.
-- Repeat the analogous block for venues and courses.
WITH used AS (
  SELECT DISTINCT sch.semester AS term, i.id AS old_id
  FROM sections sec JOIN schedules sch ON sch.id = sec.schedule_id
  JOIN instructors i ON i.id = sec.instructor_id
  WHERE i.owner_semester IS NULL
), made AS (
  INSERT INTO instructors (name, email, owner_semester, is_dummy)
  SELECT i.name, i.email, u.term, i.is_dummy FROM used u JOIN instructors i ON i.id = u.old_id
  RETURNING id AS new_id, email, owner_semester AS term       -- (email+term is unique → safe key back)
)
-- remap this term's sections to the new private instructor
UPDATE sections s SET instructor_id = m.new_id
FROM made m, schedules sch
WHERE s.schedule_id = sch.id AND sch.semester = m.term
  AND s.instructor_id IN (SELECT old_id FROM used WHERE term = m.term ...by email...);
-- copy the global instructor's office hours onto each new per-term instructor
INSERT INTO office_hours (instructor_id, day, start_time, end_time)
SELECT m.new_id, oh.day, oh.start_time, oh.end_time
FROM made m JOIN instructors gi ON gi.email = m.email AND gi.owner_semester IS NULL
            JOIN office_hours oh ON oh.instructor_id = gi.id;
```
(The real migration threads a temporary `old_id → new_id` mapping table per term rather than the
email-rejoin shorthand above, so it is exact and re-runnable. Courses map by `course_code`, venues by
`name`.) After every term has private copies:
- Office hours on the now-unused **template** instructors stay attached to the template (inert).
- The shared global rows are NOT deleted (model B keeps them as templates). If model (A) is chosen
  instead, add a final `DELETE` of any global row no longer referenced by any section.

**Preservation guarantee to verify:** for each of the 8 protected terms, the set of
(sections, their instructor/course/venue values, office hours, conflict counts) must be byte-for-byte
identical before and after. This is a pure re-pointing to identical-valued copies, so it must hold —
and the test in §6 asserts it.

---

## 5. Code changes by layer (from the verified inventory)

### Repositories
- `InstructorRepository.findAll(term)` (`:10`) / `findAssignable` (`:45`) and `VenueRepository.findAll`
  (`repositories.js:167`) / `findAssignable` (`:216`): **drop the `OR owner_semester IS NULL` term
  fallback** for the working lists (templates must not appear in a term). Add a separate explicit
  `findTemplates()` for the catalog browser.
- `CourseRepository.findAll(term)` (`:279`): change from "courses with a section in term" to
  `WHERE owner_semester = $1`; add `findTemplates()` (`owner_semester IS NULL`) for `scope=catalog`.
- `create` for all three: **stamp `owner_semester`** (courses currently don't — add it).
- `findById` / `update` / `delete` (by id): unchanged — ids are now term-private, so by-id is safe.

### Controllers (`controllers/index.js`)
- `getInstructors` (`:1318`) / `getVenues` (`:1703`): require a term (reject/empty when none); never
  return templates.
- `getCourses` (`:1140`): `scope=catalog` → `findTemplates()`; default → `findAll(term)`
  (`owner_semester`-scoped, not section-join).
- `createCourse` (`:1170`): stamp `owner_semester` from `req.activeTerm`.
- Dup-checks `crossTermResourceError` (`:293`) + email/name probes (`:1436`, `:1789`): scope to the
  active term only (drop the global-NULL branch).
- `getScheduleCoverage` (`:251`): the `SELECT DISTINCT instructor_id FROM office_hours` becomes a JOIN
  to `instructors` filtered to the schedule's term (so OH coverage is per-term).
- `suggestedOfficeHour` (`:1380`): scope the day-histogram to the active term (or keep generic — it's
  only a default-time hint; low priority).
- `createInstructor` auto-seed OH (`:1454`): unchanged in shape — the instructor is already
  term-stamped, so its seeded OH is term-private by FK.
- `previewConflicts` (`:806`) / `autoFixAround` (`:949`): id lookups for course/venue/instructor stay
  by-id (term-private now); the `ohMap` load by `instructor_id` is now naturally per-term.

### Services
- `ScheduleService._evaluateSchedule` ohMap (`:751`), R-13 (`:991`), R-04/R-05 augment (`:808`):
  no change — `instructor_id` is term-private, so the ohMap is already term-correct (this is what
  fixes R-13's "OH seeded in another term suppresses the flag" symptom).
- `ScheduleService` fix-candidate pools `findAssignable(term)` (`:787`): now strictly term-scoped.
- `SuggestService` `findAssignable` (`:972`) + venue pool (`:1015`) + course pool (`:936`): term-scoped;
  the cross-term "prior-instructor specialist history" query (`:988`) is a deliberate read-only signal —
  keep but document (it reads other terms' *sections* for scoring, never mutates).
- `QuickFixService` pools (`:1719`) + by-id course/section loads: term-private by construction.
- `ExportService.importBuffer` upserts (`:399` course, `:471` instructor, `:507` venue): stamp
  `owner_semester = importTerm`; course `ON CONFLICT (course_code)` → `ON CONFLICT (course_code,
  owner_semester)`; never read/update templates or other terms.
- `TermService.copyTerm` (`:352`): currently SHARES `course_id` across terms — change to **copy
  courses too** (create term-private copies + remap `course_id`), matching the instructor/venue dummy
  remap it already does.
- `TermService.deleteTerm` (`:566`): add an explicit term-scoped delete of that term's private
  instructors/courses/venues (+ their OH cascades); never touch templates or other terms.
- `domain/dummyResources.nextDummyVenueName` (`:63`): global name scan can become per-term (names are
  unique per term now) — minor.

### Frontend (`frontend/src/`)
- `AppContext.addCourse` (`:701`): inject `ownerSemester: schedule.semester` (parity with
  add instructor/venue at `:592`/`:680`).
- `api.getInstructors`/`getVenues` (`api/index.js:113-114`): always send `?term` (the no-arg
  header-only fallback should go once the backend stops returning a global list).
- `ExportModal` post-import `loadReference()` (`:157`): pass `schedule.semester`.
- `SuggestModal` `getCourses(undefined,{scope:'catalog'})` (`:257`): semantics become "template
  library"; picking a catalog course materialises a per-term copy on add (the add flow already POSTs
  to the term).
- Office-hours endpoints/components: no change (instructor_id is term-private).

### Seed (`db/seed.js`)
- Reshape to create the **template library** (owner NULL) AND per-term private copies for each seeded
  term, with each term's sections/OH pointing at its own copies. Largest single reshape; gate behind
  the new model so a fresh `npm run seed` produces an already-isolated DB.

---

## 6. Test strategy (regression — isolation proof is mandatory)
- **Cross-term isolation integration test** (new, mandatory): create two scratch terms that both add
  the "same" instructor/course/venue (by name/code); edit/add/delete an office hour + an instructor
  field + a course attribute + a venue attribute in term A; assert term B is byte-for-byte unchanged;
  and vice-versa. Run on the test DB.
- **Back-fill preservation test**: snapshot each of the 8 protected terms (sections + entity values +
  OH + conflict counts) before; run migration on a restored copy; assert identical after.
- **Unit**: repo scoping (findAll/findAssignable return no templates for a term; create stamps owner),
  pure logic via node scripts. Keep all 239 existing unit tests green.

## 7. Rollout (staged, reversible, protected-data-safe)
0. `pg_dump` the dev DB → timestamped backup. Restore it into a scratch DB and run EVERYTHING below
   there first; only touch the real dev DB after the scratch run proves preservation.
1. Apply schema migration 023 (additive).
2. Apply back-fill 024 on the scratch copy → run the §6 preservation snapshot diff → must be identical.
3. Land the code changes (repos→controllers→services→frontend), restart backend, run unit tests.
4. Re-run isolation + preservation tests on scratch.
5. Only then: backup dev, apply 023+024 to dev, restart backend, re-verify all 8 protected terms
   unchanged, hard-refresh.
6. (Optional, model A only) drop now-orphaned global rows.

## 8. Risks
- Re-keying section FKs in the back-fill is destructive if wrong → mitigated by backup + scratch-first
  + per-term transaction + snapshot diff + reversible additive schema.
- Suggest/QuickFix/import/coverage all assume the catalog → covered above but need thorough testing.
- The seed reshape is large; a wrong seed makes a fresh install look broken (not a data-loss risk).
- Model decision (A pure vs B template-library) is a product call that changes the "add existing
  instructor/course/room" UX — recommend **B**.

## 9. Estimated size
~2 new migrations, ~3 repo files, ~10 controller endpoints, ~4 services, ~5 frontend files, the seed,
and a new integration test. Best landed in the staged order above, verifying preservation at each step.
