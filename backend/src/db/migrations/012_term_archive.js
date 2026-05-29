// NEW-FU-192: add `archived_at` to schedules so terms can be hidden from
// the default picker view without losing data. NULL = active, non-NULL
// timestamp = archived (with the archive moment recorded for audit).
//
// Indexed because the picker's default query becomes
// `WHERE department_id = $1 AND archived_at IS NULL`, which benefits
// from a partial index on the small archived-set.

async function up(client) {
  await client.query(`
    ALTER TABLE schedules
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL
  `);
  // Partial index: only the non-archived rows are queried in the hot path.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_schedules_active
      ON schedules (department_id, semester)
      WHERE archived_at IS NULL
  `);
}

async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_schedules_active`);
  await client.query(`ALTER TABLE schedules DROP COLUMN IF EXISTS archived_at`);
}

module.exports = { up, down };
