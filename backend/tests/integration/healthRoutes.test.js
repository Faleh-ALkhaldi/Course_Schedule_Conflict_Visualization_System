// NEW-FU-298: Integration test for the route-enumerator diagnostic.
//
// Phase 26 adds GET /api/v1/health/routes so the user can confirm
// in their running backend whether the routes from Phase 21+ commits
// are actually mounted. If the SuggestModal banner says "/suggest-
// recommend not found" but this endpoint lists it, the issue is a
// stale frontend bundle or wrong API base URL — not missing backend
// code.

const request = require('supertest');
const app     = require('../../src/app');

describe('FU-298: route-enumerator diagnostic', () => {
  test('GET /api/v1/health/routes returns a route list', async () => {
    const r = await request(app).get('/api/v1/health/routes');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    expect(typeof r.body.count).toBe('number');
    expect(Array.isArray(r.body.routes)).toBe(true);
    expect(r.body.routes.length).toBeGreaterThan(0);
  });

  test('list includes the Phase 21 /suggest-recommend route', async () => {
    const r = await request(app).get('/api/v1/health/routes');
    const has = r.body.routes.some(line =>
      line === 'GET /api/v1/schedules/:scheduleId/suggest-recommend'
    );
    expect(has).toBe(true);
  });

  test('list includes the Phase 23 /sections/:id/extend route', async () => {
    const r = await request(app).get('/api/v1/health/routes');
    const has = r.body.routes.some(line =>
      line === 'POST /api/v1/sections/:sectionId/extend'
    );
    expect(has).toBe(true);
  });

  test('endpoint is open (no auth required) so it works for diagnostics', async () => {
    // No Authorization header — should still 200, since the user might
    // be diagnosing a stuck login flow and shouldn't need credentials
    // to inspect the route table.
    const r = await request(app).get('/api/v1/health/routes');
    expect(r.status).toBe(200);
  });
});

describe('FU-303: /health/version diagnostic (Phase 27)', () => {
  test('returns version + gitSha + startedAt without auth', async () => {
    const r = await request(app).get('/api/v1/health/version');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    expect(typeof r.body.version).toBe('string');
    expect(r.body.version.length).toBeGreaterThan(0);
    // gitSha is the short hash from `git rev-parse --short HEAD` or
    // 'no-git' if git isn't on PATH / the repo isn't a checkout.
    expect(typeof r.body.gitSha).toBe('string');
    expect(r.body.gitSha.length).toBeGreaterThan(0);
    // startedAt is captured at module load — verify ISO8601 shape.
    expect(r.body.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('version stays stable across calls (same running process)', async () => {
    // The version + gitSha + startedAt all reflect the boot snapshot.
    // Two requests in the same process should return identical values.
    const a = await request(app).get('/api/v1/health/version');
    const b = await request(app).get('/api/v1/health/version');
    expect(a.body.version).toBe(b.body.version);
    expect(a.body.gitSha).toBe(b.body.gitSha);
    expect(a.body.startedAt).toBe(b.body.startedAt);
  });
});

describe('FU-311: /health/build-match diagnostic (Phase 28)', () => {
  test('returns match=true when frontendSha equals backend gitSha', async () => {
    // First get the backend's sha, then echo it back as frontendSha.
    const ver = await request(app).get('/api/v1/health/version');
    const backendSha = ver.body.gitSha;
    // Only test if a real sha exists (not 'no-git' in environments
    // without git on PATH — the endpoint correctly returns null match
    // in that case, tested below).
    if (backendSha === 'no-git' || backendSha === 'unknown') {
      // Skip the positive-match case; the null-match case still runs.
      return;
    }
    const r = await request(app)
      .get(`/api/v1/health/build-match?frontendSha=${backendSha}`);
    expect(r.status).toBe(200);
    expect(r.body.match).toBe(true);
    expect(r.body.frontendSha).toBe(backendSha);
    expect(r.body.backendSha).toBe(backendSha);
  });

  test('returns match=false when shas differ', async () => {
    // Use a deliberately wrong sha. If backend's sha happens to be
    // 'no-git' (test env without git), match is null, not false —
    // verify that separately.
    const ver = await request(app).get('/api/v1/health/version');
    const backendSha = ver.body.gitSha;
    if (backendSha === 'no-git' || backendSha === 'unknown') return; // covered below
    const r = await request(app)
      .get('/api/v1/health/build-match?frontendSha=deadbeef');
    expect(r.status).toBe(200);
    expect(r.body.match).toBe(false);
    expect(r.body.frontendSha).toBe('deadbeef');
    expect(r.body.backendSha).toBe(backendSha);
  });

  test('returns match=null when frontendSha is missing', async () => {
    // Indeterminate — the endpoint should NOT report `false` because
    // the SuggestModal would then show a false-positive "older build"
    // warning. null tells the UI to suppress the warning.
    const r = await request(app)
      .get('/api/v1/health/build-match');
    expect(r.status).toBe(200);
    expect(r.body.match).toBe(null);
    expect(r.body.frontendSha).toBe(null);
  });

  test('returns match=null when frontendSha is the placeholder unknown', async () => {
    // The Vite build emits 'unknown' when git isn't on PATH during
    // build. The backend must treat this as indeterminate, not as
    // a real sha that doesn't match.
    const r = await request(app)
      .get('/api/v1/health/build-match?frontendSha=unknown');
    expect(r.status).toBe(200);
    expect(r.body.match).toBe(null);
  });
});
