// NEW-FU-692 (Phase 129): repair Seminar course data and harden the course rule.
//
// Earlier code added the Seminar section type and course flag, but existing databases could
// still have SWE 599 / Seminar rows stored as ordinary 3-credit lectures. That bypassed every
// Seminar-specific validator and made the UI offer lecture-style multi-day / 50-minute choices.
//
// This repair is conservative and idempotent:
//   - mark clear Seminar courses as Graduate, 1-credit, is_seminar=true;
//   - keep protected terms 251/252 untouched;
//   - collapse stale multi-day Seminar artifacts to one scheduled row per logical section;
//   - store Seminar sections as section_type='Sem' with a 75-minute duration when a start time exists;
//   - add a NOT VALID DB check so future inserts/updates cannot persist non-1-credit Seminars.

async function up(client) {
  await client.query(`
    UPDATE courses
       SET credits = 1,
           academic_level = 'Graduate',
           category = 'GR',
           has_lab = false,
           is_capstone = false,
           is_external = false,
           is_thesis = false,
           is_research = false,
           is_seminar = true
     WHERE (owner_semester IS NULL OR owner_semester NOT IN ('251', '252'))
       AND (
         course_code = 'SWE 599' OR
         (course_code ~ '^SWE [56][0-9]{2}$' AND lower(name) ~ '(^|[^a-z])seminar([^a-z]|$)')
       )
       AND (
         credits IS DISTINCT FROM 1 OR
         academic_level IS DISTINCT FROM 'Graduate' OR
         category IS DISTINCT FROM 'GR' OR
         has_lab IS DISTINCT FROM false OR
         is_capstone IS DISTINCT FROM false OR
         is_external IS DISTINCT FROM false OR
         is_thesis IS DISTINCT FROM false OR
         is_research IS DISTINCT FROM false OR
         is_seminar IS DISTINCT FROM true
       )`);

  await client.query(`
    UPDATE sections s
       SET section_type = 'Sem'
      FROM schedules sc, courses c
     WHERE sc.id = s.schedule_id
       AND c.id = s.course_id
       AND sc.semester NOT IN ('251', '252')
       AND COALESCE(c.is_seminar, false)
       AND s.section_type IS DISTINCT FROM 'Sem'`);

  await client.query(`
    WITH ranked AS (
      SELECT s.id,
             row_number() OVER (
               PARTITION BY s.schedule_id, s.course_id, s.section_number, COALESCE(s.gender, 'M')
               ORDER BY
                 CASE WHEN s.day IS NOT NULL AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL THEN 0 ELSE 1 END,
                 CASE WHEN s.venue_id IS NOT NULL THEN 0 ELSE 1 END,
                 CASE WHEN s.instructor_id IS NOT NULL THEN 0 ELSE 1 END,
                 CASE
                   WHEN s.start_time IS NOT NULL AND s.end_time IS NOT NULL
                    AND EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 60 = 75
                   THEN 0 ELSE 1
                 END,
                 CASE s.day
                   WHEN 'Sunday' THEN 0
                   WHEN 'Monday' THEN 1
                   WHEN 'Tuesday' THEN 2
                   WHEN 'Wednesday' THEN 3
                   WHEN 'Thursday' THEN 4
                   ELSE 5
                 END,
                 s.start_time NULLS LAST,
                 s.id
             ) AS rn
        FROM sections s
        JOIN schedules sc ON sc.id = s.schedule_id
        JOIN courses c ON c.id = s.course_id
       WHERE sc.semester NOT IN ('251', '252')
         AND COALESCE(c.is_seminar, false)
    )
    DELETE FROM sections s
     USING ranked r
     WHERE s.id = r.id
       AND r.rn > 1`);

  await client.query(`
    UPDATE sections s
       SET section_type = 'Sem',
           start_time = CASE
             WHEN s.start_time IS NOT NULL AND s.start_time + interval '75 minutes' > time '22:00'
               THEN time '22:00' - interval '75 minutes'
             ELSE s.start_time
           END,
           end_time = CASE
             WHEN s.start_time IS NOT NULL AND s.start_time + interval '75 minutes' > time '22:00'
               THEN time '22:00'
             WHEN s.start_time IS NOT NULL THEN s.start_time + interval '75 minutes'
             ELSE s.end_time
           END
      FROM schedules sc, courses c
     WHERE sc.id = s.schedule_id
       AND c.id = s.course_id
       AND sc.semester NOT IN ('251', '252')
       AND COALESCE(c.is_seminar, false)
       AND (
         s.section_type IS DISTINCT FROM 'Sem' OR
         (
           s.start_time IS NOT NULL AND s.end_time IS NOT NULL
           AND EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 60 IS DISTINCT FROM 75
         ) OR (
           s.start_time IS NOT NULL AND s.start_time + interval '75 minutes' > time '22:00'
         )
       )`);

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'courses_seminar_course_rule_chk'
      ) THEN
        ALTER TABLE courses
          ADD CONSTRAINT courses_seminar_course_rule_chk
          CHECK (
            COALESCE(is_seminar, false) = false OR
            (
              credits = 1 AND
              academic_level = 'Graduate' AND
              category = 'GR' AND
              course_code ~ '^SWE [56][0-9]{2}$'
            )
          ) NOT VALID;
      END IF;
    END $$`);
}

async function down(client) {
  await client.query(`
    ALTER TABLE courses
      DROP CONSTRAINT IF EXISTS courses_seminar_course_rule_chk`);
  // Data repair is intentionally not reversed.
}

module.exports = { up, down };
