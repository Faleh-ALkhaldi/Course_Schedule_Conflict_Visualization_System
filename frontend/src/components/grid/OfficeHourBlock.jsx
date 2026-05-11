import React from 'react';
import { useDraggable } from '@dnd-kit/core';
import './OfficeHourBlock.css';

export default function OfficeHourBlock({ officeHour, height, onClick }) {
  const id    = `oh-${officeHour.id}`;
  const start = (officeHour.start_time ?? officeHour.startTime ?? '').substring(0, 5);
  const end   = (officeHour.end_time   ?? officeHour.endTime   ?? '').substring(0, 5);

  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id, data: { type: 'officeHour', officeHour } });

  const style = {
    transform: transform ? `translate3d(${transform.x}px,${transform.y}px,0)` : undefined,
    opacity:   isDragging ? 0.4 : 1,
    cursor:    'grab',
    height:    height ? `${height}px` : '100%',
  };

  return (
    <div
      ref={setNodeRef}
      className="oh-block"
      style={style}
      title={`Office Hours: ${start}–${end}  —  click to edit, drag to move`}
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
