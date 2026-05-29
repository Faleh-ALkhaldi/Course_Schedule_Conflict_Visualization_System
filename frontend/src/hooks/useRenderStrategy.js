// NEW-FU-298 (Phase 60): React binding for the per-token content
// transform pipeline in utils/renderStrategy.js.
//
// Why a separate hook (not part of useFitText): useFitText shrinks the
// element's font. useRenderStrategy transforms the text *content*. The
// two operate at different layers — and they compose. Phase 60's
// architecture: the strategy picks the transformed string first
// (component renders it), the font-shrink hook then sizes the rendered
// text to its container. Trying to do both in one hook would conflate
// "size knob" with "content knob," and we'd lose the ability to add a
// third knob (e.g., vertical-orientation) without rewriting both.
//
// Container-size measurement uses ResizeObserver — same pattern as
// useFitText. Some redundant observation (two observers on the same
// element) is acceptable for clarity; the cost is negligible.
//
// NEW-FU-299 (Phase 61): font size is now READ from getComputedStyle,
// not passed as a caller hint. Phase 60 used a constant hint (5 px)
// chosen as the useFitText floor — that over-predicted that long names
// would fit at the floor, and the strategy picked wrap-at-space ("MAHMOOD
// \nNIAZI"). The actual rendered font was ~9.5 px (the tier's natural
// value before any shrink), at which "MAHMOOD" alone is ~37 px and won't
// fit in a 23 px container. CSS `overflow-wrap: anywhere` then engaged
// to char-break "MAHMOOD" into "MAH\nMOO\nD", and line-clamp:2 cut it
// to "MAH\nMOO" — the user saw mid-word "truncation."
//
// The fix is to read the computed font at decision time and feed it
// truthfully into the picker. Now `wrapAtFirstSpace` checks the
// longest word at the ACTUAL font and falls through to abbreviation
// when wrap-at-space won't survive (e.g., "MAHMOOD" at 9.5 px overflows
// a 23 px lane → strategy picks "M. NIAZI" instead).

import { useEffect, useLayoutEffect, useState } from 'react';

import {
  pickInstructorRender,
  pickVenueRender,
  pickCodeRender,
} from '../utils/renderStrategy.js';

// Use useLayoutEffect on the client so measurements happen before paint;
// fall back to useEffect during SSR.
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Map a `role` string to its picker. Lets the hook stay generic while
// the per-role behaviour lives in renderStrategy.js.
const PICKERS = {
  instructor: pickInstructorRender,
  venue:      pickVenueRender,
  code:       pickCodeRender,
};

// Default fallback font, used only if computed-style read fails (very
// rare — would mean the element isn't in the DOM yet at observer-fire
// time). 10 px is a sensible middle-of-the-road value across tiers.
const FALLBACK_FONT_PX = 10;

/**
 * `text`  — original string (untransformed; the tooltip caller should
 *           use this).
 * `ref`   — ref pointing at the element whose width we measure.
 * `role`  — 'instructor' | 'venue' | 'code'. Selects the picker.
 *
 * Returns the transformed display string. Before the ResizeObserver
 * fires (one frame after mount), returns the original text — the next
 * render then re-derives once measurements are in.
 */
export function useRenderStrategy(text, ref, role) {
  const picker = PICKERS[role] || ((t) => t);
  // Single state object so containerW + fontPx update together (one
  // render per measurement, not two).
  const [measurements, setMeasurements] = useState(null);

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;

    function measure() {
      if (!el.isConnected) return;
      // IMPORTANT: clear any inline font-size override before reading
      // the computed style. useFitText may have written one. We want
      // the natural cascade-resolved font so the strategy decides at
      // worst-case (pre-shrink) sizing. After we set the inline style
      // back, useFitText will re-run its own measurement.
      const inlineFont = el.style.fontSize;
      el.style.fontSize = '';
      const cs = getComputedStyle(el);
      const fontPx = parseFloat(cs.fontSize) || FALLBACK_FONT_PX;
      // Restore whatever useFitText had set, if anything.
      el.style.fontSize = inlineFont;
      setMeasurements({ w: el.clientWidth, fontPx });
    }

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  if (measurements == null) return text;
  return picker(text, measurements.w, measurements.fontPx);
}
