// NEW-FU-273 (Phase 51 #1): rename courses.venue_exempt → courses.is_capstone.
//
// The Phase 50 flag started as "skip venue rules for capstone courses". By
// the end of Phase 50 it also suppressed R-15 (insufficient credit coverage)
// because capstones legitimately meet once a week. Phase 51 adds R-06 (UG
// outside 07:00–17:00) to the suppression list. The flag's actual meaning is
// "this course is a graduation-project capstone" — the venue-only name is
// misleading.
//
// Mechanical rename: no data change, no constraint change. The default
// value (FALSE) and the NOT NULL constraint stay. SWE 411/412/413/414 are
// the only TRUE rows.

async function up(client) {
  await client.query(`
    ALTER TABLE courses
      RENAME COLUMN venue_exempt TO is_capstone
  `);
}

async function down(client) {
  await client.query(`
    ALTER TABLE courses
      RENAME COLUMN is_capstone TO venue_exempt
  `);
}

module.exports = { up, down };
