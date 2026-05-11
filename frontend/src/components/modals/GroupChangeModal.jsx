import React from 'react';
import './SectionModal.css';

const DAY_GROUPS = {
  Sunday:'STT', Tuesday:'STT', Thursday:'STT',
  Monday:'MW',  Wednesday:'MW',
};
const GROUP_INFO = {
  STT: { label:'Sun / Tue / Thu', days:3, duration:50 },
  MW:  { label:'Mon / Wed',       days:2, duration:75 },
};

export default function GroupChangeModal({ sec, newDay, newStartTime, onConfirm, onCancel }) {
  const courseCode  = sec?.courseCode   ?? sec?.course_code   ?? '';
  const secNum      = sec?.sectionNumber ?? sec?.section_number ?? '';
  const origGroup   = DAY_GROUPS[sec?.day] ?? 'single';
  const newGroup    = DAY_GROUPS[newDay]   ?? 'single';
  const origInfo    = GROUP_INFO[origGroup];
  const newInfo     = GROUP_INFO[newGroup];

  return (
    <div className="sm-overlay" onClick={e => e.target===e.currentTarget && onCancel()}>
      <div className="sm-card" style={{ maxWidth:460, borderTopColor:'var(--amber-500)' }}>
        <div className="sm-header">
          <h2 className="sm-title">⚠️ Change Day Group?</h2>
          <button className="sm-close" onClick={onCancel}>×</button>
        </div>

        <div className="sm-form" style={{ padding:'16px 24px 24px' }}>
          <div style={{
            background:'var(--soft-yellow)', border:'1px solid #fcd34d',
            borderRadius:8, padding:'12px 14px', marginBottom:16,
            fontSize:'.88rem', lineHeight:1.6, color:'var(--navy-900)'
          }}>
            <strong>{courseCode} §{secNum}</strong> is currently a{' '}
            <strong>{origInfo ? `${origInfo.label} group (${origInfo.days} days × ${origInfo.duration} min)` : 'single-day'}</strong> section.
            <br /><br />
            You dropped it on <strong>{newDay}</strong>, which belongs to the{' '}
            <strong>{newInfo ? `${newInfo.label} group (${newInfo.days} days × ${newInfo.duration} min)` : 'single-day'}</strong> schedule.
            <br /><br />
            {newInfo && origInfo ? (
              <>
                This will <strong>delete all {origInfo.days} current day-sections</strong> and{' '}
                create <strong>{newInfo.days} new sections</strong> ({newInfo.label}) at <strong>{newStartTime}</strong>.
              </>
            ) : (
              <>This will convert the section to a single day on <strong>{newDay}</strong> at <strong>{newStartTime}</strong>.</>
            )}
          </div>

          <div className="sm-actions">
            <button className="sm-btn-cancel" onClick={onCancel}>
              Cancel — keep original
            </button>
            <button className="sm-btn-save" onClick={onConfirm}
              style={{ background:'var(--amber-500)', borderColor:'var(--amber-500)' }}>
              Confirm change →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
