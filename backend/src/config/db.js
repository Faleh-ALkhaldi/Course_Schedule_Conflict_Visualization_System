const { Pool } = require('pg');
require('dotenv').config();

const host = process.env.DB_HOST || 'localhost';
const isLocalHost = host === 'localhost' || host === '127.0.0.1';

// NEW-FU-44: tighten SSL handling. The previous setting was always
// `{ rejectUnauthorized: false }` for any non-local host, which left a
// silent MITM hole — any process intercepting traffic between the app and
// the DB could present any cert and we'd accept it.
//
// Resolution policy:
//   - localhost / 127.0.0.1                            → SSL off (dev DBs)
//   - DB_SSL_CA env var present                        → SSL on, verify
//                                                        against this CA
//                                                        (the right answer
//                                                        for Render / RDS
//                                                        when the CA bundle
//                                                        is provisioned)
//   - DB_SSL_REJECT_UNAUTHORIZED=0 explicitly opt-out  → preserve prior
//                                                        legacy behaviour
//                                                        for environments
//                                                        that haven't yet
//                                                        wired the CA
//   - default for any non-local host                   → SSL on, verify
//                                                        with the system
//                                                        CA store (fail
//                                                        loud, not silent)
function resolveSslConfig() {
  if (isLocalHost) return false;
  if (process.env.DB_SSL_CA) {
    return {
      ca:                 process.env.DB_SSL_CA,
      rejectUnauthorized: true,
    };
  }
  if (process.env.DB_SSL_REJECT_UNAUTHORIZED === '0') {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

const pool = new Pool({
  host,
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'scheduler_db',
  user:     process.env.DB_USER     || 'scheduler_user',
  password: process.env.DB_PASSWORD || '',
  ssl:      resolveSslConfig(),
  max:      20,          // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

/**
 * Run a query against the pool.
 * @param {string} text   - SQL string (use $1, $2 … placeholders)
 * @param {Array}  params - Bound parameter values
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development') {
    console.debug('query', { text, duration, rows: res.rowCount });
  }
  return res;
}

/**
 * Acquire a client for multi-statement transactions.
 * Caller is responsible for calling client.release().
 */
async function getClient() {
  const client = await pool.connect();
  const originalRelease = client.release.bind(client);
  // NEW-M11: forward the optional `err` argument so pg can destroy a bad
  // connection instead of returning it to the pool for reuse.
  let released = false;
  client.release = (err) => {
    if (!released) { released = true; originalRelease(err); }
  };
  return client;
}

module.exports = { query, getClient, pool };
