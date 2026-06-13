// Term-owned resource uniqueness (SAFE SUBSET).
//
// PROBLEM (two user-visible bugs):
//   • A newly added instructor/venue vanished from its term's sidebar on
//     reload, because the per-term list was derived purely from a `sections`
//     JOIN — an unassigned-but-just-created resource has no section yet.
//   • Re-adding the same name in a DIFFERENT term was rejected as a duplicate,
//     because instructors.email / venues.name carried a GLOBAL UNIQUE.
//
// THIS MIGRATION (non-destructive, reversible — NO data re-keying):
//   • Drops the GLOBAL UNIQUE (instructors_email_key, venues_name_key).
//   • Replaces each with TWO partial UNIQUE indexes:
//       – legacy/global rows (owner_semester IS NULL) stay unique by name/email
//         exactly as before (existing catalog behaviour unchanged), and
//       – term-owned rows (owner_semester IS NOT NULL) are unique PER TERM, so
//         the same name/email may exist once per term.
//   • Touches ZERO existing rows: every current row keeps owner_semester = NULL
//     (legacy/global) and its current name/email. Only NEW resources created by
//     the create endpoints get stamped with owner_semester (handled in code).
//
// SAFETY: down() restores the original global UNIQUE constraints exactly. The
// runner wraps up()/down() in one transaction, so a failure rolls back whole.

async function up(client) {
  // Instructors: global UNIQUE(email) → per-scope partial uniques.
  await client.query(`ALTER TABLE instructors DROP CONSTRAINT IF EXISTS instructors_email_key`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_instructors_email_global
                        ON instructors (email) WHERE owner_semester IS NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_instructors_email_per_term
                        ON instructors (email, owner_semester) WHERE owner_semester IS NOT NULL`);

  // Venues: global UNIQUE(name) → per-scope partial uniques.
  await client.query(`ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_name_key`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_venues_name_global
                        ON venues (name) WHERE owner_semester IS NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_venues_name_per_term
                        ON venues (name, owner_semester) WHERE owner_semester IS NOT NULL`);
}

async function down(client) {
  await client.query(`DROP INDEX IF EXISTS uq_instructors_email_global`);
  await client.query(`DROP INDEX IF EXISTS uq_instructors_email_per_term`);
  await client.query(`DROP INDEX IF EXISTS uq_venues_name_global`);
  await client.query(`DROP INDEX IF EXISTS uq_venues_name_per_term`);
  // Restore the original global UNIQUE constraints (only succeeds if no
  // cross-term duplicate names exist; in the safe-subset model legacy rows are
  // already globally unique, so a clean install round-trips).
  await client.query(`ALTER TABLE instructors ADD CONSTRAINT instructors_email_key UNIQUE (email)`);
  await client.query(`ALTER TABLE venues      ADD CONSTRAINT venues_name_key      UNIQUE (name)`);
}

module.exports = { up, down };
