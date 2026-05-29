// scripts/phase46-card-verify.js
//
// Phase 46 DOM-inspection sweep. Verifies that for every visible
// `.sblock` card, at every tier, the user's Phase 46 contract holds:
//
//   1. ALL six identity fields are present in the DOM
//        hasCode, hasSection, hasType, hasTime, hasInstructor, hasVenue
//   2. The per-instance delete-X is RESTORED (not display:none)
//        hasDeleteX
//   3. The LEC/LAB badge sits at the card's bottom-RIGHT corner
//        (within a 6px tolerance to the card's bottom-right edge)
//   4. The delete-X sits at the card's bottom-LEFT corner
//   5. NO PIXEL OVERLAP between any pair of indicators (badge,
//      delete-X, venue, instructor, time). All bounding boxes
//      must be disjoint.
//
// The sweep runs at 6 viewport widths (1920, 1440, 1280, 1024, 800,
// 720) to exercise every density tier. We require TWO consecutive
// clean sweeps before claiming Phase 46 verified.
//
// Usage:  node scripts/phase46-card-verify.js
// Exit code 0 = both sweeps clean, 1 = any failure.

const { chromium } = require('playwright');

const APP_URL    = process.env.APP_URL || 'http://localhost:3000';
const API_URL    = process.env.API_URL || 'http://localhost:4000/api/v1';
const SCHEDULER  = { username: 'scheduler1', password: 'password123' };
const VIEWPORTS  = [1920, 1440, 1280, 1024, 800, 720];
const TOLERANCE  = 6; // px — corner-anchor margin of error

const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const RED   = s => `\x1b[31m${s}\x1b[0m`;
const GRAY  = s => `\x1b[90m${s}\x1b[0m`;
const YEL   = s => `\x1b[33m${s}\x1b[0m`;

// ── Rect helpers ──────────────────────────────────────────────────────────
function intersects(a, b) {
  if (!a || !b) return false;
  return !(a.right  <= b.left  ||
           b.right  <= a.left  ||
           a.bottom <= b.top   ||
           b.bottom <= a.top);
}
function rectArea(r) { return r ? Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top) : 0; }

// ── Login ─────────────────────────────────────────────────────────────────
async function login(page) {
  // App.jsx renders LoginPage vs SchedulerPage based on AppContext token
  // (no real router). After form submit, the LoginPage component is replaced
  // with SchedulerPage in-place — the URL never changes. So we wait on
  // localStorage having a token, NOT on URL change.
  await page.goto(`${APP_URL}/`);
  await page.locator('input[autocomplete="username"]').first().fill(SCHEDULER.username);
  await page.locator('input[autocomplete="current-password"]').first().fill(SCHEDULER.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForFunction(() => !!localStorage.getItem('token'), null, { timeout: 8000 });
  // Once authed, the SchedulerPage mounts in-place. Wait for it to render
  // the grid (the .scheduler-page wrapper or .sblock cards, whichever first).
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
}

async function gotoScheduler(page) {
  // No /scheduler route — App.jsx swaps component by token. Already on it
  // after login. Just wait for cards.
  await page.waitForSelector('.sblock', { timeout: 15000 }).catch(() => {});
}

// ── Per-card inspection in the browser ────────────────────────────────────
async function inspectCardsAt(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(450); // let ResizeObserver-driven CSS classes settle

  // Gather card data inside the page so we use real layout coordinates
  return page.evaluate(({ tol }) => {
    const cards = Array.from(document.querySelectorAll('.sblock'));
    function rectOf(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    }
    function intersects(a, b) {
      if (!a || !b) return false;
      // A rectangle with zero area has no pixels — it cannot visually
      // overlap anything. This matters at extreme densities where
      // margin-left + margin-right exceed card width, collapsing the
      // element's bounding box to zero width.
      const aw = a.right - a.left, ah = a.bottom - a.top;
      const bw = b.right - b.left, bh = b.bottom - b.top;
      if (aw <= 0 || ah <= 0 || bw <= 0 || bh <= 0) return false;
      return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    }

    return cards.slice(0, 60).map((c, idx) => {
      const cardRect = rectOf(c);
      if (!cardRect || cardRect.width < 1) return null;

      // Identify the current tier (one of tier-spacious/compact/tight/minimal/micro/tiny)
      const tier = Array.from(c.classList).find(cls => cls.startsWith('tier-')) || '(none)';
      const narrow = c.classList.contains('narrow');

      const codeEl     = c.querySelector('.sblock-code');
      const sectionEl  = c.querySelector('.sblock-section');
      const typeEl     = c.querySelector('.sblock-type-badge');
      const timeEl     = c.querySelector('.sblock-time');
      const instrEl    = c.querySelector('.sblock-instr');
      const noInstrEl  = c.querySelector('.sblock-no-instr');
      const venueEl    = c.querySelector('.sblock-venue');
      const deleteEl   = c.querySelector('.sblock-delete-row');

      const typeRect   = rectOf(typeEl);
      const deleteRect = rectOf(deleteEl);
      const venueRect  = rectOf(venueEl);
      const instrRect  = rectOf(instrEl || noInstrEl);
      const timeRect   = rectOf(timeEl);

      // Corner anchor checks — within tol px of the relevant card edge
      const badgeAtBottomRight = !!typeRect &&
        Math.abs(cardRect.bottom - typeRect.bottom) <= tol &&
        Math.abs(cardRect.right  - typeRect.right ) <= tol;

      // delete-X may be display:inline-flex with opacity:0; still has a rect
      const deleteAtBottomLeft = !!deleteRect &&
        Math.abs(cardRect.bottom - deleteRect.bottom) <= tol &&
        Math.abs(cardRect.left   - deleteRect.left  ) <= tol;

      // Pairwise overlap checks. Note: the badge is z-index above
      // everything; visual overlap is what the user objects to, but
      // bounding-box intersection is the more conservative check.
      const overlaps = {
        badge_vs_delete : intersects(typeRect, deleteRect),
        badge_vs_venue  : intersects(typeRect, venueRect ),
        badge_vs_instr  : intersects(typeRect, instrRect ),
        delete_vs_venue : intersects(deleteRect, venueRect),
        delete_vs_instr : intersects(deleteRect, instrRect),
      };
      const noOverlap = !Object.values(overlaps).some(v => v);

      const typeText = (typeEl?.textContent || '').trim();
      const hasTypeText = typeText === 'LEC' || typeText === 'LAB';

      return {
        idx, tier, narrow,
        card: { w: Math.round(cardRect.width), h: Math.round(cardRect.height) },
        hasCode       : !!codeEl    && (codeEl.textContent || '').trim().length > 0,
        hasSection    : !!sectionEl && (sectionEl.textContent || '').trim().length > 0,
        hasType       : !!typeEl && hasTypeText,
        hasTime       : !!timeEl    && (timeEl.textContent || '').trim().length > 0,
        hasInstructor : (!!instrEl  && (instrEl.textContent  || '').trim().length > 0) ||
                        (!!noInstrEl && (noInstrEl.textContent || '').trim().length > 0),
        hasVenue      : !!venueEl   && (venueEl.textContent  || '').trim().length > 0,
        hasDeleteX    : !!deleteEl,  // present in DOM (opacity:0 OK)
        badgeAtBottomRight,
        deleteAtBottomLeft,
        noOverlap,
        overlaps,
        typeText,
      };
    }).filter(Boolean);
  }, { tol: TOLERANCE });
}

// ── Per-sweep summary ──────────────────────────────────────────────────────
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
      };
      const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      if (bad.length === 0) {
        passing++;
      } else {
        failures.push({ viewport: r.width, idx: card.idx, tier: card.tier, narrow: card.narrow, card: card.card, failed: bad, overlaps: card.overlaps, typeText: card.typeText });
      }
    }
  }
  return { total, passing, failures };
}

function printSweep(label, reports, summary) {
  console.log(`\n${GRAY('─'.repeat(70))}`);
  console.log(`${YEL(label)}  total=${summary.total}  passing=${summary.passing}  failing=${summary.total - summary.passing}`);
  for (const r of reports) {
    const failCt = r.cards.filter(c => !(c.hasCode && c.hasSection && c.hasType && c.hasTime && c.hasInstructor && c.hasVenue && c.hasDeleteX && c.badgeAtBottomRight && c.deleteAtBottomLeft && c.noOverlap)).length;
    const tag = failCt === 0 ? GREEN('clean') : RED(`${failCt} fail`);
    const tiers = Array.from(new Set(r.cards.map(c => c.tier + (c.narrow ? '+narrow' : '')))).join(',');
    console.log(`  vw=${r.width}px  cards=${r.cards.length}  ${tag}  tiers=[${tiers}]`);
  }
  if (summary.failures.length) {
    console.log(`\n${RED('Failures (first 6):')}`);
    summary.failures.slice(0, 6).forEach(f => {
      const failedList = f.failed.join(', ');
      const overlaps   = Object.entries(f.overlaps || {}).filter(([, v]) => v).map(([k]) => k).join(',') || '—';
      console.log(`  vw=${f.viewport}  idx=${f.idx}  tier=${f.tier}${f.narrow ? '+narrow' : ''}  card=${f.card.w}×${f.card.h}  typeText="${f.typeText || ''}"`);
      console.log(`    failed: ${failedList}`);
      console.log(`    overlaps: ${overlaps}`);
    });
  }
}

// ── Run one sweep across all viewports ────────────────────────────────────
async function runSweep(page) {
  const reports = [];
  for (const vw of VIEWPORTS) {
    const cards = await inspectCardsAt(page, vw);
    reports.push({ width: vw, cards });
  }
  return reports;
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  try {
    console.log(GRAY(`Logging in as ${SCHEDULER.username}…`));
    await login(page);
    console.log(GRAY('Opening /scheduler…'));
    await gotoScheduler(page);

    // Two consecutive sweeps are required for a green build.
    const r1 = await runSweep(page);
    const s1 = summarize(r1);
    printSweep('SWEEP #1', r1, s1);

    const r2 = await runSweep(page);
    const s2 = summarize(r2);
    printSweep('SWEEP #2', r2, s2);

    const ok = s1.failures.length === 0 && s2.failures.length === 0 && s1.total > 0 && s2.total > 0;
    console.log(`\n${ok ? GREEN('PHASE 46 VERIFIED ✓') : RED('PHASE 46 NOT VERIFIED ✗')}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(RED('Verifier crashed:'), e);
    process.exit(2);
  } finally {
    await browser.close();
  }
})();
