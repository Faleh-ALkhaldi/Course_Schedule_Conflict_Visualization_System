import React, { useEffect } from 'react';
// NEW-FU-503 (Phase 123): SVG icon replaces the ⚠️ emoji in the title.
import Ico from '../shared/Icons.jsx';
import { sectionLabel } from '../../context/AppContext.jsx';
import './SectionModal.css';

const DAY_GROUPS = {
  Sunday:'STT', Tuesday:'STT', Thursday:'STT',
  Monday:'MW',  Wednesday:'MW',
};
const GROUP_INFO = {
  STT: { label:'Sun / Tue / Thu', days:3, duration:50 },
  MW:  { label:'Mon / Wed',       days:2, duration:75 },
};

export default function GroupChangeModal({ sec, newDay, newStartTime, actualSiblingCount, onConfirm, onCancel }) {
  // NEW-L13: Escape closes the modal (same as Cancel) — matches the
  // dismiss-on-Escape behaviour the other modals already have.
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onCancel(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const courseCode  = sec?.courseCode   ?? sec?.course_code   ?? '';
  // NEW-FU-282 (Phase 56): use sectionLabel so "F-01" sections render
  // as "§F-01" instead of "§01" in the day-group change warning.
  const secLbl      = sectionLabel(sec);
  const origGroup   = DAY_GROUPS[sec?.day] ?? 'single';
  const newGroup    = DAY_GROUPS[newDay]   ?? 'single';
  const origInfo    = GROUP_INFO[origGroup];
  const newInfo     = GROUP_INFO[newGroup];
  // NEW-FU-73: the prior copy used origInfo.days (a constant: 3 for STT,
  // 2 for MW) even when the actual schedule had fewer siblings (e.g., user
  // manually deleted one day). Now we use the parent-supplied actual count,
  // falling back to the constant when no count was supplied (defensive).
  const realOrigDays = typeof actualSiblingCount === 'number' && actualSiblingCount > 0
    ? actualSiblingCount
    : (origInfo?.days ?? 1);

  return (
    <div className="sm-overlay" onClick={e => e.target===e.currentTarget && onCancel()}>
      <div className="sm-card" style={{ maxWidth:460, borderTopColor:'var(--amber-500)' }}>
        <div className="sm-header">
          <h2 className="sm-title"><Ico name="alert" /> Change Day Group?</h2>
          <button className="sm-close" onClick={onCancel}>×</button>
        </div>

        <div className="sm-form" style={{ padding:'16px 24px 24px' }}>
          <div style={{
            background:'var(--soft-yellow)', border:'1px solid #fcd34d',
            borderRadius:8, padding:'12px 14px', marginBottom:16,
            fontSize:'.88rem', lineHeight:1.6, color:'var(--navy-900)'
          }}>
            <strong>{courseCode} {secLbl}</strong> is currently a{' '}
            <strong>{origInfo ? `${origInfo.label} group (${realOrigDays} day${realOrigDays>1?'s':''} × ${origInfo.duration} min)` : 'single-day'}</strong> section.
            <br /><br />
            You dropped it on <strong>{newDay}</strong>, which belongs to the{' '}
            <strong>{newInfo ? `${newInfo.label} group (${newInfo.days} days × ${newInfo.duration} min)` : 'single-day'}</strong> schedule.
            <br /><br />
            {newInfo && origInfo ? (
              <>
                {/* NEW-FU-73: realOrigDays reflects the actual sibling count
                    in the schedule (passed from SchedulerPage), not the
                    group constant — so a partially-deleted STT group says
                    "delete all 2 current day-sections" if only 2 exist. */}
                This will <strong>delete all {realOrigDays} current day-section{realOrigDays>1?'s':''}</strong> and{' '}
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
