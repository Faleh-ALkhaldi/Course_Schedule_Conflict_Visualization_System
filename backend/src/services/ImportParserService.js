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
// pdf-parse v2.x exposes a PDFParse class instead of the legacy callable default
// (v1.x signature was `pdfParse(buffer)`). The class accepts `{ data: buffer }`
// and exposes `.getText() → { text, pages }`.
const { PDFParse }   = require('pdf-parse');

const REQUIRED = ['course code', 'section #', 'days', 'start time', 'end time'];

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
function normalizeRow(raw) {
  const cc = (raw['course code'] ?? '').trim();
  let   sn = (raw['section #']    ?? raw['section'] ?? '').trim();
  const dd = (raw['days']         ?? '').trim();
  const st = (raw['start time']   ?? '').trim().substring(0, 5);
  const et = (raw['end time']     ?? '').trim().substring(0, 5);
  if (!cc || !sn || !dd || !st || !et) return null;

  // NEW-FU-498 (Phase 122): recognize all four types (Lec/Lab/Prj/Ths); unknown → Lec.
  const rawType = (raw['section type'] ?? '').trim();
  const sectionType = ['Lec','Lab','Prj','Ths'].includes(rawType) ? rawType : 'Lec';

  // NEW-FU-502 (Phase 123): gender round-trip — mirror of the xlsx parser.
  // Gender column 'F' marks female; an F-prefixed section number ("F-55")
  // also marks female and strips to the bare two digits. Default 'M' keeps
  // pre-Phase-123 files importing byte-identically.
  let gender = (raw['gender'] ?? '').trim().toUpperCase() === 'F' ? 'F' : 'M';
  const fPrefixed = sn.match(/^F-?(\d{2})$/i);
  if (fPrefixed) { gender = 'F'; sn = fPrefixed[1]; }

  return {
    courseCode:    cc,
    courseName:    (raw['course name']    ?? '').trim() || cc,
    academicLevel: (raw['academic level'] ?? '').trim() || 'Freshman',
    category:      (raw['category']       ?? '').trim() || 'UG',
    credits:       Number.isFinite(parseInt(raw['credits'], 10)) ? parseInt(raw['credits'], 10) : 3,
    sectionNumber: sn,
    sectionType,
    gender,         // NEW-FU-502
    days:          dd.split(/[,;/\s]+/).map(d => d.trim()).filter(Boolean),
    startTime:     st,
    endTime:       et,
    instructorName:(raw['instructor'] ?? '').trim(),
    venueName:     (raw['venue']      ?? '').trim(),
  };
}

function assertRequiredHeaders(headers) {
  const canonical = headers.map(canonicalizeHeader);
  for (const req of REQUIRED) {
    if (!canonical.includes(req)) throw new Error(`Missing required column: "${req}"`);
  }
}

// ── DOCX ─────────────────────────────────────────────────────────────────────
// mammoth gives us the document as HTML; we parse the first <table> by hand
// rather than pulling in jsdom (avoids ~10MB of deps for a 30-line extractor).
async function parseDocxToRows(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) throw new Error('No table found in Word document.');

  const tableHtml = tableMatch[0];
  const rowMatches = [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(m => m[0]);
  if (rowMatches.length < 2) throw new Error('Word table has no data rows.');

  const cellsFor = (rowHtml) => [...rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map(m => m[1]
      .replace(/<[^>]+>/g, ' ')        // strip inline tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim());

  const headers = cellsFor(rowMatches[0]).map(canonicalizeHeader);
  try {
    assertRequiredHeaders(headers);
  } catch (e) {
    // Grid-view DOCX exports (Instructor / Venue) use a per-day list schema
    // without a "Course Code" column. Reframe the technical error.
    throw new Error(
      `${e.message}. Visual grid Word docs (instructor / venue views) cannot be imported — only the Full Semester table DOCX round-trips.`
    );
  }

  const rows = [];
  for (let i = 1; i < rowMatches.length; i++) {
    const cells = cellsFor(rowMatches[i]);
    const raw = Object.fromEntries(headers.map((h, idx) => [h, cells[idx] ?? '']));
    const r = normalizeRow(raw);
    if (r) rows.push(r);
  }
  if (!rows.length) throw new Error('No data rows could be parsed from Word document.');
  return rows;
}

// ── PDF ──────────────────────────────────────────────────────────────────────
// pdf-parse v2 ships a getTable() that reconstructs tabular data from PDF
// positional data — far more reliable than ad-hoc whitespace splitting on
// the flattened text stream. We pair it with a header read from the text
// stream (getTable strips the header row).
//
// Column order in the output of our own PdfExportService.buildTablePdfBuffer is
// fixed, and we map columns by that fixed order. A third-party PDF whose columns
// are in a different order won't be remapped — only our own export round-trips cleanly.
const SELF_EXPORT_COLUMNS = [
  'course code', 'course name', 'section #', 'section type',
  'days', 'start time', 'end time', 'duration', 'instructor', 'venue',
];

// Tokens that identify a row as the table header. We accept either the
// long form ("Course Code", "Section #") from third-party PDFs or our own
// abbreviated header ("Code", "§") so a round-trip works.
const HEADER_LONG_TOKENS  = ['course code', 'section #', 'days', 'start time', 'end time'];
const HEADER_SHORT_TOKENS = ['code',        '§',         'days', 'start',      'end'];

function looksLikeHeader(line) {
  const lc = line.toLowerCase();
  const hitsLong  = HEADER_LONG_TOKENS.filter(t => lc.includes(t)).length;
  const hitsShort = HEADER_SHORT_TOKENS.filter(t => lc.includes(t)).length;
  return hitsLong === HEADER_LONG_TOKENS.length || hitsShort === HEADER_SHORT_TOKENS.length;
}

async function parsePdfToRows(buffer) {
  const parser = new PDFParse({ data: buffer });
  // Text used to detect whether the PDF has the expected header row.
  const { text } = await parser.getText();
  const { pages } = await parser.getTable();

  const allTables = (pages || []).flatMap(p => p.tables || []);
  if (!allTables.length) {
    throw new Error('No table found in PDF. Visual grid PDFs (instructor / venue views) cannot be imported — only the Full Semester table PDF round-trips.');
  }

  const textLines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const headerLine = textLines.find(looksLikeHeader);
  if (!headerLine) {
    throw new Error(
      'PDF does not contain the expected header row (Course Code, Section #, Days, Start Time, End Time). ' +
      'Visual grid PDFs (instructor / venue views) cannot be imported — only the Full Semester table PDF round-trips.'
    );
  }

  // Pick whichever table on the page has the most columns — getTable can
  // surface small accidental tables (e.g. one stray row) alongside the real
  // section table.
  const table = allTables.reduce((best, t) =>
    ((t[0] || []).length > (best[0] || []).length ? t : best), allTables[0]);

  const ncols = (table[0] || []).length;
  const headers = ncols === SELF_EXPORT_COLUMNS.length
    ? SELF_EXPORT_COLUMNS
    : SELF_EXPORT_COLUMNS.slice(0, ncols);

  const rows = [];
  for (const cells of table) {
    if (!cells || !cells.length) continue;
    const raw = Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').toString().trim()]));
    const r = normalizeRow(raw);
    if (r) rows.push(r);
  }
  if (!rows.length) throw new Error('No data rows could be extracted from PDF.');
  return rows;
}

module.exports = { parseDocxToRows, parsePdfToRows };
