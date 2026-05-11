async function up(client) {
  await client.query(`
    CREATE TABLE instructors (
      id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      name       VARCHAR(120) NOT NULL,
      email      VARCHAR(120) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  // Office hours belong exclusively to one instructor.
  // Only visible in Teacher View; not used for conflict display in other views.
  await client.query(`
    CREATE TABLE office_hours (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      instructor_id UUID        NOT NULL REFERENCES instructors (id) ON DELETE CASCADE,
      day           VARCHAR(15) NOT NULL
                    CHECK (day IN ('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')),
      start_time    TIME        NOT NULL,
      end_time      TIME        NOT NULL,
      CHECK (end_time > start_time),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX idx_office_hours_instructor ON office_hours (instructor_id);
  `);
}

async function down(client) {
  await client.query(`DROP TABLE IF EXISTS office_hours`);
  await client.query(`DROP TABLE IF EXISTS instructors`);
}

module.exports = { up, down };
