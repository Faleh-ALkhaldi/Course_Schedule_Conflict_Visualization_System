import React, { useEffect } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
// NEW-FU-503 (Phase 123): SVG icon replaces the ⚠️ emoji in the title.
import Ico from '../shared/Icons.jsx';
import { sectionLabel } from '../../context/AppContext.jsx';
import './SectionModal.css';

// NEW-FU-642 (issue #4): label a day-set + duration ACCURATELY (e.g. "Tue / Thu (2 days × 75 min)").
// The old modal mapped every day to a coarse STT/MW group, so a Tue/Thu 75-min section was
// mislabeled "Sun/Tue/Thu, 50 min" and the resulting pattern shown disagreed with what the
// restructure actually applied. Now the parent passes the section's REAL current pattern and the
// EXACT target (the same targetPatternForDrag confirmGroupChange uses), and we just format them.
const DAY_ABBR  = { Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu' };
const DAY_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
function patternLabel(p) {
  if (!p || !Array.isArray(p.days) || !p.days.length) return null;
  const days  = [...p.days].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  const names = days.map(d => DAY_ABBR[d] ?? d).join(' / ');
  const n     = days.length;
  return `${names} (${n} day${n > 1 ? 's' : ''} × ${p.duration} min)`;
}

export default function GroupChangeModal({ sec, newDay, newStartTime, current, target, onConfirm, onCancel }) {
  useFocusTrap();
  // NEW-L13: Escape closes the modal (same as Cancel) — matches the
  // dismiss-on-Escape behaviour the other modals already have.
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onCancel(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const courseCode = sec?.courseCode ?? sec?.course_code ?? '';
  // NEW-FU-282 (Phase 56): use sectionLabel so "F-01" sections render as "§F-01".
  const secLbl     = sectionLabel(sec);
  const curLbl     = patternLabel(current);
  const tgtLbl     = patternLabel(target);
  const tgtCount   = Array.isArray(target?.days) ? target.days.length : 0;

  return (
    <div className="sm-overlay" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="sm-card" role="dialog" aria-modal="true" aria-label="Change meeting group" style={{ maxWidth: 460, borderTopColor: 'var(--amber-500)' }}>
        <div className="sm-header">
          <h2 className="sm-title"><Ico name="alert" /> Change Day Group?</h2>
          <button className="sm-close" onClick={onCancel}>×</button>
        </div>

        <div className="sm-form" style={{ padding: '16px 24px 24px' }}>
          <div style={{
            background: 'var(--soft-yellow)', border: '1px solid #fcd34d',
            borderRadius: 8, padding: '12px 14px', marginBottom: 16,
            fontSize: '.88rem', lineHeight: 1.6, color: 'var(--warn-fg)',
          }}>
            <strong>{courseCode} {secLbl}</strong> is currently a{' '}
            <strong>{curLbl || 'single-day'}</strong> section.
            <br /><br />
            You dropped it on <strong>{newDay}</strong>, which changes it to a{' '}
            <strong>{tgtLbl || 'single-day'}</strong> schedule.
            <br /><br />
            This will move the whole section to{' '}
            <strong>{tgtLbl || newDay}</strong> at <strong>{newStartTime}</strong>
            {tgtCount ? <> ({tgtCount} meeting{tgtCount > 1 ? 's' : ''} per week)</> : null}.
            {' '}Days the section already meets are kept and re-timed; no duplicate sections are created.
          </div>

          <div className="sm-actions">
            <button className="sm-btn-cancel" onClick={onCancel}>
              Cancel — keep original
            </button>
            <button className="sm-btn-save" onClick={onConfirm}
              style={{ background: 'var(--amber-500)', borderColor: 'var(--amber-500)' }}>
              Confirm change →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
