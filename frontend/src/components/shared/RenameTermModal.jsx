import React, { useState, useMemo, useEffect } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import * as api from '../../api';
import './TermPicker.css';

// NEW-FU-185: rename-term modal. Lets admins fix typos / migrate legacy
// labels without delete+recreate. Backend validates the new code via
// decodeTerm() and rejects collisions with 409.

const TERM_RE = /^\d{2}[123]$/;

function decodePreview(code) {
  if (!TERM_RE.test(code)) return null;
  const yy = parseInt(code.slice(0, 2), 10);
  const t  = code[2];
  const ayStart = 2000 + yy;
  const seasons = {
    '1': { name: 'Fall',   year: ayStart },
    '2': { name: 'Spring', year: ayStart + 1 },
    '3': { name: 'Summer', year: ayStart + 1 },
  };
  const s = seasons[t];
  return { label: `${s.name} ${s.year}` };
}

export function RenameTermModal({ term, activeCode, existingCodes, onClose, onRenamed }) {
  useFocusTrap();
  const [newCode, setNewCode] = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);

  const preview     = useMemo(() => decodePreview(newCode), [newCode]);
  const validShape  = TERM_RE.test(newCode);
  const duplicate   = newCode && existingCodes.includes(newCode);
  const sameAsOld   = newCode === term.code;
  const canRename   = validShape && !duplicate && !sameAsOld && !busy;

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleRename(e) {
    e.preventDefault();
    if (!canRename) return;
    setBusy(true);
    setError(null);
    try {
      await api.renameTerm(term.code, newCode, activeCode);
      onRenamed(newCode);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to rename term.');
      setBusy(false);
    }
  }

  return (
    <div className="tp-modal-overlay" onClick={onClose}>
      <div className="tp-modal" role="dialog" aria-modal="true" aria-label="Rename term" onClick={e => e.stopPropagation()}>
        <h2 className="tp-modal-title">Rename Term {term.code}</h2>
        <p className="tp-modal-body">
          Renaming a term changes its code in the database. Sections, conflicts, and
          office hours are unaffected — they're keyed by schedule id, not by code.
        </p>
        <form onSubmit={handleRename}>
          <label className="tp-modal-label">
            New term code (YYT)
            <input
              type="text"
              className="tp-modal-input"
              value={newCode}
              onChange={e => setNewCode(e.target.value.trim().slice(0, 3))}
              placeholder={term.code === '251' ? 'e.g. 261' : 'e.g. 251'}
              autoFocus
              maxLength={3}
              inputMode="numeric"
            />
            <span className="tp-modal-hint">
              YY = academic year start, T = 1 Fall · 2 Spring · 3 Summer
            </span>
          </label>

          {newCode && !validShape && (
            <div className="tp-preview tp-preview-warn">
              Invalid format. Use 3 digits like <code>261</code>.
            </div>
          )}
          {validShape && sameAsOld && (
            <div className="tp-preview tp-preview-warn">
              New code is the same as the current one.
            </div>
          )}
          {validShape && duplicate && (
            <div className="tp-preview tp-preview-warn">
              Term <code>{newCode}</code> already exists.
            </div>
          )}
          {preview && !duplicate && !sameAsOld && (
            <div className="tp-preview">
              <div className="tp-preview-row">
                <span>{term.code} → <strong>{newCode}</strong></span>
                <span>{preview.label}</span>
              </div>
            </div>
          )}

          {error && <div className="tp-error">{error}</div>}

          <div className="tp-modal-actions">
            <button type="button" className="tp-btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="tp-btn-primary" disabled={!canRename}>
              {busy ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
