import React from 'react';
import { useDraggable } from '@dnd-kit/core';
import { LEVEL_COLORS, HARD_CONFLICT_BG, SOFT_CONFLICT_BG } from '../../context/AppContext.jsx';
import './SectionBlock.css';

export default function SectionBlock({ section, conflicts, onClick, isDragging, height }) {
  const { attributes, listeners, setNodeRef, transform, isDragging: activeDragging } =
    useDraggable({ id: section.id, disabled: isDragging });

  const courseCode = section.courseCode    ?? section.course_code    ?? '';
  const secNum     = section.sectionNumber ?? section.section_number ?? '';
  const instrName  = section.instructorName ?? section.instructor_name ?? '';
  const venueName  = section.venueName      ?? section.venue_name      ?? '';
  const level      = section.academicLevel  ?? section.academic_level  ?? 'Freshman';
  const startTime  = (section.startTime ?? section.start_time ?? '').substring(0,5);
  const endTime    = (section.endTime   ?? section.end_time   ?? '').substring(0,5);

  const hasHard    = conflicts.some(c => c.severity === 'Hard');
  const hasSoft    = conflicts.some(c => c.severity === 'Soft');
  const hasConflict = hasHard || hasSoft;
  const colors     = LEVEL_COLORS[level] ?? LEVEL_COLORS.Freshman;
  // Red wins over yellow — if any hard conflict exists, show red
  const bg          = hasHard ? HARD_CONFLICT_BG : hasSoft ? SOFT_CONFLICT_BG : colors.bg;
  const borderColor = hasHard ? '#dc2626'        : hasSoft ? '#b45309'        : colors.border;

  const style = {
    background: bg, borderColor, color: colors.text,
    transform: transform ? `translate3d(${transform.x}px,${transform.y}px,0)` : undefined,
    opacity: activeDragging ? 0.35 : 1,
    cursor: isDragging ? 'grabbing' : 'grab',
    height: height ? `${height}px` : '100%',
  };

  const compact = height && height < 38;

  return (
    <div
      ref={setNodeRef}
      className={['sblock', hasHard?'conflict-hard':'', hasSoft?'conflict-soft':'',
        isDragging?'is-overlay':'', compact?'compact':''].filter(Boolean).join(' ')}
      style={style}
      onClick={e => { e.stopPropagation(); onClick && onClick(); }}
      title={`${courseCode} §${secNum} — ${instrName || 'No instructor'} — ${startTime}–${endTime}\nClick to edit`}
      {...listeners}
      {...attributes}
    >
      <div className="sblock-header">
        <span className="sblock-code">{courseCode}</span>
        <span className="sblock-section">§{secNum}</span>
      </div>
      {!compact && (
        <>
          <div className="sblock-time">{startTime}–{endTime}</div>
          {instrName && <div className="sblock-instr">{shortName(instrName)}</div>}
          {venueName && <div className="sblock-venue">{venueName}</div>}
          {!instrName && <div className="sblock-no-instr">⚠ No instructor</div>}
        </>
      )}
      {hasConflict && (
        <div className="sblock-dots">
          {hasHard && <div className="sblock-dot hard" title="Hard conflict" />}
          {hasSoft && <div className="sblock-dot soft" title="Soft conflict" />}
        </div>
      )}
    </div>
  );
}

function shortName(name) {
  return name.split(' ').slice(0,2).join(' ');
}
