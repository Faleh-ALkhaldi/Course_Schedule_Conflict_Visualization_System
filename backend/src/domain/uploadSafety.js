// NEW-FU-662: pre-parse upload SAFETY gate. Runs on the raw uploaded buffer BEFORE any
// parser (exceljs / mammoth / pdfjs) touches it, so a hostile file is rejected with a clean
// message before it can exhaust memory/CPU or smuggle active content. This complements (does
// not replace) the multer 10MB size cap, the field-validation gate (FU-661), the parse
// timeout + row/sheet/page caps in the parsers, and the DB constraints — defense in depth.
//
// Pure (no I/O) → unit-testable. Throws an Error with .status=400/415 (a user-facing,
// plain-language message) on rejection; returns silently when the buffer is structurally safe.
//
// What it defends against here:
//   • Spoofed / renamed / polyglot files       → magic-byte (signature) verification.
//   • Zip bombs (xlsx/docx are ZIP archives)    → entry-count + declared-size + ratio caps AND
//     NEW-FU-663: a REAL decompression pass (each part is inflated through a hard byte ceiling
//     via zlib's maxOutputLength), so a bomb that LIES about its declared sizes is still caught
//     — we measure actual expanded bytes, not the central-directory's claim, and abort the
//     inflate the moment it crosses the cap (peak memory ≈ the cap, never the full bomb).
//   • XXE / SSRF / entity-expansion (billion-laughs)  → NEW-FU-663: reject any XML part carrying
//     a <!DOCTYPE or <!ENTITY declaration. The OOXML spec forbids DTDs, so a real file has none;
//     a present one is the ONLY way to reference an external entity or define an expansion bomb,
//     so this is a definitive guard (no external fetch, no expansion) BEFORE any XML parser runs.
//   • Embedded macros / active content          → reject a ZIP carrying vbaProject.bin etc.
//   • Truncated / corrupt office files          → a valid OOXML zip must carry its core parts.
const zlib = require('zlib');

// ── Caps (generous vs. real exports, which are ~10–300 KB / a few dozen ZIP entries) ──────
const MAX_ZIP_ENTRIES      = 2000;
const MAX_ZIP_UNCOMPRESSED = 100 * 1024 * 1024;   // 100 MB total expanded (declared AND actual)
const MAX_ZIP_RATIO        = 200;                 // expanded ÷ stored — a classic zip-bomb tell
const MAX_SINGLE_ENTRY     = 60 * 1024 * 1024;    // 60 MB any one part (declared AND actual)

// File signatures (magic bytes).
const ZIP_SIGS = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.from([0x50, 0x4b, 0x07, 0x08])];
const PDF_SIG  = Buffer.from('%PDF-', 'latin1');

function reject(message, status = 415) { const e = new Error(message); e.status = status; throw e; }

function startsWithAny(buf, sigs) { return sigs.some(sig => buf.length >= sig.length && buf.subarray(0, sig.length).equals(sig)); }

// Find the End-Of-Central-Directory record (sig 0x06054b50). The comment trailer can be up
// to 65535 bytes, so scan back from the end.
function findEOCD(buf) {
  const SIG = 0x06054b50;
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG) return i;
  }
  return -1;
}

// Walk the ZIP central directory (no decompression) and return { entries, names, total }.
// Throws on a corrupt/oversized/ZIP64 archive. Relies on declared sizes — a deliberate
// lie there is still backstopped by the post-parse row/cell caps + the parse timeout.
function inspectZip(buf) {
  if (!startsWithAny(buf, ZIP_SIGS)) reject("This file isn't a valid Office (.xlsx/.docx) file — its contents don't match its type.");
  const eocd = findEOCD(buf);
  if (eocd < 0 || eocd + 22 > buf.length) reject("This Office file looks corrupt — it has no valid archive index.");
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset   = buf.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdOffset === 0xffffffff) reject('This file uses an unsupported ZIP64 layout and was rejected.');
  if (entryCount > MAX_ZIP_ENTRIES) reject(`This file has too many internal parts (${entryCount}) and was rejected as unsafe.`, 400);

  let off = cdOffset, total = 0, comp = 0;
  const names = [], entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) reject('This Office file looks corrupt — its archive index is malformed.');
    const method     = buf.readUInt16LE(off + 10);
    const compSize   = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen    = buf.readUInt16LE(off + 28);
    const extraLen   = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff   = buf.readUInt32LE(off + 42);
    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOff === 0xffffffff)
      reject('This file uses an unsupported ZIP64 layout and was rejected.');
    if (uncompSize > MAX_SINGLE_ENTRY) reject('This file contains an oversized internal part and was rejected as unsafe.', 400);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    names.push(name);
    entries.push({ name, method, compressedSize: compSize, uncompressedSize: uncompSize, localHeaderOffset: localOff });
    total += uncompSize; comp += compSize;
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (total > MAX_ZIP_UNCOMPRESSED) reject('This file expands to too much data and was rejected as unsafe (possible zip bomb).', 400);
  if (comp > 0 && total / comp > MAX_ZIP_RATIO) reject('This file has an abnormal compression ratio and was rejected as unsafe (possible zip bomb).', 400);
  return { entryCount, names, total, entries };
}

// NEW-FU-663: the DEFINITIVE pass — actually inflate every part through a hard byte ceiling
// (so a size-LYING bomb is measured, not trusted) and scan every XML part for a DTD/entity
// declaration (XXE / billion-laughs). Dependency-free: Node's zlib does raw-DEFLATE inflate,
// and `maxOutputLength` makes the sync inflate THROW the instant output would cross the cap,
// so peak memory is the cap — never the bomb's full expansion.
function inspectZipDeep(buf, entries) {
  let actualTotal = 0;
  for (const e of entries) {
    const lh = e.localHeaderOffset;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50)
      reject('This Office file looks corrupt — an internal part is misaligned.');
    const nameLen  = buf.readUInt16LE(lh + 26);
    const extraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + nameLen + extraLen;
    if (dataStart > buf.length) reject('This Office file looks corrupt — an internal part is truncated.');

    let content;
    if (e.method === 0) {                       // stored (no compression) — actual == compressed
      const end = e.compressedSize > 0 ? dataStart + e.compressedSize : buf.length;
      content = buf.subarray(dataStart, Math.min(end, buf.length));
      if (content.length > MAX_SINGLE_ENTRY) reject('This file contains an oversized internal part and was rejected as unsafe.', 400);
    } else if (e.method === 8) {                // DEFLATE — inflate with a hard ceiling
      const slice = e.compressedSize > 0 ? buf.subarray(dataStart, dataStart + e.compressedSize) : buf.subarray(dataStart);
      try {
        content = zlib.inflateRawSync(slice, { maxOutputLength: MAX_SINGLE_ENTRY });
      } catch (err) {
        // ERR_BUFFER_TOO_LARGE (cap exceeded) ⇒ a size-lying bomb; any other inflate error ⇒
        // the part isn't valid DEFLATE (corrupt/crafted). Either way the file is unsafe.
        reject('This file expands to too much data and was rejected as unsafe (possible zip bomb).', 400);
      }
    } else {
      reject('This Office file uses an unsupported internal compression method and was rejected.', 400);
    }
    actualTotal += content.length;
    if (actualTotal > MAX_ZIP_UNCOMPRESSED) reject('This file expands to too much data and was rejected as unsafe (possible zip bomb).', 400);

    // XXE / entity-expansion guard: an OOXML part NEVER legitimately carries a DTD. The
    // `<!DOCTYPE`/`<!ENTITY` prolog is the only place external entities or expansion bombs can
    // be declared, so its presence ⇒ reject (definitive, before any XML parser sees it).
    if (/\.(xml|rels)$/i.test(e.name)) {
      const head = content.subarray(0, Math.min(content.length, 1 << 20)).toString('latin1');
      if (/<!DOCTYPE/i.test(head) || /<!ENTITY/i.test(head))
        reject('This Office file contains a document-type/entity declaration (a possible XXE or entity-expansion attack) and was rejected for safety.', 400);
    }
  }
  return { actualTotal };
}

// Reject macro-enabled / active-content / remote-data Office files. A schedule export is
// a plain workbook/document — it never carries macros, OLE/ActiveX objects, or external-data
// links — so any of these parts means the file is not a clean export and is rejected.
// NEW-FU-664: extended beyond vbaProject.bin to OLE/ActiveX objects and external-data links
// (xl/externalLinks/, connections.xml) — the remote-data / "prohibited content" vectors.
function assertNoActiveContent(names) {
  const lc = names.map(n => n.toLowerCase());
  const macro = lc.some(n => n.includes('vbaproject.bin') || (n.endsWith('.bin') && n.includes('vba')));
  if (macro) reject('This file contains macros / active content and was rejected for safety. Re-export a plain .xlsx/.docx.', 400);
  const activeOrRemote = lc.some(n =>
    n.includes('vbaproject') || n.includes('/oleobject') || n.includes('activex') ||
    n.includes('externallink') || n.endsWith('connections.xml'));
  if (activeOrRemote) reject('This file contains active content or an external-data link and was rejected for safety. Re-export a plain schedule file.', 400);
}

/**
 * Validate the raw upload buffer for a declared format. Throws (err.status set) on anything
 * unsafe; returns { kind } on success. `format` ∈ 'xlsx' | 'docx' | 'pdf'.
 */
function assertSafeUpload(buffer, format) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) reject('The uploaded file is empty.', 400);

  if (format === 'xlsx' || format === 'docx') {
    const { names, entries } = inspectZip(buffer);
    assertNoActiveContent(names);
    // Structural sanity — a real OOXML package always carries the content-types map, and the
    // format-specific main part. A ZIP that doesn't is not an importable schedule file.
    const lc = names.map(n => n.toLowerCase());
    if (!lc.includes('[content_types].xml'))
      reject("This file isn't a valid Office document (missing its content-types index).");
    if (format === 'xlsx' && !lc.some(n => n.startsWith('xl/')))
      reject("This file isn't a valid Excel workbook.");
    if (format === 'docx' && !lc.some(n => n.startsWith('word/')))
      reject("This file isn't a valid Word document.");
    // NEW-FU-663: only AFTER the cheap structural checks pass do we pay for the real
    // decompression + DTD scan (catches a size-lying zip bomb and any XXE/entity-bomb XML).
    inspectZipDeep(buffer, entries);
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
// passed the zip gate but is still abnormally large (or lied about its declared sizes).
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
  assertSafeUpload, inspectZip, inspectZipDeep, assertNoActiveContent,
  assertRowCount, assertSheetCount, assertPageCount, withParseTimeout,
  MAX_ZIP_ENTRIES, MAX_ZIP_UNCOMPRESSED, MAX_ZIP_RATIO,
  MAX_SHEETS, MAX_ROWS, MAX_PDF_PAGES, MAX_TEXT_ITEMS, PARSE_TIMEOUT_MS,
};
