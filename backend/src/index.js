// Load .env before any environment-variable checks (app.js also calls this,
// but index.js needs the vars earlier for the startup guard).
require('dotenv').config();

// C-3: Fail fast if JWT_SECRET is not set — a missing key causes jwt.sign to use
// the string "undefined", making every token trivially forgeable.
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
  process.exit(1);
}

// NEW-FU-72: same fail-fast for DB credentials in production. Without this,
// an empty DB_PASSWORD silently defaults to '' in config/db.js — the app
// starts cleanly, then every query 500s with "password authentication failed"
// once requests start arriving. Production deploys should never silently
// accept missing connection secrets. Dev (where trust auth is common) is
// unaffected.
if (process.env.NODE_ENV === 'production') {
  const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`FATAL: missing required env vars in production: ${missing.join(', ')}. Refusing to start.`);
    process.exit(1);
  }
}

const app  = require('./app');
const port = parseInt(process.env.PORT || '4000');
const host = process.env.HOST || '0.0.0.0';

// NEW-FU-308 (Phase 28): EADDRINUSE-aware startup. The user spent 3
// phases unable to pick up new code because their `npm run dev` kept
// failing silently — the previous backend was still bound to port
// 4000, the new process crashed with a 30-line stack trace, nodemon
// kept retrying, and they didn't realize the OLD process was still
// serving requests. This handler turns that 30-line trace into a
// 4-line message with the exact fix command, then exits 1 so
// nodemon stops retrying (it only loops on success or clean exit).
const server = app.listen(port, host, () => {
  console.log(`Scheduler API running on http://${host}:${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`❌ Cannot start backend: port ${port} is already in use.`);
    console.error('   Common cause: a previous `npm run dev` is still running.');
    console.error('   Fix:  lsof -ti:' + port + ' | xargs kill -9');
    console.error('   Then: npm run dev   (or: npm run dev:fresh — kills + starts in one step)');
    console.error('');
    process.exit(1);
  }
  // Any other listen error — re-throw so the original nodemon stack
  // trace surfaces for diagnosis. We only special-case EADDRINUSE.
  throw err;
});
