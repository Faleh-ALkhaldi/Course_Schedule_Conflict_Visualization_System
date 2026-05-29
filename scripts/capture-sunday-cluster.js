// Scroll to and capture Sunday's 11:00-13:45 cluster — the case the user
// flagged as still broken after FU-121..FU-124. This screenshot must show
// the Lec 11:00-11:50 + Lab 11:00-13:45 + Lec 12:00-12:50 + Lec 13:00-13:50
// all stacked vertically with full info readable at rest.

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const API_URL = process.env.API_URL || 'http://localhost:4000/api/v1';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const OUT_DIR = path.join(__dirname, '..', 'cscvs-screenshots');
const SCHEDULER = { username: 'scheduler1', password: 'password123' };
fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));

  const ip = `10.126.${Math.floor(Math.random()*256)}.${Math.floor(Math.random()*256)}`;
  await page.route('**/api/v1/**', route => {
    const headers = { ...route.request().headers(), 'X-Forwarded-For': ip };
    return route.continue({ headers });
  });
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]');
  await page.fill('input[name="username"], input[type="text"]', SCHEDULER.username);
  await page.fill('input[type="password"]', SCHEDULER.password);
  await page.click('button.login-btn, button[type="submit"]');
  await page.waitForSelector('.sg-root', { timeout: 15000 });
  await page.waitForTimeout(1200);

  // Find the SWE301 §02 11:00-11:50 card (Sun) — the first card of the
  // cluster — and scroll the grid so it's near the top of the viewport.
  const handle = await page.evaluateHandle(() => {
    const blocks = [...document.querySelectorAll('.sblock')];
    return blocks.find(b => {
      const code = b.querySelector('.sblock-code')?.textContent || '';
      const time = b.querySelector('.sblock-time')?.textContent || '';
      // SWE301 §02 starts at 11:00 on Sunday; find by code+time
      return code === 'SWE301' && time.startsWith('11:00');
    }) || null;
  });

  if (handle) {
    await handle.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'start' }));
    await page.waitForTimeout(500);
  }

  const file = path.join(OUT_DIR, 'fu126-sunday-cluster.png');
  await page.screenshot({ path: file, fullPage: false });
  console.log(`Wrote ${file}`);

  // Also dump the visible cluster cards
  const cluster = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.sblock')];
    return blocks
      .map(b => ({
        code:  b.querySelector('.sblock-code')?.textContent.trim() || '',
        sect:  b.querySelector('.sblock-section')?.textContent.trim() || '',
        badge: b.querySelector('.sblock-type-badge')?.textContent.trim() || '',
        time:  b.querySelector('.sblock-time')?.textContent.trim() || '',
        instr: b.querySelector('.sblock-instr')?.textContent.trim() || '',
        venue: b.querySelector('.sblock-venue')?.textContent.trim() || '',
        rect:  (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      }))
      .filter(c => /11:00|12:00|13:00/.test(c.time));
  });
  console.log('Visible 11:00–13:50 cards across all days:');
  cluster.forEach(c => console.log(`  ${c.rect.x},${c.rect.y} ${c.rect.w}x${c.rect.h}  ${c.code} ${c.sect} ${c.badge} ${c.time} ${c.instr} ${c.venue}`));

  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
