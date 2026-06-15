// NEW-FU-295 (Phase 59): adaptive per-element font sizing.
//
// Background: Phases 56–58 used a tier-class system computed from lane
// width in React (spacious / compact / tight / minimal / micro / tiny).
// Each tier picked one font size for every text node within. But two
// cards in the same tier can have wildly different content lengths
// (`MA` vs `MOHAMMAD ALSHAYEB`) — the tier rule applies the same font
// to both, so the long name hits `text-overflow: ellipsis` while the
// short name renders with empty space to spare.
//
// `useFitText` adds a per-element measurement pass that runs after the
// tier classes resolve. It reads the rendered text's `scrollWidth`
// against the container's `clientWidth`; if the text overflows, it
// shrinks the font size (via inline style) until it fits or hits a
// minimum floor.
//
// Why inline style instead of a CSS custom property:
//   • Inline styles beat tier-class rules without specificity wars.
//     The override is unconditional — we don't need to rewrite every
//     `.tier-X .sblock-Y { font-size: ... }` rule to reference a var.
//   • A future maintainer reading the DOM in DevTools sees the
//     computed override directly on the element, not hidden behind a
//     custom property indirection.
//
// Why binary search instead of linear shrink:
//   • 80+ cards on the schedule grid × ~18 candidate sizes (14px →
//     5px in 0.5px steps) = ~1440 layout reflows per resize, which
//     burns frames noticeably. Binary search cuts that to ~5 per
//     element ≈ 400 reflows, well under one frame's budget.
//
// Why ResizeObserver instead of a global resize listener:
//   • Cards resize when their lane redistributes (sibling added /
//     removed in a time slot), not just when the window resizes.
//     ResizeObserver fires for both cases automatically and is
//     debounced by the browser per animation frame.

import { useEffect, useLayoutEffect } from 'react';

// Use useLayoutEffect on the client (synchronous DOM access before
// paint) and fall back to useEffect during SSR so React doesn't warn.
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// NEW-FU-302 (Phase 62) → NEW-FU-305 (Phase 63): floor lowered
// 3 px → 2 px. Phase 63's "no mid-word break ever" rule means
// the font must shrink even further to fit single long words like
// "ALAAULDEEN" (10 chars) inside narrow tier-tiny lanes (12 px).
// At 2 px font × 0.55 ratio = 1.1 px/char, "ALAAULDEEN" needs
// 11 px — fits in a 12 px lane with 1 px margin. Below 2 px the
// font becomes a single-pixel stroke at non-retina, but for the
// rare cases where even 2 px doesn't fit, the parent's
// `overflow: hidden` clips at the card edge — strictly better
// than CSS engaging a mid-word break.
const DEFAULT_MIN_PX = 2;
// Tolerance for sub-pixel rounding. Without it, scrollWidth can
// exceed clientWidth by 0.5–1 px due to rounding even when the text
// visually fits, causing the hook to over-shrink.
const FIT_TOLERANCE_PX = 1;

/**
 * Shrink an element's font-size until its content fits horizontally.
 * Returns nothing — the hook mutates inline style on the element.
 *
 * `ref` — a React ref pointing at the text-bearing element.
 * `options.minPx` — floor for the shrink (default 2px). If the text
 *   still overflows at the floor, the hook stops and accepts the
 *   ellipsis-clip; the tooltip remains the authoritative source.
 */
export function useFitText(ref, options = {}) {
  const { minPx = DEFAULT_MIN_PX } = options;

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    function fit() {
      if (!el.isConnected) return;
      // Clear any previous override so we can read the natural size.
      el.style.fontSize = '';
      // Force a layout read; getComputedStyle is synchronous.
      const cs = getComputedStyle(el);
      const naturalSize = parseFloat(cs.fontSize);
      if (!Number.isFinite(naturalSize)) return;

      // NEW-FU-561 (audit P2-12): fit on BOTH axes. The SidePanel name spans WRAP
      // (line-clamped), so WIDTH never overflows and the hook used to no-op — long names
      // hit the clamp ellipsis instead of shrinking. The height term only bites when the
      // element has a CONSTRAINED height (clamp/fixed) that's exceeded; an unconstrained
      // element grows freely (scrollHeight == clientHeight) so nothing shrinks (no
      // over-shrink, so width-only callers are unaffected).
      const fits = () => el.scrollWidth  <= el.clientWidth  + FIT_TOLERANCE_PX
                      && el.scrollHeight <= el.clientHeight + FIT_TOLERANCE_PX;

      // Fits at natural size — nothing to do.
      if (fits()) return;

      // Binary-search the largest size in [minPx, naturalSize] that fits.
      let lo = minPx;
      let hi = naturalSize;
      while (hi - lo > 0.5) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = `${mid}px`;
        if (fits()) lo = mid;
        else hi = mid;
      }
      // Apply the floor of the binary-search interval — the largest
      // size confirmed to fit.
      el.style.fontSize = `${lo}px`;
    }

    fit();

    // ResizeObserver — fires when the container's measured size
    // changes (lane redistribution, window resize, zoom, etc.).
    const ro = new ResizeObserver(fit);
    ro.observe(el);

    // MutationObserver — fires when the text content changes
    // (instructor reassign, venue swap, course rename). Without
    // this, a card stays at its old computed font size after the
    // text changes, producing under-shrunk or over-shrunk results.
    const mo = new MutationObserver(fit);
    mo.observe(el, { childList: true, characterData: true, subtree: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [minPx, ref]);
}
