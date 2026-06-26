/**
 * DocxExportService
 *
 * Generates .docx Word documents using the `docx` library.
 *
 * NEW-FU-657: the public export is the COMBINED document —
 *   buildCombinedDocxBuffer(scheduleId, filter, semester)
 *     → Half A: visual schedule as a per-day section list (scope = filter)
 *     → page break →
 *     → Half B: full-semester section table (every section, 13-col schema)
 * Half B is always the whole term, so the file round-trips into a complete
 * schedule via importBuffer('docx'). buildTableDocxBuffer / buildGridDocxBuffer
 * remain as single-half builders (back-compat + internal reuse).
 *
 * NEW-FU-658: Half A is now a real day×time VISUAL GRID (a docx table with 5-min
 * slot rows and vertical-merged section cells) — identical in structure, colors,
 * time window and lane-splitting to the Excel and PDF grids. (Office hours stay in
 * their own table; the grid shows teaching sections only, like Excel/PDF.)
 */
const {
  Document, Packer, Paragraph, Table, TableRow, TableCell,
  HeadingLevel, TextRun, WidthType, AlignmentType, ShadingType, PageBreak,
  VerticalMergeType, HeightRule, BorderStyle,
} = require('docx');
const SectionRepository    = require('../repositories/SectionRepository');
const InstructorRepository = require('../repositories/InstructorRepository');
const { VenueRepository }  = require('../repositories/repositories');
// NEW-FU-657: gender-aware label (§F-XX) so the Word schedule matches the app.
const { sectionLabel } = require('../domain/sectionLabel');
const labels = require('../domain/exportLabels');   // NEW-FU-666: end-user display labels
const { query } = require('../config/db');
// NEW-FU-660: shared scope helpers — scoped reference sets + scope-tagged heading.
const scope = require('./exportScope');

const sectionRepo = new SectionRepository();
const instrRepo   = new InstructorRepository();

// NEW-FU-660: the scoped section set (instructor / venue / whole-term) so Half B's
// table covers the same sections as Half A's grid.
async function fetchScopedSections(scheduleId, filter = { type: 'full' }) {
  if (filter && filter.type === 'instructor' && filter.id) return sectionRepo.findByInstructor(scheduleId, filter.id);
  if (filter && filter.type === 'venue'      && filter.id) return sectionRepo.findByVenue(scheduleId, filter.id);
  return sectionRepo.findBySchedule(scheduleId);
}

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
// NEW-FU-658: visual-grid model — SAME conventions as the Excel/PDF grids so all
// three look identical (Sun–Thu, 07:00–22:00, 5-min slots, greedy lane-split,
// LEVEL_FILL colors, amber for unresolved soft conflicts).
const G_START_H = 7, G_END_H = 22, G_SLOT_MIN = 5;
const G_TOTAL_SLOTS = ((G_END_H - G_START_H) * 60) / G_SLOT_MIN; // 180
// NEW-FU-677: hard cap on visual-grid lanes per day. The docx grid builds a TableCell tree per
// (slot × lane); a pathological term (hundreds of sections overlapping at one time) produced ~86k
// cell trees and OOM-killed the whole Node process under the 512 MB Render heap (a process-fatal
// crash one export request inflicts on every user). The grid is a HUMAN aid — all sections are in
// the Half-B table regardless — and >~12 concurrent lanes is already unreadable, so clamp overflow
// sections into the last lane rather than grow columns unbounded. Bounds the cell count to ≤ 5×12×180.
const MAX_GRID_LANES = 12;
const SOFT_FILL = 'FFE08A';
const TIME_FILL = 'E8EEF7';
const EMPTY_FILL_A = 'FAFAFA', EMPTY_FILL_B = 'F0F4FA';
function gTimeToSlot(t) {
  if (!t) return 0;
  const [h, m] = t.substring(0, 5).split(':').map(Number);
  return Math.round(((h - G_START_H) * 60 + m) / G_SLOT_MIN);
}
function gSlotToTime(s) {
  const tot = G_START_H * 60 + s * G_SLOT_MIN;
  return `${String(Math.floor(tot / 60)).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`;
}
function gAssignLanes(entries) {
  const sorted = [...entries].sort((a, b) => a.startSlot - b.startSlot);
  const ends = [];
  for (const e of sorted) {
    let placed = false;
    for (let i = 0; i < ends.length; i++) { if (e.startSlot >= ends[i]) { e.lane = i; ends[i] = e.endSlot; placed = true; break; } }
    if (!placed) {
      // NEW-FU-677: cap lanes — beyond MAX_GRID_LANES, clamp overflow sections into the last lane
      // (they overlap visually there) rather than add an unbounded column, so the cell-tree count
      // stays bounded and a pathological term can't OOM-crash the export. (Full data is in the table.)
      if (ends.length >= MAX_GRID_LANES) { e.lane = MAX_GRID_LANES - 1; }
      else { e.lane = ends.length; ends.push(e.endSlot); }
    }
  }
  return ends.length || 1;
}
async function fetchSoftIds(scheduleId) {
  const { ConflictRepository } = require('../repositories/repositories');
  const conf = await new ConflictRepository().findBySchedule(scheduleId);
  return new Set(conf.filter(c => c.isSoft && !c.confirmed).flatMap(c => [c.sectionAId, c.sectionBId].filter(Boolean)));
}

function headerCell(text) {
  return new TableCell({
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: HEADER_FILL },
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 16 })],
    })],
  });
}
function bodyCell(text, fill) {
  return new TableCell({
    shading: fill ? { type: ShadingType.CLEAR, color: 'auto', fill } : undefined,
    children: [new Paragraph({
      children: [new TextRun({ text: String(text ?? ''), size: 15 })],
    })],
  });
}

function groupSections(sections) {
  const groups = new Map();
  for (const sec of sections) {
    const key = `${sec.courseId}|${sec.sectionNumber}|${sec.gender ?? 'M'}`;
    if (!groups.has(key)) groups.set(key, { sec, days: [] });
    groups.get(key).days.push(sec.day);
  }
  return groups;
}

// ── TABLE (Half B) ───────────────────────────────────────────────────────────
// NEW-FU-657: long header names match the Excel/import schema 1:1 (13 columns —
// Academic Level, Category and Gender were previously MISSING) so an exported
// DOCX round-trips through importBuffer('docx') and rebuilds the correct levels,
// categories and genders (those drive R-01/R-02 and R-04/R-05 conflicts).
const TABLE_HEADERS = [
  'Course Code', 'Course Name', 'Academic Level', 'Category', 'Credits', 'Course Type',
  'Section #', 'Section Type', 'Gender', 'Days', 'Start Time', 'End Time',
  'Duration (min)', 'Instructor', 'Venue', 'Venue Type',
];

// NEW-FU-660: `title` carries the scope-tagged heading the Word importer detects.
function tableChildren(scheduleId, semester, groups, title) {
  const headerRow = new TableRow({ children: TABLE_HEADERS.map(headerCell), tableHeader: true });

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
        bodyCell(sec.courseCode,        fill),
        bodyCell(sec.courseName,        fill),
        bodyCell(sec.academicLevel,     fill),
        bodyCell(labels.categoryDisplay(sec.category),          fill),   // NEW-FU-666: end-user labels
        bodyCell(sec.credits ?? '',     fill),
        bodyCell(labels.courseTypeLabel(sec), fill),
        bodyCell(sec.sectionNumber,     fill),
        bodyCell(labels.sectionTypeDisplay(sec.sectionType ?? 'Lec'), fill),
        bodyCell(labels.genderDisplay(sec.gender === 'F' ? 'F' : 'M'), fill),
        bodyCell(days.sort().join(', '), fill),
        bodyCell(startT, fill),
        bodyCell(endT,   fill),
        bodyCell(`${duration} min`, fill),
        bodyCell(sec.instructorName ?? '', fill),
        bodyCell(sec.venueName      ?? '', fill),
        bodyCell(labels.venueTypeDisplay(sec.venueType), fill),
      ],
    }));
  }

  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: title || `${semester || 'Schedule'} — Full Semester (all sections)`, bold: true })],
    }),
    new Table({
      rows: [headerRow, ...dataRows],
      width: { size: 100, type: WidthType.PERCENTAGE },
    }),
  ];
}

async function buildTableDocxBuffer(scheduleId, semester) {
  const sections = await sectionRepo.findBySchedule(scheduleId);
  const groups   = groupSections(sections);
  const doc = new Document({
    sections: [{
      properties: { page: { size: { orientation: 'landscape' } } },
      children: tableChildren(scheduleId, semester, groups),
    }],
  });
  return Packer.toBuffer(doc);
}

// ── GRID (Half A — per-day list) ─────────────────────────────────────────────
async function fetchGridSections(scheduleId, filter) {
  if (filter.type === 'instructor' && filter.id) {
    const [instr, secs] = await Promise.all([
      instrRepo.findById(filter.id),
      sectionRepo.findByInstructor(scheduleId, filter.id),
    ]);
    return { sections: secs, subtitle: instr?.name || 'Instructor' };
  }
  if (filter.type === 'venue' && filter.id) {
    const venue = await new VenueRepository().findById(filter.id);
    const secs  = await sectionRepo.findByVenue(scheduleId, filter.id);
    return { sections: secs, subtitle: venue?.name || 'Venue' };
  }
  // NEW-FU-657: whole-term schedule — every section, grouped per day.
  const secs = await sectionRepo.findBySchedule(scheduleId);
  return { sections: secs, subtitle: 'Full Schedule' };
}

// NEW-FU-658: a real day×time visual grid (docx table) — same model as Excel/PDF:
// 5-min slot rows (07:00–22:00), days Sun–Thu, greedy lane-split for overlaps,
// section blocks as vertical-merged colored cells (level color, amber for soft).
function gridChildren(sections, subtitle, semester, softIds = new Set()) {
  const perDay = {};
  for (const day of DAYS) perDay[day] = [];
  for (const sec of sections) {
    if (!sec.startTime || !sec.endTime) continue;
    const ss = gTimeToSlot(sec.startTime), es = gTimeToSlot(sec.endTime);
    if (ss >= es) continue;
    perDay[sec.day]?.push({ sec, startSlot: ss, endSlot: es, lane: 0 });
  }
  const lanes = {};
  for (const day of DAYS) lanes[day] = gAssignLanes(perDay[day]);

  // occupancy[day][lane][slot] = {type:'start', sec} | {type:'cont'} | undefined
  const occ = {};
  for (const day of DAYS) {
    occ[day] = Array.from({ length: lanes[day] }, () => ({}));
    for (const b of perDay[day]) {
      occ[day][b.lane][b.startSlot] = { type: 'start', sec: b.sec };
      for (let s = b.startSlot + 1; s < b.endSlot; s++) occ[day][b.lane][s] = { type: 'cont' };
    }
  }

  const totalCols = 1 + DAYS.reduce((s, d) => s + lanes[d], 0);
  const timeW = 760;
  const laneW = Math.max(620, Math.floor((14000 - timeW) / Math.max(1, totalCols - 1)));
  const colWidths = [timeW, ...Array(totalCols - 1).fill(laneW)];

  const tb = { style: BorderStyle.SINGLE, size: 2, color: 'D0D8E8' };
  const borders = { top: tb, bottom: tb, left: tb, right: tb };
  const blank = () => new Paragraph({ children: [new TextRun({ text: '', size: 2 })] });

  // Header row
  const headerCells = [new TableCell({
    width: { size: timeW, type: WidthType.DXA }, borders,
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: HEADER_FILL },
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Time', bold: true, color: 'FFFFFF', size: 14 })] })],
  })];
  for (const day of DAYS) {
    headerCells.push(new TableCell({
      columnSpan: lanes[day], borders,
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: HEADER_FILL },
      children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: day, bold: true, color: 'FFFFFF', size: 14 })] })],
    }));
  }
  const rows = [new TableRow({ tableHeader: true, children: headerCells, height: { value: 240, rule: HeightRule.ATLEAST } })];

  for (let slot = 0; slot < G_TOTAL_SLOTS; slot++) {
    const isHour = slot % 12 === 0;
    const cells = [new TableCell({
      width: { size: timeW, type: WidthType.DXA }, borders,
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: TIME_FILL },
      children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [isHour ? new TextRun({ text: gSlotToTime(slot), bold: true, color: '1F4E79', size: 12 }) : new TextRun({ text: '', size: 2 })] })],
    })];
    for (const day of DAYS) {
      for (let lane = 0; lane < lanes[day]; lane++) {
        const o = occ[day][lane][slot];
        if (o && o.type === 'start') {
          const sec = o.sec;
          const fill = softIds.has(sec.id) ? SOFT_FILL : (LEVEL_FILL[sec.academicLevel] || 'E8F4FD');
          const lines = [
            `${sec.courseCode ?? ''} ${sectionLabel(sec)} · ${labels.sectionTypeShort(sec.sectionType)}`,   // NEW-FU-666: Lec/Lab flag
            `${(sec.startTime ?? '').substring(0, 5)}–${(sec.endTime ?? '').substring(0, 5)}`,
            sec.instructorName ?? '',
            sec.venueName ?? '',
          ].filter(Boolean);
          cells.push(new TableCell({
            verticalMerge: VerticalMergeType.RESTART, borders,
            shading: { type: ShadingType.CLEAR, color: 'auto', fill },
            children: lines.map(t => new Paragraph({ children: [new TextRun({ text: t, size: 11 })] })),
          }));
        } else if (o && o.type === 'cont') {
          cells.push(new TableCell({ verticalMerge: VerticalMergeType.CONTINUE, borders, children: [blank()] }));
        } else {
          cells.push(new TableCell({
            borders,
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: slot % 2 === 0 ? EMPTY_FILL_A : EMPTY_FILL_B },
            children: [blank()],
          }));
        }
      }
    }
    rows.push(new TableRow({ children: cells, height: { value: 90, rule: HeightRule.EXACT } }));
  }

  return [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `${semester || 'Schedule'} — ${subtitle}`, bold: true })] }),
    new Table({ columnWidths: colWidths, rows, width: { size: 100, type: WidthType.PERCENTAGE } }),
  ];
}

async function buildGridDocxBuffer(scheduleId, filter, semester) {
  const [{ sections, subtitle }, softIds] = await Promise.all([
    fetchGridSections(scheduleId, filter),
    fetchSoftIds(scheduleId),
  ]);
  const doc = new Document({
    sections: [{
      properties: { page: { size: { orientation: 'landscape' } } },
      children: gridChildren(sections, subtitle, semester, softIds),
    }],
  });
  return Packer.toBuffer(doc);
}

// ── OFFICE HOURS (reference data, carried so re-import has no R-13) ───────────────
// NEW-FU-657: OH header lacks Course Code / Days, so the import's section-table
// finder skips it; a dedicated OH finder picks it up.
// NEW-FU-660: OH / instructor / venue reference sets are fetched SCOPED via the shared
// exportScope helpers, so a scoped Word doc carries only that entity's reference data.
function officeHoursChildren(ohRows, semester) {
  const headers = ['Instructor', 'Day', 'Start Time', 'End Time'];
  const rows = [new TableRow({ children: headers.map(headerCell), tableHeader: true })];
  for (const oh of ohRows) {
    rows.push(new TableRow({
      children: [
        bodyCell(oh.instructor_name ?? ''),
        bodyCell(oh.day ?? ''),
        bodyCell((oh.start_time ?? '').substring(0, 5)),
        bodyCell((oh.end_time ?? '').substring(0, 5)),
      ],
    }));
  }
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `${semester || 'Schedule'} — Office Hours`, bold: true })],
    }),
    new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }),
  ];
}

// ── REFERENCE DATA (Instructors + Venues) — NEW-FU-657b ──────────────────────────
function instructorsChildren(rows, semester, scopeName) {
  const tr = [new TableRow({ children: ['Instructor', 'Email'].map(headerCell), tableHeader: true })];
  for (const i of rows) tr.push(new TableRow({ children: [bodyCell(i.name ?? ''), bodyCell(i.email ?? '')] }));
  // NEW-FU-666: SINGULAR heading in a single-instructor file ("Instructor", not "Instructors").
  const heading = scopeName === 'instructor' ? 'Instructor' : 'Instructors';
  return [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `${semester || 'Schedule'} — ${heading}`, bold: true })] }),
    new Table({ rows: tr, width: { size: 100, type: WidthType.PERCENTAGE } }),
  ];
}
function venuesChildren(rows, semester, scopeName) {
  const tr = [new TableRow({ children: ['Venue', 'Venue Type', 'Capacity'].map(headerCell), tableHeader: true })];
  for (const v of rows) tr.push(new TableRow({ children: [bodyCell(v.name ?? ''), bodyCell(labels.venueTypeDisplay(v.type)), bodyCell(String(v.capacity ?? ''))] }));
  // NEW-FU-666: SINGULAR heading in a single-venue file ("Venue", not "Venues").
  const heading = scopeName === 'venue' ? 'Venue' : 'Venues';
  return [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `${semester || 'Schedule'} — ${heading}`, bold: true })] }),
    new Table({ rows: tr, width: { size: 100, type: WidthType.PERCENTAGE } }),
  ];
}

// ── COMBINED (schedule + table + office hours + instructors + venues) ──────────────
async function buildCombinedDocxBuffer(scheduleId, filter = { type: 'full' }, semester) {
  // NEW-FU-660: every half is scoped to the same filter — the table reads the SCOPED
  // section set (not the whole term), and OH / instructor / venue reference data is
  // scoped too. The table heading is scope-tagged so the Word importer detects merge
  // (instructor/venue) vs replace (full).
  const scopeName = scope.scopeOf(filter);
  const entity    = await scope.fetchScopeEntity(filter);
  const tableTitle = scope.tableTitle(semester, scopeName, entity);
  const [{ sections, subtitle }, scopedSections, ohRows, instrRows, venueRows, softIds] = await Promise.all([
    fetchGridSections(scheduleId, filter),
    fetchScopedSections(scheduleId, filter),
    scope.fetchOfficeHours(scheduleId, filter),
    scope.fetchInstructorsRef(scheduleId, filter),
    scope.fetchVenuesRef(scheduleId, filter),
    fetchSoftIds(scheduleId),
  ]);
  const groups = groupSections(scopedSections);

  // NEW-FU-667: a VENUE file also carries the venue's instructors + their office hours; explain
  // why (once, just before those sections) so the user doesn't read it as an error/afterthought.
  const venueNote = (scopeName === 'venue' && (ohRows.length || instrRows.length))
    ? [new Paragraph({ children: [new PageBreak()] }),
       new Paragraph({ children: [new TextRun({ text: scope.VENUE_EXPORT_NOTE, italics: true, color: '555555', size: 18 })] })]
    : [];
  const children = [
    ...gridChildren(sections, subtitle, semester, softIds),
    // Page break so Half B (the importable table) starts on its own page.
    new Paragraph({ children: [new PageBreak()] }),
    ...tableChildren(scheduleId, semester, groups, tableTitle),
    ...venueNote,
    ...(ohRows.length ? [new Paragraph({ children: [new PageBreak()] }), ...officeHoursChildren(ohRows, semester)] : []),
    ...(instrRows.length ? [new Paragraph({ children: [new PageBreak()] }), ...instructorsChildren(instrRows, semester, scopeName)] : []),
    ...(venueRows.length ? [new Paragraph({ children: [new PageBreak()] }), ...venuesChildren(venueRows, semester, scopeName)] : []),
  ];

  const doc = new Document({
    sections: [{
      properties: { page: { size: { orientation: 'landscape' } } },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildTableDocxBuffer, buildGridDocxBuffer, buildCombinedDocxBuffer, gAssignLanes, MAX_GRID_LANES };
