// NEW-FU-230: per-schedule term dates.
//
// Before this migration: `schedules` carried only the term `semester`
// code; the actual start / end dates were derived on every read by
// decodeTerm() — either from TERM_DATE_OVERRIDES (codes 251–263 known
// to KFUPM) or from the SEASONS template (everything else, with
// best-effort placeholder dates).
//
// After: callers who create a term whose code isn't in the override
// map can supply the dates at creation time (admin enters them in
// AddTermModal — FU-233), and we store them per-schedule so the
// picker reflects them across reloads. decodeTerm precedence becomes:
//   (1) schedule row's starts_at/ends_at (if present)
//   (2) TERM_DATE_OVERRIDES[code]
//   (3) SEASONS template
//
// Columns are nullable so existing rows (and any future row that
// matches an override) continue to flow through the override/template
// path without per-row redundancy.

async function up(client) {
  await client.query(`
    ALTER TABLE schedules
      ADD COLUMN IF NOT EXISTS starts_at DATE NULL,
      ADD COLUMN IF NOT EXISTS ends_at   DATE NULL
  `);
  // NEW-FU-230: enforce start < end at the DB level when both supplied.
  // The constraint is deferred-friendly because both columns are
  // updated in one statement (no transient mid-tx violation possible).
  await client.query(`
    ALTER TABLE schedules
      DROP CONSTRAINT IF EXISTS schedules_starts_before_ends
  `);
  await client.query(`
    ALTER TABLE schedules
      ADD CONSTRAINT schedules_starts_before_ends
      CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
  `);
}

async function down(client) {
  await client.query(`
    ALTER TABLE schedules
      DROP CONSTRAINT IF EXISTS schedules_starts_before_ends
  `);
  await client.query(`
    ALTER TABLE schedules
      DROP COLUMN IF EXISTS ends_at,
      DROP COLUMN IF EXISTS starts_at
  `);
}

module.exports = { up, down };
