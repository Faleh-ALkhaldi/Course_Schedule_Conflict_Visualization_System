async function up(client) {
  await client.query(`
    CREATE TABLE conflicts (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      schedule_id   UUID        NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
      rule_id       VARCHAR(10) NOT NULL,            -- e.g. "R-01", "R-04"
      severity      VARCHAR(10) NOT NULL
                    CHECK (severity IN ('Hard','Soft')),
      description   TEXT        NOT NULL,
      -- The two section IDs involved in this conflict
      section_a_id  UUID        NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
      section_b_id  UUID                 REFERENCES sections (id) ON DELETE CASCADE,
      -- section_b_id is NULL when the conflict is single-section (e.g. office hour or time window)
      confirmed     BOOLEAN     NOT NULL DEFAULT FALSE,
      -- TRUE when user clicked "Save Anyway" for a soft conflict
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX idx_conflicts_schedule  ON conflicts (schedule_id);
    CREATE INDEX idx_conflicts_section_a ON conflicts (section_a_id);
    CREATE INDEX idx_conflicts_severity  ON conflicts (severity);
  `);
}

async function down(client) {
  await client.query(`DROP TABLE IF EXISTS conflicts`);
}

module.exports = { up, down };
