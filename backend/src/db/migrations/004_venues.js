// Only shared lecture halls and laboratories that require explicit scheduling.
// Regular departmental classrooms are NOT stored here (R-05 scope).
async function up(client) {
  await client.query(`
    CREATE TABLE venues (
      id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      name       VARCHAR(80) NOT NULL UNIQUE,
      type       VARCHAR(20) NOT NULL
                 CHECK (type IN ('LectureHall','Laboratory')),
      capacity   INT         NOT NULL CHECK (capacity > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX idx_venues_type ON venues (type)`);
}

async function down(client) {
  await client.query(`DROP TABLE IF EXISTS venues`);
}

module.exports = { up, down };
