// NEW-FU-298 (Phase 60): content-aware rendering strategies.
//
// Background: Phase 59's useFitText hook shrinks the font until text
// fits horizontally. But at the 5-px floor, a 15-character name
// ("KHALID ALJASSER") still needs more horizontal room than a < 60-px
// lane can give. Result: line-clamp engages on the wrapped second line
// and we see "KHA…" mid-name truncation again.
//
// This module adds a content-transform layer that runs BEFORE the
// font-shrink layer. The transform changes the rendered string —
// "KHALID ALJASSER" might become "KHALID\nALJASSER" (wrap at space),
// or "K. ALJASSER" (abbreviate first name), or "K.A." (initials).
// Phase 59's font-shrink then handles whatever the transform produced.
//
// Strategy decision order, per element:
//   1. Full text         — if it fits on one line, keep it.
//   2. Wrap at space     — preserves whole-word identity.
//   3. Abbreviate first  — "K. ALJASSER".
//   4. Abbreviate last   — "KHALID A.".
//   5. Initials          — "K.A.".
//   6. Hide              — drop the field; tooltip is the source.
//
// Each step is tried; the first one whose predicted width fits the
// container × safety factor wins. Different browsers round font
// metrics differently (Safari widens, Chrome narrows); the 0.92
// safety factor absorbs that variance + sub-pixel rounding.

// Approximate character width / font-size ratio for the app's font
// stack. We don't measure the real ratio per-character (perf cost);
// instead we use a single ratio tuned to Inter / SF Mono mixed.
// Slightly conservative (over-estimating width) so the strategy
// prefers shorter forms when the choice is close.
const CHAR_WIDTH_RATIO = 0.55;

// NEW-FU-301 (Phase 62): SAFETY_FACTOR loosened 0.92 → 0.98. The
// 8% margin was right when the strategy ladder included abbreviation
// fallbacks — over-predicting width meant "abbreviate sooner," which
// hurt user readability. Phase 62 reverses the strategy: no
// abbreviation, always full text. Over-predicting now means "wrap
// to a second line sooner," which is the wrong direction — wraps
// fragment the visual identity of a single-word name like "MAHMOOD".
// 0.98 means "commit to one line as long as physically possible;
// the font-shrink layer (useFitText, now floored at 3 px) handles
// the rest." Browser metric variance + sub-pixel rounding still
// need *some* margin, hence 2% not 0%.
const SAFETY_FACTOR = 0.98;

// Predicted on-screen width in px for `text` at `fontPx` font size.
// Conservative — slightly over-estimates so the strategy picks the
// next-shorter form when the choice is close.
export function predictWidth(text, fontPx) {
  if (!text) return 0;
  return text.length * fontPx * CHAR_WIDTH_RATIO;
}

// True iff `text` is predicted to fit in `containerW` px at `fontPx`.
function fits(text, fontPx, containerW) {
  return predictWidth(text, fontPx) <= containerW * SAFETY_FACTOR;
}

// Find the longest "word" in `text` (longest space-separated chunk).
// Used to decide whether wrap-at-space will succeed — if the longest
// individual word is itself too wide for the container, wrapping at
// the space doesn't help.
function longestWordLength(text) {
  if (!text) return 0;
  return text.split(/\s+/).reduce((max, w) => Math.max(max, w.length), 0);
}

// Wrap a string at the first whitespace, returning a "\n"-joined form.
// If there's no whitespace OR if doing so leaves the longest line still
// wider than `containerW` at `fontPx`, returns null (signal the caller
// to try the next strategy).
export function wrapAtFirstSpace(text, fontPx, containerW) {
  if (!text) return null;
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const longestPart = parts.reduce((max, p) => p.length > max.length ? p : max, '');
  if (!fits(longestPart, fontPx, containerW)) return null;
  return parts.join('\n');
}

// "FIRSTNAME LASTNAME" → "F. LASTNAME" (or "F. M. LASTNAME" for
// multi-part names — abbreviate every part except the last).
export function abbreviateFirstName(text) {
  if (!text) return null;
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const initials = parts.slice(0, -1).map(p => `${p[0]}.`).join(' ');
  return `${initials} ${last}`;
}

// "FIRSTNAME LASTNAME" → "FIRSTNAME L."
export function abbreviateLastName(text) {
  if (!text) return null;
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0];
  const last = parts[parts.length - 1];
  return `${first} ${last[0]}.`;
}

// "FIRSTNAME MIDDLENAME LASTNAME" → "F.M.L."
export function initials(text) {
  if (!text) return null;
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return parts.map(p => `${p[0]}.`).join('');
}

// Pick the rendering strategy for an instructor name given the
// container width and the current effective font size. Returns the
// transformed string the component should render. Caller is responsible
// for separately wiring the tooltip with the ORIGINAL name so hover
// always reveals the full identifier.
//
// The font-shrink layer (useFitText from Phase 59) runs AFTER this
// transform — so we pass the *post-shrink* font size as `fontPx` to
// model what the rendered text will actually look like.
// NEW-FU-301 (Phase 62): abbreviation strategies removed from the
// ladder. The product rule changed: full text must always render,
// no matter how small the font has to shrink. Initials like "K.A."
// are ambiguous when multiple instructors share initials — the user
// sees a dense slot of `K.A. / K.A. / M.A. / M.A.` and can't tell
// which is which without hovering every cell. Better to render
// `KHALID ALJASSER / KHALID ALJASSER / MOHAMMAD ALSHAYEB` at 3 px
// than abbreviate.
//
// New ladder: full → wrap-at-first-space → return-original-as-is
// (CSS `overflow-wrap: anywhere` then handles last-resort char-break
// if even multi-line wrap doesn't fit). useFitText (Phase 59, now
// floored at 3 px in Phase 62) shrinks the font on top of whatever
// the strategy picked.
//
// The abbreviation helpers (`abbreviateFirstName`, `abbreviateLastName`,
// `initials`) stay exported from this module — future product
// decisions might want them back without an undo-the-removal commit.
export function pickInstructorRender(name, containerW, fontPx) {
  if (!name) return '';
  if (!Number.isFinite(containerW) || containerW <= 0) return name;
  // 1. Full text fits on one line → use it (preserves visual identity).
  if (fits(name, fontPx, containerW)) return name;
  // 2. Wrap at first space — splits "KHALID ALJASSER" → "KHALID\nALJASSER"
  //    so the natural word break is the line break. Even if the longest
  //    individual word doesn't fit, return the wrap result anyway and
  //    let useFitText shrink the font + CSS overflow-wrap handle the
  //    last-resort character break. The original (Phase 60) check that
  //    rejected wrap when the longest word didn't fit caused the
  //    strategy to fall through to abbreviation — now removed.
  const wrapped = wrapAtFirstSpaceAlways(name);
  if (wrapped) return wrapped;
  // 3. No space to wrap at, no abbreviation allowed — return the
  //    original. useFitText + CSS handle whatever shrink + char-wrap
  //    is needed below.
  return name;
}

// Like wrapAtFirstSpace but without the "longest part must fit" check.
// Phase 62: we always want to commit to wrap-at-space if a space
// exists, because the alternative (no wrap → CSS chars-break across
// the entire string) loses word boundaries entirely. With wrap-at-
// space the user at least sees "KHALID" together on one line even if
// "ALJASSER" then char-breaks.
function wrapAtFirstSpaceAlways(text) {
  if (!text) return null;
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return parts.join('\n');
}

// Pick the rendering strategy for a venue name. The convention is
// "XX-YYY" or "XX-YYY-Z" or "XX-YYYY". At narrow widths we'd prefer
// to wrap at the hyphen ("24-\n101-A") rather than abbreviate, since
// the hyphen-separated parts are semantically the building / room /
// section. Abbreviation last-resort is "24-…" but we'd rather not
// emit ellipsis ourselves — the tooltip is the fallback.
// NEW-FU-301 (Phase 62): same reversal as pickInstructorRender. The
// building-only fallback ("24" from "24-101-A") is removed — venues
// must always render in full. New ladder: full → wrap-at-first-
// hyphen → return-original-as-is.
export function pickVenueRender(venue, containerW, fontPx) {
  if (!venue) return '';
  if (!Number.isFinite(containerW) || containerW <= 0) return venue;
  // 1. Full venue fits — use it.
  if (fits(venue, fontPx, containerW)) return venue;
  // 2. Wrap at the first hyphen: "24-101-A" → "24-\n101-A".
  // NEW-FU-308 (Phase 65): the hyphen is preserved on line 1 (trailing)
  // rather than dropped. Without it, "76-1126" would render as "76" /
  // "1126" — two numbers with no apparent connection. The trailing
  // hyphen signals "this is one identifier that wrapped" — the
  // universal newspaper-typography convention.
  const idx = venue.indexOf('-');
  if (idx > -1) {
    const head = venue.slice(0, idx + 1); // include the hyphen
    const tail = venue.slice(idx + 1);
    return `${head}\n${tail}`;
  }
  // 3. No hyphen — return as-is; useFitText + CSS handle the rest.
  return venue;
}

// Pick the rendering strategy for a course-code-like token. Codes
// like "SWE 316" or "SWE 463" can collapse to "SWE316" at narrow
// widths (drop the space) or "S316" (drop the prefix's tail). We
// only have a few cases to worry about (the codes are short).
export function pickCodeRender(code, containerW, fontPx) {
  if (!code || !Number.isFinite(containerW) || containerW <= 0) return code || '';
  if (fits(code, fontPx, containerW)) return code;
  // "SWE 316" → "SWE316" (drop space).
  const noSpace = code.replace(/\s+/g, '');
  if (fits(noSpace, fontPx, containerW)) return noSpace;
  return code;
}
