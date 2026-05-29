// NEW-FU-278 (Phase 54): relax the courses.credits CHECK from `> 0` to
// `>= 0` so courses like SWE 413 (Senior Design Project I, the new-format
// capstone part 1) can be stored with their real 0-credit value instead
// of being coerced to 1 by the seed. The Phase-49 seed has a comment
// explicitly documenting that coercion as a workaround — this migration
// removes the need for it.
//
// The seed.js coercion stays in place because it's still defensive — if
// a future scrape brings back a course with negative or invalid credit
// values, we don't want them in the DB. But the catalog's legitimate
// 0-credit entries (SWE 413, and any future similar courses) flow through
// untouched after this migration.
//
// Maximum credit value per KFUPM catalog: 4 (no SWE course offers more).
// Backend controllers enforce the 0..4 range; the DB CHECK enforces only
// the lower bound (>= 0) so the lower bound stays consistent if controllers
// drift.

async function up(client) {
  await client.query(`
    ALTER TABLE courses
      DROP CONSTRAINT IF EXISTS courses_credits_check
  `);
  await client.query(`
    ALTER TABLE courses
      ADD CONSTRAINT courses_credits_check CHECK (credits >= 0)
  `);
}

async function down(client) {
  await client.query(`
    ALTER TABLE courses
      DROP CONSTRAINT IF EXISTS courses_credits_check
  `);
  // Reverse to the original > 0. Any existing 0-credit rows must be
  // updated or deleted before calling this down — otherwise the new
  // CHECK refuses to apply.
  await client.query(`
    ALTER TABLE courses
      ADD CONSTRAINT courses_credits_check CHECK (credits > 0)
  `);
}

module.exports = { up, down };
