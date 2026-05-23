const { Pool } = require('pg');
require('dotenv').config();

const host = process.env.DB_HOST || 'localhost';
const isLocalHost = host === 'localhost' || host === '127.0.0.1';

const pool = new Pool({
  host,
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'scheduler_db',
  user:     process.env.DB_USER     || 'scheduler_user',
  password: process.env.DB_PASSWORD || '',
  ssl:      isLocalHost ? false : { rejectUnauthorized: false },
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
  // Override to log long-held connections in dev
  let released = false;
  client.release = () => {
    if (!released) { released = true; originalRelease(); }
  };
  return client;
}

module.exports = { query, getClient, pool };
