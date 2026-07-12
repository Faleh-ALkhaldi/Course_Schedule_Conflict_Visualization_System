// NEW-FU-688 (Phase 126): the richer registrar Activity model.
//
// Three permissive, NON-destructive schema changes (no existing row's data is altered, so protected
// terms stay byte-identical):
//
//   1. INFO-ONLY (time-less) sections — internships (Summer Training / Internship), thesis, research,
//      and untimed projects exist as side-panel INFORMATION with NO meeting time or place. They are
//      never drawn in the schedule grid. To store such a section we relax NOT NULL on day/start/end and
//      make the "end after start" CHECK tolerate a missing time. (Existing rows all carry times, so the
//      column data is unchanged; only future rows may omit a time.)
//   2. SEM section type — a Seminar meeting (single day, 75–160 min). Widen the section_type CHECK to
//      allow 'Sem' (shares the Lec 01–49 number range), in the exact style of migration 020.
//   3. RES flag — courses.is_research, the Research sibling of Thesis (same full time/place exemption,
//      distinct meaning). Additive NOT NULL DEFAULT false, like migration 024's is_thesis.

async function up(client) {
  // 1. time-less (info-only) sections
  await client.query(`ALTER TABLE sections ALTER COLUMN day        DROP NOT NULL`);
  await client.query(`ALTER TABLE sections ALTER COLUMN start_time DROP NOT NULL`);
  await client.query(`ALTER TABLE sections ALTER COLUMN end_time   DROP NOT NULL`);
  // The original migration-006 CHECK (end_time > start_time) rejects NULLs implicitly only when one side
  // is present; make it explicitly NULL-tolerant so a time-less section is legal.
  await client.query(`ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_check`);            // unnamed end>start check (pg default name varies)
  await client.query(`ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_end_after_start_chk`);
  await client.query(`
    ALTER TABLE sections ADD CONSTRAINT sections_end_after_start_chk
      CHECK (start_time IS NULL OR end_time IS NULL OR end_time > start_time)`);

  // 2. SEM section type (Seminar) — share the Lec 01–49 number range
  await client.query(`ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_section_type_check`);
  await client.query(`
    ALTER TABLE sections ADD CONSTRAINT sections_section_type_check
      CHECK (section_type IN ('Lec', 'Lab', 'Prj', 'Ths', 'Sem'))`);
  await client.query(`ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_section_number_type_scoped_chk`);
  await client.query(`
    ALTER TABLE sections ADD CONSTRAINT sections_section_number_type_scoped_chk
      CHECK (
        (section_type = 'Lab'                       AND section_number ~ '^[5-9][0-9]$') OR
        (section_type IN ('Lec','Prj','Ths','Sem')  AND section_number ~ '^(0[1-9]|[1-4][0-9])$')
      )`);

  // 3. RES flag
  await client.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_research BOOLEAN NOT NULL DEFAULT false`);
}

async function down(client) {
  await client.query(`ALTER TABLE courses DROP COLUMN IF EXISTS is_research`);
  // revert section_type to Lec/Lab/Prj/Ths (fails if any 'Sem' rows remain — re-type them first)
  await client.query(`ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_section_number_type_scoped_chk`);
  await client.query(`
    ALTER TABLE sections ADD CONSTRAINT sections_section_number_type_scoped_chk
      CHECK (
        (section_type = 'Lab'             AND section_number ~ '^[5-9][0-9]$') OR
        (section_type IN ('Lec','Prj','Ths') AND section_number ~ '^(0[1-9]|[1-4][0-9])$')
      )`);
  await client.query(`ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_section_type_check`);
  await client.query(`
    ALTER TABLE sections ADD CONSTRAINT sections_section_type_check
      CHECK (section_type IN ('Lec', 'Lab', 'Prj', 'Ths'))`);
  // NOTE: re-imposing NOT NULL on day/start/end is intentionally NOT done here — a down-migration must
  // not fail on legitimately time-less rows created while this was live.
}

module.exports = { up, down };
