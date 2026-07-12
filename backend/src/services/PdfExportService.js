/**
 * PdfExportService
 *
 * PDF generation using PDFKit (no headless browser — keeps the deploy
 * footprint inside Render's 512MB free-tier envelope).
 *
 * NEW-FU-657: the public export is the COMBINED document —
 *   buildCombinedPdfBuffer(scheduleId, filter, semester)
 *     page 1+:  visual weekly schedule grid (Half A, focused scope = filter)
 *     then:     scoped section table (Half B, same focused scope)
 *     then:     reference tables needed for a conflict-clean re-import
 * Whole-term files still carry every section. Instructor/venue files carry the
 * selected entity plus required complementary Lec/Lab rows and references. The
 * table/OH column layouts (TABLE_COLS / OH_COLS / LEFT_MARGIN) are
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
  // NEW-FU-682: a scoped export also carries the COMPLEMENTARY half of each has_lab course (flagged
  // isComplement) so a re-import rebuilds the COMPLETE lecture+lab course.
  return sectionRepo.findScopedWithComplement(scheduleId, filter);
}

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday'];

const LEVEL_COLORS = {
  Freshman:  '#DAEEF3', Sophomore: '#E2EFDA', Junior: '#FFF2CC',
  Senior:    '#E8E0F5', Graduate:  '#EADDC1',
};
const SOFT_COLOR   = '#FFE08A';
// NEW-FU-682: a rose tint + deep-rose border for a CARRIED COMPLEMENT section (a lab course's other
// half). Distinct from every cool level pastel and the amber soft-conflict color, so the eye separates
// "carried" rows/cards at a glance even before reading the side note. ASCII hex (pdfkit, light + dark).
const COMPLEMENT_BG     = '#F3CCDD';
const COMPLEMENT_BORDER = '#C2185B';
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
  { key: 'gender',        label: 'Gender',         width: 32 },   // NEW-FU-679: +6 so the header "Gender" AND the value "Female" fit one line (was 26pt → char-wrapped to "Gende r" / "Femal e")
  { key: 'days',          label: 'Days',           width: 96 },   // NEW-FU-671: −6 to fund Academic Level · NEW-FU-679: −6 more to fund Gender (days still wraps "Sunday, Tuesday, Thursday" at its commas)
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

// NEW-FU-679: draw text into a fixed-width table cell WITHOUT ever char-breaking a single word.
// PDFKit wraps multi-word text at spaces/hyphens, but a single token wider than the cell is split
// MID-CHARACTER ("Gender"→"Gende\nr", "Female"→"Femal\ne") — which both looks broken AND corrupts
// the positional importer's line-rejoin (it would reconstruct "Femal e"). If the widest unbreakable
// token exceeds the inner width, shrink THIS cell's font just enough to fit it (down to a 4.5pt
// floor), then draw; multi-word text still wraps at spaces. Text stays left-aligned at the column
// x, so the positional importer maps every cell back to its column regardless of the per-cell size.
function fitCellText(doc, value, x, y, innerW, baseSize, fontName, textOpts) {
  const str = String(value ?? '');
  doc.font(fontName).fontSize(baseSize);
  let widest = 0;
  for (const tok of str.split(/[\s-]+/)) {
    if (!tok) continue;
    const w = doc.widthOfString(tok);
    if (w > widest) widest = w;
  }
  const size = (widest > innerW && widest > 0) ? Math.max(4.5, baseSize * innerW / widest) : baseSize;
  doc.fontSize(size).text(str, x, y, { width: innerW, ...textOpts });
  doc.fontSize(baseSize);
}

// NEW-FU-680: `firstPageOpts` lets the GRID build open the document on a dynamically-sized first
// page (wide enough for a dense schedule — see gridPageSize); margin defaults to LEFT_MARGIN.
function pdfToBuffer(buildFn, firstPageOpts) {
  return new Promise((resolve, reject) => {
    // NEW-FU-680: an explicit ARRAY size is already [width, height] — do NOT also pass `layout`, or
    // pdfkit re-orients it to portrait (tall + narrow). Named-size pages keep size+layout as before.
    const opts = (firstPageOpts && Array.isArray(firstPageOpts.size))
      ? Object.assign({ margin: LEFT_MARGIN }, firstPageOpts)
      : Object.assign({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN }, firstPageOpts || {});
    const doc = new PDFDocument(opts);
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { buildFn(doc); doc.end(); }
    catch (err) { reject(err); }
  });
}

// NEW-FU-680: the weekly grid PAGE widens with density so even the busiest day's side-by-side
// sections (lanes) stay wide enough to show a full course / time / instructor on one line — ending
// the truncation ("AHMED AL-NAZER…", "17:20–…") that plagued the DENSE full-term grid where many
// overlapping sections squeezed cards into tiny lanes. A4-landscape is the FLOOR (sparse
// instructor/venue grids are unchanged); the page grows up to a safety cap for dense terms. The
// height stays A4-landscape — a 50-min block there already holds four lines (instructor/venue grids
// prove it); only horizontal room was missing. renderGridInto reads doc.page.width, so it adapts
// automatically; the PNG export rasterizes this same page, so the image widens too.
const A4_LANDSCAPE = [841.89, 595.28];
const GRID_MAX_SCALE = 2.6;     // hard cap (≈ A1) so a pathological term can't explode the page
// Scale the WHOLE grid page up with density, keeping the A4 aspect ratio, so a dense grid's cards grow
// in BOTH width (lanes stay wide enough for a full name/time on one line) AND height (a 50-min block
// stays tall enough for all four lines). renderGridInto derives dayColW + rowH from the page, so both
// follow automatically. ≤ 2 lanes (sparse instructor/venue grids) → A4 (unchanged); denser → larger.
function gridPageSize(maxLanes) {
  const scale = Math.min(GRID_MAX_SCALE, Math.max(1, Math.max(1, maxLanes) / 2));
  return [A4_LANDSCAPE[0] * scale, A4_LANDSCAPE[1] * scale];
}
const maxLanesOf = (laneTotals) => Math.max(1, ...Object.values(laneTotals || {}).map(Number));

// ── TABLE (Half B) ───────────────────────────────────────────────────────────
// NEW-FU-660/FU-682: scoped table groups use the same focused set as the grid: the
// selected entity's own sections plus carried complementary Lec/Lab sections.
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
// NEW-FU-687 (Part B): `complementOnly` splits one combined group map into two tables — the ASSIGNED
// table (complementOnly=false, the entity's own sections) and a separate CARRIED table
// (complementOnly=true, the reference-only complementary halves). `noteText`, when set (carried table),
// is drawn IN RED inside the repeating page header, so the "these are carried, not part of this
// schedule" warning shows on EVERY page the carried table spans — never just the first.
function renderTableInto(doc, groups, semester, title, { complementOnly = false, noteText = null } = {}) {
  doc.font('Helvetica-Bold').fontSize(complementOnly ? 12 : 15)
     .fillColor(complementOnly ? COMPLEMENT_BORDER : HEADER_COLOR)
     .text(title || `${semester || 'Schedule'} — Full Semester (all sections)`, { align: 'left' });
  doc.fillColor('#000000');
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
    // NEW-FU-687 (Part B): the red carried-table note rides the header so it repeats on every page.
    if (noteText) {
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COMPLEMENT_BORDER);
      doc.text(noteText, left, y, { width: totalW });
      y = doc.y + 3; doc.fillColor('#000000');
    }
    doc.rect(left, y, totalW, HEADER_H).fill(complementOnly ? COMPLEMENT_BORDER : HEADER_COLOR);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(TABLE_FONT);
    let x = left;
    // NEW-FU-679: fitCellText guarantees no header word is ever char-split (e.g. "Gender"→"Gende r").
    for (const c of cols) { fitCellText(doc, c.label, x + 2, y + 3, c.width - 4, TABLE_FONT, 'Helvetica-Bold', { lineGap: 0, ellipsis: false }); x += c.width; }
    y += HEADER_H;
  };
  drawHeader();

  for (const [, { sec, days }] of groups) {
    // NEW-FU-687 (Part B): assigned table skips carried rows; carried table skips assigned rows.
    if (Boolean(sec.isComplement) !== complementOnly) continue;
    const startT = (sec.startTime ?? '').substring(0, 5);
    const endT   = (sec.endTime   ?? '').substring(0, 5);
    const [h1, m1] = startT.split(':').map(Number);
    const [h2, m2] = endT.split(':').map(Number);
    // NEW-FU-688: untimed conflict-exempt activity (Project / info-only) → blank duration, not "NaN".
    const durationText = (startT && endT) ? String((h2 * 60 + m2) - (h1 * 60 + m1)) : '';
    // NEW-FU-682: a carried complement row is shaded rose (style mark) instead of its level color — the
    // PDF importer reads cells positionally, so a text tag column would corrupt the last cell; the shade
    // is purely visual and the side note (renderComplementNoteInto) names what the rose rows are.
    const bg = sec.isComplement ? COMPLEMENT_BG : (LEVEL_COLORS[sec.academicLevel] ?? '#FFFFFF');

    const values = {
      courseCode:    sec.courseCode    ?? '',
      courseName:    sec.courseName    ?? '',
      academicLevel: sec.academicLevel ?? '',
      category:      labels.categoryDisplay(sec.category),          // NEW-FU-666: end-user labels
      credits:       sec.credits ?? '',
      courseType:    labels.courseTypeLabel(sec),
      sectionNumber: sec.sectionNumber ?? '',
      sectionType:   labels.sectionTypeDisplay(labels.effectiveSectionType(sec, { season: semester })),   // NEW-FU-687/688: Lec→Prj/Ths + ST/INT by season
      gender:        labels.genderDisplay(sec.gender === 'F' ? 'F' : 'M'),
      days:          days.sort().join(', '),
      startTime:     startT,
      endTime:       endT,
      duration:      durationText,
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
      doc.addPage({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN }); y = doc.page.margins.top; drawHeader();
      doc.font('Helvetica').fontSize(TABLE_FONT);
    }

    doc.rect(left, y, totalW, rowH).fill(bg).fillColor('#000000');
    doc.font('Helvetica').fontSize(TABLE_FONT).fillColor('#000000');
    let x = left;
    // NEW-FU-679: fitCellText guarantees no value is ever char-split (e.g. "Female"→"Femal e"),
    // which also keeps the positional re-import lossless (no "Femal e" reconstruction).
    for (const c of cols) {
      fitCellText(doc, values[c.key], x + 2, y + PAD, c.width - 4, TABLE_FONT, 'Helvetica', { lineGap: 1 });
      x += c.width;
    }

    doc.strokeColor('#D0D8E8').lineWidth(0.4);
    x = left;
    for (const c of cols) { doc.rect(x, y, c.width, rowH).stroke(); x += c.width; }
    y += rowH;
  }
  doc.y = y;   // NEW-FU-680: publish the table's bottom so the legend (renderTypeLegendInto) draws below it
}

// NEW-FU-680: a small legend, just below the section table, defining the easily-confused Course Type
// and Section Type columns (and stating they are independent — a Capstone course can have Lecture
// sections). Shown in every PDF (all scopes). Small font so it never competes with the table.
function renderTypeLegendInto(doc) {
  const left = doc.page.margins.left;
  const w = doc.page.width - left - doc.page.margins.right;
  // start a fresh page only if there isn't room for the ~4 small lines
  if (doc.y + 46 > doc.page.height - doc.page.margins.bottom) { doc.addPage({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN }); doc.y = doc.page.margins.top; }
  else { doc.y += 8; }
  doc.font('Helvetica-Bold').fontSize(8).fillColor(HEADER_COLOR).text(labels.TYPE_LEGEND_TITLE, left, doc.y, { width: w });
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(7.5).fillColor('#444444');
  for (const line of labels.typeLegendLines()) { doc.text(line, left, doc.y, { width: w }); doc.moveDown(0.15); }
  doc.fillColor('#000000');
}

// NEW-FU-682: the side note explaining the rose-shaded "Carried" rows/cards — shown only when the file
// actually carries ≥1 complement section. Drawn just below the table/legend (next to the rows it
// describes), mirroring the VENUE_EXPORT_NOTE styling.
function renderComplementNoteInto(doc) {
  const left = doc.page.margins.left;
  const w = doc.page.width - left - doc.page.margins.right;
  if (doc.y + 56 > doc.page.height - doc.page.margins.bottom) { doc.addPage({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN }); doc.y = doc.page.margins.top; }
  else { doc.y += 8; }
  doc.font('Helvetica-Oblique').fontSize(8).fillColor('#7A2540').text(scope.COMPLEMENT_EXPORT_NOTE, left, doc.y, { width: w, align: 'left' });
  doc.fillColor('#000000');
}

async function buildTablePdfBuffer(scheduleId, semester) {
  const groups = await fetchTableGroups(scheduleId);
  return pdfToBuffer((doc) => renderTableInto(doc, groups, semester));
}

// ── OFFICE HOURS (reference data; carried so re-import has no R-13) ───────────────
// NEW-FU-660/FU-682: the OH / instructor / venue reference sets come from shared
// exportScope helpers, so scoped PDFs carry the selected entity's references plus
// any complementary references needed for a valid re-import.
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
      doc.addPage({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN }); y = doc.page.margins.top; drawHeader();
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
    if (y + ROW_H > doc.page.height - doc.page.margins.bottom) { doc.addPage({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN }); y = doc.page.margins.top; drawHeader(); }
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

// NEW-FU-679: pick the LARGEST font (down to a 4pt floor) at which `text` fits the card box
// (width w, height h) once wrapped — so a short block (a 50-min class is only ~26pt tall on the
// page-height grid) shows ALL of its lines at the biggest readable size instead of being chopped
// to "AHMED AL-NAZER…". Returns { size, fits }; fits=false only when even 4pt overflows (then the
// caller ellipsizes as a last resort). Smaller fonts also pull an over-wide name within the lane,
// so the card never char-breaks either. Pure (font/size only) → unit-testable.
function pickCardFont(doc, text, w, h, maxF) {
  doc.font('Helvetica');
  for (let f = maxF; f >= 4; f -= 0.5) {
    doc.fontSize(f);
    if (doc.heightOfString(text, { width: w }) <= h) return { size: f, fits: true };
  }
  return { size: 4, fits: false };
}

// ── GRID (Half A) ──────────────────────────────────────────────────────────────
async function fetchGridData(scheduleId, filter, semester) {
  let sections = [];
  let title = `${semester || 'Schedule'} — Full Schedule`;

  // NEW-FU-682: the grid (like the table) carries the complementary half of each has_lab course.
  if (filter.type === 'instructor' && filter.id) {
    const [instr, secs] = await Promise.all([
      instrRepo.findById(filter.id),
      sectionRepo.findScopedWithComplement(scheduleId, filter),
    ]);
    sections = secs;
    title = `${semester || 'Schedule'} — ${instr?.name || 'Instructor'}`;
  } else if (filter.type === 'venue' && filter.id) {
    const venue = await new VenueRepository().findById(filter.id);
    sections = await sectionRepo.findScopedWithComplement(scheduleId, filter);
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
    // NEW-FU-687 (Part A/C): the carried complementary half must not be drawn in the focused
    // schedule grid (and so never in the rasterized PNG, which renders this same grid). The grid
    // shows the selected entity's own scheduled sections; carried complements live in a separate
    // table with their own note.
    if (sec.isComplement) continue;
    // NEW-FU-688: the info-only family (external → Summer Training/Internship, thesis, research) is
    // NEVER drawn in the grid even if it carries a placeholder time — it is information-only. Project
    // is NOT excluded here: it draws when timed (the !startTime guard below handles the untimed case).
    if (labels.isInfoOnlyCourse(sec)) continue;
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
      // NEW-FU-682: a carried complement card is rose-tinted with a rose border and a leading "Carried"
      // tag line, so it's distinct from the entity's own cards (the side note on the table page explains it).
      const isComp = sec.isComplement;
      const bg     = isSoft ? SOFT_COLOR : isComp ? COMPLEMENT_BG : (LEVEL_COLORS[sec.academicLevel] ?? '#E8F4FD');
      doc.rect(x + 1, y + 1, subW - 2, h - 1).fill(bg);
      doc.strokeColor(isSoft ? '#B45309' : isComp ? COMPLEMENT_BORDER : '#2E75B6').lineWidth(0.6)
         .rect(x + 1, y + 1, subW - 2, h - 1).stroke();
      const lines = [
        ...(isComp ? [scope.COMPLEMENT_TAG_SHORT] : []),
        `${sec.courseCode ?? ''} ${sectionLabel(sec)} · ${labels.sectionTypeShort(labels.effectiveSectionType(sec))}`,   // NEW-FU-666/687: Lec/Lab/Prj/Ths flag
        `${(sec.startTime ?? '').substring(0, 5)}–${(sec.endTime ?? '').substring(0, 5)}`,
        sec.instructorName ?? '(no instructor)',
        sec.venueName ?? '',
      ].filter(Boolean);
      // NEW-FU-679: auto-FIT the card text to its block instead of truncating it. A short block
      // (a 50-min class is only ~26pt tall on the page-height grid) can't hold four lines at 7pt,
      // so the old { height, ellipsis:true } chopped names to "AHMED AL-NAZER…". Pick the LARGEST
      // font (down to a 4pt floor) at which every line fits the block's width AND height; the
      // smaller font also pulls any over-wide name within the lane so nothing char-breaks. Only a
      // truly impossible block still ellipsizes. (The PNG export rasterizes THIS grid → fixed too.)
      const cardText = lines.join('\n');
      const cardW = subW - 4, cardH = h - 3;
      const { size: cardFont, fits: cardFits } = pickCardFont(doc, cardText, cardW, cardH, laneTot > 2 ? 6 : 7);
      doc.fontSize(cardFont).fillColor('#000000')
         .text(cardText, x + 2, y + 2, { width: cardW, height: cardH, ellipsis: !cardFits });
    }
  });
}

async function buildGridPdfBuffer(scheduleId, filter, semester) {
  const data = await fetchGridData(scheduleId, filter, semester);
  // NEW-FU-680: size the page to the density so dense grids don't truncate (sparse → A4).
  return pdfToBuffer((doc) => renderGridInto(doc, data), { size: gridPageSize(maxLanesOf(data.laneTotals)) });
}

// NEW-FU-667: the IMAGE export. The old PNG was a client-side html2canvas screenshot of the
// LIVE DOM, so it captured whatever was on screen — the wrong scope (a "venue" image showed the
// whole-term grid), the current theme (dark/light), and the current view/mode. We instead
// RASTERIZE the same scoped, theme-independent grid PDF the other formats already produce. A
// venue or instructor image shows the focused scoped grid, including carried complements when
// needed; the whole-term image shows the whole grid — deterministic and scope-correct.
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
  // NEW-FU-660/FU-682: every half is scoped to the same focused set. A scoped PDF
  // carries the selected entity's data plus required complementary rows/references.
  // The table heading is scope-tagged so the PDF importer can detect merge vs replace.
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
    // NEW-FU-680: the grid page is dynamically sized (page 1); the table + reference pages revert to
    // A4 landscape. addPage() with no args thereafter repeats A4, keeping the rest standard.
    // NEW-FU-682: pin every post-grid page to margin LEFT_MARGIN. pdfkit RESETS the margin to its 72pt
    // default whenever addPage is given an options object without `margin`, so FU-680's explicit
    // {size,layout} silently shifted the table 44pt right of the importer's column geometry (which is
    // anchored at LEFT_MARGIN=28) — the positional PDF re-import then read every value one column over
    // (course code → "", name column → "SWE 206 …") and found NO section table, so scoped PDFs would
    // not round-trip. Forcing margin: LEFT_MARGIN realigns export and import.
    doc.addPage({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN });
    renderTableInto(doc, groups, semester, tableTitle);            // NEW-FU-687 (Part B): ASSIGNED sections only
    renderTypeLegendInto(doc);   // NEW-FU-680: Course Type / Section Type definitions, just below the table
    // NEW-FU-687 (Part B): the carried complementary halves go in their OWN table on a fresh page — never
    // mixed into the assigned table — with a RED note repeated on every page of that table, so the reader
    // never confuses a carried section's instructor/venue with the assigned entity's own.
    if ([...groups.values()].some(g => g.sec.isComplement)) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN });
      renderTableInto(doc, groups, semester, scope.COMPLEMENT_EXPORT_TITLE,
        { complementOnly: true, noteText: scope.COMPLEMENT_EXPORT_NOTE });
    }
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
      doc.addPage({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN });
      showVenueNote();
      renderOfficeHoursInto(doc, ohRows, semester);
    }
    if (instrRows.length) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN });
      showVenueNote();
      // NEW-FU-666: SINGULAR heading in a single-instructor file ("Instructor", not "Instructors").
      const h = scopeName === 'instructor' ? 'Instructor' : 'Instructors';
      renderRefTable(doc, `${semester || 'Schedule'} — ${h}`, INSTRUCTOR_COLS, instrRows);
    }
    if (venueRows.length) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN });
      const h = scopeName === 'venue' ? 'Venue' : 'Venues';   // NEW-FU-666: singular for a single-venue file
      // NEW-FU-666: humanize the venue type column (LectureHall → Lecture Hall).
      const rows = venueRows.map(v => ({ ...v, type: labels.venueTypeDisplay(v.type) }));
      renderRefTable(doc, `${semester || 'Schedule'} — ${h}`, VENUE_COLS, rows);
    }
  }, { size: gridPageSize(maxLanesOf(gridData.laneTotals)) });   // NEW-FU-680: page 1 (grid) sized to density
}

module.exports = {
  buildTablePdfBuffer, buildGridPdfBuffer, buildGridPngBuffer, buildCombinedPdfBuffer,
  TABLE_COLS, OH_COLS, INSTRUCTOR_COLS, VENUE_COLS, LEFT_MARGIN,
  // NEW-FU-679: exposed for the layout regression tests (no-char-wrap + no-truncation invariants).
  fitCellText, pickCardFont, TABLE_FONT,
  // NEW-FU-680: exposed for the density-scaling regression test (dense grids get a bigger page).
  gridPageSize, A4_LANDSCAPE,
};
