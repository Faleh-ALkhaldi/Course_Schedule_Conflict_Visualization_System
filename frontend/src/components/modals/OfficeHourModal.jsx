import React, { useState, useEffect } from 'react';
import { DAYS, useApp } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
import './SectionModal.css'; // reuse same modal styles

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

  async function handleSave(e) {
    e.preventDefault();
    // H-9: client-side time-order guard so the user gets instant feedback
    if (form.endTime <= form.startTime) {
      setError('End time must be after start time.');
      return;
    }
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
              <input type="time" value={form.startTime}
                disabled={isArchived}
                onChange={e => setForm(f => ({...f, startTime: e.target.value}))} required />
            </div>
            <div className="sm-field">
              <label>End time</label>
              <input type="time" value={form.endTime}
                disabled={isArchived}
                onChange={e => setForm(f => ({...f, endTime: e.target.value}))} required />
            </div>
          </div>

          {error && <div className="sm-error">{error}</div>}

          <div className="sm-actions">
            <button type="button" className="sm-btn-delete"
              onClick={handleDelete}
              disabled={busy || isArchived}
              title={isArchived ? lockedTitle : undefined}>
              Delete
            </button>
            <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="sm-btn-save"
              disabled={busy || isArchived}
              title={isArchived ? lockedTitle : undefined}>
              {busy ? '…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
