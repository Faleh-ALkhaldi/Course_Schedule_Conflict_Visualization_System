/**
 * ImportParserService
 *
 * Format-specific row extractors for the Schedule import flow. Each parser
 * returns a normalized array of row objects with the same shape that
 * ExportService.importFromExcel's per-row builder produces — so the existing
 * upsert/transaction code in ExportService is reused unchanged.
 *
 * Why one module: PDF table extraction and Word table walking have nothing
 * in common with the Excel exceljs flow, and bundling them inside
 * ExportService.js would balloon a file that's already 600 LOC.
 *
 * Tolerance posture: best-effort. We rely on the same expected header set
 * the Excel import uses (Course Code, Section #, Days, Start Time, End Time
 * are required). Rows with malformed times are dropped with an error entry;
 * the controller surfaces those to the user in the import result.
 */
const mammoth        = require('mammoth');
// NEW-FU-660: scope detection — read the file's scope ('full'|'instructor'|'venue')
// from the scope-tagged table heading so the importer merges (scoped) vs replaces (full).
const scope          = require('./exportScope');
const labels         = require('../domain/exportLabels');   // NEW-FU-666: end-user label ↔ code
// NEW-FU-662: parse-layer safety caps (PDF pages / text items, table rows).
const { assertPageCount, assertRowCount, MAX_TEXT_ITEMS } = require('../domain/uploadSafety');
// NEW-FU-657: PDF import is done with pdfjs (positional extraction) rather than
// pdf-parse v2 — its getTable() throws internally on our combined PDF. pdfjs is
// loaded dynamically inside parsePdfToRows (it ships as ESM).

const REQUIRED = ['course code', 'section #', 'days', 'start time', 'end time'];
// NEW-FU-657: the office-hours table header (Instructor / Day / Start Time / End
// Time). 'day' (singular) distinguishes it from the section table's 'days', and it
// has no 'course code' — so the two tables are never confused.
const OH_REQUIRED = ['instructor', 'day', 'start time', 'end time'];

function normalizeOfficeHour(raw) {
  const instructorName = (raw['instructor'] ?? '').trim();
  const day            = (raw['day']        ?? '').trim();
  const startTime      = (raw['start time'] ?? '').trim().substring(0, 5);
  const endTime        = (raw['end time']   ?? '').trim().substring(0, 5);
  if (!instructorName || !day || !startTime || !endTime) return null;
  return { instructorName, day, startTime, endTime };
}

// NEW-FU-657b: reference tables — Instructors (Name, Email) and Venues (Name,
// Venue Type, Capacity). 'email' / 'capacity' uniquely identify them (no other
// table has those headers), so they're never confused with the section table.
const INSTR_REQUIRED = ['instructor', 'email'];
const VENUE_REQUIRED = ['venue', 'capacity'];
function normalizeInstructorRef(raw) {
  const name = (raw['instructor'] ?? raw['name'] ?? '').trim();
  if (!name) return null;
  return { name, email: (raw['email'] ?? '').trim() };
}
function normalizeVenueRef(raw) {
  const name = (raw['venue'] ?? raw['name'] ?? '').trim();
  if (!name) return null;
  const cap = parseInt(raw['capacity'], 10);
  return { name, type: labels.venueTypeCode((raw['venue type'] ?? '').trim()), capacity: Number.isFinite(cap) ? cap : null };
}

// Common column-name aliases — keys are normalized lowercase forms the
// caller might use, values are our canonical column names. Applied in
// assertRequiredHeaders so a user-supplied DOCX/PDF with abbreviated
// columns ("Start" instead of "Start Time") still imports cleanly.
const HEADER_ALIASES = {
  'start':          'start time',
  'end':            'end time',
  'duration (min)': 'duration',
  'duration':       'duration',
  'type':           'section type',
  'section':        'section #',
  '§':              'section #',
  'code':           'course code',
  'name':           'course name',
  'min':            'duration',
};

function canonicalizeHeader(h) {
  const lc = h.toLowerCase().trim();
  return HEADER_ALIASES[lc] ?? lc;
}

// ── shared row normalization ─────────────────────────────────────────────────
// NEW-FU-661: `rowNum` (1-based source data row) rides on the result so the strict
// field validator can name the offending row in its message.
function normalizeRow(raw, rowNum) {
  const cc = (raw['course code'] ?? '').trim();
  let   sn = (raw['section #']    ?? raw['section'] ?? '').trim();
  const dd = (raw['days']         ?? '').trim();
  const st = (raw['start time']   ?? '').trim().substring(0, 5);
  const et = (raw['end time']     ?? '').trim().substring(0, 5);
  if (!cc || !sn || !dd || !st || !et) return null;

  // NEW-FU-498 (Phase 122): recognize all four types (Lec/Lab/Prj/Ths); unknown → Lec.
  // NEW-FU-666: accept the end-user label ("Lecture"/"Laboratory"/…) as well as the code.
  const rawType = (raw['section type'] ?? '').trim();
  const stCode = labels.sectionTypeCode(rawType);
  const sectionType = ['Lec','Lab','Prj','Ths'].includes(stCode) ? stCode : 'Lec';

  // NEW-FU-502 (Phase 123): gender round-trip — mirror of the xlsx parser.
  // Gender column 'F' marks female; an F-prefixed section number ("F-55")
  // also marks female and strips to the bare two digits. Default 'M' keeps
  // pre-Phase-123 files importing byte-identically.
  const rawGender = (raw['gender'] ?? '');   // NEW-FU-661: keep raw for strict validation
  let gender = labels.genderCode(rawGender) === 'F' ? 'F' : 'M';   // NEW-FU-666: "Female"/"Male" too
  const fPrefixed = sn.match(/^F-?(\d{2})$/i);
  if (fPrefixed) { gender = 'F'; sn = fPrefixed[1]; }

  // NEW-FU-657: course-level type → the venue-exemption flags (Capstone /
  // External) that aren't recoverable from sections. Mirror of the xlsx parser.
  const ct = (raw['course type'] ?? '').toLowerCase();

  return {
    courseCode:    cc,
    courseName:    (raw['course name']    ?? '').trim() || cc,
    academicLevel: (raw['academic level'] ?? '').trim() || 'Freshman',
    category:      labels.categoryCode((raw['category'] ?? '').trim()),   // NEW-FU-666: "Undergraduate"/"Graduate" → UG/GR

    credits:       Number.isFinite(parseInt(raw['credits'], 10)) ? parseInt(raw['credits'], 10) : 3,
    sectionNumber: sn,
    sectionType,
    gender,         // NEW-FU-502
    isCapstone:    /capstone/.test(ct),   // NEW-FU-657
    isExternal:    /external/.test(ct),   // NEW-FU-657
    days:          dd.split(/[,;/\s]+/).map(d => d.trim()).filter(Boolean),
    startTime:     st,
    endTime:       et,
    instructorName:(raw['instructor'] ?? '').trim(),
    venueName:     (raw['venue']      ?? '').trim(),
    venueType:     labels.venueTypeCode((raw['venue type'] ?? '').trim()),   // NEW-FU-666: "Lecture Hall" → LectureHall
    // NEW-FU-661: source row + RAW (pre-coercion) cells for the strict validator.
    __row: rowNum,
    __raw: { gender: rawGender, sectionType: rawType, credits: raw['credits'] == null ? '' : String(raw['credits']) },
  };
}

function assertRequiredHeaders(headers) {
  const canonical = headers.map(canonicalizeHeader);
  for (const req of REQUIRED) {
    if (!canonical.includes(req)) throw new Error(`Missing required column: "${req}"`);
  }
}

// ── DOCX ─────────────────────────────────────────────────────────────────────
// mammoth gives us the document as HTML; we parse <table>s by hand rather than
// pulling in jsdom (avoids ~10MB of deps for a small extractor).
function cellsFor(rowHtml) {
  return [...rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map(m => m[1]
      .replace(/<[^>]+>/g, ' ')        // strip inline tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim());
}

async function parseDocxToRows(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  // NEW-FU-662: bound the rendered size + total rows so a docx that passed the zip gate but
  // still expands to an enormous table can't blow up memory while we scan it.
  if (html.length > 40 * 1024 * 1024) { const e = new Error('This Word file is too large to read safely and was rejected.'); e.status = 400; throw e; }
  const trCount = (html.match(/<tr[\s>]/gi) || []).length;
  assertRowCount(trCount, 'Word document');
  // NEW-FU-657: the combined DOCX contains the per-day visual-schedule tables
  // (Half A) FIRST, then the full-semester section table (Half B). Scan EVERY
  // <table> and pick the first whose header row satisfies the required schema —
  // the grid tables (Time / Course / § / …) lack Course Code + Days + Start/End
  // Time, so they're skipped and we always parse the importable Half-B table.
  const tableMatches = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m => m[0]);
  if (!tableMatches.length) throw new Error('No table found in Word document.');

  let secRows = null, secHeaders = null, ohRows = null, ohHeaders = null;
  let inRows = null, inHeaders = null, veRows = null, veHeaders = null;
  for (const tHtml of tableMatches) {
    const rowMatches = [...tHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(m => m[0]);
    if (rowMatches.length < 2) continue;
    const headers = cellsFor(rowMatches[0]).map(canonicalizeHeader);
    if (!secRows && REQUIRED.every(req => headers.includes(req))) {
      secRows = rowMatches; secHeaders = headers;
    } else if (!ohRows && OH_REQUIRED.every(req => headers.includes(req))) {
      ohRows = rowMatches; ohHeaders = headers;
    } else if (!inRows && INSTR_REQUIRED.every(req => headers.includes(req))) {
      inRows = rowMatches; inHeaders = headers;
    } else if (!veRows && VENUE_REQUIRED.every(req => headers.includes(req))) {
      veRows = rowMatches; veHeaders = headers;
    }
  }
  if (!secRows) {
    // Either a grid-only DOCX or a third-party doc without the expected schema.
    throw new Error(
      'No section table found in the Word document (need columns: Course Code, Section #, Days, Start Time, End Time). ' +
      'A visual-grid-only Word doc cannot be imported — export the combined / Full Semester DOCX, which round-trips.'
    );
  }

  const parseBody = (rws, hdrs, norm) => {
    const out = [];
    for (let i = 1; i < rws.length; i++) {
      const cells = cellsFor(rws[i]);
      // NEW-FU-661: pass the 1-based table row (header = row 1) so normalizeRow can
      // tag each section with its source row for precise validation messages. The OH/
      // instructor/venue normalizers take one arg and harmlessly ignore the second.
      const o = norm(Object.fromEntries(hdrs.map((h, idx) => [h, cells[idx] ?? ''])), i + 1);
      if (o) out.push(o);
    }
    return out;
  };

  const rows = parseBody(secRows, secHeaders, normalizeRow);
  if (!rows.length) throw new Error('No data rows could be parsed from Word document.');

  // NEW-FU-657: office hours (R-13); NEW-FU-657b: instructor emails + venue type/capacity.
  // NEW-FU-660: the scope rides in the section-table heading (an H1 paragraph in the
  // mammoth HTML) — detect it so the importer merges (instructor/venue) vs replaces (full).
  return {
    scope:        scope.detectScopeFromText(html),
    rows,
    officeHours:  ohRows ? parseBody(ohRows, ohHeaders, normalizeOfficeHour) : [],
    instructors:  inRows ? parseBody(inRows, inHeaders, normalizeInstructorRef) : [],
    venues:       veRows ? parseBody(veRows, veHeaders, normalizeVenueRef) : [],
  };
}

// ── PDF (positional, via pdfjs) ──────────────────────────────────────────────
// NEW-FU-657: pdf-parse v2's getTable() is broken in this install (throws
// internally / mis-resolves its worker), so PDF import extracts text WITH
// POSITIONS via pdfjs and reconstructs columns from the EXACT layout
// PdfExportService drew with (shared TABLE_COLS / OH_COLS / LEFT_MARGIN). Each
// cell is left-aligned at colLeft+pad and width-fitted (never overflows), so a
// token's x uniquely identifies its column. A row is a SECTION row when its first
// column is a course code; an OFFICE-HOURS row when its 2nd column is a weekday
// and columns 3/4 are times. Those discriminators keep the grid page, the section
// table and the OH table apart without needing page/region bookkeeping.
const { TABLE_COLS, OH_COLS, INSTRUCTOR_COLS, VENUE_COLS, LEFT_MARGIN } = require('./PdfExportService');

const PDF_COURSE_CODE_RE = /^[A-Za-z]{2,5}\s?\d{2,3}[A-Za-z]?$/;
const HHMM_RE  = /^\d{1,2}:\d{2}$/;
const WEEKDAYS = new Set(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
const VENUE_TYPES_LC = new Set(['laboratory', 'lecturehall', 'multipurpose']);

// camelCase TABLE_COLS/OH_COLS keys → the canonical lowercase header names the
// normalizers (normalizeRow / normalizeOfficeHour) read.
const KEY_TO_CANON = {
  courseCode: 'course code', courseName: 'course name', academicLevel: 'academic level',
  category: 'category', credits: 'credits', courseType: 'course type', sectionNumber: 'section #',
  sectionType: 'section type', gender: 'gender', days: 'days', startTime: 'start time',
  endTime: 'end time', duration: 'duration', instructor: 'instructor', venue: 'venue',
  venueType: 'venue type', day: 'day',
};

function columnLefts(cols) {
  const lefts = []; let x = LEFT_MARGIN;
  for (const c of cols) { lefts.push(x); x += c.width; }
  return lefts; // lefts[i] = left edge of column i
}
// Assign each x-sorted item to the column with the greatest left edge ≤ its x.
function rowToCells(items, cols, lefts) {
  const cells = cols.map(() => []);
  for (const it of items) {
    let i = 0;
    for (let j = 0; j < lefts.length; j++) { if (it.x >= lefts[j] - 1) i = j; else break; }
    cells[i].push(it.str);
  }
  return cells.map(parts => parts.join(' ').replace(/\s+/g, ' ').trim());
}
function cellsToRaw(cells, cols) {
  const raw = {};
  cols.forEach((c, i) => { raw[KEY_TO_CANON[c.key] ?? c.key] = cells[i] ?? ''; });
  return raw;
}

async function parsePdfToRows(buffer) {
  // pdfjs legacy build is ESM — load dynamically from this CommonJS module.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // NEW-FU-662: isEvalSupported:false (no eval), no worker fetch, and we never run any
  // embedded JS — pdfjs extracts text only. Page + text-item caps below bound a hostile PDF.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false,
  }).promise;
  assertPageCount(doc.numPages);   // NEW-FU-662: reject an absurd page count

  // Collect every text item across pages, grouped into visual rows by baseline y
  // (page order, then top→bottom within a page; items left→right within a row).
  const allRows = [];
  let itemCount = 0;   // NEW-FU-662: bound total text items (a flood-of-glyphs PDF)
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    itemCount += content.items.length;
    if (itemCount > MAX_TEXT_ITEMS) { const e = new Error('This PDF contains too much text data and was rejected as unsafe.'); e.status = 400; throw e; }
    const items = content.items
      .filter(it => it.str && it.str.trim())
      .map(it => ({ str: it.str.trim(), x: it.transform[4], y: it.transform[5] }));
    const byY = new Map();
    for (const it of items) {
      const key = Math.round(it.y);
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key).push(it);
    }
    for (const yk of [...byY.keys()].sort((a, b) => b - a)) {
      allRows.push(byY.get(yk).sort((a, b) => a.x - b.x));
    }
  }

  const tableLefts = columnLefts(TABLE_COLS);
  const ohLefts    = columnLefts(OH_COLS);
  const inLefts    = columnLefts(INSTRUCTOR_COLS);
  const veLefts    = columnLefts(VENUE_COLS);
  // NEW-FU-657b: the section table's Course Name now WRAPS (lossless), so a long
  // name spills onto continuation y-rows that carry text only in the name column.
  const nameIdx   = TABLE_COLS.findIndex(c => c.key === 'courseName');
  const nameLeft  = tableLefts[nameIdx];
  const nameRight = nameLeft + TABLE_COLS[nameIdx].width;

  const rows = [], officeHours = [], instructors = [], venues = [];
  let secNum = 0;       // NEW-FU-661: 1-based section-row counter for validation messages
  // NEW-FU-666: buffer the in-progress section row's RAW cells so we can merge WRAPPED
  // continuation lines column-by-column before parsing. FU-657b wrapped only Course Name;
  // now any long END-USER value can wrap too ("Lecture Hall", "Undergraduate", "Has
  // Laboratory"), so a continuation line may carry text in ANY column, not just the name.
  let pending = null;   // string[] of raw section cells, or null
  const flush = () => {
    if (!pending) return;
    const r = normalizeRow(cellsToRaw(pending, TABLE_COLS), ++secNum);
    if (r) rows.push(r);
    pending = null;
  };

  for (const items of allRows) {
    // Section row? first column (by the section layout) is a course code → start a new row.
    const secCells = rowToCells(items, TABLE_COLS, tableLefts);
    if (PDF_COURSE_CODE_RE.test(secCells[0])) {
      flush();
      pending = secCells;
      continue;
    }
    // Reference rows (Office Hours / Instructor / Venue) — these END the section table, so
    // flush the pending section row first, then record the reference row.
    const ohCells = rowToCells(items, OH_COLS, ohLefts);
    if (WEEKDAYS.has((ohCells[1] || '').toLowerCase()) && HHMM_RE.test(ohCells[2]) && HHMM_RE.test(ohCells[3])) {
      flush();
      const o = normalizeOfficeHour(cellsToRaw(ohCells, OH_COLS));
      if (o) officeHours.push(o);
      continue;
    }
    const inCells = rowToCells(items, INSTRUCTOR_COLS, inLefts);
    if (inCells[0] && /@/.test(inCells[1] || '')) {
      flush();
      instructors.push({ name: inCells[0], email: inCells[1] });
      continue;
    }
    // NEW-FU-666: tolerate the humanized "Lecture Hall" (strip spaces before matching).
    const veCells = rowToCells(items, VENUE_COLS, veLefts);
    if (veCells[0] && VENUE_TYPES_LC.has((veCells[1] || '').toLowerCase().replace(/\s+/g, '')) && /^\d+$/.test(veCells[2] || '')) {
      flush();
      venues.push({ name: veCells[0], type: labels.venueTypeCode(veCells[1]), capacity: parseInt(veCells[2], 10) });
      continue;
    }
    // Otherwise a WRAPPED CONTINUATION of the current section row — merge each column's text
    // into the pending cells. PDFKit wraps at spaces AND hyphens (and char-breaks a single
    // long word); we re-join hyphen-aware. The value parsers normalize whitespace, so a
    // char-break like "Undergradu"+"ate" → "Undergradu ate" → categoryCode → "UG".
    // GUARD: a real continuation has an EMPTY course-code column (the short code never wraps).
    // This excludes the repeated table HEADER ("Course Code"/"Venue Type"/… on a page break)
    // and the reference-section TITLE ("281 — Office Hours") from being merged in.
    if (pending && items.length && !secCells[0]) {
      for (let i = 0; i < TABLE_COLS.length; i++) {
        const add = secCells[i];
        if (!add) continue;
        const cur = pending[i] || '';
        pending[i] = cur.endsWith('-') ? cur + add : (cur ? `${cur} ${add}` : add);
      }
    }
  }
  flush();

  if (!rows.length) {
    throw new Error(
      'No section table found in the PDF (need the Full Semester / combined export). ' +
      'A visual-grid-only PDF cannot be imported — export the combined PDF, which round-trips.'
    );
  }
  // NEW-FU-660: detect the scope from the rendered text (the scope-tagged table
  // heading "Instructor/Venue Schedule · …"); whole-term PDFs say "Full Semester".
  const allText = allRows.map(items => items.map(it => it.str).join(' ')).join(' ');
  return { scope: scope.detectScopeFromText(allText), rows, officeHours, instructors, venues };
}

module.exports = { parseDocxToRows, parsePdfToRows };
