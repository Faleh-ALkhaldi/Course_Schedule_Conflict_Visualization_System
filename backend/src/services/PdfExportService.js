/**
 * PdfExportService
 *
 * PDF generation using PDFKit (no headless browser — keeps the deploy
 * footprint inside Render's 512MB free-tier envelope).
 *
 * Two render modes mirror the Excel exporter:
 *   buildTablePdfBuffer(scheduleId, semester)
 *     → Full-Semester table (one row per section group).
 *
 *   buildGridPdfBuffer(scheduleId, filter, semester)
 *     → Instructor / Venue weekly visual grid.
 *
 * Both return a Promise<Buffer> that the controller streams as
 * application/pdf.
 */
const PDFDocument = require('pdfkit');
const SectionRepository    = require('../repositories/SectionRepository');
const InstructorRepository = require('../repositories/InstructorRepository');
const { ConflictRepository, VenueRepository } = require('../repositories/repositories');

const sectionRepo  = new SectionRepository();
const instrRepo    = new InstructorRepository();
const conflictRepo = new ConflictRepository();

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday'];

// Hex colors (PDFKit takes CSS-style hex; the Excel exporter uses ARGB which
// PDFKit doesn't speak — keeping a parallel palette so the two formats remain
// visually consistent without coupling the conversion).
const LEVEL_COLORS = {
  Freshman:  '#DAEEF3',
  Sophomore: '#E2EFDA',
  Junior:    '#FFF2CC',
  Senior:    '#E8E0F5',
  Graduate:  '#EADDC1',
};
const SOFT_COLOR   = '#FFE08A';
const HEADER_COLOR = '#1F4E79';
const TIME_BG      = '#E8EEF7';
const BORDER_COL   = '#94A3B8';

const SLOT_MIN = 30;          // PDF grid uses 30-min granularity (the 5-min slots from Excel are too dense for printable PDF).
const START_H  = 7;
const END_H    = 22;
const TOTAL_SLOTS = ((END_H - START_H) * 60) / SLOT_MIN;

function timeToSlot(t) {
  if (!t) return 0;
  const [h, m] = t.substring(0, 5).split(':').map(Number);
  return Math.round(((h - START_H) * 60 + m) / SLOT_MIN);
}
function slotToTime(slot) {
  const tot = START_H * 60 + slot * SLOT_MIN;
  return `${String(Math.floor(tot / 60)).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`;
}

// Wrap PDFKit's stream API as a Buffer Promise so the controller can `await`.
function pdfToBuffer(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { buildFn(doc); doc.end(); }
    catch (err) { reject(err); }
  });
}

// ── TABLE PDF ──────────────────────────────────────────────────────────────────
async function buildTablePdfBuffer(scheduleId, semester) {
  const sections = await sectionRepo.findBySchedule(scheduleId);

  // Group by courseId + sectionNumber so each section group is one row,
  // mirroring the Excel exporter's grouping (downstream tools that import
  // either format see the same logical rows).
  const groups = new Map();
  for (const sec of sections) {
    const key = `${sec.courseId}|${sec.sectionNumber}`;
    if (!groups.has(key)) groups.set(key, { sec, days: [] });
    groups.get(key).days.push(sec.day);
  }

  return pdfToBuffer((doc) => {
    doc.font('Helvetica-Bold').fontSize(16).fillColor(HEADER_COLOR)
       .text(`${semester || 'Schedule'} — Full Semester`, { align: 'left' });
    doc.moveDown(0.4);

    const cols = [
      { key: 'courseCode',    label: 'Code',     width: 50 },
      { key: 'courseName',    label: 'Name',     width: 110 },
      { key: 'sectionNumber', label: '§',        width: 26 },
      { key: 'sectionType',   label: 'Type',     width: 36 },
      { key: 'days',          label: 'Days',     width: 96 },
      { key: 'startTime',     label: 'Start',    width: 40 },
      { key: 'endTime',       label: 'End',      width: 40 },
      { key: 'duration',      label: 'Min',      width: 30 },
      { key: 'instructor',    label: 'Instructor', width: 110 },
      { key: 'venue',         label: 'Venue',    width: 70 },
    ];
    const totalW = cols.reduce((s, c) => s + c.width, 0);
    const left   = doc.page.margins.left;

    let y = doc.y;
    const drawHeaderRow = () => {
      doc.rect(left, y, totalW, 18).fill(HEADER_COLOR);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
      let x = left;
      for (const c of cols) {
        doc.text(c.label, x + 4, y + 5, { width: c.width - 8, ellipsis: true });
        x += c.width;
      }
      y += 18;
    };
    drawHeaderRow();

    doc.font('Helvetica').fontSize(8).fillColor('#000000');
    for (const [, { sec, days }] of groups) {
      const startT = (sec.startTime ?? '').substring(0, 5);
      const endT   = (sec.endTime   ?? '').substring(0, 5);
      const [h1, m1] = startT.split(':').map(Number);
      const [h2, m2] = endT.split(':').map(Number);
      const duration = (h2 * 60 + m2) - (h1 * 60 + m1);
      const bg = LEVEL_COLORS[sec.academicLevel] ?? '#FFFFFF';

      if (y + 16 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeaderRow();
        doc.font('Helvetica').fontSize(8).fillColor('#000000');
      }

      doc.rect(left, y, totalW, 16).fill(bg).fillColor('#000000');

      const values = {
        courseCode:    sec.courseCode    ?? '',
        courseName:    sec.courseName    ?? '',
        sectionNumber: sec.sectionNumber ?? '',
        sectionType:   sec.sectionType   ?? 'Lec',
        days:          days.sort().join(', '),
        startTime:     startT,
        endTime:       endT,
        duration:      String(duration),
        instructor:    sec.instructorName ?? '',
        venue:         sec.venueName      ?? '',
      };
      let x = left;
      for (const c of cols) {
        doc.text(String(values[c.key] ?? ''), x + 4, y + 4, {
          width: c.width - 8, height: 12, ellipsis: true,
        });
        x += c.width;
      }

      // Cell borders (drawn after text so the stroke doesn't get overwritten).
      doc.strokeColor('#D0D8E8').lineWidth(0.4);
      x = left;
      for (const c of cols) {
        doc.rect(x, y, c.width, 16).stroke();
        x += c.width;
      }
      y += 16;
    }
  });
}

// ── GRID PDF ──────────────────────────────────────────────────────────────────
async function buildGridPdfBuffer(scheduleId, filter, semester) {
  let sections = [];
  let title = semester || 'Schedule';

  if (filter.type === 'instructor' && filter.id) {
    const [instr, secs] = await Promise.all([
      instrRepo.findById(filter.id),
      sectionRepo.findByInstructor(scheduleId, filter.id),
    ]);
    sections = secs;
    title = `${semester || 'Schedule'} — ${instr?.name || 'Instructor'}`;
    // Office hours intentionally excluded from PDF/Word per the design call —
    // grid PDF shows the teaching schedule only.
  } else if (filter.type === 'venue' && filter.id) {
    const venue = await new VenueRepository().findById(filter.id);
    sections = await sectionRepo.findByVenue(scheduleId, filter.id);
    title = `${semester || 'Schedule'} — ${venue?.name || 'Venue'}`;
  }

  const allConflicts = await conflictRepo.findBySchedule(scheduleId);
  const softIds = new Set(
    allConflicts
      .filter(c => c.isSoft && !c.confirmed)
      .flatMap(c => [c.sectionAId, c.sectionBId].filter(Boolean))
  );

  // Bucket sections by day with slot bounds for the grid.
  const daySecs = Object.fromEntries(DAYS.map(d => [d, []]));
  for (const sec of sections) {
    if (!sec.startTime || !sec.endTime) continue;
    const ss = timeToSlot(sec.startTime);
    const es = timeToSlot(sec.endTime);
    if (ss >= es) continue;
    daySecs[sec.day]?.push({ sec, startSlot: ss, endSlot: es });
  }

  return pdfToBuffer((doc) => {
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
    const rowH     = Math.min(14, Math.floor((pageH - headerH) / TOTAL_SLOTS));

    // Header row
    doc.rect(left, top, timeColW, headerH).fill(HEADER_COLOR);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9)
       .text('Time', left, top + 5, { width: timeColW, align: 'center' });
    DAYS.forEach((d, i) => {
      const x = left + timeColW + i * dayColW;
      doc.rect(x, top, dayColW, headerH).fill(HEADER_COLOR);
      doc.fillColor('#FFFFFF').text(d, x, top + 5, { width: dayColW, align: 'center' });
    });

    // Time column + empty cells
    for (let s = 0; s < TOTAL_SLOTS; s++) {
      const y = top + headerH + s * rowH;
      doc.rect(left, y, timeColW, rowH).fill(TIME_BG);
      if (slotToTime(s).endsWith(':00')) {
        doc.fillColor('#1F4E79').font('Helvetica-Bold').fontSize(7)
           .text(slotToTime(s), left, y + rowH / 2 - 4, {
             width: timeColW, align: 'center',
           });
      }
      DAYS.forEach((_, di) => {
        const x = left + timeColW + di * dayColW;
        doc.rect(x, y, dayColW, rowH).fill(s % 2 === 0 ? '#FAFAFA' : '#F0F4FA');
      });
    }

    // Day column borders
    doc.strokeColor(BORDER_COL).lineWidth(0.5);
    for (let i = 0; i <= DAYS.length; i++) {
      const x = left + timeColW + i * dayColW;
      doc.moveTo(x, top).lineTo(x, top + headerH + TOTAL_SLOTS * rowH).stroke();
    }

    // Section blocks
    DAYS.forEach((day, di) => {
      const xBase = left + timeColW + di * dayColW;
      for (const { sec, startSlot, endSlot } of daySecs[day]) {
        const y      = top + headerH + startSlot * rowH;
        const h      = (endSlot - startSlot) * rowH;
        const isSoft = softIds.has(sec.id);
        const bg     = isSoft ? SOFT_COLOR : (LEVEL_COLORS[sec.academicLevel] ?? '#E8F4FD');
        doc.rect(xBase + 1, y + 1, dayColW - 2, h - 1).fill(bg);
        doc.strokeColor(isSoft ? '#B45309' : '#2E75B6').lineWidth(0.6)
           .rect(xBase + 1, y + 1, dayColW - 2, h - 1).stroke();

        const lines = [
          `${sec.courseCode ?? ''} §${sec.sectionNumber ?? ''}`,
          `${(sec.startTime ?? '').substring(0, 5)}–${(sec.endTime ?? '').substring(0, 5)}`,
          sec.instructorName ?? '(no instructor)',
          sec.venueName ?? '',
        ].filter(Boolean);
        doc.fillColor('#000000').font('Helvetica').fontSize(7)
           .text(lines.join('\n'), xBase + 3, y + 3, {
             width: dayColW - 6, height: h - 4, ellipsis: true,
           });
      }
    });
  });
}

module.exports = { buildTablePdfBuffer, buildGridPdfBuffer };
