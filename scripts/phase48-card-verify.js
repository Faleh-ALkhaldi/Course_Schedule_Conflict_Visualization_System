// scripts/phase48-card-verify.js
//
// Phase 48 DOM-inspection sweep. Inherits all Phase 46 + Phase 47
// invariants and REPLACES the Phase 47 "visible at rest" assertion
// with the Phase 48 hover-reveal contract:
//
//   A. AT REST (mouse moved to viewport (0,0)): every card's
//      .sblock-delete-row computed opacity < 0.05. The schedule
//      reads clean — no red X clutter.
//
//   B. ON CARD HOVER (mouse positioned over a card's upper-right
//      "safe zone" — away from the X at bottom-left): that card's
//      .sblock-delete-row computed opacity ≥ 0.85. The X is now
//      visible and clickable.
//
// Plus everything Phase 47 verified:
//   - All 6 identity fields rendered
//   - Badge at bottom-right corner, X at bottom-left corner
//   - No bounding-box overlap between any pair of indicators or
//     content rows (at-rest snapshot — overlap is what we'd care
//     about for "is the layout correct")
//   - Hit-target area ≥ per-tier px² floor (the X must still be
//     a comfortable target WHEN revealed)
//   - Click X → confirm dialog fires, edit modal stays closed
//     (must hover card body first to reveal X, THEN click)
//   - Click card body → edit modal opens, no dialog
//
// Two consecutive full-clean sweeps required.
// Exit 0 = both clean, 1 = any failure.

const { chromium } = require('playwright');

const APP_URL    = process.env.APP_URL || 'http://localhost:3000';
const SCHEDULER  = { username: 'scheduler1', password: 'password123' };
const VIEWPORTS  = [1920, 1440, 1280, 1024, 800, 720];
const TOLERANCE  = 6;

const MIN_HIT_AREA_BY_TIER = {
  'tier-spacious': 676, 'tier-compact': 676, 'tier-tight': 484,
  'tier-minimal':  324, 'tier-micro':   256, 'tier-tiny':   196,
};
const MIN_HIT_AREA_NARROW = 400;
const REST_OPACITY_MAX  = 0.05;   // at rest must be ~invisible
const HOVER_OPACITY_MIN = 0.85;   // on card hover must be revealed

const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const RED   = s => `\x1b[31m${s}\x1b[0m`;
const GRAY  = s => `\x1b[90m${s}\x1b[0m`;
const YEL   = s => `\x1b[33m${s}\x1b[0m`;

async function login(page) {
  await page.goto(`${APP_URL}/`);
  await page.locator('input[autocomplete="username"]').first().fill(SCHEDULER.username);
  await page.locator('input[autocomplete="current-password"]').first().fill(SCHEDULER.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForFunction(() => !!localStorage.getItem('token'), null, { timeout: 8000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForSelector('.sblock', { timeout: 15000 });
}

// ── DOM inspection (Phase 46+47 checks + Phase 48 at-rest opacity) ─────────
async function inspectCardsAt(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(450);
  // Ensure NO card has :hover for the at-rest opacity measurement
  await page.mouse.move(0, 0);
  await page.waitForTimeout(180);   // let the 0.12s opacity transition settle

  return page.evaluate(({ tol, restOpacityMax, minAreaByTier, minAreaNarrow }) => {
    const cards = Array.from(document.querySelectorAll('.sblock'));
    function rectOf(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    }
    function intersects(a, b) {
      if (!a || !b) return false;
      const aw = a.right - a.left, ah = a.bottom - a.top;
      const bw = b.right - b.left, bh = b.bottom - b.top;
      if (aw <= 0 || ah <= 0 || bw <= 0 || bh <= 0) return false;
      return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    }

    return cards.slice(0, 60).map((c, idx) => {
      const cardRect = rectOf(c);
      if (!cardRect || cardRect.width < 1) return null;

      const tier   = Array.from(c.classList).find(cls => cls.startsWith('tier-')) || '(none)';
      const narrow = c.classList.contains('narrow');

      const codeEl    = c.querySelector('.sblock-code');
      const sectionEl = c.querySelector('.sblock-section');
      const typeEl    = c.querySelector('.sblock-type-badge');
      const timeEl    = c.querySelector('.sblock-time');
      const instrEl   = c.querySelector('.sblock-instr');
      const noInstrEl = c.querySelector('.sblock-no-instr');
      const venueEl   = c.querySelector('.sblock-venue');
      const deleteEl  = c.querySelector('.sblock-delete-row');

      const typeRect   = rectOf(typeEl);
      const deleteRect = rectOf(deleteEl);
      const venueRect  = rectOf(venueEl);
      const instrRect  = rectOf(instrEl || noInstrEl);

      const badgeAtBottomRight = !!typeRect &&
        Math.abs(cardRect.bottom - typeRect.bottom) <= tol &&
        Math.abs(cardRect.right  - typeRect.right ) <= tol;
      const deleteAtBottomLeft = !!deleteRect &&
        Math.abs(cardRect.bottom - deleteRect.bottom) <= tol &&
        Math.abs(cardRect.left   - deleteRect.left  ) <= tol;
      const overlaps = {
        badge_vs_delete : intersects(typeRect, deleteRect),
        badge_vs_venue  : intersects(typeRect, venueRect ),
        badge_vs_instr  : intersects(typeRect, instrRect ),
        delete_vs_venue : intersects(deleteRect, venueRect),
        delete_vs_instr : intersects(deleteRect, instrRect),
      };
      const noOverlap = !Object.values(overlaps).some(v => v);

      const typeText    = (typeEl?.textContent || '').trim();
      const hasTypeText = typeText === 'LEC' || typeText === 'LAB';

      let restOpacity = 1;
      let hitArea = 0;
      if (deleteEl) {
        restOpacity = parseFloat(getComputedStyle(deleteEl).opacity) || 0;
        hitArea = (deleteRect.right - deleteRect.left) * (deleteRect.bottom - deleteRect.top);
      }
      const effectiveMinArea = narrow
        ? Math.min(minAreaByTier[tier] || 0, minAreaNarrow)
        : (minAreaByTier[tier] || 0);

      return {
        idx, tier, narrow,
        card: { w: Math.round(cardRect.width), h: Math.round(cardRect.height) },
        hasCode       : !!codeEl    && (codeEl.textContent    || '').trim().length > 0,
        hasSection    : !!sectionEl && (sectionEl.textContent || '').trim().length > 0,
        hasType       : !!typeEl && hasTypeText,
        hasTime       : !!c.querySelector('.sblock-time') && (c.querySelector('.sblock-time').textContent || '').trim().length > 0,
        hasInstructor : (!!instrEl  && (instrEl.textContent  || '').trim().length > 0) ||
                        (!!noInstrEl && (noInstrEl.textContent || '').trim().length > 0),
        hasVenue      : !!venueEl   && (venueEl.textContent  || '').trim().length > 0,
        hasDeleteX    : !!deleteEl,
        badgeAtBottomRight,
        deleteAtBottomLeft,
        noOverlap,
        overlaps,
        typeText,
        restOpacity,
        hitArea,
        effectiveMinArea,
        // Phase 48: at-rest the X must be ~invisible
        restOpacityOK: restOpacity <= restOpacityMax,
        hitAreaOK: hitArea >= effectiveMinArea,
      };
    }).filter(Boolean);
  }, { tol: TOLERANCE, restOpacityMax: REST_OPACITY_MAX, minAreaByTier: MIN_HIT_AREA_BY_TIER, minAreaNarrow: MIN_HIT_AREA_NARROW });
}

// ── Phase 48 hover-reveal check ────────────────────────────────────────────
// For one card per viewport, hover its safe zone (upper-right) and confirm
// the X's opacity rose to ≥0.85. Doing this for ALL 240 cards would be
// expensive and redundant — the CSS rule (`.sblock:hover .sblock-delete-row
// { opacity: 0.95; }`) applies uniformly to every card, so verifying it
// on one representative card per viewport is sufficient. We pick the FIRST
// card at each viewport as the representative.
async function inspectHoverRevealAt(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(300);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(180);

  const cardBox = await page.locator('.sblock').first().boundingBox();
  if (!cardBox) return { width, ok: false, error: 'no card found' };

  // Hover the SAFE zone — upper-right area, away from bottom-left X.
  // 8px in from top-right corner gives plenty of clearance from the §X
  // badge (which has pointer-events:none anyway) and from the X.
  const hx = cardBox.x + cardBox.width - 10;
  const hy = cardBox.y + 10;
  await page.mouse.move(hx, hy);
  await page.waitForTimeout(200);   // let the 0.12s opacity transition complete

  const hoverOpacity = await page.evaluate(() => {
    const card = document.querySelector('.sblock');
    if (!card) return null;
    const del = card.querySelector('.sblock-delete-row');
    if (!del) return null;
    return parseFloat(getComputedStyle(del).opacity);
  });

  // Move mouse off card for cleanup before returning
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);

  return { width, hoverOpacity, ok: hoverOpacity !== null && hoverOpacity >= HOVER_OPACITY_MIN };
}

// ── Summary ─────────────────────────────────────────────────────────────────
function summarize(reports) {
  let total = 0, passing = 0;
  const failures = [];
  for (const r of reports) {
    for (const card of r.cards) {
      total++;
      const checks = {
        hasCode: card.hasCode,
        hasSection: card.hasSection,
        hasType: card.hasType,
        hasTime: card.hasTime,
        hasInstructor: card.hasInstructor,
        hasVenue: card.hasVenue,
        hasDeleteX: card.hasDeleteX,
        badgeAtBottomRight: card.badgeAtBottomRight,
        deleteAtBottomLeft: card.deleteAtBottomLeft,
        noOverlap: card.noOverlap,
        restOpacityOK: card.restOpacityOK,
        hitAreaOK: card.hitAreaOK,
      };
      const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      if (bad.length === 0) passing++;
      else failures.push({
        viewport: r.width, idx: card.idx, tier: card.tier, narrow: card.narrow,
        card: card.card, failed: bad, overlaps: card.overlaps,
        restOpacity: card.restOpacity, hitArea: card.hitArea,
        effectiveMinArea: card.effectiveMinArea,
      });
    }
  }
  return { total, passing, failures };
}

function printSweep(label, reports, summary) {
  console.log(`\n${GRAY('─'.repeat(70))}`);
  console.log(`${YEL(label)}  total=${summary.total}  passing=${summary.passing}  failing=${summary.total - summary.passing}`);
  for (const r of reports) {
    const failCt = r.cards.filter(c => !(c.hasCode && c.hasSection && c.hasType && c.hasTime && c.hasInstructor && c.hasVenue && c.hasDeleteX && c.badgeAtBottomRight && c.deleteAtBottomLeft && c.noOverlap && c.restOpacityOK && c.hitAreaOK)).length;
    const tag = failCt === 0 ? GREEN('clean') : RED(`${failCt} fail`);
    const tiers = Array.from(new Set(r.cards.map(c => c.tier + (c.narrow ? '+narrow' : '')))).join(',');
    console.log(`  vw=${r.width}px  cards=${r.cards.length}  ${tag}  tiers=[${tiers}]`);
  }
  if (summary.failures.length) {
    console.log(`\n${RED('Failures (first 6):')}`);
    summary.failures.slice(0, 6).forEach(f => {
      const failedList = f.failed.join(', ');
      const overlaps   = Object.entries(f.overlaps || {}).filter(([, v]) => v).map(([k]) => k).join(',') || '—';
      console.log(`  vw=${f.viewport}  idx=${f.idx}  tier=${f.tier}${f.narrow ? '+narrow' : ''}  card=${f.card.w}×${f.card.h}`);
      console.log(`    failed: ${failedList}`);
      if (f.failed.includes('restOpacityOK')) console.log(`    rest opacity = ${f.restOpacity.toFixed(3)} (need ≤ ${REST_OPACITY_MAX})`);
      if (f.failed.includes('hitAreaOK'))     console.log(`    hit area = ${Math.round(f.hitArea)} px² (need ≥ ${f.effectiveMinArea})`);
      if (f.failed.includes('noOverlap'))     console.log(`    overlaps: ${overlaps}`);
    });
  }
}

// ── Click-isolation test (Phase 48: hover before click) ────────────────────
async function runClickIsolationTest(page) {
  console.log(`\n${YEL('CLICK ISOLATION TEST')}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  let dialogCount = 0;
  let lastDialogText = '';
  page.on('dialog', async d => {
    dialogCount++;
    lastDialogText = d.message();
    await d.dismiss();
  });

  async function isEditModalOpen() {
    return page.evaluate(() => {
      const el = document.querySelector('.sm-overlay, .sm-card');
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || parseFloat(cs.opacity) === 0) return false;
      return true;
    });
  }

  // ── Test 1: hover card to reveal X, then click X ──
  const card = page.locator('.sblock').first();
  const cardBox = await card.boundingBox();
  if (!cardBox) {
    console.log(RED('  no card found — SKIP'));
    return { test1OK: false, test2OK: false };
  }

  // Move into the card's safe zone first to TRIGGER the hover-reveal
  await page.mouse.move(cardBox.x + cardBox.width - 10, cardBox.y + 10);
  await page.waitForTimeout(200);   // wait for opacity transition

  // Now click the X (which is now revealed at opacity 0.95)
  const deleteX = card.locator('.sblock-delete-row');
  const beforeDlg = dialogCount;
  await deleteX.click();
  await page.waitForTimeout(400);
  const dlgFiredAfterX = dialogCount > beforeDlg;
  const modalOpenAfterX = await isEditModalOpen();
  const test1OK = dlgFiredAfterX && !modalOpenAfterX;
  console.log(`  Click X:    dialog_fired=${dlgFiredAfterX}  modal_open=${modalOpenAfterX}  ${test1OK ? GREEN('PASS') : RED('FAIL')}`);
  if (dlgFiredAfterX) console.log(GRAY(`    dialog text: "${lastDialogText.slice(0, 80)}…"`));

  if (modalOpenAfterX) await page.keyboard.press('Escape').catch(() => {});

  // ── Test 2: click card body (upper-right safe zone), no dialog ──
  // Note: by now we already moved mouse to the safe zone for Test 1, so
  // we have to move OFF the card and back ON to register a fresh click.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  const card2 = page.locator('.sblock').first();
  const box = await card2.boundingBox();
  if (!box) {
    console.log(RED('  Click body: could not measure card box — SKIP'));
    return { test1OK, test2OK: false };
  }
  const beforeDlg2 = dialogCount;
  await page.mouse.click(box.x + box.width - 12, box.y + 12);
  await page.waitForTimeout(400);
  const dlgFiredAfterBody = dialogCount > beforeDlg2;
  const modalOpenAfterBody = await isEditModalOpen();
  const test2OK = !dlgFiredAfterBody && modalOpenAfterBody;
  console.log(`  Click body: dialog_fired=${dlgFiredAfterBody}  modal_open=${modalOpenAfterBody}  ${test2OK ? GREEN('PASS') : RED('FAIL')}`);

  if (modalOpenAfterBody) await page.keyboard.press('Escape').catch(() => {});
  return { test1OK, test2OK };
}

async function runSweep(page) {
  const reports = [];
  for (const vw of VIEWPORTS) {
    const cards = await inspectCardsAt(page, vw);
    reports.push({ width: vw, cards });
  }
  return reports;
}

async function runHoverRevealSweep(page) {
  const checks = [];
  for (const vw of VIEWPORTS) checks.push(await inspectHoverRevealAt(page, vw));
  return checks;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    console.log(GRAY(`Logging in as ${SCHEDULER.username}…`));
    await login(page);

    // DOM matrix sweep #1 (at-rest checks across all viewports)
    const r1 = await runSweep(page);
    const s1 = summarize(r1);
    printSweep('SWEEP #1 (DOM matrix, at-rest)', r1, s1);

    // DOM matrix sweep #2
    const r2 = await runSweep(page);
    const s2 = summarize(r2);
    printSweep('SWEEP #2 (DOM matrix, at-rest)', r2, s2);

    // Hover-reveal sweep — ONE card per viewport, verify on-hover opacity
    console.log(`\n${YEL('HOVER-REVEAL SWEEP')}  (mouse-over → opacity ≥ ${HOVER_OPACITY_MIN})`);
    const hrs = await runHoverRevealSweep(page);
    for (const h of hrs) {
      const op = h.hoverOpacity == null ? 'n/a' : h.hoverOpacity.toFixed(2);
      console.log(`  vw=${h.width}px  on-hover opacity=${op}  ${h.ok ? GREEN('PASS') : RED('FAIL')}`);
    }
    const hoverOK = hrs.every(h => h.ok);

    // Click isolation (hover, then click)
    const click = await runClickIsolationTest(page);

    const domOK   = s1.failures.length === 0 && s2.failures.length === 0 && s1.total > 0 && s2.total > 0;
    const clickOK = click.test1OK && click.test2OK;
    const ok = domOK && hoverOK && clickOK;
    console.log(`\n${ok ? GREEN('PHASE 48 VERIFIED ✓') : RED('PHASE 48 NOT VERIFIED ✗')}`);
    if (!domOK)   console.log(RED('  → DOM matrix had failures'));
    if (!hoverOK) console.log(RED('  → hover-reveal sweep failed'));
    if (!clickOK) console.log(RED('  → click-isolation test failed'));
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(RED('Verifier crashed:'), e);
    process.exit(2);
  } finally {
    await browser.close();
  }
})();
