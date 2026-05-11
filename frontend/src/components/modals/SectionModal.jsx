import React, { useState, useEffect } from 'react';
import { useApp, DAYS, DAY_DURATION, fromMinutes, toMinutes } from '../../context/AppContext.jsx';
import './SectionModal.css';

const DAY_GROUPS = {
  Sunday:'STT', Tuesday:'STT', Thursday:'STT',
  Monday:'MW',  Wednesday:'MW',
};
const GROUP_DAYS = {
  STT: ['Sunday','Tuesday','Thursday'],
  MW:  ['Monday','Wednesday'],
};
const GROUP_LABELS = {
  STT: 'Sun / Tue / Thu  (50 min)',
  MW:  'Mon / Wed  (75 min)',
  single: 'Single day',
};

export default function SectionModal({ mode, initial, onClose, showToast }) {
  const { courses, instructors, venues, schedule,
          addSection, moveSection, removeSection, loadView, view, filterId } = useApp();

  const existing = initial?.section;

  // ── Determine existing group ──────────────────────────────────────────────
  const existingGroup = existing ? (DAY_GROUPS[existing.day] ?? 'single') : null;

  const [tab, setTab] = useState(mode === 'edit' ? 'time' : 'info');
  // 'info' = instructor/venue/section# | 'time' = day/startTime/duration

  const [form, setForm] = useState({
    courseId:      existing?.courseId      ?? existing?.course_id      ?? initial?.courseId ?? '',
    instructorId:  existing?.instructorId  ?? existing?.instructor_id  ?? '',
    venueId:       existing?.venueId       ?? existing?.venue_id       ?? '',
    sectionNumber: existing?.sectionNumber ?? existing?.section_number ?? '',
    dayMode:       initial?.dayMode ?? (mode === 'add' ? 'STT' : (existingGroup ?? 'single')),
    day:           existing?.day ?? initial?.day ?? 'Sunday',
    startTime:     (existing?.startTime ?? existing?.start_time ?? initial?.startTime ?? '08:00').substring(0,5),
    duration: existing
      ? String(toMinutes(existing.endTime ?? existing.end_time) - toMinutes(existing.startTime ?? existing.start_time))
      : String(initial?.duration ?? 50),
  });

  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState('');

  // Auto-set duration from dayMode
  useEffect(() => {
    if (mode === 'add') {
      if (form.dayMode === 'STT') setForm(f => ({...f, duration:'50', day:'Sunday'}));
      else if (form.dayMode === 'MW') setForm(f => ({...f, duration:'75', day:'Monday'}));
    }
  }, [form.dayMode]);

  function computeEnd() {
    const [h,m] = form.startTime.split(':').map(Number);
    return fromMinutes(h*60+m+parseInt(form.duration||0));
  }

  // Days that will be created/affected
  function getAffectedDays() {
    if (form.dayMode === 'STT') return ['Sunday','Tuesday','Thursday'];
    if (form.dayMode === 'MW')  return ['Monday','Wednesday'];
    return [form.day];
  }

  async function handleSubmitInfo(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (mode === 'add') {
        const days = getAffectedDays();
        await addSection(schedule.id, {
          courseId:      form.courseId,
          instructorId:  form.instructorId  || undefined,
          venueId:       form.venueId       || undefined,
          sectionNumber: form.sectionNumber,
          days,
          day:           days[0],
          startTime:     form.startTime,
          endTime:       computeEnd(),
        });
        showToast(`✓ Section added (${days.length} day${days.length>1?'s':''}).`, 'success');
      } else {
        // Edit info only — propagates to all siblings
        await fetch(`/api/v1/sections/${existing.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('token')}`,
          },
          body: JSON.stringify({
            infoOnly:      true,
            instructorId:  form.instructorId  || null,  // empty string → null = clear
            venueId:       form.venueId       || null,
            sectionNumber: form.sectionNumber,
          }),
        });
        showToast('✓ Section info updated for all linked days.', 'success');
        if (schedule) loadView(schedule.id, view, filterId);
      }
      onClose();
    } catch(err) {
      setError(err.response?.data?.error || err.message || 'Failed.');
    } finally { setBusy(false); }
  }

  async function handleSubmitTime(e) {
    e.preventDefault();
    if (!existing) return;
    setBusy(true); setError('');
    try {
      await moveSection(existing.id, {
        instructorId: form.instructorId || null,
        venueId:      form.venueId      || existing.venueId      || existing.venue_id,
        day:          form.day,
        startTime:    form.startTime,
        endTime:      computeEnd(),
      });
      showToast('✓ Time updated for all linked days.', 'success');
      onClose();
    } catch(err) {
      setError('Failed to update time.');
    } finally { setBusy(false); }
  }

  async function handleDelete() {
    if (!existing) return;
    const label = `${existing.courseCode??existing.course_code} §${existing.sectionNumber??existing.section_number}`;
    if (!window.confirm(`Delete ${label} and all linked days in its group?`)) return;
    setBusy(true);
    try {
      await removeSection(existing.id);
      showToast('Section deleted.', 'info');
      onClose();
    } catch { setError('Failed to delete.'); setBusy(false); }
  }

  const selectedCourse = courses.find(c => c.id === form.courseId);

  return (
    <div className="sm-overlay" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="sm-card">
        <div className="sm-header">
          <div>
            <h2 className="sm-title">
              {mode==='add' ? '+ Add Section'
                : `${existing?.courseCode??existing?.course_code} §${existing?.sectionNumber??existing?.section_number}`}
            </h2>
            {mode==='edit' && existingGroup && (
              <div className="sm-group-badge">
                {existingGroup==='STT' ? '📅 Sun / Tue / Thu group'
                  : existingGroup==='MW' ? '📅 Mon / Wed group'
                  : '📅 Single day'}
                <span className="sm-group-note"> — changes apply to all days in group</span>
              </div>
            )}
          </div>
          <button className="sm-close" onClick={onClose}>×</button>
        </div>

        {mode==='edit' && (
          <div className="sm-tabs">
            <button className={tab==='time'?'active':''} onClick={()=>setTab('time')}>📍 Time &amp; Day</button>
            <button className={tab==='info'?'active':''} onClick={()=>setTab('info')}>✏️ Info</button>
          </div>
        )}

        {/* ── ADD MODE or INFO tab ── */}
        {(mode==='add' || tab==='info') && (
          <form className="sm-form" onSubmit={handleSubmitInfo}>
            {mode==='add' && (
              <>
                <div className="sm-field">
                  <label>Course</label>
                  <select value={form.courseId} onChange={e=>setForm(f=>({...f,courseId:e.target.value}))} required>
                    <option value="">— Select course —</option>
                    {['Freshman','Sophomore','Junior','Senior','Graduate'].map(level => {
                      const cs = courses.filter(c=>c.academic_level===level);
                      if (!cs.length) return null;
                      return (
                        <optgroup key={level} label={level}>
                          {cs.map(c=><option key={c.id} value={c.id}>{c.course_code} — {c.name}</option>)}
                        </optgroup>
                      );
                    })}
                  </select>
                </div>

                <div className="sm-field">
                  <label>Section #</label>
                  <input placeholder="e.g. A or 01" value={form.sectionNumber}
                    onChange={e=>setForm(f=>({...f,sectionNumber:e.target.value}))} required />
                </div>

                <div className="sm-field">
                  <label>Schedule type</label>
                  <div className="sm-daymode-group">
                    {['STT','MW','single'].map(mode2=>(
                      <button key={mode2} type="button"
                        className={`sm-daymode-btn ${form.dayMode===mode2?'active':''}`}
                        onClick={()=>setForm(f=>({...f,dayMode:mode2}))}>
                        {mode2==='STT'?'Sun/Tue/Thu':mode2==='MW'?'Mon/Wed':'Single day'}
                      </button>
                    ))}
                  </div>
                  {form.dayMode==='single' && (
                    <select value={form.day} onChange={e=>setForm(f=>({...f,day:e.target.value}))}
                      style={{marginTop:6}}>
                      {DAYS.map(d=><option key={d} value={d}>{d}</option>)}
                    </select>
                  )}
                </div>

                <div className="sm-row">
                  <div className="sm-field">
                    <label>Start time</label>
                    <input type="time" value={form.startTime}
                      onChange={e=>setForm(f=>({...f,startTime:e.target.value}))} required />
                  </div>
                  <div className="sm-field">
                    <label>Duration (min)</label>
                    <input type="number" value={form.duration} min="30" max="180"
                      onChange={e=>setForm(f=>({...f,duration:e.target.value}))} required />
                  </div>
                  <div className="sm-field">
                    <label>End time</label>
                    <div className="sm-readonly">{computeEnd()}</div>
                  </div>
                </div>
              </>
            )}

            <div className="sm-field">
              <label>Instructor <span className="sm-optional">(soft warning if empty)</span></label>
              <select value={form.instructorId} onChange={e=>setForm(f=>({...f,instructorId:e.target.value}))}>
                <option value="">— No instructor —</option>
                {instructors.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>

            <div className="sm-field">
              <label>Venue <span className="sm-optional">(optional)</span></label>
              <select value={form.venueId} onChange={e=>setForm(f=>({...f,venueId:e.target.value}))}>
                <option value="">— No venue —</option>
                {venues.map(v=><option key={v.id} value={v.id}>{v.name} ({v.type})</option>)}
              </select>
            </div>

            {mode==='edit' && (
              <div className="sm-field">
                <label>Section # <span className="sm-optional">(updates all days in group)</span></label>
                <input value={form.sectionNumber}
                  onChange={e=>setForm(f=>({...f,sectionNumber:e.target.value}))} />
              </div>
            )}

            {error && <div className="sm-error">{error}</div>}
            <div className="sm-actions">
              {mode==='edit' && (
                <button type="button" className="sm-btn-delete" onClick={handleDelete} disabled={busy}>Delete all</button>
              )}
              <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
              <button type="submit" className="sm-btn-save" disabled={busy}>
                {busy ? '…' : mode==='add' ? 'Add Section' : 'Save Info'}
              </button>
            </div>
          </form>
        )}

        {/* ── EDIT TIME tab ── */}
        {mode==='edit' && tab==='time' && (
          <form className="sm-form" onSubmit={handleSubmitTime}>
            <div className="sm-info-box">
              Moving the time will shift <strong>all days</strong> in this group to the same start/end time.
            </div>
            <div className="sm-row">
              <div className="sm-field">
                <label>Day</label>
                <select value={form.day} onChange={e=>setForm(f=>({...f,day:e.target.value}))}>
                  {existingGroup && existingGroup!=='single'
                    ? GROUP_DAYS[existingGroup].map(d=><option key={d} value={d}>{d}</option>)
                    : DAYS.map(d=><option key={d} value={d}>{d}</option>)
                  }
                </select>
              </div>
              <div className="sm-field">
                <label>Start time</label>
                <input type="time" value={form.startTime}
                  onChange={e=>setForm(f=>({...f,startTime:e.target.value}))} required />
              </div>
              <div className="sm-field">
                <label>Duration (min)</label>
                <input type="number" value={form.duration} min="30" max="180"
                  onChange={e=>setForm(f=>({...f,duration:e.target.value}))} required />
              </div>
            </div>
            <div className="sm-field sm-end-preview">
              End time: <strong>{computeEnd()}</strong>
            </div>
            {error && <div className="sm-error">{error}</div>}
            <div className="sm-actions">
              <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
              <button type="submit" className="sm-btn-save" disabled={busy}>
                {busy ? '…' : 'Move All Days'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
