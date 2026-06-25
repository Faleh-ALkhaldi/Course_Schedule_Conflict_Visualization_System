'use strict';
// NEW-FU-670: run an uploaded file's safety-inspection + parse in a worker thread, so a
// synchronous CPU-bound parser can never block the main event loop, and HARD-KILL it at the
// deadline (the residual the in-thread `withParseTimeout` Promise.race could not enforce).
//
// A small PERSISTENT POOL (≤ MAX_CONCURRENT workers) reuses threads across imports — the
// ~module-load cost is paid once per worker, not per request — while still bounding the resource
// blast radius: at most MAX_CONCURRENT parses run at once (the rest queue); a worker whose request
// times out or crashes is terminated and replaced (never reused); workers are `unref()`d so they
// don't keep the process (or a jest run) alive when idle. MEMORY (FU-671 re-audit): `resourceLimits`
// below caps only the V8 HEAP — off-heap allocations (Buffer/typed arrays, what parsers build) are
// NOT bounded by it, so the worker itself runs an RSS watchdog that hard-exits past a generous
// ceiling (see importParseWorker.js). Same return shape as the in-thread path:
// { rows, officeHours, instructors, venues, scope }.
const { Worker } = require('worker_threads');
const path = require('path');

const WORKER_PATH        = path.join(__dirname, '..', 'workers', 'importParseWorker.js');
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_CONCURRENT     = 4;
const WORKER_MAX_HEAP_MB = 256;

function statusError(message, status) { const e = new Error(message); e.status = status; return e; }
const genericError = () => statusError('We could not read this file.', 422);
const timeoutError = () => statusError('This file took too long to read safely and was rejected.', 400);
const fromMessage  = (m) => statusError((m && m.message) || 'We could not read this file.', (m && m.status) || 422);

// ── pool state ───────────────────────────────────────────────────────────────────────────────
const idle    = [];   // healthy, available workers
const waiters = [];   // resolvers awaiting a worker (all slots busy)
let   live    = 0;    // count of non-broken workers (idle + checked-out)

function spawnWorker() {
  const w = new Worker(WORKER_PATH, { resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_HEAP_MB } });
  w.unref();
  w.broken = false;
  w.onDeath = null;   // set to the in-flight request's failer while checked out
  live++;
  const die = () => {
    if (w.broken) return;
    w.broken = true;
    const i = idle.indexOf(w); if (i >= 0) idle.splice(i, 1);
    live = Math.max(0, live - 1);
    const cb = w.onDeath; w.onDeath = null;
    if (cb) cb();                 // reject the request this worker was serving
    try { w.terminate(); } catch { /* already gone */ }
    pump();                       // hand any waiter a fresh worker so capacity is restored
  };
  w.on('error', die);
  w.on('exit',  die);             // a persistent worker should never exit on its own
  return w;
}

function pump() {
  while (waiters.length && (idle.length || live < MAX_CONCURRENT)) {
    const give = waiters.shift();
    give(idle.length ? idle.pop() : spawnWorker());
  }
}
function checkout() {
  if (idle.length) return Promise.resolve(idle.pop());
  if (live < MAX_CONCURRENT) return Promise.resolve(spawnWorker());
  return new Promise((resolve) => waiters.push(resolve));
}
function checkin(w) {
  if (w.broken) return;
  if (waiters.length) waiters.shift()(w);
  else idle.push(w);
}

async function parseUploadInWorker(buffer, format, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const w = await checkout();
  return new Promise((resolve, reject) => {
    let done = false;
    // err set → reject(err); else resolve(value). `healthy` = the worker is fine to reuse (a
    // bad-file message) vs compromised (timeout / crash → terminate + replace).
    const finish = (err, value, healthy) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.off('message', onMessage);
      w.onDeath = null;
      if (healthy) checkin(w);
      else if (!w.broken) { w.broken = true; const i = idle.indexOf(w); if (i >= 0) idle.splice(i, 1); live = Math.max(0, live - 1); try { w.terminate(); } catch { /* */ } pump(); }
      err ? reject(err) : resolve(value);
    };
    const onMessage = (m) => {
      if (m && m.ok) finish(null, m.parsed, true);
      else finish(fromMessage(m), null, true);   // bad file, but the worker is healthy → reuse it
    };
    const timer = setTimeout(() => finish(timeoutError(), null, false), timeoutMs);

    // If the worker dies mid-request, die() already terminated it + restored capacity; finish's
    // `!w.broken` guard then skips a second teardown and just rejects this request.
    w.onDeath = () => finish(genericError(), null, false);
    w.once('message', onMessage);
    w.postMessage({ buffer, format });
  });
}

module.exports = { parseUploadInWorker, DEFAULT_TIMEOUT_MS, MAX_CONCURRENT };
