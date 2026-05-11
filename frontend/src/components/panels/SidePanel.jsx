import React, { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { useApp, VIEWS, LEVEL_COLORS, DAYS, DAY_DURATION } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
import './SidePanel.css';

const LEVEL_ORDER = ['Freshman','Sophomore','Junior','Senior','Graduate'];

export default function SidePanel({ showToast, onAddSection, onEditSection }) {
  const {
    view, filterId, schedule,
    courses, instructors, venues,
    sections, officeHours, conflicts,
    switchView, loadView,
    addSection, removeSection,
    addInstructor, removeInstructor,
    addVenue, removeVenue,
    addCourse, removeCourse,
  } = useApp();

  const [openForm, setOpenForm] = useState(null); // 'section'|'instructor'|'venue'|'course'
  const [expandedConflict, setExpandedConflict] = useState(null); // index of expanded conflict
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  // ── Section form state ────────────────────────────────────────────────────
  const [secForm, setSecForm] = useState({
    courseId:'', instructorId:'', venueId:'',
    sectionNumber:'', day:'Sunday', startTime:'08:00', duration:'50',
  });

  // ── Instructor form ────────────────────────────────────────────────────────
  const [instrForm, setInstrForm] = useState({ name:'', email:'' });
  const [ohForm,    setOhForm]    = useState({ day:'Sunday', startTime:'10:00', endTime:'11:00' });
  const [ohList,    setOhList]    = useState([]);
  const [ohLoading, setOhLoading] = useState(false);

  // ── Venue form ────────────────────────────────────────────────────────────
  const [venueForm, setVenueForm] = useState({ name:'', type:'LectureHall', capacity:'60' });

  // ── Course form ────────────────────────────────────────────────────────────
  const [courseForm, setCourseForm] = useState({
    courseCode:'', name:'', credits:'3',
    academicLevel:'Junior', category:'UG', numSections:'1',
  });

  // Load office hours when an instructor is selected
  React.useEffect(() => {
    if (view === VIEWS.TEACHER && filterId) {
      setOhLoading(true);
      api.getInstructorOfficeHours(filterId)
        .then(data => setOhList(Array.isArray(data) ? data : []))
        .catch(() => setOhList([]))
        .finally(() => setOhLoading(false));
    } else {
      setOhList([]);
    }
  }, [filterId, view]);

  async function handleAddOH(e) {
    e.preventDefault();
    if (!filterId) return;
    setBusy(true); setFormError('');
    try {
      const oh = await api.addInstructorOfficeHour(filterId, ohForm);
      setOhList(prev => [...prev, oh]);
      setOhForm({ day:'Sunday', startTime:'10:00', endTime:'11:00' });
      setOpenForm(null);
      // Reload view to show new office hour block on grid
      if (schedule) loadView(schedule.id, view, filterId);
    } catch(err) {
      setFormError(err.response?.data?.error || 'Failed to add office hour.');
    } finally { setBusy(false); }
  }

  async function handleDeleteOH(ohId) {
    if (!filterId) return;
    try {
      await api.deleteInstructorOfficeHour(filterId, ohId);
      setOhList(prev => prev.filter(o => o.id !== ohId));
      if (schedule) loadView(schedule.id, view, filterId);
    } catch {}
  }

  function selectFilter(id) {
    if (!schedule) return;
    const newId = filterId === id ? null : id;
    switchView(view, newId);
    loadView(schedule.id, view, newId);
  }

  // compute end time from start + duration
  function computeEndTime(startTime, duration) {
    const [h, m] = startTime.split(':').map(Number);
    const total = h * 60 + m + parseInt(duration || 0);
    return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;
  }

  async function handleAddSection(e) {
    e.preventDefault();
    if (!schedule) return;
    setBusy(true); setFormError('');
    try {
      const endTime = computeEndTime(secForm.startTime, secForm.duration);
      await addSection(schedule.id, {
        courseId:      secForm.courseId,
        instructorId:  secForm.instructorId || undefined,
        venueId:       secForm.venueId      || undefined,
        sectionNumber: secForm.sectionNumber,
        day:           secForm.day,
        startTime:     secForm.startTime,
        endTime,
      });
      setOpenForm(null);
      setSecForm({ courseId:'', instructorId:'', venueId:'', sectionNumber:'', day:'Sunday', startTime:'08:00', duration:'50' });
    } catch(err) {
      setFormError(err.response?.data?.error || 'Failed to add section.');
    } finally { setBusy(false); }
  }

  async function handleAddInstructor(e) {
    e.preventDefault();
    setBusy(true); setFormError('');
    try {
      await addInstructor(instrForm);
      setOpenForm(null);
      setInstrForm({ name:'', email:'' });
    } catch(err) {
      setFormError(err.response?.data?.error || 'Failed to add instructor.');
    } finally { setBusy(false); }
  }

  async function handleAddVenue(e) {
    e.preventDefault();
    setBusy(true); setFormError('');
    try {
      await addVenue(venueForm);
      setOpenForm(null);
      setVenueForm({ name:'', type:'LectureHall', capacity:'60' });
    } catch(err) {
      setFormError(err.response?.data?.error || 'Failed to add venue.');
    } finally { setBusy(false); }
  }

  async function handleAddCourse(e) {
    e.preventDefault();
    setBusy(true); setFormError('');
    try {
      await addCourse(courseForm);
      setOpenForm(null);
      setCourseForm({ courseCode:'', name:'', credits:'3', academicLevel:'Junior', category:'UG', numSections:'1' });
    } catch(err) {
      setFormError(err.response?.data?.error || 'Failed to add course.');
    } finally { setBusy(false); }
  }

  const hardCount = conflicts.filter(c => c.severity === 'Hard').length;
  const softCount = conflicts.filter(c => c.severity === 'Soft' && !c.confirmed).length;

  return (
    <aside className="sp-root">

      {/* ── Conflict summary ─────────────────────────────────────────────── */}
      <div className="sp-section">
        <div className="sp-heading">Conflicts</div>
        <div className="sp-badges">
          <span className={`sp-badge hard ${hardCount > 0 ? 'active' : ''}`}>
            ● {hardCount} Hard
          </span>
          <span className={`sp-badge soft ${softCount > 0 ? 'active' : ''}`}>
            ● {softCount} Soft
          </span>
        </div>
        {conflicts.length > 0 && (
          <ul className="sp-conflict-list">
            {conflicts.map((conflict, i) => {
              const isExpanded = expandedConflict === i;
              const preview = conflict.description.length > 80
                ? conflict.description.substring(0, 80) + '…'
                : conflict.description;
              return (
                <li key={i}
                  className={`sp-conflict-item ${conflict.severity.toLowerCase()} clickable`}
                  onClick={() => setExpandedConflict(isExpanded ? null : i)}
                  title="Click to expand"
                >
                  <div className="sp-conflict-header">
                    <span className="sp-conflict-rule">{conflict.ruleId}</span>
                    <span className="sp-conflict-severity">{conflict.severity}</span>
                    <span className="sp-conflict-toggle">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                  <span className="sp-conflict-desc">
                    {isExpanded ? conflict.description : preview}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {conflicts.length === 0 && schedule && (
          <p className="sp-no-conflict">✓ No conflicts</p>
        )}
      </div>

      {/* ── Sections (Course View) ───────────────────────────────────────── */}
      {view === VIEWS.COURSE && (
        <div className="sp-section">
          <div className="sp-heading-row">
            <span className="sp-heading">Sections</span>
            <button className="sp-add-btn" onClick={() => onAddSection && onAddSection()} title="Add section">+</button>
          </div>

          {/* Section list — grouped by course, ordered by academic level */}
          {sections.length === 0
            ? <ul className="sp-list"><li className="sp-empty">No sections yet</li></ul>
            : LEVEL_ORDER.map(level => {
                const grps = groupSections(sections).filter(g => (g.academicLevel??'Freshman') === level);
                if (!grps.length) return null;
                // Further group by courseCode
                const byCourse = {};
                for (const grp of grps) {
                  if (!byCourse[grp.courseCode]) byCourse[grp.courseCode] = [];
                  byCourse[grp.courseCode].push(grp);
                }
                const colors = LEVEL_COLORS[level] ?? LEVEL_COLORS.Freshman;
                return (
                  <div key={level} className="sp-sec-level-group">
                    <div className="sp-sec-level-header" style={{borderColor:colors.border,color:colors.border}}>
                      {level}
                    </div>
                    {Object.entries(byCourse).map(([courseCode, courseGrps]) => (
                      <div key={courseCode} className="sp-sec-course-group">
                        <div className="sp-sec-course-label"
                          style={{background:colors.bg, borderLeft:`3px solid ${colors.border}`}}>
                          {courseCode}
                        </div>
                        <ul className="sp-list" style={{marginTop:2}}>
                          {courseGrps.sort((a,b) => a.sectionNumber.localeCompare(b.sectionNumber, undefined, {numeric:true})).map(grp => {
                            const days = grp.days.sort((a,b)=>{
                              const o=['Sunday','Monday','Tuesday','Wednesday','Thursday'];
                              return o.indexOf(a)-o.indexOf(b);
                            }).map(d=>d.substring(0,3)).join('/');
                            return (
                              <li key={grp.key}
                                className="sp-section-item clickable"
                                onClick={() => onEditSection && onEditSection(
                                  sections.find(s => s.id === grp.representativeId)
                                )}
                                title="Click to edit"
                              >
                                <span className="sp-sec-code" style={{minWidth:28,fontSize:'.72rem',
                                  color:colors.border,fontWeight:700}}>§{grp.sectionNumber}</span>
                                <span className="sp-sec-detail">{days} {grp.startTime}</span>
                                <button className="sp-del-btn" title="Remove"
                                  onPointerDown={e=>e.stopPropagation()}
                                  onClick={async e=>{
                                    e.stopPropagation();
                                    try { await removeSection(grp.representativeId); }
                                    catch { showToast&&showToast('Failed to delete.','error'); }
                                  }}>×</button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                );
              })
          }
        </div>
      )}

      {/* ── Instructors (Teacher View) ────────────────────────────────────── */}
      {view === VIEWS.TEACHER && (
        <div className="sp-section">
          <div className="sp-heading-row">
            <span className="sp-heading">Instructors</span>
            <button className="sp-add-btn" onClick={()=>setOpenForm(openForm==='instructor'?null:'instructor')}>+</button>
          </div>

          {openForm === 'instructor' && (
            <form className="sp-form" onSubmit={handleAddInstructor}>
              <input placeholder="Full name" value={instrForm.name}
                onChange={e=>setInstrForm(f=>({...f,name:e.target.value}))} required />
              <input placeholder="Email" type="email" value={instrForm.email}
                onChange={e=>setInstrForm(f=>({...f,email:e.target.value}))} required />
              {formError && <div className="sp-form-error">{formError}</div>}
              <div className="sp-form-actions">
                <button type="button" onClick={()=>setOpenForm(null)}>Cancel</button>
                <button type="submit" className="sp-submit" disabled={busy}>{busy?'…':'Add'}</button>
              </div>
            </form>
          )}

          <ul className="sp-list">
            {instructors.map(instr => (
              <li key={instr.id}>
                <button
                  className={`sp-filter-item ${filterId===instr.id?'selected':''}`}
                  onClick={()=>selectFilter(instr.id)}
                >
                  <span className="sp-avatar">{instr.name.split(' ').pop()[0]}</span>
                  <span className="sp-filter-name">{instr.name}</span>
                  {filterId===instr.id && <span className="sp-check">✓</span>}
                </button>
                <button className="sp-del-btn" title="Remove instructor"
                  onClick={()=>removeInstructor(instr.id)}>×</button>
              </li>
            ))}
          </ul>

          {/* Office Hours for selected instructor */}
          {filterId && (
            <div className="sp-oh-section">
              <div className="sp-heading-row" style={{marginTop:10}}>
                <span className="sp-heading">Office Hours</span>
                <button className="sp-add-btn"
                  onClick={()=>setOpenForm(openForm==='oh'?null:'oh')}>+</button>
              </div>

              {openForm === 'oh' && (
                <form className="sp-form" onSubmit={handleAddOH}>
                  <select value={ohForm.day} onChange={e=>setOhForm(f=>({...f,day:e.target.value}))}>
                    {DAYS.map(d=><option key={d} value={d}>{d}</option>)}
                  </select>
                  <div style={{display:'flex',gap:6}}>
                    <input type="time" value={ohForm.startTime}
                      onChange={e=>setOhForm(f=>({...f,startTime:e.target.value}))} required />
                    <input type="time" value={ohForm.endTime}
                      onChange={e=>setOhForm(f=>({...f,endTime:e.target.value}))} required />
                  </div>
                  {formError && <div className="sp-form-error">{formError}</div>}
                  <div className="sp-form-actions">
                    <button type="button" onClick={()=>setOpenForm(null)}>Cancel</button>
                    <button type="submit" className="sp-submit" disabled={busy}>{busy?'…':'Add'}</button>
                  </div>
                </form>
              )}

              {ohLoading && <p className="sp-empty">Loading…</p>}
              {!ohLoading && ohList.length === 0 && (
                <p className="sp-empty">No office hours set</p>
              )}
              <ul className="sp-list">
                {ohList.map(oh => (
                  <li key={oh.id} className="sp-oh-item">
                    <span className="sp-oh-day">{oh.day}</span>
                    <span className="sp-oh-time">
                      {(oh.start_time??oh.startTime??'').substring(0,5)}–{(oh.end_time??oh.endTime??'').substring(0,5)}
                    </span>
                    <button className="sp-del-btn" onClick={()=>handleDeleteOH(oh.id)}>×</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── Venues (Venue View) ────────────────────────────────────────────── */}
      {view === VIEWS.VENUE && (
        <div className="sp-section">
          <div className="sp-heading-row">
            <span className="sp-heading">Venues</span>
            <button className="sp-add-btn" onClick={()=>setOpenForm(openForm==='venue'?null:'venue')}>+</button>
          </div>
          <p className="sp-hint">Lecture halls &amp; labs only</p>

          {openForm === 'venue' && (
            <form className="sp-form" onSubmit={handleAddVenue}>
              <input placeholder="Name (e.g. H-201)" value={venueForm.name}
                onChange={e=>setVenueForm(f=>({...f,name:e.target.value}))} required />
              <select value={venueForm.type} onChange={e=>setVenueForm(f=>({...f,type:e.target.value}))}>
                <option value="LectureHall">Lecture Hall</option>
                <option value="Laboratory">Laboratory</option>
              </select>
              <input type="number" placeholder="Capacity" value={venueForm.capacity}
                onChange={e=>setVenueForm(f=>({...f,capacity:e.target.value}))} min="1" required />
              {formError && <div className="sp-form-error">{formError}</div>}
              <div className="sp-form-actions">
                <button type="button" onClick={()=>setOpenForm(null)}>Cancel</button>
                <button type="submit" className="sp-submit" disabled={busy}>{busy?'…':'Add'}</button>
              </div>
            </form>
          )}

          <ul className="sp-list">
            {venues.map(v => (
              <li key={v.id} className="sp-venue-li">
                <button
                  className={`sp-filter-item ${filterId===v.id?'selected':''}`}
                  onClick={()=>selectFilter(v.id)}
                >
                  <span className={`sp-venue-tag ${v.type==='Laboratory'?'lab':'hall'}`}>
                    {v.type==='Laboratory'?'LAB':'HALL'}
                  </span>
                  <span className="sp-filter-name">{v.name}</span>
                  <span className="sp-venue-cap">cap.{v.capacity}</span>
                  {filterId===v.id && <span className="sp-check">✓</span>}
                </button>
                <button className="sp-del-btn" onClick={()=>removeVenue(v.id)}>×</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Courses (always shown at bottom) ─────────────────────────────── */}
      <div className="sp-section">
        <div className="sp-heading-row">
          <span className="sp-heading">Courses</span>
          <button className="sp-add-btn" onClick={()=>setOpenForm(openForm==='course'?null:'course')}>+</button>
        </div>

        {openForm === 'course' && (
          <form className="sp-form" onSubmit={handleAddCourse}>
            <input placeholder="Code (e.g. SWE301)" value={courseForm.courseCode}
              onChange={e=>setCourseForm(f=>({...f,courseCode:e.target.value}))} required />
            <input placeholder="Course name" value={courseForm.name}
              onChange={e=>setCourseForm(f=>({...f,name:e.target.value}))} required />

            {/* Category first — determines whether academic level is shown */}
            <select value={courseForm.category} onChange={e=>{
              const cat = e.target.value;
              setCourseForm(f=>({
                ...f,
                category: cat,
                // GR → always Graduate; UG → reset to Junior
                academicLevel: cat === 'GR' ? 'Graduate' : (f.academicLevel === 'Graduate' ? 'Junior' : f.academicLevel),
              }));
            }}>
              <option value="UG">Undergraduate (UG)</option>
              <option value="GR">Graduate (GR)</option>
            </select>

            {/* Academic level — only for UG courses */}
            {courseForm.category === 'UG' && (
              <select value={courseForm.academicLevel} onChange={e=>setCourseForm(f=>({...f,academicLevel:e.target.value}))}>
                {['Freshman','Sophomore','Junior','Senior'].map(l=><option key={l}>{l}</option>)}
              </select>
            )}
            {courseForm.category === 'GR' && (
              <div style={{fontSize:'.78rem',color:'var(--slate-500)',
                padding:'5px 8px',background:'var(--slate-100)',borderRadius:6}}>
                Academic level: <strong>Graduate</strong> (fixed for GR courses)
              </div>
            )}

            <input type="number" placeholder="Credits" value={courseForm.credits}
              onChange={e=>setCourseForm(f=>({...f,credits:e.target.value}))} min="1" max="6" required />
            {formError && <div className="sp-form-error">{formError}</div>}
            <div className="sp-form-actions">
              <button type="button" onClick={()=>setOpenForm(null)}>Cancel</button>
              <button type="submit" className="sp-submit" disabled={busy}>{busy?'…':'Add Course'}</button>
            </div>
          </form>
        )}

        <div className="sp-course-groups">
          {Object.entries(groupBy(courses, 'academic_level')).map(([level, cs]) => (
            <div key={level} className="sp-level-group">
              <div className="sp-level-header" style={{color: LEVEL_COLORS[level]?.border, borderColor: LEVEL_COLORS[level]?.border}}>
                <span className="sp-level-dot" style={{background:LEVEL_COLORS[level]?.bg, borderColor:LEVEL_COLORS[level]?.border}} />
                {level}
              </div>
              <div className="sp-level-courses">
                {cs.map(c => (
                  <DraggableCourse key={c.id} course={c} level={level} onRemove={removeCourse} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

    </aside>
  );
}

// ── DraggableCourse ──────────────────────────────────────────────────────────
function DraggableCourse({ course, level, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: course.id });
  const colors = LEVEL_COLORS[level] ?? LEVEL_COLORS.Freshman;
  const style = {
    transform: transform ? `translate3d(${transform.x}px,${transform.y}px,0)` : undefined,
    opacity: isDragging ? 0.4 : 1,
    cursor: 'grab',
  };
  return (
    <div
      ref={setNodeRef}
      className="sp-course-card"
      style={{ ...style, borderColor: colors.border, background: colors.bg }}
      {...listeners}
      {...attributes}
      title={`Drag ${course.course_code} onto the grid to add a section`}
    >
      <span className="sp-course-code" style={{ color: colors.text }}>{course.course_code}</span>
      <span className="sp-course-name" style={{ color: colors.text }}>{course.name}</span>
      <button
        className="sp-del-btn"
        onPointerDown={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation();
          if (window.confirm(`Delete ${course.course_code} and ALL its sections?`)) {
            onRemove(course.id);
          }
        }}
      >×</button>
    </div>
  );
}

// Group sections by courseId+sectionNumber for the sidebar display
function groupSections(sections) {
  const map = new Map();
  for (const sec of sections) {
    const key = `${sec.courseId??sec.course_id}|${sec.sectionNumber??sec.section_number}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        courseCode:       sec.courseCode      ?? sec.course_code      ?? '?',
        sectionNumber:    sec.sectionNumber   ?? sec.section_number   ?? '',
        academicLevel:    sec.academicLevel   ?? sec.academic_level   ?? 'Freshman',
        startTime:        (sec.startTime ?? sec.start_time ?? '').substring(0,5),
        days:             [],
        representativeId: sec.id,
      });
    }
    map.get(key).days.push(sec.day);
  }
  return Array.from(map.values());
}

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key]; if (!acc[k]) acc[k] = []; acc[k].push(item); return acc;
  }, {});
}
