import React, { useState, useEffect } from 'react';
import { useApp, DAYS, LEVEL_COLORS } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
import './ManagePanel.css';

const TABS = ['Sections', 'Courses', 'Instructors', 'Venues'];
const LEVELS = ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Graduate'];
const DAYS_LIST = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
const SLOTS = [];
for (let m = 7 * 60; m < 22 * 60; m += 30) {
  const h = String(Math.floor(m / 60)).padStart(2, '0');
  const min = String(m % 60).padStart(2, '0');
  SLOTS.push(`${h}:${min}`);
}

export default function ManagePanel({ onClose }) {
  const { schedule, sections, courses, instructors, venues,
          loadReference, loadView, view, filterId, dispatch } = useApp();
  const [tab, setTab] = useState('Sections');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [success, setSuccess] = useState(null);

  function flash(msg, isErr = false) {
    if (isErr) { setError(msg); setTimeout(() => setError(null), 4000); }
    else       { setSuccess(msg); setTimeout(() => setSuccess(null), 3000); }
  }

  async function reload() {
    await loadReference();
    if (schedule) await loadView(schedule.id, view, filterId);
  }

  return (
    <div className="mpanel-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="mpanel">
        <div className="mpanel-header">
          <div className="mpanel-tabs">
            {TABS.map(t => (
              <button key={t} className={`mpanel-tab ${tab === t ? 'active' : ''}`}
                onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>
          <button className="mpanel-close" onClick={onClose}>✕</button>
        </div>

        {error   && <div className="mpanel-error">{error}</div>}
        {success && <div className="mpanel-success">{success}</div>}

        <div className="mpanel-body">
          {tab === 'Sections'     && <SectionsTab     schedule={schedule} sections={sections} courses={courses} instructors={instructors} venues={venues} reload={reload} flash={flash} />}
          {tab === 'Courses'      && <CoursesTab      courses={courses}     reload={reload} flash={flash} />}
          {tab === 'Instructors'  && <InstructorsTab  instructors={instructors} reload={reload} flash={flash} />}
          {tab === 'Venues'       && <VenuesTab       venues={venues}      reload={reload} flash={flash} />}
        </div>
      </div>
    </div>
  );
}

// ── Sections Tab ──────────────────────────────────────────────────────────────
function SectionsTab({ schedule, sections, courses, instructors, venues, reload, flash }) {
  const empty = { courseId: '', instructorId: '', venueId: '', sectionNumber: 'A', day: 'Sunday', startTime: '08:00', endTime: '09:30' };
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);

  async function handleAdd(e) {
    e.preventDefault();
    if (!schedule) return flash('No schedule loaded.', true);
    setSaving(true);
    try {
      await api.createSection(schedule.id, form);
      await reload();
      setForm(empty);
      flash('Section added.');
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to add section.', true);
    } finally { setSaving(false); }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this section?')) return;
    try {
      await api.deleteSection(id);
      await reload();
      flash('Section deleted.');
    } catch { flash('Failed to delete section.', true); }
  }

  return (
    <div className="mtab">
      <form className="mform" onSubmit={handleAdd}>
        <h3 className="mform-title">Add Section</h3>
        <div className="mform-grid">
          <div className="mform-field">
            <label>Course</label>
            <select value={form.courseId} onChange={e => setForm({...form, courseId: e.target.value})} required>
              <option value="">Select course…</option>
              {courses.map(c => <option key={c.id} value={c.id}>{c.course_code} — {c.name}</option>)}
            </select>
          </div>
          <div className="mform-field">
            <label>Instructor</label>
            <select value={form.instructorId} onChange={e => setForm({...form, instructorId: e.target.value})}>
              <option value="">Select instructor…</option>
              {instructors.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <div className="mform-field">
            <label>Venue (optional)</label>
            <select value={form.venueId} onChange={e => setForm({...form, venueId: e.target.value})}>
              <option value="">No venue</option>
              {venues.map(v => <option key={v.id} value={v.id}>{v.name} ({v.type})</option>)}
            </select>
          </div>
          <div className="mform-field">
            <label>Section #</label>
            <input value={form.sectionNumber} onChange={e => setForm({...form, sectionNumber: e.target.value})} placeholder="A" required />
          </div>
          <div className="mform-field">
            <label>Day</label>
            <select value={form.day} onChange={e => setForm({...form, day: e.target.value})}>
              {DAYS_LIST.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div className="mform-field">
            <label>Start Time</label>
            <select value={form.startTime} onChange={e => setForm({...form, startTime: e.target.value})}>
              {SLOTS.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="mform-field">
            <label>End Time</label>
            <select value={form.endTime} onChange={e => setForm({...form, endTime: e.target.value})}>
              {SLOTS.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <button type="submit" className="mform-btn" disabled={saving}>
          {saving ? 'Adding…' : '+ Add Section'}
        </button>
      </form>

      <div className="mlist">
        <h3 className="mlist-title">All Sections ({sections.length})</h3>
        {sections.length === 0 && <p className="mlist-empty">No sections yet.</p>}
        <table className="mtable">
          <thead><tr><th>Course</th><th>Section</th><th>Day</th><th>Time</th><th>Instructor</th><th>Venue</th><th></th></tr></thead>
          <tbody>
            {sections.map(s => (
              <tr key={s.id}>
                <td><span className="level-pill" style={{ background: LEVEL_COLORS[s.academicLevel ?? s.academic_level]?.bg, color: LEVEL_COLORS[s.academicLevel ?? s.academic_level]?.text }}>{s.courseCode ?? s.course_code}</span></td>
                <td>{s.sectionNumber ?? s.section_number}</td>
                <td>{s.day}</td>
                <td className="mono">{(s.startTime ?? s.start_time ?? '').substring(0,5)}–{(s.endTime ?? s.end_time ?? '').substring(0,5)}</td>
                <td>{s.instructorName ?? s.instructor_name ?? '—'}</td>
                <td>{s.venueName ?? s.venue_name ?? '—'}</td>
                <td><button className="mdelete-btn" onClick={() => handleDelete(s.id)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Courses Tab ───────────────────────────────────────────────────────────────
function CoursesTab({ courses, reload, flash }) {
  const empty = { courseCode: '', name: '', credits: 3, academicLevel: 'Freshman', category: 'UG', numSections: 1 };
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving]   = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await api.updateCourse(editing, form);
        flash('Course updated.');
        setEditing(null);
      } else {
        await api.createCourse(form);
        flash('Course added.');
      }
      await reload();
      setForm(empty);
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to save course.', true);
    } finally { setSaving(false); }
  }

  function startEdit(c) {
    setEditing(c.id);
    setForm({ courseCode: c.course_code, name: c.name, credits: c.credits,
              academicLevel: c.academic_level, category: c.category, numSections: c.num_sections });
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this course? This will also remove its sections.')) return;
    try { await api.deleteCourse(id); await reload(); flash('Course deleted.'); }
    catch { flash('Failed to delete course.', true); }
  }

  return (
    <div className="mtab">
      <form className="mform" onSubmit={handleSubmit}>
        <h3 className="mform-title">{editing ? 'Edit Course' : 'Add Course'}</h3>
        <div className="mform-grid">
          <div className="mform-field">
            <label>Course Code</label>
            <input value={form.courseCode} onChange={e => setForm({...form, courseCode: e.target.value})} placeholder="SWE301" required />
          </div>
          <div className="mform-field">
            <label>Name</label>
            <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="Software Architecture" required />
          </div>
          <div className="mform-field">
            <label>Credits</label>
            <input type="number" min="1" max="6" value={form.credits} onChange={e => setForm({...form, credits: e.target.value})} required />
          </div>
          <div className="mform-field">
            <label>Academic Level</label>
            <select value={form.academicLevel} onChange={e => setForm({...form, academicLevel: e.target.value})}>
              {LEVELS.map(l => <option key={l}>{l}</option>)}
            </select>
          </div>
          <div className="mform-field">
            <label>Category</label>
            <select value={form.category} onChange={e => setForm({...form, category: e.target.value})}>
              <option value="UG">UG (Undergraduate)</option>
              <option value="GR">GR (Graduate)</option>
            </select>
          </div>
          <div className="mform-field">
            <label>Sections</label>
            <input type="number" min="1" value={form.numSections} onChange={e => setForm({...form, numSections: e.target.value})} />
          </div>
        </div>
        <div className="mform-actions">
          <button type="submit" className="mform-btn" disabled={saving}>{saving ? 'Saving…' : editing ? 'Update' : '+ Add'}</button>
          {editing && <button type="button" className="mform-btn secondary" onClick={() => { setEditing(null); setForm(empty); }}>Cancel</button>}
        </div>
      </form>

      <div className="mlist">
        <h3 className="mlist-title">All Courses ({courses.length})</h3>
        <table className="mtable">
          <thead><tr><th>Code</th><th>Name</th><th>Level</th><th>Cat.</th><th>Credits</th><th>Sections</th><th></th></tr></thead>
          <tbody>
            {courses.map(c => (
              <tr key={c.id}>
                <td className="mono">{c.course_code}</td>
                <td>{c.name}</td>
                <td><span className="level-pill" style={{ background: LEVEL_COLORS[c.academic_level]?.bg, color: LEVEL_COLORS[c.academic_level]?.text }}>{c.academic_level}</span></td>
                <td>{c.category}</td>
                <td>{c.credits}</td>
                <td>{c.num_sections}</td>
                <td className="mrow-actions">
                  <button className="medit-btn" onClick={() => startEdit(c)}>✎</button>
                  <button className="mdelete-btn" onClick={() => handleDelete(c.id)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Instructors Tab ───────────────────────────────────────────────────────────
function InstructorsTab({ instructors, reload, flash }) {
  const empty = { name: '', email: '' };
  const [form, setForm]       = useState(empty);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving]   = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [officeHours, setOfficeHours] = useState([]);
  const [ohForm, setOhForm]   = useState({ day: 'Sunday', startTime: '11:00', endTime: '12:00' });

  async function handleSubmit(e) {
    e.preventDefault(); setSaving(true);
    try {
      if (editing) { await api.updateInstructor(editing, form); flash('Instructor updated.'); setEditing(null); }
      else         { await api.createInstructor(form);          flash('Instructor added.'); }
      await reload(); setForm(empty);
    } catch (err) { flash(err.response?.data?.error || 'Failed to save.', true); }
    finally { setSaving(false); }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this instructor?')) return;
    try { await api.deleteInstructor(id); await reload(); flash('Instructor deleted.'); }
    catch { flash('Failed to delete.', true); }
  }

  async function expandOH(instr) {
    if (expandedId === instr.id) { setExpandedId(null); return; }
    setExpandedId(instr.id);
    const oh = await api.getOfficeHours(instr.id);
    setOfficeHours(oh);
  }

  async function addOH(instrId) {
    try {
      await api.addOfficeHour(instrId, ohForm);
      const oh = await api.getOfficeHours(instrId);
      setOfficeHours(oh);
      flash('Office hour added.');
    } catch { flash('Failed to add office hour.', true); }
  }

  async function removeOH(instrId, ohId) {
    await api.deleteOfficeHour(instrId, ohId);
    const oh = await api.getOfficeHours(instrId);
    setOfficeHours(oh);
    flash('Office hour removed.');
  }

  return (
    <div className="mtab">
      <form className="mform" onSubmit={handleSubmit}>
        <h3 className="mform-title">{editing ? 'Edit Instructor' : 'Add Instructor'}</h3>
        <div className="mform-grid">
          <div className="mform-field">
            <label>Name</label>
            <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="Dr. Smith" required />
          </div>
          <div className="mform-field">
            <label>Email</label>
            <input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} placeholder="smith@dept.edu" required />
          </div>
        </div>
        <div className="mform-actions">
          <button type="submit" className="mform-btn" disabled={saving}>{saving ? 'Saving…' : editing ? 'Update' : '+ Add'}</button>
          {editing && <button type="button" className="mform-btn secondary" onClick={() => { setEditing(null); setForm(empty); }}>Cancel</button>}
        </div>
      </form>

      <div className="mlist">
        <h3 className="mlist-title">All Instructors ({instructors.length})</h3>
        {instructors.map(instr => (
          <div key={instr.id} className="minstr-card">
            <div className="minstr-row">
              <div className="minstr-avatar">{instr.name.split(' ').pop()[0]}</div>
              <div className="minstr-info">
                <span className="minstr-name">{instr.name}</span>
                <span className="minstr-email">{instr.email}</span>
              </div>
              <div className="mrow-actions">
                <button className="moh-btn" onClick={() => expandOH(instr)} title="Office hours">🕐</button>
                <button className="medit-btn" onClick={() => { setEditing(instr.id); setForm({ name: instr.name, email: instr.email }); }}>✎</button>
                <button className="mdelete-btn" onClick={() => handleDelete(instr.id)}>✕</button>
              </div>
            </div>

            {expandedId === instr.id && (
              <div className="moh-panel">
                <div className="moh-form">
                  <select value={ohForm.day} onChange={e => setOhForm({...ohForm, day: e.target.value})}>
                    {DAYS_LIST.map(d => <option key={d}>{d}</option>)}
                  </select>
                  <select value={ohForm.startTime} onChange={e => setOhForm({...ohForm, startTime: e.target.value})}>
                    {SLOTS.map(s => <option key={s}>{s}</option>)}
                  </select>
                  <span>to</span>
                  <select value={ohForm.endTime} onChange={e => setOhForm({...ohForm, endTime: e.target.value})}>
                    {SLOTS.map(s => <option key={s}>{s}</option>)}
                  </select>
                  <button className="mform-btn small" onClick={() => addOH(instr.id)}>+ Add</button>
                </div>
                {officeHours.length === 0
                  ? <p className="mlist-empty">No office hours.</p>
                  : officeHours.map(oh => (
                    <div key={oh.id} className="moh-item">
                      <span className="mono">{oh.day} {oh.start_time?.substring(0,5)}–{oh.end_time?.substring(0,5)}</span>
                      <button className="mdelete-btn small" onClick={() => removeOH(instr.id, oh.id)}>✕</button>
                    </div>
                  ))
                }
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Venues Tab ────────────────────────────────────────────────────────────────
function VenuesTab({ venues, reload, flash }) {
  const empty = { name: '', type: 'LectureHall', capacity: 80 };
  const [form, setForm]       = useState(empty);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving]   = useState(false);

  async function handleSubmit(e) {
    e.preventDefault(); setSaving(true);
    try {
      if (editing) { await api.updateVenue(editing, form); flash('Venue updated.'); setEditing(null); }
      else         { await api.createVenue(form);          flash('Venue added.'); }
      await reload(); setForm(empty);
    } catch (err) { flash(err.response?.data?.error || 'Failed to save.', true); }
    finally { setSaving(false); }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this venue?')) return;
    try { await api.deleteVenue(id); await reload(); flash('Venue deleted.'); }
    catch { flash('Failed to delete venue.', true); }
  }

  return (
    <div className="mtab">
      <form className="mform" onSubmit={handleSubmit}>
        <h3 className="mform-title">{editing ? 'Edit Venue' : 'Add Venue'}</h3>
        <div className="mform-grid">
          <div className="mform-field">
            <label>Name</label>
            <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="H-401" required />
          </div>
          <div className="mform-field">
            <label>Type</label>
            <select value={form.type} onChange={e => setForm({...form, type: e.target.value})}>
              <option value="LectureHall">Lecture Hall</option>
              <option value="Laboratory">Laboratory</option>
            </select>
          </div>
          <div className="mform-field">
            <label>Capacity</label>
            <input type="number" min="1" value={form.capacity} onChange={e => setForm({...form, capacity: e.target.value})} required />
          </div>
        </div>
        <div className="mform-actions">
          <button type="submit" className="mform-btn" disabled={saving}>{saving ? 'Saving…' : editing ? 'Update' : '+ Add'}</button>
          {editing && <button type="button" className="mform-btn secondary" onClick={() => { setEditing(null); setForm(empty); }}>Cancel</button>}
        </div>
      </form>

      <div className="mlist">
        <h3 className="mlist-title">All Venues ({venues.length})</h3>
        <table className="mtable">
          <thead><tr><th>Name</th><th>Type</th><th>Capacity</th><th></th></tr></thead>
          <tbody>
            {venues.map(v => (
              <tr key={v.id}>
                <td className="mono">{v.name}</td>
                <td><span className={`venue-tag ${v.type === 'Laboratory' ? 'lab' : 'hall'}`}>{v.type === 'Laboratory' ? 'LAB' : 'HALL'}</span></td>
                <td>{v.capacity}</td>
                <td className="mrow-actions">
                  <button className="medit-btn" onClick={() => { setEditing(v.id); setForm({ name: v.name, type: v.type, capacity: v.capacity }); }}>✎</button>
                  <button className="mdelete-btn" onClick={() => handleDelete(v.id)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
