// NEW-FU-175: convert the legacy "Fall-2025" seed label to canonical
// term code "251" (Fall 2025 per the FU-159 codec) so the term picker
// displays a friendly decoded label by default. Idempotent: only fires
// when the legacy row still exists AND the target code does not.
//
// Why a dedicated migration vs. fixing seed.js alone? Existing DBs (the
// dev DB I've been working against, any deployment that ran the prior
// seed) already contain "Fall-2025" — those need an in-place rename,
// not just a seed change for new installs.

async function up(client) {
  // Only rename if the legacy row exists.
  const legacy = await client.query(
    `SELECT id FROM schedules
     WHERE department_id = 'SWE-DEPT' AND semester = 'Fall-2025'`
  );
  if (legacy.rowCount === 0) return;

  // Refuse to clobber an existing 251.
  const target = await client.query(
    `SELECT id FROM schedules
     WHERE department_id = 'SWE-DEPT' AND semester = '251'`
  );
  if (target.rowCount > 0) {
    // Already-migrated DB. Bail out — running migrations on top of a
    // mixed state is dangerous and the prior shape can be re-derived
    // from the seed if needed.
    return;
  }

  await client.query(
    `UPDATE schedules
     SET semester = '251', updated_at = NOW()
     WHERE department_id = 'SWE-DEPT' AND semester = 'Fall-2025'`
  );
}

async function down(client) {
  // Reverse the rename. Same idempotency: only fires if the canonical
  // row still exists with no conflict on the legacy code.
  const canonical = await client.query(
    `SELECT id FROM schedules
     WHERE department_id = 'SWE-DEPT' AND semester = '251'`
  );
  if (canonical.rowCount === 0) return;
  const legacy = await client.query(
    `SELECT id FROM schedules
     WHERE department_id = 'SWE-DEPT' AND semester = 'Fall-2025'`
  );
  if (legacy.rowCount > 0) return;
  await client.query(
    `UPDATE schedules
     SET semester = 'Fall-2025', updated_at = NOW()
     WHERE department_id = 'SWE-DEPT' AND semester = '251'`
  );
}

module.exports = { up, down };
