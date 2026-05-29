// NEW-FU-92: Feature wave migration combining three coordinated schema
// changes (kept in one migration so the up/down semantics are atomic):
//
//   1. courses.has_lab            — whether the course has lab sections at all
//   2. sections.section_type      — 'Lec' or 'Lab' per section
//   3. sections.section_number    — normalized to two-digit '01'..'99'
//                                   format + CHECK constraint enforces it
//
// Sections that previously had non-conforming numbers (e.g., 'A', 'B', 'Z1')
// are renumbered in-place. Siblings (same schedule + course + old section
// number, different days) keep the same NEW number so STT/MW groups stay
// together. The renumbering uses DENSE_RANK to assign one new number per
// distinct old number within each (schedule, course) scope.
//
// Down: drops the CHECK constraints + columns. The renumbering itself is
// NOT reversed (we don't have a record of the original letters); down's
// job is to undo the schema change, not to restore an irrecoverable prior
// labelling.

async function up(client) {
  // ── 1. courses.has_lab ──────────────────────────────────────────────────
  await client.query(`
    ALTER TABLE courses
      ADD COLUMN has_lab BOOLEAN NOT NULL DEFAULT FALSE
  `);

  // ── 2. sections.section_type ────────────────────────────────────────────
  // Default 'Lec' so every existing section becomes a lecture by default —
  // we'll mark specific lab sections in seed.js. The CHECK constraint pins
  // the allowed values to match SECTION_TYPE in config/constants.js.
  await client.query(`
    ALTER TABLE sections
      ADD COLUMN section_type VARCHAR(3) NOT NULL DEFAULT 'Lec'
        CHECK (section_type IN ('Lec', 'Lab'))
  `);

  // ── 3. section_number — renumber existing rows then add CHECK ──────────
  // Use DENSE_RANK so each distinct OLD section_number within a
  // (schedule_id, course_id) gets a single NEW number. Multi-day siblings
  // share the same old number → same new number → group integrity preserved.
  //
  // The ORDER BY uses the old section_number string itself so the rename
  // is deterministic (alphabetical: 'A'→01, 'B'→02, 'C'→03). If a schedule
  // already had numeric numbers like '1' or '10', they sort lexically; the
  // renumbering still produces valid 01..99 strings.
  await client.query(`
    WITH ranked AS (
      SELECT DISTINCT
        schedule_id, course_id, section_number,
        LPAD(
          DENSE_RANK() OVER (
            PARTITION BY schedule_id, course_id
            ORDER BY section_number
          )::text,
          2, '0'
        ) AS new_section_number
      FROM sections
    )
    UPDATE sections AS s
    SET section_number = r.new_section_number
    FROM ranked r
    WHERE s.schedule_id    = r.schedule_id
      AND s.course_id      = r.course_id
      AND s.section_number = r.section_number
  `);

  // Now enforce the format. Regex matches '01'..'09' OR '10'..'99'.
  // Excludes '00' and anything that isn't exactly two ASCII digits.
  await client.query(`
    ALTER TABLE sections
      ADD CONSTRAINT sections_section_number_format_chk
      CHECK (section_number ~ '^(0[1-9]|[1-9][0-9])$')
  `);
}

async function down(client) {
  // Drop additions in reverse order. The renumbered section_number values
  // remain — restoring the original letters would require a backup we
  // didn't capture.
  await client.query(`
    ALTER TABLE sections
      DROP CONSTRAINT IF EXISTS sections_section_number_format_chk
  `);
  await client.query(`
    ALTER TABLE sections
      DROP COLUMN IF EXISTS section_type
  `);
  await client.query(`
    ALTER TABLE courses
      DROP COLUMN IF EXISTS has_lab
  `);
}

module.exports = { up, down };
