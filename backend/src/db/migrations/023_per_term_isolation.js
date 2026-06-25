// Per-term data isolation (NEW-FU-645).
//
// PROBLEM: instructors/courses/venues were a SHARED CATALOG (seeded rows have
// owner_semester = NULL = global, shared by every term) and office_hours had NO term
// scope at all (only instructor_id). So editing an instructor's office hours — or a
// course's credits, a venue's capacity, an instructor's name — in ONE term silently
// changed it in EVERY term (proven cross-term contamination).
//
// FIX (model B — per-term private copies + an inert template library):
//   • Give `courses` an `owner_semester` (instructors/venues already have it, mig 019/021),
//     drop the GLOBAL UNIQUE(course_code), add per-term + template uniques.
//   • Back-fill: for every term, materialise a PRIVATE copy (owner_semester = term) of each
//     global instructor / course / venue that term's sections reference, RE-POINT that term's
//     section FKs to the copies, and COPY each instructor's office hours onto its per-term copy.
//   • The original global rows are kept as INERT TEMPLATES (owner_semester IS NULL) — a source
//     to copy from; the application reads exclude them from term-scoped lists/conflicts.
//
// Office hours need NO column: once an instructor is per-term, office_hours.instructor_id
// already implies the term.
//
// PRESERVATION (verified on a restored copy before shipping): every term's set of
// (sections × course_code/instructor_name/venue_name/times/credits/capacity) and its
// (instructor × office-hours) are byte-for-byte identical before and after — the back-fill
// only re-points to identical-valued copies. Idempotent: re-running creates no duplicates
// because after the first run no section references a global (owner NULL) entity.

async function up(client) {
  // ── 1. courses: term scope + per-term/template uniqueness ──────────────────────────────
  await client.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS owner_semester varchar(8)`);
  await client.query(`ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_course_code_key`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_courses_code_template
                        ON courses (course_code) WHERE owner_semester IS NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_courses_code_per_term
                        ON courses (course_code, owner_semester) WHERE owner_semester IS NOT NULL`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_courses_owner ON courses (owner_semester)`);

  // ── 2. back-fill: explode the shared catalog into per-term private copies ───────────────
  await client.query(`
    DO $$
    DECLARE t RECORD; r RECORD; nid uuid;
    BEGIN
      FOR t IN SELECT id, semester FROM schedules LOOP
        -- instructors used by this term that are still GLOBAL (owner NULL)
        FOR r IN SELECT DISTINCT i.id,i.name,i.email,i.is_dummy
                 FROM sections s JOIN instructors i ON i.id = s.instructor_id
                 WHERE s.schedule_id = t.id AND i.owner_semester IS NULL LOOP
          INSERT INTO instructors (name,email,owner_semester,is_dummy)
            VALUES (r.name,r.email,t.semester,r.is_dummy) RETURNING id INTO nid;
          UPDATE sections SET instructor_id = nid WHERE schedule_id = t.id AND instructor_id = r.id;
          INSERT INTO office_hours (instructor_id,day,start_time,end_time)
            SELECT nid,day,start_time,end_time FROM office_hours WHERE instructor_id = r.id;
        END LOOP;
        -- venues used by this term that are still GLOBAL
        FOR r IN SELECT DISTINCT v.id,v.name,v.type,v.capacity,v.is_dummy
                 FROM sections s JOIN venues v ON v.id = s.venue_id
                 WHERE s.schedule_id = t.id AND v.owner_semester IS NULL LOOP
          INSERT INTO venues (name,type,capacity,owner_semester,is_dummy)
            VALUES (r.name,r.type,r.capacity,t.semester,r.is_dummy) RETURNING id INTO nid;
          UPDATE sections SET venue_id = nid WHERE schedule_id = t.id AND venue_id = r.id;
        END LOOP;
        -- courses used by this term (all global until now)
        FOR r IN SELECT DISTINCT c.id,c.course_code,c.name,c.credits,c.academic_level,
                                 c.category,c.num_sections,c.has_lab,c.is_capstone,c.is_external
                 FROM sections s JOIN courses c ON c.id = s.course_id
                 WHERE s.schedule_id = t.id AND c.owner_semester IS NULL LOOP
          INSERT INTO courses (course_code,name,credits,academic_level,category,num_sections,
                               has_lab,is_capstone,is_external,owner_semester)
            VALUES (r.course_code,r.name,r.credits,r.academic_level,r.category,r.num_sections,
                    r.has_lab,r.is_capstone,r.is_external,t.semester) RETURNING id INTO nid;
          UPDATE sections SET course_id = nid WHERE schedule_id = t.id AND course_id = r.id;
        END LOOP;
      END LOOP;
    END $$;
  `);
}

async function down(client) {
  // Best-effort reverse: re-point each per-term copy's sections back to its template
  // (same code/email/name, owner NULL), delete the copies, restore the global course unique.
  // NOTE: copies created for entities that have NO template (genuinely per-term entities added
  // AFTER this migration) cannot be reverted to a template — the authoritative recovery path
  // for those is the pre-migration pg_dump backup. This down() cleanly reverses a fresh up().
  await client.query(`
    DO $$
    DECLARE r RECORD; tmpl uuid;
    BEGIN
      -- courses
      FOR r IN SELECT id, course_code FROM courses WHERE owner_semester IS NOT NULL LOOP
        SELECT id INTO tmpl FROM courses WHERE course_code = r.course_code AND owner_semester IS NULL LIMIT 1;
        IF tmpl IS NOT NULL THEN
          UPDATE sections SET course_id = tmpl WHERE course_id = r.id;
          DELETE FROM courses WHERE id = r.id;
        END IF;
      END LOOP;
      -- instructors (templates exist for the seeded ones; dummies/new have none → left as-is)
      FOR r IN SELECT id, email FROM instructors WHERE owner_semester IS NOT NULL AND is_dummy = false LOOP
        SELECT id INTO tmpl FROM instructors WHERE email = r.email AND owner_semester IS NULL LIMIT 1;
        IF tmpl IS NOT NULL THEN
          UPDATE sections SET instructor_id = tmpl WHERE instructor_id = r.id;
          DELETE FROM instructors WHERE id = r.id;   -- OH cascades
        END IF;
      END LOOP;
      -- venues
      FOR r IN SELECT id, name FROM venues WHERE owner_semester IS NOT NULL AND is_dummy = false LOOP
        SELECT id INTO tmpl FROM venues WHERE name = r.name AND owner_semester IS NULL LIMIT 1;
        IF tmpl IS NOT NULL THEN
          UPDATE sections SET venue_id = tmpl WHERE venue_id = r.id;
          DELETE FROM venues WHERE id = r.id;
        END IF;
      END LOOP;
    END $$;
  `);
  await client.query(`DROP INDEX IF EXISTS uq_courses_code_per_term`);
  await client.query(`DROP INDEX IF EXISTS uq_courses_code_template`);
  await client.query(`DROP INDEX IF EXISTS idx_courses_owner`);
  await client.query(`ALTER TABLE courses DROP COLUMN IF EXISTS owner_semester`);
  await client.query(`ALTER TABLE courses ADD CONSTRAINT courses_course_code_key UNIQUE (course_code)`);
}

module.exports = { up, down };
