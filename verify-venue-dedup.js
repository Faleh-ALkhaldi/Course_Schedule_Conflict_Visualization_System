// Phase 117 — verify frontend venue dedup now catches 01-002 (unreferenced venue)
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let P = 0, F = 0;
  const ok = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); cond ? P++ : F++; };

  await page.goto('http://localhost:3000');
  await page.fill('input[type=text]', 'admin1');
  await page.fill('input[type=password]', 'password123');
  await page.click('form button[type=submit], form button');
  await page.waitForTimeout(2500);

  await page.goto('http://localhost:3000/?term=271');
  await page.waitForTimeout(3000);

  // ── Test A: 01-002 (whole room exists in DB, 0 section refs → not in term-scoped list) ──
  console.log('\n[A] 01-002 — whole room registered but unreferenced');
  // find + click Add Venue button
  const btns = await page.$$('button');
  let clicked = false;
  for (const b of btns) {
    const t = await b.textContent();
    if (/add venue/i.test(t)) { await b.click(); clicked = true; break; }
  }
  ok('Add Venue button found and clicked', clicked);
  await page.waitForTimeout(1500); // wait for modal open + allVenues fetch

  const bldgIn = await page.$('[aria-label="Building"]');
  ok('Modal opened (building input present)', !!bldgIn);
  if (bldgIn) {
    await bldgIn.fill('01');
    await page.waitForTimeout(200);
    await page.fill('[aria-label="Room"]', '002');
    await page.waitForTimeout(1000); // let useMemo recompute

    const result = await page.evaluate(() => {
      const preview = document.querySelector('.sm-end-preview strong');
      const errors  = [...document.querySelectorAll('.sm-group-badge')].map(e => e.textContent.trim());
      const addBtn  = document.querySelector('.sm-btn-save');
      return {
        preview: preview ? preview.textContent : null,
        errors,
        addBtnDisabled: addBtn ? addBtn.disabled : null,
      };
    });
    console.log('  Modal state:', JSON.stringify(result));
    ok('preview shows 01-002', result.preview === '01-002');
    ok('conflict error shown for 01-002', result.errors.some(e => /already|sub-room|whole room/i.test(e)));
    ok('Add Venue button disabled', result.addBtnDisabled === true);
  }

  // ── Test B: 01-002-1 exists (sub-room) → adding bare 01-002 must be blocked ──
  // Already covered by Test A (01-002 is the whole room, so Test A checks the whole-room case)

  // ── Test C: 22-119 (referenced venue, in context list) still blocked ──
  console.log('\n[C] 22-119 — referenced whole room (already in context list)');
  await page.press('[aria-label="Building"]', 'Control+a');
  await page.fill('[aria-label="Building"]', '22');
  await page.fill('[aria-label="Room"]', '119');
  await page.waitForTimeout(800);
  const resultC = await page.evaluate(() => {
    const errors = [...document.querySelectorAll('.sm-group-badge')].map(e => e.textContent.trim());
    const addBtn = document.querySelector('.sm-btn-save');
    return { errors, addBtnDisabled: addBtn ? addBtn.disabled : null };
  });
  ok('conflict error shown for 22-119', resultC.errors.some(e => /already|sub-room|whole room/i.test(e)));
  ok('Add Venue button disabled for 22-119', resultC.addBtnDisabled === true);

  console.log(`\n=== Phase 117 venue dedup: ${P} passed, ${F} failed ===`);
  await browser.close();
  if (F) process.exitCode = 1;
})().catch(e => { console.error('ERROR:', e.message); process.exitCode = 2; });
