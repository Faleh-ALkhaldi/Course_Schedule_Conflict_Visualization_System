// NEW-FU-662: pre-parse upload SAFETY gate. Runs on the raw uploaded buffer BEFORE any
// parser (exceljs / mammoth / pdfjs) touches it, so a hostile file is rejected with a clean
// message before it can exhaust memory/CPU or smuggle active content. This complements (does
// not replace) the multer 10MB size cap, the field-validation gate (FU-661), the parse
// timeout + row/sheet/page caps in the parsers, and the DB constraints — defense in depth.
//
// NEW-FU-675 (ZIP-gate migration): the OOXML inspection now loads the archive with the SAME
// unzipper the parsers use — jszip 3.10.1 (mammoth and exceljs both call `JSZip.loadAsync`).
// The hand-rolled central-directory walk this replaces re-implemented jszip's byte-format reading
// and diverged from it FOUR times across audits — FU-672 (EOCD entry-count), FU-673 (prepend /
// `zero`-offset), FU-674 (0x7075 Unicode-Path name override), plus a latent ZIP64 gap — each one
// letting a part be HIDDEN or RENAMED past the gate's name/size checks while the parser still saw
// it. Inspecting via jszip makes "what the gate checked" identical to "what the parser runs" by
// construction: there is no offset/name/count model left to model differently. `loadAsync` only
// ENUMERATES (it stores each part compressed and never eagerly inflates), so enumeration is
// bomb-safe; we then bound-inflate each part through a byte counter that aborts past the cap, so a
// size-lying bomb is measured (not trusted) with peak memory ≈ the cap.
//
// Pure-ish (no DB; one jszip dependency) → unit-testable. assertSafeUpload is ASYNC (jszip is).
// Throws / rejects with an Error carrying .status=400/415 (a user-facing, plain-language message);
// resolves to { kind } when the buffer is structurally safe.
//
// What it defends against:
//   • Spoofed / renamed / polyglot files     → magic-byte (signature) verification.
//   • Zip bombs (incl. size-LYING ones)      → jszip enumerate + bounded streaming inflate of every
//                                               part through a per-part + total byte ceiling.
//   • XXE / SSRF / billion-laughs            → reject any XML/.rels part carrying <!DOCTYPE/<!ENTITY
//                                               (the OOXML spec forbids DTDs; a real file has none).
//   • Macros / OLE / ActiveX / external data → reject vbaProject.bin / oleObject / activeX /
//                                               externalLink / connections.xml — on jszip's EXACT names.
//   • Truncated / corrupt office files       → jszip fails to load, or a required core part is missing.

// ── Caps (generous vs. real exports, which are ~10–300 KB / a few dozen ZIP entries) ──────
const MAX_ZIP_ENTRIES      = 2000;
const MAX_ZIP_UNCOMPRESSED = 40 * 1024 * 1024;    // 40 MB total expanded (measured)
const MAX_SINGLE_ENTRY     = 25 * 1024 * 1024;    // 25 MB any one part (measured)

// File signatures (magic bytes).
const ZIP_SIGS = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.from([0x50, 0x4b, 0x07, 0x08])];
const PDF_SIG  = Buffer.from('%PDF-', 'latin1');

function statusError(message, status) { const e = new Error(message); e.status = status; return e; }
function reject(message, status = 415) { throw statusError(message, status); }
function startsWithAny(buf, sigs) { return sigs.some(sig => buf.length >= sig.length && buf.subarray(0, sig.length).equals(sig)); }

// Reject macro-enabled / active-content / remote-data Office files. A schedule export is a plain
// workbook/document — it never carries macros, OLE/ActiveX objects, or external-data links — so any
// of these parts means the file is not a clean export. Runs on jszip's RESOLVED part names (FU-675),
// so a 0x7075 rename can no longer hide a vbaProject.bin behind a benign central-header name.
function assertNoActiveContent(names) {
  const lc = names.map(n => n.toLowerCase());
  const macro = lc.some(n => n.includes('vbaproject.bin') || (n.endsWith('.bin') && n.includes('vba')));
  if (macro) reject('This file contains macros / active content and was rejected for safety. Re-export a plain .xlsx/.docx.', 400);
  const activeOrRemote = lc.some(n =>
    n.includes('vbaproject') || n.includes('/oleobject') || n.includes('activex') ||
    n.includes('externallink') || n.endsWith('connections.xml'));
  if (activeOrRemote) reject('This file contains active content or an external-data link and was rejected for safety. Re-export a plain schedule file.', 400);
}

// Stream-inflate a jszip part through a hard byte ceiling. jszip's nodeStream decompresses
// INCREMENTALLY, so destroying the stream the moment the running total crosses `cap` stops the
// inflate with peak memory ≈ the cap — never the bomb's full expansion. (Verified against a
// 300 MB-from-299 KB DEFLATE bomb: peak RSS stayed ≈ baseline + a couple MB, not + 300 MB.)
function readBoundedPart(file, cap) {
  return new Promise((resolve, rej) => {
    const chunks = []; let n = 0, done = false;
    const stream = file.nodeStream('nodebuffer');
    const finish = (err, val) => {
      if (done) return; done = true;
      try { stream.destroy(); } catch { /* already torn down */ }
      err ? rej(err) : resolve(val);
    };
    // The `done` guard makes further 'data'/'error' after destroy() no-ops — we do NOT
    // removeAllListeners() (that interferes with jszip's stream teardown and hangs the inflate).
    stream.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > cap) finish(statusError('This file contains an oversized internal part and was rejected as unsafe (possible zip bomb).', 400));
      else chunks.push(c);
    });
    stream.on('end',   () => finish(null, Buffer.concat(chunks)));
    stream.on('error', (e) => finish(e && e.status ? e : statusError('This Office file looks corrupt — an internal part could not be read.', 400)));
  });
}

// NEW-FU-676 (DoS pre-filter — NOT a security inspection; jszip stays authoritative below): read
// ONLY the 2-byte EOCD "total entries" field. A ZIP that HONESTLY declares a huge entry count makes
// JSZip.loadAsync build that many JS objects before the post-load MAX_ZIP_ENTRIES check can fire (a
// ~10 MB / ~126k-entry file → ~90 MB heap, ~800 ms). Reject an oversized declared count up front in
// microseconds (a real export declares a few dozen). This is a single field read, NOT the
// divergence-prone central-directory walk this gate replaced.
function eocdEntryCount(buf) {
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt16LE(i + 10);
  return 0;   // no EOCD found → let jszip's loadAsync decide (it will reject a non-archive)
}

// Inspect an OOXML upload by loading it with jszip (the parser's own unzipper) and bound-inflating
// every part. Throws (with .status) on anything unsafe; resolves on success.
async function inspectOoxmlViaJszip(buffer, format) {
  const JSZip = require('jszip');
  // Fast DoS pre-reject for an honestly-declared oversized entry count (see eocdEntryCount). A file
  // that LIES (declares few, holds many) still passes here but is bounded by the worker pool — the
  // authoritative count check on jszip's ACTUAL part set runs below.
  const declared = eocdEntryCount(buffer);
  if (declared > MAX_ZIP_ENTRIES) reject(`This file has too many internal parts (${declared}) and was rejected as unsafe.`, 400);

  let zip;
  try { zip = await JSZip.loadAsync(buffer); }
  catch { reject('This Office file looks corrupt — its archive could not be read.'); }

  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  if (names.length > MAX_ZIP_ENTRIES) reject(`This file has too many internal parts (${names.length}) and was rejected as unsafe.`, 400);

  assertNoActiveContent(names);

  // Structural sanity — a real OOXML package carries the content-types map + the format's main part.
  const lc = names.map((n) => n.toLowerCase());
  if (!lc.includes('[content_types].xml')) reject("This file isn't a valid Office document (missing its content-types index).");
  if (format === 'xlsx' && !lc.some((n) => n.startsWith('xl/')))   reject("This file isn't a valid Excel workbook.");
  if (format === 'docx' && !lc.some((n) => n.startsWith('word/'))) reject("This file isn't a valid Word document.");

  // Bounded inflate of every part (measures ACTUAL expanded bytes — a size-lying bomb is caught at
  // the per-part / total ceiling) + a <!DOCTYPE/<!ENTITY scan of each XML/.rels part (XXE / billion-laughs).
  let total = 0;
  for (const name of names) {
    const content = await readBoundedPart(zip.files[name], MAX_SINGLE_ENTRY);
    total += content.length;
    if (total > MAX_ZIP_UNCOMPRESSED) reject('This file expands to too much data and was rejected as unsafe (possible zip bomb).', 400);
    if (/\.(xml|rels)$/i.test(name)) {
      const head = content.toString('latin1');
      if (/<!DOCTYPE/i.test(head) || /<!ENTITY/i.test(head))
        reject('This Office file contains a document-type/entity declaration (a possible XXE or entity-expansion attack) and was rejected for safety.', 400);
    }
  }
}

/**
 * Validate the raw upload buffer for a declared format. Rejects (err.status set) on anything
 * unsafe; resolves to { kind } on success. `format` ∈ 'xlsx' | 'docx' | 'pdf'. ASYNC (FU-675).
 */
async function assertSafeUpload(buffer, format) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) reject('The uploaded file is empty.', 400);

  if (format === 'xlsx' || format === 'docx') {
    // Cheap magic-byte pre-reject before paying for a jszip load.
    if (!startsWithAny(buffer, ZIP_SIGS)) reject("This file isn't a valid Office (.xlsx/.docx) file — its contents don't match its type.");
    await inspectOoxmlViaJszip(buffer, format);
    return { kind: 'ooxml' };
  }

  if (format === 'pdf') {
    // A PDF must start with %PDF- (allow a tiny leading-byte tolerance some tools add).
    const head = buffer.subarray(0, Math.min(buffer.length, 1024));
    if (!head.includes(PDF_SIG)) reject("This file isn't a valid PDF — its contents don't match its type.");
    return { kind: 'pdf' };
  }

  reject(`Unsupported file type "${format}".`, 400);
}

// ── Parse-layer caps (enforced INSIDE the parsers, after the lib has the document) ──────
// Real exports: ~6 sheets, a few hundred rows/sheet, ~6 PDF pages. These bound a file that
// passed the zip gate but is still abnormally large.
const MAX_SHEETS    = 30;
const MAX_ROWS      = 100000;   // per worksheet / table
const MAX_PDF_PAGES = 300;
const MAX_TEXT_ITEMS = 500000;  // total PDF text items
const PARSE_TIMEOUT_MS = 20000; // a malicious file can never hang the request thread forever

function assertRowCount(n, what = 'file') {
  if (n > MAX_ROWS) { const e = new Error(`This ${what} has too many rows (${n}) and was rejected as unsafe.`); e.status = 400; throw e; }
}
function assertSheetCount(n) {
  if (n > MAX_SHEETS) { const e = new Error(`This file has too many sheets (${n}) and was rejected as unsafe.`); e.status = 400; throw e; }
}
function assertPageCount(n) {
  if (n > MAX_PDF_PAGES) { const e = new Error(`This PDF has too many pages (${n}) and was rejected as unsafe.`); e.status = 400; throw e; }
}

// Race a parse against a timeout so a pathological file can't wedge the request thread.
// (The work itself isn't cancellable, but the request fails fast with a clean message and
// the transaction never opens, so nothing is half-applied.)
function withParseTimeout(promise, ms = PARSE_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => {
    const e = new Error('The file took too long to read and was rejected. Make sure it is a normal schedule export.');
    e.status = 400; rej(e);
  }, ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = {
  assertSafeUpload, inspectOoxmlViaJszip, assertNoActiveContent,
  assertRowCount, assertSheetCount, assertPageCount, withParseTimeout,
  MAX_ZIP_ENTRIES, MAX_ZIP_UNCOMPRESSED, MAX_SINGLE_ENTRY,
  MAX_SHEETS, MAX_ROWS, MAX_PDF_PAGES, MAX_TEXT_ITEMS, PARSE_TIMEOUT_MS,
};
