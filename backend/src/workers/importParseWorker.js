'use strict';
// NEW-FU-670: a REUSABLE worker that runs the CPU-bound pre-DB ingestion work — the file-safety
// inspection (magic bytes, zip deep-inflate, active-content scan) AND the format parse (exceljs /
// mammoth / pdfjs) — OFF the request thread. The parent (ImportParseRunner pool) keeps a small
// set of these alive and hands each one parse request at a time, so the ~module-load cost is paid
// ONCE per worker instead of per import. A hostile parse is still bounded: the parent HARD-KILLS
// (worker.terminate()) a worker whose request exceeds the deadline and replaces it. The worker
// touches NO database (parsing is pure buffer→rows; config/db's Pool is lazy and never connects).
const { parentPort } = require('worker_threads');
// Loaded ONCE when the worker spawns (the amortized cost), reused for every subsequent message.
const uploadSafety = require('../domain/uploadSafety');
const exportSvc    = require('../services/ExportService');

// NEW-FU-671 (re-audit): the pool's `resourceLimits.maxOldGenerationSizeMb` caps only the V8 HEAP,
// NOT off-heap allocations (Buffer / ArrayBuffer / typed arrays) — exactly what pdfjs/exceljs/
// mammoth build. The pre-parse gate bounds zip inflation (≤40 MB) but a PDF has no expansion gate
// beyond its magic bytes, so its off-heap working set is otherwise bounded only by the 20 s
// deadline. Backstop it: sample this worker's process RSS during the parse and hard-exit past a
// generous ceiling (pdfjs yields between async ops, so the interval fires). The parent maps the
// exit to a clean 422 and replaces the worker. The ceiling is far above any real parse (real
// exports are ≤300 KB; 4 concurrent legit parses sit well under it), so it never trips normal load.
const RSS_ABORT_BYTES = 1024 * 1024 * 1024;   // ~1 GB process-RSS host-OOM backstop

if (parentPort) {
  parentPort.on('message', async (req) => {
    const memGuard = setInterval(() => {
      if (process.memoryUsage().rss > RSS_ABORT_BYTES) { clearInterval(memGuard); process.exit(1); }
    }, 250);
    memGuard.unref();
    try {
      const buffer = Buffer.from(req.buffer);   // structured-clone delivers a Uint8Array
      uploadSafety.assertSafeUpload(buffer, req.format);        // throws { status:400/415 } on a bad file
      const parsed = await exportSvc.parseRows(buffer, req.format);

      parentPort.postMessage({ ok: true, parsed });
    } catch (e) {
      // Only surface a message we DELIBERATELY set (it carries `.status`). A raw library throw
      // (pdfjs "Invalid PDF structure", saxes "text data outside of root node", a V8 TypeError)
      // must NOT leak — forward a generic message + null status so the runner maps it to a clean
      // 422 (preserves the FU-659 raw-error-leak guard).
      const deliberate = e && e.status;
      parentPort.postMessage({
        ok: false,
        status:  deliberate ? e.status  : null,
        message: deliberate ? e.message : 'We could not read this file.',
      });
    } finally {
      clearInterval(memGuard);
    }
  });
}
