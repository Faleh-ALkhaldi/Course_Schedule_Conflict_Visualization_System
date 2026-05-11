import React, { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  useApp, DAYS, LEVEL_COLORS, SOFT_CONFLICT_BG, HARD_CONFLICT_BG,
  PX_PER_MIN, toMinutes, fromMinutes, SLOT_STEP,
} from '../../context/AppContext.jsx';
import SectionBlock from './SectionBlock.jsx';
import OfficeHourBlock from './OfficeHourBlock.jsx';
import './ScheduleGrid.css';

const DISPLAY_START = 7 * 60;
const DISPLAY_END   = 22 * 60;
const GRID_HEIGHT   = (DISPLAY_END - DISPLAY_START) * PX_PER_MIN;

function getHourMarks() {
  const marks = [];
  for (let h = 7; h <= 22; h++) marks.push(`${String(h).padStart(2,'0')}:00`);
  return marks;
}
const HOUR_MARKS = getHourMarks();

function blockGeometry(startTime, endTime) {
  const start  = toMinutes(startTime);
  const end    = toMinutes(endTime);
  const top    = (start - DISPLAY_START) * PX_PER_MIN;
  const height = Math.max((end - start) * PX_PER_MIN - 2, 20);
  return { top, height };
}

function layoutSections(sections) {
  if (!sections.length) return [];

  // Step 1: assign each section a column index using greedy interval scheduling
  const sorted = [...sections].sort((a,b) =>
    toMinutes(a.startTime??a.start_time) - toMinutes(b.startTime??b.start_time)
  );

  // colEnds[i] = end time of last section placed in column i
  const colEnds = [];
  const assignments = new Map(); // section id → colIndex

  for (const sec of sorted) {
    const start = toMinutes(sec.startTime ?? sec.start_time);
    const end   = toMinutes(sec.endTime   ?? sec.end_time);
    let placed  = false;
    for (let ci = 0; ci < colEnds.length; ci++) {
      if (start >= colEnds[ci]) {
        assignments.set(sec.id, ci);
        colEnds[ci] = end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      assignments.set(sec.id, colEnds.length);
      colEnds.push(end);
    }
  }

  const totalCols = colEnds.length;

  // Step 2: for each section, find how many columns are truly active
  // during its time span (i.e. how wide the column area is at that moment)
  return sorted.map(sec => {
    const start    = toMinutes(sec.startTime ?? sec.start_time);
    const end      = toMinutes(sec.endTime   ?? sec.end_time);
    const colIndex = assignments.get(sec.id) ?? 0;

    // Find the maximum column index used by any section overlapping this one
    let maxColUsed = colIndex;
    for (const other of sorted) {
      if (other.id === sec.id) continue;
      const os = toMinutes(other.startTime ?? other.start_time);
      const oe = toMinutes(other.endTime   ?? other.end_time);
      if (start < oe && os < end) {
        const oci = assignments.get(other.id) ?? 0;
        if (oci > maxColUsed) maxColUsed = oci;
      }
    }
    const colTotal = maxColUsed + 1;

    return { sec, colIndex, colTotal };
  });
}

export default function ScheduleGrid({ onBlockClick, onOHClick }) {
  const { sections, officeHours, conflicts } = useApp();
  const [dropHighlight, setDropHighlight]    = useState(null);

  const sectionsByDay = {};
  const ohByDay       = {};
  for (const day of DAYS) {
    sectionsByDay[day] = sections.filter(s => s.day === day);
    ohByDay[day]       = officeHours.filter(o => o.day === day);
  }

  // Build conflict map — propagate to ALL siblings (same course+sectionNumber = grouped days)
  const conflictMap = {};

  // First pass: map directly involved section IDs
  for (const conflict of conflicts) {
    [conflict.sectionAId, conflict.sectionBId].filter(Boolean).forEach(id => {
      if (!conflictMap[id]) conflictMap[id] = [];
      conflictMap[id].push(conflict);
    });
  }

  // Second pass: for each section in a group, collect ALL conflicts from ALL siblings
  // so every day of the group shows the same (worst) conflict state
  for (const sec of sections) {
    const courseId = sec.courseId ?? sec.course_id;
    const secNum   = sec.sectionNumber ?? sec.section_number;

    // Find all siblings (including self)
    const siblings = sections.filter(other =>
      (other.courseId ?? other.course_id) === courseId &&
      (other.sectionNumber ?? other.section_number) === secNum
    );

    // Collect all conflicts from all siblings in the group
    const groupConflicts = [];
    const seen = new Set();
    for (const sib of siblings) {
      for (const conflict of (conflictMap[sib.id] ?? [])) {
        const key = conflict.ruleId + '|' + (conflict.sectionAId??'') + '|' + (conflict.sectionBId??'');
        if (!seen.has(key)) { seen.add(key); groupConflicts.push(conflict); }
      }
    }

    // Apply merged conflicts to ALL siblings
    if (groupConflicts.length > 0) {
      for (const sib of siblings) {
        conflictMap[sib.id] = groupConflicts;
      }
    }
  }

  return (
    <div className="sg-root">
      {/* Time axis */}
      <div className="sg-left-col">
        <div className="sg-time-spacer" />
        <div className="sg-time-col" style={{ height: GRID_HEIGHT }}>
          {HOUR_MARKS.map(mark => {
            const top = (toMinutes(mark) - DISPLAY_START) * PX_PER_MIN;
            return (
              <div key={mark} className="sg-hour-mark" style={{ top }}>
                <span className="sg-hour-label">{mark}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Day columns */}
      <div className="sg-right-col">
        <div className="sg-day-headers">
          {DAYS.map(day => (
            <div key={day} className="sg-day-header">{day}</div>
          ))}
        </div>
        <div className="sg-day-cols" style={{ height: GRID_HEIGHT }}>
          {DAYS.map(day => (
            <DayColumn
              key={day}
              day={day}
              height={GRID_HEIGHT}
              sections={sectionsByDay[day] ?? []}
              officeHours={ohByDay[day] ?? []}
              conflictMap={conflictMap}
              onBlockClick={onBlockClick}
              onOHClick={onOHClick}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayColumn({ day, height, sections, officeHours, conflictMap, onBlockClick, onOHClick }) {
  const laid = layoutSections(sections);

  const dropZones = [];
  for (let m = DISPLAY_START; m < DISPLAY_END; m += SLOT_STEP) dropZones.push(m);

  return (
    <div className="sg-day-col" style={{ height }}>
      {HOUR_MARKS.map(mark => {
        const top = (toMinutes(mark) - DISPLAY_START) * PX_PER_MIN;
        return <div key={mark}    className="sg-hour-line" style={{ top }} />;
      })}
      {HOUR_MARKS.slice(0,-1).map(mark => {
        const top = (toMinutes(mark) - DISPLAY_START + 30) * PX_PER_MIN;
        return <div key={mark+'.5'} className="sg-half-line" style={{ top }} />;
      })}

      {dropZones.map(m => (
        <DropZone key={m} id={`${day}|${m}`}
          top={(m - DISPLAY_START) * PX_PER_MIN}
          height={SLOT_STEP * PX_PER_MIN}
        />
      ))}

      {officeHours.map((oh, i) => {
        const start = oh.start_time ?? oh.startTime;
        const end   = oh.end_time   ?? oh.endTime;
        if (!start || !end) return null;
        const { top, height: h } = blockGeometry(start, end);
        return (
          <div key={i} style={{ position:'absolute', top, left:2, right:2, height:h, zIndex:2 }}>
            <OfficeHourBlock officeHour={oh} onClick={() => onOHClick && onOHClick(oh)} />
          </div>
        );
      })}

      {laid.map(({ sec, colIndex, colTotal }) => {
        const start = sec.startTime ?? sec.start_time;
        const end   = sec.endTime   ?? sec.end_time;
        if (!start || !end) return null;
        const { top, height: h } = blockGeometry(start, end);
        const colW  = 100 / colTotal;
        return (
          <div key={sec.id} style={{
            position:'absolute', top,
            left:`calc(${colIndex*colW}% + 2px)`,
            width:`calc(${colW}% - 4px)`,
            height:h, zIndex:3,
          }}>
            <SectionBlock
              section={sec}
              conflicts={conflictMap[sec.id] ?? []}
              onClick={() => onBlockClick && onBlockClick(sec)}
              height={h}
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
