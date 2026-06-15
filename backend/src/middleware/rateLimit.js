// In-process fixed-window token-bucket rate limiter.
//
// NEW-H5 introduced this for /auth/login; NEW-FU-564 (audit-2 P2-13) generalised
// it into a factory and extracted it here so (a) the expensive solver endpoints
// (preview / auto-fix / quick-fix / suggest, each of which runs the FULL conflict
// engine over the whole schedule) can reuse the identical bucket, and (b) the
// limiter can be unit-tested in isolation.
//
// Dependency-free; per-IP buckets with a TIGHTER limit for unidentifiable
// ('unknown') clients so a flood of header-less requests can only lock out
// itself, never legitimate clients. A single shared sweep prunes every limiter's
// stale buckets so the Maps can't grow unbounded. A multi-worker deployment
// should move this to a shared store (Redis); for the current single-instance
// topology an in-process Map is sufficient.

const _allBuckets = [];   // every limiter's Map, swept together below

/**
 * Build an Express middleware that enforces `max` requests per `windowMs` per
 * client IP (falling back to socket address, then a stricter 'unknown' bucket).
 * @returns Express middleware (req, res, next) => void
 */
function makeRateLimiter({ windowMs, max, maxUnknown = max, message } = {}) {
  if (!(windowMs > 0) || !(max > 0)) {
    throw new Error('makeRateLimiter requires positive windowMs and max');
  }
  const buckets = new Map();
  _allBuckets.push(buckets);
  return function rateLimit(req, res, next) {
    const ip  = req.ip || req.socket?.remoteAddress || null;
    const key = ip || 'unknown';
    const lim = ip ? max : maxUnknown;
    const now = Date.now();
    let rec   = buckets.get(key);
    if (!rec || now > rec.resetAt) {
      rec = { count: 0, resetAt: now + windowMs };
      buckets.set(key, rec);
    }
    rec.count++;
    if (rec.count > lim) {
      const retrySec = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
      res.setHeader('Retry-After', retrySec);
      return res.status(429).json({ error: `${message || 'Too many requests.'} Try again in ${retrySec}s.` });
    }
    next();
  };
}

// Sweep stale buckets across ALL limiters every 5 min. .unref() so the timer
// never keeps the process (or a Jest run) alive.
const _sweep = setInterval(() => {
  const now = Date.now();
  for (const buckets of _allBuckets) {
    for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
  }
}, 5 * 60_000);
if (_sweep.unref) _sweep.unref();

module.exports = { makeRateLimiter };
