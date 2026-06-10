// NEW-FU-425 (Phase 104 item 2): term-local DUMMY instructors & venues.
//
// When the Suggest auto-fix hits a CAPACITY wall (more sections than there are
// free instructors/venues), it now creates placeholder ("dummy") instructors and
// venues to absorb the load instead of dropping courses. These rows are tagged
// so they can be (a) clearly labelled as placeholders in the UI, (b) scoped to
// the single term that created them (owner_semester), and (c) excluded from the
// global catalog / instructor-accountability / other terms.
//
// Purely additive (two nullable/defaulted columns per table) — zero risk to
// existing rows; existing instructors/venues default to is_dummy=false.

async function up(client) {
  await client.query(`ALTER TABLE instructors ADD COLUMN IF NOT EXISTS is_dummy boolean NOT NULL DEFAULT false`);
  await client.query(`ALTER TABLE instructors ADD COLUMN IF NOT EXISTS owner_semester varchar(8)`);
  await client.query(`ALTER TABLE venues      ADD COLUMN IF NOT EXISTS is_dummy boolean NOT NULL DEFAULT false`);
  await client.query(`ALTER TABLE venues      ADD COLUMN IF NOT EXISTS owner_semester varchar(8)`);
  // Helpful partial indexes for the "dummies of a term" lookups.
  await client.query(`CREATE INDEX IF NOT EXISTS idx_instructors_dummy ON instructors (owner_semester) WHERE is_dummy`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_venues_dummy      ON venues      (owner_semester) WHERE is_dummy`);
}

async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_instructors_dummy`);
  await client.query(`DROP INDEX IF EXISTS idx_venues_dummy`);
  await client.query(`ALTER TABLE instructors DROP COLUMN IF EXISTS is_dummy`);
  await client.query(`ALTER TABLE instructors DROP COLUMN IF EXISTS owner_semester`);
  await client.query(`ALTER TABLE venues      DROP COLUMN IF EXISTS is_dummy`);
  await client.query(`ALTER TABLE venues      DROP COLUMN IF EXISTS owner_semester`);
}

module.exports = { up, down };
