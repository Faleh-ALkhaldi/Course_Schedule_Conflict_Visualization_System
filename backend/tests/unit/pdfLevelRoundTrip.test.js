// NEW-FU-671 (regression guard): the section-table "Academic Level" column must be wide enough
// that EVERY level word renders on one line at Helvetica 7. "Sophomore" is the only one long
// enough to be at risk: at the OLD width (38 → 34pt inner) PDFKit char-wrapped it to
// "Sophomor"+"e", which parsePdfToRows rejoins space-separated as "Sophomor e", and the commit
// resolver then silently defaulted the level to "Freshman" (real PDF round-trip data loss).
//
// The wrap happens iff widthOfString(level) > (columnWidth - 4) — renderTableInto fits each data
// cell to width-4. So this guards the EXACT cause with pdfkit's deterministic AFM metrics (no DB,
// no pdfjs, no ESM flag). The full render→parse round-trip is proven empirically elsewhere; this
// keeps a fast, permanent tripwire on the column width so it can never be narrowed back.
const PDFDocument = require('pdfkit');
const { TABLE_COLS, LEFT_MARGIN } = require('../../src/services/PdfExportService');

const LEVELS = ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Graduate'];
const levelCol = TABLE_COLS.find((c) => c.key === 'academicLevel');

let doc;
beforeAll(() => {
  doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: LEFT_MARGIN });
  doc.font('Helvetica').fontSize(7);   // the section table's data-cell font/size
});

describe('FU-671 — PDF Academic-Level column never char-wraps a level word', () => {
  test('every academic level fits the Academic Level column on one line', () => {
    const inner = levelCol.width - 4;
    for (const lvl of LEVELS) {
      // > inner ⇒ PDFKit wraps the cell ⇒ the importer reads back "<head> <tail>" (e.g. "Sophomor e")
      expect(doc.widthOfString(lvl)).toBeLessThanOrEqual(inner);
    }
  });

  test('"Sophomore" is the binding case: wrapped at the old width, fits the new one', () => {
    const w = doc.widthOfString('Sophomore');
    expect(w).toBeGreaterThan(38 - 4);            // would have char-wrapped at the OLD inner width (34pt) → the bug
    expect(w).toBeLessThanOrEqual(levelCol.width - 4);  // fits the fixed column (44 → 40pt inner)
  });

  test('the rebalanced table still fits A4-landscape content width', () => {
    const total = TABLE_COLS.reduce((s, c) => s + c.width, 0);
    const contentWidth = 841.89 - 2 * LEFT_MARGIN;   // A4 long edge minus both margins
    expect(total).toBeLessThanOrEqual(contentWidth);
  });
});
