// scripts/smoke-test.js
//
// Regression smoke tests for the four bugs fixed during the Features
// Showcase capture session. Each test exercises the user-facing path that
// previously failed silently. Tests run against the live dev frontend +
// backend; no data is mutated (the 403 RBAC path acts as a safety net for
// the destructive cases).
//
//   Bug #1 — Office-hour block click renders OfficeHourModal
//   Bug #2 — Course delete as scheduler shows "Insufficient permissions." toast
//   Bug #3 — Instructor delete as scheduler shows the same toast
//   Bug #4 — Venue delete as scheduler shows the same toast
//
// Usage:  node scripts/smoke-test.js
// Exit code 0 = all pass, 1 = one or more failures.

const { chromium } = require('playwright');

const API_URL = process.env.API_URL || 'http://localhost:4000/api/v1';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const VIEWPORT = { width: 1280, height: 800 };
const SCHEDULER = { username: 'scheduler1', password: 'password123' };
const ADMIN     = { username: 'admin1',     password: 'password123' };

const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const RED   = s => `\x1b[31m${s}\x1b[0m`;
const GRAY  = s => `\x1b[90m${s}\x1b[0m`;

// NEW-FU-77: rate-limit isolation. Each test gets a unique X-Forwarded-For
// IP so its login attempts land in their own per-test bucket. NEW-FU-37
// set `trust proxy = 1`, which means the backend treats the LAST hop in
// XFF as the real client — so localhost-originated test requests carrying
// a per-test XFF get bucketed by that XFF value. Without this, debug logins
// or repeated suite runs filled the localhost bucket and tests started
// failing with 429s that masked the real assertions.
let testIpCounter = 0;
function nextTestIp() {
  testIpCounter++;
  return `10.99.${Math.floor(testIpCounter / 256) % 256}.${testIpCounter % 256}`;
}

// ── HTTP helper ─────────────────────────────────────────────────────────────
async function api(method, urlPath, token, body, ip = null) {
  const res = await fetch(`${API_URL}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // NEW-FU-77: per-test IP for rate-limit isolation.
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status}`);
  return res.json();
}

// ── Page helpers ────────────────────────────────────────────────────────────
async function loginUi(page, creds) {
  // NEW-FU-77: each page run installs a unique X-Forwarded-For header on
  // every request via Playwright's route(), so the backend's rate limiter
  // sees this test in its own bucket. Per-test isolation makes the suite
  // safe to re-run without restarting the backend or waiting for the
  // 60-second login window to expire.
  const testIp = nextTestIp();
  await page.route('**/api/v1/**', route => {
    const headers = { ...route.request().headers(), 'X-Forwarded-For': testIp };
    return route.continue({ headers });
  });
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]', { timeout: 8000 });
  await page.fill('input[name="username"], input[type="text"]', creds.username);
  await page.fill('input[type="password"]', creds.password);
  await page.click('button.login-btn, button[type="submit"]');
  await page.waitForSelector('.sg-root', { timeout: 15000 });
  await page.waitForTimeout(800);
}

async function expectToast(page, expectedText, timeout = 5000) {
  await page.waitForSelector('.toast.toast-error', { timeout });
  const text = (await page.locator('.toast').first().textContent() || '').trim();
  if (!text.includes(expectedText)) {
    throw new Error(`toast text was "${text}", expected to contain "${expectedText}"`);
  }
  return text;
}

// ── Test 1: Office-hour modal renders ───────────────────────────────────────
async function testOhModalRenders(ctx) {
  // Find an instructor that actually has at least one office hour via API.
  const adminToken = (await api('POST', '/auth/login', null, ADMIN)).token;
  const instructors = await api('GET', '/instructors', adminToken);
  let target = null;
  for (const ins of instructors) {
    const oh = await api('GET', `/instructors/${ins.id}/office-hours`, adminToken);
    if (Array.isArray(oh) && oh.length > 0) { target = ins; break; }
  }
  if (!target) {
    // Create one so the test is self-healing on a fresh DB.
    await api('POST', `/instructors/${instructors[0].id}/office-hours`, adminToken, {
      day: 'Monday', startTime: '14:00', endTime: '15:00',
    });
    target = instructors[0];
  }

  const page = await ctx.newPage();
  await loginUi(page, SCHEDULER);
  await page.locator('button.topbar-tab:has-text("Instructor View")').click();
  await page.waitForTimeout(500);

  await page
    .locator(`.sp-filter-item:has(.sp-filter-name:has-text("${target.name}"))`)
    .first().click();
  await page.waitForSelector('.oh-block', { timeout: 8000 });

  // dnd-kit listeners swallow synthetic clicks; use real mouse events.
  const ohBox = await page.locator('.oh-block').first().boundingBox();
  if (!ohBox) throw new Error('.oh-block has no bounding box');
  await page.mouse.move(ohBox.x + ohBox.width / 2, ohBox.y + ohBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();

  await page.waitForSelector('.sm-card:has-text("Edit Office Hours")', { timeout: 5000 });
  await page.close();
}

// ── Test 2: Course delete as scheduler → toast ──────────────────────────────
async function testCourseDeleteToast(ctx) {
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  await loginUi(page, SCHEDULER);
  await page.waitForSelector('.sp-course-card', { timeout: 8000 });
  const before = await page.locator('.sp-course-card').count();

  await page.locator('.sp-course-card .sp-del-btn').first().click();
  const txt = await expectToast(page, 'Insufficient permissions.');

  const after = await page.locator('.sp-course-card').count();
  if (after !== before) {
    throw new Error(`course count changed: ${before} → ${after} (scheduler should be blocked)`);
  }
  await page.close();
  return txt;
}

// ── Test 3: Instructor delete as scheduler → toast ──────────────────────────
async function testInstructorDeleteToast(ctx) {
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  await loginUi(page, SCHEDULER);
  await page.locator('button.topbar-tab:has-text("Instructor View")').click();
  await page.waitForSelector('.sp-filter-item', { timeout: 8000 });
  await page.waitForTimeout(400);
  const before = await page.locator('.sp-filter-item').count();

  // The first × button inside the instructor list.
  await page.locator('.sp-section:has(.sp-heading:has-text("Instructors")) .sp-del-btn')
    .first().click();
  const txt = await expectToast(page, 'Insufficient permissions.');

  const after = await page.locator('.sp-filter-item').count();
  if (after !== before) {
    throw new Error(`instructor count changed: ${before} → ${after}`);
  }
  await page.close();
  return txt;
}

// ── Test 5: Office-hour delete error surfaces a toast ───────────────────────
// OH delete is NOT admin-only, so we can't lean on the 403 path here.
// Instead we intercept the DELETE network call and force a 500 — verifying
// the catch-block in handleDeleteOH actually surfaces a toast rather than
// silently swallowing the error.
async function testOhDeleteToast(ctx) {
  const adminToken = (await api('POST', '/auth/login', null, ADMIN)).token;
  const instructors = await api('GET', '/instructors', adminToken);
  let target = null;
  for (const ins of instructors) {
    const oh = await api('GET', `/instructors/${ins.id}/office-hours`, adminToken);
    if (Array.isArray(oh) && oh.length > 0) { target = ins; break; }
  }
  if (!target) {
    await api('POST', `/instructors/${instructors[0].id}/office-hours`, adminToken, {
      day: 'Monday', startTime: '14:00', endTime: '15:00',
    });
    target = instructors[0];
  }

  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  await loginUi(page, SCHEDULER);
  await page.locator('button.topbar-tab:has-text("Instructor View")').click();
  await page.waitForTimeout(400);

  await page
    .locator(`.sp-filter-item:has(.sp-filter-name:has-text("${target.name}"))`)
    .first().click();
  await page.waitForSelector('.sp-oh-item', { timeout: 8000 });
  await page.waitForTimeout(300);
  const before = await page.locator('.sp-oh-item').count();

  // Intercept the OH DELETE and force a 500 — verifies the error handler
  // surfaces a toast (and protects the real DB from this destructive test).
  await page.route(/\/api\/v1\/instructors\/[^/]+\/office-hours\/[^/?]+$/, route => {
    if (route.request().method() === 'DELETE') {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Simulated server error.' }),
      });
    } else {
      route.continue();
    }
  });

  await page.locator('.sp-oh-item .sp-del-btn').first().click();
  const txt = await expectToast(page, 'Simulated server error.');

  const after = await page.locator('.sp-oh-item').count();
  if (after !== before) {
    throw new Error(`OH count changed: ${before} → ${after} (delete should have failed)`);
  }
  await page.close();
  return txt;
}

// ── Test 4: Venue delete as scheduler → toast ───────────────────────────────
async function testVenueDeleteToast(ctx) {
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  await loginUi(page, SCHEDULER);
  await page.locator('button.topbar-tab:has-text("Venue View")').click();
  await page.waitForSelector('.sp-venue-li', { timeout: 8000 });
  await page.waitForTimeout(400);
  const before = await page.locator('.sp-venue-li').count();

  await page.locator('.sp-venue-li .sp-del-btn').first().click();
  const txt = await expectToast(page, 'Insufficient permissions.');

  const after = await page.locator('.sp-venue-li').count();
  if (after !== before) {
    throw new Error(`venue count changed: ${before} → ${after}`);
  }
  await page.close();
  return txt;
}

// NEW-FU-173: Term picker smoke. Logs in as admin, clicks the term chip,
// asserts the dropdown opens with at least the seeded term + its stats,
// then closes via Esc and verifies it's gone. Doesn't mutate (no add/
// delete) so the smoke suite stays idempotent — those flows already have
// dedicated integration tests in backend/tests/integration/terms.test.js.
async function testTermPickerOpens(ctx) {
  const page = await ctx.newPage();
  await loginUi(page, ADMIN);

  // Click the chip — it must be visible and clearly clickable.
  const chip = page.locator('.tp-chip');
  if (await chip.count() === 0) throw new Error('Term chip (.tp-chip) not rendered in topbar');
  await chip.click();

  // Dropdown opens immediately on click; rows render after the async
  // listTerms() call resolves. Wait for at least one .tp-row to attach.
  await page.waitForSelector('.tp-popover', { timeout: 5000 });
  await page.waitForSelector('.tp-row',     { timeout: 5000 });
  const rows = await page.locator('.tp-row').count();
  if (rows < 1) throw new Error(`expected ≥1 term row in dropdown, found ${rows}`);

  // The active row must carry the .active class and show the ✓ check.
  const active = await page.locator('.tp-row.active').count();
  if (active < 1) throw new Error('no active term marked in dropdown');

  // At least one row must show non-zero stats (proves the join worked).
  const statsText = (await page.locator('.tp-row.active .tp-row-stats').textContent() || '').replace(/\s+/g, ' ');
  if (!/📚 \d+/.test(statsText) || !/📋 \d+/.test(statsText)) {
    throw new Error(`active-row stats look malformed: "${statsText}"`);
  }

  // Esc closes the popover.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const stillOpen = await page.locator('.tp-popover').count();
  if (stillOpen > 0) throw new Error('Esc did not close the term picker dropdown');

  await page.close();
  return `${rows} term(s) listed; active stats: ${statsText.trim()}`;
}

// NEW-FU-198: Term archive end-to-end smoke. Sets up a throwaway term via
// the API, then drives the picker UI to archive it, verifies it disappears
// from the default view, toggles "Show archived" to surface it again, then
// unarchives via the row button and confirms it's back in the default view.
// Cleanup is in a finally so a half-failed run doesn't leave orphans.
async function testTermArchiveFlow(ctx) {
  const SMOKE_CODE = '991'; // reserved test-only code — must NEVER collide with a real working term (271 was a real term; the old value silently deleted it)
  const adminToken = (await api('POST', '/auth/login', null, ADMIN)).token;

  // Pre-clean: if a prior crashed run left this code around, hard-delete it.
  // The 404 from a clean state is fine; we swallow it.
  try { await api('DELETE', `/terms/${SMOKE_CODE}?activeCode=251`, adminToken); } catch { /* not present */ }

  // Setup: create the throwaway term so the picker has a stable row to act on.
  await api('POST', '/terms', adminToken, { code: SMOKE_CODE });

  const page = await ctx.newPage();
  try {
    await loginUi(page, ADMIN);

    // Open the picker.
    await page.locator('.tp-chip').click();
    await page.waitForSelector('.tp-popover', { timeout: 5000 });
    await page.waitForSelector('.tp-row',     { timeout: 5000 });

    // Locate the row for our throwaway code. :has() filtering pins it down
    // even if other terms exist; the row must be visible in the default
    // (non-archived) view at this point.
    const rowSelector = `.tp-row:has(.tp-row-code-chip:has-text("${SMOKE_CODE}"))`;
    if (await page.locator(rowSelector).count() !== 1) {
      throw new Error(`expected exactly 1 row for ${SMOKE_CODE} in default view, found ${await page.locator(rowSelector).count()}`);
    }

    // Archive it via the row button.
    await page.locator(`${rowSelector} .tp-row-archive`).click();
    // After refresh(), the row should disappear from the default view.
    // Use Playwright's locator-based wait — :has-text() doesn't work inside
    // page.evaluate / waitForFunction (browser native querySelector).
    await page.locator(rowSelector).first().waitFor({ state: 'detached', timeout: 5000 });

    // Toggle "Show archived" — the button label reflects state.
    const toggle = page.locator('.tp-archive-toggle');
    const labelBefore = (await toggle.textContent() || '').trim();
    if (!/Show archived/i.test(labelBefore)) {
      throw new Error(`expected toggle to read "Show archived" before click, got "${labelBefore}"`);
    }
    await toggle.click();
    // Now the archived row must reappear, with the .archived class.
    await page.locator(`${rowSelector}.archived`).waitFor({ state: 'visible', timeout: 5000 });
    const labelAfter = (await toggle.textContent() || '').trim();
    if (!/Hide archived/i.test(labelAfter)) {
      throw new Error(`expected toggle to read "Hide archived (N)" after click, got "${labelAfter}"`);
    }

    // Unarchive via the row button.
    await page.locator(`${rowSelector} .tp-row-unarchive`).click();
    // The row should lose the .archived class (it's now active again, still
    // visible because showArchived is still ON). Waiting for the .archived
    // descendant locator to detach is the cleanest proxy.
    await page.locator(`${rowSelector}.archived`).first().waitFor({ state: 'detached', timeout: 5000 });

    return `archived → hidden, toggle revealed (label: "${labelAfter}"), unarchived → reverted`;
  } finally {
    await page.close();
    // Always hard-delete the throwaway, even if the test failed partway.
    try { await api('DELETE', `/terms/${SMOKE_CODE}?activeCode=251`, adminToken); }
    catch (e) { console.error(GRAY(`  (cleanup of ${SMOKE_CODE} failed: ${e.message})`)); }
  }
}

// NEW-FU-208: archived-view lockdown smoke. Creates + archives a term, navigates
// to it via ?term=XXX, then asserts every mutation affordance the admin would
// otherwise have is disabled. The api-level checks already exist in the
// integration suite; this test guards the *user-visible* lockdown, which is
// what the user actually experiences. Cleanup in finally so a half-failed
// run doesn't leave the throwaway term behind.
async function testArchivedViewLockdown(ctx) {
  // NEW-FU-217: range guard rejects pre-251. Switched to 302 (Spring 2031)
  // — in-range, distinct from FU-198 (271) and other test codes.
  const CODE = '302';
  const adminToken = (await api('POST', '/auth/login', null, ADMIN)).token;

  // Pre-clean defensively in case a prior crash left an orphan.
  try { await api('DELETE', `/terms/${CODE}?activeCode=251`, adminToken); } catch {}
  await api('POST', '/terms', adminToken, { code: CODE });
  await api('PATCH', `/terms/${CODE}/archive?activeCode=251`, adminToken, {});

  const page = await ctx.newPage();
  try {
    await loginUi(page, ADMIN);
    // Navigate to the archived term via URL — the boot flow respects ?term.
    await page.goto(`${APP_URL}/?term=${CODE}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.scheduler-archived-banner', { timeout: 5000 });

    // 1. Banner is present.
    const banner = await page.locator('.scheduler-archived-banner').count();
    if (banner !== 1) throw new Error(`expected 1 archived banner, got ${banner}`);

    // 2. Save + Suggest are disabled (TopBar — FU-203).
    const suggestDisabled = await page.locator('button.topbar-btn.suggest').isDisabled();
    const saveLoc = page.locator('button.topbar-btn.success, button.topbar-btn.warn, button.topbar-btn.danger').first();
    const saveDisabled = await saveLoc.isDisabled();
    if (!suggestDisabled || !saveDisabled)
      throw new Error(`expected Save+Suggest disabled, got save=${saveDisabled} suggest=${suggestDisabled}`);

    // 3. Sidebar "+" buttons are disabled (FU-205). The sidebar shows the
    //    + Sections, + Courses buttons in Course view by default.
    const addBtns = page.locator('.sp-section .sp-add-btn');
    const addCount = await addBtns.count();
    if (addCount < 2) throw new Error(`expected ≥2 sp-add-btn, got ${addCount}`);
    for (let i = 0; i < addCount; i++) {
      if (!(await addBtns.nth(i).isDisabled())) {
        throw new Error(`sp-add-btn[${i}] is NOT disabled on archived view`);
      }
    }

    // 4. Sidebar section-row delete buttons disabled (sample first row).
    //    The seed schedule has at least one section visible on Course view.
    await page.waitForSelector('.sp-section-item .sp-del-btn', { timeout: 5000 });
    const firstDelDisabled = await page.locator('.sp-section-item .sp-del-btn').first().isDisabled();
    if (!firstDelDisabled) throw new Error('section delete button is NOT disabled on archived view');

    // 5. Course-card drag is disabled (cursor reflects state).
    const courseCard = page.locator('.sp-course-card').first();
    if (await courseCard.count() > 0) {
      const cursor = await courseCard.evaluate(el => getComputedStyle(el).cursor);
      if (cursor === 'grab') throw new Error(`course card cursor is "grab" — drag should be disabled`);
    }

    return `banner+5 affordances locked (suggest, save, sp-add×${addCount}, section-del, course-card cursor=${
      await page.locator('.sp-course-card').first().evaluate(el => getComputedStyle(el).cursor).catch(()=>'n/a')
    })`;
  } finally {
    await page.close();
    // Always restore + hard-delete the throwaway. Restoration first because
    // delete is allowed on archived rows, but unarchive is cheap and keeps
    // the cleanup honest.
    try { await api('PATCH', `/terms/${CODE}/unarchive`, adminToken, {}); }   catch {}
    try { await api('DELETE', `/terms/${CODE}?activeCode=251`, adminToken); } catch (e) {
      console.error(GRAY(`  (cleanup of ${CODE} failed: ${e.message})`));
    }
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────
const TESTS = [
  { name: 'Bug #1 — OfficeHourModal renders on OH block click', fn: testOhModalRenders },
  { name: 'Bug #2 — Course delete by scheduler shows error toast', fn: testCourseDeleteToast },
  { name: 'Bug #3 — Instructor delete by scheduler shows error toast', fn: testInstructorDeleteToast },
  { name: 'Bug #4 — Venue delete by scheduler shows error toast', fn: testVenueDeleteToast },
  { name: 'Bug #5 — OH delete by scheduler shows error toast', fn: testOhDeleteToast },
  { name: 'Bug #6 — Term picker dropdown opens with stats',     fn: testTermPickerOpens },
  { name: 'Bug #7 — Term archive round-trip (FU-198)',          fn: testTermArchiveFlow },
  { name: 'Bug #8 — Archived view is fully read-only (FU-208)', fn: testArchivedViewLockdown },
];

(async () => {
  console.log(GRAY(`Running ${TESTS.length} regression smoke tests against ${APP_URL}\n`));
  const browser = await chromium.launch({ headless: true });

  // A fresh context per test isolates auth (localStorage token) so the second
  // test doesn't get auto-logged-in from the first test's session.
  const results = [];
  for (const t of TESTS) {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const start = Date.now();
    try {
      const extra = await t.fn(ctx);
      const ms = Date.now() - start;
      console.log(`${GREEN('  ✓')} ${t.name} ${GRAY(`(${ms} ms)`)}`);
      if (extra) console.log(GRAY(`      ${extra}`));
      results.push({ name: t.name, ok: true });
    } catch (err) {
      const ms = Date.now() - start;
      console.log(`${RED('  ✗')} ${t.name} ${GRAY(`(${ms} ms)`)}`);
      console.log(RED(`      ${err.message}`));
      results.push({ name: t.name, ok: false, err: err.message });
    } finally {
      await ctx.close();
    }
  }

  await browser.close();

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log();
  if (failed === 0) {
    console.log(GREEN(`✓ ${passed}/${results.length} tests passed`));
    process.exit(0);
  } else {
    console.log(RED(`✗ ${failed}/${results.length} tests failed`));
    process.exit(1);
  }
})().catch(err => {
  console.error(RED('\n✗ runner crashed: ' + err.message));
  console.error(err.stack);
  process.exit(2);
});
