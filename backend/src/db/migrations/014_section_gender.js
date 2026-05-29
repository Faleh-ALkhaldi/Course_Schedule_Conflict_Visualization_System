// NEW-FU-271 (Phase 49): per-section gender attribute.
//
// KFUPM publishes male-only and female-only course sections separately. In
// the registrar's offerings, a male section is numbered '01', '02', … and
// a female section uses an 'F'-prefix on a section number that does NOT
// collide with the male range (e.g., male '01'..'03', female 'F11'..'F12';
// male labs '51'..'53', female labs 'F61'..'F62').
//
// Rather than push the 'F' prefix into the section_number string (which
// would require relaxing the type-scoped numeric CHECK from migration 010
// and would break conflict-detection ordering), we split the F off into
// its own column and keep section_number as a clean two-digit number. The
// display layer can reconstruct "F11" from gender='F' + number='11'.
//
// Existing data: every row in the system today is a male section (the
// pre-Phase-49 seed had no female sections), so DEFAULT 'M' is correct.
//
// Uniqueness: the old constraint was
//   (schedule_id, course_id, section_number, day)
// which would now collide between a male '11' and a stripped female '11'
// for the same course/day. Drop that and replace with a constraint that
// includes gender, so the two pools stay distinct.

async function up(client) {
  // 1. Add the gender column with a safe default.
  await client.query(`
    ALTER TABLE sections
      ADD COLUMN gender VARCHAR(1) NOT NULL DEFAULT 'M'
        CHECK (gender IN ('M', 'F'))
  `);

  // 2. Swap the uniqueness constraint so M-11 and F-11 of the same
  //    course-day don't collide. Drop the FU-67 (mig 008) constraint
  //    first, then add the wider one.
  await client.query(`
    ALTER TABLE sections
      DROP CONSTRAINT IF EXISTS sections_schedule_course_section_day_key
  `);
  await client.query(`
    ALTER TABLE sections
      ADD CONSTRAINT sections_schedule_course_section_day_gender_key
      UNIQUE (schedule_id, course_id, section_number, day, gender)
  `);
}

async function down(client) {
  // Restore the prior uniqueness shape and drop the gender column.
  // Any female-section rows that exist will collide if a male equivalent
  // exists for the same (schedule, course, section_number, day) — the
  // caller is expected to clean up before running this down.
  await client.query(`
    ALTER TABLE sections
      DROP CONSTRAINT IF EXISTS sections_schedule_course_section_day_gender_key
  `);
  await client.query(`
    ALTER TABLE sections
      ADD CONSTRAINT sections_schedule_course_section_day_key
      UNIQUE (schedule_id, course_id, section_number, day)
  `);
  await client.query(`
    ALTER TABLE sections
      DROP COLUMN IF EXISTS gender
  `);
}

module.exports = { up, down };
