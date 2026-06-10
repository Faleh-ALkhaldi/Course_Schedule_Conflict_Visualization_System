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
const { getClient } = require('../config/db');
// NEW-FU-282 (Phase 56): shared label helper so exported Excel / CSV /
// PDF render female sections as "§F-XX" rather than "§XX".
const { sectionLabel } = require('../domain/sectionLabel');
// NEW-FU-21: reuse the canonical lock-and-status-check from ScheduleService
// so importFromExcel respects the same finalize-immutability contract that
// every other section-writing path (assignSection/createSection/deleteSection
// /updateSectionInfo/suggest) enforces.
const schedSvc = require('./ScheduleService');

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

// ── TABLE EXPORT ────────────────────────────────────────────────────────────────
async function buildTableWorkbook(scheduleId, semester) {
  const sections = await sectionRepo.findBySchedule(scheduleId);

  // Group by courseId+sectionNumber (logical section)
  const groups = new Map();
  for (const sec of sections) {
    const key = `${sec.courseId}|${sec.sectionNumber}`;
    if (!groups.has(key)) {
      groups.set(key, { sec, days: [] });
    }
    groups.get(key).days.push(sec.day);
  }

  const wb = new ExcelJS.Workbook();
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
    row.getCell('category').value      = safeCell(sec.category       ?? '');
    row.getCell('sectionNumber').value = safeCell(sec.sectionNumber  ?? '');
    row.getCell('sectionType').value   = safeCell(sec.sectionType    ?? 'Lec');   // NEW-FU-100
    row.getCell('gender').value        = sec.gender === 'F' ? 'F' : 'M';          // NEW-FU-502
    row.getCell('days').value          = days.sort().join(', ');
    row.getCell('startTime').value     = startT;
    row.getCell('endTime').value       = endT;
    row.getCell('duration').value      = duration;
    row.getCell('instructor').value    = safeCell(sec.instructorName ?? '');
    row.getCell('venue').value         = safeCell(sec.venueName      ?? '');

    row.eachCell(cell => {
      cell.fill   = { type:'pattern', pattern:'solid', fgColor:{ argb } };
      cell.font   = { size:9 };
      cell.alignment = { vertical:'middle', horizontal:'left' };
      cell.border = thin();
    });
  }

  // Auto-filter on header
  // NEW-FU-100: extend to column L now that Section Type was inserted
  // before Days. NEW-FU-502 (Phase 123): one more column (Gender) → A..M.
  ws.autoFilter = { from:'A1', to:`M1` };

  return wb;
}

// ── GRID EXPORT (filtered views) ────────────────────────────────────────────────
async function buildGridWorkbook(scheduleId, filter, semester) {
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

  const wb=new ExcelJS.Workbook();
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
        safeCell(`${sec.courseCode??''} ${sectionLabel(sec)}`),
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
  return wb;
}

// ── IMPORT ──────────────────────────────────────────────────────────────────────

// NEW: extracted from importFromExcel so the PDF/Word parsers in
// ImportParserService.js can feed pre-parsed rows into the same
// transactional commit path without copy-pasting the lock/upsert logic.
async function commitRows(rowData, scheduleId) {
  if (!rowData.length) throw new Error('No data rows found in file.');

  const errors  = [];
  let   created = 0;
  let   skipped = 0;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await schedSvc.assertSchedulerEditableLocked(client, scheduleId);

    // Step 1: upsert courses
    const courseByCode = new Map();
    const allCoursesRes = await client.query(
      `SELECT id, course_code, name, academic_level, category, num_sections FROM courses`
    );
    for (const c of allCoursesRes.rows) courseByCode.set(c.course_code?.toLowerCase(), c);

    // NEW-FU-459 (Phase 109): validate imported course codes/names. The Add-Course
    // path validates (Phase 108) but Import inserted raw rows — so garbage codes like
    // "lklsh 292-1" and gibberish names could persist via a file upload. Reject the
    // whole import up front; the surrounding transaction rolls back, so the term's
    // existing courses/sections are never lost.
    const { courseCodeError, courseNameError } = require('../domain/courseFormat');
    const badCourses = [];
    for (const row of rowData) {
      const ce = courseCodeError(row.courseCode), ne = courseNameError(row.courseName);
      if (ce || ne) badCourses.push(`"${row.courseCode} — ${row.courseName}": ${ce || ne}`);
    }
    if (badCourses.length) {
      const err = new Error(`Import canceled — ${badCourses.length} course(s) have an invalid code or name, so nothing was changed:\n• ${[...new Set(badCourses)].slice(0, 10).join('\n• ')}`);
      err.status = 400;
      throw err;
    }

    for (const row of rowData) {
      const key = row.courseCode.toLowerCase();
      if (!courseByCode.has(key)) {
        const isGR = row.category?.toUpperCase() === 'GR';
        const level = isGR ? 'Graduate' :
          ['Freshman','Sophomore','Junior','Senior'].find(
            l => l.toLowerCase() === row.academicLevel?.toLowerCase()
          ) ?? 'Freshman';
        const res = await client.query(`
          INSERT INTO courses (course_code, name, credits, academic_level, category, num_sections)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (course_code) DO UPDATE SET name=EXCLUDED.name
          RETURNING id, course_code, name, academic_level, category, num_sections
        `, [row.courseCode, row.courseName, row.credits, level, isGR?'GR':'UG', 1]);
        courseByCode.set(key, res.rows[0]);
      }
    }

    // Step 2: upsert instructors
    const importedInstrNames = [...new Set(
      rowData.map(r => r.instructorName?.trim()).filter(Boolean).map(n => n.toLowerCase())
    )];
    const existingInstrsRes = await client.query(`SELECT id, name FROM instructors`);
    const instrByName = new Map(existingInstrsRes.rows.map(i => [i.name?.toLowerCase(), i]));

    for (const name of importedInstrNames) {
      if (!instrByName.has(name)) {
        const displayName = rowData.find(r => r.instructorName?.toLowerCase() === name)?.instructorName ?? name;
        const slug  = displayName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase() || 'instructor';
        let   email = `${slug}@dept.edu`;
        for (let i = 2; i < 100; i++) {
          const probe = await client.query(`SELECT 1 FROM instructors WHERE email = $1`, [email]);
          if (!probe.rowCount) break;
          email = `${slug}_${i}@dept.edu`;
        }
        const res = await client.query(
          `INSERT INTO instructors (name, email) VALUES ($1, $2) RETURNING id, name`,
          [displayName, email]
        );
        instrByName.set(name, res.rows[0]);
      }
    }

    // Step 3: upsert venues
    const importedVenueNames = [...new Set(
      rowData.map(r => r.venueName?.trim()).filter(Boolean).map(n => n.toLowerCase())
    )];
    const existingVenuesRes = await client.query(`SELECT id, name FROM venues`);
    const venueByName = new Map(existingVenuesRes.rows.map(v => [v.name?.toLowerCase(), v]));

    for (const name of importedVenueNames) {
      if (!venueByName.has(name)) {
        const displayName = rowData.find(r => r.venueName?.toLowerCase() === name)?.venueName ?? name;
        const res = await client.query(
          `INSERT INTO venues (name, type, capacity)
           VALUES ($1, $2, $3)
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id, name`,
          [displayName, 'LectureHall', 30]
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
          errors.push(`${row.courseCode} ${sectionLabel(row)} on ${day}: ${err.message}`);
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
  const ws = wb.getWorksheet('Sections') ?? wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found in uploaded file.');

  // NEW-FU-68: case-insensitive header matching. Previously "Course Code"
  // worked but "course code" or "COURSE CODE" produced "Missing required
  // column" errors — a UX trap when users paste headers from another tool.
  // We normalize both the file's headers AND our internal lookups to
  // lowercase, but keep an original-case reverse map for any place that
  // still cares about the canonical name (none currently).
  const headers = {};
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
    const rawSectionType = getStr('Section Type');
    const sectionType = (['Lec','Lab','Prj','Ths'].includes(rawSectionType) ? rawSectionType : 'Lec');
    // NEW-FU-502 (Phase 123): gender round-trip. Primary source is the new
    // Gender column ('F' → female, anything else → 'M' — matches the column
    // default in migration 014, so files exported before this column existed
    // import exactly as they used to). Tolerance: a hand-edited "F-55"/"F55"
    // in Section # also marks the row female and strips the prefix, so the
    // registrar-style label users SEE in the app is accepted as input.
    let gender = getStr('Gender').trim().toUpperCase() === 'F' ? 'F' : 'M';
    const fPrefixed = sectionNumber.match(/^F-?(\d{2})$/i);
    if (fPrefixed) { gender = 'F'; sectionNumber = fPrefixed[1]; }
    rowData.push({
      courseCode,
      courseName:    getStr('Course Name')    || courseCode,
      academicLevel: getStr('Academic Level') || 'Freshman',
      category:      getStr('Category')       || 'UG',
      credits,
      sectionNumber,
      sectionType,    // NEW-FU-100
      gender,         // NEW-FU-502
      days: daysStr.split(/[,;/\s]+/).map(d => d.trim()).filter(Boolean),
      startTime,
      endTime,
      instructorName: getStr('Instructor'),
      venueName:      getStr('Venue'),
    });
  }

  return rowData;
}

async function importFromExcel(buffer, scheduleId) {
  const rows = await parseExcelToRows(buffer);
  return commitRows(rows, scheduleId);
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
      const wb = filter.type === 'full'
        ? await buildTableWorkbook(scheduleId, semester)
        : await buildGridWorkbook(scheduleId, filter, semester);
      // Caller streams via wb.xlsx.write(res); return shape kept distinct
      // so the controller can detect "workbook vs buffer".
      return { workbook: wb };
    },
  },
  pdf: {
    mime: 'application/pdf',
    ext:  'pdf',
    async build(scheduleId, filter, semester) {
      const buffer = filter.type === 'full'
        ? await pdfSvc.buildTablePdfBuffer(scheduleId, semester)
        : await pdfSvc.buildGridPdfBuffer(scheduleId, filter, semester);
      return { buffer };
    },
  },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext:  'docx',
    async build(scheduleId, filter, semester) {
      const buffer = filter.type === 'full'
        ? await docxSvc.buildTableDocxBuffer(scheduleId, semester)
        : await docxSvc.buildGridDocxBuffer(scheduleId, filter, semester);
      return { buffer };
    },
  },
  // PNG export happens client-side (html2canvas captures the rendered DOM
  // — server has no DOM to render). The controller rejects format=png with
  // a 400 so a stray API call surfaces a clear message instead of failing
  // silently.
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

  async commitRows(rows, scheduleId) {
    return commitRows(rows, scheduleId);
  }

  async importBuffer(buffer, scheduleId, format = 'xlsx') {
    const rows = await this.parseRows(buffer, format);
    return commitRows(rows, scheduleId);
  }
}

// NEW-FU-79: expose safeFilenamePart as a static helper on the exported
// singleton so the controller's exportSchedule can use it for the
// Content-Disposition filename without duplicating the regex.
const exportSvc = new ExportService();
exportSvc.safeFilenamePart = safeFilenamePart;
module.exports = exportSvc;
