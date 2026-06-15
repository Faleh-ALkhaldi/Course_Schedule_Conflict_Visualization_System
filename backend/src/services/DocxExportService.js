/**
 * DocxExportService
 *
 * Generates .docx Word documents using the `docx` library. Two render modes:
 *   buildTableDocxBuffer  → one table, one row per section group (round-trips with the Excel/PDF table).
 *   buildGridDocxBuffer   → instructor or venue view as a per-day section list (Word tables don't render colored visual grids well).
 *
 * Office hours are intentionally excluded — Word/PDF exports are "schedule
 * only" per the design call.
 */
const {
  Document, Packer, Paragraph, Table, TableRow, TableCell,
  HeadingLevel, TextRun, WidthType, AlignmentType, ShadingType, BorderStyle,
} = require('docx');
const SectionRepository    = require('../repositories/SectionRepository');
const InstructorRepository = require('../repositories/InstructorRepository');
const { VenueRepository }  = require('../repositories/repositories');

const sectionRepo = new SectionRepository();
const instrRepo   = new InstructorRepository();

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];

// Hex without `#` — docx ShadingType wants raw hex.
const LEVEL_FILL = {
  Freshman:  'DAEEF3',
  Sophomore: 'E2EFDA',
  Junior:    'FFF2CC',
  Senior:    'E8E0F5',
  Graduate:  'EADDC1',
};
const HEADER_FILL = '1F4E79';

function headerCell(text) {
  return new TableCell({
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: HEADER_FILL },
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 18 })],
    })],
  });
}
function bodyCell(text, fill) {
  return new TableCell({
    shading: fill ? { type: ShadingType.CLEAR, color: 'auto', fill } : undefined,
    children: [new Paragraph({
      children: [new TextRun({ text: String(text ?? ''), size: 16 })],
    })],
  });
}

// ── TABLE DOCX ─────────────────────────────────────────────────────────────────
async function buildTableDocxBuffer(scheduleId, semester) {
  const sections = await sectionRepo.findBySchedule(scheduleId);

  const groups = new Map();
  for (const sec of sections) {
    const key = `${sec.courseId}|${sec.sectionNumber}|${sec.gender ?? 'M'}`;
    if (!groups.has(key)) groups.set(key, { sec, days: [] });
    groups.get(key).days.push(sec.day);
  }

  // Long header names match the Excel/import schema 1:1 so an exported DOCX
  // round-trips through importBuffer('docx') without column-alias gymnastics.
  const headers = [
    'Course Code', 'Course Name', 'Section #', 'Section Type',
    'Days', 'Start Time', 'End Time', 'Duration (min)', 'Instructor', 'Venue',
  ];
  const headerRow = new TableRow({ children: headers.map(headerCell), tableHeader: true });

  const dataRows = [];
  for (const [, { sec, days }] of groups) {
    const startT = (sec.startTime ?? '').substring(0, 5);
    const endT   = (sec.endTime   ?? '').substring(0, 5);
    const [h1, m1] = startT.split(':').map(Number);
    const [h2, m2] = endT.split(':').map(Number);
    const duration = (h2 * 60 + m2) - (h1 * 60 + m1);
    const fill = LEVEL_FILL[sec.academicLevel];

    dataRows.push(new TableRow({
      children: [
        bodyCell(sec.courseCode,    fill),
        bodyCell(sec.courseName,    fill),
        bodyCell(sec.sectionNumber, fill),
        bodyCell(sec.sectionType ?? 'Lec', fill),
        bodyCell(days.sort().join(', '), fill),
        bodyCell(startT, fill),
        bodyCell(endT,   fill),
        bodyCell(`${duration} min`, fill),
        bodyCell(sec.instructorName ?? '', fill),
        bodyCell(sec.venueName      ?? '', fill),
      ],
    }));
  }

  const doc = new Document({
    sections: [{
      properties: { page: { size: { orientation: 'landscape' } } },
      children: [
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: `${semester || 'Schedule'} — Full Semester`, bold: true })],
        }),
        new Table({
          rows: [headerRow, ...dataRows],
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

// ── GRID DOCX (per-day list, not a visual grid) ────────────────────────────────
async function buildGridDocxBuffer(scheduleId, filter, semester) {
  let sections = [];
  let subtitle = '';

  if (filter.type === 'instructor' && filter.id) {
    const [instr, secs] = await Promise.all([
      instrRepo.findById(filter.id),
      sectionRepo.findByInstructor(scheduleId, filter.id),
    ]);
    sections = secs;
    subtitle = instr?.name || 'Instructor';
  } else if (filter.type === 'venue' && filter.id) {
    const venue = await new VenueRepository().findById(filter.id);
    sections = await sectionRepo.findByVenue(scheduleId, filter.id);
    subtitle = venue?.name || 'Venue';
  }

  // Group by day so each weekday becomes its own heading + table.
  const byDay = Object.fromEntries(DAYS.map(d => [d, []]));
  for (const sec of sections) {
    if (!sec.startTime || !sec.endTime) continue;
    byDay[sec.day]?.push(sec);
  }
  for (const d of DAYS) {
    byDay[d].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  }

  const children = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `${semester || 'Schedule'} — ${subtitle}`, bold: true })],
    }),
  ];

  const dayTableHeaders = ['Time', 'Course', '§', 'Instructor', 'Venue'];
  for (const day of DAYS) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: day, bold: true })],
    }));
    if (byDay[day].length === 0) {
      children.push(new Paragraph({
        children: [new TextRun({ text: '(no scheduled sections)', italics: true, color: '888888' })],
      }));
      continue;
    }
    const rows = [new TableRow({ children: dayTableHeaders.map(headerCell), tableHeader: true })];
    for (const sec of byDay[day]) {
      const startT = (sec.startTime ?? '').substring(0, 5);
      const endT   = (sec.endTime   ?? '').substring(0, 5);
      const fill   = LEVEL_FILL[sec.academicLevel];
      rows.push(new TableRow({
        children: [
          bodyCell(`${startT}–${endT}`, fill),
          bodyCell(`${sec.courseCode ?? ''} ${sec.courseName ?? ''}`, fill),
          bodyCell(sec.sectionNumber ?? '', fill),
          bodyCell(sec.instructorName ?? '', fill),
          bodyCell(sec.venueName ?? '', fill),
        ],
      }));
    }
    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
  }

  const doc = new Document({
    sections: [{
      properties: { page: { size: { orientation: 'landscape' } } },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildTableDocxBuffer, buildGridDocxBuffer };
