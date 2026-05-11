async function up(client) {
  // Drop the old constraint that doesn't include day
  await client.query(`
    ALTER TABLE sections
    DROP CONSTRAINT IF EXISTS sections_schedule_id_course_id_section_number_key
  `);
  // Add new constraint that includes day — allows same course+section on different days
  await client.query(`
    ALTER TABLE sections
    ADD CONSTRAINT sections_schedule_course_section_day_key
    UNIQUE (schedule_id, course_id, section_number, day)
  `);
}

async function down(client) {
  await client.query(`
    ALTER TABLE sections
    DROP CONSTRAINT IF EXISTS sections_schedule_course_section_day_key
  `);
  await client.query(`
    ALTER TABLE sections
    ADD CONSTRAINT sections_schedule_id_course_id_section_number_key
    UNIQUE (schedule_id, course_id, section_number)
  `);
}

module.exports = { up, down };
