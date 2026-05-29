const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// NEW-M2: short-lived cache so we don't hit the DB on every request to
// verify the user still exists. TTL is short enough that a deleted user
// loses access within the configured window rather than waiting for token
// expiry.
// NEW-FU-65: tighten the window from 60s to 15s. The original 60s was a
// compromise between DB load and access-revocation latency; with this
// service's modest QPS the additional DB hits at 15s TTL are negligible
// (a few SELECT 1 / second / active user) and the smaller window narrows
// the "deleted but still authorized" gap by 4×.
const USER_CACHE_TTL_MS = 15_000;
// NEW-FU-65: cap the map so a pathological login storm can't grow it
// unbounded between sweep cycles. The sweep already handles steady-state
// growth; the cap protects against bursts.
const USER_CACHE_MAX = 5000;
const userExistsCache = new Map(); // userId → { existsAt: ts }

// NEW-FU-3: periodic sweep so the Map can't grow unbounded as new users log
// in over time. The cumulative login population would otherwise leave a
// permanent residue of entries for users who never come back. .unref() keeps
// the interval from blocking process exit.
setInterval(() => {
  const cutoff = Date.now() - USER_CACHE_TTL_MS;
  for (const [k, v] of userExistsCache) {
    if (v.existsAt < cutoff) userExistsCache.delete(k);
  }
}, 5 * 60_000).unref();

async function userStillExists(userId) {
  const hit = userExistsCache.get(userId);
  const now = Date.now();
  if (hit && now - hit.existsAt < USER_CACHE_TTL_MS) return true;
  const res = await query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
  if (res.rowCount > 0) {
    // NEW-FU-65: drop the oldest entry once the map exceeds the cap, so
    // bursts can't grow it unbounded between the 5-min sweep cycles.
    if (userExistsCache.size >= USER_CACHE_MAX) {
      const oldestKey = userExistsCache.keys().next().value;
      if (oldestKey !== undefined) userExistsCache.delete(oldestKey);
    }
    userExistsCache.set(userId, { existsAt: now });
    return true;
  }
  userExistsCache.delete(userId);
  return false;
}

async function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }
  const token = auth.split(' ')[1];
  let payload;
  try {
    // NEW-M1: pin the verification algorithm. Without this, jsonwebtoken would
    // accept any algorithm the token header advertises — historical CVEs
    // (alg=none, HS/RS confusion) all start there.
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired.' });
  }

  // NEW-M2: deleted users should lose access well before their JWT expires.
  try {
    if (!(await userStillExists(payload.id))) {
      return res.status(401).json({ error: 'Account no longer exists.' });
    }
  } catch (err) {
    // DB error — fail closed.
    return res.status(503).json({ error: 'Authentication service unavailable.' });
  }

  req.user = payload;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
