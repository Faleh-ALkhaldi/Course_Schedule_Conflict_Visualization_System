/**
 * ExportService
 *
 * Two export modes:
 *   type='table'  → simple tabular rows (one row per logical section group)
 *   type='grid'   → visual weekly grid with colored merged cells
 *
 * Import: reads the table format and creates sections.
 */
const ExcelJS = require('exceljs');
const SectionRepository    = require('../repositories/SectionRepository');
const InstructorRepository = require('../repositories/InstructorRepository');
const { ConflictRepository, CourseRepository, VenueRepository } = require('../repositories/repositories');
const { getClient, query } = require('../config/db');
// NEW-FU-282 (Phase 56): shared label helper so exported Excel / CSV /
// PDF render female sections as "§F-XX" rather than "§XX".
const { sectionLabel } = require('../domain/sectionLabel');
const labels = require('../domain/exportLabels');   // NEW-FU-666: end-user display labels
// NEW-FU-21: reuse the canonical lock-and-status-check from ScheduleService
// so importFromExcel respects the same finalize-immutability contract that
// every other section-writing path (assignSection/createSection/deleteSection
// /updateSectionInfo/suggest) enforces.
const schedSvc = require('./ScheduleService');
// NEW-FU-660: shared scope helpers — an instructor/venue export carries ONLY that
// entity's data (sections + its OH + the venues/instructors it touches), and the
// file is stamped with a scope the importer reads.
const scope = require('./exportScope');
// NEW-FU-662: parse-layer safety caps (sheet/row counts) — a file that passed the
// pre-parse zip gate but is still abnormally large is rejected before we iterate it.
const { assertSheetCount, assertRowCount } = require('../domain/uploadSafety');

// NEW-FU-660: the scoped section set, as the repository's Section domain objects the
// table/grid renderers consume. Mirrors addScheduleSheet's inline branching so Half B
// (the section table) covers the SAME sections as Half A (the grid) — instructor- or
// venue-only, not the whole term.
async function fetchScopedSections(scheduleId, filter = { type: 'full' }) {
  if (filter && filter.type === 'instructor' && filter.id) return sectionRepo.findByInstructor(scheduleId, filter.id);
  if (filter && filter.type === 'venue'      && filter.id) return sectionRepo.findByVenue(scheduleId, filter.id);
  return sectionRepo.findBySchedule(scheduleId);
}

const sectionRepo  = new SectionRepository();
const instrRepo    = new InstructorRepository();
const conflictRepo = new ConflictRepository();

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday'];

// ── Colors ─────────────────────────────────────────────────────────────────────
const LEVEL_COLORS = {
  Freshman:  'FFDAEEF3', Sophomore: 'FFE2EFDA',
  Junior:    'FFFFF2CC', Senior:    'FFE8E0F5',
  Graduate:  'FFEADDC1',
};
const SOFT_COLOR   = 'FFFFE08A';
const OH_COLOR     = 'FFD9D9D9';
const HEADER_COLOR = 'FF1F4E79';
const TIME_BG      = 'FFE8EEF7';

const SLOT_MIN  = 5;
const START_H   = 7;
const END_H     = 22;
const TOTAL_SLOTS = ((END_H - START_H) * 60) / SLOT_MIN;
const ROW_H_PT  = 11;

function timeToSlot(t) {
  if (!t) return 0;
  const [h,m] = t.substring(0,5).split(':').map(Number);
  return Math.round(((h-START_H)*60+m)/SLOT_MIN);
}
function slotToTime(slot) {
  const tot = START_H*60+slot*SLOT_MIN;
  return `${String(Math.floor(tot/60)).padStart(2,'0')}:${String(tot%60).padStart(2,'0')}`;
}
function thin(color='FFD0D8E8') {
  const s={style:'thin',color:{argb:color}};
  return {top:s,bottom:s,left:s,right:s};
}
function safeMerge(ws,r1,c1,r2,c2) {
  if (r2<r1||c2<c1) return;
  try { ws.mergeCells(r1,c1,r2,c2); } catch(e){}
}
function assignColumns(entries) {
  const sorted=[...entries].sort((a,b)=>a.startSlot-b.startSlot);
  const colEnds=[];
  for (const entry of sorted) {
    let placed=false;
    for (let ci=0;ci<colEnds.length;ci++) {
      if (entry.startSlot>=colEnds[ci]) { entry.colIdx=ci; colEnds[ci]=entry.endSlot; placed=true; break; }
    }
    if (!placed) { entry.colIdx=colEnds.length; colEnds.push(entry.endSlot); }
  }
  return colEnds.length||1;
}

// NEW-C1: prevent CSV/XLSX formula injection. A user-controlled value that
// starts with `=`, `+`, `-`, `@`, tab, or CR will be interpreted as a formula
// by Excel/Sheets/Numbers when the file is opened. Prefixing with a single
// quote forces literal-string interpretation. Only applied to strings — numeric
// columns (duration etc.) flow through untouched.
function safeCell(v) {
  if (typeof v !== 'string' || v.length === 0) return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

// NEW-FU-79: produce a string safe to use as either an Excel sheet name OR
// the filename half of a Content-Disposition header. Excel forbids `/ \ ? *
// [ ] :` in sheet names and a name can't start with a single quote. HTTP
// Content-Disposition is sensitive to `"` and CR/LF (Node sanitizes CR/LF
// but a stray quote produces malformed headers some browsers handle poorly).
// We strip the dangerous set to '-' and trim any leading/trailing dashes or
// quotes the result might still carry. Empty result falls back to a sane
// default chosen by the caller.
function safeFilenamePart(s) {
  if (typeof s !== 'string') return '';
  // NEW-FU-79 + NEW-FU-90: strip Excel-forbidden chars AND HTTP-troublesome
  // chars. The added `;` and `=` (FU-90) are Content-Disposition parameter
  // separators — currently `safeFilenamePart` is only fed by `semester`
  // (FU-74 already gates this charset at create-time) and instructor/venue
  // names (looser FU-46 length-only validator), so defence-in-depth here
  // means a future endpoint that pipes one of those names into a header
  // can't produce a malformed Content-Disposition.
  return s
    .replace(/[\\/?*[\]:"<>|;=\r\n\t]/g, '-')
    .replace(/^['\-\s]+|['\-\s]+$/g, '')
    .trim();
}

// NEW-H1: exceljs returns time cells as Date objects (or numbers for raw
// fractional-day values). Coercing those via .toString() yields "1899-12-31..."
// which then parses to 0 minutes and silently collapses every section to 00:00.
// Normalize to "HH:MM" here so the import path stays string-only downstream.
function cellToTimeString(value) {
  if (value == null) return '';
  if (value instanceof Date) {
    const h = value.getUTCHours();
    const m = value.getUTCMinutes();
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  if (typeof value === 'number') {
    // Excel stores times as fraction of a day (0.5 = 12:00). Round to nearest minute.
    const totalMin = Math.round(value * 24 * 60);
    const h = (Math.floor(totalMin / 60) % 24 + 24) % 24;
    const m = ((totalMin % 60) + 60) % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  return String(value).trim().substring(0, 5);
}

// ── TABLE EXPORT (Half B) ─────────────────────────────────────────────────────
// NEW-FU-657: the section table is written into a CALLER-SUPPLIED workbook so it can
// ride alongside the visual "Schedule" grid sheet in one combined file.
// NEW-FU-660: the table is now SCOPED to the same filter as the grid — an instructor
// or venue export lists ONLY that entity's sections, not the whole term. buildTable-
// Workbook (back-compat) passes no filter → defaults to the whole term.
async function addSectionsSheet(wb, scheduleId, filter = { type: 'full' }) {
  const sections = await fetchScopedSections(scheduleId, filter);

  // Group by courseId+sectionNumber+gender (logical section). Gender is part of the
  // identity: the UNIQUE constraint is (schedule,course,section_number,day,gender), so a
  // male §01 and a female §01 of one course legally coexist and must NOT collapse into
  // one exported row (that silently dropped a section on xlsx round-trip).
  const groups = new Map();
  for (const sec of sections) {
    const key = `${sec.courseId}|${sec.sectionNumber}|${sec.gender ?? 'M'}`;
    if (!groups.has(key)) {
      groups.set(key, { sec, days: [] });
    }
    groups.get(key).days.push(sec.day);
  }

  const ws = wb.addWorksheet('Sections');

  // Column definitions
  // NEW-FU-100: Section Type column ('Lec' or 'Lab') so the export round-
  // trips the new attribute. Placed right after Section # so the section's
  // identity columns stay grouped.
  const cols = [
    { header:'Course Code',    key:'courseCode',    width:14 },
    { header:'Course Name',    key:'courseName',    width:28 },
    { header:'Academic Level', key:'academicLevel', width:16 },
    { header:'Category',       key:'category',      width:10 },
    // NEW-FU-657: Credits round-trips so re-import validates section patterns and
    // R-15 against the REAL credit value (0/1/2/4-credit courses were failing the
    // 3-credit-default pattern check). The importer already reads this column.
    { header:'Credits',        key:'credits',       width:9  },
    // NEW-FU-657: course-level type (Capstone / External / Has Lab / Standard).
    // Capstone + External are NOT derivable from sections yet drive the venue
    // rules (R-05/R-10/R-11/R-12), so without this column they'd re-import as
    // Standard and change the conflict result. Mutually exclusive (courseFlagError).
    { header:'Course Type',    key:'courseType',    width:13 },
    { header:'Section #',      key:'sectionNumber', width:10 },
    { header:'Section Type',   key:'sectionType',   width:12 },   // NEW-FU-100
    // NEW-FU-502 (Phase 123): Gender column so the F-section flag round-trips.
    // Without it, §F-55 exported as a bare "55" and re-imported as male — and
    // because the sections UNIQUE key includes gender, an M/F pair sharing a
    // number+day collapsed to one row on import (second insert silently hit
    // ON CONFLICT DO NOTHING). Same additive pattern as FU-100's Section Type.
    { header:'Gender',         key:'gender',        width:9  },   // NEW-FU-502
    { header:'Days',           key:'days',          width:28 },
    { header:'Start Time',     key:'startTime',     width:12 },
    { header:'End Time',       key:'endTime',       width:12 },
    { header:'Duration (min)', key:'duration',      width:14 },
    { header:'Instructor',     key:'instructor',    width:22 },
    { header:'Venue',          key:'venue',         width:14 },
    // NEW-FU-657: venue type round-trips (Laboratory / LectureHall / Multipurpose)
    // so re-import re-creates the venue with the right type — without it a lab venue
    // came back as a LectureHall and fired R-11/R-12.
    { header:'Venue Type',     key:'venueType',     width:14 },
  ];

  ws.columns = cols;

  // Header row styling
  const hdr = ws.getRow(1);
  hdr.height = 22;
  hdr.eachCell(cell => {
    cell.fill   = { type:'pattern', pattern:'solid', fgColor:{ argb: HEADER_COLOR } };
    cell.font   = { bold:true, color:{ argb:'FFFFFFFF' }, size:10 };
    cell.alignment = { vertical:'middle', horizontal:'center' };
    cell.border = thin('FF1F4E79');
  });

  // Data rows
  let rowNum = 2;
  for (const [, { sec, days }] of groups) {
    const startT   = (sec.startTime ?? '').substring(0,5);
    const endT     = (sec.endTime   ?? '').substring(0,5);
    const [h1,m1]  = startT.split(':').map(Number);
    const [h2,m2]  = endT.split(':').map(Number);
    const duration = (h2*60+m2) - (h1*60+m1);
    const level    = sec.academicLevel ?? '';
    const argb     = LEVEL_COLORS[level] ?? 'FFFFFFFF';

    const row = ws.getRow(rowNum++);
    row.height = 18;
    // NEW-C1: every user-supplied string flows through safeCell() to neutralise
    // formula-injection payloads in course names, instructor names, etc.
    row.getCell('courseCode').value    = safeCell(sec.courseCode     ?? '');
    row.getCell('courseName').value    = safeCell(sec.courseName     ?? '');
    row.getCell('academicLevel').value = level;
    // NEW-FU-666: emit END-USER labels, never the stored codes (UG/GR, Lec, LectureHall, M/F).
    row.getCell('category').value      = labels.categoryDisplay(sec.category);
    row.getCell('credits').value       = sec.credits ?? '';                       // NEW-FU-657
    row.getCell('courseType').value    = labels.courseTypeLabel(sec);             // NEW-FU-657
    row.getCell('sectionNumber').value = safeCell(sec.sectionNumber  ?? '');
    row.getCell('sectionType').value   = labels.sectionTypeDisplay(sec.sectionType ?? 'Lec'); // NEW-FU-100
    row.getCell('gender').value        = labels.genderDisplay(sec.gender === 'F' ? 'F' : 'M'); // NEW-FU-502
    row.getCell('days').value          = days.sort().join(', ');
    row.getCell('startTime').value     = startT;
    row.getCell('endTime').value       = endT;
    row.getCell('duration').value      = duration;
    row.getCell('instructor').value    = safeCell(sec.instructorName ?? '');
    row.getCell('venue').value         = safeCell(sec.venueName      ?? '');
    row.getCell('venueType').value     = labels.venueTypeDisplay(sec.venueType);  // NEW-FU-657

    row.eachCell(cell => {
      cell.fill   = { type:'pattern', pattern:'solid', fgColor:{ argb } };
      cell.font   = { size:9 };
      cell.alignment = { vertical:'middle', horizontal:'left' };
      cell.border = thin();
    });
  }

  // Auto-filter on header. NEW-FU-100 (Section Type), NEW-FU-502 (Gender),
  // NEW-FU-657 (Credits + Course Type + Venue Type) → now 16 columns, A..P.
  ws.autoFilter = { from:'A1', to:`P1` };
  return ws;
}

async function buildTableWorkbook(scheduleId, semester) {
  const wb = new ExcelJS.Workbook();
  await addSectionsSheet(wb, scheduleId);
  return wb;
}

// ── GRID EXPORT / Half A (whole-term, instructor, or venue) ──────────────────────
// NEW-FU-657: now also handles filter.type==='full' (the whole-term grid — every
// section, lane-split for overlaps via assignColumns) so the combined export's
// schedule half exists for the full semester, not only the filtered views. Writes
// into a caller-supplied workbook; buildGridWorkbook stays a back-compat wrapper.
async function addScheduleSheet(wb, scheduleId, filter, semester) {
  let sections=[], officeHours=[], sheetName=semester||'Schedule';

  if (filter.type==='instructor' && filter.id) {
    const [instr,ohs,secs]=await Promise.all([
      instrRepo.findById(filter.id),
      instrRepo.getOfficeHours(filter.id),
      sectionRepo.findByInstructor(scheduleId,filter.id),
    ]);
    sections=secs; officeHours=ohs;
    // NEW-C1 + NEW-FU-79: sheet name is user-visible AND must satisfy Excel's
    // forbidden-char rules. safeCell handles formula injection in cell values;
    // safeFilenamePart strips `/ \ ? * [ ] : " < > | etc.` that would make
    // exceljs throw at write time.
    sheetName=`${safeFilenamePart(semester) || 'Schedule'} – ${safeFilenamePart(instr?.name) || 'Instructor'}`;
  } else if (filter.type==='venue' && filter.id) {
    const {VenueRepository}=require('../repositories/repositories');
    const venue=await new VenueRepository().findById(filter.id);
    sections=await sectionRepo.findByVenue(scheduleId,filter.id);
    sheetName=`${safeFilenamePart(semester) || 'Schedule'} – ${safeFilenamePart(venue?.name) || 'Venue'}`;
  } else {
    // NEW-FU-657: whole-term schedule grid (every section in the schedule). No
    // office hours (those are instructor-scoped). assignColumns lane-splits the
    // inevitable same-day overlaps so nothing draws on top of anything else.
    sections = await sectionRepo.findBySchedule(scheduleId);
    sheetName = `${safeFilenamePart(semester) || 'Term'} – Schedule`;
  }

  const allConflicts = await conflictRepo.findBySchedule(scheduleId);
  // M-2: Amber highlight should mark *unresolved* soft conflicts — not confirmed ones.
  const softIds = new Set(
    allConflicts.filter(c => c.isSoft && !c.confirmed)
      .flatMap(c => [c.sectionAId, c.sectionBId].filter(Boolean))
  );

  const daySecEntries={};
  const dayOhEntries={};
  for (const day of DAYS) { daySecEntries[day]=[]; dayOhEntries[day]=[]; }

  for (const sec of sections) {
    if (!sec.startTime||!sec.endTime) continue;
    const ss=timeToSlot(sec.startTime),es=timeToSlot(sec.endTime);
    if (ss>=es) continue;
    daySecEntries[sec.day]?.push({sec,startSlot:ss,endSlot:es,colIdx:0});
  }
  for (const oh of officeHours) {
    const st=oh.start_time??oh.startTime,et=oh.end_time??oh.endTime;
    if (!st||!et) continue;
    const ss=timeToSlot(st),es=timeToSlot(et);
    if (ss>=es) continue;
    dayOhEntries[oh.day]?.push({oh,startSlot:ss,endSlot:es,colIdx:0});
  }

  const subCols={};
  for (const day of DAYS) {
    const all=[...daySecEntries[day],...dayOhEntries[day]];
    subCols[day]=assignColumns(all);
  }

  const dayStartExcelCol={};
  let nextCol=2;
  for (const day of DAYS) { dayStartExcelCol[day]=nextCol; nextCol+=subCols[day]; }

  const ws=wb.addWorksheet(sheetName.substring(0,31));

  ws.getColumn(1).width=7;
  for (const day of DAYS) {
    const start=dayStartExcelCol[day],count=subCols[day];
    const w=Math.max(14,Math.floor(24/count));
    for (let i=0;i<count;i++) ws.getColumn(start+i).width=w;
  }

  const hdr=ws.getRow(1); hdr.height=22;
  const tcH=hdr.getCell(1);
  tcH.value='Time'; tcH.fill={type:'pattern',pattern:'solid',fgColor:{argb:HEADER_COLOR}};
  tcH.font={bold:true,color:{argb:'FFFFFFFF'},size:10};
  tcH.alignment={vertical:'middle',horizontal:'center'}; tcH.border=thin('FF1F4E79');

  for (const day of DAYS) {
    const start=dayStartExcelCol[day],count=subCols[day];
    if (count>1) safeMerge(ws,1,start,1,start+count-1);
    const cell=ws.getCell(1,start);
    cell.value=day; cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:HEADER_COLOR}};
    cell.font={bold:true,color:{argb:'FFFFFFFF'},size:10};
    cell.alignment={vertical:'middle',horizontal:'center'}; cell.border=thin('FF1F4E79');
  }

  for (let slot=0;slot<TOTAL_SLOTS;slot++) {
    const rowNum=slot+2,row=ws.getRow(rowNum); row.height=ROW_H_PT;
    const timeStr=slotToTime(slot),isHour=timeStr.endsWith(':00');
    if (isHour) {
      const mergeEnd=Math.min(rowNum+2,TOTAL_SLOTS+1);
      safeMerge(ws,rowNum,1,mergeEnd,1);
      const tc=ws.getCell(rowNum,1);
      tc.value=timeStr; tc.fill={type:'pattern',pattern:'solid',fgColor:{argb:TIME_BG}};
      tc.font={size:9,bold:true,color:{argb:'FF1F4E79'}};
      tc.alignment={vertical:'top',horizontal:'center'}; tc.border=thin('FF94A3B8');
    } else {
      const tc=ws.getCell(rowNum,1);
      tc.fill={type:'pattern',pattern:'solid',fgColor:{argb:TIME_BG}}; tc.border=thin('FFE2E8F0');
    }
    for (const day of DAYS) {
      const start=dayStartExcelCol[day],count=subCols[day];
      for (let ci=0;ci<count;ci++) {
        const cell=ws.getCell(rowNum,start+ci);
        cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:slot%2===0?'FFFAFAFA':'FFF0F4FA'}};
        cell.border=thin(isHour?'FFD0D8E8':'FFF1F5F9');
      }
    }
  }

  for (const day of DAYS) {
    for (const {sec,startSlot,endSlot,colIdx} of daySecEntries[day]) {
      const startRow=startSlot+2,endRow=endSlot+1;
      if (endRow<=startRow) continue;
      const excelCol=dayStartExcelCol[day]+colIdx;
      const isSoft=softIds.has(sec.id);
      const argb=isSoft?SOFT_COLOR:(LEVEL_COLORS[sec.academicLevel]??'FFE8F4FD');
      safeMerge(ws,startRow,excelCol,endRow-1,excelCol);
      const cell=ws.getCell(startRow,excelCol);
      // NEW-C1: sanitise each line individually before joining, then once more
      // on the joined value (a multi-line block can still start with a leading
      // `=` from any source line — Excel only checks the first character of
      // the whole cell, but defence in depth is cheap).
      cell.value = safeCell([
        safeCell(`${sec.courseCode??''} ${sectionLabel(sec)} · ${labels.sectionTypeShort(sec.sectionType)}`),   // NEW-FU-666: Lec/Lab flag
        `${(sec.startTime??'').substring(0,5)}–${(sec.endTime??'').substring(0,5)}`,
        safeCell(sec.instructorName ?? '(no instructor)'),
        safeCell(sec.venueName ?? ''),
      ].filter(Boolean).join('\n'));
      cell.fill={type:'pattern',pattern:'solid',fgColor:{argb}};
      cell.font={size:9}; cell.alignment={vertical:'top',horizontal:'left',wrapText:true};
      cell.border=thin(isSoft?'FFB45309':'FF2E75B6');
    }
    for (const {oh,startSlot,endSlot,colIdx} of dayOhEntries[day]) {
      const startRow=startSlot+2,endRow=endSlot+1;
      if (endRow<=startRow) continue;
      const excelCol=dayStartExcelCol[day]+colIdx;
      safeMerge(ws,startRow,excelCol,endRow-1,excelCol);
      const cell=ws.getCell(startRow,excelCol);
      cell.value='Office Hours';
      cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:OH_COLOR}};
      cell.font={size:8,italic:true,color:{argb:'FF555555'}};
      cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};
      cell.border=thin('FF9CA3AF');
    }
  }

  ws.views=[{state:'frozen',xSplit:1,ySplit:1,topLeftCell:'B2'}];
  return ws;
}

async function buildGridWorkbook(scheduleId, filter, semester) {
  const wb = new ExcelJS.Workbook();
  await addScheduleSheet(wb, scheduleId, filter, semester);
  return wb;
}

// ── OFFICE HOURS (reference data, carried so re-import has no R-13) ───────────────
// NEW-FU-657: office hours aren't in the section table but the conflict engine
// needs them (R-13 "no office hours", R-04 instructor clash).
// NEW-FU-660: scoped — the OH set is now `scope.fetchOfficeHours(scheduleId, filter)`
// so an instructor export carries only that instructor's OH, and a venue export only
// the OH of the instructors who teach in it. (Whole-term export is unchanged.)
async function addOfficeHoursSheet(wb, scheduleId, filter = { type: 'full' }) {
  const ohs = await scope.fetchOfficeHours(scheduleId, filter);
  const ws = wb.addWorksheet('OfficeHours');
  ws.columns = [
    { header:'Instructor', key:'instructor', width:24 },
    { header:'Day',        key:'day',        width:12 },
    { header:'Start Time', key:'startTime',  width:12 },
    { header:'End Time',   key:'endTime',    width:12 },
  ];
  const hdr = ws.getRow(1); hdr.height = 20;
  hdr.eachCell(cell => {
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: HEADER_COLOR } };
    cell.font = { bold:true, color:{ argb:'FFFFFFFF' }, size:10 };
    cell.alignment = { vertical:'middle', horizontal:'center' };
    cell.border = thin('FF1F4E79');
  });
  let r = 2;
  for (const oh of ohs) {
    const row = ws.getRow(r++);
    row.getCell('instructor').value = safeCell(oh.instructor_name ?? '');
    row.getCell('day').value        = oh.day ?? '';
    row.getCell('startTime').value  = (oh.start_time || '').substring(0, 5);
    row.getCell('endTime').value    = (oh.end_time   || '').substring(0, 5);
    row.eachCell(cell => { cell.font = { size:9 }; cell.border = thin(); });
  }
  return ws;
}

// ── REFERENCE DATA (Instructors + Venues) ────────────────────────────────────────
// NEW-FU-657b: carry the full instructor + venue records so a re-import rebuilds
// them with their REAL email / type / capacity instead of synthetic defaults.
// NEW-FU-660: scoped via `scope.fetchInstructorsRef`/`fetchVenuesRef` — an instructor
// export's Instructors sheet is JUST that instructor, its Venues sheet is the venues
// that instructor uses; a venue export is the mirror image.
function styleHeaderRow(ws) {
  const hdr = ws.getRow(1); hdr.height = 20;
  hdr.eachCell(cell => {
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: HEADER_COLOR } };
    cell.font = { bold:true, color:{ argb:'FFFFFFFF' }, size:10 };
    cell.alignment = { vertical:'middle', horizontal:'center' };
    cell.border = thin('FF1F4E79');
  });
}
async function addInstructorsSheet(wb, scheduleId, filter = { type: 'full' }) {
  // NEW-FU-666: SINGULAR sheet name in a single-instructor file ("Instructor"); the importer
  // accepts either name (parseInstructorsSheet). Full/venue exports keep "Instructors".
  const ws = wb.addWorksheet(scope.scopeOf(filter) === 'instructor' ? 'Instructor' : 'Instructors');
  ws.columns = [
    { header:'Instructor', key:'name',  width:26 },
    { header:'Email',      key:'email', width:32 },
  ];
  styleHeaderRow(ws);
  let r = 2;
  for (const i of await scope.fetchInstructorsRef(scheduleId, filter)) {
    const row = ws.getRow(r++);
    row.getCell('name').value  = safeCell(i.name  ?? '');
    row.getCell('email').value = safeCell(i.email ?? '');
    row.eachCell(cell => { cell.font = { size:9 }; cell.border = thin(); });
  }
  return ws;
}
async function addVenuesSheet(wb, scheduleId, filter = { type: 'full' }) {
  // NEW-FU-666: SINGULAR sheet name in a single-venue file ("Venue"); importer accepts either.
  const ws = wb.addWorksheet(scope.scopeOf(filter) === 'venue' ? 'Venue' : 'Venues');
  ws.columns = [
    { header:'Venue',      key:'name',     width:16 },
    { header:'Venue Type', key:'type',     width:16 },
    { header:'Capacity',   key:'capacity', width:12 },
  ];
  styleHeaderRow(ws);
  let r = 2;
  for (const v of await scope.fetchVenuesRef(scheduleId, filter)) {
    const row = ws.getRow(r++);
    row.getCell('name').value     = safeCell(v.name ?? '');
    row.getCell('type').value     = labels.venueTypeDisplay(v.type);   // NEW-FU-666: Lecture Hall, not LectureHall
    row.getCell('capacity').value = v.capacity ?? '';
    row.eachCell(cell => { cell.font = { size:9 }; cell.border = thin(); });
  }
  return ws;
}

// NEW-FU-660: machine-readable scope marker. Excel has no rendered heading the parser
// could key off (unlike PDF/Word), so the file's scope rides in a dedicated "Meta"
// sheet — Field/Value rows the importer reads to choose merge (instructor/venue) vs
// replace (full). A file with no Meta sheet (any export made before FU-660) is read
// as 'full', preserving the old replace behavior.
function addMetaSheet(wb, scopeName, entity, semester) {
  const ws = wb.addWorksheet('Meta');
  ws.columns = [
    { header:'Field', key:'field', width:14 },
    { header:'Value', key:'value', width:90 },   // NEW-FU-667: wide enough for the venue note
  ];
  styleHeaderRow(ws);
  const rows = [['Scope', scopeName], ['Entity', entity ?? ''], ['Term', semester ?? '']];
  // NEW-FU-667: in a VENUE file, explain why the OfficeHours / Instructors sheets are present.
  // (A data-sheet header row can't be shifted without breaking the importer, so the note lives
  // here in the metadata sheet — the designated place for "what is this file" information.)
  if (scopeName === 'venue') rows.push(['Note', scope.VENUE_EXPORT_NOTE]);
  let r = 2;
  for (const [field, value] of rows) {
    const row = ws.getRow(r++);
    row.getCell('field').value = field;
    row.getCell('value').value = safeCell(String(value ?? ''));
    row.eachCell(cell => { cell.font = { size:9 }; cell.border = thin(); cell.alignment = { wrapText:true, vertical:'top' }; });
  }
  return ws;
}

// NEW-FU-657: the combined export — Half A (visual schedule grid) on the first
// sheet, Half B (full-term section table) on the "Sections" sheet the importer
// reads by name, plus "OfficeHours", "Instructors" and "Venues" sheets so the
// round-trip is conflict-clean AND loses no entity data. One file carries it all;
// re-importing rebuilds the whole term exactly.
async function buildCombinedWorkbook(scheduleId, filter = { type: 'full' }, semester) {
  const wb = new ExcelJS.Workbook();
  // NEW-FU-660: EVERY half is scoped to the same filter now — a scoped export carries
  // only that instructor's/venue's schedule + only its own reference data, and a Meta
  // sheet stamps the scope so the importer merges (scoped) or replaces (full).
  const scopeName = scope.scopeOf(filter);
  const entity    = await scope.fetchScopeEntity(filter);
  await addScheduleSheet(wb, scheduleId, filter, semester);
  await addSectionsSheet(wb, scheduleId, filter);
  await addOfficeHoursSheet(wb, scheduleId, filter);
  await addInstructorsSheet(wb, scheduleId, filter);
  await addVenuesSheet(wb, scheduleId, filter);
  addMetaSheet(wb, scopeName, entity, semester);
  return wb;
}

// ── IMPORT ──────────────────────────────────────────────────────────────────────

// NEW: extracted from importFromExcel so the PDF/Word parsers in
// ImportParserService.js can feed pre-parsed rows into the same
// transactional commit path without copy-pasting the lock/upsert logic.
async function commitRows(rowData, scheduleId, officeHours = [], instructorsRef = [], venuesRef = []) {
  if (!rowData.length) throw new Error('No data rows found in file.');

  // NEW-FU-657b: reference maps so instructors/venues rebuild with their REAL
  // email / type / capacity (carried in the Instructors & Venues sheets/sections)
  // rather than synthetic defaults — a re-import loses no entity data.
  const refEmailByInstr = new Map(
    (instructorsRef || []).filter(i => i.name && i.email).map(i => [i.name.trim().toLowerCase(), i.email.trim()])
  );
  const refVenueByName = new Map(
    (venuesRef || []).filter(v => v.name).map(v => [v.name.trim().toLowerCase(), v])
  );
  // num_sections = real per-course logical-section count (was hard-coded 1).
  const sectionCountByCourse = new Map();
  for (const r of rowData) {
    const k = String(r.courseCode ?? '').toLowerCase();
    sectionCountByCourse.set(k, (sectionCountByCourse.get(k) || 0) + 1);
  }

  const errors  = [];
  let   created = 0;
  let   skipped = 0;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await schedSvc.assertSchedulerEditableLocked(client, scheduleId);

    // NEW-FU-645 (per-term isolation): resolve the target term UP FRONT so EVERY entity
    // lookup/insert below is scoped to it. Import must populate this term's OWN private
    // copies and never reuse a template (owner_semester NULL) or another term's row — doing
    // so would re-share the entity across terms (the exact cross-term contamination per-term
    // isolation removes). Newly-created rows are stamped owner_semester = this term.
    const ownerRes = await client.query('SELECT semester FROM schedules WHERE id = $1', [scheduleId]);
    const ownerSemester = ownerRes.rows[0]?.semester ?? null;

    // Step 1: upsert courses — scoped to THIS term's private copies only.
    const courseByCode = new Map();
    const allCoursesRes = await client.query(
      `SELECT id, course_code, name, academic_level, category, num_sections
         FROM courses WHERE owner_semester = $1`,
      [ownerSemester]
    );
    for (const c of allCoursesRes.rows) courseByCode.set(c.course_code?.toLowerCase(), c);

    // NEW-FU-661: strict FIELD gate FIRST — reject any malformed value/cell (course code,
    // level↔number, credits range, flag exclusivity, gender, section type/number, days,
    // times+window, venue type, instructor email, venue capacity) with a precise, row-aware
    // message. This runs BEFORE the destructive DELETE, so a bad file changes nothing.
    const { validateImportFields } = require('../domain/importFieldValidation');
    // NEW-FU-665: officeHours are validated by the SAME pre-DELETE gate, so a malformed OH
    // (out-of-window / non-schedulable day / end ≤ start / junk instructor) rejects the whole
    // file before anything is written — closing the non-atomic "OH dropped but rest committed" gap.
    const fieldCheck = validateImportFields({ rows: rowData, instructors: instructorsRef, venues: venuesRef, officeHours });
    if (fieldCheck.errors.length) {
      const err = new Error(`Import canceled — ${fieldCheck.errors.length} value(s) don't match the expected format, so nothing was changed:\n• ${fieldCheck.errors.slice(0, 12).join('\n• ')}`);
      err.status = 400;
      throw err;
    }

    // NEW-FU-459 (Phase 109): validate imported course codes/names. The Add-Course
    // path validates (Phase 108) but Import inserted raw rows — so garbage codes like
    // "lklsh 292-1" and gibberish names could persist via a file upload. Reject the
    // whole import up front; the surrounding transaction rolls back, so the term's
    // existing courses/sections are never lost.
    const { courseCodeError, courseNameError, courseCodeLevelError } = require('../domain/courseFormat');
    // NEW-FU-657: a faithful re-import of an exported term must be ACCEPTED. The seed
    // catalog legitimately holds names the strict create-time validator rejects —
    // one-word graduate titles ("Thesis", "Seminar") and an em-dash in a demo title —
    // so re-importing an export of any real term used to fail the gate below and
    // change nothing. We therefore SKIP the name check for any (code, name) the system
    // already stores anywhere (re-importing existing data introduces no new garbage);
    // a genuinely NEW course name still faces the full validator, and the CODE check
    // always runs. This keeps the FU-459 garbage-rejection intent for new data while
    // making every exported file round-trip.
    const knownNamesRes = await client.query('SELECT LOWER(course_code) AS code, LOWER(name) AS name FROM courses');
    const knownNames = new Set(knownNamesRes.rows.map(r => `${r.code}|${r.name}`));
    // NEW-FU-657: a known course CODE is a known course — accept whatever name the
    // file carries for it (a re-import labels by code; the PDF table may even clip a
    // long name for layout). Only a genuinely-NEW course code faces the full name
    // validator, so the FU-459 garbage-rejection still holds for new data. The CODE
    // check (courseCodeError) always runs, so a malformed code is still rejected.
    const knownCodes = new Set(knownNamesRes.rows.map(r => r.code));
    const badCourses = [];
    for (const row of rowData) {
      const ce = courseCodeError(row.courseCode);
      const codeLc = String(row.courseCode ?? '').toLowerCase();
      const known = knownCodes.has(codeLc) ||
        knownNames.has(`${codeLc}|${String(row.courseName ?? '').toLowerCase()}`);
      const ne = known ? null : courseNameError(row.courseName);
      // NEW-FU-661: level ↔ number agreement, NEW codes only (a re-imported known code may
      // carry a legacy mismatch like SWE 201=Junior and must still round-trip).
      const lvle = known ? null : courseCodeLevelError(row.courseCode, row.academicLevel, row.category);
      if (ce || ne || lvle) badCourses.push(`"${row.courseCode} — ${row.courseName}": ${ce || ne || lvle}`);
    }
    if (badCourses.length) {
      const err = new Error(`Import canceled — ${badCourses.length} course(s) have an invalid code or name, so nothing was changed:\n• ${[...new Set(badCourses)].slice(0, 10).join('\n• ')}`);
      err.status = 400;
      throw err;
    }

    // NEW-FU-570 (audit-2 Phase-11 P2): validate every row through the SAME domain
    // stack createSection enforces, BEFORE the destructive DELETE below. Derives
    // has_lab from the imported Lab sections (the file carries no flag) so a
    // 4-credit course is never persisted unschedulable, and rejects out-of-range /
    // illegal-pattern sections up front (a clean 400) instead of silently
    // corrupting or aborting the section loop mid-transaction.
    const { validateImportRows } = require('../domain/importValidation');
    const { errors: rowErrors, hasLabByCourse } = validateImportRows(rowData);
    if (rowErrors.length) {
      const err = new Error(`Import canceled — ${rowErrors.length} row(s) are invalid, so nothing was changed:\n• ${rowErrors.slice(0, 12).join('\n• ')}`);
      err.status = 400;
      throw err;
    }

    // NEW-FU-657: capstone/external are course-level type flags carried in the
    // import's Course Type column (NOT derivable from sections). Persist them so a
    // capstone/external course re-imports venue-exempt and conflict-identical — and
    // so a 0-credit capstone passes the credits/flag invariant. Mutually exclusive
    // with the section-derived has_lab (a capstone/external course has no Lab row).
    const isCapstoneByCourse = new Map();
    const isExternalByCourse = new Map();
    for (const r of rowData) {
      const k = r.courseCode.toLowerCase();
      if (r.isCapstone) isCapstoneByCourse.set(k, true);
      if (r.isExternal) isExternalByCourse.set(k, true);
    }

    for (const row of rowData) {
      const key = row.courseCode.toLowerCase();
      if (!courseByCode.has(key)) {
        const isGR = row.category?.toUpperCase() === 'GR';
        const level = isGR ? 'Graduate' :
          ['Freshman','Sophomore','Junior','Senior'].find(
            l => l.toLowerCase() === row.academicLevel?.toLowerCase()
          ) ?? 'Freshman';
        // NEW-FU-570 (audit-2 Phase-11 P2): persist the derived has_lab so a
        // 4-credit course imports schedulable (it was defaulting FALSE, which the
        // app treats as impossible → every later add-section failed pattern validation).
        // NEW-FU-645: stamp owner_semester so the imported course is THIS term's private
        // copy, not a global-catalog leak. The scoped lookup above already reused any
        // existing this-term course, so a code reaching here is new for this term — a plain
        // INSERT (the old `ON CONFLICT (course_code)` had no matching index post-migration-023,
        // which dropped the bare UNIQUE for partial per-term/template indexes, and would throw).
        const res = await client.query(`
          INSERT INTO courses (course_code, name, credits, academic_level, category, num_sections, has_lab, is_capstone, is_external, owner_semester)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING id, course_code, name, academic_level, category, num_sections
        `, [row.courseCode, row.courseName, row.credits, level, isGR?'GR':'UG',
            sectionCountByCourse.get(key) || 1,     // NEW-FU-657b: real count
            hasLabByCourse.get(key) || false,
            isCapstoneByCourse.get(key) || false,   // NEW-FU-657
            isExternalByCourse.get(key) || false,   // NEW-FU-657
            ownerSemester]);
        courseByCode.set(key, res.rows[0]);
      }
    }

    // Step 2: upsert instructors
    // NEW-FU-665b: ensure every instructor the file DEFINES exists — those used by the section
    // rows AND those carried in the Instructors reference sheet. A term-owned instructor may have
    // office hours but teach no section (sabbatical / admin); without creating it from the ref
    // sheet, its OH (now exported, see exportScope.fetchOfficeHours) would have no instructor to
    // attach to and silently vanish on re-import. The ref sheet also supplies the canonical name.
    const displayNameByLc = new Map();
    for (const r of rowData) { const nm = r.instructorName?.trim(); if (nm) displayNameByLc.set(nm.toLowerCase(), nm); }
    for (const it of (instructorsRef || [])) { const nm = it?.name?.trim(); if (nm && !displayNameByLc.has(nm.toLowerCase())) displayNameByLc.set(nm.toLowerCase(), nm); }
    const importedInstrNames = [...displayNameByLc.keys()];
    // NEW-FU-645 (per-term isolation): scope to THIS term's instructors ONLY. Reusing a
    // template (owner_semester NULL) would re-share the row across every term that imports
    // the same name — so a name not already owned by this term becomes a fresh per-term copy.
    const existingInstrsRes = await client.query(
      `SELECT id, name FROM instructors WHERE owner_semester = $1`,
      [ownerSemester]
    );
    const instrByName = new Map(existingInstrsRes.rows.map(i => [i.name?.toLowerCase(), i]));

    for (const name of importedInstrNames) {
      if (!instrByName.has(name)) {
        const displayName = displayNameByLc.get(name) ?? name;   // NEW-FU-665b: ref-sheet name for no-section instructors
        const slug  = displayName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase() || 'instructor';
        // The per-term unique index is (email, owner_semester) WHERE owner_semester
        // IS NOT NULL, so a term instructor's email only needs to be unique WITHIN
        // this term — a template (owner NULL) or another term sharing the email is
        // legal. (Scoping to this term, not "OR owner IS NULL", is what lets the REAL
        // email round-trip instead of being bounced to a synthetic one by a template.)
        const taken = async (e) => (await client.query(
          `SELECT 1 FROM instructors WHERE email = $1 AND owner_semester = $2`,
          [e, ownerSemester]
        )).rowCount > 0;
        // NEW-FU-657b: prefer the instructor's REAL email (carried in the
        // Instructors sheet/section) so re-import keeps it; fall back to a synthetic
        // unique address only when it's missing or already used in this scope.
        let email = refEmailByInstr.get(name) || `${slug}@dept.edu`;
        if (await taken(email)) {
          email = `${slug}@dept.edu`;
          for (let i = 2; i < 1000 && await taken(email); i++) email = `${slug}_${i}@dept.edu`;
        }
        // NEW-FU-570 (audit-2 Phase-11 P2): stamp owner_semester so the imported
        // instructor is term-local, not a global-catalog leak.
        const res = await client.query(
          `INSERT INTO instructors (name, email, owner_semester) VALUES ($1, $2, $3) RETURNING id, name`,
          [displayName, email, ownerSemester]
        );
        instrByName.set(name, res.rows[0]);
      }
    }

    // Step 3: upsert venues
    const importedVenueNames = [...new Set(
      rowData.map(r => r.venueName?.trim()).filter(Boolean).map(n => n.toLowerCase())
    )];
    // NEW-FU-645 (per-term isolation): scope to THIS term's venues ONLY (see instructors).
    const existingVenuesRes = await client.query(
      `SELECT id, name FROM venues WHERE owner_semester = $1`,
      [ownerSemester]
    );
    const venueByName = new Map(existingVenuesRes.rows.map(v => [v.name?.toLowerCase(), v]));

    // NEW-FU-657: map each venue name → its exported type so a re-created venue
    // keeps the real type (Laboratory / LectureHall / Multipurpose). Falls back to
    // LectureHall when the file carries no type (older exports / hand-made files).
    const VENUE_TYPES = ['Laboratory', 'LectureHall', 'Multipurpose'];
    const venueTypeByName = new Map();
    for (const r of rowData) {
      const vn = r.venueName?.trim().toLowerCase();
      if (!vn || venueTypeByName.has(vn)) continue;
      const match = VENUE_TYPES.find(t => t.toLowerCase() === String(r.venueType ?? '').trim().toLowerCase());
      if (match) venueTypeByName.set(vn, match);
    }

    for (const name of importedVenueNames) {
      if (!venueByName.has(name)) {
        const displayName = rowData.find(r => r.venueName?.toLowerCase() === name)?.venueName ?? name;
        // NEW-FU-570 (audit-2 Phase-11 P2): migration 021 dropped the global
        // UNIQUE(name) for partial per-scope indexes, so the old `ON CONFLICT (name)`
        // had NO matching constraint and threw — importing ANY new venue was broken.
        // The scoped lookup above already reused an existing global/this-term venue,
        // so a name reaching here is genuinely new for this scope: plain INSERT,
        // stamped term-local.
        // NEW-FU-657b: real type + capacity from the Venues sheet/section; fall back
        // to the section table's venue type (FU-657) and a sane default capacity.
        const vref  = refVenueByName.get(name) || {};
        const vType = ['Laboratory', 'LectureHall', 'Multipurpose'].find(
                        t => t.toLowerCase() === String(vref.type ?? '').toLowerCase())
                      || venueTypeByName.get(name) || 'LectureHall';
        const vCap  = Number.isFinite(vref.capacity) ? vref.capacity : 30;
        const res = await client.query(
          `INSERT INTO venues (name, type, capacity, owner_semester)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name`,
          [displayName, vType, vCap, ownerSemester]
        );
        venueByName.set(name, res.rows[0]);
      }
    }

    // Step 4: atomically replace sections for this schedule
    await client.query(`DELETE FROM sections WHERE schedule_id = $1`, [scheduleId]);

    for (const row of rowData) {
      const course = courseByCode.get(row.courseCode.toLowerCase());
      if (!course) { errors.push(`Course "${row.courseCode}" could not be created.`); continue; }
      const instructor = instrByName.get(row.instructorName?.toLowerCase()) ?? null;
      const venue      = venueByName.get(row.venueName?.toLowerCase())      ?? null;

      for (const day of row.days) {
        try {
          const ins = await client.query(`
            INSERT INTO sections
              (schedule_id,course_id,instructor_id,venue_id,section_number,day,start_time,end_time,section_type,gender)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [
            scheduleId, course.id,
            instructor?.id ?? null,
            venue?.id      ?? null,
            row.sectionNumber, day, row.startTime, row.endTime,
            row.sectionType ?? 'Lec',
            row.gender === 'F' ? 'F' : 'M',   // NEW-FU-502 (Phase 123)
          ]);
          if (ins.rowCount > 0) created++;
          else                  skipped++;
        } catch(err) {
          // NEW-FU-659: keep the row-error human-readable — don't leak raw DB text
          // (constraint names, "duplicate key…") into the user's import result.
          console.error('[import] row insert failed:', row.courseCode, day, err.message);
          errors.push(`${row.courseCode} ${sectionLabel(row)} on ${day} couldn't be added — it may duplicate another section or break a scheduling rule.`);
        }
      }
    }

    // NEW-FU-657: re-create office hours so the re-imported term doesn't fire R-13
    // ("instructor has no office hours") for every instructor. Clear the term's
    // existing OH first so re-import is idempotent (a fresh term has none; the same
    // term replaces rather than duplicates). Each OH is keyed to its instructor by name.
    if (Array.isArray(officeHours) && officeHours.length) {
      await client.query(
        `DELETE FROM office_hours WHERE instructor_id IN (SELECT id FROM instructors WHERE owner_semester = $1)`,
        [ownerSemester]
      );
      for (const oh of officeHours) {
        const instr = instrByName.get(oh.instructorName?.trim().toLowerCase());
        if (!instr || !oh.day || !oh.startTime || !oh.endTime) continue;
        try {
          await instrRepo.addOfficeHour(
            instr.id, { day: oh.day, startTime: oh.startTime, endTime: oh.endTime }, client
          );
        } catch (err) {
          // NEW-FU-665: the field gate already validated every OH (shape, window, day,
          // known instructor) BEFORE the DELETE, so a throw here means a genuine DB-level
          // problem on an otherwise-clean file. ABORT the whole import (the outer catch
          // rolls back) rather than dropping this OH and committing the rest — that was the
          // non-atomic gap. Surface a clean message; never leak raw DB text (cf. FU-659).
          console.error('[import] office-hour insert failed:', oh.instructorName, oh.day, err.message);
          const e = new Error(`Import canceled — the office hours could not be saved, so nothing was changed.`);
          e.status = 400;
          throw e;
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    try { client.release(err); } catch { /* ignore */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* already released via catch path */ }
  }

  return { created, skipped, errors };
}

async function parseExcelToRows(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  // NEW-FU-662: cap sheets/rows so an abnormally large (or size-lying) workbook is rejected.
  assertSheetCount(wb.worksheets.length);
  const ws = wb.getWorksheet('Sections') ?? wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found in uploaded file.');
  assertRowCount(ws.rowCount, 'sheet');

  // NEW-FU-68: case-insensitive header matching. Previously "Course Code"
  // worked but "course code" or "COURSE CODE" produced "Missing required
  // column" errors — a UX trap when users paste headers from another tool.
  // We normalize both the file's headers AND our internal lookups to
  // lowercase, but keep an original-case reverse map for any place that
  // still cares about the canonical name (none currently).
  // NEW-FU-662: a null-prototype map so a malicious header cell ("__proto__", "constructor")
  // becomes an ordinary key and can never pollute Object.prototype.
  const headers = Object.create(null);
  ws.getRow(1).eachCell((cell, colNum) => {
    const v = cell.value?.toString().trim();
    if (v) headers[v.toLowerCase()] = colNum;
  });

  const required = ['Course Code','Section #','Days','Start Time','End Time'];
  for (const req of required) {
    if (!headers[req.toLowerCase()]) throw new Error(`Missing required column: "${req}"`);
  }

  // Parse all rows first (no DB access).
  // NEW-H1: time columns use cellToTimeString() to correctly handle Date and
  // number cell types (Excel-formatted times).
  // NEW-L7: split day strings on `,`, `;`, `/`, or any whitespace so import
  // tolerates the most common delimiter typos.
  const rowData = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    // NEW-FU-24 + NEW-FU-68: guard `headers[col.toLowerCase()]` so an
    // optional missing column doesn't trip row.getCell(undefined). The
    // lowercased key matches FU-68's case-insensitive header table.
    const getStr  = col => {
      const k = headers[col.toLowerCase()];
      return k ? (row.getCell(k)?.value?.toString().trim() ?? '') : '';
    };
    const getTime = col => {
      const k = headers[col.toLowerCase()];
      return k ? cellToTimeString(row.getCell(k)?.value) : '';
    };
    const courseCode    = getStr('Course Code');
    let   sectionNumber = getStr('Section #');
    const daysStr       = getStr('Days');
    const startTime     = getTime('Start Time');
    const endTime       = getTime('End Time');
    if (!courseCode || !sectionNumber || !daysStr || !startTime || !endTime) continue;

    // NEW-M13 + NEW-FU-24 + NEW-FU-68: lowercased optional-column lookup.
    const creditsCol = headers['credits'];
    const creditsCell = creditsCol ? row.getCell(creditsCol)?.value : undefined;
    const credits = Number.isFinite(parseInt(creditsCell, 10)) ? parseInt(creditsCell, 10) : 3;

    // NEW-FU-100: read Section Type with 'Lec' default. Files exported
    // from older versions (no Section Type column) treat every row as a
    // lecture — consistent with the migration 009 default. We validate
    // against the allowed set so a stray "Tutorial" or typo lands as 'Lec'
    // rather than tripping the DB CHECK at insert.
    // NEW-FU-498 (Phase 122): recognize all four types (Lec/Lab/Prj/Ths); unknown → Lec.
    // NEW-FU-666: accept the END-USER label ("Lecture"/"Laboratory"/…) OR the legacy code
    // ("Lec"/"Lab"/…). labels.sectionTypeCode maps known forms to the code; an unknown value
    // passes through so the strict field gate still rejects it (here it just defaults to Lec).
    const rawSectionType = getStr('Section Type');
    const stCode = labels.sectionTypeCode(rawSectionType);
    const sectionType = (['Lec','Lab','Prj','Ths'].includes(stCode) ? stCode : 'Lec');
    // NEW-FU-502 (Phase 123): gender round-trip. Primary source is the new
    // Gender column ('F' → female, anything else → 'M' — matches the column
    // default in migration 014, so files exported before this column existed
    // import exactly as they used to). Tolerance: a hand-edited "F-55"/"F55"
    // in Section # also marks the row female and strips the prefix, so the
    // registrar-style label users SEE in the app is accepted as input.
    const rawGender = getStr('Gender');   // NEW-FU-661: keep the raw cell for strict validation
    // NEW-FU-666: accept "Female"/"Male" labels as well as the "F"/"M" codes.
    let gender = labels.genderCode(rawGender) === 'F' ? 'F' : 'M';
    const fPrefixed = sectionNumber.match(/^F-?(\d{2})$/i);
    if (fPrefixed) { gender = 'F'; sectionNumber = fPrefixed[1]; }
    // NEW-FU-657: course-level type → carries the venue-exemption flags
    // (Capstone / External) that aren't derivable from sections.
    const courseTypeRaw = getStr('Course Type').toLowerCase();
    rowData.push({
      courseCode,
      courseName:    getStr('Course Name')    || courseCode,
      academicLevel: getStr('Academic Level') || 'Freshman',
      category:      labels.categoryCode(getStr('Category')),   // NEW-FU-666: "Undergraduate"/"Graduate" → UG/GR
      credits,
      sectionNumber,
      sectionType,    // NEW-FU-100
      gender,         // NEW-FU-502
      isCapstone:    /capstone/.test(courseTypeRaw),   // NEW-FU-657
      isExternal:    /external/.test(courseTypeRaw),   // NEW-FU-657
      days: daysStr.split(/[,;/\s]+/).map(d => d.trim()).filter(Boolean),
      startTime,
      endTime,
      instructorName: getStr('Instructor'),
      venueName:      getStr('Venue'),
      venueType:      labels.venueTypeCode(getStr('Venue Type')),   // NEW-FU-666: "Lecture Hall" → LectureHall

      // NEW-FU-661: source row number (for precise error messages) + the RAW (pre-coercion)
      // cells the strict validator needs (a stated bad gender/type/credits must be rejected,
      // not silently normalized to M/Lec/3).
      __row: r,
      __raw: { gender: rawGender, sectionType: rawSectionType, credits: creditsCell == null ? '' : String(creditsCell) },
    });
  }

  // NEW-FU-657: also parse the OfficeHours / Instructors / Venues sheets so OH,
  // instructor emails and venue type+capacity all round-trip — nothing is missing.
  // NEW-FU-660: read the Meta sheet's Scope so the importer picks merge vs replace.
  return {
    scope:        parseMetaScope(wb),
    rows:         rowData,
    officeHours:  parseOfficeHoursSheet(wb),
    instructors:  parseInstructorsSheet(wb),
    venues:       parseVenuesSheet(wb),
  };
}

// NEW-FU-660: read the "Meta" sheet's Scope value ('full' | 'instructor' | 'venue').
// Absent sheet → 'full' (pre-FU-660 files were whole-term replace files).
function parseMetaScope(wb) {
  const ws = wb.getWorksheet('Meta');
  if (!ws) return 'full';
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const field = row.getCell(1)?.value?.toString().trim().toLowerCase();
    if (field === 'scope') {
      const v = row.getCell(2)?.value?.toString().trim().toLowerCase();
      return (v === 'instructor' || v === 'venue') ? v : 'full';
    }
  }
  return 'full';
}

// NEW-FU-657b: read the "Instructors" sheet → [{name, email}].
function parseInstructorsSheet(wb) {
  const ws = wb.getWorksheet('Instructors') ?? wb.getWorksheet('Instructor');   // NEW-FU-666: accept singular scoped name
  if (!ws) return [];
  const h = {};
  ws.getRow(1).eachCell((cell, n) => { const v = cell.value?.toString().trim(); if (v) h[v.toLowerCase()] = n; });
  const nCol = h['instructor'] ?? h['name'], eCol = h['email'];
  if (!nCol) return [];
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name  = row.getCell(nCol)?.value?.toString().trim() ?? '';
    const email = eCol ? (row.getCell(eCol)?.value?.toString().trim() ?? '') : '';
    if (name) out.push({ name, email });
  }
  return out;
}

// NEW-FU-657b: read the "Venues" sheet → [{name, type, capacity}].
function parseVenuesSheet(wb) {
  const ws = wb.getWorksheet('Venues') ?? wb.getWorksheet('Venue');   // NEW-FU-666: accept singular scoped name
  if (!ws) return [];
  const h = {};
  ws.getRow(1).eachCell((cell, n) => { const v = cell.value?.toString().trim(); if (v) h[v.toLowerCase()] = n; });
  const nCol = h['venue'] ?? h['name'], tCol = h['type'] ?? h['venue type'], cCol = h['capacity'];
  if (!nCol) return [];
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = row.getCell(nCol)?.value?.toString().trim() ?? '';
    const type = tCol ? labels.venueTypeCode(row.getCell(tCol)?.value?.toString().trim() ?? '') : '';  // NEW-FU-666
    const capRaw = cCol ? row.getCell(cCol)?.value : null;
    const capacity = Number.isFinite(parseInt(capRaw, 10)) ? parseInt(capRaw, 10) : null;
    if (name) out.push({ name, type, capacity });
  }
  return out;
}

// NEW-FU-657: read the "OfficeHours" sheet → [{instructorName, day, startTime, endTime}].
function parseOfficeHoursSheet(wb) {
  const ws = wb.getWorksheet('OfficeHours');
  if (!ws) return [];
  const headers = {};
  ws.getRow(1).eachCell((cell, colNum) => {
    const v = cell.value?.toString().trim();
    if (v) headers[v.toLowerCase()] = colNum;
  });
  const iCol = headers['instructor'], dCol = headers['day'],
        sCol = headers['start time'], eCol = headers['end time'];
  if (!iCol || !dCol || !sCol || !eCol) return [];
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const instructorName = row.getCell(iCol)?.value?.toString().trim() ?? '';
    const day            = row.getCell(dCol)?.value?.toString().trim() ?? '';
    const startTime      = cellToTimeString(row.getCell(sCol)?.value);
    const endTime        = cellToTimeString(row.getCell(eCol)?.value);
    if (!instructorName || !day || !startTime || !endTime) continue;
    out.push({ instructorName, day, startTime, endTime });
  }
  return out;
}

async function importFromExcel(buffer, scheduleId) {
  const { rows, officeHours, instructors, venues } = await parseExcelToRows(buffer);
  return commitRows(rows, scheduleId, officeHours, instructors, venues);
}

// Format dispatch tables. Each entry returns either a Buffer
// (PDF/DOCX) or an exceljs Workbook (XLSX), plus the response
// content-type and filename extension.
const pdfSvc  = require('./PdfExportService');
const docxSvc = require('./DocxExportService');
const importParser = require('./ImportParserService');

const EXPORT_FORMATS = {
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext:  'xlsx',
    async build(scheduleId, filter, semester) {
      // NEW-FU-657: always emit the combined workbook (Schedule grid sheet +
      // Sections table sheet). The filter only selects WHICH grid is Half A;
      // Half B is always the whole-term table so the file round-trips into a
      // complete schedule.
      const wb = await buildCombinedWorkbook(scheduleId, filter, semester);
      // Caller streams via wb.xlsx.write(res); return shape kept distinct
      // so the controller can detect "workbook vs buffer".
      return { workbook: wb };
    },
  },
  pdf: {
    mime: 'application/pdf',
    ext:  'pdf',
    async build(scheduleId, filter, semester) {
      // NEW-FU-657: always emit the combined PDF (grid page(s) + section table).
      // The filter selects which grid is Half A; Half B is the whole-term table.
      const buffer = await pdfSvc.buildCombinedPdfBuffer(scheduleId, filter, semester);
      return { buffer };
    },
  },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext:  'docx',
    async build(scheduleId, filter, semester) {
      // NEW-FU-657: always emit the combined DOCX (per-day schedule list +
      // section table). Filter selects Half A's scope; Half B is whole-term.
      const buffer = await docxSvc.buildCombinedDocxBuffer(scheduleId, filter, semester);
      return { buffer };
    },
  },
  // NEW-FU-667: PNG is now generated SERVER-SIDE — the same SCOPED, theme-independent grid the
  // PDF renders, rasterized to an image. (Was a client-side html2canvas screenshot of the live
  // DOM, which captured the wrong scope + the current theme/view.) So an image export is now
  // factual and deterministic exactly like xlsx/docx/pdf.
  png: {
    mime: 'image/png',
    ext:  'png',
    async build(scheduleId, filter, semester) {
      const buffer = await pdfSvc.buildGridPngBuffer(scheduleId, filter, semester);
      return { buffer };
    },
  },
};

const IMPORT_FORMATS = {
  xlsx: parseExcelToRows,
  docx: importParser.parseDocxToRows,
  pdf:  importParser.parsePdfToRows,
};

class ExportService {
  async buildExport(scheduleId, filter = { type: 'full' }, semester = '', format = 'xlsx') {
    const fmt = EXPORT_FORMATS[format];
    if (!fmt) {
      const err = new Error(`Unsupported export format: "${format}". Allowed: ${Object.keys(EXPORT_FORMATS).join(', ')}.`);
      err.status = 400;
      throw err;
    }
    const result = await fmt.build(scheduleId, filter, semester);
    return { ...result, mime: fmt.mime, ext: fmt.ext };
  }

  // Back-compat: existing callers (tests) still expect a Workbook here.
  async buildWorkbook(scheduleId, filter = { type: 'full' }, semester = '') {
    if (filter.type === 'full') return buildTableWorkbook(scheduleId, semester);
    return buildGridWorkbook(scheduleId, filter, semester);
  }

  // Excel-only legacy entry point; preserved so any direct caller
  // continues to work.
  async importWorkbook(buffer, scheduleId) {
    return importFromExcel(buffer, scheduleId);
  }

  // Format-dispatched import. Parses first, then commits. The two-stage
  // shape (parseRows + commitRows) is intentional — a future "preview
  // before commit" flow can call parseRows alone, render the rows in the
  // UI, and only invoke commitRows after the user confirms.
  async parseRows(buffer, format = 'xlsx') {
    const parser = IMPORT_FORMATS[format];
    if (!parser) {
      const err = new Error(`Unsupported import format: "${format}". Allowed: ${Object.keys(IMPORT_FORMATS).join(', ')}.`);
      err.status = 400;
      throw err;
    }
    return parser(buffer);
  }

  async commitRows(rows, scheduleId, officeHours = [], instructors = [], venues = []) {
    return commitRows(rows, scheduleId, officeHours, instructors, venues);
  }

  async importBuffer(buffer, scheduleId, format = 'xlsx') {
    const parsed = await this.parseRows(buffer, format);
    // NEW-FU-657: parsers now return { rows, officeHours, instructors, venues };
    // tolerate a bare array (defensive) so any legacy parser path still commits.
    const rows        = Array.isArray(parsed) ? parsed : (parsed?.rows || []);
    const officeHours = Array.isArray(parsed) ? []     : (parsed?.officeHours || []);
    const instructors = Array.isArray(parsed) ? []     : (parsed?.instructors || []);
    const venues      = Array.isArray(parsed) ? []     : (parsed?.venues || []);
    return commitRows(rows, scheduleId, officeHours, instructors, venues);
  }
}

// NEW-FU-79: expose safeFilenamePart as a static helper on the exported
// singleton so the controller's exportSchedule can use it for the
// Content-Disposition filename without duplicating the regex.
const exportSvc = new ExportService();
exportSvc.safeFilenamePart = safeFilenamePart;
module.exports = exportSvc;
