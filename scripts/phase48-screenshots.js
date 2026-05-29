// scripts/phase48-screenshots.js
//
// Capture Phase 48 before/after visual evidence at 3 viewports.
// Each viewport produces TWO screenshots that prove the hover-reveal
// behavior end-to-end:
//
//   1. "at-rest"  — mouse positioned at (0,0). Schedule shows zero
//                   red X buttons; the grid reads clean.
//   2. "hover"    — mouse positioned over the first card's upper-right
//                   safe zone. ONLY that card's X is revealed; every
//                   other card still has its X hidden.
//
// Six files written to scripts/phase48-evidence/:
//   phase48-vw1440-at-rest.png  / phase48-vw1440-hover.png
//   phase48-vw1024-at-rest.png  / phase48-vw1024-hover.png
//   phase48-vw720-at-rest.png   / phase48-vw720-hover.png

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const APP_URL   = 'http://localhost:3000';
const SCHEDULER = { username: 'scheduler1', password: 'password123' };
const OUT_DIR   = path.join(__dirname, 'phase48-evidence');
const VIEWPORTS = [1440, 1024, 720];

async function login(page) {
  await page.goto(`${APP_URL}/`);
  await page.locator('input[autocomplete="username"]').first().fill(SCHEDULER.username);
  await page.locator('input[autocomplete="current-password"]').first().fill(SCHEDULER.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForFunction(() => !!localStorage.getItem('token'), null, { timeout: 8000 });
  await page.waitForSelector('.sblock', { timeout: 15000 });
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  try {
    await login(page);

    for (const vw of VIEWPORTS) {
      await page.setViewportSize({ width: vw, height: 900 });
      await page.waitForTimeout(500);

      // ── Shot A: AT REST (mouse at (0,0)) ──
      await page.mouse.move(0, 0);
      await page.waitForTimeout(220);   // > 0.12s opacity transition
      const restPath = path.join(OUT_DIR, `phase48-vw${vw}-at-rest.png`);
      await page.screenshot({ path: restPath, fullPage: false });

      // Snapshot the at-rest opacity from a sample card so we can quote it
      const restOp = await page.evaluate(() => {
        const c = document.querySelector('.sblock');
        if (!c) return null;
        const del = c.querySelector('.sblock-delete-row');
        if (!del) return null;
        return parseFloat(getComputedStyle(del).opacity);
      });

      // ── Shot B: HOVER (mouse over first card's safe zone) ──
      const box = await page.locator('.sblock').first().boundingBox();
      if (box) {
        // Upper-right safe zone — away from bottom-left X and bottom-right badge
        await page.mouse.move(box.x + box.width - 12, box.y + 12);
        await page.waitForTimeout(220);   // opacity transition
        const hoverPath = path.join(OUT_DIR, `phase48-vw${vw}-hover.png`);
        await page.screenshot({ path: hoverPath, fullPage: false });

        const hoverOp = await page.evaluate(() => {
          const c = document.querySelector('.sblock');
          if (!c) return null;
          const del = c.querySelector('.sblock-delete-row');
          if (!del) return null;
          return parseFloat(getComputedStyle(del).opacity);
        });

        console.log(`vw=${vw}px  at-rest opacity=${restOp?.toFixed(2) ?? 'n/a'}  →  on-hover opacity=${hoverOp?.toFixed(2) ?? 'n/a'}`);
        console.log(`  at-rest: ${restPath}`);
        console.log(`  hover:   ${hoverPath}`);
      } else {
        console.log(`vw=${vw}px  (no card found for hover shot)`);
      }
    }

    console.log(`\nEvidence written to ${OUT_DIR}/`);
  } catch (e) {
    console.error('Screenshot capture crashed:', e);
    process.exit(2);
  } finally {
    await browser.close();
  }
})();
