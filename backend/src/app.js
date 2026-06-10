require('dotenv').config();
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const morgan  = require('morgan');
const routes  = require('./routes/index');

const app = express();

// NEW-FU-37: trust exactly one upstream proxy hop so req.ip / req.protocol /
// req.hostname reflect the real client when running behind Render's reverse
// proxy. Without this, req.ip would always be Render's internal IP, which
// would (1) make the H-5 rate limiter bucket every external client into one
// IP — letting any attacker DoS all legitimate logins with 8 failed attempts —
// and (2) make morgan access logs useless for forensics.
//
// Using `1` (not `true`) protects against header spoofing: Express only
// trusts the LAST hop in X-Forwarded-For. With `true`, an attacker could
// stuff X-Forwarded-For with arbitrary IPs and rotate freely.
//
// Placed BEFORE any middleware that reads req.ip (rate limiter in routes,
// morgan, etc.).
app.set('trust proxy', 1);

// ── Security & logging ────────────────────────────────────────────────────────
app.use(helmet());

// Accept either CORS_ORIGIN or legacy CORS_ORIGINS. Entries without a scheme
// (e.g. "myhost.onrender.com" or "myhost:443") are normalized to https://myhost.
// NEW-FU-63: localhost / 127.0.0.1 / private IPs use http instead. Without
// this, a developer who sets CORS_ORIGIN=localhost:3000 (without scheme)
// got https://localhost:3000, which didn't match the dev Vite server and
// produced silent CORS rejections.
const corsRaw = process.env.CORS_ORIGIN || process.env.CORS_ORIGINS || 'http://localhost:3000';
const allowedOrigins = corsRaw
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    if (/^https?:\/\//i.test(s)) return s;
    const hostOnly = s.replace(/:(80|443)$/, '');
    // NEW-FU-63: localhost / loopback / RFC1918 → http; everything else → https
    const isLocal = /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(hostOnly);
    return `${isLocal ? 'http' : 'https'}://${hostOnly}`;
  });

// NEW-M10: credentials: false — this API uses Bearer tokens, not cookies,
// so there's no reason to enable the CORS-credentials path. Keeping it on
// was a misleading config that also tightened browser behaviour unnecessarily.
app.use(cors({
  origin: allowedOrigins,
  credentials: false,
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Diagnostic: route enumerator (NEW-FU-298, Phase 26) ───────────────────────
// Registered BEFORE the /api/v1 router mount so it doesn't go through
// the authenticate middleware. The endpoint is intentionally open —
// the user might be diagnosing a stuck login flow and shouldn't need
// credentials to inspect the route table.
function listRoutes(stack, prefix = '') {
  const out = [];
  for (const layer of stack) {
    if (layer.route) {
      const path = prefix + layer.route.path;
      for (const m of Object.keys(layer.route.methods)) {
        out.push(`${m.toUpperCase()} ${path}`);
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      // Extract the mount path from the regexp (e.g., /^\/api\/v1\/?(?=\/|$)/ → /api/v1)
      const match = layer.regexp?.source?.match(/^\^\\\/(.+?)\\\/\?\(/);
      const mountPath = match ? '/' + match[1].replace(/\\\//g, '/') : '';
      out.push(...listRoutes(layer.handle.stack, prefix + mountPath));
    }
  }
  return out;
}
app.get('/api/v1/health/routes', (_, res) => {
  res.json({
    status: 'ok',
    count:  app._router?.stack ? listRoutes(app._router.stack).length : 0,
    routes: app._router?.stack ? listRoutes(app._router.stack).sort() : [],
  });
});

// NEW-FU-303 (Phase 27): /health/version — surfaces the running build's
// version + git short SHA. The user has reported the /suggest-recommend
// banner appearing across multiple phases despite the route being in
// code; the missing link was a runtime way to confirm WHICH build is
// actually running. With this endpoint, the user can hit it once and
// compare against the latest commit to know whether they need to
// restart their dev server.
//
// gitSha is captured at module-load time (server start) so it reflects
// the snapshot the running process booted with, not the current
// working-tree state. If a dev edits files without restarting, the
// commit SHA stays at the pre-edit value — exactly the signal needed.
//
// execFileSync (not execSync) so there's no shell — the command +
// args go straight to the spawned process. Inputs are hardcoded
// constants so neither is at risk of injection regardless, but the
// no-shell form is cheaper and matches the codebase's safety norms.
const { execFileSync } = require('child_process');
function gitField(args) {
  try {
    return execFileSync('git', args, {
      cwd: __dirname, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}
let gitSha = 'unknown';
try {
  gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], // suppress stderr in case git isn't available
  }).trim();
} catch {
  gitSha = 'no-git';
}
// NEW-FU-360 (Phase 35): augment with `dirty` (uncommitted working tree)
// and `phaseTag` (highest "Phase NN" marker in SuggestService source) so
// users can answer "is my backend stale?" without shell access — the
// exact diagnostic guardrail #1 of Phase 35 demands.
const SERVER_DIRTY = (gitField(['status', '--porcelain']) ?? '').length > 0;
let SERVER_PHASE_TAG = 'unknown';
try {
  const path = require('path');
  const suggestSrc = require('fs').readFileSync(
    path.resolve(__dirname, 'services', 'SuggestService.js'), 'utf8',
  );
  const phases = [...suggestSrc.matchAll(/Phase\s+(\d+)/g)].map(m => parseInt(m[1], 10));
  if (phases.length) SERVER_PHASE_TAG = `Phase ${Math.max(...phases)}`;
} catch { /* keep 'unknown' */ }

const { version: PKG_VERSION } = require('../package.json');
const SERVER_START_AT = new Date().toISOString();
app.get('/api/v1/health/version', (_, res) => {
  res.json({
    status: 'ok',
    version: PKG_VERSION,
    gitSha,
    // NEW-FU-360 (Phase 35): dirty + phaseTag let users tell at a glance
    // whether they're on a pristine commit or a live working tree.
    dirty:        SERVER_DIRTY,
    phaseTag:     SERVER_PHASE_TAG,
    startedAt:    SERVER_START_AT,
    nodeVersion:  process.version,
  });
});

// NEW-FU-311 (Phase 28): /health/build-match — the frontend passes its
// VITE_GIT_SHA build constant via ?frontendSha=..., we return whether
// it matches the backend's running gitSha. This is the SINGLE call the
// SuggestModal makes to decide whether to show the EADDRINUSE-aware
// "your backend is older than your frontend" banner. Without this, the
// frontend would have to GET /health/version then compare in JS — two
// fetches and string-compare logic in the UI. With this, one fetch +
// a boolean.
//
// We tolerate `frontendSha` being absent ('unknown' / 'no-git') so the
// endpoint still works in environments where Vite couldn't capture
// the sha at build time (CI build from a tarball, etc.). In that case
// `match` is null — "indeterminate", not "false" — so the UI knows
// to suppress the warning rather than show a false positive.
app.get('/api/v1/health/build-match', (req, res) => {
  const frontendSha = (req.query.frontendSha || '').toString().trim();
  const known = frontendSha && frontendSha !== 'unknown' && frontendSha !== 'no-git'
             && gitSha    && gitSha    !== 'unknown' && gitSha    !== 'no-git';
  res.json({
    status: 'ok',
    frontendSha: frontendSha || null,
    backendSha:  gitSha,
    match: known ? (frontendSha === gitSha) : null,
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1', routes);

// ── Service info at root ──────────────────────────────────────────────────────
// Returning JSON (not a 404) here lets a human hitting http://localhost:4000/
// or a deploy probe see at a glance that the service is alive and where to go.
const { name: SERVICE_NAME, version: SERVICE_VERSION } = require('../package.json');
app.get('/', (_, res) => res.json({
  service: SERVICE_NAME,
  version: SERVICE_VERSION,
  status:  'ok',
  api:     '/api/v1',
  health:  '/health',
  docs:    'POST /api/v1/auth/login → {token}, then send Bearer <token> on all other endpoints',
}));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// NEW-FU-298: log the registered API routes once at startup so the user
// can verify in their dev console whether /suggest-recommend, /extend,
// /health/routes etc. are actually mounted by THIS process. If they
// see "Could not pre-compute recommendations (Route ... not found)" in
// the modal but DO see the route in this log, the issue is a stale
// frontend bundle or wrong API base URL — not a missing backend route.
//
// Gated on NODE_ENV !== 'test' so the test suite output stays clean.
if (process.env.NODE_ENV !== 'test') {
  // Defer so the routes-mount above runs first; otherwise the stack
  // hasn't been populated when this line executes.
  setImmediate(() => {
    if (!app._router?.stack) return;
    const routes = listRoutes(app._router.stack).sort();
    console.log(`[startup] Registered API routes (${routes.length}):`);
    for (const r of routes) console.log(`  ${r}`);
  });
}

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route ${req.path} not found.` }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  let status = err.status || 500;
  // M-1: Sanitize PostgreSQL internal error messages so DB schema details never leak.
  let message = err.message || 'Internal server error.';
  // NEW-FU-410 (Phase 102): give the common integrity violations a clear,
  // human-readable message + a 4xx status instead of an opaque "Database
  // constraint violation" 500. When editing a section the most-hit cases are
  // the UNIQUE (duplicate section number on the same course/day) and CHECK
  // (section number outside its Lec/Lab range) constraints.
  if (err.code?.startsWith('23')) {
    status = 400;
    if (err.code === '23505') {
      // NEW-FU-456 (Phase 108): attribute the UNIQUE violation to the right entity.
      // A duplicate COURSE CODE was wrongly showing the section-number message
      // inside the Add-Course modal; differentiate by the violated constraint.
      const c = `${err.constraint || ''} ${err.detail || ''}`;
      message = /course_code/.test(c)
        ? 'A course with this code already exists. Pick a different code.'
        // NEW-FU-477 (Phase 115): a duplicate VENUE name was wrongly showing the
        // section-number message inside the Add-Venue modal — attribute it to the venue.
        : /venue/i.test(c)
        ? 'A room with this building and room number already exists. Pick a different one.'
        : 'That section number is already used for this course on one of these days. Pick a different number.';
    } else if (err.code === '23514') {
      message = 'Section number is outside the allowed range for its type (Lecture 01–49, Lab 50–99).';
    } else if (err.code === '23503') {
      message = 'A referenced record no longer exists — refresh and try again.';
    } else {
      message = 'That change conflicts with an existing record. Adjust the values and try again.';
    }
  }
  // NEW-C2: surface multer upload-limit failures as 400 with a friendly message
  // instead of letting them bubble up as generic 500s.
  else if (err.name === 'MulterError') {
    status  = 400;
    message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Uploaded file is too large (max 5 MB).'
      : `Upload rejected: ${err.code}.`;
  }
  // NEW-FU-470 (Phase 113): a malformed JSON body makes body-parser throw with
  // status 400 + a parser-position message ("Expected ',' … at position 12").
  // The 500-only sanitizer below let that internal detail reach the client; give
  // it a clean plain-language message instead.
  else if (err.type === 'entity.parse.failed') {
    status  = 400;
    message = 'The request could not be read — please try again.';
  }
  else if (process.env.NODE_ENV === 'production' && status === 500) message = 'Internal server error.';
  res.status(status).json({ error: message });
});

module.exports = app;
