// NEW-FU-680 — export rendering fixes (pure layout/content logic):
//   Issue 1: the weekly grid page scales UP with density so a dense full-term grid's cards stay
//            readable (the old fixed A4 page squeezed many overlapping sections into tiny lanes →
//            "AHMED AL-NAZER…" truncation); sparse instructor/venue grids stay A4.
//   Issue 3: a small legend defines the easily-confused Course Type / Section Type columns.
const Pdf    = require('../../src/services/PdfExportService');
const labels = require('../../src/domain/exportLabels');

describe('FU-680 — grid page scales with density', () => {
  const [A4W, A4H] = Pdf.A4_LANDSCAPE;

  test('a sparse grid (≤ 2 lanes) stays A4 landscape', () => {
    for (const lanes of [1, 2]) {
      const [w, h] = Pdf.gridPageSize(lanes);
      expect(w).toBeCloseTo(A4W, 1);
      expect(h).toBeCloseTo(A4H, 1);
    }
  });

  test('a dense grid gets a proportionally bigger page (more room for full card text)', () => {
    const [w4, h4] = Pdf.gridPageSize(4);
    expect(w4).toBeGreaterThan(A4W);
    expect(h4).toBeGreaterThan(A4H);
    expect(w4 / h4).toBeCloseTo(A4W / A4H, 2);              // keeps the A4 aspect ratio
    expect(Pdf.gridPageSize(6)[0]).toBeGreaterThan(w4);     // denser → bigger
  });

  test('the page is clamped so a pathological term cannot explode it', () => {
    const [w, h] = Pdf.gridPageSize(99);
    expect(w).toBeLessThanOrEqual(A4W * 2.6 + 1);
    expect(h).toBeLessThanOrEqual(A4H * 2.6 + 1);
  });
});

describe('FU-680 — Course/Section Type legend content', () => {
  test('the legend defines every Course Type + Section Type value and the independence note', () => {
    const all = labels.typeLegendLines().join('  ');
    for (const [k] of labels.COURSE_TYPE_DEFS) expect(all).toContain(k);    // NEW-FU-687: Regular/Project/Thesis/Has Laboratory/External
    for (const [k] of labels.SECTION_TYPE_DEFS) expect(all).toContain(k);   // Lecture/Laboratory/Project/Thesis
    expect(all).toMatch(/independent/i);
    // NEW-FU-687: independence example updated (Capstone→Project derives its sessions to Project, so the
    // old "Capstone course can have Lecture sections" example no longer holds; Has-Lab is the clean case).
    expect(all).toMatch(/Has Laboratory course has both Lecture and Laboratory/i);
    expect(all).toContain('Project');   // the renamed capstone course type appears in the legend
    expect(all).toContain('Thesis');    // the new thesis course type appears
    expect(labels.TYPE_LEGEND_TITLE).toMatch(/Course Type.*Section Type/i);
  });
});
