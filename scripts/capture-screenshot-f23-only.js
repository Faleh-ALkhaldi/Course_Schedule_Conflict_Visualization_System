// scripts/capture-screenshot-f23-only.js
//
// Re-captures only F-23 (Office Hour modal). The main script fell back to
// the add-OH form because the first few instructors it tried have no OH,
// or the OH block hadn't finished rendering after the click. This version:
//   1. picks (via API) the first instructor that DOES have at least one OH,
//   2. clicks that instructor by name in the sidebar,
//   3. waits explicitly for an .oh-block to appear,
//   4. clicks it and captures the modal.

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const API_URL = process.env.API_URL || 'http://localhost:4000/api/v1';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const OUT_DIR = path.join(process.cwd(), 'cscvs-screenshots');
const VIEWPORT = { width: 1440, height: 900 };
const SCHEDULER = { username: 'scheduler1', password: 'password123' };
const ADMIN     = { username: 'admin1',     password: 'password123' };

async function api(method, urlPath, token, body) {
  const res = await fetch(`${API_URL}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

(async () => {
  console.log('▶ API login (admin) to find an instructor with OH...');
  const adminToken = await api('POST', '/auth/login', null, ADMIN).then(r => r.token);
  const instructors = await api('GET', '/instructors', adminToken);

  let target = null;
  for (const ins of instructors) {
    const oh = await api('GET', `/instructors/${ins.id}/office-hours`, adminToken);
    if (Array.isArray(oh) && oh.length > 0) {
      target = { ...ins, ohCount: oh.length };
      break;
    }
  }
  if (!target) {
    // Add one to the first instructor.
    const ins = instructors[0];
    await api('POST', `/instructors/${ins.id}/office-hours`, adminToken, {
      day: 'Monday', startTime: '14:00', endTime: '15:00',
    });
    target = { ...ins, ohCount: 1 };
    console.log(`  ⚠ no OH found — created one for ${ins.name}`);
  }
  console.log(`  Target instructor: ${target.name} (${target.ohCount} OH)`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));

  console.log('▶ Login UI as scheduler1...');
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]');
  await page.fill('input[name="username"], input[type="text"]', SCHEDULER.username);
  await page.fill('input[type="password"]', SCHEDULER.password);
  await page.click('button.login-btn, button[type="submit"]');
  await page.waitForSelector('.sg-root', { timeout: 15000 });
  await page.waitForTimeout(1500);

  console.log('▶ Switch to Teacher View...');
  await page.locator('button.topbar-tab:has-text("Teacher View")').click();
  await page.waitForTimeout(800);

  console.log(`▶ Click instructor "${target.name}"...`);
  // Match by visible name inside .sp-filter-item .sp-filter-name
  const targetBtn = page.locator(`.sp-filter-item:has(.sp-filter-name:has-text("${target.name}"))`).first();
  await targetBtn.click();
  // Wait for the OH block to actually render on the grid.
  await page.waitForSelector('.oh-block', { timeout: 8000 });
  await page.waitForTimeout(800);

  console.log('▶ Click the OH block...');
  // dnd-kit binds pointer handlers; a normal .click() works only when the
  // pointer doesn't move past the 6 px activation distance. Compute the
  // center of the first .oh-block and use page.mouse so React's onClick
  // (wrapped in stopPropagation) actually fires.
  const ohLoc = page.locator('.oh-block').first();
  const box = await ohLoc.boundingBox();
  if (!box) throw new Error('oh-block has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  // Wait for the modal — OfficeHourModal title is "Edit Office Hours"
  const modal = await page.waitForSelector(
    '.sm-card:has-text("Edit Office Hours")',
    { timeout: 5000 },
  ).catch(() => null);
  if (!modal) {
    // Fallback: dispatch a synthetic click via JS directly on the React node.
    console.warn('  ⚠ pointer-click didn\'t open modal; trying JS click...');
    await ohLoc.evaluate((el) => el.click());
    await page.waitForSelector(
      '.sm-card:has-text("Edit Office Hours")',
      { timeout: 5000 },
    );
  }
  await page.waitForTimeout(500);

  const outFile = path.join(OUT_DIR, 'screenshot-F-23-office-hours.png');
  await page.screenshot({ path: outFile });
  const s = fs.statSync(outFile);
  console.log(`✓ Wrote ${outFile} (${(s.size/1024).toFixed(1)} KB)`);

  await browser.close();
})().catch(err => {
  console.error('✗ FAILED:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
