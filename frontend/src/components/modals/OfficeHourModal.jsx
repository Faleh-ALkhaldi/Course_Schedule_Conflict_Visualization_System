import React, { useState } from 'react';
import { DAYS } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
import './SectionModal.css'; // reuse same modal styles

export default function OfficeHourModal({ officeHour, instructorId, onClose, onSaved, showToast }) {
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
    setBusy(true); setError('');
    try {
      // Delete old + create new (API has no PUT for office hours)
      await api.deleteInstructorOfficeHour(instructorId, officeHour.id);
      await api.addInstructorOfficeHour(instructorId, form);
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
          <h2 className="sm-title">Edit Office Hours</h2>
          <button className="sm-close" onClick={onClose}>×</button>
        </div>

        <form className="sm-form" onSubmit={handleSave}>
          <div className="sm-field">
            <label>Day</label>
            <select value={form.day} onChange={e => setForm(f => ({...f, day: e.target.value}))}>
              {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          <div className="sm-row">
            <div className="sm-field">
              <label>Start time</label>
              <input type="time" value={form.startTime}
                onChange={e => setForm(f => ({...f, startTime: e.target.value}))} required />
            </div>
            <div className="sm-field">
              <label>End time</label>
              <input type="time" value={form.endTime}
                onChange={e => setForm(f => ({...f, endTime: e.target.value}))} required />
            </div>
          </div>

          {error && <div className="sm-error">{error}</div>}

          <div className="sm-actions">
            <button type="button" className="sm-btn-delete" onClick={handleDelete} disabled={busy}>
              Delete
            </button>
            <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="sm-btn-save" disabled={busy}>
              {busy ? '…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
