import React, { useState, useEffect } from 'react';
// NEW-FU-503 (Phase 123): shared SVG icons replace emoji glyphs.
import Ico from '../shared/Icons.jsx';
import * as api from '../../api/index.js';
import './SectionModal.css';

// NEW-FU-319 (Phase 29): Quick Fix preview modal. Renders the plan
// returned by /quick-fix with per-op checkboxes (drops default-off),
// summary line, and Apply/Cancel actions. Click → POST /quick-fix/apply
// with the selected ops → backend runs them in one transaction.
//
// Op types currently produced by QuickFixService (Phase 29 + Phase 30):
//   reassign-instructor  → default CHECKED   (low-risk swap of teacher;
//                                             handles R-04 conflicts
//                                             AND R-09 missing-instructor)
//   reassign-venue       → default CHECKED   (low-risk swap of room;
//                                             handles R-05 conflicts
//                                             AND R-10 missing-venue +
//                                             R-11/R-12 type mismatch)
//   add-day              → default CHECKED   (Phase 30 — R-15 credit-
//                                             coverage fix; additive,
//                                             non-destructive)
//   drop                 → default UNCHECKED (last resort — user must
//                                             explicitly opt in)

const OP_TYPE_LABEL = {
  'reassign-instructor': 'Reassign Instructor',
  'reassign-venue':      'Reassign Venue',
  'add-day':             'Add Meeting Day',
  'move':                'Move Time Slot',
  'compound':            'Move + Reassign',
  'drop':                'Drop Section',
  // NEW-FU-426 (Phase 105): placeholder-resource ops (parity with Suggest).
  'add-dummy-instructor':'Add Placeholder Instructor',
  'add-dummy-venue':     'Add Placeholder Venue',
};

const OP_TYPE_COLOR = {
  'reassign-instructor': '#0f766e',  // teal — same as the R-04/R-05 fix buttons
  'reassign-venue':      '#0f766e',
  'add-day':             '#0f766e',  // teal — additive, non-destructive
  'move':                '#0369a1',  // blue — shifts time, moderate disruption
  'compound':            '#0369a1',  // blue — multi-step but still non-destructive
  'drop':                '#b91c1c',  // red — destructive
  // NEW-FU-426 (Phase 105): amber — adds a placeholder resource (matches the
  // sidebar's "placeholder" badge); constructive, far better than a drop.
  'add-dummy-instructor':'#b45309',
  'add-dummy-venue':     '#b45309',
};

export default function QuickFixModal({ scheduleId, onClose, onApplied, showToast }) {
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [plan,     setPlan]     = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Fetch the plan on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await api.quickFixPlan(scheduleId);
        if (cancelled) return;
        setPlan(p);
        // Default: all checked EXCEPT drops.
        const defaults = new Set();
        for (const op of p.ops ?? []) {
          if (op.type !== 'drop') defaults.add(op.id);
        }
        setSelected(defaults);
      } catch (err) {
        if (cancelled) return;
        setError(err.response?.data?.error ?? err.message ?? 'Failed to compute plan.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scheduleId]);

  function toggleOp(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else              next.add(id);
      return next;
    });
  }

  async function handleApply() {
    if (!plan || selected.size === 0) return;
    setApplying(true);
    try {
      const ops = plan.ops.filter(op => selected.has(op.id));
      const result = await api.quickFixApply(scheduleId, ops);
      showToast?.(`✓ Applied ${result.applied} fix${result.applied === 1 ? '' : 'es'}.`, 'success');
      onApplied?.();
      onClose();
    } catch (err) {
      showToast?.('Quick Fix failed: ' + (err.response?.data?.error ?? err.message), 'error');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="sm-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sm-card" style={{maxWidth: 720, width: '95vw'}}>
        <div className="sm-header">
          <h2 className="sm-title"><Ico name="sparkles" /> Quick Fix Conflicts</h2>
          <button className="sm-close" onClick={onClose}>×</button>
        </div>

        <div style={{padding: '12px 24px', fontSize: '.85rem', color: 'var(--slate-600)'}}>
          The resolver analyzed your conflicts and proposed a sequence of fixes.
          Review the plan, opt out of any you don't want, then apply.
          {' '}
          <strong style={{color: '#b91c1c'}}>Drops are unchecked by default — they're the last resort.</strong>
        </div>

        {loading && (
          <div style={{padding: '24px', textAlign: 'center', color: 'var(--slate-500)'}}>
            Computing fix plan…
          </div>
        )}

        {error && (
          <div style={{padding: '12px 24px', color: '#b91c1c'}}>
            <Ico name="alert" /> {error}
          </div>
        )}

        {plan && !loading && !error && (
          <>
            <div style={{padding: '0 24px 12px', fontSize: '.82rem', color: 'var(--slate-700)'}}>
              <strong>Summary:</strong> {plan.summary.initialHard} hard + {plan.summary.initialSoft} soft
              {' → '}
              <strong style={{color: plan.summary.remainingHard + plan.summary.remainingSoft === 0 ? '#0f766e' : '#b45309'}}>
                {plan.summary.remainingHard} hard + {plan.summary.remainingSoft} soft remaining
              </strong>
              {' '}(if all ops applied)
            </div>

            <div style={{padding: '0 24px', maxHeight: '50vh', overflowY: 'auto'}}>
              {plan.ops.length === 0 && (
                <div style={{padding: '16px', textAlign: 'center', color: 'var(--slate-500)', fontStyle: 'italic'}}>
                  {/* NEW-FU-345 (Phase 33): concise empty state. The
                      Phase 30 verbose copy listed every supported op
                      type — operationally noisy. One line is enough:
                      the user only needs to know there's no fix AND
                      where to look next (the conflict in the side
                      panel). */}
                  {plan.unresolvedRuleIds && plan.unresolvedRuleIds.length > 0 ? (
                    <>
                      No automatic fix for{' '}
                      <strong style={{color: '#b91c1c'}}>{plan.unresolvedRuleIds.join(', ')}</strong>.
                      Open the conflict to resolve manually.
                    </>
                  ) : (
                    'No conflicts to fix — schedule is clean.'
                  )}
                </div>
              )}
              {plan.ops.map((op) => (
                <label
                  key={op.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '8px 0',
                    borderBottom: '1px solid var(--slate-100)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(op.id)}
                    onChange={() => toggleOp(op.id)}
                    style={{marginTop: 4, accentColor: OP_TYPE_COLOR[op.type] ?? '#475569'}}
                  />
                  <div style={{flex: 1}}>
                    <div style={{
                      display: 'inline-block',
                      padding: '1px 6px',
                      borderRadius: 3,
                      fontSize: '.62rem',
                      fontWeight: 700,
                      letterSpacing: '.04em',
                      textTransform: 'uppercase',
                      color: '#fff',
                      background: OP_TYPE_COLOR[op.type] ?? '#475569',
                      marginRight: 8,
                    }}>
                      {OP_TYPE_LABEL[op.type] ?? op.type}
                    </div>
                    <span style={{fontSize: '.85rem'}}>{op.label}</span>
                    {op.willResolveCount && (
                      <div style={{fontSize: '.72rem', color: 'var(--slate-500)', marginTop: 2}}>
                        Resolves {op.willResolveCount.hard} hard, {op.willResolveCount.soft} soft
                      </div>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="sm-actions" style={{padding: '12px 24px 20px'}}>
          <button className="sm-btn-cancel" onClick={onClose}>Cancel</button>
          <button
            className="sm-btn-save"
            onClick={handleApply}
            disabled={loading || applying || !plan || selected.size === 0}
          >
            {applying ? 'Applying…' : <><Ico name="check" /> Apply {selected.size} {selected.size === 1 ? 'fix' : 'fixes'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
