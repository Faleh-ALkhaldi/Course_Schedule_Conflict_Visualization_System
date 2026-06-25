/**
 * NEW-FU-670 — uploaded files are inspected + parsed in a worker thread that is HARD-KILLED at
 * the deadline, so a synchronous CPU-bound parser can never wedge the main event loop past the
 * timeout (the residual the in-thread Promise.race `withParseTimeout` could not enforce).
 * These tests spawn the real worker (no DB is touched — parsing is pure buffer→rows).
 */
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { parseUploadInWorker, MAX_CONCURRENT } = require('../../src/services/ImportParseRunner');

const HEADERS = ['Course Code', 'Course Name', 'Academic Level', 'Category', 'Credits', 'Course Type',
                 'Section #', 'Section Type', 'Gender', 'Days', 'Start Time', 'End Time',
                 'Duration (min)', 'Instructor', 'Venue', 'Venue Type'];
const ROW = ['SWE 211', 'Software Engineering 1', 'Sophomore', 'Undergraduate', 3, 'Standard',
             '01', 'Lecture', 'Male', 'Sunday, Tuesday, Thursday', '08:00', '08:50',
             50, 'VALID INSTRUCTOR', '99-001', 'Lecture Hall'];
async function xlsxBuf(n) {
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet('Sections');
  s.addRow(HEADERS);
  for (let i = 0; i < n; i++) s.addRow([...ROW.slice(0, 6), String((i % 99) + 1).padStart(2, '0'), ...ROW.slice(7)]);
  return Buffer.from(await w.xlsx.writeBuffer());
}

describe('FU-670 — worker-thread parse', () => {
  test('parses a valid file and returns the in-thread shape', async () => {
    const p = await parseUploadInWorker(await xlsxBuf(1), 'xlsx');
    expect(p.scope).toBe('full');
    expect(p.rows.length).toBe(1);
    expect(p.rows[0].instructorName).toBe('VALID INSTRUCTOR');
  }, 15000);

  test('rejects a non-Office buffer with a clean status (no crash, no raw leak)', async () => {
    await expect(parseUploadInWorker(Buffer.from('definitely not a zip'), 'xlsx'))
      .rejects.toMatchObject({ status: expect.any(Number) });
  }, 15000);

  test('a parse runs OFF the main thread — the event loop stays responsive', async () => {
    const buf = await xlsxBuf(4000);            // a few hundred ms of parse work
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 2);
    const p = await parseUploadInWorker(buf, 'xlsx', { timeoutMs: 19000 });
    clearInterval(iv);
    expect(p.rows.length).toBe(4000);
    expect(ticks).toBeGreaterThan(10);          // the loop ticked throughout ⇒ work was off-thread
  }, 20000);

  test('the deadline HARD-KILLS a parse that exceeds it (status 400, returns immediately)', async () => {
    const buf = await xlsxBuf(4000);
    const t0 = Date.now();
    await expect(parseUploadInWorker(buf, 'xlsx', { timeoutMs: 5 }))
      .rejects.toMatchObject({ status: 400 });
    expect(Date.now() - t0).toBeLessThan(3000);  // returned at the deadline, not after the full parse
  }, 15000);

  // NEW-FU-670 (re-audit fixes):
  test('a corrupt-but-valid-magic file rejects with a GENERIC message (no raw library leak)', async () => {
    const badPdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('garbage body not a real pdf '.repeat(5))]);
    let err;
    await parseUploadInWorker(badPdf, 'pdf').catch((e) => { err = e; });
    expect(err).toBeTruthy();
    expect(err.status).toBe(422);
    // the raw pdfjs/saxes/V8 text must NOT surface
    expect(err.message).not.toMatch(/invalid pdf|tagName|root node|cannot read|xref|startxref|undefined/i);
  }, 15000);

  test('concurrent imports beyond the cap all settle (the gate bounds workers, no deadlock)', async () => {
    const N = MAX_CONCURRENT * 4 + 2;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => parseUploadInWorker(Buffer.from('not a zip'), 'xlsx')),
    );
    expect(results).toHaveLength(N);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);   // all completed, none hung
  }, 20000);

  // NEW-FU-670: the persistent worker POOL (reuse spawn cost across imports).
  test('a warm pooled worker reuses the thread — much faster than the cold spawn', async () => {
    const buf = await xlsxBuf(1);
    const t1 = Date.now(); await parseUploadInWorker(buf, 'xlsx'); const cold = Date.now() - t1;
    const t2 = Date.now(); await parseUploadInWorker(buf, 'xlsx'); await parseUploadInWorker(buf, 'xlsx');
    const warm = (Date.now() - t2) / 2;
    expect(warm).toBeLessThan(cold / 2);   // reuse amortizes the ~module-load spawn cost
  }, 15000);

  test('a timed-out worker is terminated and REPLACED — the pool keeps serving', async () => {
    let killed = false;
    await parseUploadInWorker(await xlsxBuf(4000), 'xlsx', { timeoutMs: 5 })
      .catch((e) => { killed = e.status === 400; });
    expect(killed).toBe(true);
    const after = await parseUploadInWorker(await xlsxBuf(1), 'xlsx');   // pool recovered
    expect(after.rows.length).toBe(1);
  }, 15000);
});
