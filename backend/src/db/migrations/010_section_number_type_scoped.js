// NEW-FU-105: type-scoped section_number ranges.
//
// Lecture sections (section_type='Lec') take numbers '01'..'49'.
// Lab sections     (section_type='Lab') take numbers '50'..'99'.
// The two ranges are disjoint by design — Lec and Lab of the same course
// can never share a section_number, removing the prior ambiguity (the seed
// previously had SWE206 Lec §01 AND Lab §01 sharing the number, distinguished
// only by day and type).
//
// This migration:
//   1. Renumbers any existing Lab sections whose section_number is in the
//      Lec range (01..49) up to the Lab range (50..). DENSE_RANK preserves
//      group identity: all rows of the same (schedule, course) old Lab
//      section_number get the same new number.
//   2. Drops the old format CHECK constraint added in migration 009.
//   3. Adds a new constraint that enforces BOTH the format AND the type-
//      scoped range in one predicate.
//
// Down reverses the schema changes (the renumber is preserved — restoring
// the original Lab numbers from '50'+ back to whatever they were before
// would require a backup we didn't capture, and there's nothing meaningful
// for a "down" to restore since the prior state was the pre-feature schema
// that allowed any '01'..'99' regardless of type).

async function up(client) {
  // ── Step 1: renumber Lab sections that violate the new range ────────────
  // For each (schedule_id, course_id), if there are Lab rows with
  // section_number < '50', DENSE_RANK them starting at 50.
  // The OFFSET (49 +) makes rank-1 → 50, rank-2 → 51, etc.
  // Rows already in the Lab range stay put.
  await client.query(`
    WITH old_lab_groups AS (
      SELECT DISTINCT schedule_id, course_id, section_number
      FROM sections
      WHERE section_type = 'Lab' AND section_number !~ '^[5-9][0-9]$'
    ),
    ranked AS (
      SELECT
        schedule_id, course_id, section_number,
        LPAD(
          (49 + DENSE_RANK() OVER (
             PARTITION BY schedule_id, course_id
             ORDER BY section_number
          ))::text,
          2, '0'
        ) AS new_num
      FROM old_lab_groups
    )
    UPDATE sections s
    SET section_number = r.new_num
    FROM ranked r
    WHERE s.schedule_id    = r.schedule_id
      AND s.course_id      = r.course_id
      AND s.section_number = r.section_number
      AND s.section_type   = 'Lab'
  `);

  // ── Step 2: also renumber Lec sections that somehow ended up in 50..99 ──
  // (Unlikely under the prior seed, but defensive.) DENSE_RANK starting at 1.
  await client.query(`
    WITH old_lec_groups AS (
      SELECT DISTINCT schedule_id, course_id, section_number
      FROM sections
      WHERE section_type = 'Lec' AND section_number !~ '^(0[1-9]|[1-4][0-9])$'
    ),
    ranked AS (
      SELECT
        schedule_id, course_id, section_number,
        LPAD(
          DENSE_RANK() OVER (
            PARTITION BY schedule_id, course_id
            ORDER BY section_number
          )::text,
          2, '0'
        ) AS new_num
      FROM old_lec_groups
    )
    UPDATE sections s
    SET section_number = r.new_num
    FROM ranked r
    WHERE s.schedule_id    = r.schedule_id
      AND s.course_id      = r.course_id
      AND s.section_number = r.section_number
      AND s.section_type   = 'Lec'
  `);

  // ── Step 3: replace the old (format-only) CHECK with the type-scoped one ─
  await client.query(`
    ALTER TABLE sections
      DROP CONSTRAINT IF EXISTS sections_section_number_format_chk
  `);
  await client.query(`
    ALTER TABLE sections
      ADD CONSTRAINT sections_section_number_type_scoped_chk
      CHECK (
        (section_type = 'Lec' AND section_number ~ '^(0[1-9]|[1-4][0-9])$')
        OR
        (section_type = 'Lab' AND section_number ~ '^[5-9][0-9]$')
      )
  `);
}

async function down(client) {
  // Restore the FU-92 format-only constraint and drop the type-scoped one.
  // The Lab renumbering remains (irrecoverable without a backup).
  await client.query(`
    ALTER TABLE sections
      DROP CONSTRAINT IF EXISTS sections_section_number_type_scoped_chk
  `);
  await client.query(`
    ALTER TABLE sections
      ADD CONSTRAINT sections_section_number_format_chk
      CHECK (section_number ~ '^(0[1-9]|[1-9][0-9])$')
  `);
}

module.exports = { up, down };
