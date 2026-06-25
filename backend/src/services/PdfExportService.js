/**
 * PdfExportService
 *
 * PDF generation using PDFKit (no headless browser — keeps the deploy
 * footprint inside Render's 512MB free-tier envelope).
 *
 * NEW-FU-657: the public export is the COMBINED document —
 *   buildCombinedPdfBuffer(scheduleId, filter, semester)
 *     page 1+:  visual weekly schedule grid (Half A, scope = filter)
 *     then:     full-semester section table (Half B, every section)
 *     then:     office-hours table (so a re-import is conflict-clean)
 * Half B is always the whole term so the file round-trips into a complete
 * schedule. The table/OH column layouts (TABLE_COLS / OH_COLS / LEFT_MARGIN) are
 * EXPORTED so ImportParserService can reconstruct columns by x-position — text is
 * drawn left-aligned at colLeft+pad and width-fitted (never overflows its cell),
 * so a positional pdfjs parse maps every token back to its column unambiguously.
 *
 * All builders return a Promise<Buffer> the controller streams as application/pdf.
 */
const PDFDocument = require('pdfkit');
const { createCanvas } = require('@napi-rs/canvas');   // NEW-FU-667: server-side raster for the PNG export
const SectionRepository    = require('../repositories/SectionRepository');
const InstructorRepository = require('../repositories/InstructorRepository');
const { ConflictRepository, VenueRepository } = require('../repositories/repositories');
const { sectionLabel } = require('../domain/sectionLabel');
const labels = require('../domain/exportLabels');   // NEW-FU-666: end-user display labels
const { query } = require('../config/db');
// NEW-FU-660: shared scope helpers — scoped OH / instructor / venue reference sets +
// the scope-tagged table title the importer detects.
const scope = require('./exportScope');

const sectionRepo  = new SectionRepository();
const instrRepo    = new InstructorRepository();
const conflictRepo = new ConflictRepository();

// NEW-FU-660: the scoped section set (instructor / venue / whole-term) as Section
// domain objects — Half B's table now covers the same sections as Half A's grid.
async function fetchScopedSections(scheduleId, filter = { type: 'full' }) {
  if (filter && filter.type === 'instructor' && filter.id) return sectionRepo.findByInstructor(scheduleId, filter.id);
  if (filter && filter.type === 'venue'      && filter.id) return sectionRepo.findByVenue(scheduleId, filter.id);
  return sectionRepo.findBySchedule(scheduleId);
}

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday'];

const LEVEL_COLORS = {
  Freshman:  '#DAEEF3', Sophomore: '#E2EFDA', Junior: '#FFF2CC',
  Senior:    '#E8E0F5', Graduate:  '#EADDC1',
};
const SOFT_COLOR   = '#FFE08A';
const HEADER_COLOR = '#1F4E79';
const TIME_BG      = '#E8EEF7';
const BORDER_COL   = '#94A3B8';

// NEW-FU-658: 5-min slots (was 30) so PDF section blocks sit at the EXACT same
// position as the Excel and Word grids — no 30-minute rounding. The grid fills the
// page height, so rows are fine but blocks are placed precisely.
const SLOT_MIN = 5;
const START_H  = 7;
const END_H    = 22;
const TOTAL_SLOTS = ((END_H - START_H) * 60) / SLOT_MIN; // 180

// ── Shared layout (exported; the importer maps x → column from these) ─────────────
const LEFT_MARGIN = 28;
const TABLE_FONT  = 7;
// Section table (Half B). Identity-critical columns (Days, Instructor, Venue,
// Venue Type, times, flags) are sized so their real values never truncate; only
// Course Name (display-only — the course is identified by its code) may clip.
// Widths: identity-critical columns (Days, Instructor, Venue, Venue Type, times,
// flags) are sized so their real values NEVER truncate — instructor is 126pt to fit
// the longest name ("MUHAMMAD FAISAL ABDULRAZZAK" ≈ 114pt at 7pt). Only Course Name
// (display-only; the course is identified by its code) may clip; Excel/Word keep it
// in full. Total ≈ 754pt fits an A4-landscape content width (~786pt).
// NEW-FU-666: full END-USER column headers (no truncated jargon like "Acad. Level"/"Cat."/
// "Cr."/"Sec #"/"Gen."/"Min"). The header row wraps to two lines (renderTableInto) and the
// widths are re-balanced so every full header AND every humanized value fits — widened for the
// long ones ("Undergraduate", "Lecture Hall"), trimmed from the over-generous ones. Total
// ≈780pt still fits A4-landscape (~786pt). The importer reads columns by x-position from THIS
// shared array, so changing labels/widths stays consistent across export and import.
const TABLE_COLS = [
  { key: 'courseCode',    label: 'Course Code',    width: 40 },
  { key: 'courseName',    label: 'Course Name',    width: 72 },
  { key: 'academicLevel', label: 'Academic Level', width: 44 },   // NEW-FU-671: fit "Sophomore" (was 38 → char-wrapped)
  { key: 'category',      label: 'Category',       width: 52 },
  { key: 'credits',       label: 'Credits',        width: 30 },
  { key: 'courseType',    label: 'Course Type',    width: 40 },
  { key: 'sectionNumber', label: 'Section #',      width: 32 },
  { key: 'sectionType',   label: 'Section Type',   width: 42 },
  { key: 'gender',        label: 'Gender',         width: 26 },
  { key: 'days',          label: 'Days',           width: 102 },   // NEW-FU-671: −6 to fund Academic Level (still fits "Sunday, Tuesday, Thursday")
  { key: 'startTime',     label: 'Start Time',     width: 30 },
  { key: 'endTime',       label: 'End Time',       width: 30 },
  { key: 'duration',      label: 'Duration (min)', width: 34 },
  { key: 'instructor',    label: 'Instructor',     width: 116 },
  { key: 'venue',         label: 'Venue',          width: 40 },
  { key: 'venueType',     label: 'Venue Type',     width: 50 },
];
// Office-hours table (reference data). Wide instructor column → no truncation.
const OH_COLS = [
  { key: 'instructor', label: 'Instructor', width: 210 },
  { key: 'day',        label: 'Day',        width: 120 },
  { key: 'startTime',  label: 'Start Time', width: 100 },
  { key: 'endTime',    label: 'End Time',   width: 100 },
];
// NEW-FU-657b: Instructor + Venue reference tables — wide single-line columns so
// email / name / type never truncate (full records round-trip).
const INSTRUCTOR_COLS = [
  { key: 'name',  label: 'Instructor', width: 240 },
  { key: 'email', label: 'Email',      width: 300 },
];
const VENUE_COLS = [
  { key: 'name',     label: 'Venue',      width: 170 },
  { key: 'type',     label: 'Venue Type', width: 150 },
  { key: 'capacity', label: 'Capacity',   width: 110 },
];

function timeToSlot(t) {
  if (!t) return 0;
  const [h, m] = t.substring(0, 5).split(':').map(Number);
  return Math.round(((h - START_H) * 60 + m) / SLOT_MIN);
}
function slotToTime(slot) {
  const tot = START_H * 60 + slot * SLOT_MIN;
  return `${String(Math.floor(tot / 60)).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`;
}

// Greedy lane assignment so overlapping same-day sections sit side-by-side.
function assignLanes(entries) {
  const sorted = [...entries].sort((a, b) => a.startSlot - b.startSlot);
  const laneEnds = [];
  for (const e of sorted) {
    let placed = false;
    for (let i = 0; i < laneEnds.length; i++) {
      if (e.startSlot >= laneEnds[i]) { e.lane = i; laneEnds[i] = e.endSlot; placed = true; break; }
    }
    if (!placed) { e.lane = laneEnds.length; laneEnds.push(e.endSlot); }
  }
  return laneEnds.length || 1;
}

// Truncate a string so it fits maxWidth at the doc's CURRENT font/size — keeps
// every cell inside its column so the positional importer never mis-assigns a token.
function fitText(doc, str, maxWidth) {
  let s = String(str ?? '');
  if (!s || doc.widthOfString(s) <= maxWidth) return s;
  while (s.length > 1 && doc.widthOfString(s) > maxWidth) s = s.slice(0, -1);
  return s;
}

function pdfToBuffer(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { buildFn(doc); doc.end(); }
    catch (err) { reject(err); }
  });
}

// ── TABLE (Half B) ───────────────────────────────────────────────────────────
// NEW-FU-660: scoped — an instructor/venue export's table lists only that entity's
// sections (same set as the grid).
async function fetchTableGroups(scheduleId, filter = { type: 'full' }) {
  const sections = await fetchScopedSections(scheduleId, filter);
  const groups = new Map();
  for (const sec of sections) {
    const key = `${sec.courseId}|${sec.sectionNumber}|${sec.gender ?? 'M'}`;
    if (!groups.has(key)) groups.set(key, { sec, days: [] });
    groups.get(key).days.push(sec.day);
  }
  return groups;
}

// NEW-FU-660: `title` carries the scope-tagged heading (full → "Full Semester (all
// sections)"; instructor/venue → "Instructor/Venue Schedule · <name>"), which the PDF
// importer reads to detect the file's scope.
function renderTableInto(doc, groups, semester, title) {
  doc.font('Helvetica-Bold').fontSize(15).fillColor(HEADER_COLOR)
     .text(title || `${semester || 'Schedule'} — Full Semester (all sections)`, { align: 'left' });
  doc.moveDown(0.4);

  const cols    = TABLE_COLS;
  const totalW  = cols.reduce((s, c) => s + c.width, 0);
  const left    = doc.page.margins.left;
  const PAD     = 3;
  const nameW   = cols.find(c => c.key === 'courseName').width - 4;
  let y = doc.y;

  // NEW-FU-666: a TALLER header band so full headers WRAP to two lines instead of being
  // truncated to "Course Co"/"Acad. Level"/"Cat."/… The data cells (below) wrap too.
  const HEADER_H = 24;
  const drawHeader = () => {
    doc.rect(left, y, totalW, HEADER_H).fill(HEADER_COLOR);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(TABLE_FONT);
    let x = left;
    for (const c of cols) { doc.text(c.label, x + 2, y + 3, { width: c.width - 4, lineGap: 0, ellipsis: false }); x += c.width; }
    y += HEADER_H;
  };
  drawHeader();

  for (const [, { sec, days }] of groups) {
    const startT = (sec.startTime ?? '').substring(0, 5);
    const endT   = (sec.endTime   ?? '').substring(0, 5);
    const [h1, m1] = startT.split(':').map(Number);
    const [h2, m2] = endT.split(':').map(Number);
    const duration = (h2 * 60 + m2) - (h1 * 60 + m1);
    const bg = LEVEL_COLORS[sec.academicLevel] ?? '#FFFFFF';

    const values = {
      courseCode:    sec.courseCode    ?? '',
      courseName:    sec.courseName    ?? '',
      academicLevel: sec.academicLevel ?? '',
      category:      labels.categoryDisplay(sec.category),          // NEW-FU-666: end-user labels
      credits:       sec.credits ?? '',
      courseType:    labels.courseTypeLabel(sec),
      sectionNumber: sec.sectionNumber ?? '',
      sectionType:   labels.sectionTypeDisplay(sec.sectionType ?? 'Lec'),
      gender:        labels.genderDisplay(sec.gender === 'F' ? 'F' : 'M'),
      days:          days.sort().join(', '),
      startTime:     startT,
      endTime:       endT,
      duration:      String(duration),
      instructor:    sec.instructorName ?? '',
      venue:         sec.venueName      ?? '',
      venueType:     labels.venueTypeDisplay(sec.venueType),
    };

    // NEW-FU-657b/FU-666: cells WRAP (no truncation → lossless, readable). PDFKit breaks at
    // spaces AND hyphens; the importer re-joins lines, adding a space EXCEPT after a trailing
    // hyphen, so both "…Computer\nInteraction" and "Human-\nComputer" rebuild exactly. The row
    // height is the TALLEST wrapped cell (course name, and a long Course Type like "Has
    // Laboratory"), so every full header/value shows in full. (Helvetica lacks a non-breaking
    // hyphen, so real hyphens stay.)
    doc.font('Helvetica').fontSize(TABLE_FONT);
    let cellH = 0;
    for (const c of cols) {
      const h = doc.heightOfString(String(values[c.key] ?? '') || ' ', { width: c.width - 4, lineGap: 1 });
      if (h > cellH) cellH = h;
    }
    const rowH = Math.max(14, Math.ceil(cellH) + 2 * PAD);

    if (y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage(); y = doc.page.margins.top; drawHeader();
      doc.font('Helvetica').fontSize(TABLE_FONT);
    }

    doc.rect(left, y, totalW, rowH).fill(bg).fillColor('#000000');
    doc.font('Helvetica').fontSize(TABLE_FONT).fillColor('#000000');
    let x = left;
    for (const c of cols) {
      doc.text(String(values[c.key] ?? ''), x + 2, y + PAD, { width: c.width - 4, lineGap: 1 });
      x += c.width;
    }

    doc.strokeColor('#D0D8E8').lineWidth(0.4);
    x = left;
    for (const c of cols) { doc.rect(x, y, c.width, rowH).stroke(); x += c.width; }
    y += rowH;
  }
}

async function buildTablePdfBuffer(scheduleId, semester) {
  const groups = await fetchTableGroups(scheduleId);
  return pdfToBuffer((doc) => renderTableInto(doc, groups, semester));
}

// ── OFFICE HOURS (reference data; carried so re-import has no R-13) ───────────────
// NEW-FU-660: the OH / instructor / venue reference sets are now fetched SCOPED via
// the shared exportScope helpers, so an instructor/venue PDF carries only that
// entity's reference data. (Whole-term export is unchanged.)
function renderOfficeHoursInto(doc, ohRows, semester) {
  doc.font('Helvetica-Bold').fontSize(15).fillColor(HEADER_COLOR)
     .text(`${semester || 'Schedule'} — Office Hours`, { align: 'left' });
  doc.moveDown(0.4);

  const cols   = OH_COLS;
  const totalW = cols.reduce((s, c) => s + c.width, 0);
  const left   = doc.page.margins.left;
  const ROW_H  = 16;
  let y = doc.y;

  const drawHeader = () => {
    doc.rect(left, y, totalW, ROW_H).fill(HEADER_COLOR);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
    let x = left;
    for (const c of cols) { doc.text(c.label, x + 3, y + 4, { width: c.width - 6, lineBreak: false }); x += c.width; }
    y += ROW_H;
  };
  drawHeader();

  for (const oh of ohRows) {
    if (y + ROW_H > doc.page.height - doc.page.margins.bottom) {
      doc.addPage(); y = doc.page.margins.top; drawHeader();
    }
    doc.rect(left, y, totalW, ROW_H).fill('#FFFFFF').fillColor('#000000');
    const vals = [oh.instructor_name ?? '', oh.day ?? '', (oh.start_time ?? '').substring(0, 5), (oh.end_time ?? '').substring(0, 5)];
    doc.font('Helvetica').fontSize(9).fillColor('#000000');
    let x = left;
    for (let i = 0; i < cols.length; i++) { doc.text(fitText(doc, String(vals[i]), cols[i].width - 6), x + 3, y + 4, { width: cols[i].width - 6, lineBreak: false }); x += cols[i].width; }
    doc.strokeColor('#D0D8E8').lineWidth(0.4);
    x = left;
    for (const c of cols) { doc.rect(x, y, c.width, ROW_H).stroke(); x += c.width; }
    y += ROW_H;
  }
}

// ── REFERENCE TABLES (Instructors + Venues) — NEW-FU-657b ─────────────────────────
// Generic single-line reference table (wide columns → no truncation).
function renderRefTable(doc, title, cols, rows) {
  doc.font('Helvetica-Bold').fontSize(15).fillColor(HEADER_COLOR).text(title, { align: 'left' });
  doc.moveDown(0.4);
  const totalW = cols.reduce((s, c) => s + c.width, 0);
  const left   = doc.page.margins.left;
  const ROW_H  = 16;
  let y = doc.y;
  const drawHeader = () => {
    doc.rect(left, y, totalW, ROW_H).fill(HEADER_COLOR);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
    let x = left;
    for (const c of cols) { doc.text(c.label, x + 3, y + 4, { width: c.width - 6, lineBreak: false }); x += c.width; }
    y += ROW_H;
  };
  drawHeader();
  for (const row of rows) {
    if (y + ROW_H > doc.page.height - doc.page.margins.bottom) { doc.addPage(); y = doc.page.margins.top; drawHeader(); }
    doc.rect(left, y, totalW, ROW_H).fill('#FFFFFF').fillColor('#000000');
    doc.font('Helvetica').fontSize(9).fillColor('#000000');
    let x = left;
    for (const c of cols) { doc.text(fitText(doc, String(row[c.key] ?? ''), c.width - 6), x + 3, y + 4, { width: c.width - 6, lineBreak: false }); x += c.width; }
    doc.strokeColor('#D0D8E8').lineWidth(0.4);
    x = left;
    for (const c of cols) { doc.rect(x, y, c.width, ROW_H).stroke(); x += c.width; }
    y += ROW_H;
  }
}

// ── GRID (Half A) ──────────────────────────────────────────────────────────────
async function fetchGridData(scheduleId, filter, semester) {
  let sections = [];
  let title = `${semester || 'Schedule'} — Full Schedule`;

  if (filter.type === 'instructor' && filter.id) {
    const [instr, secs] = await Promise.all([
      instrRepo.findById(filter.id),
      sectionRepo.findByInstructor(scheduleId, filter.id),
    ]);
    sections = secs;
    title = `${semester || 'Schedule'} — ${instr?.name || 'Instructor'}`;
  } else if (filter.type === 'venue' && filter.id) {
    const venue = await new VenueRepository().findById(filter.id);
    sections = await sectionRepo.findByVenue(scheduleId, filter.id);
    title = `${semester || 'Schedule'} — ${venue?.name || 'Venue'}`;
  } else {
    sections = await sectionRepo.findBySchedule(scheduleId);
  }

  const allConflicts = await conflictRepo.findBySchedule(scheduleId);
  const softIds = new Set(
    allConflicts.filter(c => c.isSoft && !c.confirmed)
      .flatMap(c => [c.sectionAId, c.sectionBId].filter(Boolean))
  );

  const daySecs = Object.fromEntries(DAYS.map(d => [d, []]));
  for (const sec of sections) {
    if (!sec.startTime || !sec.endTime) continue;
    const ss = timeToSlot(sec.startTime);
    const es = timeToSlot(sec.endTime);
    if (ss >= es) continue;
    daySecs[sec.day]?.push({ sec, startSlot: ss, endSlot: es, lane: 0 });
  }
  const laneTotals = {};
  for (const d of DAYS) laneTotals[d] = assignLanes(daySecs[d]);

  return { daySecs, laneTotals, softIds, title };
}

function renderGridInto(doc, { daySecs, laneTotals, softIds, title }) {
  doc.font('Helvetica-Bold').fontSize(14).fillColor(HEADER_COLOR)
     .text(title, { align: 'left' });
  doc.moveDown(0.3);

  const left   = doc.page.margins.left;
  const top    = doc.y;
  const pageW  = doc.page.width  - doc.page.margins.left - doc.page.margins.right;
  const pageH  = doc.page.height - top - doc.page.margins.bottom;

  const timeColW = 42;
  const dayColW  = (pageW - timeColW) / DAYS.length;
  const headerH  = 18;
  // NEW-FU-658: fill the page height with the 180 5-min slots (float rowH) so blocks
  // are positioned to the exact minute, matching the Excel/Word grids.
  const rowH     = (pageH - headerH) / TOTAL_SLOTS;

  doc.rect(left, top, timeColW, headerH).fill(HEADER_COLOR);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9)
     .text('Time', left, top + 5, { width: timeColW, align: 'center' });
  DAYS.forEach((d, i) => {
    const x = left + timeColW + i * dayColW;
    doc.rect(x, top, dayColW, headerH).fill(HEADER_COLOR);
    doc.fillColor('#FFFFFF').text(d, x, top + 5, { width: dayColW, align: 'center' });
  });

  for (let s = 0; s < TOTAL_SLOTS; s++) {
    const y = top + headerH + s * rowH;
    doc.rect(left, y, timeColW, rowH).fill(TIME_BG);
    // NEW-FU-658: alternate the background per HOUR (12 slots), not per 5-min, so the
    // fine grid reads as clean hour bands instead of dense stripes.
    const band = Math.floor(s / 12) % 2 === 0 ? '#FAFAFA' : '#F0F4FA';
    DAYS.forEach((_, di) => {
      const x = left + timeColW + di * dayColW;
      doc.rect(x, y, dayColW, rowH).fill(band);
    });
  }
  // Hour labels + subtle hour gridlines (every 12 slots).
  doc.strokeColor('#E2E8F0').lineWidth(0.3);
  for (let s = 0; s <= TOTAL_SLOTS; s += 12) {
    const y = top + headerH + s * rowH;
    doc.moveTo(left, y).lineTo(left + timeColW + DAYS.length * dayColW, y).stroke();
    if (s < TOTAL_SLOTS) {
      doc.fillColor('#1F4E79').font('Helvetica-Bold').fontSize(7)
         .text(slotToTime(s), left, y + 1, { width: timeColW, align: 'center' });
    }
  }

  doc.strokeColor(BORDER_COL).lineWidth(0.5);
  for (let i = 0; i <= DAYS.length; i++) {
    const x = left + timeColW + i * dayColW;
    doc.moveTo(x, top).lineTo(x, top + headerH + TOTAL_SLOTS * rowH).stroke();
  }

  DAYS.forEach((day, di) => {
    const xBase   = left + timeColW + di * dayColW;
    const laneTot = laneTotals[day] || 1;
    const subW    = dayColW / laneTot;
    for (const { sec, startSlot, endSlot, lane } of daySecs[day]) {
      const y      = top + headerH + startSlot * rowH;
      const h      = (endSlot - startSlot) * rowH;
      const x      = xBase + lane * subW;
      const isSoft = softIds.has(sec.id);
      const bg     = isSoft ? SOFT_COLOR : (LEVEL_COLORS[sec.academicLevel] ?? '#E8F4FD');
      doc.rect(x + 1, y + 1, subW - 2, h - 1).fill(bg);
      doc.strokeColor(isSoft ? '#B45309' : '#2E75B6').lineWidth(0.6)
         .rect(x + 1, y + 1, subW - 2, h - 1).stroke();
      const lines = [
        `${sec.courseCode ?? ''} ${sectionLabel(sec)} · ${labels.sectionTypeShort(sec.sectionType)}`,   // NEW-FU-666: Lec/Lab flag
        `${(sec.startTime ?? '').substring(0, 5)}–${(sec.endTime ?? '').substring(0, 5)}`,
        sec.instructorName ?? '(no instructor)',
        sec.venueName ?? '',
      ].filter(Boolean);
      doc.fillColor('#000000').font('Helvetica').fontSize(laneTot > 2 ? 6 : 7)
         .text(lines.join('\n'), x + 2, y + 2, { width: subW - 4, height: h - 3, ellipsis: true });
    }
  });
}

async function buildGridPdfBuffer(scheduleId, filter, semester) {
  const data = await fetchGridData(scheduleId, filter, semester);
  return pdfToBuffer((doc) => renderGridInto(doc, data));
}

// NEW-FU-667: the IMAGE export. The old PNG was a client-side html2canvas screenshot of the
// LIVE DOM, so it captured whatever was on screen — the wrong scope (a "venue" image showed the
// whole-term grid), the current theme (dark/light), and the current view/mode. We instead
// RASTERIZE the same SCOPED, theme-independent grid PDF the other formats already produce, so a
// venue image shows ONLY that venue's grid, an instructor image only that instructor's, and the
// whole-term image the whole grid — deterministic, scope-correct, and identical in every theme.
// (Uses pdfjs to render the grid page onto an @napi-rs/canvas surface → PNG; no browser/DOM.)
async function buildGridPngBuffer(scheduleId, filter, semester) {
  const pdfBuf = await buildGridPdfBuffer(scheduleId, filter, semester);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf), isEvalSupported: false }).promise;
  const page = await doc.getPage(1);   // the grid is always a single fixed-layout page
  const viewport = page.getViewport({ scale: 2 });   // 2× for a crisp, print-quality image
  const canvasFactory = {
    create: (w, h) => { const c = createCanvas(w, h); return { canvas: c, context: c.getContext('2d') }; },
    reset: (cc, w, h) => { cc.canvas.width = w; cc.canvas.height = h; },
    destroy: (cc) => { try { cc.canvas.width = 0; cc.canvas.height = 0; } catch { /* ignore */ } },
  };
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport, canvasFactory }).promise;
  return canvas.toBuffer('image/png');
}

// ── COMBINED (grid + table + office hours) ────────────────────────────────────────
async function buildCombinedPdfBuffer(scheduleId, filter = { type: 'full' }, semester) {
  // NEW-FU-660: every half is scoped to the same filter — a scoped PDF carries only
  // that entity's grid + table + reference data. The table heading is scope-tagged so
  // the PDF importer can detect whether to merge (instructor/venue) or replace (full).
  const scopeName = scope.scopeOf(filter);
  const entity    = await scope.fetchScopeEntity(filter);
  const tableTitle = scope.tableTitle(semester, scopeName, entity);
  const [gridData, groups, ohRows, instrRows, venueRows] = await Promise.all([
    fetchGridData(scheduleId, filter, semester),
    fetchTableGroups(scheduleId, filter),
    scope.fetchOfficeHours(scheduleId, filter),
    scope.fetchInstructorsRef(scheduleId, filter),
    scope.fetchVenuesRef(scheduleId, filter),
  ]);
  return pdfToBuffer((doc) => {
    renderGridInto(doc, gridData);
    doc.addPage();
    renderTableInto(doc, groups, semester, tableTitle);
    // NEW-FU-667: explain (once, at the top of the first reference page) why a VENUE file also
    // lists the instructors who teach here and their office hours — so it doesn't read as a bug.
    let venueNoteShown = false;
    const showVenueNote = () => {
      if (scopeName !== 'venue' || venueNoteShown) return;
      venueNoteShown = true;
      const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#555555')
         .text(scope.VENUE_EXPORT_NOTE, doc.page.margins.left, doc.y, { width: w, align: 'left' });
      doc.moveDown(0.8).fillColor('#000000');
    };
    if (ohRows.length) {
      doc.addPage();
      showVenueNote();
      renderOfficeHoursInto(doc, ohRows, semester);
    }
    if (instrRows.length) {
      doc.addPage();
      showVenueNote();
      // NEW-FU-666: SINGULAR heading in a single-instructor file ("Instructor", not "Instructors").
      const h = scopeName === 'instructor' ? 'Instructor' : 'Instructors';
      renderRefTable(doc, `${semester || 'Schedule'} — ${h}`, INSTRUCTOR_COLS, instrRows);
    }
    if (venueRows.length) {
      doc.addPage();
      const h = scopeName === 'venue' ? 'Venue' : 'Venues';   // NEW-FU-666: singular for a single-venue file
      // NEW-FU-666: humanize the venue type column (LectureHall → Lecture Hall).
      const rows = venueRows.map(v => ({ ...v, type: labels.venueTypeDisplay(v.type) }));
      renderRefTable(doc, `${semester || 'Schedule'} — ${h}`, VENUE_COLS, rows);
    }
  });
}

module.exports = {
  buildTablePdfBuffer, buildGridPdfBuffer, buildGridPngBuffer, buildCombinedPdfBuffer,
  TABLE_COLS, OH_COLS, INSTRUCTOR_COLS, VENUE_COLS, LEFT_MARGIN,
};
