async function up(client) {
  await client.query(`
    CREATE TABLE sections (
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      schedule_id    UUID        NOT NULL REFERENCES schedules    (id) ON DELETE CASCADE,
      course_id      UUID        NOT NULL REFERENCES courses      (id) ON DELETE RESTRICT,
      instructor_id  UUID                 REFERENCES instructors  (id) ON DELETE SET NULL,
      venue_id       UUID                 REFERENCES venues       (id) ON DELETE SET NULL,

      -- One instructor per section is enforced at the application layer (F-09 / R-03).
      -- venue_id is nullable: only courses needing a shared hall/lab fill this field.

      section_number VARCHAR(10) NOT NULL,   -- e.g. "A", "B", "01"
      day            VARCHAR(15) NOT NULL
                     CHECK (day IN ('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')),
      start_time     TIME        NOT NULL,
      end_time       TIME        NOT NULL,
      CHECK (end_time > start_time),

      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE (schedule_id, course_id, section_number)
    )
  `);

  await client.query(`
    CREATE INDEX idx_sections_schedule    ON sections (schedule_id);
    CREATE INDEX idx_sections_instructor  ON sections (instructor_id);
    CREATE INDEX idx_sections_venue       ON sections (venue_id);
    CREATE INDEX idx_sections_day_time    ON sections (day, start_time, end_time);
  `);
}

async function down(client) {
  await client.query(`DROP TABLE IF EXISTS sections`);
}

module.exports = { up, down };
