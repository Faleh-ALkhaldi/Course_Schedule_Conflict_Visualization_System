import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import * as api from '../../api';
import './TermPicker.css';

// NEW-FU-185: rename-term modal. Lets admins fix typos / migrate legacy
// labels without delete+recreate. Backend validates the new code via
// decodeTerm() and rejects collisions with 409.

const TERM_RE = /^\d{2}[123]$/;
// NEW-FU-656: mirror AddTermModal's allowed range (251 Fall 2025 – 303 Summer 2031) so Rename catches
// out-of-range codes inline too.
const CODE_MIN = 251;
const CODE_MAX = 303;

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
  const [hint, setHint]       = useState('');   // NEW-FU-656: transient "only numbers" hint
  const hintTimer = useRef(null);
  function flashHint(msg) {
    setHint(msg);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(''), 2500);
  }

  const preview     = useMemo(() => decodePreview(newCode), [newCode]);
  const validShape  = TERM_RE.test(newCode);
  const duplicate   = newCode && existingCodes.includes(newCode);
  const sameAsOld   = newCode === term.code;
  // NEW-FU-656: out-of-range guard, consistent with AddTermModal.
  const outOfRange  = validShape && (parseInt(newCode, 10) < CODE_MIN || parseInt(newCode, 10) > CODE_MAX);
  const canRename   = validShape && !duplicate && !sameAsOld && !outOfRange && !busy;

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
              onChange={e => {
                // NEW-FU-656: English digits 0–9 only — block letters (English/Arabic), symbols, and
                // non-English numerals at runtime; also strips pasted junk.
                if (/[^0-9]/.test(e.target.value)) flashHint('Term code accepts only numbers (0–9).');
                setNewCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 3));
              }}
              placeholder={term.code === '251' ? 'e.g. 261' : 'e.g. 251'}
              autoFocus
              inputMode="numeric"
            />
            <span className="tp-modal-hint">
              YY = academic year start, T = 1 Fall · 2 Spring · 3 Summer
            </span>
          </label>

          {hint && <div className="tp-input-hint">{hint}</div>}

          {newCode && !validShape && (
            <div className="tp-preview tp-preview-warn">
              Invalid format. Use 3 digits like <code>261</code>.
            </div>
          )}
          {validShape && outOfRange && (
            <div className="tp-preview tp-preview-warn">
              Term <code>{newCode}</code> is outside the allowed range <code>{CODE_MIN}</code>–<code>{CODE_MAX}</code>.
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
          {preview && !duplicate && !sameAsOld && !outOfRange && (
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
