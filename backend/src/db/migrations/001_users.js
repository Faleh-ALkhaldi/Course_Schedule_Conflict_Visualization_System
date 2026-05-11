async function up(client) {
  await client.query(`
    CREATE TABLE users (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      username     VARCHAR(80) NOT NULL UNIQUE,
      email        VARCHAR(120) NOT NULL UNIQUE,
      password_hash TEXT        NOT NULL,
      role         VARCHAR(20) NOT NULL DEFAULT 'scheduler'
                   CHECK (role IN ('scheduler', 'admin')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function down(client) {
  await client.query(`DROP TABLE IF EXISTS users`);
}

module.exports = { up, down };
