/**
 * audit-2 P2-13 — makeRateLimiter must enforce a per-IP fixed window, give
 * unidentifiable clients a stricter ceiling, keep IPs in independent buckets,
 * and reset after the window elapses. Pure unit test (no server, no DB).
 */
const { makeRateLimiter } = require('../../src/middleware/rateLimit');

function mkRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

describe('makeRateLimiter (audit-2 P2-13)', () => {
  test('allows up to max, then 429s with a Retry-After header', () => {
    const limiter = makeRateLimiter({ windowMs: 60_000, max: 3, message: 'Too many.' });
    const req = { ip: '1.2.3.4' };
    let passed = 0;
    for (let i = 0; i < 3; i++) {
      const res = mkRes();
      limiter(req, res, () => { passed++; });
      expect(res.statusCode).toBeNull();
    }
    expect(passed).toBe(3);

    const res = mkRes();
    let calledNext = false;
    limiter(req, res, () => { calledNext = true; });
    expect(calledNext).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
    expect(res.body.error).toMatch(/Too many\./);
  });

  test('unidentifiable (no IP) clients get the stricter maxUnknown limit', () => {
    const limiter = makeRateLimiter({ windowMs: 60_000, max: 10, maxUnknown: 2 });
    const req = {}; // no ip, no socket → 'unknown' bucket
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const res = mkRes();
      limiter(req, res, () => {});
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([null, null, 429]); // 2 allowed, 3rd blocked
  });

  test('separate IPs have independent buckets', () => {
    const limiter = makeRateLimiter({ windowMs: 60_000, max: 1 });
    const a1 = mkRes(); limiter({ ip: 'a' }, a1, () => {}); expect(a1.statusCode).toBeNull();
    const a2 = mkRes(); limiter({ ip: 'a' }, a2, () => {}); expect(a2.statusCode).toBe(429);
    const b1 = mkRes(); limiter({ ip: 'b' }, b1, () => {}); expect(b1.statusCode).toBeNull(); // unaffected by a
  });

  test('the bucket resets after the window elapses', () => {
    const realNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      const limiter = makeRateLimiter({ windowMs: 1000, max: 1 });
      const r1 = mkRes(); limiter({ ip: 'x' }, r1, () => {}); expect(r1.statusCode).toBeNull();
      const r2 = mkRes(); limiter({ ip: 'x' }, r2, () => {}); expect(r2.statusCode).toBe(429);
      t += 1001; // advance past the window
      const r3 = mkRes(); limiter({ ip: 'x' }, r3, () => {}); expect(r3.statusCode).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  test('rejects nonsensical configuration', () => {
    expect(() => makeRateLimiter({ windowMs: 0, max: 5 })).toThrow();
    expect(() => makeRateLimiter({ windowMs: 1000, max: 0 })).toThrow();
  });
});
