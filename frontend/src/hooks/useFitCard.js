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
// NEW-FU-216 (Phase 90): MIN_S floor lowered 0.30 → 0.25 (see the const below). The
// Phase-89 equal columns make the densest term-251/262 clusters ~32–40px wide; the
// longest instructor name ("MOHD SHAMEEM SALEEM", natW ~100–125px) needs scale ~0.28
// to fit, which the old 0.30 floor clamped away → a ~2px clip (Phase 89 "fixed" it by
// hiding the text, which the user rejected). 0.25 ⇒ displayed code ≥ ~3.25px — tiny
// but WHOLE and clip-free, exactly the floor's stated purpose. Only cards that
// naturally want < 0.30 are affected (the few longest-content narrow cards); every
// other card fits above the floor and is unchanged.
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
const MIN_S = 0.25;   // NEW-FU-216 (Phase 90): 0.30 → 0.25, see note above MAX_S
// NEW-FU-218 (Phase 92): anti-pulse hysteresis threshold. The corner-tag gutter
// (tagReserve) is measured from the §/badge offsetWidth, whose font-size derives from
// --sb-code-px = this fit's OWN output → a feedback loop. In Overview it converges in
// 1–2 passes; at Readable-mode card sizes it settles into a stable 2-cycle (scale
// flipping ~0.720↔0.737 forever = the visible "pulsing"). If a re-fit's new scale is
// within SCALE_EPS of the one already applied, we KEEP the applied one (below), so
// --sb-code-px stops changing, the tag stops resizing, and the loop can't re-trigger.
// 0.02 > the measured 0.017 cycle amplitude; a 0.02 scale step is ≤0.3px of code —
// imperceptible — and real changes (resize, mode switch) exceed it and still apply.
const SCALE_EPS = 0.02;
const NAT_CODE_PX = 13; // must match the base font-size of .sblock-fit .sblock-code in CSS
// NEW-FU-372 (Phase 98 item 1): anti-billboard ceiling for ROOMY / low-density
// cards. In a SPARSE term (few courses ⇒ each card is large with whitespace to
// spare) the natural content is SMALLER than the card, so the scale-to-fit `s`
// exceeds 1.0 (sFit > 1) and the grow lifts it to the general MAX_CODE_PX
// ceiling. DENSE terms (251/262) are the opposite regime: their cards are
// fit-bound (sFit < 1, content overflows ⇒ s shrinks), so they NEVER reach
// this ceiling and stay byte-for-byte unchanged. Gated purely on sFit > 1, so
// it is a one-way upper clamp — no feedback into natW/natH, no pulse, no
// dense-term effect.
// NEW-FU-491 (Phase 119 item 1): user requested ~1.6× larger text on the roomy
// morning UG cards in term 271 (cards were physically large but code read tiny
// at the 14px cap). 14 × 1.6 ≈ 22px; MAX_CODE_PX also raised 16 → 22 so the
// outer ceiling no longer binds before this constant can take effect.
// Dense-term cards are unaffected (sFit < 1, bounded by sFit — never reach the
// MAX_CODE_PX ceiling). isMatchTarget cards remain bounded by the live green
// reference px (--sb-green-ref-px), which is ≤ 16 px, so they are unchanged.
const ROOMY_CODE_PX = 22;

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
      // NEW-FU-218 (Phase 92): READABLE mode runs the BASE fit only — scale the content
      // to fill the (uniform, fixed-size) card, clamp, done. ALL the Overview emphasis
      // tuning (the grow, per-group caps, the green haircut, the green-ref broadcast,
      // the red fill-boost) is SKIPPED in Readable: it's Overview aesthetics, it makes
      // text non-uniform, and its fill-measured grow is a feedback loop that oscillated
      // (the "pulsing") at Readable's roomy card sizes. SectionBlock publishes the mode
      // NEW-FU-221 (Phase 95): UNIFORM typography is decoupled from the readable LAYOUT.
      // A card carries data-uniform-type="1" whenever it should render fixed, uniform
      // fonts — i.e. Course-View Readable mode AND the Instructor/Venue views (no overlaps
      // → they use the OVERVIEW layout but still want uniform per-duration typography).
      // Course-View Overview is uniform=false → the content-fit path, byte-for-byte
      // unchanged (every gate below is `!uniform`). (Formerly `readable`/data-view-mode.)
      const uniform = card.dataset.uniformType === '1';
      // NEW-FU-205 (Phase 82): FOUR course-keyed emphasis groups, replacing the
      // Phase-80 green/red pair. The user's visual highlight groups cut across the
      // geometry classes and a course can render BOTH big and tiny at once (SWE
      // 587/503/387 are big evening lectures AND tiny morning-cluster cards), so
      // the selector is COURSE CODE + the tiny flag, with a strict precedence:
      //   1. tiny  → YELLOW handling (the pinned-tag dense cluster; gets a small ✕
      //              added below). Checked FIRST, so a tiny instance of any course
      //              follows yellow regardless of its code — the user confirmed the
      //              dense ~45px cluster is always yellow.
      //   2. SWE 412 (non-tiny) → BLUE: typography + ✕ ~25% SMALLER; tags unchanged.
      //   3. SWE 587/503/387 (non-tiny) → GREEN: typography ~45% SMALLER, tags +70%,
      //      ✕ +45% (the tan evening/long lectures).
      //   4. every other non-tiny lecture → RED: typography/tags/✕ grow, scaled by
      //      how UNDER-FILLED the card is (geometry-driven, see --sb-fill below).
      // Zoom-stable (course identity never changes) and dead-zone-free.
      const codeText = (card.querySelector('.sblock-code')?.textContent || '').trim();
      const GREEN_CODES = ['SWE 587', 'SWE 503', 'SWE 387'];
      const isBlue  = !tiny && codeText === 'SWE 412';
      const isGreen = !tiny && GREEN_CODES.includes(codeText);
      const isRed   = !tiny && !isBlue && !isGreen;
      // NEW-FU-213 (Phase 88): the user's "blue" set that must MATCH the green SWE
      // 387 reference size = SWE 412 + SWE 503 (SWE 316/101 already match green via
      // the Phase-87 shortwide 14px cap). 412/503 currently hit the 16px ceiling
      // (their shorter instructor names let the fit scale higher than 387's), so
      // they read ~1.6px LARGER than green. Marking them lets the cap below pull
      // them down to green's ~14px. SWE 587/387 stay green (NOT in this set) — 587
      // isn't highlighted and 387 IS the reference, so neither changes.
      // NEW-FU-214 (Phase 88 R2): the full BLUE set that matches the green reference,
      // keyed by COURSE CODE (identity), not geometry. R1 gated SWE 316/101 on a
      // fragile `isShortWide` height threshold (H<52) — but at a larger viewport
      // those rows grow to H=53, fall out of the gate, lose the cap and read 16px
      // (measured mismatch). Keying on the code makes the match hold at EVERY
      // viewport. SWE 412 + 503 + 316 + 101 → match green; 387 is the reference,
      // 587 is unhighlighted — neither is in this set.
      const MATCH_GREEN_CODES = ['SWE 412', 'SWE 503', 'SWE 316', 'SWE 101'];
      const isMatchGreen = !tiny && MATCH_GREEN_CODES.includes(codeText);
      // NEW-FU-214 (Phase 88 R2): SWE 387 (non-tiny) is the GREEN REFERENCE whose
      // live rendered code-px the blue cards match. It publishes --sb-green-ref-px
      // to :root after its own fit (below). Only the big 387 instance is the
      // reference (a tiny 387 in a dense lane must not hijack the reference).
      // NEW-FU-215 (Phase 89): the reference must be the SINGLE prominent SWE 387
      // block. `!tiny` drops the dense §F tutorial 387s, but NOT a medium half-width
      // 387 — and with the Phase-89 EQUAL columns a 2-lane Thursday 387 (~113px)
      // started publishing too and (last-writer-wins) hijacked --sb-green-ref-px to
      // ~5.5px, so the blue cards capped there while the big green rendered ~10px
      // (broken match). Gate on FULL-COLUMN width (this 387 fills ~all of its day
      // column → it's the 1-lane lecture, the visual reference the user means), so
      // exactly one 387 publishes. Viewport-relative, no race; if two days ever have
      // a full-column 387 they're the same width → same px → agree anyway.
      const col387 = card.closest('.sg-day-col');
      const isFullCol = !!col387 && col387.clientWidth > 0 && W / col387.clientWidth > 0.85;
      const isGreenRef = !tiny && isFullCol && codeText === 'SWE 387';
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
      // NEW-FU-216 (Phase 90): Phase-89 made the dense equal-column clusters code-only
      // (`.sb-pintiny`, W<46) to dodge a ~2px instructor clip — but that violated the
      // "every field visible on every card" contract; the user wants the time/instr/
      // venue back. Reverted to the original short-square trigger (H<44), which is
      // DORMANT at the locked zoom (tiny cards are ≥47px tall). The narrow cards now
      // keep all fields; the marginal clip is fixed instead by reclaiming the corner-
      // tag gutter on narrow cards + a slightly lower scale floor (see below).
      const pinTiny = pinnedTags && H < 44;
      card.classList.toggle('sb-tiny', tiny);
      card.classList.toggle('sb-narrowtall', pinnedTags);
      // NEW-FU-216 (Phase 90): NO code-only. Phase 89 wired `.sb-pintiny` to strip
      // the dense equal-column cards to course-code-only, but that broke the "every
      // field visible on every card" contract — the user wants the time/instructor/
      // venue back. The class stays UNtoggled (back to its pre-Phase-89 dormant
      // state). The marginal instructor clip those narrow cards had is handled by the
      // lower MIN_S floor instead (see the scale clamp) — a smaller WHOLE word beats a
      // clipped one, and beats hiding the word entirely.
      card.classList.toggle('sb-wide', wide);
      // NEW-FU-205 (Phase 82): four course-keyed emphasis classes (see the ladder
      // above). CSS reads these for per-group tag/✕/secondary-row sizing; the JS
      // cap below reads the booleans for per-group typography scale.
      card.classList.toggle('sb-blue',  isBlue);   // SWE 412 — type & ✕ smaller
      card.classList.toggle('sb-green', isGreen);  // 587/503/387 — type smaller, tags/✕ bigger
      card.classList.toggle('sb-red',   isRed);    // other lectures — grow by under-fill
      // NEW-FU-212 (Phase 87): SHORT-WIDE red lectures (SWE 316/101 morning rows —
      // wide 2-col cards under ~52px tall). The user wants their CODE to read as big
      // as the green SWE 387 block, but they are HEIGHT-bound (~30px tall) so a
      // 2-row stack pins the code small. Mark them so CSS can shrink the SECONDARY
      // rows hard (freeing vertical room for the code to scale up) while keeping all
      // 4 rows visible — the user chose "keep 4 rows, grow as much as fits". Keyed
      // on geometry (red + wide + short), so it tracks these cards at any zoom.
      card.classList.toggle('sb-shortwide', isRed && wide && H < 52);
      // NEW-FU-206 (Phase 83): YELLOW ✕ — re-shown on the tiny pinned-tag cluster,
      // sharing the bottom band with the (shrunk, right-pinned) LEC/LAB badge.
      //
      // CROSS-BROWSER ROOT-CAUSE FIX: the Phase-82 gate was `tiny && pinnedTags &&
      // H >= 44`. That extra `H >= 44` float threshold was REDUNDANT — at the
      // locked zoom every tiny card is ≥47px, and `pinnedTags` is already `tiny &&
      // H >= 33`, so the same set of cards satisfied all three. But the 47px cards
      // sit only ~3px above 44, and WebKit's sub-pixel grid/flex rounding can render
      // that same card a hair shorter than Chromium → it falls below 44 → `.sb-
      // yellowx` never toggles → the `.sb-tiny:not(.sb-yellowx)` rule HIDES the ✕.
      // That is exactly the "✕ in Chrome, missing in Safari" bug. Removing the
      // fragile threshold makes `.sb-yellowx` track `pinnedTags` EXACTLY — one
      // condition, engine-agnostic (offsetHeight≥33 is a wide margin, not a knife-
      // edge), so Chrome and Safari toggle the class identically. No card is lost:
      // nothing renders between 33 and 47px, so there was nothing the 44 gate
      // protected. (If a genuinely-too-short card ever appears, the badge-shrink +
      // bottom-left placement already keeps the ✕ collision-free; and pinnedTags is
      // itself the "has room for tags" signal, so it's the right gate for "has room
      // for a ✕ beside them" too.)
      card.classList.toggle('sb-yellowx', pinnedTags);

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
      let tagInnerEdge = W;  // NEW-FU-210: smallest LEFT edge of any right-corner tag
      //                        (how far IN from the card's right side the tags reach)
      if (!tiny) {
        const cr = card.getBoundingClientRect();
        ['.sblock-secnum', '.sblock-type-badge', '.sblock-dots'].forEach((sel) => {
          const e = card.querySelector(sel);
          if (e && getComputedStyle(e).display !== 'none') {
            tagReserve = Math.max(tagReserve, e.offsetWidth);
            tagHeight  = Math.max(tagHeight, e.offsetHeight);
            // measure the tag's left edge relative to the card (the § / badge sit
            // top-right / bottom-right, so their LEFT edge is how far the corner
            // chrome intrudes from the right). dots are top-LEFT — ignore for this.
            if (sel !== '.sblock-dots') {
              const er = e.getBoundingClientRect();
              tagInnerEdge = Math.min(tagInnerEdge, er.left - cr.left);
            }
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
      let vBand = tiny
        ? (pinnedTags ? Math.max(9, Math.round(H * 0.12)) : 2)
        : (isRed ? Math.max(8, tagHeight + 4) : Math.max(band, tagHeight + 5));
      // NEW-FU-218 (Phase 92): in Readable, vBand uses ONLY the H-based `band` — never
      // `tagHeight` (which tracks --sb-code-px = scale) — so availH is scale-INDEPENDENT,
      // a prerequisite for a stable, non-pulsing fit. `band` (~H×0.18 ≈ 17px) already
      // clears the small corner §/badge. The scale-dependent band-RECLAIM below is also
      // skipped in Readable (its clearOfTags test is the main pulse driver).
      if (uniform && !tiny) vBand = band;

      // NEW-FU-210 (Phase 85): RECLAIM the over-conservative vertical band on cards
      // where the corner tags are HORIZONTALLY clear of the centred content. The
      // band reserves top+bottom strips so the centred text never collides with the
      // top-right § / bottom-right badge. But on a WIDE card the content is centred
      // and NARROW (e.g. SWE 316: content ~105px wide, centred in 303px) while the
      // tags sit far right (left edge ~283px) — they are ~78px apart HORIZONTALLY,
      // so the content can grow vertically into the corner rows WITHOUT ever
      // reaching the tag column. In that case the band is unused space blocking the
      // size grow (exactly the Phase-84 SWE 316/101 cap). Measure it: if the
      // content, even after a generous grow, stays left of the tag's inner edge
      // with margin, drop the band to a hairline so availH ≈ full card height.
      // self-limiting — a card whose content DOES reach the tag column keeps the
      // full band, so this can never re-create a collision. Only for non-tiny,
      // non-pinned cards; tiny/pinned keep their fixed band.
      if (!tiny && !uniform) {
        // natW here is the unscaled content width; after the grow the scaled content
        // half-width is ≈ (natW * sFit * growMax)/2 around the card centre. Use a
        // generous growMax (1.4) so the guard is conservative. If the content's
        // right edge stays >= 6px left of the tag inner edge, the band is free.
        // (sFit isn't computed yet here — use the natural-fit upper bound availW/natW
        //  capped at MAX_S; recomputed precisely below, this is the safety estimate.)
        const fitEl0 = fitEl;
        const prevT = fitEl0.style.transform;
        fitEl0.style.transform = 'translate(-50%, -50%) scale(1)';
        const natW0 = fitEl0.offsetWidth;
        const natH0 = fitEl0.offsetHeight;
        fitEl0.style.transform = prevT;
        // NEW-FU-212 (Phase 87) FIX: estimate the grown content width at the scale
        // the card will ACTUALLY reach — the min of the width- AND height-available
        // scales — NOT the width-only MAX_S. The Phase-85 guard used the width scale
        // alone, so on a HEIGHT-bound short-wide card (SWE 316: 266×30) it assumed
        // the content could grow to ~1.7× width (285px right edge) and refused to
        // reclaim — even though height actually caps the scale near ~0.5, keeping the
        // content's right edge at ~160px, a full 90px clear of the tags. Using the
        // true binding scale lets the reclaim fire on exactly these cards. The band
        // we're about to reclaim is the OLD availH; use the pre-reclaim availH for
        // the height term so the estimate is conservative (real availH only grows).
        const availH_preReclaim = H - 2 * vBand;
        const estScaleW = (W - 2 * gutter) / Math.max(1, natW0);
        const estScaleH = availH_preReclaim / Math.max(1, natH0);
        const estScale = Math.min(MAX_S, estScaleW, estScaleH);
        const grownHalfW = (natW0 * estScale * 1.4) / 2;
        const contentRightEdge = W / 2 + grownHalfW;
        const clearOfTags = contentRightEdge <= (tagInnerEdge - 6);
        if (clearOfTags) {
          // tags don't threaten the centred content vertically → reclaim the band,
          // keep only a 2px hairline so the content can use ~full card height.
          vBand = 2;
        }

        // NEW-FU-211 (Phase 86): a horizontal GUTTER reclaim was TESTED here (twin of
        // the vertical band reclaim) to unblock the WIDTH-bound afternoon reds
        // (206/413/463). It worked but produced UNEVEN, overshooting results
        // (SWE 206 jumped +62–115% while 463/413 stayed flat) because reclaiming the
        // full gutter on a tall card opens far more width than a clean +20–35% needs,
        // and bounding it back to target proved circular. Reverted to avoid stacking
        // a 7th interacting lever (systematic-debugging: 3+ fixes each revealing a
        // new problem ⇒ stop, don't keep patching). The afternoon/wide reds that sit
        // at a genuine fit ceiling are reported as CAPPED (see MANIFEST); the clean,
        // in-range win this round is the evening blocks via the grow-band raise.
      }

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
      // NEW-FU-205 (Phase 82): per-group typography cap.
      //   • BLUE (SWE 412): ~25% smaller than its Phase-80 size. It was capped at
      //     MAX_S_GREEN 1.0 (13px); ×0.75 → 0.75 cap (~9.7px).
      //   • GREEN (587/503/387): ~45% smaller. They were uncapped lectures hitting
      //     ~20-22px; cap at MAX_S_GREEN45 0.58 (~7.5px ≈ 0.55× of 13.7 natural,
      //     ≈ 45% down from the ~20px they showed). The CSS also restores their
      //     secondary rows (un-does the red shrink) so the WHOLE block scales down.
      //   • RED: no LOWER cap change — they GROW. The growth is delivered by the
      //     CSS secondary-row shrink (already present) PLUS the --sb-fill-driven tag
      //     bump below; typography rises because the shared scale grows. Keep MAX_S.
      // BLUE 412 was 13px (cap 1.0); ×0.75 → 9.7px ≈ −25%. GREEN 587/503 were
      // ~20-22px UNCAPPED (hit the scale ceiling), so a cap doesn't cut a clean
      // 45%; instead apply a relative haircut: take the natural fit `s` and scale
      // it to 0.55× (≈ −45%) for green, then clamp. This tracks the real rendered
      // size down by the requested fraction regardless of the uncapped start.
      // NEW-FU-207 (Phase 84): 412's cap raised 0.75 → 0.98 so the Phase-84 grow can
      // lift it ~20–35% from its current ~9.8px. 0.98 → ~12.7px max, still far below
      // the ~22px billboard Phase 80 fixed (the user confirmed walking back part of
      // the shrink is intentional; this is the capped value for the billboard-risk
      // card). The grow's own re-clamp to sFit still applies on top.
      // NEW-FU-211 (Phase 86): 412's cap raised 0.98 → 1.25 for the second grow
      // round (~+25% from its current 12.7px → ~16px). Still under the old ~22px
      // billboard line Phase 80 fixed; cap-and-report if the fit can't reach it.
      const MAX_S_BLUE = 1.25;
      const sFit = s;              // the NATURAL fit ceiling (largest scale that fits)
      let cap = MAX_S;
      if (!uniform && isBlue) cap = MAX_S_BLUE;
      if (!uniform && isGreen) s = s * 0.55;   // ~45% smaller than the natural fit (Phase 82) — Overview only
      s = Math.max(MIN_S, Math.min(cap, s));

      // ── NEW-FU-207 (Phase 84): GROW the roomy "red" cards' typography ~20–35%,
      //    scaled by TWO measured signals (more of either → bigger grow):
      //      • BLANK AREA — how under-filled the card is. blank = 1 − fillFrac,
      //        where fillFrac = scaled content area ÷ card area (computed below).
      //      • CLIP-HEADROOM — how far the card renders BELOW its natural-fit
      //        ceiling sFit. head = (sFit − s)/sFit. A card already at its fit has
      //        head≈0 (no room to grow the code without clipping); a card shrunk by
      //        a cap (412) or the green haircut (587/503/387) has lots of head.
      //    The user's "red" set = every roomy non-tiny card EXCEPT the dense tiny
      //    cluster, INCLUDING 412/587/503/387 which earlier phases shrank (the user
      //    confirmed walking that back is intentional). So the grow applies to all
      //    non-tiny cards here; tiny cards never reach this branch's grow.
      //    grow ∈ [1.20, 1.35] mapped from the COMBINED signal; then folded into s
      //    and RE-CLAMPED against sFit (the clip ceiling) and the per-group cap, so
      //    a card physically cannot grow past where its text would clip — clip-safe
      //    by construction. The course code is prioritised on wide 2-col cards via
      //    the CSS secondary-row easing (see SectionBlock.css NEW-FU-207).
      let growApplied = 1;
      if (!tiny && !uniform) {
        const fr0 = fitEl.getBoundingClientRect();
        const fillNow = (fr0.width * fr0.height) / (W * H);
        const blank = Math.max(0, Math.min(1, 1 - fillNow));        // 0..1, bigger = emptier
        const head  = sFit > 0 ? Math.max(0, (sFit - s) / sFit) : 0; // 0..1, bigger = more clip room
        // Combine: weight blank and head, normalise to a 0..1 "roomScore". Both our
        // signals run high on the roomy cards (fill 0.06–0.28 → blank 0.72–0.94; the
        // shrunk cards add head 0.25–0.45), so use the MAX of the two so either one
        // being high lifts the grow (per the user's "more of EITHER → bigger").
        const roomScore = Math.max(blank, head * 1.4);              // head scaled so its smaller range still reaches high
        // NEW-FU-211 (Phase 86): SECOND grow round — another ~20–35% on top of the
        // Phase-85 grow, per the user. The grow is COMPOUND: round-1 was 1.20–1.35,
        // a second ~1.20–1.35 → cumulative ~1.44–1.82. Raised the band to
        // 1.45–1.80. The clip-safe re-clamp to sFit/cap still binds, so cards with
        // NO remaining headroom (the pinned reds) simply stay put — only cards with
        // room (the greens) actually grow further; the other levers below lift the
        // pinned reds' ceiling so they can use this bigger grow.
        const GROW_MIN = 1.45, GROW_MAX = 1.80;
        const grow = GROW_MIN + (GROW_MAX - GROW_MIN) * Math.max(0, Math.min(1, roomScore));
        // Fold grow into s, then RE-CLAMP to FOUR bounds:
        //   • sFit  — the clip ceiling (never exceed the natural fit) [clip-safe]
        //   • cap   — the per-group MAX_S
        //   • MAX_CODE_PX/13 — an ABSOLUTE displayed-code ceiling. NEW-FU-211: the
        //     Phase-86 gutter reclaim can open huge availW on a tall card (SWE 206
        //     96×157), which let s*grow run past the target. This ceiling caps the
        //     displayed code; roomy non-isMatchTarget cards land at ~22px (Phase 119
        //     item 1); isMatchTarget cards are bound by the green reference px instead.
        // NEW-FU-212 (Phase 87): the SHORT-WIDE blue cards (SWE 316/101) get a
        // SLIGHTLY LOWER code ceiling (14px vs the general 16px) so they MATCH the
        // green SWE 387 reference (~14.4px) rather than peg the 16px cap and exceed
        // it. The user asked for these to match green's size, not surpass it. The
        // band-reclaim above frees the vertical room to reach ~14px on a 30px card;
        // this ceiling stops it there. 14px is viewport-robust: green is fit-bound
        // around the same value at every locked-zoom viewport, so blue tracks it.
        // NEW-FU-214 (Phase 88 R2): MATCH-GREEN by LIVE RELATIONSHIP, not a frozen px.
        // The blue cards (412/503/316/101, all in MATCH_GREEN_CODES) must render
        // their code at the SAME px as the green SWE 387 reference. Green's size is
        // CONTENT- and VIEWPORT-driven (its long instructor name + the card ratio fix
        // its fit), so it MOVES with the window — a hardcoded 14px (R1) only matched
        // at one viewport and drifted everywhere else (measured: green 13.44px vs the
        // 14px-capped blue at 1900px). Instead: the green reference publishes its
        // rendered code-px to :root (--sb-green-ref-px, below), and the blue cards
        // cap at THAT live value. Default 16 (= the general ceiling) until green has
        // published, so a blue card that fits before green simply uses the normal
        // cap; the deferred re-fits (rAF/120/400ms/ResizeObserver) then re-run it
        // after green publishes → converges to the live match within a frame or two.
        // The blue match set is now keyed purely on course code (isMatchGreen),
        // so it can't fall out at large viewports the way the old H<52 gate did.
        // (Phase 119: the general ceiling was raised 16 → 22, but isMatchTarget
        // keeps its conservative 16 fallback — it stays bounded by the live green
        // reference regardless of the general ceiling.)
        const isMatchTarget = isMatchGreen;
        // NEW-FU-491 (Phase 119 item 1): raised 16 → 22 so roomy-morning cards
        // can reach ~22px (1.6× their former 14px). Dense cards are sFit-bound
        // and can never reach this ceiling regardless. MAX_S = 1.7 ⇒ max code
        // = 1.7 × 13 = 22.1px — the 22 here sits just below that hard cap.
        let MAX_CODE_PX = 22;  // general anti-billboard ceiling
        if (isMatchTarget) {
          const ref = parseFloat(
            (typeof document !== 'undefined' &&
              getComputedStyle(document.documentElement).getPropertyValue('--sb-green-ref-px')) || ''
          );
          MAX_CODE_PX = (isFinite(ref) && ref > 0) ? ref : 16;
        }
        // NEW-FU-372 (Phase 98 item 1) / NEW-FU-491 (Phase 119 item 1):
        // roomy / low-density cards (sFit > 1 — sparse term like 271) are capped
        // at ROOMY_CODE_PX (now 22px ≈ 1.6× the former 14px cap; see constant
        // above). Greens already cap via s*0.55 and are excluded; DENSE cards
        // (251/262) are fit-bound (sFit < 1) and never reach this ceiling, so
        // they are unchanged. isMatchTarget cards are bound by the green ref px
        // (set above), which is lower — so they too are unchanged. Pure upper
        // clamp ⇒ no feedback loop.
        if (!isGreen && sFit > 1) MAX_CODE_PX = Math.min(MAX_CODE_PX, ROOMY_CODE_PX);
        const grown = Math.min(s * grow, sFit, cap, MAX_CODE_PX / NAT_CODE_PX);
        growApplied = s > 0 ? grown / s : 1;
        s = Math.max(MIN_S, grown);
      }

      // NEW-FU-219 (Phase 93): READABLE typography is UNIFORM — every card uses the
      // SAME fixed scale (1), not a content-fitted one. Same-duration cards have the
      // same box (Phase 92) AND now the same font sizes for code/time/instr/venue
      // regardless of text length (the fit otherwise shrank long-name cards smaller).
      // Overflowing text wraps/ellipsizes in CSS (the uniform rows are width-bounded)
      // — it is never shrunk. This also removes the last content→scale coupling, so it
      // can't pulse. Overview keeps the content-fit `s`.
      if (uniform) s = 1;
      // Apply the scale. translate(-50%,-50%) + the wrapper at top/left:50%
      // (CSS) centres it; transform-origin:center keeps it centred while scaled.
      // Round to 3 decimals to avoid sub-pixel transform churn between re-fits.
      const sr = Math.round(s * 1000) / 1000;
      // NEW-FU-218 (Phase 92): anti-pulse hysteresis (see SCALE_EPS note). Keep the
      // previously-applied scale when the new one is within SCALE_EPS, so the published
      // --sb-code-px below doesn't change → the corner tag doesn't resize → the
      // tagReserve feedback 2-cycle can't re-trigger. `srFinal` (not `sr`) is what we
      // apply AND publish, so every downstream value is the stable one.
      const prevSr  = parseFloat(card.dataset.sbFitScale || '');
      const srFinal = (isFinite(prevSr) && Math.abs(sr - prevSr) < SCALE_EPS) ? prevSr : sr;
      card.dataset.sbFitScale = String(srFinal);
      fitEl.style.transform = `translate(-50%, -50%) scale(${srFinal})`;
      card.style.setProperty('--sb-grow', growApplied.toFixed(3));

      // NEW-FU-214 (Phase 88 R2): the GREEN REFERENCE (SWE 387) publishes its live
      // rendered code-px to :root so the blue match-cards can cap at it (read above).
      // Displayed code = natural 13px × the applied scale. Only publish when it
      // actually changed, to avoid churning style on every re-fit. A blue card's
      // deferred re-fits pick this up after green settles → viewport-relative match.
      if (!uniform && isGreenRef && typeof document !== 'undefined') {
        const refPx = (NAT_CODE_PX * srFinal).toFixed(1);
        const root = document.documentElement;
        if (root.style.getPropertyValue('--sb-green-ref-px') !== `${refPx}px`) {
          root.style.setProperty('--sb-green-ref-px', `${refPx}px`);
        }
      }

      // Publish the DISPLAYED code px so the absolute corner chrome (§ / badge /
      // ✕, sized via calc(var(--sb-code-px) * factor) in CSS) tracks the card's
      // real typography. Displayed code = natural 13px × scale.
      // NEW-FU-218 (Phase 92): in Readable, FREEZE --sb-code-px at the natural code px.
      // Several CSS rules derive font-sizes from it — not just the corner §/badge but
      // SECONDARY CONTENT ROWS (instr/venue: `calc(var(--sb-code-px) * …)`). When it
      // tracked the live scale, those fonts changed → the measured natural content
      // width (`.sblock-fit` offsetWidth) changed → the fit oscillated (the pulsing).
      // Frozen, every measured size is constant → the fit converges to ONE scale. This
      // is THE fix that stops the pulse (the grow/band gates above are for uniformity).
      // Overview keeps the live value so its chrome tracks the real displayed code px.
      card.style.setProperty('--sb-code-px', `${(uniform ? NAT_CODE_PX : NAT_CODE_PX * srFinal).toFixed(1)}px`);

      // NEW-FU-205 (Phase 82): publish an UNDER-FILL boost for RED cards. The user
      // wants red type/tags/✕ to grow MORE the more empty the card is: ~30% when
      // fairly full, up to ~65% when very under-filled. Fill = scaled content area
      // ÷ card area (after the scale is applied, so it's the REAL occupancy). Map
      // fill→boost linearly and clamp: fill 0.45 (fairly full) → 1.30, fill ≤0.12
      // (very empty) → 1.65. The CSS multiplies the red tag/✕ factors by this var,
      // and a matching CSS secondary-row nudge lets the typography ride the same
      // signal. Only meaningful on red (others ignore the var).
      if (!uniform && isRed) {
        const r = fitEl.getBoundingClientRect();
        const fillFrac = (r.width * r.height) / (W * H);
        // linear: fill 0.45→1.30, 0.12→1.65; clamp to [1.30, 1.65]
        const boost = Math.max(1.30, Math.min(1.65, 1.30 + (0.45 - fillFrac) * (0.35 / 0.33)));
        card.style.setProperty('--sb-fill-boost', boost.toFixed(3));
      } else {
        card.style.setProperty('--sb-fill-boost', '1');
      }
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

    // NEW-FU-209 (Phase 85): re-fit once the card web font (JetBrains Mono) loads.
    // The font loads async with display=swap, so the first fit() measures the
    // FALLBACK system-mono metrics; when JetBrains Mono swaps in, glyph advances
    // change → natW/natH change. document.fonts.ready resolves after web fonts
    // settle; re-running fit() then re-measures and re-scales against the real
    // metrics, so the swap can't leave stale sizing or a clip. Guarded for SSR /
    // browsers without the Font Loading API.
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (card.isConnected) schedule(); });
    }

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(t1); clearTimeout(t2);
      ro.disconnect(); mo.disconnect();
    };
  }, [cardRef]);
}
