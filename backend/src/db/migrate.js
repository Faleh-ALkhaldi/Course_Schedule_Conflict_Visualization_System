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
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate(process.argv[2] === 'rollback' ? 'rollback' : 'up');
