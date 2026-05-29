import React, { useEffect } from 'react';
import './SoftConflictModal.css';

export default function SoftConflictModal({ conflicts, onConfirm, onCancel }) {
  // M-6: Escape key closes the modal (dismiss = go back, same as onCancel)
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onCancel(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  if (!conflicts || conflicts.length === 0) return null;

  return (
    // M-6: Clicking the backdrop also cancels (same behaviour as other modals)
    <div className="modal-overlay" role="dialog" aria-modal="true"
         aria-labelledby="modal-title"
         onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal-card">
        <div className="modal-icon">⚠️</div>

        <h2 className="modal-title" id="modal-title">
          Scheduling Warnings
        </h2>

        <p className="modal-lead">
          The following soft conflicts were detected. You may save anyway or go back to resolve them:
        </p>

        <ul className="modal-conflict-list">
          {conflicts.map((c, i) => (
            <li key={i} className="modal-conflict-item">
              <span className="modal-rule">{c.ruleId}</span>
              <span className="modal-desc">{c.description}</span>
            </li>
          ))}
        </ul>

        <p className="modal-question">
          Are you sure you want to save this schedule?
        </p>

        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={onCancel}>
            ← Go Back
          </button>
          <button className="modal-btn confirm" onClick={onConfirm}>
            Dismiss &amp; Save →
          </button>
        </div>
      </div>
    </div>
  );
}
