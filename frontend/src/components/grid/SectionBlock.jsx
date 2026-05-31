import React, { useRef, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDraggable } from '@dnd-kit/core';
import { LEVEL_COLORS, HARD_CONFLICT_BG, SOFT_CONFLICT_BG, useApp, sectionLabel } from '../../context/AppContext.jsx';
// NEW-FU-309 (Phase 66): card-level TWO-DIMENSIONAL auto-fit. Replaces
// the Phase 59-64 per-element useFitText + Phase 60 useRenderStrategy
// wrap-injection in the grid. A single hook shrinks every in-flow token
// uniformly until the whole card fits both its height and width — fixing
// the vertical clipping (venue "59-1003" → "59") that width-only fitting
// caused. CSS now handles wrapping naturally (white-space: normal), so
// shrinking collapses 2-line wraps back to one line when they fit.
// (useFitText / useRenderStrategy remain in use by the sidebar.)
import { useFitCard } from '../../hooks/useFitCard.js';
import './SectionBlock.css';

// NEW-FU-144 + FU-148: smart viewport-aware popover positioner. Tries
// the four anchor positions (right / left / below / above) in that
// order, picks the first that fits inside the viewport, falls back to
// the one with the smallest overflow if none fit cleanly.
function pickPopoverPosition(cardRect, popoverSize, gap = 8) {
  const { innerWidth: vw, innerHeight: vh } = window;
  const { width: pw, height: ph } = popoverSize;
  const candidates = [
    { name: 'right', x: cardRect.right + gap, y: clamp(cardRect.top, 4, vh - ph - 4) },
    { name: 'left',  x: cardRect.left - pw - gap, y: clamp(cardRect.top, 4, vh - ph - 4) },
    { name: 'below', x: clamp(cardRect.left, 4, vw - pw - 4), y: cardRect.bottom + gap },
    { name: 'above', x: clamp(cardRect.left, 4, vw - pw - 4), y: cardRect.top - ph - gap },
  ];
  for (const c of candidates) {
    if (c.x >= 4 && c.y >= 4 && c.x + pw <= vw - 4 && c.y + ph <= vh - 4) return c;
  }
  let best = candidates[0], bestOverflow = Infinity;
  for (const c of candidates) {
    const overflowX = Math.max(0, 4 - c.x) + Math.max(0, c.x + pw - (vw - 4));
    const overflowY = Math.max(0, 4 - c.y) + Math.max(0, c.y + ph - (vh - 4));
    const overflow = overflowX + overflowY;
    if (overflow < bestOverflow) { best = c; bestOverflow = overflow; }
  }
  return { name: best.name, x: clamp(best.x, 4, vw - pw - 4), y: clamp(best.y, 4, vh - ph - 4) };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }

// NEW-FU-306 (Phase 27): abbreviate the instructor's given name to an
// initial: "Dr. Rashed" → "Dr. R.", "Prof. Mona Khalid" → "Prof. M. Khalid".
// Keeps the title prefix (Dr., Prof., etc.) intact and the family name
// (if any) full. Exported for unit testing — the inline use inside
// SectionBlock is the only production caller today.
export function abbreviateInstructorName(name) {
  if (!name) return name;
  // Match "<prefix>. <first> <maybe-rest>" — keep prefix + initial.
  const m = name.match(/^(.+?\.\s+)(\S+)(.*)$/);
  if (m) return `${m[1]}${m[2][0]}.${m[3]}`;
  // No "Dr."-style prefix — take first word's initial.
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return name; // single word, nothing to abbreviate
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

export default function SectionBlock({ section, conflicts, onClick, onDelete, isDragging, height, tier = 'spacious' }) {
  // NEW-FU-207: archived schedules disable section drag + change the cursor.
  // Click is gated upstream in SchedulerPage.handleBlockClick.
  const { schedule } = useApp();
  const isArchived = Boolean(schedule?.archived_at);
  const { attributes, listeners, setNodeRef, transform, isDragging: activeDragging } =
    useDraggable({ id: section.id, disabled: isDragging || isArchived });

  // NEW-FU-148: refs only — no React state for popover position. We
  // mutate the DOM node directly inside the same handler (no batched
  // re-render delay between measure and paint).
  const cardRef = useRef(null);
  const popoverRef = useRef(null);

  // NEW-FU-309 (Phase 66): a single card-level fit replaces the six
  // per-element useFitText hooks (code/time/instr/venue/section/badge)
  // and the useRenderStrategy wrap-injection. It shrinks every in-flow
  // token uniformly until the card fits both height and width. Tokens
  // are queried by class inside the hook, so no per-element refs are
  // needed — just the card ref.
  useFitCard(cardRef);

  const positionPopover = useCallback(() => {
    if (activeDragging) return;
    const cardEl = cardRef.current;
    const popEl = popoverRef.current;
    if (!cardEl || !popEl) return;

    // .sblock-popover is permanently `position: fixed` in CSS (FU-147),
    // so toggling display:block does not affect surrounding layout.
    popEl.style.display = 'block';
    popEl.style.left = '-9999px';
    popEl.style.top = '-9999px';

    const apply = () => {
      const cardRect = cardEl.getBoundingClientRect();
      const popRect  = popEl.getBoundingClientRect();
      // Sanity: if measurement returns nothing (popover not laid out
      // yet for some reason), retry on the next frame.
      if (popRect.width < 100 || popRect.height < 30) {
        requestAnimationFrame(apply);
        return;
      }
      const pos = pickPopoverPosition(cardRect, { width: popRect.width, height: popRect.height });
      popEl.style.left = `${pos.x}px`;
      popEl.style.top  = `${pos.y}px`;
    };
    requestAnimationFrame(apply);
  }, [activeDragging]);

  // NEW-FU-301 (Phase 26): popover is once again info-only. The Phase 22
  // "Delete entire section" button moved to the side panel ✕, so the
  // popover doesn't need to be interactive anymore. The hover-bridge +
  // debounced hide (FU-289) were only there to let the cursor reach the
  // button without the popover vanishing — with no button to reach, the
  // synchronous hide-on-mouseLeave from the pre-Phase-22 era is correct.
  const hidePopover = useCallback(() => {
    const popEl = popoverRef.current;
    if (popEl) popEl.style.display = 'none';
  }, []);

  // NEW-FU-152: cleanup on unmount — ensure the portaled popover element
  // is hidden if the SectionBlock unmounts while hovered (view switch,
  // section delete, etc.). createPortal unmounts the DOM node itself,
  // but this is belt-and-suspenders for any stray visible state.
  useEffect(() => {
    return () => {
      const popEl = popoverRef.current;
      if (popEl) popEl.style.display = 'none';
    };
  }, []);

  // NEW-FU-306 (Phase 27): width-aware adaptive layout. The existing
  // `tier` prop adapts to HEIGHT (computed in ScheduleGrid from row
  // height), but it doesn't account for WIDTH. When two sections
  // overlap in time, ScheduleGrid splits the column 50/50 — at that
  // width "SWE301" gets clipped to "SWE…" and instructor names
  // truncate mid-word.
  //
  // We track the rendered width via ResizeObserver and apply the
  // `narrow` modifier when the card is below ~140px. The CSS
  // (SectionBlock.css) responds by abbreviating the instructor's
  // first name to an initial, hiding the section badge, and
  // shrinking fonts so the FULL course code stays visible. We
  // pick 140px because the seed venues + 7-char "SWE301" + the LEC
  // badge fit comfortably at that width; below it, abbreviation
  // is required.
  // NEW-FU-400 (Phase 40): narrow threshold tightened from 140 → 120.
  // Phase 35 used 140 as a "shrink fonts" cue; with the Phase 40 tier
  // system handling extreme density (tiny/micro/minimal cover < 90px
  // separately), `narrow` now ONLY covers the middle zone where a card
  // is mildly squeezed but still shows all fields. The narrow CSS
  // continues to shrink fonts + hide the §badge to free room.
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    setIsNarrow(el.getBoundingClientRect().width < 120);
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setIsNarrow(entry.contentRect.width < 120);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const courseCode = section.courseCode    ?? section.course_code    ?? '';
  const secNum     = section.sectionNumber ?? section.section_number ?? '';
  // NEW-FU-282 (Phase 56): single source of truth for the visible
  // section label. Female sections render as "§F-01" (with hyphen);
  // male/unset render as "§01". `secLbl` is used in every card
  // surface (header chip, tooltip title, full-info hover). Aria
  // label uses the symbol-stripped form so screen-readers don't
  // announce the "§" glyph mid-sentence.
  const secLbl     = sectionLabel(section);
  const secLblAria = sectionLabel(section, { withSection: false });
  const instrName  = section.instructorName ?? section.instructor_name ?? '';
  const venueName  = section.venueName      ?? section.venue_name      ?? '';
  // NEW-FU-309 (Phase 66): render the raw full strings. The Phase 60-61
  // useRenderStrategy wrap-injection is retired in the grid — CSS now
  // wraps naturally (white-space: normal, word-break: keep-all) and
  // useFitCard shrinks the font until the whole card fits. Full text is
  // always in the DOM; CSS decides where (if anywhere) it wraps.
  const level      = section.academicLevel  ?? section.academic_level  ?? 'Freshman';
  const startTime  = (section.startTime ?? section.start_time ?? '').substring(0,5);
  const endTime    = (section.endTime   ?? section.end_time   ?? '').substring(0,5);
  const secType    = section.sectionType ?? section.section_type ?? 'Lec';

  // NEW-FU-200 (Phase 79): publish the meeting DURATION in minutes so useFitCard
  // can split "large near-square" cards into GREEN (long classes — SWE 412 is
  // 160min, capped smaller so the big card reads refined) vs RED (short evening
  // lectures — SWE 587/503 are 75min, enlarged + 1-column). Duration is
  // ZOOM-INVARIANT, so the split is identical at every zoom — unlike pixel aspect
  // ratio, which drifts as the grid's px-per-minute changes and would flip the
  // cards' classification at deep zoom-in / zoom-out.
  const durMin = (() => {
    const p = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const d = p(endTime) - p(startTime);
    return Number.isFinite(d) && d > 0 ? d : 0;
  })();

  const hasHard    = conflicts.some(c => c.severity === 'Hard');
  const hasSoft    = conflicts.some(c => c.severity === 'Soft');
  const hasConflict = hasHard || hasSoft;
  const colors     = LEVEL_COLORS[level] ?? LEVEL_COLORS.Freshman;
  const bg          = hasHard ? HARD_CONFLICT_BG : hasSoft ? SOFT_CONFLICT_BG : colors.bg;
  const borderColor = hasHard ? '#dc2626'        : hasSoft ? '#b45309'        : colors.border;

  // NEW-FU-133: card just claims the wrapper's full height. No min-height
  // floor anymore (FU-129's 80px floor caused label-overlap at low zoom);
  // the tier-* CSS classes shrink font sizes / line-height to fit any
  // reasonable card height.
  const style = {
    background: bg, borderColor, color: colors.text,
    transform: transform ? `translate3d(${transform.x}px,${transform.y}px,0)` : undefined,
    opacity: activeDragging ? 0.35 : 1,
    // NEW-FU-207: archived → default cursor (no drag affordance) + no
    // interactive hint. Click-to-edit is gated upstream so we don't
    // even need to disable pointer-events; the cursor just stops
    // suggesting that the card is grabbable.
    cursor: isArchived ? 'default' : (isDragging ? 'grabbing' : 'grab'),
    height: '100%',
  };

  // NEW-FU-137: always render the FULL time range. FU-133's start-only
  // collapse at tier-minimal sacrificed usability ("when does this end?")
  // for ~6px of horizontal room — the user explicitly rejected this
  // trade-off. The time line uses ellipsis if it genuinely cannot fit,
  // but the new tier-micro font (FU-138) makes the full range fit even
  // in the tightest cards in the seed data.
  const timeText = `${startTime}–${endTime}`;

  // NEW-FU-137: badge text is uppercase "LEC" / "LAB" consistently across
  // Course / Teacher / Venue views.
  const badgeText = String(secType).toUpperCase();

  // NEW-FU-309 (Phase 66): instructor/venue render as raw full strings.
  // No abbreviation (removed Phase 62), no JS wrap-injection (removed
  // Phase 66). CSS wraps; useFitCard sizes. The full name is always in
  // the DOM and the hover tooltip carries it verbatim.

  // NEW-FU-144: combine the dnd-kit ref with our local cardRef so we can
  // measure the card for popover positioning.
  const combinedRef = (el) => { setNodeRef(el); cardRef.current = el; };

  // NEW-FU-364 (Phase 35): aria-label gives screen readers the full
  // section info regardless of CSS truncation. NEW-FU-400 (Phase 40):
  // the SAME string is also fed to a `data-tooltip` attribute that the
  // popover reads at hover time, AND used as the inline text content
  // of a hidden span the user can copy on long-select. The native
  // `title=""` attribute is deliberately NOT used here because it would
  // collide with the custom popover (FU-149's original concern); the
  // popover is the visible-on-hover source and aria-label covers a11y.
  const fullInfo =
    `${courseCode} ${secLbl} (${secType}) · ${startTime}–${endTime}` +
    (instrName ? ` · ${instrName}` : ' · (no instructor)') +
    (venueName ? ` · ${venueName}` : ' · (no venue)') +
    (hasHard ? ' · HARD conflict' : hasSoft ? ' · soft conflict' : '');
  const ariaLabel =
    `${courseCode} section ${secLblAria}, ${secType}, ${startTime} to ${endTime}` +
    (instrName ? `, instructor ${instrName}` : '') +
    (venueName ? `, venue ${venueName}` : '') +
    (hasHard ? ', has hard conflict' : hasSoft ? ', has soft conflict' : '');

  return (
    <div
      ref={combinedRef}
      className={['sblock', `tier-${tier}`,
        // NEW-FU-306 (Phase 27): width-aware narrow modifier — added
        // when ResizeObserver reports actual rendered width < 140px.
        // The CSS (SectionBlock.css `.sblock.narrow`) handles the
        // adaptive layout: shrinks fonts but KEEPS course code at full
        // length. Phase 35 (FU-362) makes text WRAP rather than abbreviate.
        isNarrow ? 'narrow' : '',
        hasHard?'conflict-hard':'', hasSoft?'conflict-soft':'',
        isDragging?'is-overlay':'',
      ].filter(Boolean).join(' ')}
      style={style}
      onClick={e => { e.stopPropagation(); onClick && onClick(); }}
      onMouseEnter={positionPopover}
      onMouseLeave={hidePopover}
      onDragStart={hidePopover}
      /* NEW-FU-149: no native `title=""` (collides with custom popover).
         NEW-FU-364 (Phase 35): aria-label for screen readers.
         NEW-FU-400 (Phase 40): data-fullinfo attribute is a
         machine-readable copy of the same content — used in tests
         (`querySelector('[data-fullinfo]')`) and for debugging via
         element inspector. Not user-visible. */
      aria-label={ariaLabel}
      data-fullinfo={fullInfo}
      /* NEW-FU-403 (Phase 43): data-section-type drives the corner
         ribbon's color in CSS. Even when .sblock-type-badge is
         hidden at narrow tiers, the ribbon stays visible — a 9×9px
         colored triangle in the top-right corner. Blue = Lec,
         yellow = Lab, preserving the original color encoding. */
      data-section-type={secType}
      data-section-num={secNum}
      /* NEW-FU-200 (Phase 79): zoom-invariant meeting duration (minutes) read by
         useFitCard to split green (long) vs red (short) large near-square cards. */
      data-dur-min={durMin}
      {...listeners}
      {...attributes}
    >
      {/* NEW-FU-147 (Phase 72): section number in the absolute top-right
          corner, DYNAMICALLY sized from --sb-code-px (published by useFitCard)
          so it scales with the card's typography at every density. Rendered on
          EVERY card; the symmetric header reserve keeps the centered code
          clear of it. */}
      <div className="sblock-secnum">{secLbl}</div>
      {/* NEW-FU-186 (Phase 77 REDESIGN): corner chrome (§ / LEC-LAB badge / ✕)
          are DIRECT children of the card, OUTSIDE the .sblock-fit wrapper, so the
          transform:scale() applied to .sblock-fit never distorts them. They are
          absolutely positioned in the corners (CSS) and sized from --sb-code-px /
          --sb-chrome-px published by useFitCard. */}
      <span className="sblock-type-badge" style={{
        background: secType === 'Lab' ? '#fde68a' : '#dbeafe',
        color:      secType === 'Lab' ? '#78350f' : '#1e3a8a',
      }}>{badgeText}</span>
      {/* NEW-FU-272: per-day quick-delete (✕). Removes ONLY this meeting row,
          leaving the rest of the section group intact. Disabled on archived
          schedules (mutations blocked upstream). Hover-revealed via CSS. */}
      {onDelete && !isArchived && (
        <button
          type="button"
          className="sblock-delete-row"
          title="Delete this meeting day (leaves rest of section)"
          onClick={(e) => {
            e.stopPropagation();
            hidePopover();
            onDelete(section, 'row');
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >×</button>
      )}
      {/* NEW-FU-186 (Phase 77 REDESIGN): all in-flow text lives in ONE wrapper
          that useFitCard measures (offsetWidth/Height — WebKit-reliable) and
          scales via transform to fit the card on both axes. scale = min(availW/
          natW, availH/natH) cannot clip; capped at MAX_S so it cannot billboard;
          grows to the binding edge so it fills the card. The wrapper is
          width:max-content + nowrap rows (CSS), so each row stays whole and the
          measured box is the content's true natural size. .sb-wide reflows these
          into a 2×2 grid (code|time / instr|venue) so wide cards' content is wide,
          not a tall narrow column — fixing the "empty left & right". */}
      <div className="sblock-fit">
        <div className="sblock-header">
          <span className="sblock-code">{courseCode}</span>
        </div>
        <div className="sblock-time">
          <span>{startTime}</span>
          <span className="sblock-time-dash">–</span>
          <span>{endTime}</span>
        </div>
        {instrName && (
          <div className="sblock-instr">{instrName}</div>
        )}
        {venueName && (
          <div className="sblock-venue">{venueName}</div>
        )}
        {!instrName && <div className="sblock-no-instr">⚠ No instructor</div>}
        {!venueName && <div className="sblock-no-instr">⚠ No venue</div>}
      </div>
      {hasConflict && (
        <div className="sblock-dots">
          {hasHard && <div className="sblock-dot hard" title="Hard conflict" />}
          {hasSoft && <div className="sblock-dot soft" title="Soft conflict" />}
        </div>
      )}
      {/* NEW-FU-152: render the popover via PORTAL into document.body so
          it escapes the wrapper div's `position:absolute; z-index:3`
          stacking context. Previously the popover's z-index:10000 was
          interpreted RELATIVE to its enclosing stacking context (the
          wrapper at z-index 3), so later-rendered sibling cards (also
          at z-index 3) painted on top of it. position:fixed alone does
          NOT escape stacking contexts; only DOM-level portaling does. */}
      {typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          className="sblock-popover"
          /* NEW-FU-301 (Phase 26): popover restored to info-only. No
             hover-bridge handlers needed — without an interactive
             button inside, the original "hide on card mouseLeave"
             behavior from pre-Phase 22 is correct. aria-hidden is
             back too since the popover is a pure tooltip again. */
          aria-hidden="true"
        >
          <div className="sblock-popover-title">
            {courseCode} {secLbl} <span className="sblock-popover-type">{badgeText}</span>
          </div>
          <div className="sblock-popover-row">⏱ {startTime}–{endTime}</div>
          <div className="sblock-popover-row">👤 {instrName || '— no instructor —'}</div>
          <div className="sblock-popover-row">🏛 {venueName || '— no venue —'}</div>
          {/* NEW-FU-301 (Phase 26): the "Delete entire section" button
              that used to live here is gone. Whole-section deletion is
              now exclusively the side panel's ✕ button. Card's ✕ is
              still here for per-day delete. Two affordances, two
              clear surfaces, no overlap. */}
        </div>,
        document.body
      )}
    </div>
  );
}
