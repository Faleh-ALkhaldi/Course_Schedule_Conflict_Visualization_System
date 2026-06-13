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
  // TEST ISOLATION: under NODE_ENV=test the app connects to a DEDICATED test DB
  // (DB_NAME_TEST, default "<DB_NAME>_test"), never the dev database. The
  // integration suite create/deletes terms; running it against the dev DB is what
  // destroyed real terms (see jest globalSetup + the smoke-test 271 incident).
  database: process.env.NODE_ENV === 'test'
    ? (process.env.DB_NAME_TEST || `${process.env.DB_NAME || 'scheduler_db'}_test`)
    : (process.env.DB_NAME || 'scheduler_db'),
  user:     process.env.DB_USER     || 'scheduler_user',
  password: process.env.DB_PASSWORD || '',
  ssl:      resolveSslConfig(),
  // NEW-FU-380 (Phase 99 item 5): pool resilience under heavy Suggest load.
  // The Auto-Suggest greedy is CPU-heavy and the modal fired a recommend on
  // every change; under that load the old `connectionTimeoutMillis: 2000` made
  // any query that waited >2 s for a slot throw "Connection terminated due to
  // connection timeout" — the reported "Suggest breaks suddenly". A wider pool
  // plus a longer acquire deadline gives genuine queries (incl. the full-catalog
  // fetch that feeds the Graduate tier) the headroom to wait out a transient
  // spike instead of hard-failing. The deeper fix (fast/cancelable live
  // recommend + event-loop yielding in the greedy) removes the pressure itself;
  // this is the safety margin.
  max:      30,          // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
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
