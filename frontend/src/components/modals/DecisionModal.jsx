import React, { useEffect, useRef } from 'react';
// NEW-FU-503 (Phase 123): SVG default icon replaces the ⚠️ emoji default.
import Ico from '../shared/Icons.jsx';
import './SoftConflictModal.css';
import './DecisionModal.css';

// NEW-FU-223 (Phase 96): a small, generic, in-app decision dialog.
//
// It replaces the chain of native window.confirm() / window.alert() calls the
// Suggest flow used to drive its "your picks conflict — what now?" decisions.
// Native dialogs can't show a plain-language conflict list, can't offer more
// than OK/Cancel, and look nothing like the rest of the app. This component
// renders a styled card with an optional bullet list and N labelled buttons,
// each carrying its own return value and visual tone.
//
// It is intentionally presentational + imperative-friendly: the parent holds
// the dialog spec in state (see SchedulerPage's askDecision helper) and gets
// the chosen value back through onChoose. Dismissing (Escape / backdrop)
// resolves to the dialog's dismissValue so the caller can treat it as
// "cancelled".
export default function DecisionModal({
  icon = <Ico name="alert" />,
  title,
  lead,
  bullets = [],
  question,
  options = [],          // [{ label, value, tone: 'primary'|'danger'|'neutral' }]
  onChoose,
  onDismiss,
}) {
  // NEW-FU-448 (Phase 107 M8): keyboard operability. The two-option Suggest
  // chooser is the central decision surface — it must be usable without a mouse.
  // Focus the primary action on open and bind Enter to it; Escape still cancels.
  const primaryRef = useRef(null);
  const primaryIdx = Math.max(0, options.findIndex(o => o.tone === 'primary'));
  const primaryValue = options[primaryIdx]?.value;

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') { onDismiss?.(); }
      else if (e.key === 'Enter' && primaryValue !== undefined) { e.preventDefault(); onChoose?.(primaryValue); }
    }
    document.addEventListener('keydown', onKeyDown);
    primaryRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDismiss, onChoose, primaryValue]);

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="decision-modal-title"
      aria-describedby={lead ? 'decision-modal-desc' : undefined}
      onClick={e => e.target === e.currentTarget && onDismiss?.()}
    >
      <div className="modal-card decision-card">
        {icon && <div className="modal-icon">{icon}</div>}

        {title && <h2 className="modal-title" id="decision-modal-title">{title}</h2>}
        {lead && <p className="modal-lead" id="decision-modal-desc">{lead}</p>}

        {bullets.length > 0 && (
          <ul className="decision-bullets">
            {bullets.map((b, i) => (
              <li key={i} className="decision-bullet">{b}</li>
            ))}
          </ul>
        )}

        {question && <p className="modal-question">{question}</p>}

        <div className="modal-actions decision-actions">
          {options.map((opt, i) => (
            <button
              key={i}
              ref={i === primaryIdx ? primaryRef : null}
              className={`modal-btn decision-btn ${opt.tone || 'neutral'}`}
              onClick={() => onChoose?.(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
