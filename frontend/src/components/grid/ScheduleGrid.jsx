import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  useApp, DAYS, LEVEL_COLORS, SOFT_CONFLICT_BG, HARD_CONFLICT_BG,
  toMinutes, fromMinutes, SLOT_STEP,
} from '../../context/AppContext.jsx';
import SectionBlock from './SectionBlock.jsx';
import OfficeHourBlock from './OfficeHourBlock.jsx';
import './ScheduleGrid.css';

const DISPLAY_START = 7 * 60;
const DISPLAY_END   = 22 * 60;

function getHourMarks() {
  const marks = [];
  for (let h = 7; h <= 22; h++) marks.push(`${String(h).padStart(2,'0')}:00`);
  return marks;
}
const HOUR_MARKS = getHourMarks();

// NEW-FU-313 (Phase 68): vertical room expansion. Measurement showed
// the grid is already ~98% width-utilized (the thin dense lanes come
// from time-overlap splitting, not unused grid width), so the real
// headroom is vertical.
//   • DEFAULT 48 → 56: taller cards out of the box → more room for the
//     2-D fit to render text larger before any shrink is needed.
//   • MAX 96 → 132: a much higher zoom-in ceiling so a detail view can
//     make any card big and fully readable.
//   • MIN 22 → 20: at max zoom-out the full 07:00–22:00 (30 half-hour
//     rows) is 30×20 = 600px + header ≈ 660px, fitting without scroll
//     even on shorter (≈720px-tall) screens.
// NEW-FU-204 (Phase 81): with the in-app zoom feature removed, only two row-height
// bounds remain meaningful, and they're the CLAMP on the single fit-to-viewport
// level (see the fit effect):
//   • ROW_H_DEFAULT 64 — the UPPER clamp + first-paint fallback before the fit
//     effect measures. A very tall window won't balloon rows past this.
//   • ROW_H_MIN 20 — the LOWER clamp, the Phase-68-R2-proven floor at which the
//     full 07:00–22:00 (30 half-hour rows = 600px + header) still fits with zero
//     vertical scroll on short (~720px) screens.
// ROW_H_MAX / ROW_H_STEP (the old zoom-in ceiling + step) are gone — there is no
// longer a zoom range to step through, just the one fitted level.
const ROW_H_DEFAULT = 64;
const ROW_H_MIN     = 20;

// NEW-FU-133 + FU-138 + FU-139: density tier thresholds. The grid fits
// all 5 days within `availableW` via proportional flex-grow, so per-lane
// width = availableW / sum(maxLanesPerDay). Tier selection considers
// BOTH per-lane width AND per-card height: if a card's natural height
// (shortest slot duration × pxPerMin) drops below a vertical threshold,
// we step DOWN one tier to keep content readable inside the card.
//
// Order matters: TIER_BY_WIDTH is searched in declared order, first match
// wins.
// NEW-FU-400 (Phase 40): added `tiny` tier below `micro` for extreme
// horizontal density (6+ cards stacked in one time slot, narrow viewport).
// At tier-tiny the card collapses to course code + a thin color band
// only — instructor / venue / time hide into the tooltip. This prevents
// the per-letter vertical wrap that Phase 35's break-word CSS produced
// when the lane width dropped below the rendered width of "SWE301".
const TIER_BY_WIDTH = [
  { name: 'spacious', minLaneW: 200 },
  { name: 'compact',  minLaneW: 140 },
  { name: 'tight',    minLaneW:  90 },
  { name: 'minimal',  minLaneW:  60 },
  { name: 'micro',    minLaneW:  40 },
  { name: 'tiny',     minLaneW:   0 },
];
const TIER_ORDER = ['spacious', 'compact', 'tight', 'minimal', 'micro', 'tiny'];

function pickTier(laneW, cardHeight) {
  const byWidth = (TIER_BY_WIDTH.find(t => laneW >= t.minLaneW) ?? TIER_BY_WIDTH[TIER_BY_WIDTH.length - 1]).name;
  // Step down if vertical room is short. Thresholds derived from the
  // content's vertical needs at each tier (header + time + instr + venue):
  //   spacious 13px lines × ~1.25 lh × 4 lines + 12px padding ≈ 77px
  //   compact  12px lines × ~1.22 × 4 + 10px ≈ 69px
  //   tight    10px × 1.18 × 4 + 8 ≈ 55px
  //   minimal  8.5px × 1.08 × 4 + 4 ≈ 41px
  //   micro    7px × 1.0 × 4 + 2 ≈ 30px
  // NEW-FU-400: minHeightFor includes tier-tiny (effectively 0 — at this
  // density the card just shows the course code, so any non-zero height
  // is enough).
  const minHeightFor = { spacious: 78, compact: 70, tight: 56, minimal: 42, micro: 30, tiny: 0 };
  let tier = byWidth;
  while (tier !== 'tiny' && cardHeight < minHeightFor[tier]) {
    tier = TIER_ORDER[TIER_ORDER.indexOf(tier) + 1];
  }
  return tier;
}

// ────────────────────────────────────────────────────────────────────────
// NEW-FU-127: greedy lane layout (unchanged from FU-127, still the right
// primitive). NEW-FU-132 only changes how lanes are SIZED (proportional
// flex instead of fixed px) and how their content is RENDERED (tier-
// adaptive SectionBlock instead of fixed layout).
// ────────────────────────────────────────────────────────────────────────
function layoutSectionsForDay(sections) {
  if (!sections.length) return [];

  const sorted = [...sections].sort((a, b) => {
    const aS = toMinutes(a.startTime ?? a.start_time);
    const bS = toMinutes(b.startTime ?? b.start_time);
    if (aS !== bS) return aS - bS;
    return toMinutes(a.endTime ?? a.end_time) - toMinutes(b.endTime ?? b.end_time);
  });

  const colEnds = [];
  const meta = new Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    const sec = sorted[i];
    const start = toMinutes(sec.startTime ?? sec.start_time);
    const end   = toMinutes(sec.endTime   ?? sec.end_time);
    let placed = false;
    for (let ci = 0; ci < colEnds.length; ci++) {
      if (start >= colEnds[ci]) {
        colEnds[ci] = end;
        meta[i] = { sec, start, end, laneIndex: ci };
        placed = true;
        break;
      }
    }
    if (!placed) {
      const ci = colEnds.length;
      colEnds.push(end);
      meta[i] = { sec, start, end, laneIndex: ci };
    }
  }

  // NEW-FU-140 (Phase 69): per-CLUSTER uniform column count.
  //
  // BUG (pre-69): laneTotal was computed independently per card as
  // (max overlapping laneIndex) + 1. Two cards in the SAME visual cluster
  // could therefore disagree on how many columns the cluster has — a wide
  // card that reaches lane 2 computes laneTotal 3 and places itself in the
  // middle third (left 33%–66%), while a narrower neighbour that only sees
  // lanes 0–1 computes laneTotal 2 and places itself in the left half
  // (left 0%–50%). 33% < 50%, so the two boxes intrude on each other and one
  // is painted partly over the other (the SWE 439 / SWE 326 collision).
  //
  // FIX: every card in one connected component of the time-overlap graph
  // must share ONE column count. The greedy colouring above already gives
  // overlapping cards distinct laneIndexes and (because interval graphs are
  // perfect, so greedy-by-start is an optimal colouring) uses exactly the
  // cluster's peak concurrency many lanes. So the cluster's column count is
  // (max laneIndex in the cluster) + 1; with that SHARED denominator every
  // overlapping pair maps to distinct, adjacent, non-overlapping column
  // ranges — provably zero overlap, for partial overlaps and overlap chains
  // alike. (We intentionally do NOT expand a card into trailing empty
  // columns: uniform per-cluster width is the simplest provably-safe layout,
  // and width is already reclaimed globally by proportional flex sizing.)
  //
  // Components are found with union-find over every (i<j) time-overlapping
  // pair. Overlap is half-open [start,end): cards that merely touch at an
  // edge (one ends exactly when the next begins) do NOT overlap — consistent
  // with the `start >= colEnds[ci]` reuse test in the greedy pass above.
  const parent = meta.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < meta.length; i++) {
    for (let j = i + 1; j < meta.length; j++) {
      if (meta[i].start < meta[j].end && meta[j].start < meta[i].end) union(i, j);
    }
  }
  const clusterMaxLane = new Map();   // component root → max laneIndex in it
  for (let i = 0; i < meta.length; i++) {
    const root = find(i);
    const cur = clusterMaxLane.get(root) ?? 0;
    // NEW-FU-142 (Phase 70): ALWAYS record the root's max lane. The Phase 69
    // form `if (laneIndex > cur) set(...)` never wrote an entry for a cluster
    // whose max laneIndex is 0 — i.e. every singleton / non-overlapping card.
    // Those roots then read back `undefined` below, so laneTotal became
    // `undefined + 1 = NaN`, the wrapper's `width: calc(NaN% - 4px)` was
    // dropped by the DOM, and the absolute wrapper fell back to width:auto
    // (content-sized). A content-sized card whose width straddles the
    // `.narrow` 120px threshold then oscillated (narrow ⇄ not-narrow →
    // padding/font change → width change → …): the Phase 70 flicker.
    // Math.max + unconditional set guarantees every root has an entry, so
    // laneTotal is always an integer ≥ 1 (singleton → 1 → full lane width,
    // exactly as before Phase 69).
    clusterMaxLane.set(root, Math.max(cur, meta[i].laneIndex));
  }
  return meta.map(({ sec, laneIndex }, i) => ({
    sec,
    laneIndex,
    // `?? laneIndex` is defensive — with the unconditional set above the
    // root is always present, but this guarantees a finite laneTotal even
    // if the map ever misses, so `width: calc()` can never go NaN again.
    laneTotal: (clusterMaxLane.get(find(i)) ?? laneIndex) + 1,
  }));
}

export default function ScheduleGrid({ onBlockClick, onOHClick, onSectionDelete }) {
  const { sections, officeHours, conflicts } = useApp();
  const [dropHighlight, setDropHighlight]    = useState(null);
  // NEW-FU-204 (Phase 81): SINGLE-LEVEL grid. The in-app zoom feature is removed.
  // The grid renders ONLY at the fit-to-viewport level — the same level the old
  // "max zoom-out" produced — so the whole 07:00–22:00 day + all day columns are
  // visible with no vertical scroll, and there is exactly ONE rendering target to
  // tune card typography against (Phases 66–80 thrashed because each in-app zoom
  // level was a separate geometry regime; collapsing to one ends that class of
  // cross-level regressions). `rowH` is now driven SOLELY by the fit effect below
  // — no manual rowH state, no atFloorRef, no min/max/step. Users who want a
  // closer look use the browser's native zoom (Cmd +/−), which is unaffected.
  // ROW_H_DEFAULT is only the first-paint fallback until the fit effect measures.
  const [rowH, setRowH] = useState(ROW_H_DEFAULT);
  const pxPerMin  = rowH / 30;

  const GRID_HEIGHT = (DISPLAY_END - DISPLAY_START) * pxPerMin;
  const pixelOffsetAt = (t) =>
    Math.max(0, Math.min(t, DISPLAY_END) - DISPLAY_START) * pxPerMin;

  const sectionsByDay = useMemo(() => {
    const m = {};
    for (const day of DAYS) m[day] = sections.filter(s => s.day === day);
    return m;
  }, [sections]);

  const ohByDay = useMemo(() => {
    const m = {};
    for (const day of DAYS) m[day] = officeHours.filter(o => o.day === day);
    return m;
  }, [officeHours]);

  const layoutsByDay = useMemo(() => {
    const m = {};
    for (const day of DAYS) m[day] = layoutSectionsForDay(sectionsByDay[day] ?? []);
    return m;
  }, [sectionsByDay]);

  // NEW-FU-132: per-day max lane count drives the flex-grow ratio.
  const maxLanesPerDay = useMemo(() => {
    const m = {};
    for (const day of DAYS) {
      let n = 1;
      for (const l of (layoutsByDay[day] ?? [])) if (l.laneTotal > n) n = l.laneTotal;
      m[day] = n;
    }
    return m;
  }, [layoutsByDay]);

  const totalLanes = useMemo(() =>
    DAYS.reduce((acc, d) => acc + maxLanesPerDay[d], 0),
    [maxLanesPerDay]);

  // NEW-FU-132: ResizeObserver tracks the day-cols container width so
  // per-lane width = containerW / totalLanes is accurate to the actual
  // viewport (and updates on resize). Default fallback covers SSR / first
  // paint before the observer fires.
  const dayColsRef = useRef(null);
  const [dayColsWidth, setDayColsWidth] = useState(1170);
  useEffect(() => {
    if (!dayColsRef.current) return;
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) {
        setDayColsWidth(Math.max(400, entry.contentRect.width));
      }
    });
    obs.observe(dayColsRef.current);
    return () => obs.disconnect();
  }, []);

  // NEW-FU-204 (Phase 81): the SOLE zoom driver. Measures the vertical space
  // available to the grid body (top of the day-cols → bottom of viewport, minus
  // a small margin) and divides by the 30 half-hour rows so the full 07:00–22:00
  // EXACTLY fills the height with no vertical scroll — i.e. the old "max zoom-out"
  // level, now the ONLY level. Clamped to [ROW_H_MIN, ROW_H_DEFAULT]: never below
  // the proven dense floor (20), never above the default (so a very tall window
  // doesn't balloon the rows). Re-measured on every viewport resize so the grid
  // always re-fits — the fit-to-viewport behaviour the Phase-81 prompt asked to
  // preserve. `rowH` is set DIRECTLY here (no separate floor state / atFloor
  // bookkeeping); this effect is the single source of truth for the zoom level.
  //
  // NEW-FU-155 (Phase 73 R3): floor to 0.1px (not whole px) so the 30 rows fill
  // the height to within ~3px instead of leaving up to ~29px of integer-rounding
  // slack. floor (not round) still guarantees 30·rowH ≤ avail → never overflows
  // into a scroll. Fractional rowH is safe: pxPerMin = rowH/30 already produces
  // fractional card tops/heights, and useFitCard measures the REAL rendered box.
  const ROWS = (DISPLAY_END - DISPLAY_START) / 30; // 30 half-hour rows
  useEffect(() => {
    const compute = () => {
      const el = dayColsRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const avail = window.innerHeight - top - 4; // 4px bottom breathing margin
      const fit = Math.max(ROW_H_MIN, Math.min(ROW_H_DEFAULT, Math.floor(avail / ROWS * 10) / 10));
      setRowH(prev => (prev !== fit ? fit : prev));
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [ROWS]);

  // NEW-FU-133 + FU-139: per-lane width AND shortest card height drive the
  // tier. The tier is GLOBAL — every day has the same per-lane width via
  // proportional flex. Shortest card height = the min slot duration in
  // any visible section × pxPerMin (drops as user zooms out).
  const laneWidth = dayColsWidth / Math.max(1, totalLanes);
  const shortestCardHeight = useMemo(() => {
    let minDur = 50; // sensible default (50-min Lec is the seed's mode)
    for (const day of DAYS) {
      for (const sec of (sectionsByDay[day] ?? [])) {
        const d = toMinutes(sec.endTime ?? sec.end_time) - toMinutes(sec.startTime ?? sec.start_time);
        if (d > 0 && d < minDur) minDur = d;
      }
    }
    return minDur * pxPerMin;
  }, [sectionsByDay, pxPerMin]);
  const tier = pickTier(laneWidth, shortestCardHeight);

  // Build conflict map — propagate to ALL siblings (same course+sectionNumber)
  const conflictMap = useMemo(() => {
    const cm = {};
    for (const conflict of conflicts) {
      [conflict.sectionAId, conflict.sectionBId].filter(Boolean).forEach(id => {
        if (!cm[id]) cm[id] = [];
        cm[id].push(conflict);
      });
    }
    const groups = new Map();
    for (const sec of sections) {
      const key = `${sec.courseId ?? sec.course_id}|${sec.sectionNumber ?? sec.section_number}`;
      let bucket = groups.get(key);
      if (!bucket) { bucket = { siblingIds: [], seen: new Set(), conflicts: [] }; groups.set(key, bucket); }
      bucket.siblingIds.push(sec.id);
      for (const conflict of (cm[sec.id] ?? [])) {
        const ckey = conflict.ruleId + '|' + (conflict.sectionAId ?? '') + '|' + (conflict.sectionBId ?? '');
        if (!bucket.seen.has(ckey)) {
          bucket.seen.add(ckey);
          bucket.conflicts.push(conflict);
        }
      }
    }
    for (const { siblingIds, conflicts: c } of groups.values()) {
      if (c.length === 0) continue;
      for (const sibId of siblingIds) cm[sibId] = c;
    }
    return cm;
  }, [conflicts, sections]);

  return (
    <div className="sg-root" style={{ '--row-height': `${rowH}px` }}>
      {/* NEW-FU-204 (Phase 81): the in-app zoom +/− controls were removed. The
          grid is locked to the single fit-to-viewport level (see the fit effect
          above). Browser-native zoom (Cmd +/−) remains available for close-ups. */}
      <div className="sg-left-col">
        <div className="sg-time-spacer" />
        <div className="sg-time-col" style={{ height: GRID_HEIGHT }}>
          {HOUR_MARKS.map(mark => {
            const top = pixelOffsetAt(toMinutes(mark));
            return (
              <div key={mark} className="sg-hour-mark" style={{ top }}>
                <span className="sg-hour-label">{mark}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* NEW-FU-132: day columns use flex-grow proportional to maxLanesPerDay.
          All 5 days fit within the available container width — no horizontal
          scroll regardless of any single day's overlap density. */}
      <div className="sg-right-col">
        <div className="sg-day-headers">
          {DAYS.map(day => (
            <div key={day} className="sg-day-header" style={{
              flex: `${maxLanesPerDay[day]} 1 0`,
              // NEW-FU-162 (Phase 75 R3): MIN width = lanes × MIN_LANE_PX so a
              // dense day never squeezes its lanes below readable width; the
              // grid scrolls horizontally instead. Matches the day-col min so
              // header and body stay aligned when scrolled.
              minWidth: maxLanesPerDay[day] * MIN_LANE_PX,
            }}>{day}</div>
          ))}
        </div>
        <div className="sg-day-cols" ref={dayColsRef} style={{ height: GRID_HEIGHT }}>
          {DAYS.map(day => (
            <DayColumn
              key={day}
              day={day}
              height={GRID_HEIGHT}
              maxLanes={maxLanesPerDay[day]}
              layouts={layoutsByDay[day] ?? []}
              officeHours={ohByDay[day] ?? []}
              conflictMap={conflictMap}
              onBlockClick={onBlockClick}
              onOHClick={onOHClick}
              onSectionDelete={onSectionDelete}
              pxPerMin={pxPerMin}
              pixelOffsetAt={pixelOffsetAt}
              tier={tier}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const DROP_STEP = 15;

// NEW-FU-162 (Phase 75 R3): minimum per-lane width (CSS px). A lane this wide
// holds "11:00–11:50" at a readable mono size with padding. At default zoom the
// flex layout already gives lanes ≥ this, so the min never binds (no horizontal
// scroll). At high browser zoom the effective width shrinks below it, the min
// holds, and the grid scrolls horizontally — keeping text un-clipped. 46px is
// the empirical floor where the densest term's total still fits the viewport at
// default zoom (no scroll regression) while binding at ~1.4× zoom and beyond.
const MIN_LANE_PX = 46;

function DayColumn({ day, height, maxLanes, layouts, officeHours, conflictMap, onBlockClick, onOHClick, onSectionDelete, pxPerMin, pixelOffsetAt, tier }) {
  const dropZones = [];
  for (let m = DISPLAY_START; m < DISPLAY_END; m += DROP_STEP) dropZones.push(m);

  return (
    <div className="sg-day-col" style={{
      height,
      flex: `${maxLanes} 1 0`,
      // NEW-FU-190 (Phase 77): floor the card-column body width at
      // maxLanes × MIN_LANE_PX — the SAME floor Phase 75 put on the day HEADER
      // (line ~464). The body kept minWidth:0, so on a dense day (term 262's
      // 6-lane clusters) the column compressed and each lane fell to ~30px —
      // narrower than a single glyph, which no font/scale can fill (the residual
      // clips). Matching the header floor forces a dense column wide enough for
      // every lane to be ≥46px; .sg-root overflow:auto already supplies the
      // horizontal scroll. Sparse terms (251) stay under the viewport, so the
      // floor doesn't bind and no scrollbar appears there.
      minWidth: maxLanes * MIN_LANE_PX,
    }}>
      {HOUR_MARKS.map(mark => {
        const top = pixelOffsetAt(toMinutes(mark));
        return <div key={mark}    className="sg-hour-line" style={{ top }} />;
      })}
      {HOUR_MARKS.slice(0,-1).map(mark => {
        const top = pixelOffsetAt(toMinutes(mark) + 30);
        return <div key={mark+'.5'} className="sg-half-line" style={{ top }} />;
      })}

      {dropZones.map(m => {
        const top = pixelOffsetAt(m);
        const nextTop = pixelOffsetAt(Math.min(m + DROP_STEP, DISPLAY_END));
        return <DropZone key={m} id={`${day}|${m}`} top={top} height={nextTop - top} />;
      })}

      {officeHours.map((oh, i) => {
        const start = oh.start_time ?? oh.startTime;
        const end   = oh.end_time   ?? oh.endTime;
        if (!start || !end) return null;
        const top = pixelOffsetAt(toMinutes(start));
        const h = pixelOffsetAt(toMinutes(end)) - top;
        return (
          <div key={i} style={{ position:'absolute', top, left:2, right:2, height: Math.max(h, 20), zIndex:2 }}>
            <OfficeHourBlock officeHour={oh} onClick={() => onOHClick && onOHClick(oh)} />
          </div>
        );
      })}

      {layouts.map(({ sec, laneIndex, laneTotal }) => {
        const start = sec.startTime ?? sec.start_time;
        const end   = sec.endTime   ?? sec.end_time;
        if (!start || !end) return null;
        const startMin = toMinutes(start);
        const endMin   = toMinutes(end);
        const top      = pixelOffsetAt(startMin);
        const height   = pixelOffsetAt(endMin) - top;
        const colW     = 100 / laneTotal;
        return (
          <div key={sec.id} style={{
            position:'absolute', top,
            left:  `calc(${laneIndex * colW}% + 2px)`,
            width: `calc(${colW}% - 4px)`,
            height: Math.max(height, 20),
            zIndex:3,
          }}>
            <SectionBlock
              section={sec}
              conflicts={conflictMap[sec.id] ?? []}
              onClick={() => onBlockClick && onBlockClick(sec)}
              onDelete={onSectionDelete}
              height={height}
              tier={tier}
            />
          </div>
        );
      })}
    </div>
  );
}

function DropZone({ id, top, height }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef}
      className={`sg-drop-zone ${isOver ? 'over' : ''}`}
      style={{ top, height }}
    />
  );
}
