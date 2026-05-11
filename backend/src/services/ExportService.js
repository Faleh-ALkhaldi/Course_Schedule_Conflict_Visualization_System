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
  const cols = [
    { header:'Course Code',    key:'courseCode',    width:14 },
    { header:'Course Name',    key:'courseName',    width:28 },
    { header:'Academic Level', key:'academicLevel', width:16 },
    { header:'Category',       key:'category',      width:10 },
    { header:'Section #',      key:'sectionNumber', width:10 },
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
    row.getCell('courseCode').value    = sec.courseCode     ?? '';
    row.getCell('courseName').value    = sec.courseName     ?? '';
    row.getCell('academicLevel').value = level;
    row.getCell('category').value      = sec.category       ?? '';
    row.getCell('sectionNumber').value = sec.sectionNumber  ?? '';
    row.getCell('days').value          = days.sort().join(', ');
    row.getCell('startTime').value     = startT;
    row.getCell('endTime').value       = endT;
    row.getCell('duration').value      = duration;
    row.getCell('instructor').value    = sec.instructorName ?? '';
    row.getCell('venue').value         = sec.venueName      ?? '';

    row.eachCell(cell => {
      cell.fill   = { type:'pattern', pattern:'solid', fgColor:{ argb } };
      cell.font   = { size:9 };
      cell.alignment = { vertical:'middle', horizontal:'left' };
      cell.border = thin();
    });
  }

  // Auto-filter on header
  ws.autoFilter = { from:'A1', to:`K1` };

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
    sheetName=`${semester} – ${instr?.name??'Instructor'}`;
  } else if (filter.type==='venue' && filter.id) {
    const {VenueRepository}=require('../repositories/repositories');
    const venue=await new VenueRepository().findById(filter.id);
    sections=await sectionRepo.findByVenue(scheduleId,filter.id);
    sheetName=`${semester} – ${venue?.name??'Venue'}`;
  }

  const allConflicts = await conflictRepo.findBySchedule(scheduleId);
  const softIds = new Set(
    allConflicts.filter(c=>c.isSoft&&c.confirmed)
      .flatMap(c=>[c.sectionAId,c.sectionBId].filter(Boolean))
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
      cell.value=[
        `${sec.courseCode??''} §${sec.sectionNumber??''}`,
        `${(sec.startTime??'').substring(0,5)}–${(sec.endTime??'').substring(0,5)}`,
        sec.instructorName??'(no instructor)', sec.venueName??'',
      ].filter(Boolean).join('\n');
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
async function importFromExcel(buffer, scheduleId) {
  const db = require('../config/db');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Sections') ?? wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found in uploaded file.');

  // Read header row
  const headers = {};
  ws.getRow(1).eachCell((cell, colNum) => {
    const v = cell.value?.toString().trim();
    if (v) headers[v] = colNum;
  });

  const required = ['Course Code','Section #','Days','Start Time','End Time'];
  for (const req of required) {
    if (!headers[req]) throw new Error(`Missing required column: "${req}"`);
  }

  // Parse all rows first
  const rowData = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = col => row.getCell(headers[col])?.value?.toString().trim() ?? '';
    const courseCode    = get('Course Code');
    const sectionNumber = get('Section #');
    const daysStr       = get('Days');
    const startTime     = get('Start Time');
    const endTime       = get('End Time');
    if (!courseCode || !sectionNumber || !daysStr || !startTime || !endTime) continue;
    rowData.push({
      courseCode,
      courseName:    get('Course Name')    || courseCode,
      academicLevel: get('Academic Level') || 'Freshman',
      category:      get('Category')       || 'UG',
      sectionNumber,
      days: daysStr.split(',').map(d=>d.trim()).filter(Boolean),
      startTime,
      endTime,
      instructorName: get('Instructor'),
      venueName:      get('Venue'),
    });
  }

  if (!rowData.length) throw new Error('No data rows found in file.');

  // ── Step 1: delete ALL existing sections for this schedule ──────────────
  await db.query(`DELETE FROM sections WHERE schedule_id = $1`, [scheduleId]);

  // ── Step 2: find which courses are referenced in the file ───────────────
  const importedCourseCodes = [...new Set(rowData.map(r => r.courseCode.toLowerCase()))];

  // Delete courses NOT in the import file (and their sections, already cleared)
  const allCourses = await new CourseRepository().findAll();
  for (const course of allCourses) {
    if (!importedCourseCodes.includes(course.course_code?.toLowerCase())) {
      await db.query(`DELETE FROM courses WHERE id = $1`, [course.id]);
    }
  }

  // ── Step 3: create missing courses ─────────────────────────────────────
  const courseByCode = new Map();
  const freshCourses = await new CourseRepository().findAll();
  for (const c of freshCourses) courseByCode.set(c.course_code?.toLowerCase(), c);

  const LEVEL_RANK = {freshman:1,sophomore:2,junior:3,senior:4,graduate:5};
  for (const row of rowData) {
    const key = row.courseCode.toLowerCase();
    if (!courseByCode.has(key)) {
      const isGR = row.category?.toUpperCase() === 'GR';
      const level = isGR ? 'Graduate' :
        ['Freshman','Sophomore','Junior','Senior'].find(
          l => l.toLowerCase() === row.academicLevel?.toLowerCase()
        ) ?? 'Freshman';
      const res = await db.query(`
        INSERT INTO courses (course_code, name, credits, academic_level, category, num_sections)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (course_code) DO UPDATE SET name=EXCLUDED.name
        RETURNING id, course_code, name, academic_level, category, num_sections
      `, [row.courseCode, row.courseName, 3, level, isGR?'GR':'UG', 1]);
      courseByCode.set(key, res.rows[0]);
    }
  }

  // ── Step 4: manage instructors ─────────────────────────────────────────
  // Find all instructor names referenced in the file
  const importedInstrNames = [...new Set(
    rowData.map(r => r.instructorName?.trim()).filter(Boolean).map(n => n.toLowerCase())
  )];

  // Load existing instructors
  const existingInstrs = await instrRepo.findAll();
  const instrByName    = new Map(existingInstrs.map(i => [i.name?.toLowerCase(), i]));

  // Remove instructors NOT referenced in the import file
  for (const instr of existingInstrs) {
    if (!importedInstrNames.includes(instr.name?.toLowerCase())) {
      await db.query(`DELETE FROM instructors WHERE id = $1`, [instr.id]);
      instrByName.delete(instr.name?.toLowerCase());
    }
  }

  // Create new instructors that don't exist yet
  for (const name of importedInstrNames) {
    if (!instrByName.has(name)) {
      const displayName = rowData.find(r => r.instructorName?.toLowerCase() === name)?.instructorName ?? name;
      const res = await db.query(
        `INSERT INTO instructors (name, email) VALUES ($1, $2) RETURNING id, name`,
        [displayName, `${displayName.replace(/\s+/g,'_').toLowerCase()}@dept.edu`]
      );
      instrByName.set(name, res.rows[0]);
    }
  }

  // ── Step 4b: manage venues (same as instructors — create new, remove unrelated) ─
  const importedVenueNames = [...new Set(
    rowData.map(r => r.venueName?.trim()).filter(Boolean).map(n => n.toLowerCase())
  )];

  const existingVenues = await new VenueRepository().findAll();
  const venueByName    = new Map(existingVenues.map(v => [v.name?.toLowerCase(), v]));

  // Remove venues NOT referenced in the import file
  for (const venue of existingVenues) {
    if (!importedVenueNames.includes(venue.name?.toLowerCase())) {
      await db.query(`DELETE FROM venues WHERE id = $1`, [venue.id]);
      venueByName.delete(venue.name?.toLowerCase());
    }
  }

  // Create new venues that don't exist yet
  for (const name of importedVenueNames) {
    if (!venueByName.has(name)) {
      const displayName = rowData.find(r => r.venueName?.toLowerCase() === name)?.venueName ?? name;
      const res = await db.query(
        `INSERT INTO venues (name, type, capacity) VALUES ($1, $2, $3) RETURNING id, name`,
        [displayName, 'LectureHall', 30]
      );
      venueByName.set(name, res.rows[0]);
    }
  }

  // ── Step 5: insert sections ────────────────────────────────────────────
  const errors  = [];
  let   created = 0;

  for (const row of rowData) {
    const course     = courseByCode.get(row.courseCode.toLowerCase());
    if (!course) { errors.push(`Course "${row.courseCode}" could not be created.`); continue; }
    const instructor = instrByName.get(row.instructorName?.toLowerCase()) ?? null;
    const venue      = venueByName.get(row.venueName?.toLowerCase())      ?? null;

    for (const day of row.days) {
      try {
        await db.query(`
          INSERT INTO sections
            (schedule_id,course_id,instructor_id,venue_id,section_number,day,start_time,end_time)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT DO NOTHING
        `, [
          scheduleId, course.id,
          instructor?.id ?? null,
          venue?.id      ?? null,
          row.sectionNumber, day, row.startTime, row.endTime,
        ]);
        created++;
      } catch(err) {
        errors.push(`${row.courseCode} §${row.sectionNumber} on ${day}: ${err.message}`);
      }
    }
  }

  return { created, errors };
}

class ExportService {
  async buildWorkbook(scheduleId, filter={type:'full'}, semester='') {
    // Full semester → tabular rows; filtered views → visual grid
    if (filter.type === 'full') {
      return buildTableWorkbook(scheduleId, semester);
    }
    return buildGridWorkbook(scheduleId, filter, semester);
  }

  async importWorkbook(buffer, scheduleId) {
    return importFromExcel(buffer, scheduleId);
  }
}

module.exports = new ExportService();
