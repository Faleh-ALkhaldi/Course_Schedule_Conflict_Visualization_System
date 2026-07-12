// NEW-FU-687 (Phase 125): add the THESIS course flag.
//
// A thesis / research course (e.g. SWE 610 Thesis, SWE 6xx research) is independent study —
// the student does research, so it has NO fixed time or place, exactly like an EXTERNAL
// (off-campus / internship) course is exempt from venue/time rules. We keep it a SEPARATE flag
// from is_external because the two mean different things to a reader (research vs off-campus) and
// the exports/legend must distinguish them — they merely share the same constraint-exemption.
//
// Purely ADDITIVE and permissive, in the exact style of migration 020 (project_thesis_types):
// a new NOT-NULL column defaulting to FALSE. No existing row's meaning changes (every course was
// already "not a thesis"); nothing is re-typed; no schedule/section data is touched. This is the
// established pattern for evolving the course-type model without disturbing protected terms.

async function up(client) {
  await client.query(`
    ALTER TABLE courses
      ADD COLUMN IF NOT EXISTS is_thesis BOOLEAN NOT NULL DEFAULT false`);
}

async function down(client) {
  await client.query(`ALTER TABLE courses DROP COLUMN IF EXISTS is_thesis`);
}

module.exports = { up, down };
