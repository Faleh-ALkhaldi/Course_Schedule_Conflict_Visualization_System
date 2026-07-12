// NEW-FU-691 (Phase 127): add a fixed Seminar course flag.
//
// SEM already exists as a section/activity code from migration 025. This migration adds the
// course-level flag that makes Seminar a stable course type instead of an interchangeable section
// choice on ordinary lecture courses. It is additive only: existing courses remain non-Seminar.

async function up(client) {
  await client.query(`
    ALTER TABLE courses
      ADD COLUMN IF NOT EXISTS is_seminar BOOLEAN NOT NULL DEFAULT false`);
}

async function down(client) {
  await client.query(`ALTER TABLE courses DROP COLUMN IF EXISTS is_seminar`);
}

module.exports = { up, down };
