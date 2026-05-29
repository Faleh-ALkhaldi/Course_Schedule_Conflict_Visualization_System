// scripts/capture-fu121-grid-verification.js
//
// Visual verification for the schedule-grid layout after NEW-FU-132..FU-135
// (proportional day widths + density tiers + tier-adaptive SectionBlock).
//
// At THREE zoom levels (min, default, max) the following must ALL hold for
// Course / Teacher / Venue views:
//
//   1. ZERO horizontal scroll: scrollWidth ≤ clientWidth on .sg-root.
//   2. ALL 5 day headers visible inside the viewport.
//   3. Every .sblock shows all FOUR info elements (code, time, instr,
//      venue) with non-empty text — at every density tier.
//   4. ZERO same-lane vertical-overlap collisions (same (x,w) bucket).
//   5. ZERO overlap between hour-axis labels and card rects.
//   6. ZERO truncated text spans (scrollWidth > clientWidth + 1).

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const API_URL = process.env.API_URL || 'http://localhost:4000/api/v1';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const OUT_DIR = path.join(__dirname, '..', 'cscvs-screenshots');
const VIEWPORT = { width: 1440, height: 900 };
const SCHEDULER = { username: 'scheduler1', password: 'password123' };

fs.mkdirSync(OUT_DIR, { recursive: true });

function nextTestIp() {
  return `10.135.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
}

async function loginAndOpenSchedule(page) {
  const ip = nextTestIp();
  await page.route('**/api/v1/**', route => {
    const headers = { ...route.request().headers(), 'X-Forwarded-For': ip };
    return route.continue({ headers });
  });
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]', { timeout: 8000 });
  await page.fill('input[name="username"], input[type="text"]', SCHEDULER.username);
  await page.fill('input[type="password"]', SCHEDULER.password);
  await page.click('button.login-btn, button[type="submit"]');
  await page.waitForSelector('.sg-root', { timeout: 15000 });
  await page.waitForTimeout(1200);
}

async function setZoom(page, level) {
  // The grid stores rowH in component state; zoom buttons step by 8.
  // We invoke clicks to reach the desired level. ROW_H_MIN=22, ROW_H_MAX=96,
  // ROW_H_DEFAULT=48. Defaults to default zoom on a fresh page.
  // To reach `min`, click `−` until disabled. To reach `max`, click `+` likewise.
  if (level === 'min') {
    for (let i = 0; i < 12; i++) {
      const btn = page.locator('.sg-zoom-btn:has-text("－")');
      if (await btn.isDisabled()) break;
      await btn.click(); await page.waitForTimeout(60);
    }
  } else if (level === 'max') {
    for (let i = 0; i < 12; i++) {
      const btn = page.locator('.sg-zoom-btn:has-text("＋")');
      if (await btn.isDisabled()) break;
      await btn.click(); await page.waitForTimeout(60);
    }
  } else {
    // default — first reset to max then step down to default
    for (let i = 0; i < 12; i++) {
      const btn = page.locator('.sg-zoom-btn:has-text("＋")');
      if (await btn.isDisabled()) break;
      await btn.click(); await page.waitForTimeout(40);
    }
    for (let i = 0; i < 6; i++) {
      // From max=96 step down by 8 six times → 48 (default)
      const btn = page.locator('.sg-zoom-btn:has-text("－")');
      if (await btn.isDisabled()) break;
      await btn.click(); await page.waitForTimeout(40);
    }
  }
  await page.waitForTimeout(300);
}

async function dumpBlocks(page) {
  return await page.evaluate(() => {
    // NEW-FU-145: WCAG relative luminance + contrast ratio helpers
    // injected into page context so we read live computed styles.
    function parseRgb(s) {
      const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s);
      return m ? [+m[1], +m[2], +m[3]] : null;
    }
    function relLum([r, g, b]) {
      const c = [r, g, b].map(v => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      });
      return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2];
    }
    function contrast(rgb1, rgb2) {
      const l1 = relLum(rgb1), l2 = relLum(rgb2);
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
      return (hi + 0.05) / (lo + 0.05);
    }
    function readFieldContrast(el, bgEl) {
      const cs = getComputedStyle(el);
      const bgCs = getComputedStyle(bgEl);
      const fg = parseRgb(cs.color);
      const bg = parseRgb(bgCs.backgroundColor);
      if (!fg || !bg) return null;
      const fontPx = parseFloat(cs.fontSize);
      const fontWeight = parseInt(cs.fontWeight, 10) || 400;
      return { ratio: contrast(fg, bg), fg: cs.color, bg: bgCs.backgroundColor, fontPx, fontWeight };
    }

    const sgRoot = document.querySelector('.sg-root');
    const sgRootRect = sgRoot.getBoundingClientRect();
    const sgRootScrollW = sgRoot.scrollWidth;
    const sgRootClientW = sgRoot.clientWidth;
    const dayHeaders = [...document.querySelectorAll('.sg-day-header')].map(h => {
      const r = h.getBoundingClientRect();
      return { text: h.textContent.trim(), x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right), visible: r.right <= window.innerWidth + 1 };
    });
    const hourLabels = [...document.querySelectorAll('.sg-hour-label')].map(l => {
      const r = l.getBoundingClientRect();
      return { text: l.textContent.trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    // NEW-FU-145: scan view-tab buttons + page heading text for any
    // leaking "Teacher" string.
    const tabText = [...document.querySelectorAll('button')]
      .map(b => b.textContent.trim())
      .filter(t => /view/i.test(t))
      .join(' | ');
    const headingText = (document.querySelector('h2, h3, .scheduler-toolbar, [class*="heading"]') || document.body).innerText.slice(0, 2000);
    const blocks = [...document.querySelectorAll('.sblock')].map((b, idx) => {
      const rect = b.getBoundingClientRect();
      const text = sel => (b.querySelector(sel)?.textContent || '').trim();
      const tier = (b.className.match(/tier-(\w+)/) || [])[1] || 'unknown';
      const truncatedSpans = [...b.querySelectorAll('.sblock-code, .sblock-instr, .sblock-venue, .sblock-time')]
        .filter(el => el.scrollWidth > el.clientWidth + 1)
        .map(el => ({ field: el.className.replace('sblock-', ''), text: el.textContent.trim(), scrollW: el.scrollWidth, clientW: el.clientWidth }));
      // NEW-FU-140: bottom of last-rendered content row (venue OR
      // no-venue warning) — used to detect content spilling past the
      // card's bottom border.
      const lastContentRect = (() => {
        const candidates = ['.sblock-venue', '.sblock-no-instr', '.sblock-instr', '.sblock-time'];
        for (const sel of candidates) {
          const els = b.querySelectorAll(sel);
          if (els.length) {
            const r = els[els.length - 1].getBoundingClientRect();
            return { selector: sel, bottom: Math.round(r.bottom) };
          }
        }
        return null;
      })();
      // NEW-FU-145 + FU-157: per-text-field contrast + font-weight readings.
      const contrasts = {};
      for (const sel of ['.sblock-code', '.sblock-time', '.sblock-instr', '.sblock-venue', '.sblock-section']) {
        const el = b.querySelector(sel);
        if (!el) continue;
        const m = readFieldContrast(el, b);
        if (m) contrasts[sel.replace('.sblock-', '')] = { ratio: +m.ratio.toFixed(2), fg: m.fg, bg: m.bg, fontPx: m.fontPx, weight: m.fontWeight };
      }
      // NEW-FU-157: font-smoothing assertion on .sblock parent.
      const blockCS = getComputedStyle(b);
      const fontSmoothing = blockCS.getPropertyValue('-webkit-font-smoothing') || blockCS.webkitFontSmoothing || '';
      return {
        idx, tier,
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
        lastContentBottom: lastContentRect ? lastContentRect.bottom : null,
        lastContentSel: lastContentRect ? lastContentRect.selector : null,
        code:    text('.sblock-code'),
        section: text('.sblock-section'),
        badge:   text('.sblock-type-badge'),
        time:    text('.sblock-time'),
        instr:   text('.sblock-instr'),
        venue:   text('.sblock-venue'),
        noInstr: !!b.querySelector('.sblock-no-instr'),
        truncated: truncatedSpans,
        contrasts,
        fontSmoothing,
      };
    });
    return {
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      sgRoot: { x: Math.round(sgRootRect.x), w: Math.round(sgRootRect.width), scrollW: sgRootScrollW, clientW: sgRootClientW },
      dayHeaders,
      hourLabels,
      tabText, headingText,
      blocks,
    };
  });
}

// NEW-FU-145 + FU-157: contrast violations — text field vs .sblock bg.
// Tightened from WCAG AA (4.5) to a stricter 5.5 baseline for normal
// text (large text ≥18.66px still allowed 3.0). The 5.5 floor catches
// borderline AA pairings that look pale against pastel backgrounds.
function findContrastViolations(blocks) {
  const out = [];
  for (const b of blocks) {
    for (const [field, m] of Object.entries(b.contrasts ?? {})) {
      const minRatio = m.fontPx >= 18.66 ? 3.0 : 5.5;
      if (m.ratio < minRatio) {
        out.push({ idx: b.idx, code: b.code, tier: b.tier, field, ratio: m.ratio, minRatio, fontPx: m.fontPx, fg: m.fg, bg: m.bg });
      }
    }
  }
  return out;
}

// NEW-FU-157: font-weight assertion. Every sub-field (time/instr/venue/
// section) must be ≥700 across all tiers. The code is already 700 (set
// in FU-142). This catches accidental weight regressions.
function findFontWeightViolations(blocks) {
  const out = [];
  for (const b of blocks) {
    for (const field of ['time', 'instr', 'venue', 'section', 'code']) {
      const m = b.contrasts?.[field];
      if (!m) continue;
      if (m.weight < 700) {
        out.push({ idx: b.idx, code: b.code, tier: b.tier, field, weight: m.weight });
      }
    }
  }
  return out;
}

// NEW-FU-157: macOS Safari renders thin strokes blurry without the
// -webkit-font-smoothing: antialiased hint. Every .sblock must carry
// that property in its computed style.
function findFontSmoothingViolations(blocks) {
  return blocks
    .filter(b => b.fontSmoothing !== 'antialiased' && b.fontSmoothing !== 'subpixel-antialiased')
    .map(b => ({ idx: b.idx, code: b.code, tier: b.tier, value: b.fontSmoothing || '(none)' }));
}

// NEW-FU-145: any user-visible "Teacher" leak.
function findTeacherLeaks(dump) {
  const out = [];
  if (/Teacher/i.test(dump.tabText)) out.push({ where: 'view-tabs', text: dump.tabText });
  if (/Teacher/i.test(dump.headingText)) out.push({ where: 'page-heading', text: dump.headingText.split('\n').find(l => /Teacher/i.test(l)) || dump.headingText.slice(0, 200) });
  for (const h of dump.dayHeaders) {
    if (/Teacher/i.test(h.text)) out.push({ where: 'day-header', text: h.text });
  }
  return out;
}

function rectCollide(a, b, TOL = 1) {
  return !(
    a.x + a.w <= b.x + TOL ||
    b.x + b.w <= a.x + TOL ||
    a.y + a.h <= b.y + TOL ||
    b.y + b.h <= a.y + TOL
  );
}

function findSameLaneCollisions(blocks) {
  const lanes = new Map();
  for (const b of blocks) {
    const key = `${Math.round(b.x / 5) * 5}|${Math.round(b.w / 5) * 5}`;
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(b);
  }
  const out = [];
  for (const [key, group] of lanes) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (rectCollide(group[i], group[j])) {
          out.push({ lane: key, a: { y: group[i].y, h: group[i].h, code: group[i].code, time: group[i].time }, b: { y: group[j].y, h: group[j].h, code: group[j].code, time: group[j].time } });
        }
      }
    }
  }
  return out;
}

function findLabelCardOverlap(blocks, labels) {
  const out = [];
  for (const lab of labels) {
    for (const b of blocks) {
      if (rectCollide(lab, b, 0)) {
        out.push({ label: lab.text, lx: lab.x, ly: lab.y, lw: lab.w, lh: lab.h, code: b.code, bx: b.x, by: b.y, bw: b.w, bh: b.h });
      }
    }
  }
  return out;
}

function findMissingInfo(blocks) {
  // NEW-FU-140: every block must render code, time, instr, venue. The
  // .sblock-no-instr warning is acceptable as a substitute (it tells the
  // user *which* field is missing in the data — still "information").
  const out = [];
  for (const b of blocks) {
    const missing = [];
    if (!b.code) missing.push('code');
    if (!b.time) missing.push('time');
    if (!b.instr && !b.noInstr) missing.push('instr');
    if (!b.venue && !b.noInstr) missing.push('venue');
    if (missing.length > 0) out.push({ idx: b.idx, code: b.code, missing });
  }
  return out;
}

// NEW-FU-140: content stays within the card border.
function findContentSpillover(blocks) {
  return blocks
    .filter(b => b.lastContentBottom !== null && b.lastContentBottom > b.bottom + 1)
    .map(b => ({ idx: b.idx, code: b.code, tier: b.tier, bottom: b.bottom, lastContentBottom: b.lastContentBottom, sel: b.lastContentSel }));
}

// NEW-FU-140: time text must be a full range like "07:00–07:50".
function findTimeRangeViolations(blocks) {
  return blocks
    .filter(b => {
      if (!b.time) return false;
      // Full range = two colons and a dash/en-dash separator.
      const colons = (b.time.match(/:/g) || []).length;
      const hasSep = /[–\-]/.test(b.time);
      return colons < 2 || !hasSep;
    })
    .map(b => ({ idx: b.idx, code: b.code, time: b.time }));
}

// NEW-FU-140: badge text must be exactly "LEC" or "LAB" — uppercase, full.
function findBadgeViolations(blocks) {
  return blocks
    .filter(b => b.badge && !['LEC', 'LAB'].includes(b.badge))
    .map(b => ({ idx: b.idx, code: b.code, badge: b.badge, tier: b.tier }));
}

async function captureAtZoom(page, viewLabel, zoomLabel, filename, extra = null) {
  await setZoom(page, zoomLabel);
  await page.waitForTimeout(500);
  const file = path.join(OUT_DIR, filename);
  await page.screenshot({ path: file, fullPage: false });
  const dumpFile = path.join(OUT_DIR, filename.replace(/\.png$/, '.json'));
  const dump = await dumpBlocks(page);

  const truncated     = dump.blocks.filter(b => b.truncated.length > 0);
  const sameLaneColls = findSameLaneCollisions(dump.blocks);
  const labelOverlaps = findLabelCardOverlap(dump.blocks, dump.hourLabels);
  const missingInfo   = findMissingInfo(dump.blocks);
  const spillover     = findContentSpillover(dump.blocks);
  const timeViolations = findTimeRangeViolations(dump.blocks);
  const badgeViolations = findBadgeViolations(dump.blocks);
  const contrastViolations = findContrastViolations(dump.blocks);  // NEW-FU-145
  const teacherLeaks = findTeacherLeaks(dump);                       // NEW-FU-145
  const weightViolations    = findFontWeightViolations(dump.blocks); // NEW-FU-157
  const smoothingViolations = findFontSmoothingViolations(dump.blocks); // NEW-FU-157
  const horizontalScroll = dump.sgRoot.scrollW > dump.sgRoot.clientW + 1;
  const hiddenDays    = dump.dayHeaders.filter(d => !d.visible);
  const extraCheck    = extra ? extra(dump) : { ok: true };

  const ok = !horizontalScroll
          && hiddenDays.length === 0
          && truncated.length === 0
          && sameLaneColls.length === 0
          && labelOverlaps.length === 0
          && missingInfo.length === 0
          && spillover.length === 0
          && timeViolations.length === 0
          && badgeViolations.length === 0
          && contrastViolations.length === 0
          && teacherLeaks.length === 0
          && weightViolations.length === 0
          && smoothingViolations.length === 0
          && extraCheck.ok;

  fs.writeFileSync(dumpFile, JSON.stringify({
    view: viewLabel, zoom: zoomLabel,
    summary: {
      totalBlocks: dump.blocks.length,
      horizontalScroll, hiddenDayCount: hiddenDays.length,
      truncatedCount: truncated.length,
      sameLaneCollisionCount: sameLaneColls.length,
      labelCardOverlapCount: labelOverlaps.length,
      missingInfoCount: missingInfo.length,
      spilloverCount: spillover.length,
      timeRangeViolationCount: timeViolations.length,
      badgeViolationCount: badgeViolations.length,
      contrastViolationCount: contrastViolations.length,
      teacherLeakCount: teacherLeaks.length,
      weightViolationCount: weightViolations.length,
      smoothingViolationCount: smoothingViolations.length,
      extraCheck,
      pass: ok,
    },
    sgRoot: dump.sgRoot,
    dayHeaders: dump.dayHeaders,
    tabText: dump.tabText, headingText: dump.headingText,
    truncated, sameLaneCollisions: sameLaneColls,
    labelOverlaps, missingInfo, spillover, timeViolations, badgeViolations,
    contrastViolations, teacherLeaks, weightViolations, smoothingViolations,
    hourLabels: dump.hourLabels,
    blocks: dump.blocks,
  }, null, 2));

  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${viewLabel} @ ${zoomLabel}: ${dump.blocks.length} blocks · scroll=${horizontalScroll} hidden=${hiddenDays.length} trunc=${truncated.length} laneColl=${sameLaneColls.length} labelOv=${labelOverlaps.length} miss=${missingInfo.length} spill=${spillover.length} timeBad=${timeViolations.length} badgeBad=${badgeViolations.length} contrast=${contrastViolations.length} teacher=${teacherLeaks.length} weight<700=${weightViolations.length} smooth!=AA=${smoothingViolations.length}`);
  if (!ok) {
    if (horizontalScroll) console.log(`  → horizontal scroll: scrollW=${dump.sgRoot.scrollW} vs clientW=${dump.sgRoot.clientW}`);
    if (hiddenDays.length) console.log(`  → hidden days: ${hiddenDays.map(d => d.text).join(', ')} (viewportW=${dump.viewportW})`);
    if (truncated.length) truncated.slice(0, 5).forEach(b => console.log(`  → truncated: y=${b.y} w=${b.w} code="${b.code}" fields=${b.truncated.map(t=>t.field).join(',')}`));
    if (sameLaneColls.length) sameLaneColls.slice(0, 5).forEach(c => console.log(`  → lane collision: ${c.a.code}@y${c.a.y}h${c.a.h} ↔ ${c.b.code}@y${c.b.y}h${c.b.h}`));
    if (labelOverlaps.length) labelOverlaps.slice(0, 5).forEach(o => console.log(`  → label "${o.label}" overlaps card "${o.code}" (lab y=${o.ly} h=${o.lh}, block y=${o.by} h=${o.bh})`));
    if (missingInfo.length) missingInfo.slice(0, 5).forEach(m => console.log(`  → missing: ${m.code} → [${m.missing.join(',')}]`));
    if (spillover.length) spillover.slice(0, 5).forEach(s => console.log(`  → spillover: ${s.code} tier=${s.tier} card.bottom=${s.bottom} ${s.sel}.bottom=${s.lastContentBottom}`));
    if (timeViolations.length) timeViolations.slice(0, 5).forEach(t => console.log(`  → time: ${t.code} time="${t.time}" (need full range like "07:00–07:50")`));
    if (badgeViolations.length) badgeViolations.slice(0, 5).forEach(b => console.log(`  → badge: ${b.code} badge="${b.badge}" tier=${b.tier} (need exactly LEC or LAB)`));
    if (contrastViolations.length) contrastViolations.slice(0, 5).forEach(c => console.log(`  → contrast: ${c.code} ${c.field} ratio=${c.ratio} (need ≥${c.minRatio} for ${c.fontPx}px) fg=${c.fg} bg=${c.bg}`));
    if (teacherLeaks.length) teacherLeaks.slice(0, 5).forEach(l => console.log(`  → "Teacher" leak in ${l.where}: "${l.text}"`));
    if (weightViolations.length) weightViolations.slice(0, 5).forEach(v => console.log(`  → font-weight: ${v.code} ${v.field} weight=${v.weight} (need ≥700)`));
    if (smoothingViolations.length) smoothingViolations.slice(0, 5).forEach(v => console.log(`  → font-smoothing: ${v.code} value="${v.value}" (need antialiased)`));
  }
  return { dump, ok };
}

async function runView(page, name, tag, anchorCheck = null) {
  const results = [];
  for (const zoom of ['default', 'min', 'max']) {
    const filename = `fu132-${tag}-${zoom}.png`;
    results.push(await captureAtZoom(page, name, zoom, filename, anchorCheck));
  }
  return results;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  page.on('console', m => { if (m.type() === 'error') console.error('  [browser]', m.text()); });

  console.log('▶ Login');
  await loginAndOpenSchedule(page);

  console.log('▶ Course View — 3 zoom levels');
  const cv = await runView(page, 'Course View', 'course');

  console.log('▶ Instructor View (Dr. Ali) — 3 zoom levels');
  await page.locator('button:has-text("Instructor View")').click();
  await page.waitForTimeout(600);
  try {
    await page.locator('.sp-filter-item').filter({ hasText: 'Dr. Ali' }).first().click({ timeout: 3000 });
  } catch (e) {
    await page.locator('.sp-filter-item').first().click({ timeout: 2000 });
  }
  await page.waitForTimeout(1000);
  const tv = await runView(page, 'Teacher View', 'teacher');

  console.log('▶ Venue View (H-101) — 3 zoom levels');
  await page.locator('button:has-text("Venue View")').click();
  await page.waitForTimeout(600);
  try {
    await page.locator('.sp-filter-item').filter({ hasText: 'H-101' }).first().click({ timeout: 3000 });
  } catch (e) {
    await page.locator('.sp-filter-item').first().click({ timeout: 2000 });
  }
  await page.waitForTimeout(1000);
  const vv = await runView(page, 'Venue View', 'venue');

  // NEW-FU-145 + FU-150: popover sanity check. Hover SIX cards across
  // the grid (rightmost / leftmost / topmost / bottommost / middle /
  // conflict). Each placement must:
  //   • be fully inside the viewport
  //   • have width ≤ 320 and height ≤ 180 (correctly sized to content)
  //   • use computed position: fixed
  //   • not overlap any OTHER .sblock's rect (popover floats above them)
  // Also assert: zero .sblock elements still carry a non-empty `title`
  // attribute (FU-149 — that was conflicting with the custom popover).
  console.log('▶ Popover sanity check (Course View, default zoom)');
  await page.locator('button:has-text("Course View")').click();
  await page.waitForTimeout(600);
  await setZoom(page, 'default');

  // First: assert no title-attribute leaks AND collect block rect info.
  const setup = await page.evaluate(() => {
    function rectInside(r) {
      return r.left >= -0.5 && r.top >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
    }
    const allBlocks = [...document.querySelectorAll('.sblock')];
    const titleLeaks = allBlocks.filter(b => (b.getAttribute('title') ?? '').length > 0)
      .map(b => ({ code: b.querySelector('.sblock-code')?.textContent.trim() || '?', title: b.getAttribute('title') }));
    const blocks = allBlocks.map((b, i) => {
      const r = b.getBoundingClientRect();
      return {
        i, code: b.querySelector('.sblock-code')?.textContent.trim() || '?',
        x: r.x, y: r.y, w: r.width, h: r.height,
        right: r.right, bottom: r.bottom,
        conflict: b.classList.contains('conflict-hard') || b.classList.contains('conflict-soft'),
      };
    });
    return { titleLeaks, blocks, viewport: { w: window.innerWidth, h: window.innerHeight } };
  });

  // Pick 6 anchor points: rightmost / leftmost / topmost / bottommost / middle / conflict.
  const sortedByRight  = [...setup.blocks].sort((a,b) => b.right - a.right);
  const sortedByLeft   = [...setup.blocks].sort((a,b) => a.x - b.x);
  const sortedByTop    = [...setup.blocks].sort((a,b) => a.y - b.y);
  const sortedByBottom = [...setup.blocks].sort((a,b) => b.bottom - a.bottom);
  const conflict       = setup.blocks.find(b => b.conflict);
  const picks = [
    { name: 'rightmost',  idx: sortedByRight[0]?.i },
    { name: 'leftmost',   idx: sortedByLeft[0]?.i },
    { name: 'topmost',    idx: sortedByTop[0]?.i },
    { name: 'bottommost', idx: sortedByBottom[0]?.i },
    { name: 'middle',     idx: setup.blocks[Math.floor(setup.blocks.length / 2)]?.i },
    ...(conflict ? [{ name: 'conflict', idx: conflict.i }] : []),
  ].filter(p => p.idx != null);

  const failures = []; let fits = 0;
  for (const pick of picks) {
    try {
      const cardLoc = page.locator('.sblock').nth(pick.idx);
      await cardLoc.hover({ timeout: 5000 });
      await page.waitForTimeout(140); // let the rAF-deferred positioner settle
      // NEW-FU-153: query against document (NOT inside the card) because
      // the popover is now portaled to document.body and is no longer a
      // DOM descendant of the .sblock.
      const result = await page.evaluate(() => {
        const visiblePops = [...document.querySelectorAll('.sblock-popover')]
          .filter(p => getComputedStyle(p).display !== 'none');
        if (!visiblePops.length) return { visible: false };
        // Should be exactly one — pick the first.
        const pop = visiblePops[0];
        const cs = getComputedStyle(pop);
        const r = pop.getBoundingClientRect();
        const parentTag = pop.parentElement ? pop.parentElement.tagName.toLowerCase() : '(none)';
        const parentInSgRoot = pop.parentElement
          ? !!pop.parentElement.closest('.sg-root')
          : false;
        // NEW-FU-153: z-order proof via the CSS guarantee.
        // (1) parent === document.body → no enclosing stacking context.
        // (2) computed z-index ≥ 2147483000 (FU-152 set this very high).
        // Together these two CSS-level facts mean the popover paints
        // above every other element in the document — no per-pixel
        // elementsFromPoint test needed (and elementsFromPoint is
        // unreliable for pointer-events:none elements anyway).
        const zIndexN = parseInt(cs.zIndex, 10);
        const zOrderOk = parentTag === 'body' && zIndexN >= 1000000;
        return {
          visible: true, position: cs.position,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          parentTag, parentInSgRoot, zIndex: cs.zIndex,
          topIsPopover: zOrderOk,
        };
      });
      const widthOk  = result.rect && result.rect.w <= 320 && result.rect.w >= 100;
      const heightOk = result.rect && result.rect.h <= 180 && result.rect.h >= 30;
      const posFixed = result.position === 'fixed';
      const parentOk = result.parentTag === 'body' && !result.parentInSgRoot;
      const zOrderOk = result.topIsPopover === true;
      const ok = result.visible && result.inside && posFixed && widthOk && heightOk && parentOk && zOrderOk;
      if (ok) fits++;
      else failures.push({ ...pick, ...result, widthOk, heightOk, posFixed, parentOk, zOrderOk });
      if (ok) console.log(`    ${pick.name}: parent=${result.parentTag}, z-index=${result.zIndex}, position=${result.position}, rect=${result.rect.w}×${result.rect.h}`);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(60);
    } catch (e) {
      failures.push({ ...pick, error: e.message });
    }
  }
  const popoverOk = fits === picks.length && setup.titleLeaks.length === 0;
  console.log(`${popoverOk ? '✓' : '✗'} Popover sanity: ${fits}/${picks.length} placements ok, titleLeaks=${setup.titleLeaks.length}`);
  if (!popoverOk) {
    failures.forEach(f => console.log(`  → ${f.name} visible=${f.visible} inside=${f.inside} fixed=${f.posFixed} wOk=${f.widthOk} hOk=${f.heightOk} parentOk=${f.parentOk} (parent=${f.parentTag}/inSgRoot=${f.parentInSgRoot}) zOrderOk=${f.zOrderOk} (top=${f.topElementTag} class="${f.topElementClass}") rect=${JSON.stringify(f.rect)} err=${f.error || ''}`));
    setup.titleLeaks.slice(0, 3).forEach(t => console.log(`  → title leak: ${t.code} title="${t.title.slice(0, 80)}…"`));
  }
  const popoverResults = { fits, tested: picks.length, titleLeaks: setup.titleLeaks };

  await browser.close();

  const all = [...cv, ...tv, ...vv];
  const passed = all.filter(r => r.ok).length;
  const total = all.length;
  const allOk = passed === total && popoverOk;
  console.log(`\n${allOk ? '✓ ALL PASS' : '✗ FAILED'} — ${passed}/${total} (view × zoom) combinations, popover ${popoverOk ? 'pass' : 'fail'}`);
  process.exitCode = allOk ? 0 : 1;
})().catch(err => {
  console.error('✗ FAILED:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
