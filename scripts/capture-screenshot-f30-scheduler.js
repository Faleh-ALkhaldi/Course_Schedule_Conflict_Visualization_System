// scripts/capture-screenshot-f30-scheduler.js
// Re-capture F-30 scheduler-blocked after fixing the silent-error bug.
// Now expects the red "Insufficient permissions." toast to appear.

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const API_URL = process.env.API_URL || 'http://localhost:4000/api/v1';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const OUT_DIR = path.join(process.cwd(), 'cscvs-screenshots');
const VIEWPORT = { width: 1440, height: 900 };
const SCHEDULER = { username: 'scheduler1', password: 'password123' };

(async () => {
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
  await page.waitForSelector('.sp-course-card', { timeout: 8000 });
  await page.waitForTimeout(1000);

  console.log('▶ Click × on first course card...');
  const before = await page.locator('.sp-course-card').count();
  await page.locator('.sp-course-card .sp-del-btn').first().click();

  console.log('▶ Wait for toast...');
  await page.waitForSelector('.toast.toast-error', { timeout: 5000 });
  await page.waitForTimeout(400);

  const after = await page.locator('.sp-course-card').count();
  console.log(`  course count: ${before} → ${after} (should be equal)`);

  const file = path.join(OUT_DIR, 'screenshot-F-30-scheduler-blocked.png');
  await page.screenshot({ path: file });
  const s = fs.statSync(file);
  console.log(`✓ Wrote ${file} (${(s.size/1024).toFixed(1)} KB)`);

  // Read toast text for sanity
  const toastText = await page.locator('.toast').first().textContent().catch(() => '');
  console.log(`  toast text: "${toastText}"`);

  await browser.close();
})().catch(err => {
  console.error('✗ FAILED:', err.message);
  process.exitCode = 1;
});
