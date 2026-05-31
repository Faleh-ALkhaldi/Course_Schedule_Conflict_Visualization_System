// NEW-FU-186 (Phase 77 REDESIGN): TRANSFORM-SCALE 2-D AUTO-FIT.
//
// The whole of Phases 66-76 sized each text token's FONT and hoped the layout
// followed — and every variant broke a different card shape (billboard on big,
// blank sides on wide, tiny on small, clip/overlap on dense), because no single
// font number can satisfy four card aspect-ratios at once. This rewrite inverts
// the approach: lay the content out ONCE at a fixed natural size, measure its
// real box, and apply a CSS `transform: scale()` so the content fits its card on
// BOTH axes simultaneously.
//
// Why this is robust where font-shrink was not:
//   • `transform: scale()` is a COMPOSITOR operation — pixel-identical in every
//     engine (no cqh/cqw container-query divergence, no clamp() resolution gap).
//   • Measurement uses `offsetWidth`/`offsetHeight` — per-element box metrics
//     that ARE reliable in WebKit (the bugs that burned us were `scrollHeight`
//     under-report in flex+overflow:hidden and `cqh` resolving against the
//     padding-shrunk content box — neither is used here).
//   • scale = min(availW/natW, availH/natH) ≤ both ratios ⇒ scaled content never
//     exceeds the card on either axis ⇒ CANNOT clip. (anti-clip by construction)
//   • scale is capped at MAX_S ⇒ CANNOT billboard. (anti-billboard by construction)
//   • scale grows to the binding edge ⇒ FILLS the card. (the user's "blank space")
//
// The content lives in a single `.sblock-fit` wrapper (SectionBlock.jsx). The
// corner chrome (§ number, LEC/LAB badge, ✕, conflict dots) are siblings of the
// wrapper — absolute on the card — so they are NOT scaled and never distort.
// availH reserves a chrome band top+bottom so the centred, scaled content can
// never reach the corner tags (chrome-collision-proof by construction).
//
// Wide-short cards (≥200px wide, ≤95px tall) get `.sb-wide`, whose CSS lays the
// content in a 2×2 grid (code|time / instr|venue) so the content's shape is wide
// — matching the box — and the SAME scale-to-fit then enlarges it to fill the
// width (fixes the "empty left & right"). Tiny cards (<46px tall or <60px wide)
// get `.sb-tiny`, which hides the corner tags (recoverable via the hover tooltip
// + sidebar) so the scaled content owns the whole box.

import { useEffect, useLayoutEffect } from 'react';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Scale bounds. The natural (unscaled) code font is 13px (CSS .sblock-fit
// .sblock-code). MAX_S 1.7 ⇒ displayed code ≤ ~22px on the biggest cards
// (confident, never a billboard). MIN_S 0.3 ⇒ displayed code ≥ ~3.9px on the
// densest sub-physical lanes (tiny but whole — "a smaller whole word beats a
// clipped one"). The scale formula already guarantees fit; these only bound the
// extremes.
const MAX_S = 1.7;
// LARGE near-square cards are split by class DURATION (zoom-invariant), not by
// pixel aspect (which drifts with zoom):
//   • MAX_S_GREEN — LONG classes (SWE 412, 160min, 268×338). A huge card would
//     billboard at MAX_S; even 1.12 still read a touch large, so Phase 79 Rule 2
//     lowers it to 0.92 (~12px code) per the user's "make green smaller". 2-col
//     layout keeps the width filled so the smaller type isn't a void.
//   • MAX_S_REDLARGE — SHORT large lectures (SWE 587/503, 75min, 268×157). These
//     were the SMALLEST red cards (~12.6px) because the 2-col layout pinned them
//     width-bound. Phase 79 Rule 1 flips them to 1-column (narrower stack ⇒ the
//     scale-to-fit enlarges it) and raises the cap to 1.45 (~18.9px) so they read
//     as the confident lectures the user wants — still < the 22px billboard line.
// NEW-FU-203 (Phase 80): SWE 412 (green) caps at ~1.0 → ~13px code, i.e. ~40%
// smaller than the uncapped 22px billboard it showed at max-zoom-out. Applied to
// the green card at EVERY zoom (course-based, no pixel-class dead zone).
const MAX_S_GREEN    = 1.0;
const MIN_S = 0.3;
const NAT_CODE_PX = 13; // must match the base font-size of .sblock-fit .sblock-code in CSS

export function useFitCard(cardRef) {
  useIsomorphicLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || typeof ResizeObserver === 'undefined') return undefined;

    function fit() {
      if (!card.isConnected) return;
      const fitEl = card.querySelector('.sblock-fit');
      if (!fitEl) return;

      const W = card.clientWidth;
      const H = card.clientHeight;
      if (!W || !H) return;

      // ── Shape classes (attributes → MutationObserver childList/characterData
      //    ignores them, so toggling can't re-fire fit()). ───────────────────
      const ar = W / H; // aspect ratio (width ÷ height)
      // NEW-FU-194 (Phase 78 cont.): a WIDE card is wide regardless of how SHORT
      // it gets. The bug the user saw ("2-column at some zooms, 1-column at max
      // zoom-out") was a rule-precedence collision: at the floor the red SWE 316
      // lecture is 268×37 — very wide (ar 7.24) but H<46, so the old `tiny` gate
      // (H<46 || W<60) marked it tiny, and `wide = !tiny && …` then KILLED its
      // 2-column layout. A wide-short card is the textbook 2-column case (use the
      // width, not a cramped vertical stack), so `tiny` must NOT swallow it.
      // FIX: compute the wide aspect first; a card is only `tiny` if it's small
      // AND not wide. Genuinely tiny = short/narrow with NO width to exploit.
      const wideShape = ar >= 2.0;                 // width clearly overpowers height
      const tiny = !wideShape && (H < 46 || W < 60); // tiny only if NOT a wide card
      // NEW-FU-191 (Phase 78 Rule 1+2): two-column (2×2 grid) layout is now
      // ASPECT-RATIO-driven, not just "short". Two distinct cases get .sb-wide:
      //   (a) WIDE cards — width overpowers height (ar ≥ 2.0). The red full-width
      //       lectures (SWE 316/101, measured 268×104, ar 2.58) waste huge
      //       horizontal blank in one column; 2 columns fills the width. The
      //       2.0 cut sits in a clean measured gap (real cards cluster at ar 1.71
      //       and 2.58; nothing between 2.0–2.5), and it EXCLUDES the near-square
      //       SWE 412 (ar 0.79) and the yellow 1.71 medium cards, which stay 1-col.
      //   (b) LARGE NEAR-SQUARE cards — big area AND ar in [0.6,1.7]. The green
      //       SWE 412 billboards in one column; 2 columns + the lower scale cap
      //       below makes it a refined card. Threshold set BY MEASURED DATA:
      //       across its zoom range SWE 412 spans area 33,768 (vp877, ar 2.13 —
      //       already caught by wideAR≥2.0) up to 90,584 (vp900, ar 0.79 —
      //       near-square, needs this rule). The largest SMALL near-square card
      //       that must STAY one-column is SWE 463 at 20,567 (131×157). 35,000
      //       sits in the clean empty gap between 20,567 and 90,584 — it catches
      //       big SWE 412 throughout its near-square range yet excludes every
      //       genuine small/medium near-square card. (Was 60,000, which sat above
      //       SWE 412's mid-zoom area so it missed the billboard at exactly the
      //       zoom the user flagged.)
      // wideAR uses wideShape (already excludes tiny by construction — a wide
      // card is never tiny now). largeSq stays !tiny-guarded.
      const wideAR  = wideShape;
      const largeSq = !tiny && W * H >= 35000 && ar >= 0.6 && ar <= 1.7;
      const wide = wideAR || largeSq;
      // NEW-FU-200 (Phase 79 Rule 1+2): split LARGE near-square cards by class
      // DURATION (published by SectionBlock as data-dur-min — zoom-invariant).
      //   • largeTall  = LONG class (≥110min: SWE 412 is 160min) → green: low cap,
      //                  keep the 2-column fill so the smaller type isn't a void.
      //   • largeWide  = SHORT large lecture (<110min: SWE 587/503 are 75min) →
      //                  red: 1-column (CSS) + the higher MAX_S_REDLARGE cap so the
      //                  evening lectures grow. 110 sits in the clean gap between
      //                  the 75-min and 160-min meetings, so the split never flips
      //                  with zoom (duration is fixed; pixel aspect is not).
      const durMin   = parseInt(card.dataset.durMin || '0', 10) || 0;
      // NEW-FU-203 (Phase 80): GREEN / RED emphasis is NO LONGER gated on the
      // pixel class (largeSq/wideAR) — that left a DEAD ZONE: at max-zoom-out SWE
      // 412 is aspect ~1.93, between largeSq (≤1.7) and wideAR (≥2.0), so it got
      // NO cap and billboarded at 22px. And SWE 412 (160min) vs SWE 206-14:00
      // (160min) are GEOMETRICALLY IDENTICAL, so neither aspect nor duration can
      // separate them — yet the user wants 412 smaller, 206 bigger. The only
      // distinguisher is the COURSE CODE, so GREEN is course-specific (the user's
      // own SWE 412 capstone card) applied at ANY size/zoom; every other non-tiny
      // lecture is RED (enlarged). Display-only, zoom-stable (no dead zones).
      const codeText = (card.querySelector('.sblock-code')?.textContent || '').trim();
      const isGreen = !tiny && codeText === 'SWE 412';
      const isRed   = !tiny && !isGreen;
      // NEW-FU-202 (Phase 79 Rule 3): PINNED-TAG mode — show the § + LEC/LAB badge
      // on the SMALL SQUARE dense cards at deep zoom-out, not just the narrow-TALL
      // ones. At max / near-max zoom the yellow cluster collapses to ~36×33–36×51
      // squares; the previous rule (narrow AND H≥58) dropped them to plain-tiny and
      // HID the tags — the user's "small square cards still have no tags at max /
      // near-max zoom". Generalise to ANY tiny card with enough height, and now
      // RESERVE a measured tag band in the fit (vBand below) so the centred text is
      // pushed clear of the pinned tags. Band-reserve REPLACES the old lucky-height
      // floor (H≥58, which only worked because tall cards happened to clear): with
      // the band reserved, the tags hold down to H≥33 on square cards too. The §
      // pins top-centre, the badge bottom-centre (CSS .sb-narrowtall) — both use
      // the card HEIGHT, so they never fight the horizontally-centred text. We keep
      // the class name `.sb-narrowtall` so the existing pinned-tag CSS applies
      // unchanged; the concept is now "tiny card that pins its tags".
      const pinnedTags = tiny && H >= 33;
      // The very shortest tagged cards (<40px) cannot seat the 4 text rows between
      // the bands even at MIN_S, so `.sb-pintiny` (CSS) shows the COURSE CODE only —
      // the card's identity — between the § and badge; time/instructor/venue live in
      // the hover tooltip. They are illegible specks at that size anyway, so dropping
      // them buys the room to keep the tags the user explicitly asked to see.
      const pinTiny = pinnedTags && H < 44;
      card.classList.toggle('sb-tiny', tiny);
      card.classList.toggle('sb-narrowtall', pinnedTags);
      card.classList.toggle('sb-wide', wide);
      // NEW-FU-203 (Phase 80): green = the user's SWE 412 (smaller cap below);
      // red = every other non-tiny lecture (CSS shrinks its secondary rows so the
      // course code scales up ~50% bigger). sb-pintiny/bigsq/widelarge retired —
      // pinned-tag tiny cards now always show COMPLETE rows with proportional tags.
      card.classList.toggle('sb-green', isGreen);
      card.classList.toggle('sb-red', isRed);

      // ── Chrome reserve. The § (top-right) and LEC/LAB badge (bottom-right)
      //    are absolute corner chrome. Reserving a band top+bottom keeps the
      //    centred, scaled content in the middle of the card, clear of the
      //    corners — chrome-collision-proof. Tiny cards hide the tags, so they
      //    need only a hairline margin. ───────────────────────────────────────
      const band = tiny ? 2 : Math.max(9, Math.min(20, Math.round(H * 0.18)));
      const padX = tiny ? 2 : Math.max(3, Math.min(6, Math.round(W * 0.03)));
      // Publish chrome size so the absolute ✕ / badge scale with the card (CSS
      // reads --sb-chrome-px). NEW-FU-198 (Phase 78 cont. Rule 4): cap raised
      // 20 → 24 so the enlarged ✕ can reach its bigger size on roomy cards. This
      // ONLY widens the ✕/badge published ceiling — it does NOT change `band`
      // (which still caps at 20 for the content vertical gutter, so content
      // height is unaffected). The ✕ is bottom-LEFT and the badge bottom-RIGHT,
      // both clear of the centred content, so a slightly bigger chrome value
      // can't collide with text.
      const chromePx = tiny ? 12 : Math.min(Math.max(band, Math.round(H * 0.20)), 24);
      card.style.setProperty('--sb-chrome-px', `${chromePx}px`);

      // NEW-FU-187 (Phase 77): MEASURED corner gutter. The §(top-right),
      // LEC/LAB badge(bottom-right) and conflict dots(top-left) are absolute
      // corner chrome. The scaled content is centred, so to guarantee it never
      // reaches a corner we reserve a SYMMETRIC horizontal gutter = the widest
      // visible tag's real offsetWidth + a gap (measure, don't estimate — a
      // "§F-04" chip is far wider than its height). Symmetric keeps the content
      // card-centred (no asymmetric offset). Tiny cards hide the tags (CSS), so
      // they reserve only a hairline. Reading offsetWidth of the CURRENT render
      // is a chicken-and-egg with --sb-code-px, but it's damped and the deferred
      // re-fits converge in 1-2 passes. This is what makes chromeCollision 0
      // without hiding the tags the user asked to keep visible.
      let tagReserve = 0;   // widest visible tag (horizontal gutter)
      let tagHeight = 0;     // tallest visible top/bottom tag (vertical band)
      if (!tiny) {
        ['.sblock-secnum', '.sblock-type-badge', '.sblock-dots'].forEach((sel) => {
          const e = card.querySelector(sel);
          if (e && getComputedStyle(e).display !== 'none') {
            tagReserve = Math.max(tagReserve, e.offsetWidth);
            tagHeight  = Math.max(tagHeight, e.offsetHeight);
          }
        });
      }
      const gutter = tiny ? 2 : Math.max(padX, tagReserve + 5);
      // NEW-FU-193 (Phase 78 R3): the vertical band must also CLEAR the corner
      // tags by MEASURE, not estimate. The § (top-right) and badge (bottom-right)
      // have a real rendered height; on a SHORT wide card (2-col grid) the
      // estimate band (H*0.18 ≈ 12px on a 64px card) was thinner than the § (≈14.5px
      // + its 3px top offset), so the grid's top row rose into the § (the measured
      // SWE 316 268×64 collision). Reserve the tag's real height + its 3px inset +
      // a 2px gap, exactly like the horizontal gutter — so top/bottom content can
      // never reach the tags on any card shape. Floor at the old band so tall
      // cards are unaffected.
      // NEW-FU-202 (Phase 79 Rule 3): a PINNED-TAG tiny card reserves a FIXED band
      // top+bottom so the centred text is pushed CLEAR of the § / badge. Fixed (not
      // measured) on purpose: the pinned tag font is a constant CSS px (7px on the
      // tall lanes, 6px on the .sb-pintiny squares), so a constant band is both
      // correct AND immune to the first-paint measurement race that made a measured
      // band resolve too small (code-only content then scaled up into the badge —
      // the 59×37 collisions). The band = tag pill height + a real 4px GAP, because
      // the centred content otherwise sits flush against the band edge (scale caps
      // height at availH, content spans exactly [band, H−band]) and sub-pixel
      // rounding turns a 0px gap into a 1px overlap. pintiny squares: 6px tag ⇒ 12;
      // taller narrow lanes: 7px tag ⇒ 14. Non-tagged tiny cards keep the hairline.
      // NEW-FU-203 (Phase 80): tiny pinned-tag cards reserve a band that scales
      // with card HEIGHT (≈12%, floored at 9px) — taller lanes seat the (now
      // PROPORTIONAL, ≤7px) pinned tags with a comfortable gap; shorter squares
      // reserve only what they need so the COMPLETE text keeps the most room.
      // NEW-FU-203 (Phase 80): RED cards reserve only the (now SMALL) tag's real
      // height + a 4px gap — NOT the larger content `band` floor — so the short
      // max-zoom-out lectures give the course code the maximum vertical room to
      // grow (~50% bigger) while still clearing the small §/badge. Green & others
      // keep the full band. Tiny pinned-tag cards unchanged.
      const vBand = tiny
        ? (pinnedTags ? Math.max(9, Math.round(H * 0.12)) : 2)
        : (isRed ? Math.max(8, tagHeight + 4) : Math.max(band, tagHeight + 5));

      const availW = Math.max(8, W - 2 * gutter);
      const availH = Math.max(8, H - 2 * vBand);

      // ── Measure the content at scale 1, then scale to fit both axes. ────────
      // Reset transform so offset* reports the natural (unscaled) box. The
      // wrapper is width:max-content (CSS), so offsetWidth = the widest row's
      // natural width and offsetHeight = the natural stacked/2×2 height — both
      // engine-reliable per-element metrics.
      fitEl.style.transform = 'translate(-50%, -50%) scale(1)';
      const natW = fitEl.offsetWidth;
      const natH = fitEl.offsetHeight;
      if (!natW || !natH) return;

      let s = Math.min(availW / natW, availH / natH);
      if (!isFinite(s) || s <= 0) s = 1;
      // NEW-FU-200 (Phase 79 Rule 1+2): the cap is duration-split for large
      // near-square cards (see largeTall/largeWide above). Green long card →
      // MAX_S_GREEN (smaller, refined); red short lecture → MAX_S_REDLARGE
      // (bigger); every other shape keeps the full MAX_S reach.
      let cap = MAX_S;
      if (isGreen) cap = MAX_S_GREEN;   // SWE 412 → ~40% smaller, at every zoom
      s = Math.max(MIN_S, Math.min(cap, s));

      // Apply the scale. translate(-50%,-50%) + the wrapper at top/left:50%
      // (CSS) centres it; transform-origin:center keeps it centred while scaled.
      // Round to 3 decimals to avoid sub-pixel transform churn between re-fits.
      const sr = Math.round(s * 1000) / 1000;
      fitEl.style.transform = `translate(-50%, -50%) scale(${sr})`;

      // Publish the DISPLAYED code px so the absolute corner chrome (§ / badge /
      // ✕, sized via calc(var(--sb-code-px) * factor) in CSS) tracks the card's
      // real typography. Displayed code = natural 13px × scale.
      card.style.setProperty('--sb-code-px', `${(NAT_CODE_PX * sr).toFixed(1)}px`);
    }

    // Deferred re-fits: the grid resolves overlapping-lane widths in a pass that
    // can run AFTER this layout effect, so the first fit() may measure a
    // pre-narrowed (wide) card. Re-running on the next frame + after layout
    // settles catches the straggler dense lanes. fit() is idempotent (it resets
    // the transform to scale 1 before measuring), so extra runs are safe.
    let rafId = 0;
    const schedule = () => { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(fit); };
    fit();                              // synchronous, pre-paint
    schedule();                        // next frame (after first paint)
    const t1 = setTimeout(fit, 120);   // after the grid's overlap pass
    const t2 = setTimeout(fit, 400);   // safety net for slow layout

    const ro = new ResizeObserver(schedule);
    ro.observe(card);
    const mo = new MutationObserver(schedule);
    // childList + characterData only — NOT attributes, so our own class/style
    // writes can't trigger a re-fire loop.
    mo.observe(card, { childList: true, characterData: true, subtree: true });

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(t1); clearTimeout(t2);
      ro.disconnect(); mo.disconnect();
    };
  }, [cardRef]);
}
