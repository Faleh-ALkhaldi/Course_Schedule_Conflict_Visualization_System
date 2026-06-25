import React, { useState, useEffect } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { DAYS, useApp } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
import { findOfficeHourClassClashes, suggestFreeOfficeHour, clashLabel } from '../../utils/officeHourConflict.js';
import OfficeHourModal from './OfficeHourModal.jsx';
import Ico from '../shared/Icons.jsx';
import './SectionModal.css'; // reuse the modal shell styles

// NEW-FU-637 (issue #5): a DEDICATED office-hours subscreen for one instructor — list, add,
// edit, delete — opened by its OWN control (not by clicking the instructor's name). Replaces
// the old bottom-of-sidebar inline editor that forced the user to scroll to it. Enforces the
// 08:00–16:00 window, the OH↔OH overlap guard, and the #2b OH↔class up-front conflict
// confirmation (officeHourConflict.js); fully read-only when the term is finalized/archived.
const OH_MIN = '08:00', OH_MAX = '16:00';
const clampOH = v => !v ? v : (v < OH_MIN ? OH_MIN : v > OH_MAX ? OH_MAX : v);

export default function OfficeHoursManagerModal({ instructor, onClose, showToast }) {
  useFocusTrap();
  // NEW-FU-639 (issue #2/#6): pull loadView so add/delete/edit refresh the GRID, not only this
  // modal's local list. Without it, an OH added here never appeared on the schedule grid (the
  // modal did a modal-local refresh only) — which also made undoing the add look like a no-op.
  const { schedule, view, filterId, loadView, confirm, sections, recordRefCommand } = useApp();
  const refreshGrid = () => { if (schedule) loadView(schedule.id, view, filterId); };
  // Finalized OR archived term → read-only (matches OfficeHourModal / the FU-562 contract).
  const isArchived = Boolean(schedule?.archived_at) || schedule?.status === 'Finalized';
  const lockedNote = schedule?.status === 'Finalized'
    ? 'Term is finalized — office hours are read-only. Unlock the term to edit.'
    : (schedule?.archived_at ? 'Term is archived — unarchive to edit office hours.' : '');

  const [ohList, setOhList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ day: 'Sunday', startTime: '10:00', endTime: '11:00' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // an OH row being edited via OfficeHourModal

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !editing) onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  async function refresh() {
    setLoading(true);
    try {
      const list = await api.getInstructorOfficeHours(instructor.id);
      setOhList(Array.isArray(list) ? list : (list?.officeHours || []));
    } catch { setOhList([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [instructor.id]);

  // The instructor's class meetings (for #2b) — `sections` is this instructor's in TEACHER view.
  const instrSections = sections || [];

  const windowBad = (form.startTime < OH_MIN || form.startTime > OH_MAX) || (form.endTime < OH_MIN || form.endTime > OH_MAX);
  const orderBad  = form.endTime <= form.startTime;
  // OH↔OH overlap (mirrors backend findOverlappingOH).
  const ohOverlap = !windowBad && !orderBad && ohList.some(o =>
    o.day === form.day &&
    String(o.start_time ?? o.startTime ?? '').slice(0, 5) < form.endTime &&
    String(o.end_time ?? o.endTime ?? '').slice(0, 5) > form.startTime);
  const blockMsg = windowBad ? 'Office hours can only be between 8:00 AM and 4:00 PM.'
    : orderBad ? 'End time must be after the start time.'
    : ohOverlap ? 'This overlaps an existing office hour for this instructor on that day.' : '';

  async function handleAdd(e) {
    e.preventDefault();
    if (blockMsg) { setError(blockMsg); return; }
    // NEW-FU-634/637 (issue #2b in #5) + NEW-FU-639 (issue #7): up-front OH↔class conflict
    // confirmation as a 3-OPTION decision — Add anyway (accept the conflict) · Use the nearest
    // conflict-free slot (apply it) · Cancel — matching the OH-edit modal and the OH drag.
    let payload = { ...form };
    const clashes = findOfficeHourClassClashes(form, instrSections);
    if (clashes.length) {
      const sug = suggestFreeOfficeHour(form, instrSections, ohList);
      const choice = await confirm({
        title: 'This office hour overlaps a class',
        message: `It overlaps ${clashLabel(clashes[0])}${clashes.length > 1 ? ` (and ${clashes.length - 1} more)` : ''} and will create a conflict.`,
        options: [
          { label: 'Add anyway', value: 'proceed', tone: 'danger' },
          ...(sug ? [{ label: `Use ${sug.day} ${sug.startTime}–${sug.endTime}`, value: 'suggest', tone: 'primary' }] : []),
          { label: 'Cancel', value: 'cancel', tone: 'neutral' },
        ],
        dismissValue: 'cancel',
      });
      if (choice === 'cancel') return;
      if (choice === 'suggest' && sug) payload = { day: sug.day, startTime: sug.startTime, endTime: sug.endTime };
    }
    setBusy(true); setError('');
    try {
      const created = await api.addInstructorOfficeHour(instructor.id, payload);
      // NEW-FU-638 (issue #6): one undo step — undo deletes this OH, redo re-adds it.
      const snap = { ...payload };
      let curId = created?.id;
      recordRefCommand && recordRefCommand({
        label: 'add office hour',
        undo: async () => { if (curId) await api.deleteInstructorOfficeHour(instructor.id, curId); },
        redo: async () => { const re = await api.addInstructorOfficeHour(instructor.id, snap); curId = re?.id; },
      });
      setForm({ day: 'Sunday', startTime: '10:00', endTime: '11:00' });
      setAdding(false);
      await refresh();
      refreshGrid();   // NEW-FU-639 (issue #2/#6): show the new OH on the schedule grid immediately
      showToast && showToast('✓ Office hour added.', 'success');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add office hour.');
    } finally { setBusy(false); }
  }

  async function handleDelete(oh) {
    const label = `${oh.day} ${(oh.start_time ?? oh.startTime ?? '').slice(0, 5)}–${(oh.end_time ?? oh.endTime ?? '').slice(0, 5)}`;
    if (!await confirm({ title: `Delete the ${label} office hour?`, confirmLabel: 'Delete' })) return;
    try {
      // NEW-FU-638 (issue #6): capture before delete so undo can re-add the exact slot.
      const snap = {
        day: oh.day,
        startTime: String(oh.start_time ?? oh.startTime ?? '').slice(0, 5),
        endTime:   String(oh.end_time   ?? oh.endTime   ?? '').slice(0, 5),
      };
      await api.deleteInstructorOfficeHour(instructor.id, oh.id);
      let reId = null;
      recordRefCommand && recordRefCommand({
        label: 'delete office hour',
        undo: async () => { const re = await api.addInstructorOfficeHour(instructor.id, snap); reId = re?.id; },
        redo: async () => { if (reId) await api.deleteInstructorOfficeHour(instructor.id, reId); },
      });
      await refresh();
      refreshGrid();   // NEW-FU-639 (issue #2/#6): reflect the deletion on the schedule grid
      showToast && showToast('Office hour deleted.', 'info');
    } catch (err) {
      showToast && showToast(err.response?.data?.error || 'Failed to delete office hour.', 'error');
    }
  }

  return (
    <div className="sm-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sm-card" role="dialog" aria-modal="true" aria-label="Office hours manager" style={{ maxWidth: 460 }}>
        <div className="sm-header">
          <h2 className="sm-title">Office Hours — {instructor.name}{isArchived ? ' (read-only)' : ''}</h2>
          <button className="sm-close" onClick={onClose}>×</button>
        </div>

        <div className="sm-form">
          {isArchived && <div className="sm-info-box" role="status"><Ico name="info" /> <span>{lockedNote}</span></div>}

          {loading ? <p className="sm-hint">Loading…</p> : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {ohList.length === 0 && <li className="sm-hint">No office hours yet.</li>}
              {ohList.map(oh => (
                <li key={oh.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                  borderRadius: 6, background: 'var(--bg-elevated)' }}>
                  <span style={{ fontWeight: 600, minWidth: 80 }}>{oh.day}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', flex: 1 }}>
                    {(oh.start_time ?? oh.startTime ?? '').slice(0, 5)}–{(oh.end_time ?? oh.endTime ?? '').slice(0, 5)}
                  </span>
                  <button type="button" className="sm-inline-add" disabled={isArchived}
                    title={isArchived ? lockedNote : 'Edit'} onClick={() => setEditing(oh)}>Edit</button>
                  <button type="button" className="sm-btn-delete" disabled={isArchived}
                    title={isArchived ? lockedNote : 'Delete'} style={{ padding: '2px 8px' }}
                    onClick={() => handleDelete(oh)}>Delete</button>
                </li>
              ))}
            </ul>
          )}

          {!isArchived && !adding && (
            <button type="button" className="sm-inline-add" style={{ marginTop: 8, alignSelf: 'flex-start' }}
              onClick={() => { setError(''); setAdding(true); }}>
              <Ico name="plus" /> Add office hour
            </button>
          )}

          {!isArchived && adding && (
            <form onSubmit={handleAdd} style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="sm-field">
                <label>Day</label>
                <select value={form.day} onChange={e => setForm(f => ({ ...f, day: e.target.value }))}>
                  {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div className="sm-row">
                <div className="sm-field"><label>Start</label>
                  <input type="time" min={OH_MIN} max={OH_MAX} value={form.startTime}
                    onChange={e => setForm(f => ({ ...f, startTime: clampOH(e.target.value) }))} required /></div>
                <div className="sm-field"><label>End</label>
                  <input type="time" min={OH_MIN} max={OH_MAX} value={form.endTime}
                    onChange={e => setForm(f => ({ ...f, endTime: clampOH(e.target.value) }))} required /></div>
              </div>
              {(blockMsg || error)
                ? <div className="sm-error" role="alert">{blockMsg || error}</div>
                : <p className="sm-hint">Office hours can be set between 8:00 AM and 4:00 PM.</p>}
              <div className="sm-actions">
                <button type="button" className="sm-btn-cancel" onClick={() => { setAdding(false); setError(''); }}>Cancel</button>
                <button type="submit" className="sm-btn-save" disabled={busy || !!blockMsg}>{busy ? '…' : 'Add'}</button>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* Edit a single OH via the existing modal (it carries the same #2b confirmation). */}
      {editing && (
        <OfficeHourModal
          officeHour={editing}
          instructorId={instructor.id}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); refreshGrid(); /* NEW-FU-639: refresh grid too */ }}
          showToast={showToast}
        />
      )}
    </div>
  );
}
