/**
 * DocxExportService
 *
 * Generates .docx Word documents using the `docx` library.
 *
 * NEW-FU-657: the public export is the COMBINED document —
 *   buildCombinedDocxBuffer(scheduleId, filter, semester)
 *     → Half A: visual schedule as a per-day section list (focused scope = filter)
 *     → page break →
 *     → Half B: scoped section table plus required reference tables
 * Whole-term files carry every section. Instructor/venue files carry the selected
 * entity plus required complementary Lec/Lab rows and references so scoped files
 * can be re-imported safely. buildTableDocxBuffer / buildGridDocxBuffer remain as
 * single-half builders (back-compat + internal reuse).
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
  // NEW-FU-682: also carry the complementary half of each has_lab course (flagged isComplement).
  return sectionRepo.findScopedWithComplement(scheduleId, filter);
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
// NEW-FU-682: rose fill for a CARRIED COMPLEMENT section (a lab course's other half) — same hue used by
// the PDF/Excel exports, distinct from every level fill and the amber soft fill.
const COMPLEMENT_FILL = 'F3CCDD';
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
function tableChildren(scheduleId, semester, groups, title, { complementOnly = false } = {}) {
  // NEW-FU-687 (Part B): `complementOnly` splits the rows — the ASSIGNED table (false) shows the entity's
  // own sections; a separate CARRIED table (true) shows the reference-only complementary halves with a red
  // note. The carried table no longer needs a tag COLUMN (the whole table IS the carried set), so headers
  // stay the standard set on both — keeping the Word importer's header→cell zip lossless for round-trip.
  const headerRow = new TableRow({ children: TABLE_HEADERS.map(headerCell), tableHeader: true });

  const dataRows = [];
  for (const [, { sec, days }] of groups) {
    if (Boolean(sec.isComplement) !== complementOnly) continue;   // assigned-only OR carried-only
    const startT = (sec.startTime ?? '').substring(0, 5);
    const endT   = (sec.endTime   ?? '').substring(0, 5);
    const [h1, m1] = startT.split(':').map(Number);
    const [h2, m2] = endT.split(':').map(Number);
    // NEW-FU-688: an untimed conflict-exempt activity (Project / info-only) has blank times — render a
    // blank duration instead of "NaN min".
    const durationText = (startT && endT) ? `${(h2 * 60 + m2) - (h1 * 60 + m1)} min` : '';
    const fill = complementOnly ? COMPLEMENT_FILL : LEVEL_FILL[sec.academicLevel];

    dataRows.push(new TableRow({
      children: [
        bodyCell(sec.courseCode,        fill),
        bodyCell(sec.courseName,        fill),
        bodyCell(sec.academicLevel,     fill),
        bodyCell(labels.categoryDisplay(sec.category),          fill),   // NEW-FU-666: end-user labels
        bodyCell(sec.credits ?? '',     fill),
        bodyCell(labels.courseTypeLabel(sec), fill),                     // NEW-FU-687: Project/Thesis
        bodyCell(sec.sectionNumber,     fill),
        bodyCell(labels.sectionTypeDisplay(labels.effectiveSectionType(sec, { season: semester })), fill),  // NEW-FU-687/688: Lec→Prj/Ths + ST/INT by season
        bodyCell(labels.genderDisplay(sec.gender === 'F' ? 'F' : 'M'), fill),
        bodyCell(days.sort().join(', '), fill),
        bodyCell(startT, fill),
        bodyCell(endT,   fill),
        bodyCell(durationText, fill),
        bodyCell(sec.instructorName ?? '', fill),
        bodyCell(sec.venueName      ?? '', fill),
        bodyCell(labels.venueTypeDisplay(sec.venueType), fill),
      ],
    }));
  }

  return [
    new Paragraph({
      heading: complementOnly ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1,
      children: [new TextRun({ text: title || `${semester || 'Schedule'} — Full Semester (all sections)`, bold: true,
        ...(complementOnly ? { color: 'C2185B' } : {}) })],
    }),
    // NEW-FU-687 (Part B): the red carried-table note, immediately under the carried heading (this Word
    // table can't repeat a per-page banner, but a docx table header row repeats across page breaks, and the
    // note sits with the table it describes — satisfying "the carried table is always clearly marked").
    ...(complementOnly ? [new Paragraph({ children: [new TextRun({
      text: scope.COMPLEMENT_EXPORT_NOTE, italics: true, color: 'C2185B', size: 16 })] })] : []),
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
  // NEW-FU-682: the grid carries the complementary half of each has_lab course too (flagged isComplement).
  if (filter.type === 'instructor' && filter.id) {
    const [instr, secs] = await Promise.all([
      instrRepo.findById(filter.id),
      sectionRepo.findScopedWithComplement(scheduleId, filter),
    ]);
    return { sections: secs, subtitle: instr?.name || 'Instructor' };
  }
  if (filter.type === 'venue' && filter.id) {
    const venue = await new VenueRepository().findById(filter.id);
    const secs  = await sectionRepo.findScopedWithComplement(scheduleId, filter);
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
    if (sec.isComplement) continue;   // NEW-FU-687 (Part A): carried halves never appear in the grid
    if (labels.isInfoOnlyCourse(sec)) continue;   // NEW-FU-688: info-only (external/thesis/research) never in the grid
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
          // NEW-FU-682: a carried complement card is rose-filled with a leading "Carried" tag line.
          const isComp = sec.isComplement;
          const fill = softIds.has(sec.id) ? SOFT_FILL : isComp ? COMPLEMENT_FILL : (LEVEL_FILL[sec.academicLevel] || 'E8F4FD');
          const lines = [
            ...(isComp ? [scope.COMPLEMENT_TAG_SHORT] : []),
            `${sec.courseCode ?? ''} ${sectionLabel(sec)} · ${labels.sectionTypeShort(labels.effectiveSectionType(sec))}`,   // NEW-FU-666/687: Lec/Lab/Prj/Ths flag (derived)
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
// exportScope helpers, so a scoped Word doc carries the selected entity's reference
// data plus any complementary references required for a valid re-import.
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
// NEW-FU-680: a small legend below the table defining Course Type / Section Type (and that they are
// independent — a Capstone course can have Lecture sections). Same content in PDF/Word/Excel, all scopes.
function typeLegendChildren() {
  const line = (text, bold) => new Paragraph({
    children: [new TextRun({ text, italics: !bold, bold: !!bold, size: bold ? 16 : 15, color: bold ? '1F4E79' : '444444' })],
    spacing: { after: 40 },
  });
  return [line(labels.TYPE_LEGEND_TITLE, true), ...labels.typeLegendLines().map((l) => line(l, false))];
}

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

  // NEW-FU-667/FU-679: a VENUE file also carries the venue's instructors + their office hours;
  // explain why on the SAME page as (directly above) the Office Hours it accompanies — matching the
  // PDF — so the reader sees the note WHILE reading the office hours. (Was its own block split off by
  // a page break onto a separate page from the OH, so it read as a disconnected afterthought.)
  const venueNotePara = () => new Paragraph({
    children: [new TextRun({ text: scope.VENUE_EXPORT_NOTE, italics: true, color: '555555', size: 18 })],
    spacing: { after: 200 },
  });
  const wantNote    = scopeName === 'venue' && (ohRows.length || instrRows.length);
  const noteOnOH    = wantNote && ohRows.length > 0;   // ride with the Office Hours when present…
  const noteOnInstr = wantNote && !ohRows.length;      // …else with the Instructors page
  const children = [
    ...gridChildren(sections, subtitle, semester, softIds),
    // Page break so Half B (the importable table) starts on its own page.
    new Paragraph({ children: [new PageBreak()] }),
    ...tableChildren(scheduleId, semester, groups, tableTitle),   // NEW-FU-687 (Part B): ASSIGNED sections only
    ...typeLegendChildren(),   // NEW-FU-680/687 (Part D): Course Type / Section Type definitions, on the SAME page directly below the table
    // NEW-FU-687 (Part B): the carried complementary halves go in their OWN table (on a fresh page), with a
    // red heading + red note — never mixed with the assigned table, so a carried section's instructor/venue
    // is never mistaken for the assigned entity's own.
    ...(scopedSections.some(s => s.isComplement)
      ? [new Paragraph({ children: [new PageBreak()] }),
         ...tableChildren(scheduleId, semester, groups, scope.COMPLEMENT_EXPORT_TITLE, { complementOnly: true })]
      : []),
    ...(ohRows.length ? [new Paragraph({ children: [new PageBreak()] }), ...(noteOnOH ? [venueNotePara()] : []), ...officeHoursChildren(ohRows, semester)] : []),
    ...(instrRows.length ? [new Paragraph({ children: [new PageBreak()] }), ...(noteOnInstr ? [venueNotePara()] : []), ...instructorsChildren(instrRows, semester, scopeName)] : []),
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
