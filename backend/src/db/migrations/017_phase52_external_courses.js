// NEW-FU-275 (Phase 52 #5): courses.is_external — full conflict exemption
// flag for courses where the student is placed off-campus (SWE 399 Summer
// Training, where students do industry internships). Distinct from
// is_capstone:
//
//   is_capstone — meets on campus without a fixed venue, capstone
//                 schedule rules apply with venue/time/credit exemptions
//                 but R-04 (instructor double-book) and R-09 still fire.
//   is_external — student is OFF campus entirely; no instructor, no
//                 venue, no schedule. Every conflict rule is skipped for
//                 sections of an external course.
//
// Zero-data-loss schema addition: defaults to FALSE, every existing course
// stays valid. Only SWE 399 flips to TRUE in seed.js.

async function up(client) {
  await client.query(`
    ALTER TABLE courses
      ADD COLUMN is_external BOOLEAN NOT NULL DEFAULT FALSE
  `);
}

async function down(client) {
  await client.query(`
    ALTER TABLE courses
      DROP COLUMN IF EXISTS is_external
  `);
}

module.exports = { up, down };
