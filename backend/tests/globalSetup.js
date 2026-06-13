// Jest globalSetup — TEST DATABASE ISOLATION.
//
// The integration suite create/deletes terms and mutates schedule data. Running
// it against the DEV database (scheduler_db) is what destroyed real terms (and,
// with the smoke test's old SMOKE_CODE=271, the user's Fall 2027 term). This
// setup gives the tests their OWN database, recreated fresh every run, so the
// dev data can never be touched by `npm test` again.
//
// Flow (once, before any test file):
//   1. NODE_ENV=test → config/db.js connects to <DB_NAME>_test, never the dev DB.
//   2. Drop (FORCE) + recreate the test DB as the app role (owns it → owns public).
//   3. Run the committed migrations, then seed, against the test DB.
//
// Requires the app role to have CREATEDB (ALTER ROLE scheduler_user CREATEDB).

const { Client } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

module.exports = async () => {
  // Unit tests don't touch the DB — `npm run test:unit` sets SKIP_TEST_DB=1 to
  // skip the (otherwise wasted) test-DB spin-up.
  if (process.env.SKIP_TEST_DB === '1') return;
  process.env.NODE_ENV = 'test';

  const conn = {
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    user:     process.env.DB_USER || 'scheduler_user',
    password: process.env.DB_PASSWORD || '',
  };
  const devDb  = process.env.DB_NAME || 'scheduler_db';
  const testDb = process.env.DB_NAME_TEST || `${devDb}_test`;

  // Hard guard: the test DB name must differ from the dev DB name, or we'd be
  // about to DROP the dev database. Refuse loudly rather than risk it.
  if (testDb === devDb) {
    throw new Error(`Refusing to run: test DB ("${testDb}") equals dev DB ("${devDb}"). Set DB_NAME_TEST.`);
  }

  // 1) (re)create the test DB via the maintenance 'postgres' database.
  const admin = new Client({ ...conn, database: 'postgres' });
  await admin.connect();
  // Terminate any stragglers, then drop+create fresh. FORCE needs PG13+.
  await admin.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDb}`);          // owned by the connecting role
  await admin.end();

  // 2) ensure the app role can create objects in public (PG15+ tightened this).
  const owner = new Client({ ...conn, database: testDb });
  await owner.connect();
  await owner.query(`GRANT ALL ON SCHEMA public TO ${conn.user}`).catch(() => {});
  await owner.end();

  // 3) migrate + seed against the test DB (NODE_ENV=test → config/db.js targets it).
  const backendDir = path.resolve(__dirname, '..');
  const childEnv = { ...process.env, NODE_ENV: 'test', DB_NAME_TEST: testDb };
  console.log(`\n[test-setup] preparing isolated test DB "${testDb}" …`);
  // execFileSync (argv array, no shell) — no command-injection surface.
  execFileSync('node', ['src/db/migrate.js'], { cwd: backendDir, env: childEnv, stdio: 'inherit' });
  execFileSync('node', ['src/db/seed.js'],    { cwd: backendDir, env: childEnv, stdio: 'inherit' });
  console.log('[test-setup] test DB ready.\n');
};
