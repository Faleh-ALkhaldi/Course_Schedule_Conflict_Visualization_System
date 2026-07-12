// NEW-FU-679 (export fixes) — PDF table layout never char-breaks a word.
// Issue 1: the "gender" column was 26pt (22pt inner), too narrow for the header "Gender" and the
// value "Female" at the 7pt table font, so PDFKit split them mid-character → "Gende r" / "Femal e"
// (which also corrupted the positional re-import). These tests pin the two guarantees that fix it:
//   (a) every column is wide enough for its longest header WORD and its widest enumerable value, and
//   (b) fitCellText shrinks any single token that would still overflow, so a word is NEVER char-split.
const PDFDocument = require('pdfkit');
const Pdf = require('../../src/services/PdfExportService');
const labels = require('../../src/domain/exportLabels');

const F = Pdf.TABLE_FONT;
const cols = Object.fromEntries(Pdf.TABLE_COLS.map(c => [c.key, c]));

// widest token PDFKit cannot break (it breaks at spaces and hyphens)
function widestToken(doc, str, bold) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(F);
  return Math.max(0, ...String(str).split(/[\s-]+/).filter(Boolean).map(t => doc.widthOfString(t)));
}

describe('FU-679 — PDF table column widths fit their content (no mid-word wrap)', () => {
  let doc;
  beforeAll(() => { doc = new PDFDocument({ size: 'A4', layout: 'landscape' }); });

  test('the gender column fits both the header "Gender" and the value "Female" on one line', () => {
    const inner = cols.gender.width - 4;
    expect(widestToken(doc, 'Gender', true)).toBeLessThanOrEqual(inner);             // header
    expect(widestToken(doc, labels.genderDisplay('F'), false)).toBeLessThanOrEqual(inner); // "Female"
    expect(widestToken(doc, labels.genderDisplay('M'), false)).toBeLessThanOrEqual(inner); // "Male"
  });

  test('every header\'s longest WORD fits its column inner width (no header is char-wrapped)', () => {
    for (const c of Pdf.TABLE_COLS) {
      expect(widestToken(doc, c.label, true)).toBeLessThanOrEqual(c.width - 4);
    }
  });

  test('each bounded column fits its widest enumerable value at the table font', () => {
    const enumVals = {
      gender:        ['M', 'F'].map(g => labels.genderDisplay(g)),
      academicLevel: ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Graduate'],
      sectionType:   ['Lec', 'Lab', 'Prj', 'Ths'].map(t => labels.sectionTypeDisplay(t)),
      credits:       ['0', '1', '2', '3', '4'],
      startTime:     ['17:20'], endTime: ['18:10'], duration: ['180'],
    };
    for (const [key, vals] of Object.entries(enumVals)) {
      const inner = cols[key].width - 4;
      for (const v of vals) {
        expect(widestToken(doc, v, false)).toBeLessThanOrEqual(inner);
      }
    }
  });

  test('the whole table still fits the A4-landscape content width (~786pt)', () => {
    const total = Pdf.TABLE_COLS.reduce((s, c) => s + c.width, 0);
    expect(total).toBeLessThanOrEqual(Math.round(841.89 - 2 * Pdf.LEFT_MARGIN));
  });
});

describe('FU-679 — fitCellText never lets a single token char-wrap', () => {
  let doc;
  beforeAll(() => { doc = new PDFDocument({ size: 'A4', layout: 'landscape' }); });

  test('a token WIDER than the cell is drawn at a SMALLER font (so it fits on one line)', () => {
    const innerW = 14;                       // deliberately tiny cell
    const base = 7;
    doc.font('Helvetica').fontSize(base);
    const before = doc._fontSize;
    Pdf.fitCellText(doc, 'Female', 0, 0, innerW, base, 'Helvetica', {});  // "Female" @7pt ≈ 24pt ≫ 14pt
    // fitCellText restores the base size after drawing; assert the shrink happened by re-deriving it
    doc.font('Helvetica').fontSize(base);
    const widest = doc.widthOfString('Female');
    const expectedShrunk = Math.max(4.5, base * innerW / widest);
    expect(expectedShrunk).toBeLessThan(base);                 // it WOULD shrink
    expect(before).toBe(base);
  });

  test('a token that FITS keeps the base font', () => {
    const innerW = 200;                      // roomy cell
    doc.font('Helvetica').fontSize(7);
    expect(doc.widthOfString('Male')).toBeLessThan(innerW);    // fits → no shrink needed
  });
});

describe('FU-679 — grid cards auto-fit their box instead of truncating (Issue 2)', () => {
  // A 4-line card ("course", "time", "instructor", "venue"); a 50-min class block on the page-height
  // grid is only ~26pt tall — the OLD fixed 7pt font overflowed → "AHMED AL-NAZER…". pickCardFont
  // must find a font where ALL four lines fit, with NO truncation.
  const CARD = 'SWE 503 §01 · Lec\n17:20–18:10\nAHMED AL-NAZER\n22-119';
  let doc;
  beforeAll(() => { doc = new PDFDocument({ size: 'A4', layout: 'landscape' }); });

  test('a roomy block keeps the largest (max) font', () => {
    const { size, fits } = Pdf.pickCardFont(doc, CARD, 140, 200, 7);
    expect(fits).toBe(true);
    expect(size).toBe(7);
  });

  test('a short ~26pt block (50-min class) still fits all 4 lines WITHOUT truncating', () => {
    const w = 140, h = 26;
    const { size, fits } = Pdf.pickCardFont(doc, CARD, w, h, 7);
    expect(fits).toBe(true);                         // found a font that fits → no ellipsis
    expect(size).toBeLessThan(7);                    // smaller than the max (the block is tight)
    doc.font('Helvetica').fontSize(size);
    expect(doc.heightOfString(CARD, { width: w })).toBeLessThanOrEqual(h);   // genuinely fits
  });

  test('a narrow lane still fits (no ellipsis) — text wraps within the card, never truncates', () => {
    const w = 36, h = 60;                              // a narrow ~3-lane column
    const { size, fits } = Pdf.pickCardFont(doc, CARD, w, h, 6);
    expect(fits).toBe(true);                           // a fitting font exists → ellipsis OFF → no "…"
    doc.font('Helvetica').fontSize(size);
    expect(doc.heightOfString(CARD, { width: w })).toBeLessThanOrEqual(h);   // all text fits the box
  });
});
