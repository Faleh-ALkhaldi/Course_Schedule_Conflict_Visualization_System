import React from 'react';
import { useDraggable } from '@dnd-kit/core';
import { useApp } from '../../context/AppContext.jsx';
import './OfficeHourBlock.css';

export default function OfficeHourBlock({ officeHour, height, onClick, draggable = true }) {
  const id    = `oh-${officeHour.id}`;
  const start = (officeHour.start_time ?? officeHour.startTime ?? '').substring(0, 5);
  const end   = (officeHour.end_time   ?? officeHour.endTime   ?? '').substring(0, 5);

  // NEW-FU-207: archived schedules disable OH drag. Click still fires —
  // it opens the OH modal in read-only mode (FU-206), so admins can see
  // OH details on historical terms without dragging them somewhere new.
  const { schedule } = useApp();
  // NEW-FU-561 (audit P3): finalized terms are read-only too. The drag was disabled only
  // for archived_at, so on a Finalized term the OH block could still be dragged — a ghost
  // that snaps back (the move is rejected server-side). Lock on Finalized as well.
  const isArchived = Boolean(schedule?.archived_at);
  const isLocked   = isArchived || schedule?.status === 'Finalized';

  // NEW-L16: callers in non-teacher views can opt out of drag — defends
  // against the OH block accidentally hijacking pointer events anywhere
  // it might be rendered outside Teacher View in the future.
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id, disabled: !draggable || isLocked, data: { type: 'officeHour', officeHour } });

  const style = {
    transform: transform ? `translate3d(${transform.x}px,${transform.y}px,0)` : undefined,
    opacity:   isDragging ? 0.4 : 1,
    // NEW-FU-568 (audit-2 P3): the cursor/title must track isLocked (archived OR
    // Finalized), not just isArchived — otherwise a Finalized term shows a "grab"
    // cursor + "drag to move" tooltip while the drag is actually disabled.
    cursor:    isLocked ? 'pointer' : 'grab',
    height:    height ? `${height}px` : '100%',
  };

  return (
    <div
      ref={setNodeRef}
      className="oh-block"
      style={style}
      title={isArchived
        ? `Office Hours: ${start}–${end}  —  click to view (term is archived)`
        : isLocked
        ? `Office Hours: ${start}–${end}  —  click to view (term is finalized)`
        : `Office Hours: ${start}–${end}  —  click to edit, drag to move`}
      onClick={e => { e.stopPropagation(); onClick && onClick(); }}
      aria-label={`Office Hours ${start} to ${end}`}
      {...listeners}
      {...attributes}
    >
      <span className="oh-label">Office Hours</span>
      <span className="oh-time">{start}–{end}</span>
    </div>
  );
}
