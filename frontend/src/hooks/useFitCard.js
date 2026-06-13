// NEW-FU-520 (Phase 124 REDESIGN): PER-SIZE-CLASS, COORDINATED 2-D AUTO-FIT.
//
// ── Why this exists (the root cause it replaces) ─────────────────────────────
// Phases 77-123 fit each card INDEPENDENTLY: every card measured ITS OWN
// content box (natW/natH) and applied transform:scale = min(availW/natW,
// availH/natH). Two cards of the IDENTICAL rendered box but different text
// therefore got DIFFERENT scales — different fonts AND different badge/✕ sizes
// (the corner chrome is `calc(var(--sb-code-px) * k)`, and --sb-code-px = the
// card's OWN scaled code px). Worse, a small card with short text grew to the
// MAX cap while a large card with a long instructor name stayed fit-bound and
// SMALL — so small cards rendered BIGGER type than large cards: the inversion
// the user saw. Layered on top were per-COURSE typography levers (green
// haircut, blue/red caps, fill-boost) that deliberately made same-size cards
// differ by course — compounding the non-uniformity.
//
// ── The fix: size decides typography, and nothing else ───────────────────────
// Typography is now a function of the card's RENDERED BOX ALONE. A single
// module-level COORDINATOR (not the per-card hook) runs after layout settles:
//   1. MEASURE every Overview card's box (W×H) and natural content (natW/natH).
//   2. BUCKET cards by quantized (W,H) — the rendered box, NOT duration alone:
//      concurrent sections split a day into narrower lanes, so two equal-
//      duration cards can differ in WIDTH and must land in different buckets.
//   3. Per bucket, the uniform scale = the WORST-CASE fit across its members
//      (the MIN of each member's own max-fitting scale). Applying the min means
//      the textiest card in the bucket still fits → no card in the bucket can
//      clip, and every card in the bucket renders the SAME scale → same font,
//      same § / LEC-LAB badge / ✕ (all ride the per-bucket --sb-code-px).
//   4. MONOTONICITY: project the per-bucket scales so a SMALLER box never gets
//      a larger font than a LARGER box. finalScale[b] = min(rawScale[b'] for
//      every bucket b' with area ≥ area[b]) — a shrink-only running-min from
//      the largest bucket down. It only ever LOWERS a scale, and each bucket's
//      raw scale already fits its own worst case, so lowering still fits:
//      monotone AND clip-safe by construction. (Equal-area buckets of different
//      shape do not constrain each other — see the projection below.)
//
// ── Guards PRESERVED from the per-card era (handoff §Batch-4) ────────────────
//   • anti-CLIP by construction — scale ≤ min(availW/natW, availH/natH) for the
//     WORST card in the bucket ⇒ no member overflows either axis.
//   • anti-BILLBOARD — every bucket scale is capped at MAX_S and the displayed
//     code px at MAX_CODE_PX / ROOMY_CODE_PX (sparse-term ceiling).
//   • anti-PULSE hysteresis — the corner-tag gutter is measured from tag
//     offsetWidth, whose font derives from --sb-code-px (this fit's own output)
//     → a feedback loop. It is now a BUCKET-level loop (all members share one
//     --sb-code-px). Per-bucket scale hysteresis (SCALE_EPS) freezes a bucket's
//     scale when a re-fit moves it < SCALE_EPS, so --sb-code-px stops changing,
//     the tags stop resizing, and the loop can't re-trigger.
//   • WebKit offsetWidth correctness — measurement uses offsetWidth/offsetHeight
//     (per-element box metrics, reliable in WebKit). NO scrollHeight, NO cqh.
//   • performance over ~1,262 cards — the coordinator BATCHES: one write pass to
//     reset transforms, one read pass to measure all cards (single reflow), then
//     one write pass to apply — 2 reflows per recompute total, not 2·N. All the
//     observers (ResizeObserver per card, MutationObserver, fonts.ready) funnel
//     into ONE microtask-coalesced recompute.
//
// The READABLE / Instructor / Venue path is UNCHANGED: those cards carry
// data-uniform-type="1" and render at a fixed scale 1 with a frozen
// --sb-code-px (CSS pins their fonts) — already uniform, already non-pulsing.
//
// The corner chrome (§ / LEC-LAB badge / ✕ / conflict dots) are siblings of the
// .sblock-fit wrapper (SectionBlock.jsx) — absolute on the card, NOT scaled.
// availH/availW reserve a chrome band so the centred, scaled content can never
// reach the corner tags (chrome-collision-proof by construction).

import { useEffect, useLayoutEffect } from 'react';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// ── Scale bounds. The natural (unscaled) code font is 13px (.sblock-fit
//    .sblock-code in CSS). These bound the extremes; the fit formula already
//    guarantees the in-between fit. ───────────────────────────────────────────
// MAX_S 1.7 ⇒ displayed code ≤ ~22px on the biggest cards (confident, never a
// billboard). MIN_S 0.25 ⇒ displayed code ≥ ~3.25px on the densest sub-physical
// lanes (tiny but WHOLE — a smaller whole word beats a clipped one; this is the
// legible floor, with the card's overflow:hidden as the only, rarely-reached,
// backstop).
const MAX_S = 1.7;
const MIN_S = 0.25;
const NAT_CODE_PX = 13; // must match .sblock-fit .sblock-code font-size in CSS
// anti-PULSE hysteresis threshold (per BUCKET now). 0.02 > the historical
// ~0.017 feedback-cycle amplitude; a 0.02 scale step is ≤0.3px of code —
// imperceptible — while real changes (resize, mode switch) exceed it and apply.
const SCALE_EPS = 0.02;
// anti-BILLBOARD displayed-code ceilings.
//   • MAX_CODE_PX — the general ceiling. 22px ≈ 1.7×13 sits just under the hard
//     MAX_S cap, so the roomy morning UG cards in a sparse term read large
//     (the user's "~1.6× larger text on roomy cards", Phase 119) without
//     shouting. Dense-term cards are fit-bound (rawScale < 1) and never reach it.
//   • ROOMY_CODE_PX — a tighter ceiling applied ONLY to roomy buckets (rawScale
//     > 1: the content is SMALLER than the box, sparse term). Equal to 22 today,
//     kept as a distinct knob so a roomy ceiling can be tuned without touching
//     the dense path. Pure one-way upper clamp ⇒ no feedback, no pulse.
const MAX_CODE_PX = 22;
const ROOMY_CODE_PX = 22;

// Box quantization (px) for bucketing. Cards within QUANT px of each other in
// BOTH width and height share a size bucket — absorbs sub-pixel grid/flex
// rounding (which differs between Chromium and WebKit) so the same logical card
// lands in the same bucket in every engine. 6px is below the smallest real
// inter-class gap (lane-width steps and duration steps are far larger) yet above
// rasteriser jitter.
const QUANT = 6;
const qbin = (v) => Math.round(v / QUANT) * QUANT;

// ── Module-level coordinator state ───────────────────────────────────────────
const registry = new Set();              // every mounted card element
const prevBucketScale = new Map();       // bucketKey → last applied scale (hysteresis)
let pending = false;

// Coalesce every trigger (mount, resize, mutation, font swap) into ONE recompute
// per microtask. Microtasks flush before paint, so the initial mount settles
// with no flash; resize storms (ResizeObserver firing per card) collapse to a
// single pass.
function scheduleRecompute() {
  if (pending) return;
  pending = true;
  const flush = () => { pending = false; recompute(); };
  if (typeof queueMicrotask === 'function') queueMicrotask(flush);
  else Promise.resolve().then(flush);
}

// Geometry classes derived PURELY from the card box (W,H) — identical for every
// card in a bucket, so they never break size-uniformity. (The per-COURSE classes
// of the old design — sb-blue/green/red/shortwide — are intentionally GONE:
// size decides typography, nothing else.)
function geometryFor(W, H) {
  const ar = W / H;
  // A WIDE card is wide regardless of how short it gets (ar ≥ 2.0). `tiny` must
  // NOT swallow a wide-short card (the textbook 2-column case): a card is `tiny`
  // only if small AND not wide.
  const wideShape = ar >= 2.0;
  const tiny = !wideShape && (H < 46 || W < 60);
  // .sb-wide (2×2 grid): WIDE cards (ar ≥ 2.0, fills width with 2 columns) OR
  // LARGE near-square cards (area ≥ 35000, ar ∈ [0.6,1.7]) — the big blocks that
  // would billboard in a single column.
  const wide = wideShape || (!tiny && W * H >= 35000 && ar >= 0.6 && ar <= 1.7);
  // PINNED-TAG tiny cards: a tiny card with enough height (H ≥ 33) pins its § top
  // and badge bottom (CSS .sb-narrowtall) and reserves a fixed band so the
  // centred text clears them.
  const pinnedTags = tiny && H >= 33;
  return { tiny, wide, pinnedTags };
}

// ── The coordinator. Three DOM phases (reset → measure → apply) so the whole
//    board costs 2 reflows, not 2 per card. ──────────────────────────────────
function recompute() {
  const cards = [];
  for (const card of registry) if (card.isConnected) cards.push(card);
  if (!cards.length) return;

  // PHASE A (WRITE): reset every fit wrapper to scale 1 so the upcoming reads
  // report the NATURAL (unscaled) box. Batched first so the reads in Phase B
  // trigger a single layout flush.
  const ctx = [];
  for (const card of cards) {
    const fitEl = card.querySelector('.sblock-fit');
    if (!fitEl) continue;
    fitEl.style.transform = 'translate(-50%, -50%) scale(1)';
    ctx.push({ card, fitEl, uniform: card.dataset.uniformType === '1' });
  }
  if (!ctx.length) return;

  // PHASE B (READ): measure box + natural content + corner-tag gutter for all.
  for (const c of ctx) {
    const { card, fitEl } = c;
    c.W = card.clientWidth;
    c.H = card.clientHeight;
    // width:max-content wrapper ⇒ offsetWidth = widest natural row, offsetHeight
    // = the natural stacked / 2×2 height. Both WebKit-reliable per-element box
    // metrics (the bugs that burned earlier phases were scrollHeight + cqh —
    // neither is used).
    c.natW = fitEl.offsetWidth;
    c.natH = fitEl.offsetHeight;
    c.geo = (c.W && c.H) ? geometryFor(c.W, c.H) : { tiny: false, wide: false, pinnedTags: false };

    if (c.uniform || !c.W || !c.H || !c.natW || !c.natH) continue;

    const { tiny } = c.geo;
    // Chrome reserve. The § (top-right), LEC/LAB badge (bottom-right) and
    // conflict dots (top-left) are absolute corner chrome. The scaled content is
    // centred, so reserve a SYMMETRIC horizontal gutter = the widest visible
    // tag's real offsetWidth + a gap (measure, don't estimate — a "§F-04" chip is
    // far wider than its height), and a vertical band that clears the tallest
    // tag. Tiny cards hide the tags (CSS) → only a hairline. Measuring the tag at
    // the CURRENT --sb-code-px is the bucket-level feedback loop the hysteresis
    // below damps.
    const band = tiny ? 2 : Math.max(9, Math.min(20, Math.round(c.H * 0.18)));
    const padX = tiny ? 2 : Math.max(3, Math.min(6, Math.round(c.W * 0.03)));
    c.chromePx = tiny ? 12 : Math.min(Math.max(band, Math.round(c.H * 0.20)), 24);

    let tagReserve = 0;    // widest visible tag (horizontal gutter)
    let tagHeight = 0;     // tallest visible top/bottom tag (vertical band)
    let tagInnerEdge = c.W; // smallest LEFT edge of any right-corner tag
    if (!tiny) {
      const cr = card.getBoundingClientRect();
      ['.sblock-secnum', '.sblock-type-badge', '.sblock-dots'].forEach((sel) => {
        const e = card.querySelector(sel);
        if (e && getComputedStyle(e).display !== 'none') {
          tagReserve = Math.max(tagReserve, e.offsetWidth);
          tagHeight = Math.max(tagHeight, e.offsetHeight);
          if (sel !== '.sblock-dots') {
            const er = e.getBoundingClientRect();
            tagInnerEdge = Math.min(tagInnerEdge, er.left - cr.left);
          }
        }
      });
    }
    const gutter = tiny ? 2 : Math.max(padX, tagReserve + 5);
    // Vertical band: a pinned-tag tiny card reserves a height-proportional band
    // (≈12%, floored 9) so the centred text clears its top §/bottom badge; other
    // tiny cards a hairline; non-tiny cards clear the tallest tag + 5.
    let vBand = tiny
      ? (c.geo.pinnedTags ? Math.max(9, Math.round(c.H * 0.12)) : 2)
      : Math.max(band, tagHeight + 5);

    // BAND RECLAIM (non-tiny): on a WIDE card the centred content is narrow and
    // the tags sit far right, so the content can grow vertically into the corner
    // rows without ever reaching the tag column. When that's provably true,
    // reclaim the band to a hairline so availH ≈ full card height (lets wide-
    // short cards fill instead of being pinned tiny). Self-limiting: a card whose
    // content WOULD reach the tag column keeps the full band, so this can never
    // create a collision. All inputs (W,H,natW,natH,tagInnerEdge) are bucket-
    // consistent, so the reclaim decision is uniform within a bucket.
    if (!tiny) {
      const availH_pre = c.H - 2 * vBand;
      const estScaleW = (c.W - 2 * gutter) / Math.max(1, c.natW);
      const estScaleH = availH_pre / Math.max(1, c.natH);
      const estScale = Math.min(MAX_S, estScaleW, estScaleH);
      const grownHalfW = (c.natW * estScale * 1.4) / 2; // generous grow estimate
      const contentRightEdge = c.W / 2 + grownHalfW;
      if (contentRightEdge <= tagInnerEdge - 6) vBand = 2;
    }

    const availW = Math.max(8, c.W - 2 * gutter);
    const availH = Math.max(8, c.H - 2 * vBand);
    // This card's own MAX-FITTING scale (the largest that fits BOTH axes).
    let cand = Math.min(availW / c.natW, availH / c.natH);
    if (!isFinite(cand) || cand <= 0) cand = 1;
    c.cand = cand;
  }

  // ── BUCKET: group fit cards by quantized (W,H). The bucket's RAW scale is the
  //    MIN candidate over its members — the worst-case content sets the size so
  //    the whole bucket fits. roomy flag = the bucket's content is smaller than
  //    its box (every member fits at > 1), which gates the tighter ceiling. ────
  const buckets = new Map();
  for (const c of ctx) {
    if (c.uniform || c.cand == null) continue;
    const key = qbin(c.W) + 'x' + qbin(c.H);
    let b = buckets.get(key);
    if (!b) {
      b = { key, area: qbin(c.W) * qbin(c.H), members: [], raw: Infinity, roomyAll: true };
      buckets.set(key, b);
    }
    b.members.push(c);
    b.raw = Math.min(b.raw, c.cand);
    if (c.cand <= 1) b.roomyAll = false;
  }

  // Clamp each bucket's raw scale to the legible floor, the anti-billboard cap,
  // and the displayed-code ceiling (the roomy ceiling only where the whole
  // bucket is roomy — a one-way upper clamp).
  for (const b of buckets.values()) {
    let ceilPx = MAX_CODE_PX;
    if (b.roomyAll) ceilPx = Math.min(ceilPx, ROOMY_CODE_PX);
    let s = Math.min(b.raw, MAX_S, ceilPx / NAT_CODE_PX);
    s = Math.max(MIN_S, s);
    b.scale = s;
  }

  // ── MONOTONICITY projection: finalScale[b] = min(scale[b'] : area[b'] ≥
  //    area[b]). Walk buckets LARGEST area first, carrying a running min; a
  //    smaller bucket can never exceed any larger one. Equal-area buckets of
  //    different shape must NOT constrain each other, so fold the running min in
  //    GROUPS: apply the running min from STRICTLY-larger areas to a group, then
  //    extend the running min with that group's own scales. Shrink-only ⇒ never
  //    clips (each bucket's own scale already fits its worst case); never inverts.
  const ordered = [...buckets.values()].sort((a, b) => b.area - a.area);
  let runMin = Infinity;
  let i = 0;
  while (i < ordered.length) {
    let j = i;
    while (j < ordered.length && ordered[j].area === ordered[i].area) j++;
    // group [i,j) shares one area: each is min(own, strictly-larger runMin)
    let groupMin = Infinity;
    for (let k = i; k < j; k++) {
      ordered[k].mono = Math.min(ordered[k].scale, runMin);
      groupMin = Math.min(groupMin, ordered[k].mono);
    }
    runMin = Math.min(runMin, groupMin);
    i = j;
  }

  // ── PHASE C (WRITE): apply. Per-bucket scale hysteresis freezes a bucket whose
  //    new scale moved < SCALE_EPS (stops the gutter feedback loop). Same scale
  //    + same --sb-code-px for every member ⇒ identical fonts, §, badge, ✕. ────
  for (const b of buckets.values()) {
    let s = b.mono;
    const prev = prevBucketScale.get(b.key);
    if (prev !== undefined && Math.abs(s - prev) < SCALE_EPS) s = prev;
    prevBucketScale.set(b.key, s);
    const sr = Math.round(s * 1000) / 1000;
    const codePx = (NAT_CODE_PX * sr).toFixed(1);
    for (const c of b.members) {
      c.fitEl.style.transform = `translate(-50%, -50%) scale(${sr})`;
      c.card.dataset.sbFitScale = String(sr);
      c.card.style.setProperty('--sb-code-px', `${codePx}px`);
    }
  }

  // Uniform (Readable / Instructor / Venue) cards: fixed scale 1, frozen code px.
  // CSS pins their fonts; nothing here couples content → scale, so they can't
  // pulse. (Geometry classes + chrome below still apply.)
  for (const c of ctx) {
    if (!c.uniform) continue;
    c.fitEl.style.transform = 'translate(-50%, -50%) scale(1)';
    c.card.dataset.sbFitScale = '1';
    c.card.style.setProperty('--sb-code-px', `${NAT_CODE_PX}px`);
  }

  // Geometry classes + chrome px for EVERY card (size-derived; uniform per
  // bucket). --sb-grow / --sb-fill-boost are pinned to 1: the per-course grow /
  // under-fill boost of the old design are removed (size decides typography).
  for (const c of ctx) {
    const { card } = c;
    const { tiny, wide, pinnedTags } = c.geo;
    card.classList.toggle('sb-tiny', tiny);
    card.classList.toggle('sb-narrowtall', pinnedTags);
    card.classList.toggle('sb-yellowx', pinnedTags);
    card.classList.toggle('sb-wide', wide);
    // Per-course emphasis classes are no longer applied — ensure any stale ones
    // from a prior build are cleared so their CSS can't re-introduce per-course
    // (non-size) typography.
    card.classList.remove('sb-blue', 'sb-green', 'sb-red', 'sb-shortwide');
    card.style.setProperty('--sb-grow', '1');
    card.style.setProperty('--sb-fill-boost', '1');
    const chromePx = c.chromePx != null ? c.chromePx : (tiny ? 12 : 14);
    card.style.setProperty('--sb-chrome-px', `${chromePx}px`);
  }
}

export function useFitCard(cardRef) {
  useIsomorphicLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || typeof ResizeObserver === 'undefined') return undefined;

    registry.add(card);
    scheduleRecompute();

    // The grid resolves overlapping-lane widths in a pass that can run AFTER this
    // layout effect, so the card may first measure pre-narrowed. Per-card RO
    // catches its own resize; MO catches content changes; both funnel into the
    // coalesced recompute. childList + characterData only (NOT attributes) so the
    // coordinator's own class/style writes can't re-fire it.
    const ro = new ResizeObserver(scheduleRecompute);
    ro.observe(card);
    const mo = new MutationObserver(scheduleRecompute);
    mo.observe(card, { childList: true, characterData: true, subtree: true });

    // Safety nets for late layout (grid overlap pass, slow first paint). All
    // coalesce into a single recompute, so 1,262 cards firing at ~the same time
    // cost one pass each, not N.
    const t1 = setTimeout(scheduleRecompute, 120);
    const t2 = setTimeout(scheduleRecompute, 400);

    // Re-fit once the card web font (JetBrains Mono, display=swap) loads: the
    // fallback metrics differ from the real ones, changing natW/natH. Guarded for
    // SSR / no Font Loading API; the rejection is swallowed (document teardown
    // mid-load) — the observers drive re-fits regardless.
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (card.isConnected) scheduleRecompute(); }).catch(() => {});
    }

    return () => {
      registry.delete(card);
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
      mo.disconnect();
      scheduleRecompute();
    };
  }, [cardRef]);
}
