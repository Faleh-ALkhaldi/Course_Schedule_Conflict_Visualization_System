// NEW-FU-561 (audit P3): index the conflicts.section_b_id foreign key.
//
// conflicts.section_b_id REFERENCES sections(id) ON DELETE CASCADE (migration 007),
// but the column was never indexed. Postgres does NOT auto-create an index for the
// referencing side of a FK, so every section delete had to sequential-scan `conflicts`
// to find/cascade the rows that point at it (and FK validation did likewise). Add the
// index. section_a_id has the same shape; index it too for symmetry.
//
// Plain (non-CONCURRENT) CREATE INDEX because the migrate runner wraps each migration in
// a transaction; the conflicts table is small (per-schedule rows), so the brief lock is
// negligible. IF NOT EXISTS keeps it idempotent.

async function up(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_conflicts_section_b_id ON conflicts (section_b_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_conflicts_section_a_id ON conflicts (section_a_id)
  `);
}

async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_conflicts_section_b_id`);
  await client.query(`DROP INDEX IF EXISTS idx_conflicts_section_a_id`);
}

module.exports = { up, down };
