// scripts/capture-fu165-term-picker.js
//
// Visual capture of the NEW-FU-165 term picker. Logs in as admin, opens
// the term chip dropdown, screenshots in three states:
//
//   1) closed chip (default state)
//   2) open dropdown listing existing terms with stats
//   3) Add-term modal with live decode preview for "263"
//
// Each screenshot is saved under cscvs-screenshots/ for the final report.

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const OUT_DIR = path.join(__dirname, '..', 'cscvs-screenshots');
const ADMIN   = { username: 'admin1', password: 'password123' };

fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page    = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));

  const ip = `10.165.${Math.floor(Math.random()*256)}.${Math.floor(Math.random()*256)}`;
  await page.route('**/api/v1/**', route => {
    const headers = { ...route.request().headers(), 'X-Forwarded-For': ip };
    return route.continue({ headers });
  });

  console.log('▶ Login as admin');
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]');
  await page.fill('input[name="username"], input[type="text"]', ADMIN.username);
  await page.fill('input[type="password"]', ADMIN.password);
  await page.click('button.login-btn, button[type="submit"]');
  await page.waitForSelector('.sg-root', { timeout: 15000 });
  await page.waitForTimeout(1200);

  // 1) Closed chip
  await page.screenshot({ path: path.join(OUT_DIR, 'fu165-chip-closed.png') });
  console.log('✓ Captured fu165-chip-closed.png');

  // 2) Open dropdown
  await page.locator('.tp-chip').click();
  await page.waitForTimeout(700);
  await page.waitForSelector('.tp-popover', { timeout: 5000 });
  await page.screenshot({ path: path.join(OUT_DIR, 'fu165-dropdown-open.png') });
  console.log('✓ Captured fu165-dropdown-open.png');

  // Dump term list for the report
  const terms = await page.evaluate(() => {
    return [...document.querySelectorAll('.tp-row')].map(r => ({
      code:    r.querySelector('.tp-row-code')?.textContent.trim(),
      label:   r.querySelector('.tp-row-label')?.textContent.trim(),
      span:    r.querySelector('.tp-row-span')?.textContent.trim(),
      stats:   r.querySelector('.tp-row-stats')?.textContent.trim().replace(/\s+/g, ' '),
      active:  r.classList.contains('active'),
      hasDeleteBtn: !!r.querySelector('.tp-row-del'),
    }));
  });
  console.log('▶ Visible terms:');
  terms.forEach(t => console.log(`    ${t.active?'✓':' '} ${t.code} · ${t.label} · ${t.span} · ${t.stats} ${t.hasDeleteBtn?'(delete)':''}`));

  // 3) Add-term modal with preview for "263"
  await page.locator('.tp-add-btn').click();
  await page.waitForSelector('.tp-modal', { timeout: 3000 });
  await page.fill('.tp-modal-input', '263');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, 'fu165-add-modal-summer.png') });
  console.log('✓ Captured fu165-add-modal-summer.png (Summer 2027 preview)');

  // 4) Same modal, type "262" → Spring preview with template-seed copy
  await page.fill('.tp-modal-input', '262');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, 'fu165-add-modal-spring.png') });
  console.log('✓ Captured fu165-add-modal-spring.png (Spring 2027 preview)');

  // Close modal
  await page.locator('.tp-btn-secondary').click();
  await page.waitForTimeout(300);

  // 5) If there's any deletable term, capture delete stage 1
  const delBtn = page.locator('.tp-row-del').first();
  if (await delBtn.count() > 0) {
    await delBtn.click();
    await page.waitForSelector('.tp-modal', { timeout: 3000 });
    await page.screenshot({ path: path.join(OUT_DIR, 'fu165-delete-stage1.png') });
    console.log('✓ Captured fu165-delete-stage1.png');

    // Stage 2
    await page.locator('.tp-btn-danger').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, 'fu165-delete-stage2.png') });
    console.log('✓ Captured fu165-delete-stage2.png');

    // Cancel — don't actually delete
    await page.locator('.tp-btn-secondary').click();
  } else {
    console.log('  (no deletable terms — skip delete capture)');
  }

  await browser.close();
  console.log('✓ Done');
})().catch(err => { console.error('✗ FAILED:', err.message); console.error(err.stack); process.exit(1); });
