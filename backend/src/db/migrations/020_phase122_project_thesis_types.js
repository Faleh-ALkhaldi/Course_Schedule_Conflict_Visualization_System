// NEW-FU-498 (Phase 122): add 'Prj' (Project) and 'Ths' (Thesis) section types,
// matching the KFUPM registrar's PRJ / THS activities (capstone projects like
// SWE 412/413/414, thesis courses like SWE 494/496).
//
// Widens two CHECK constraints (never edits the original migrations 009/010):
//   sections_section_type_check              — allow 'Prj','Ths' (was 'Lec','Lab' only)
//   sections_section_number_type_scoped_chk  — Prj/Ths share the Lec 01–49 number range
//
// section_type is VARCHAR(3), so 'Prj'/'Ths' already fit. Purely permissive —
// no existing rows change; nothing is re-typed by this migration.

async function up(client) {
  await client.query(`ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_section_type_check`);
  await client.query(`
    ALTER TABLE sections ADD CONSTRAINT sections_section_type_check
      CHECK (section_type IN ('Lec', 'Lab', 'Prj', 'Ths'))`);

  await client.query(`ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_section_number_type_scoped_chk`);
  await client.query(`
    ALTER TABLE sections ADD CONSTRAINT sections_section_number_type_scoped_chk
      CHECK (
        (section_type = 'Lec'              AND section_number ~ '^(0[1-9]|[1-4][0-9])$') OR
        (section_type = 'Lab'              AND section_number ~ '^[5-9][0-9]$')          OR
        (section_type IN ('Prj', 'Ths')    AND section_number ~ '^(0[1-9]|[1-4][0-9])$')
      )`);
}

async function down(client) {
  // Revert to Lec/Lab only. (Will fail if any Prj/Ths rows still exist — re-type
  // them to Lec first, as you would before rolling this back.)
  await client.query(`ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_section_number_type_scoped_chk`);
  await client.query(`
    ALTER TABLE sections ADD CONSTRAINT sections_section_number_type_scoped_chk
      CHECK (
        (section_type = 'Lec' AND section_number ~ '^(0[1-9]|[1-4][0-9])$') OR
        (section_type = 'Lab' AND section_number ~ '^[5-9][0-9]$')
      )`);
  await client.query(`ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_section_type_check`);
  await client.query(`
    ALTER TABLE sections ADD CONSTRAINT sections_section_type_check
      CHECK (section_type IN ('Lec', 'Lab'))`);
}

module.exports = { up, down };
