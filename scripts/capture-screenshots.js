// scripts/capture-screenshots.js
//
// Captures 13 UI screenshots for the User Manual using Playwright.
// Requires backend (port 4000) and frontend (port 3000) to be running.
// Uses the public REST API + the live UI. Cleans up test data on exit.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const API_URL  = process.env.API_URL  || 'http://localhost:4000/api/v1';
const APP_URL  = process.env.APP_URL  || 'http://localhost:3000';
const OUT_DIR  = path.join(process.cwd(), 'screenshots', 'v1.1');
const VIEWPORT = { width: 1440, height: 900 };
const ADMIN    = { username: 'admin1', password: 'password123' };

fs.mkdirSync(OUT_DIR, { recursive: true });

async function api(method, urlPath, token, body) {
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
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

async function listSections(token, scheduleId) {
  const r = await api('GET', `/schedules/${scheduleId}/sections`, token);
  return r.sections || r;
}
async function listSectionIds(token, scheduleId) {
  return (await listSections(token, scheduleId)).map(s => s.id);
}

async function setupConflicts(token) {
  const schedules = await api('GET', '/departments/SWE-DEPT/schedules', token);
  if (!schedules.length) throw new Error('No schedule found for SWE-DEPT. Run npm run seed first.');
  const schedule = schedules.find(s => s.semester === 'Fall-2025') || schedules[0];

  // Purge leftover test sections from previous runs (idempotent).
  const TEST_SECTION_NUMBERS = ['X1', 'X2', 'X3', 'PROBE'];
  const existing = await listSections(token, schedule.id);
  const leftovers = existing.filter(s => TEST_SECTION_NUMBERS.includes(s.sectionNumber ?? s.section_number));
  for (const s of leftovers) {
    await api('DELETE', `/sections/${s.id}`, token).catch(() => {});
  }
  if (leftovers.length) console.log(`  Purged ${leftovers.length} leftover test sections`);

  const instructors = await api('GET', '/instructors', token);
  if (!instructors.length) throw new Error('No instructors. Run npm run seed first.');
  const instructor = instructors[0];

  const courses = await api('GET', '/courses', token);
  // /courses returns snake_case fields; tolerate both shapes just in case.
  const ugJ = courses.filter(c =>
    (c.academic_level === 'Junior' || c.academicLevel === 'Junior') &&
    c.category === 'UG'
  );
  if (ugJ.length < 2) throw new Error('Need at least 2 Junior UG courses in seed.');

  const before = new Set(await listSectionIds(token, schedule.id));

  // Hard conflict via R-04: same instructor, overlapping time
  await api('POST', `/schedules/${schedule.id}/sections`, token, {
    courseId: ugJ[0].id,
    instructorId: instructor.id,
    venueId: null,
    sectionNumber: 'X1',
    days: ['Sunday', 'Tuesday', 'Thursday'],
    startTime: '11:00',
    endTime: '11:50',
  });
  await api('POST', `/schedules/${schedule.id}/sections`, token, {
    courseId: ugJ[1].id,
    instructorId: instructor.id,
    venueId: null,
    sectionNumber: 'X2',
    days: ['Sunday', 'Tuesday', 'Thursday'],
    startTime: '11:00',
    endTime: '11:50',
  });

  // Soft conflict via R-09: no instructor. Chosen time slot avoids any other
  // Junior UG section so it doesn't also trigger an R-01 (same-level overlap)
  // hard conflict — the seeded SWE321A occupies Mon 12:00–13:30.
  await api('POST', `/schedules/${schedule.id}/sections`, token, {
    courseId: ugJ[0].id,
    instructorId: null,
    venueId: null,
    sectionNumber: 'X3',
    days: ['Monday', 'Wednesday'],
    startTime: '15:00',
    endTime: '15:50',
  });

  // Identify new sections by section_number rather than slice order, since the
  // API does not return rows in insertion order.
  const after = await listSections(token, schedule.id);
  const hardIds = after.filter(s => ['X1', 'X2'].includes(s.sectionNumber ?? s.section_number)).map(s => s.id);
  const softIds = after.filter(s => (s.sectionNumber ?? s.section_number) === 'X3').map(s => s.id);
  const newIds  = [...hardIds, ...softIds];
  return { schedule, newIds, hardIds, softIds };
}

async function cleanup(token, ids) {
  for (const id of ids) {
    try { await api('DELETE', `/sections/${id}`, token); } catch { /* ignore */ }
  }
}

async function settle(page, ms = 400) {
  await page.waitForTimeout(ms);
}

async function closeModal(page) {
  // SectionModal closes on (1) × button, (2) overlay-only click, NOT Escape.
  const closeBtn = page.locator('.sm-close, .sm-btn-cancel').first();
  if (await closeBtn.count()) {
    await closeBtn.click({ force: true }).catch(() => {});
  }
  // Wait for overlay to detach.
  try {
    await page.waitForSelector('.sm-overlay', { state: 'detached', timeout: 2500 });
    return;
  } catch { /* fall through */ }
  // Last resort: click the corner of the overlay (outside the card).
  const ov = page.locator('.sm-overlay').first();
  if (await ov.count()) {
    await ov.click({ position: { x: 3, y: 3 }, force: true }).catch(() => {});
  }
  await page.waitForSelector('.sm-overlay', { state: 'detached', timeout: 2000 }).catch(() => {});
}

async function clickByText(page, selectors, text, opts = {}) {
  for (const sel of selectors) {
    const loc = page.locator(`${sel}:has-text("${text}")`);
    if (await loc.count()) {
      await loc.first().click(opts);
      return true;
    }
  }
  return false;
}

(async () => {
  let trackedIds = [];
  let token;
  let browser;

  try {
    console.log('▶ Login via REST...');
    ({ token } = await api('POST', '/auth/login', null, ADMIN));

    console.log('▶ Setting up conflict data...');
    const { newIds, hardIds: setupHardIds, softIds: setupSoftIds } = await setupConflicts(token);
    trackedIds = newIds;
    console.log(`  Created ${newIds.length} test sections (hard=${setupHardIds.length}, soft=${setupSoftIds.length})`);
    // Stash for step 13.
    var hardIds = setupHardIds;
    var softIds = setupSoftIds;

    console.log('▶ Launching headless Chromium...');
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await ctx.newPage();

    // 01 — Login page
    console.log('▶ 01_login.png');
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.login-card, form', { timeout: 8000 });
    await settle(page, 500);
    await page.screenshot({ path: path.join(OUT_DIR, '01_login.png') });

    // Login via UI
    await page.fill('input[type="text"], input[name="username"]', ADMIN.username);
    await page.fill('input[type="password"]', ADMIN.password);
    await page.click('button.login-btn, button[type="submit"]');
    await page.waitForSelector('.sg-root', { timeout: 15000 });
    await settle(page, 1200);

    // 02 — Main grid default
    console.log('▶ 02_main_grid_default.png');
    await page.screenshot({ path: path.join(OUT_DIR, '02_main_grid_default.png') });

    // 03 — Sidebar collapsed
    console.log('▶ 03_sidebar_collapsed.png');
    if (await page.locator('.sp-collapse-btn').count()) {
      await page.locator('.sp-collapse-btn').first().click();
      await settle(page, 600);
      await page.screenshot({ path: path.join(OUT_DIR, '03_sidebar_collapsed.png') });
      await page.locator('.sp-collapse-btn').first().click();
      await settle(page, 600);
    } else {
      console.warn('  ⚠ .sp-collapse-btn not found; capturing main view as fallback');
      await page.screenshot({ path: path.join(OUT_DIR, '03_sidebar_collapsed.png') });
    }

    // 04 — Zoomed in
    console.log('▶ 04_grid_zoomed_in.png');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.sg-zoom-btn'));
      const plus = btns.find(b => /\+/.test(b.textContent));
      if (plus) for (let i = 0; i < 4; i++) plus.click();
    });
    await settle(page, 500);
    await page.screenshot({ path: path.join(OUT_DIR, '04_grid_zoomed_in.png') });

    // 05 — Zoomed out
    console.log('▶ 05_grid_zoomed_out.png');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.sg-zoom-btn'));
      const minus = btns.find(b => /[−-]/.test(b.textContent));
      if (minus) for (let i = 0; i < 7; i++) minus.click();
    });
    await settle(page, 500);
    await page.screenshot({ path: path.join(OUT_DIR, '05_grid_zoomed_out.png') });

    // Reset zoom by reload
    await page.reload();
    await page.waitForSelector('.sg-root');
    await settle(page, 1000);

    // 06 — Hard conflict (red highlights from X1/X2)
    console.log('▶ 06_hard_conflict.png');
    await page.screenshot({ path: path.join(OUT_DIR, '06_hard_conflict.png') });

    // 07 — Soft conflict — switch to a view where X3 is visible
    console.log('▶ 07_soft_conflict.png');
    await page.screenshot({ path: path.join(OUT_DIR, '07_soft_conflict.png') });

    // 08 — Section modal (add). Click the first + add button.
    console.log('▶ 08_section_modal_add.png');
    const addClicked = await clickByText(page, ['button'], '+ Add Section')
                    || (await page.locator('.sp-add-btn').count() && (await page.locator('.sp-add-btn').first().click(), true));
    if (addClicked || (await page.locator('.sp-add-btn').count())) {
      if (!addClicked) await page.locator('.sp-add-btn').first().click();
      await page.waitForSelector('.sm-card', { timeout: 5000 });
      await settle(page, 500);
      await page.screenshot({ path: path.join(OUT_DIR, '08_section_modal_add.png') });
      await closeModal(page);
      await settle(page, 400);
    } else {
      console.warn('  ⚠ Could not open Add Section modal; skipping #08');
    }

    // 09 — Section modal (edit). Click first existing section.
    console.log('▶ 09_section_modal_edit.png');
    if (await page.locator('.sblock').count()) {
      await page.locator('.sblock').first().click();
      await page.waitForSelector('.sm-card', { timeout: 5000 });
      await settle(page, 500);
      // Try Info tab
      const infoTab = page.locator('button:has-text("Info"), .sm-tab:has-text("Info")');
      if (await infoTab.count()) {
        await infoTab.first().click();
        await settle(page, 400);
      }
      await page.screenshot({ path: path.join(OUT_DIR, '09_section_modal_edit.png') });
      await closeModal(page);
      await settle(page, 400);
    }

    // 10 — Suggest modal
    console.log('▶ 10_suggest_modal.png');
    const suggestOpened = await clickByText(page, ['button.topbar-btn', 'button'], 'Suggest');
    if (suggestOpened) {
      await page.waitForSelector('.sm-card, .suggest-card', { timeout: 5000 });
      await settle(page, 500);
      await page.screenshot({ path: path.join(OUT_DIR, '10_suggest_modal.png') });
      await closeModal(page);
      await settle(page, 400);
    }

    // 11 — Export modal (Export tab)
    console.log('▶ 11_export_modal_export_tab.png');
    const exportOpened = await clickByText(page, ['button.topbar-btn', 'button'], 'Export');
    if (exportOpened) {
      await page.waitForSelector('.sm-card', { timeout: 5000 });
      await settle(page, 500);
      await page.screenshot({ path: path.join(OUT_DIR, '11_export_modal_export_tab.png') });

      // 12 — Export modal (Import tab)
      console.log('▶ 12_export_modal_import_tab.png');
      const importSwitched = await clickByText(page, ['button.sm-tab', 'button', '.sm-tab'], 'Import');
      if (importSwitched) {
        await settle(page, 500);
        await page.screenshot({ path: path.join(OUT_DIR, '12_export_modal_import_tab.png') });
      }
      await closeModal(page);
      await settle(page, 400);
    }

    // 13 — Soft conflict confirmation modal
    console.log('▶ 13_soft_conflict_modal.png');
    // Remove every X1 / X2 section (identified by section_number from setup)
    // so the save flow proceeds past the hard-conflict block and shows the
    // soft-conflict modal for the remaining X3 (R-09 "no instructor") section.
    for (const id of hardIds) {
      await api('DELETE', `/sections/${id}`, token).catch(() => {});
    }
    trackedIds = softIds.slice();   // only soft sections remain
    await page.reload();
    await page.waitForSelector('.sg-root');
    await settle(page, 2000);

    // Look for the Save button. With only a soft conflict present, the save
    // class becomes 'warn' (⚠️ Save) per TopBar.jsx. Try a few selectors.
    const saveLocators = [
      'button.topbar-btn.warn',
      'button.topbar-btn.success',
      'button.topbar-btn:has-text("Save")',
    ];
    let saveClicked = false;
    for (const sel of saveLocators) {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        const isDisabled = await loc.isDisabled().catch(() => false);
        if (!isDisabled) {
          await loc.click().catch(() => {});
          saveClicked = true;
          break;
        }
      }
    }
    if (saveClicked) {
      try {
        // SoftConflictModal uses .modal-overlay/.modal-card, not .sm-overlay/.sm-card
        await page.waitForSelector('.modal-card, .sm-card', { timeout: 8000 });
        await settle(page, 600);
        await page.screenshot({ path: path.join(OUT_DIR, '13_soft_conflict_modal.png') });
        // Dismiss with "Go Back" so nothing is actually saved
        const goBack = page.locator('button.modal-btn.cancel, button:has-text("Go Back")').first();
        if (await goBack.count()) await goBack.click().catch(() => {});
      } catch (e) {
        console.warn('  ⚠ Soft conflict modal did not appear within timeout; skipping #13');
      }
    } else {
      const diag = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.topbar-btn')).map(b => ({
          text: b.textContent.trim(), classes: b.className, disabled: b.disabled,
        }));
      });
      console.warn('  ⚠ Save button not clickable for step #13. Topbar state:');
      console.warn('   ' + JSON.stringify(diag));
    }

    console.log('\n✓ Capture complete.');
    const files = fs.readdirSync(OUT_DIR).sort();
    console.log(`  ${files.length} files in ${OUT_DIR}:`);
    files.forEach(f => console.log('   - ' + f));
  } catch (err) {
    console.error('\n✗ FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (token && trackedIds.length) {
      console.log('▶ Cleaning up test sections...');
      await cleanup(token, trackedIds);
    }
    if (browser) await browser.close();
  }
})();
