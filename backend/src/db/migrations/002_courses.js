async function up(client) {
  await client.query(`
    CREATE TABLE courses (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      course_code      VARCHAR(20) NOT NULL UNIQUE,
      name             VARCHAR(120) NOT NULL,
      credits          INT         NOT NULL CHECK (credits > 0),
      academic_level   VARCHAR(20) NOT NULL
                       CHECK (academic_level IN ('Freshman','Sophomore','Junior','Senior','Graduate')),
      category         VARCHAR(5)  NOT NULL
                       CHECK (category IN ('UG','GR')),
      num_sections     INT         NOT NULL DEFAULT 1 CHECK (num_sections > 0),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX idx_courses_level    ON courses (academic_level);
    CREATE INDEX idx_courses_category ON courses (category);
  `);
}

async function down(client) {
  await client.query(`DROP TABLE IF EXISTS courses`);
}

module.exports = { up, down };
