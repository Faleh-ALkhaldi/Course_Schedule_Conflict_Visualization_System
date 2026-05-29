import React, { useState, useEffect } from 'react';
import * as api from '../../api';
import './TermPicker.css';

// NEW-FU-167: Two-stage delete confirmation.
// Stage 1: "are you sure" with destructive Continue button.
// Stage 2: type-to-confirm — must type "DELETE <code>" exactly.

export function DeleteTermModal({ term, activeCode, onClose, onDeleted }) {
  const [stage, setStage] = useState(1);
  const [typed, setTyped] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  const expected = `DELETE ${term.code}`;
  const ok = typed === expected;

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleDelete() {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteTerm(term.code, activeCode);
      onDeleted();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to delete term.');
      setBusy(false);
    }
  }

  return (
    <div className="tp-modal-overlay" onClick={onClose}>
      <div className="tp-modal" onClick={e => e.stopPropagation()}>
        {stage === 1 ? (
          <>
            <h2 className="tp-modal-title">Delete Term {term.code} ({term.label})?</h2>
            <p className="tp-modal-body">
              This will permanently remove the schedule and all its sections,
              office hours, and conflicts for this term. Shared resources
              (courses / instructors / venues) that are not used by any other
              term will also be removed.
            </p>
            <div className="tp-modal-actions">
              <button type="button" className="tp-btn-secondary" onClick={onClose}>Cancel</button>
              <button type="button" className="tp-btn-danger" onClick={() => setStage(2)}>Continue</button>
            </div>
          </>
        ) : (
          <>
            <h2 className="tp-modal-title">Final confirmation</h2>
            <p className="tp-modal-body">
              You are about to delete <strong>{term.sectionCount} sections</strong>
              ({term.courseCount} courses, {term.instructorCount} instructors,
              {' '}{term.venueCount} venues). This cannot be undone.
              <br /><br />
              Type <code>{expected}</code> below to confirm.
            </p>
            <input
              type="text"
              className="tp-modal-input"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={expected}
              autoFocus
            />
            {error && <div className="tp-error">{error}</div>}
            <div className="tp-modal-actions">
              <button type="button" className="tp-btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button
                type="button"
                className="tp-btn-danger"
                onClick={handleDelete}
                disabled={!ok || busy}
              >
                {busy ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
