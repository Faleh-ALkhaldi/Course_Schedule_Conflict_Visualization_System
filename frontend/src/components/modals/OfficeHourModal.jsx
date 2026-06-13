import React, { useState, useEffect } from 'react';
import { DAYS, useApp } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
import './SectionModal.css'; // reuse same modal styles

// NEW-FU-511 (Batch 2): add one hour to an "HH:MM" time, clamped to 16:00 (the
// office-hours upper edge). Used to auto-move the end time when the user sets a
// start at/after the current end, so an office-hours block stays a valid +1h span.
const OH_MAX_MIN = 16 * 60; // 16:00
function plusOneHourClamped(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.min(h * 60 + m + 60, OH_MAX_MIN);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export default function OfficeHourModal({ officeHour, instructorId, onClose, onSaved, showToast }) {
  // NEW-FU-206: when active term is archived, the modal still opens (so the
  // admin can SEE the OH) but every form input and the Save / Delete buttons
  // are disabled. This is purely UX — OH is global per-instructor, so the
  // API can't 409 here; the UI lockdown is the only enforcement axis.
  const { schedule } = useApp();
  const isArchived = Boolean(schedule?.archived_at);
  const lockedTitle = 'Term is archived — unarchive to change office hours.';
  // NEW-L14: Escape closes the modal (matches the dismiss-on-Escape pattern
  // used in the other modals).
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const start = (officeHour.start_time ?? officeHour.startTime ?? '').substring(0, 5);
  const end   = (officeHour.end_time   ?? officeHour.endTime   ?? '').substring(0, 5);

  const [form, setForm] = useState({
    day:       officeHour.day ?? 'Sunday',
    startTime: start,
    endTime:   end,
  });
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState('');

  // NEW-FU-466 (Phase 112): office hours may only be 08:00–16:00 (8 AM–4 PM).
  // Validate as the user types — flag immediately and block Save, never wait for
  // the API to bounce it. The backend enforces the same window as a backstop.
  // This is the user-facing half of the R-04 "class overlaps office hours" fix:
  // an out-of-window early block can no longer be entered here at all.
  // NEW-FU-496 (Phase 120): check BOTH endpoints against BOTH edges (catches a
  // start AFTER 16:00 / an end BEFORE 08:00, not just start<08:00 / end>16:00),
  // give the window message PRIORITY over the ordering message, and have the
  // ordering message still name the window so the user is never left guessing.
  // The inputs are clamped on change so an out-of-window value can't be entered.
  const OH_MIN = '08:00', OH_MAX = '16:00';
  const clampOH = v => !v ? v : (v < OH_MIN ? OH_MIN : v > OH_MAX ? OH_MAX : v);
  const windowBad = (form.startTime && (form.startTime < OH_MIN || form.startTime > OH_MAX)) ||
                    (form.endTime   && (form.endTime   < OH_MIN || form.endTime   > OH_MAX));
  const orderBad  = form.startTime && form.endTime && form.endTime <= form.startTime;
  const validationMsg = windowBad ? 'Office hours can only be between 8:00 AM and 4:00 PM.'
    : orderBad ? 'End time must be after the start time (office hours are 8:00 AM–4:00 PM).' : '';

  async function handleSave(e) {
    e.preventDefault();
    // H-9 + NEW-FU-466: block any out-of-window / out-of-order value at the source.
    // The user already sees `validationMsg` inline; this also stops the submit.
    if (validationMsg) { setError(validationMsg); return; }
    setBusy(true); setError('');
    try {
      // NEW-FU-41: one atomic PUT instead of the prior C-5 add-then-delete
      // pattern. The old approach was acknowledged-recoverable on its own
      // comment ("if delete subsequently fails we have a duplicate") — but
      // the user got only a generic "Failed to update" toast and no signal
      // that they now had a duplicate row in the DB. PUT updates the same
      // row id, so either the edit lands or the original is unchanged.
      await api.updateInstructorOfficeHour(instructorId, officeHour.id, form);
      showToast('✓ Office hours updated.', 'success');
      onSaved();
      onClose();
    } catch(err) {
      setError(err.response?.data?.error || 'Failed to update.');
    } finally { setBusy(false); }
  }

  async function handleDelete() {
    if (!window.confirm('Delete these office hours?')) return;
    setBusy(true);
    try {
      await api.deleteInstructorOfficeHour(instructorId, officeHour.id);
      showToast('Office hours deleted.', 'info');
      onSaved();
      onClose();
    } catch {
      setError('Failed to delete.');
      setBusy(false);
    }
  }

  return (
    <div className="sm-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sm-card" style={{ maxWidth: 400 }}>
        <div className="sm-header">
          <h2 className="sm-title">
            {isArchived ? 'Office Hours (read-only)' : 'Edit Office Hours'}
          </h2>
          <button className="sm-close" onClick={onClose}>×</button>
        </div>

        <form className="sm-form" onSubmit={handleSave}>
          <div className="sm-field">
            <label>Day</label>
            <select value={form.day}
              disabled={isArchived}
              onChange={e => setForm(f => ({...f, day: e.target.value}))}>
              {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          <div className="sm-row">
            <div className="sm-field">
              <label>Start time</label>
              <input type="time" min={OH_MIN} max={OH_MAX} value={form.startTime}
                disabled={isArchived}
                onChange={e => {
                  // NEW-FU-511 (Batch 2): auto-move the end to start+1h (capped at
                  // 16:00) when the new start lands at/after the current end, so
                  // the block stays valid instead of flagging an ordering error.
                  const start = clampOH(e.target.value);
                  setForm(f => ({
                    ...f,
                    startTime: start,
                    endTime: f.endTime && start >= f.endTime ? plusOneHourClamped(start) : f.endTime,
                  }));
                }} required />
            </div>
            <div className="sm-field">
              <label>End time</label>
              <input type="time" min={OH_MIN} max={OH_MAX} value={form.endTime}
                disabled={isArchived}
                onChange={e => setForm(f => ({...f, endTime: clampOH(e.target.value)}))} required />
            </div>
          </div>

          {/* NEW-FU-466 (Phase 112): live window/order flag (takes precedence),
              else the plain-language rule so the secretary knows it up front. */}
          {(validationMsg || error)
            ? <div className="sm-error">{validationMsg || error}</div>
            : <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                Office hours can be set between 8:00 AM and 4:00 PM.
              </div>}

          <div className="sm-actions">
            <button type="button" className="sm-btn-delete"
              onClick={handleDelete}
              disabled={busy || isArchived}
              title={isArchived ? lockedTitle : undefined}>
              Delete
            </button>
            <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="sm-btn-save"
              disabled={busy || isArchived || !!validationMsg}
              title={isArchived ? lockedTitle : (validationMsg || undefined)}>
              {busy ? '…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
