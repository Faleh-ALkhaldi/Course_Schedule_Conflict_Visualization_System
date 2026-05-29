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

const ROW_H_DEFAULT = 48;
const ROW_H_MIN     = 22;
const ROW_H_MAX     = 96;
const ROW_H_STEP    = 8;

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

  return meta.map(({ sec, start, end, laneIndex }) => {
    let maxLane = laneIndex;
    for (const o of meta) {
      if (o.sec === sec) continue;
      if (start < o.end && o.start < end && o.laneIndex > maxLane) {
        maxLane = o.laneIndex;
      }
    }
    return { sec, laneIndex, laneTotal: maxLane + 1 };
  });
}

export default function ScheduleGrid({ onBlockClick, onOHClick, onSectionDelete }) {
  const { sections, officeHours, conflicts } = useApp();
  const [dropHighlight, setDropHighlight]    = useState(null);
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
      <div className="sg-zoom-controls">
        <button
          className="sg-zoom-btn"
          onClick={() => setRowH(h => Math.min(h + ROW_H_STEP, ROW_H_MAX))}
          disabled={rowH >= ROW_H_MAX}
          title="Zoom in"
        >＋</button>
        <button
          className="sg-zoom-btn"
          onClick={() => setRowH(h => Math.max(h - ROW_H_STEP, ROW_H_MIN))}
          disabled={rowH <= ROW_H_MIN}
          title="Zoom out"
        >－</button>
      </div>

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
              minWidth: 0,
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

function DayColumn({ day, height, maxLanes, layouts, officeHours, conflictMap, onBlockClick, onOHClick, onSectionDelete, pxPerMin, pixelOffsetAt, tier }) {
  const dropZones = [];
  for (let m = DISPLAY_START; m < DISPLAY_END; m += DROP_STEP) dropZones.push(m);

  return (
    <div className="sg-day-col" style={{
      height,
      flex: `${maxLanes} 1 0`,
      minWidth: 0,
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
