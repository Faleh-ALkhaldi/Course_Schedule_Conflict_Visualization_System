async function up(client) {
  await client.query(`
    CREATE TABLE schedules (
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      department_id  VARCHAR(80) NOT NULL,
      semester       VARCHAR(30) NOT NULL,
      status         VARCHAR(25) NOT NULL DEFAULT 'Draft'
                     CHECK (status IN ('Draft','PendingApproval','Finalized')),
      created_by     UUID        REFERENCES users (id) ON DELETE SET NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (department_id, semester)
    )
  `);

  await client.query(`CREATE INDEX idx_schedules_dept_sem ON schedules (department_id, semester)`);
}

async function down(client) {
  await client.query(`DROP TABLE IF EXISTS schedules`);
}

module.exports = { up, down };
