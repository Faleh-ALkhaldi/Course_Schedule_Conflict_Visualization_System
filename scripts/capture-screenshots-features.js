// scripts/capture-screenshots-features.js
//
// Captures the 31 (32 files, F-30 has two) screenshots required by the
// CSCVS Features Showcase document. Saves into cscvs-screenshots/ at
// 1440 x 900 with deviceScaleFactor 2.
//
// Requirements: backend on :4000, frontend on :3000, DB seeded.

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const API_URL = process.env.API_URL || 'http://localhost:4000/api/v1';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const OUT_DIR = path.join(process.cwd(), 'cscvs-screenshots');
const VIEWPORT = { width: 1440, height: 900 };
const SCHEDULER = { username: 'scheduler1', password: 'password123' };
const ADMIN     = { username: 'admin1',     password: 'password123' };

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── REST helpers ────────────────────────────────────────────────────────────
async function api(method, urlPath, token, body, raw = false) {
  const res = await fetch(`${API_URL}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${urlPath} → ${res.status} ${text}`);
  }
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

async function loginApi(creds) {
  const r = await api('POST', '/auth/login', null, creds);
  return r.token;
}

async function listSections(token, sid) {
  const r = await api('GET', `/schedules/${sid}/sections`, token);
  return r.sections || r;
}

async function deleteTestSections(token, sid) {
  const all = await listSections(token, sid);
  const probes = ['X1', 'X2', 'X3', 'X4', 'NEW-A', 'NEW-B'];
  const ids = [...new Set(all
    .filter(s => probes.includes(s.sectionNumber ?? s.section_number))
    .map(s => s.id))];
  for (const id of ids) await api('DELETE', `/sections/${id}`, token).catch(() => {});
  if (ids.length) console.log(`  Cleaned ${ids.length} leftover probe sections`);
}

// ── Page helpers ────────────────────────────────────────────────────────────
async function settle(page, ms = 500) {
  await page.waitForTimeout(ms);
}

async function loginUi(page, creds) {
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]', { timeout: 8000 });
  await page.fill('input[name="username"], input[type="text"]', creds.username);
  await page.fill('input[type="password"]', creds.password);
  await page.click('button.login-btn, button[type="submit"]');
  await page.waitForSelector('.sg-root', { timeout: 15000 });
  await settle(page, 1000);
}

async function clickTopbarTab(page, label) {
  await page.locator(`button.topbar-tab:has-text("${label}")`).first().click();
  await settle(page, 600);
}

async function closeModal(page) {
  // Try the standard SectionModal × first
  const closers = [
    '.sm-close',
    'button.sm-btn-cancel',
    'button.modal-btn.cancel',
    'button:has-text("Close")',
    'button:has-text("Cancel")',
  ];
  for (const sel of closers) {
    const loc = page.locator(sel).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) {
      await loc.click({ force: true }).catch(() => {});
      break;
    }
  }
  // Wait for either overlay to disappear
  await page.waitForFunction(() => {
    return !document.querySelector('.sm-overlay') && !document.querySelector('.modal-overlay');
  }, { timeout: 3000 }).catch(() => {});
  await settle(page, 300);
}

// Drag a section block (via Playwright Locator) to a (day, startMinutes) drop
// zone. dnd-kit needs sustained pointer events with multiple intermediate
// moves to clear the 6 px activation distance.
async function dragLocatorToSlot(page, sourceLoc, day, startMinutes) {
  await sourceLoc.scrollIntoViewIfNeeded();
  const src = await sourceLoc.boundingBox();
  if (!src) throw new Error('drag source not visible');

  // dnd-kit doesn't expose the droppable id as a DOM attribute, so we compute
  // the target geometry from the day-column + time axis instead.
  const tgt = await computeSlotBox(page, day, startMinutes);
  if (!tgt) throw new Error(`could not compute target box for ${day}|${startMinutes}`);

  const fromX = src.x + src.width / 2;
  const fromY = src.y + src.height / 2;
  const toX   = tgt.x + tgt.width / 2;
  const toY   = tgt.y + tgt.height / 2;

  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  // Several intermediate steps so dnd-kit registers the drag past 6 px threshold.
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(
      fromX + (toX - fromX) * t,
      fromY + (toY - fromY) * t,
      { steps: 1 },
    );
    await page.waitForTimeout(15);
  }
  await page.waitForTimeout(150);
  await page.mouse.up();
  await settle(page, 800);
}

// Compute pixel-box of a (day, minutes-since-midnight) drop slot on the grid.
async function computeSlotBox(page, day, startMinutes) {
  return await page.evaluate(({ day, startMinutes }) => {
    const headers = document.querySelectorAll('.sg-day-header');
    let dayCol = null, dayIdx = -1;
    headers.forEach((h, i) => { if (h.textContent.trim() === day) dayIdx = i; });
    if (dayIdx < 0) return null;
    const cols = document.querySelectorAll('.sg-day-col');
    dayCol = cols[dayIdx];
    if (!dayCol) return null;
    const colRect = dayCol.getBoundingClientRect();
    // Grid starts at 07:00 (= 420 min) at top.
    const DISPLAY_START = 7 * 60;
    const root = document.querySelector('.sg-root');
    const rowH = parseInt(getComputedStyle(root).getPropertyValue('--row-height')) || 32;
    const pxPerMin = rowH / 30;
    const topInCol = (startMinutes - DISPLAY_START) * pxPerMin;
    return {
      x: colRect.left + 4,
      y: colRect.top + topInCol + 4,
      width: colRect.width - 8,
      height: pxPerMin * 30 - 8,
    };
  }, { day, startMinutes });
}

// Locate an sblock by visible course code + section number.
function sblockByLabel(page, code, sectionNum) {
  return page.locator(`.sblock`).filter({
    hasText: code,
  }).filter({ hasText: `§${sectionNum}` }).first();
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  → ${name}`);
}

async function shotRegion(page, selector, name) {
  const file = path.join(OUT_DIR, name);
  const loc = page.locator(selector).first();
  await loc.screenshot({ path: file });
  console.log(`  → ${name} (region: ${selector})`);
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('▶ Logging in via API (admin) to set up data...');
  const adminToken = await loginApi(ADMIN);
  const schedules  = await api('GET', '/departments/SWE-DEPT/schedules', adminToken);
  const schedule   = schedules.find(s => s.semester === 'Fall-2025') || schedules[0];
  if (!schedule) throw new Error('No Fall-2025 schedule. Run npm run seed.');
  const SID = schedule.id;

  await deleteTestSections(adminToken, SID);

  // Pre-fetch reference data to drive scripted state.
  const courses     = await api('GET', '/courses', adminToken);
  const instructors = await api('GET', '/instructors', adminToken);
  const venues      = await api('GET', '/venues', adminToken);

  const ugJ = courses.filter(c => (c.academic_level === 'Junior') && c.category === 'UG');
  const ugSr = courses.filter(c => (c.academic_level === 'Senior') && c.category === 'UG');
  if (ugJ.length < 2) throw new Error('Need 2 Junior UG courses in seed.');

  // Save a sample.xlsx for the F-27 import step — round-trip the export API.
  console.log('▶ Saving sample-import.xlsx for F-27...');
  const xlsxRes = await api(
    'GET', `/schedules/${SID}/export?view=full`, adminToken, null, true,
  );
  const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
  const xlsxPath = path.join(OUT_DIR, 'sample-import.xlsx');
  fs.writeFileSync(xlsxPath, xlsxBuf);
  console.log(`  sample-import.xlsx: ${xlsxBuf.length} bytes`);

  console.log('▶ Launching Chromium...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  // Accept the window.confirm() popup that DraggableCourse uses.
  ctx.on('page', p => {
    p.on('dialog', d => d.accept().catch(() => {}));
  });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 1 — Login page (fresh, NOT logged in)
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n▶ F-01: login screen');
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]', { timeout: 8000 });
  await settle(page, 500);
  await shot(page, 'screenshot-F-01-login.png');

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 2 — Scheduler session
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n▶ Logging in via UI as scheduler1...');
  await page.fill('input[name="username"], input[type="text"]', SCHEDULER.username);
  await page.fill('input[type="password"]', SCHEDULER.password);
  await page.click('button.login-btn, button[type="submit"]');
  await page.waitForSelector('.sg-root', { timeout: 15000 });
  await settle(page, 1500);

  // F-02 Course View
  console.log('▶ F-02: Course View');
  await clickTopbarTab(page, 'Course View');
  await page.waitForSelector('.sblock', { timeout: 8000 });
  await shot(page, 'screenshot-F-02-course-view.png');

  // F-03 Teacher View
  console.log('▶ F-03: Teacher View');
  await clickTopbarTab(page, 'Teacher View');
  await settle(page, 700);
  // Click first instructor in sidebar
  const firstInstructor = page.locator('.sp-filter-item').first();
  await firstInstructor.click();
  await settle(page, 1200);
  await shot(page, 'screenshot-F-03-teacher-view.png');

  // F-04 Venue View
  console.log('▶ F-04: Venue View');
  await clickTopbarTab(page, 'Venue View');
  await settle(page, 700);
  // Click first lecture hall in sidebar
  const firstHall = page.locator('.sp-venue-li:has(.sp-venue-tag.hall) .sp-filter-item').first();
  await firstHall.click();
  await settle(page, 1200);
  await shot(page, 'screenshot-F-04-venue-view.png');

  // Return to Course View
  await clickTopbarTab(page, 'Course View');
  await page.waitForSelector('.sblock');
  await settle(page, 800);

  // ─────────────────────────────────────────────────────────────────────
  // F-05 Section block visual language — create normal + hard + soft state
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-05: section block visual language');
  // Create the conflict trio (mirrors capture-screenshots.js):
  //   X1, X2 — same instructor, overlapping time   → hard
  //   X3     — no instructor, R-09                  → soft
  const inst = instructors[0];
  await api('POST', `/schedules/${SID}/sections`, adminToken, {
    courseId: ugJ[0].id, instructorId: inst.id, venueId: null,
    sectionNumber: 'X1', days: ['Sunday','Tuesday','Thursday'],
    startTime: '11:00', endTime: '11:50',
  });
  await api('POST', `/schedules/${SID}/sections`, adminToken, {
    courseId: ugJ[1].id, instructorId: inst.id, venueId: null,
    sectionNumber: 'X2', days: ['Sunday','Tuesday','Thursday'],
    startTime: '11:00', endTime: '11:50',
  });
  await api('POST', `/schedules/${SID}/sections`, adminToken, {
    courseId: ugJ[0].id, instructorId: null, venueId: null,
    sectionNumber: 'X3', days: ['Monday','Wednesday'],
    startTime: '15:00', endTime: '15:50',
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sblock');
  await settle(page, 1500);
  // Capture a region around the conflict area on Sunday/Monday columns
  // (left area of the grid where X1/X2/X3 cluster).
  await page.locator('.sg-day-cols').first().screenshot({
    path: path.join(OUT_DIR, 'screenshot-F-05-section-block-visual.png'),
    clip: undefined,
  });
  console.log('  → screenshot-F-05-section-block-visual.png');

  // ─────────────────────────────────────────────────────────────────────
  // F-06 Add Section modal
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-06: Add Section modal (filled)');
  // Click "+" next to "Sections" heading in the SidePanel
  const addBtn = page.locator('.sp-heading-row:has-text("Sections") .sp-add-btn').first();
  await addBtn.click();
  await page.waitForSelector('.sm-card', { timeout: 5000 });
  await settle(page, 500);
  // Pick a course (any) — use value (= course UUID) since selectOption.label
  // expects a string, not a regex.
  const courseSel = page.locator('.sm-field:has-text("Course") select').first();
  await courseSel.selectOption(courses[0].id);
  await page.locator('.sm-field:has-text("Section #") input').fill('NEW-A');
  // STT is default; set start time 10:00
  await page.locator('input[type="time"]').first().fill('10:00');
  // Pick instructor + venue
  const inSel = page.locator('.sm-field:has-text("Instructor") select');
  if (await inSel.count() && instructors.length) {
    await inSel.selectOption({ index: 1 });
  }
  const vSel = page.locator('.sm-field:has-text("Venue") select');
  if (await vSel.count() && venues.length) {
    await vSel.selectOption({ index: 1 });
  }
  await settle(page, 400);
  await shot(page, 'screenshot-F-06-add-section.png');
  // Close without saving (we don't need NEW-A on the grid)
  await closeModal(page);

  // ─────────────────────────────────────────────────────────────────────
  // F-07 Edit Section modal (Time & Day tab)
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-07: Edit Section modal');
  // Click any existing section — use a baseline (non-test) section like SWE301
  const editTarget = page.locator('.sblock').filter({ hasNotText: /§X[123]/ }).first();
  await editTarget.click();
  await page.waitForSelector('.sm-card', { timeout: 5000 });
  await settle(page, 500);
  // It opens on Time & Day tab by default (mode==='edit')
  await shot(page, 'screenshot-F-07-edit-section.png');
  await closeModal(page);

  // ─────────────────────────────────────────────────────────────────────
  // F-08 Drag-and-drop within same day pattern (after state)
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-08: drag within same pattern');
  // Pick an STT section, drag from its current Sunday slot to Sunday 14:00
  // (within same pattern → no GroupChangeModal).
  const stt = page.locator('.sblock').filter({ hasNotText: /§X[123]/ }).first();
  const sttBefore = await stt.boundingBox();
  await dragLocatorToSlot(page, stt, 'Sunday', 14 * 60);
  await settle(page, 1500);
  await shot(page, 'screenshot-F-08-drag-after.png');

  // ─────────────────────────────────────────────────────────────────────
  // F-09 Group Change modal — drag STT section to Monday
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-09: GroupChange modal');
  // Pick any non-test STT section (baseline seeded sections are STT pattern).
  const stt2 = page.locator('.sblock').filter({ hasNotText: /§X[123]/ }).first();
  await dragLocatorToSlot(page, stt2, 'Monday', 9 * 60);
  // Wait for the GroupChangeModal (uses .sm-overlay with amber border)
  const modalAppeared = await page.waitForSelector('.sm-card:has-text("Change Day Group")', { timeout: 4000 }).catch(() => null);
  if (modalAppeared) {
    await settle(page, 400);
    await shot(page, 'screenshot-F-09-group-change.png');
    // Cancel — keep original
    await page.locator('button.sm-btn-cancel').first().click();
    await settle(page, 500);
  } else {
    console.warn('  ⚠ F-09 modal did not appear — capturing current state as fallback');
    await shot(page, 'screenshot-F-09-group-change.png');
  }

  // ─────────────────────────────────────────────────────────────────────
  // F-10 Real-time conflict detection
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-10: real-time conflict (using X1/X2 hard)');
  // The X1/X2/X3 setup is already on the grid; reload to ensure baseline state.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sblock');
  await settle(page, 1500);
  await shot(page, 'screenshot-F-10-real-time-conflict.png');

  // ─────────────────────────────────────────────────────────────────────
  // F-11 Hard conflict + red Save button
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-11: hard conflict visualization');
  await shot(page, 'screenshot-F-11-hard-conflict.png');

  // ─────────────────────────────────────────────────────────────────────
  // F-12 Soft conflict only — delete X1/X2 to clear the hard
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-12: soft conflict only');
  const all = await listSections(adminToken, SID);
  const x1x2Ids = all.filter(s => ['X1','X2'].includes(s.sectionNumber ?? s.section_number)).map(s => s.id);
  for (const id of x1x2Ids) await api('DELETE', `/sections/${id}`, adminToken).catch(() => {});
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sblock');
  await settle(page, 1500);
  await shot(page, 'screenshot-F-12-soft-conflict.png');

  // ─────────────────────────────────────────────────────────────────────
  // F-13 Conflict list (SidePanel) — re-create one hard to have 2+ entries
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-13: conflict list in SidePanel');
  await api('POST', `/schedules/${SID}/sections`, adminToken, {
    courseId: ugJ[0].id, instructorId: inst.id, venueId: null,
    sectionNumber: 'X1', days: ['Sunday','Tuesday','Thursday'],
    startTime: '11:00', endTime: '11:50',
  });
  await api('POST', `/schedules/${SID}/sections`, adminToken, {
    courseId: ugJ[1].id, instructorId: inst.id, venueId: null,
    sectionNumber: 'X2', days: ['Sunday','Tuesday','Thursday'],
    startTime: '11:00', endTime: '11:50',
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sp-conflict-item', { timeout: 8000 });
  await settle(page, 1000);
  // Click first conflict to expand
  await page.locator('.sp-conflict-item').first().click();
  await settle(page, 500);
  await shotRegion(page, '.sp-root', 'screenshot-F-13-conflict-list.png');

  // ─────────────────────────────────────────────────────────────────────
  // F-14 Resolve conflict — delete X1/X2/X3 to get clean state
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-14: resolve conflict (clean state)');
  const all2 = await listSections(adminToken, SID);
  const probeIds = all2.filter(s => ['X1','X2','X3'].includes(s.sectionNumber ?? s.section_number)).map(s => s.id);
  for (const id of probeIds) await api('DELETE', `/sections/${id}`, adminToken).catch(() => {});
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sblock');
  // Wait until conflict list shows the "✓ No conflicts" pill
  await page.waitForSelector('.sp-no-conflict', { timeout: 8000 });
  await settle(page, 800);
  await shot(page, 'screenshot-F-14-resolve-conflict.png');

  // ─────────────────────────────────────────────────────────────────────
  // F-15 Save clean — green button + success toast
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-15: save clean → toast');
  const saveBtn = page.locator('button.topbar-btn.success').first();
  await saveBtn.click();
  // Toast appears at the bottom; capture before auto-dismiss (~3.5s)
  await page.waitForSelector('.toast', { timeout: 4000 });
  await settle(page, 400);
  await shot(page, 'screenshot-F-15-save-clean.png');
  // Wait for toast dismissal so it doesn't intrude on next shots
  await page.waitForSelector('.toast', { state: 'detached', timeout: 5000 }).catch(() => {});

  // ─────────────────────────────────────────────────────────────────────
  // F-16 Save with soft modal — recreate only X3 (no instructor → soft)
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-16: save with soft-conflict modal');
  await api('POST', `/schedules/${SID}/sections`, adminToken, {
    courseId: ugJ[0].id, instructorId: null, venueId: null,
    sectionNumber: 'X3', days: ['Monday','Wednesday'],
    startTime: '15:00', endTime: '15:50',
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sblock');
  await settle(page, 1500);
  // Click amber save
  const softSave = page.locator('button.topbar-btn.warn').first();
  if (await softSave.count() && !(await softSave.isDisabled())) {
    await softSave.click();
    await page.waitForSelector('.modal-card', { timeout: 4000 });
    await settle(page, 500);
    await shot(page, 'screenshot-F-16-save-soft.png');
    // Cancel
    await page.locator('button.modal-btn.cancel').first().click();
    await settle(page, 500);
  } else {
    console.warn('  ⚠ F-16 amber save button not available');
    await shot(page, 'screenshot-F-16-save-soft.png');
  }

  // ─────────────────────────────────────────────────────────────────────
  // F-17 Save blocked by hard — re-create X1/X2
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-17: save blocked by hard conflict');
  await api('POST', `/schedules/${SID}/sections`, adminToken, {
    courseId: ugJ[0].id, instructorId: inst.id, venueId: null,
    sectionNumber: 'X1', days: ['Sunday','Tuesday','Thursday'],
    startTime: '11:00', endTime: '11:50',
  });
  await api('POST', `/schedules/${SID}/sections`, adminToken, {
    courseId: ugJ[1].id, instructorId: inst.id, venueId: null,
    sectionNumber: 'X2', days: ['Sunday','Tuesday','Thursday'],
    startTime: '11:00', endTime: '11:50',
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sblock');
  await settle(page, 1500);
  // Try clicking red Save — should be disabled and do nothing
  const redSave = page.locator('button.topbar-btn.danger').first();
  if (await redSave.count()) {
    await redSave.click({ force: true }).catch(() => {});  // ignore disabled error
  }
  await settle(page, 500);
  await shot(page, 'screenshot-F-17-save-blocked.png');

  // ─────────────────────────────────────────────────────────────────────
  // Resolve all probes before F-18 so suggest has a clean canvas
  // ─────────────────────────────────────────────────────────────────────
  const all3 = await listSections(adminToken, SID);
  const probeIds3 = all3.filter(s => ['X1','X2','X3'].includes(s.sectionNumber ?? s.section_number)).map(s => s.id);
  for (const id of probeIds3) await api('DELETE', `/sections/${id}`, adminToken).catch(() => {});
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sblock');
  await settle(page, 1200);

  // ─────────────────────────────────────────────────────────────────────
  // F-18 Suggest config modal
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-18: suggest config');
  await page.locator('button.topbar-btn.suggest').first().click();
  await page.waitForSelector('.suggest-card', { timeout: 5000 });
  await settle(page, 500);
  // Set first 2 number inputs to 2; toggle first MW radio
  const numInputs = page.locator('input.suggest-num-input');
  const n = await numInputs.count();
  if (n >= 2) {
    await numInputs.nth(0).fill('2');
    await numInputs.nth(1).fill('2');
  }
  // Click first MW radio to toggle
  const mwRadios = page.locator('label.suggest-pattern-btn:has-text("Mon / Wed")');
  if (await mwRadios.count()) await mwRadios.first().click();
  await settle(page, 400);
  await shot(page, 'screenshot-F-18-suggest-config.png');

  // ─────────────────────────────────────────────────────────────────────
  // F-19 Suggest result — click Run Suggest
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-19: suggest result');
  await page.locator('button.sm-btn-save:has-text("Run Suggest")').first().click();
  // Modal closes, grid repopulates
  await page.waitForSelector('.suggest-card', { state: 'detached', timeout: 8000 }).catch(() => {});
  // Suggest can take a few seconds
  await page.waitForFunction(
    () => document.querySelectorAll('.sblock').length > 0,
    { timeout: 15000 },
  );
  await settle(page, 2500);
  // Dismiss any lingering toasts before screenshot
  await page.waitForSelector('.toast', { state: 'detached', timeout: 4000 }).catch(() => {});
  await shot(page, 'screenshot-F-19-suggest-result.png');

  // ─────────────────────────────────────────────────────────────────────
  // F-20 Manage Courses — open inline form
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-20: manage courses');
  // Scroll sidepanel to courses (which is at bottom)
  await page.locator('.sp-section:has(.sp-heading:has-text("Courses"))')
    .first().scrollIntoViewIfNeeded();
  await settle(page, 300);
  await page.locator('.sp-heading-row:has-text("Courses") .sp-add-btn').first().click();
  await settle(page, 500);
  await shot(page, 'screenshot-F-20-manage-courses.png');
  // Close form (Cancel)
  const cancel20 = page.locator('.sp-form button:has-text("Cancel")').first();
  if (await cancel20.count()) await cancel20.click();
  await settle(page, 400);

  // ─────────────────────────────────────────────────────────────────────
  // F-21 Manage Instructors — switch to Teacher View
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-21: manage instructors');
  await clickTopbarTab(page, 'Teacher View');
  await settle(page, 700);
  await page.locator('.sp-heading-row:has-text("Instructors") .sp-add-btn').first().click();
  await settle(page, 500);
  await shotRegion(page, '.sp-root', 'screenshot-F-21-manage-instructors.png');
  const cancel21 = page.locator('.sp-form button:has-text("Cancel")').first();
  if (await cancel21.count()) await cancel21.click();
  await settle(page, 400);

  // ─────────────────────────────────────────────────────────────────────
  // F-22 Manage Venues — switch to Venue View
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-22: manage venues');
  await clickTopbarTab(page, 'Venue View');
  await settle(page, 700);
  await page.locator('.sp-heading-row:has-text("Venues") .sp-add-btn').first().click();
  await settle(page, 500);
  await shotRegion(page, '.sp-root', 'screenshot-F-22-manage-venues.png');
  const cancel22 = page.locator('.sp-form button:has-text("Cancel")').first();
  if (await cancel22.count()) await cancel22.click();
  await settle(page, 400);

  // ─────────────────────────────────────────────────────────────────────
  // F-23 Manage Office Hours — Teacher view, click an OH block
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-23: office hours modal');
  await clickTopbarTab(page, 'Teacher View');
  await settle(page, 600);
  // Click an instructor that has office hours seeded
  const instructorsList = page.locator('.sp-filter-item');
  const ic = await instructorsList.count();
  let openedOh = false;
  for (let i = 0; i < ic; i++) {
    await instructorsList.nth(i).click();
    await settle(page, 800);
    // Look for an OH block on the grid
    const ohOnGrid = page.locator('.oh-block, .ohblock, [class*="OfficeHour"]').first();
    if (await ohOnGrid.count()) {
      await ohOnGrid.click({ force: true }).catch(() => {});
      const opened = await page.waitForSelector('.sm-card:has-text("Office Hours")', { timeout: 2500 }).catch(() => null);
      if (opened) { openedOh = true; break; }
    }
  }
  if (!openedOh) {
    // Fallback — open the OH edit modal via the SidePanel: click first existing OH item's day text
    // Actually OH list in SidePanel just shows delete; opening modal needs a click on the grid OH.
    // Last-ditch: open the add-OH form to capture *something* OH-related.
    console.warn('  ⚠ No OH block clickable on grid — capturing add-OH form as fallback');
    const ohAddBtn = page.locator('.sp-heading-row:has-text("Office Hours") .sp-add-btn').first();
    if (await ohAddBtn.count()) {
      await ohAddBtn.click();
      await settle(page, 400);
    }
  }
  await settle(page, 400);
  await shot(page, 'screenshot-F-23-office-hours.png');
  await closeModal(page);

  // Return to Course View for export captures
  await clickTopbarTab(page, 'Course View');
  await settle(page, 700);

  // ─────────────────────────────────────────────────────────────────────
  // F-24/25/26 Export modal — three options
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-24: export full semester');
  await page.locator('button.topbar-btn.export').first().click();
  await page.waitForSelector('.sm-card:has-text("Schedule Data")', { timeout: 5000 });
  await settle(page, 400);
  // Ensure Export tab + full radio selected
  await page.locator('button.sm-tab:has-text("Export"), button:has-text("↓ Export")').first()
    .click().catch(() => {});
  await page.locator('input[type="radio"][value="full"]').check();
  await settle(page, 300);
  await shot(page, 'screenshot-F-24-export-full-semester.png');

  console.log('▶ F-25: export teacher');
  await page.locator('input[type="radio"][value="teacher"]').check();
  await settle(page, 300);
  // Pick first instructor in the dropdown that appears
  const teacherSel = page.locator('.exp-option:has-text("Teacher View") + select, select').filter({
    has: page.locator('option:has-text("—")'),
  }).first();
  // Simpler: just pick the first non-empty option in the visible select after the teacher radio
  const teacherDropdown = page.locator('label.exp-option:has-text("Teacher")  + select');
  if (await teacherDropdown.count()) {
    const opts = await teacherDropdown.locator('option').allTextContents();
    const realOpts = opts.filter(t => !t.includes('—')).slice(0, 1);
    if (realOpts.length) await teacherDropdown.selectOption({ label: realOpts[0] });
  } else {
    // Fallback to nth(1) on any select inside the modal (radio + teacher select)
    const sels = page.locator('.sm-form select');
    if (await sels.count()) {
      const targetSel = sels.first();
      const opts = await targetSel.locator('option').count();
      if (opts > 1) await targetSel.selectOption({ index: 1 });
    }
  }
  await settle(page, 400);
  await shot(page, 'screenshot-F-25-export-teacher.png');

  console.log('▶ F-26: export venue');
  await page.locator('input[type="radio"][value="venue"]').check();
  await settle(page, 300);
  const venueDropdown = page.locator('label.exp-option:has-text("Venue") + select');
  if (await venueDropdown.count()) {
    const opts = await venueDropdown.locator('option').allTextContents();
    const realOpts = opts.filter(t => !t.includes('—')).slice(0, 1);
    if (realOpts.length) await venueDropdown.selectOption({ label: realOpts[0] });
  } else {
    const sels = page.locator('.sm-form select');
    if (await sels.count()) {
      const targetSel = sels.first();
      const opts = await targetSel.locator('option').count();
      if (opts > 1) await targetSel.selectOption({ index: 1 });
    }
  }
  await settle(page, 400);
  await shot(page, 'screenshot-F-26-export-venue.png');
  await closeModal(page);

  // ─────────────────────────────────────────────────────────────────────
  // F-28 SidePanel collapse
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-28: side-panel collapsed');
  await page.locator('.sp-collapse-btn').first().click();
  await settle(page, 700);
  await shot(page, 'screenshot-F-28-sidepanel-collapsed.png');
  // Expand again
  await page.locator('.sp-collapse-btn').first().click();
  await settle(page, 700);

  // ─────────────────────────────────────────────────────────────────────
  // F-29 Schedule grid zoom max
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-29: grid zoom max');
  const zoomIn = page.locator('.sg-zoom-btn').filter({ hasText: /\+|＋/ }).first();
  for (let i = 0; i < 12; i++) {
    if (await zoomIn.isDisabled().catch(() => false)) break;
    await zoomIn.click().catch(() => {});
    await page.waitForTimeout(120);
  }
  await settle(page, 600);
  await shot(page, 'screenshot-F-29-grid-zoom-max.png');
  // Reset by reload
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sblock');
  await settle(page, 1000);

  // ─────────────────────────────────────────────────────────────────────
  // F-31 Semester badge — crop topbar-brand
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-31: semester badge');
  await shotRegion(page, '.topbar-brand', 'screenshot-F-31-semester-badge.png');

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 3 — Admin session
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n▶ Logout, log in as admin1...');
  await page.locator('.topbar-logout').first().click();
  await page.waitForSelector('input[type="password"]', { timeout: 8000 });
  await settle(page, 500);
  await loginUi(page, ADMIN);

  // ─────────────────────────────────────────────────────────────────────
  // F-27 Excel Import (admin only)
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-27: import (admin)');
  await page.locator('button.topbar-btn.export').first().click();
  await page.waitForSelector('.sm-card:has-text("Schedule Data")', { timeout: 5000 });
  await page.locator('button.sm-tab:has-text("Import"), button:has-text("↑ Import")').first().click();
  await settle(page, 500);
  // Upload sample-import.xlsx
  await page.setInputFiles('input[type="file"]', xlsxPath);
  // Wait for result summary
  await page.waitForSelector('.sm-form >> text=/section.*imported/', { timeout: 12000 }).catch(() => {});
  await settle(page, 800);
  await shot(page, 'screenshot-F-27-import.png');
  await closeModal(page);

  // ─────────────────────────────────────────────────────────────────────
  // F-30 (admin delete success)
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-30 (admin): course delete success');
  // Wait for courses list, capture count
  await page.waitForSelector('.sp-course-card');
  const beforeCount = await page.locator('.sp-course-card').count();
  // Click delete on the first course card; window.confirm() is auto-accepted
  // by the dialog handler above.
  await page.locator('.sp-course-card .sp-del-btn').first().click();
  // Wait for the count to drop
  await page.waitForFunction(
    (n) => document.querySelectorAll('.sp-course-card').length < n,
    beforeCount,
    { timeout: 8000 },
  ).catch(() => {});
  await settle(page, 800);
  await shot(page, 'screenshot-F-30-admin-delete-success.png');

  // ─────────────────────────────────────────────────────────────────────
  // F-30 (scheduler blocked) — log out, log in as scheduler, retry delete
  // ─────────────────────────────────────────────────────────────────────
  console.log('▶ F-30 (scheduler): course delete blocked');
  await page.locator('.topbar-logout').first().click();
  await page.waitForSelector('input[type="password"]', { timeout: 8000 });
  await loginUi(page, SCHEDULER);
  await page.waitForSelector('.sp-course-card', { timeout: 8000 });
  const beforeCount2 = await page.locator('.sp-course-card').count();
  await page.locator('.sp-course-card .sp-del-btn').first().click();
  // The 403 produces no toast (silent in current code). Wait briefly to let
  // any reaction surface, then capture.
  await page.waitForTimeout(2500);
  await shot(page, 'screenshot-F-30-scheduler-blocked.png');
  const afterCount2 = await page.locator('.sp-course-card').count();
  if (afterCount2 < beforeCount2) {
    console.warn('  ⚠ Scheduler appears to have deleted a course — RBAC may not be enforced as expected.');
  } else {
    console.log('  ✓ Course count unchanged — delete was blocked at the API.');
  }

  // ════════════════════════════════════════════════════════════════════════
  // Wrap-up
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n▶ Cleanup: removing residual probe sections from API...');
  const finalAll = await listSections(adminToken, SID);
  const finalProbes = finalAll
    .filter(s => ['X1','X2','X3','X4','NEW-A','NEW-B'].includes(s.sectionNumber ?? s.section_number))
    .map(s => s.id);
  for (const id of finalProbes) await api('DELETE', `/sections/${id}`, adminToken).catch(() => {});

  await browser.close();

  // Summary
  const files = fs.readdirSync(OUT_DIR)
    .filter(f => f.startsWith('screenshot-F-'))
    .sort();
  console.log(`\n✓ Capture done. ${files.length} screenshots in ${OUT_DIR}`);
  let totalBytes = 0;
  for (const f of files) {
    const s = fs.statSync(path.join(OUT_DIR, f));
    totalBytes += s.size;
    console.log(`   ${(s.size/1024).toFixed(1).padStart(7)} KB  ${f}`);
  }
  console.log(`   ${'-'.padStart(7,'-')}`);
  console.log(`   ${(totalBytes/1024).toFixed(1).padStart(7)} KB  total`);

  // Cross-check against the expected list
  const expected = [
    'screenshot-F-01-login.png',
    'screenshot-F-02-course-view.png',
    'screenshot-F-03-teacher-view.png',
    'screenshot-F-04-venue-view.png',
    'screenshot-F-05-section-block-visual.png',
    'screenshot-F-06-add-section.png',
    'screenshot-F-07-edit-section.png',
    'screenshot-F-08-drag-after.png',
    'screenshot-F-09-group-change.png',
    'screenshot-F-10-real-time-conflict.png',
    'screenshot-F-11-hard-conflict.png',
    'screenshot-F-12-soft-conflict.png',
    'screenshot-F-13-conflict-list.png',
    'screenshot-F-14-resolve-conflict.png',
    'screenshot-F-15-save-clean.png',
    'screenshot-F-16-save-soft.png',
    'screenshot-F-17-save-blocked.png',
    'screenshot-F-18-suggest-config.png',
    'screenshot-F-19-suggest-result.png',
    'screenshot-F-20-manage-courses.png',
    'screenshot-F-21-manage-instructors.png',
    'screenshot-F-22-manage-venues.png',
    'screenshot-F-23-office-hours.png',
    'screenshot-F-24-export-full-semester.png',
    'screenshot-F-25-export-teacher.png',
    'screenshot-F-26-export-venue.png',
    'screenshot-F-27-import.png',
    'screenshot-F-28-sidepanel-collapsed.png',
    'screenshot-F-29-grid-zoom-max.png',
    'screenshot-F-30-admin-delete-success.png',
    'screenshot-F-30-scheduler-blocked.png',
    'screenshot-F-31-semester-badge.png',
  ];
  const missing = expected.filter(f => !files.includes(f));
  if (missing.length) {
    console.log('\n✗ MISSING:');
    for (const m of missing) console.log('   -', m);
    process.exitCode = 2;
  }
})().catch(err => {
  console.error('\n✗ FAILED:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
