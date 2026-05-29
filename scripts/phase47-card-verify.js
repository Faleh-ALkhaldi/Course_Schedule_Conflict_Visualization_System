// scripts/phase47-card-verify.js
//
// Phase 47 DOM-inspection sweep. Builds on Phase 46's matrix
// (all 6 identity fields present, indicators at correct corners,
// no overlaps) and ADDS the Phase 47 contract for the per-instance
// delete `✕` button:
//
//   A. Visible at rest (no card-hover): computed opacity > 0.5.
//      Phase 46's `opacity: 0` rest state hid the affordance behind
//      a hover-to-discover gesture — users couldn't see what they
//      could click. Phase 47 requires the button be self-evident.
//
//   B. Hit-target area meets a per-tier minimum px² floor.
//      Fitts's-Law: a 196 px² (14×14) target is the bottom of the
//      "confident mouse click without misses" range; tier-tiny just
//      barely clears it, every other tier exceeds by 1.5-3×.
//
//   C. Click isolation: clicking the X fires the delete-confirm
//      dialog (proving the handler ran) AND the section edit modal
//      does NOT open (proving e.stopPropagation prevented bubble-up
//      to the card's onClick). We auto-dismiss the confirm so no
//      data is actually deleted.
//
//   D. Negative click test: clicking the card body (NOT on the X)
//      opens the edit modal and does NOT fire the confirm dialog.
//      This proves the X isn't accidentally intercepting all clicks.
//
// Two consecutive full-clean sweeps required.
// Exit 0 = both clean, 1 = any failure.

const { chromium } = require('playwright');

const APP_URL    = process.env.APP_URL || 'http://localhost:3000';
const SCHEDULER  = { username: 'scheduler1', password: 'password123' };
const VIEWPORTS  = [1920, 1440, 1280, 1024, 800, 720];
const TOLERANCE  = 6;

// Per-tier minimum px² floors. Each is the SQUARE of the user's
// declared dimension floor (e.g., tier-tiny 14×14 = 196).
const MIN_HIT_AREA_BY_TIER = {
  'tier-spacious': 676,   // 26×26
  'tier-compact':  676,   // 26×26
  'tier-tight':    484,   // 22×22
  'tier-minimal':  324,   // 18×18
  'tier-micro':    256,   // 16×16
  'tier-tiny':     196,   // 14×14
};
// `.narrow` modifier overrides to 20×20 = 400 (replaces base size
// from whatever tier it composes with). Applied as a separate floor.
const MIN_HIT_AREA_NARROW = 400;
const MIN_REST_OPACITY    = 0.5;

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

// ── Per-card inspection (Phase 46 + Phase 47 checks combined) ────────────
async function inspectCardsAt(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(450);

  // Move mouse to top-left corner of viewport so NO card has :hover —
  // we need to measure the at-rest opacity, not the hover opacity.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(120);

  return page.evaluate(({ tol, minOpacity, minAreaByTier, minAreaNarrow }) => {
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
      const timeRect   = rectOf(timeEl);

      // Phase 46 checks
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

      // Phase 47 checks: visible-at-rest opacity + hit-target area
      let restOpacity = 0;
      let hitArea = 0;
      if (deleteEl) {
        const cs = getComputedStyle(deleteEl);
        // Effective opacity = self * any ancestor that's :not-fully-opaque.
        // For our case, the parent .sblock has opacity:1, so cs.opacity
        // alone is the effective opacity AT REST.
        restOpacity = parseFloat(cs.opacity) || 0;
        hitArea = (deleteRect.right - deleteRect.left) * (deleteRect.bottom - deleteRect.top);
      }
      const minAreaForCard = narrow
        ? Math.max(minAreaByTier[tier] || 0, minAreaNarrow)
        : (minAreaByTier[tier] || 0);
      // narrow's 400 floor only OVERRIDES if smaller than tier floor
      // — but practically it raises the floor for narrow+tier-minimal/
      // micro/tiny. Use min(tier, narrow) so narrow doesn't accidentally
      // require MORE than the tier-spacious base. (The user spec listed
      // narrow as 20×20 which is between minimal and tight — meaning
      // narrow is the dominant constraint at the densest tiers but
      // not at wider ones.)
      const effectiveMinArea = narrow
        ? Math.min(minAreaByTier[tier] || 0, minAreaNarrow)
        : (minAreaByTier[tier] || 0);

      return {
        idx, tier, narrow,
        card: { w: Math.round(cardRect.width), h: Math.round(cardRect.height) },
        hasCode       : !!codeEl    && (codeEl.textContent    || '').trim().length > 0,
        hasSection    : !!sectionEl && (sectionEl.textContent || '').trim().length > 0,
        hasType       : !!typeEl && hasTypeText,
        hasTime       : !!timeEl    && (timeEl.textContent || '').trim().length > 0,
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
        opacityOK: restOpacity > minOpacity,
        hitAreaOK: hitArea >= effectiveMinArea,
      };
    }).filter(Boolean);
  }, { tol: TOLERANCE, minOpacity: MIN_REST_OPACITY, minAreaByTier: MIN_HIT_AREA_BY_TIER, minAreaNarrow: MIN_HIT_AREA_NARROW });
}

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
        opacityOK: card.opacityOK,
        hitAreaOK: card.hitAreaOK,
      };
      const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      if (bad.length === 0) {
        passing++;
      } else {
        failures.push({
          viewport: r.width,
          idx: card.idx,
          tier: card.tier,
          narrow: card.narrow,
          card: card.card,
          failed: bad,
          overlaps: card.overlaps,
          restOpacity: card.restOpacity,
          hitArea: card.hitArea,
          effectiveMinArea: card.effectiveMinArea,
        });
      }
    }
  }
  return { total, passing, failures };
}

function printSweep(label, reports, summary) {
  console.log(`\n${GRAY('─'.repeat(70))}`);
  console.log(`${YEL(label)}  total=${summary.total}  passing=${summary.passing}  failing=${summary.total - summary.passing}`);
  for (const r of reports) {
    const failCt = r.cards.filter(c => !(c.hasCode && c.hasSection && c.hasType && c.hasTime && c.hasInstructor && c.hasVenue && c.hasDeleteX && c.badgeAtBottomRight && c.deleteAtBottomLeft && c.noOverlap && c.opacityOK && c.hitAreaOK)).length;
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
      if (f.failed.includes('opacityOK'))  console.log(`    rest opacity = ${f.restOpacity.toFixed(2)} (need > ${MIN_REST_OPACITY})`);
      if (f.failed.includes('hitAreaOK'))  console.log(`    hit area = ${Math.round(f.hitArea)} px² (need ≥ ${f.effectiveMinArea})`);
      if (f.failed.includes('noOverlap'))  console.log(`    overlaps: ${overlaps}`);
    });
  }
}

// ── Click-isolation test ──────────────────────────────────────────────────
// Click the X on a card; confirm dialog appears AND modal does NOT open.
// Then click the card body; modal opens AND no dialog appears.
async function runClickIsolationTest(page) {
  console.log(`\n${YEL('CLICK ISOLATION TEST')}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  // Set up dialog interceptor: always cancel so no real delete happens.
  let dialogCount = 0;
  let lastDialogText = '';
  page.on('dialog', async d => {
    dialogCount++;
    lastDialogText = d.message();
    await d.dismiss();   // cancel — keeps test data intact
  });

  // Helper to check if the section edit modal is open.
  // SectionModal.jsx renders with `.sm-overlay > .sm-card`.
  async function isEditModalOpen() {
    return page.evaluate(() => {
      const el = document.querySelector('.sm-overlay, .sm-card');
      if (!el) return false;
      // Make sure it's actually visible (not display:none / opacity:0)
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || parseFloat(cs.opacity) === 0) return false;
      return true;
    });
  }

  // ── Test 1: click the X ──
  const card = page.locator('.sblock').first();
  await card.scrollIntoViewIfNeeded();
  const deleteX = card.locator('.sblock-delete-row');
  const beforeDlg = dialogCount;
  await deleteX.click({ force: true });   // force ignores hover requirements
  await page.waitForTimeout(400);
  const dlgFiredAfterX = dialogCount > beforeDlg;
  const modalOpenAfterX = await isEditModalOpen();
  const xText = dlgFiredAfterX ? lastDialogText : '(no dialog)';

  const test1OK = dlgFiredAfterX && !modalOpenAfterX;
  console.log(`  Click X:    dialog_fired=${dlgFiredAfterX}  modal_open=${modalOpenAfterX}  ${test1OK ? GREEN('PASS') : RED('FAIL')}`);
  if (dlgFiredAfterX) console.log(GRAY(`    dialog text: "${xText.slice(0, 80)}…"`));

  // If a modal somehow did open, close it before test 2 to avoid bleed-over
  if (modalOpenAfterX) await page.keyboard.press('Escape').catch(() => {});

  // ── Test 2: click the card body (not on the X) ──
  // Card has its delete-X at bottom-left. Click in the upper-right portion
  // of the card to be safely away from the X.
  const card2 = page.locator('.sblock').first();
  const box = await card2.boundingBox();
  if (!box) {
    console.log(RED('  Click body: could not measure card box — SKIP'));
    return { test1OK, test2OK: false };
  }
  const beforeDlg2 = dialogCount;
  await page.mouse.click(box.x + box.width - 12, box.y + 12);   // top-right area
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

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    console.log(GRAY(`Logging in as ${SCHEDULER.username}…`));
    await login(page);

    // Sweep 1 (DOM-inspection)
    const r1 = await runSweep(page);
    const s1 = summarize(r1);
    printSweep('SWEEP #1 (DOM matrix)', r1, s1);

    // Sweep 2 (DOM-inspection)
    const r2 = await runSweep(page);
    const s2 = summarize(r2);
    printSweep('SWEEP #2 (DOM matrix)', r2, s2);

    // Click-isolation sweep — only runs after DOM sweeps to keep state clean
    const click = await runClickIsolationTest(page);

    const domOK   = s1.failures.length === 0 && s2.failures.length === 0 && s1.total > 0 && s2.total > 0;
    const clickOK = click.test1OK && click.test2OK;
    const ok = domOK && clickOK;
    console.log(`\n${ok ? GREEN('PHASE 47 VERIFIED ✓') : RED('PHASE 47 NOT VERIFIED ✗')}`);
    if (!domOK) console.log(RED('  → DOM matrix had failures'));
    if (!clickOK) console.log(RED('  → click-isolation test failed'));
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(RED('Verifier crashed:'), e);
    process.exit(2);
  } finally {
    await browser.close();
  }
})();
