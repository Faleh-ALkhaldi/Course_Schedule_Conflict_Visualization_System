// NEW-FU-690 follow-up: normalize existing info-only activity data.
//
// Earlier migrations added the is_thesis / is_research flags and allowed NULL
// section meeting fields, but existing databases could already contain registrar
// Thesis/Summer Training rows that had been treated as lectures. This migration
// is intentionally conservative and idempotent:
//   - derive only clear Thesis / Research / Summer Training / Internship course flags;
//   - collapse stale multi-day artifacts to one side-panel row per section/instructor;
//   - clear day/time/venue for info-only sections;
//   - never rewrite protected term 251/252 section rows.

async function up(client) {
  await client.query(`
    UPDATE courses
       SET is_thesis = true,
           is_research = false,
           is_capstone = false,
           has_lab = false
     WHERE (owner_semester IS NULL OR owner_semester NOT IN ('251', '252'))
       AND lower(name) ~ '(^|[^a-z])thesis([^a-z]|$)'
       AND COALESCE(is_external, false) = false
       AND COALESCE(is_seminar, false) = false
       AND (
         is_thesis IS DISTINCT FROM true OR
         is_research IS DISTINCT FROM false OR
         is_capstone IS DISTINCT FROM false OR
         has_lab IS DISTINCT FROM false
       )`);

  await client.query(`
    UPDATE courses
       SET is_research = true,
           is_thesis = false,
           is_capstone = false,
           has_lab = false
     WHERE (owner_semester IS NULL OR owner_semester NOT IN ('251', '252'))
       AND lower(name) ~ '(^|[^a-z])research([^a-z]|$)'
       AND lower(name) !~ '(^|[^a-z])thesis([^a-z]|$)'
       AND COALESCE(is_external, false) = false
       AND COALESCE(is_seminar, false) = false
       AND (
         is_research IS DISTINCT FROM true OR
         is_thesis IS DISTINCT FROM false OR
         is_capstone IS DISTINCT FROM false OR
         has_lab IS DISTINCT FROM false
       )`);

  await client.query(`
    UPDATE courses
       SET is_external = true,
           is_thesis = false,
           is_research = false,
           is_capstone = false,
           has_lab = false
     WHERE (owner_semester IS NULL OR owner_semester NOT IN ('251', '252'))
       AND (
         course_code = 'SWE 399' OR
         lower(name) LIKE '%summer training%' OR
         lower(name) LIKE '%internship%'
       )
       AND COALESCE(is_seminar, false) = false
       AND (
         is_external IS DISTINCT FROM true OR
         is_thesis IS DISTINCT FROM false OR
         is_research IS DISTINCT FROM false OR
         is_capstone IS DISTINCT FROM false OR
         has_lab IS DISTINCT FROM false
       )`);

  await client.query(`
    WITH ranked AS (
      SELECT s.id,
             row_number() OVER (
               PARTITION BY s.schedule_id, s.course_id, s.section_number, COALESCE(s.gender, 'M'), s.instructor_id
               ORDER BY
                 CASE WHEN s.day IS NULL AND s.start_time IS NULL AND s.end_time IS NULL THEN 0 ELSE 1 END,
                 s.id
             ) AS rn
        FROM sections s
        JOIN schedules sc ON sc.id = s.schedule_id
        JOIN courses c ON c.id = s.course_id
       WHERE sc.semester NOT IN ('251', '252')
         AND (COALESCE(c.is_external, false) OR COALESCE(c.is_thesis, false) OR COALESCE(c.is_research, false))
    )
    DELETE FROM sections s
     USING ranked r
     WHERE s.id = r.id
       AND r.rn > 1`);

  await client.query(`
    UPDATE sections s
       SET day = NULL,
           start_time = NULL,
           end_time = NULL,
           venue_id = NULL,
           section_type = CASE WHEN c.is_thesis THEN 'Ths' ELSE 'Lec' END
      FROM schedules sc, courses c
     WHERE sc.id = s.schedule_id
       AND c.id = s.course_id
       AND sc.semester NOT IN ('251', '252')
       AND (COALESCE(c.is_external, false) OR COALESCE(c.is_thesis, false) OR COALESCE(c.is_research, false))
       AND (
         s.day IS NOT NULL OR
         s.start_time IS NOT NULL OR
         s.end_time IS NOT NULL OR
         s.venue_id IS NOT NULL OR
         s.section_type IS DISTINCT FROM CASE WHEN c.is_thesis THEN 'Ths' ELSE 'Lec' END
       )`);
}

async function down() {
  // Irreversible data repair: meeting times removed here were stale lecture
  // artifacts for information-only activities, not source-of-truth registrar data.
}

module.exports = { up, down };
