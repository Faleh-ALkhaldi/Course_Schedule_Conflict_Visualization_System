// scripts/phase47-screenshots.js
//
// Capture Phase 47 visual evidence at 3 viewports — the prompt asks
// for proof that the delete-✕ is "visibly distinct from the card
// background at rest." We:
//   1. Log in headlessly
//   2. Take a full-page screenshot at 1440, 1024, 720
//   3. Take a tight crop of one card at each viewport (cropped to
//      150×150 around the card's bottom-left where the ✕ sits) so
//      reviewers can see the X at pixel scale without zooming
//   4. Print each card's at-rest opacity in the console for record
//
// Files written to scripts/phase47-evidence/.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const APP_URL   = 'http://localhost:3000';
const SCHEDULER = { username: 'scheduler1', password: 'password123' };
const OUT_DIR   = path.join(__dirname, 'phase47-evidence');
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
      // Move mouse away so no card has :hover
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);

      // Full-page screenshot
      const fullPath = path.join(OUT_DIR, `phase47-vw${vw}-full.png`);
      await page.screenshot({ path: fullPath, fullPage: false });

      // Sample first card; crop tightly around its bottom-left X
      const card = page.locator('.sblock').first();
      const box  = await card.boundingBox();
      const info = await page.evaluate(() => {
        const c = document.querySelector('.sblock');
        if (!c) return null;
        const del = c.querySelector('.sblock-delete-row');
        const tier = Array.from(c.classList).find(x => x.startsWith('tier-')) || '';
        const narrow = c.classList.contains('narrow');
        if (!del) return { tier, narrow, opacity: 0, width: 0, height: 0 };
        const cs = getComputedStyle(del);
        return {
          tier, narrow,
          opacity: parseFloat(cs.opacity),
          width:  parseFloat(cs.width),
          height: parseFloat(cs.height),
        };
      });

      if (box && info) {
        // Crop window: 80×80 around the card's bottom-left corner
        const cropW = Math.min(120, box.width + 40);
        const cropH = Math.min(120, box.height + 40);
        const cropX = Math.max(0, box.x - 20);
        const cropY = Math.max(0, box.y + box.height - cropH + 20);

        const cropPath = path.join(OUT_DIR, `phase47-vw${vw}-x-closeup.png`);
        await page.screenshot({
          path: cropPath,
          clip: { x: cropX, y: cropY, width: cropW, height: cropH },
        });

        console.log(`vw=${vw}px  tier=${info.tier}${info.narrow ? '+narrow' : ''}  X=${info.width}×${info.height}px  opacity=${info.opacity.toFixed(2)}`);
        console.log(`  full: ${fullPath}`);
        console.log(`  X close-up: ${cropPath}`);
      } else {
        console.log(`vw=${vw}px  full: ${fullPath}  (no card data for close-up)`);
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
