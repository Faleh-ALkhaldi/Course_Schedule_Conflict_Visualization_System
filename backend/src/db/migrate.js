/**
 * Simple sequential migration runner.
 * Run:  node src/db/migrate.js
 * Roll: node src/db/migrate.js rollback
 */
require('dotenv').config();
const { pool } = require('../config/db');
const path = require('path');
const fs   = require('fs');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate(direction = 'up') {
  const client = await pool.connect();
  try {
    // Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.js'))
      .sort();

    if (direction === 'rollback') {
      // Roll back the last applied migration
      const res = await client.query(
        `SELECT name FROM _migrations ORDER BY applied_at DESC LIMIT 1`
      );
      if (res.rows.length === 0) {
        console.log('Nothing to roll back.');
        return;
      }
      const lastName = res.rows[0].name;
      const mod = require(path.join(MIGRATIONS_DIR, lastName));
      console.log(`Rolling back: ${lastName}`);
      await client.query('BEGIN');
      await mod.down(client);
      await client.query(`DELETE FROM _migrations WHERE name = $1`, [lastName]);
      await client.query('COMMIT');
      console.log(`✓ Rolled back: ${lastName}`);
    } else {
      // Apply all pending migrations
      const applied = (await client.query('SELECT name FROM _migrations')).rows.map(r => r.name);

      // NEW-FU-62: detect previously-applied migration files that no longer
      // exist on disk. This is almost always a deployment-integrity error
      // (someone removed a migration file from the repo without dropping
      // its row from _migrations). Fail loudly instead of silently skipping
      // it — subsequent migrations could depend on the deleted one and
      // produce confusing FK / schema errors at runtime.
      const onDisk = new Set(files);
      const missing = applied.filter(name => !onDisk.has(name));
      if (missing.length > 0) {
        console.error(
          `Migration integrity error: ${missing.length} previously-applied ` +
          `migration(s) are no longer present on disk: ${missing.join(', ')}.`
        );
        console.error('Restore the missing files OR remove their rows from _migrations and re-apply downstream migrations as appropriate.');
        // NEW-FU-561 (audit P3): set exitCode + return (NOT process.exit(1)) so the
        // finally clause's `await pool.end()` drains the pool before Node exits — same
        // pattern the catch block already uses (FU-88). The bare exit here preempted it.
        process.exitCode = 1;
        return;
      }

      const pending = files.filter(f => !applied.includes(f));

      if (pending.length === 0) {
        console.log('All migrations already applied.');
        return;
      }

      for (const file of pending) {
        const mod = require(path.join(MIGRATIONS_DIR, file));
        console.log(`Applying: ${file}`);
        await client.query('BEGIN');
        await mod.up(client);
        await client.query(`INSERT INTO _migrations (name) VALUES ($1)`, [file]);
        await client.query('COMMIT');
        console.log(`✓ Applied: ${file}`);
      }
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // NEW-FU-48: pass err so pg destroys a partially-broken migration
    // connection. Wrapped in try/catch because client comes from raw
    // pool.connect() here (no M-11 wrapper) — calling release twice on
    // the raw client throws.
    try { client.release(err); } catch { /* ignore */ }
    console.error('Migration failed:', err.message);
    // NEW-FU-88: set exitCode + return instead of process.exit(1) so the
    // finally clause's `await pool.end()` runs to completion before Node
    // terminates. process.exit() is synchronous and can preempt the async
    // pool drain, occasionally producing "unfinished pool" warnings on
    // failed migrations. Cooperative exit keeps cleanup deterministic.
    process.exitCode = 1;
    return;
  } finally {
    try { client.release(); } catch { /* already released via catch path */ }
    await pool.end();
  }
}

// NEW-FU-58: catch rejections from `pool.connect()` so we surface a clean
// error rather than an unhandled-promise warning (the inner try/catch only
// covers the body after connect succeeds).
migrate(process.argv[2] === 'rollback' ? 'rollback' : 'up').catch(err => {
  console.error('Migration failed (before tx started):', err.message);
  process.exit(1);
});
