import React, { useEffect, useState } from 'react';
import {
  DndContext, PointerSensor, useSensor, useSensors, DragOverlay, closestCenter,
} from '@dnd-kit/core';
import { useApp, VIEWS, DAY_DURATION, LEVEL_COLORS, fromMinutes } from '../context/AppContext.jsx';

const DAY_GROUPS = {
  Sunday:'STT', Tuesday:'STT', Thursday:'STT',
  Monday:'MW',  Wednesday:'MW',
};
const GROUP_DAYS = { STT:['Sunday','Tuesday','Thursday'], MW:['Monday','Wednesday'] };
const GROUP_LABELS = { STT:'Sun / Tue / Thu (3 days, 50 min)', MW:'Mon / Wed (2 days, 75 min)', single:'Single day' };
import * as api from '../api/index.js';
import TopBar            from '../components/shared/TopBar.jsx';
import SidePanel         from '../components/panels/SidePanel.jsx';
import ScheduleGrid      from '../components/grid/ScheduleGrid.jsx';
import SoftConflictModal from '../components/modals/SoftConflictModal.jsx';
import SectionModal      from '../components/modals/SectionModal.jsx';
import OfficeHourModal  from '../components/modals/OfficeHourModal.jsx';
import ExportModal      from '../components/modals/ExportModal.jsx';
import GroupChangeModal from '../components/modals/GroupChangeModal.jsx';
import SuggestModal     from '../components/modals/SuggestModal.jsx';
import './SchedulerPage.css';

const DEPT_ID  = 'SWE-DEPT';
const SEMESTER = 'Fall-2025';

export default function SchedulerPage() {
  const { schedule, view, filterId, softPending, saveBlocked,
          loadReference, loadView, saveSchedule, moveSection,
          sections, courses, dispatch } = useApp();

  const [showSoftModal, setShowSoftModal] = useState(false);
  const [toast,         setToast]         = useState(null);
  const [sectionModal,  setSectionModal]  = useState(null);
  const [ohModal,       setOhModal]       = useState(null);
  const [showExport,    setShowExport]    = useState(false);
  const [showSuggest,   setShowSuggest]   = useState(false);
  const [groupChangeModal, setGroupChangeModal] = useState(null); // { sec, newDay, newStartTime, duration }
  const [activeDrag,    setActiveDrag]    = useState(null); // { type:'section'|'course', id }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  useEffect(() => {
    async function boot() {
      try {
        await loadReference();
        const { listSchedules, createSchedule } = await import('../api/index.js');
        const list = await listSchedules(DEPT_ID);
        let sched  = list.find(s => s.semester === SEMESTER) ?? null;
        if (!sched) {
          try {
            sched = await createSchedule({ departmentId: DEPT_ID, semester: SEMESTER });
          } catch {
            // Schedule may already exist — reload list and pick it up
            const list2 = await listSchedules(DEPT_ID);
            sched = list2.find(s => s.semester === SEMESTER) ?? null;
          }
        }
        dispatch({ type: 'SET_SCHEDULE', schedule: sched });
        await loadView(sched.id, view, filterId);
      } catch (err) { console.error('Boot failed:', err); }
    }
    boot();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (schedule) loadView(schedule.id, view, filterId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, filterId, schedule?.id]);

  // Reload when sections are cleared (after delete operations)
  const { sections: currentSections } = useApp();
  const prevSectionsRef = React.useRef(currentSections);
  useEffect(() => {
    if (prevSectionsRef.current.length > 0 && currentSections.length === 0 && schedule) {
      loadView(schedule.id, view, filterId);
    }
    prevSectionsRef.current = currentSections;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSections.length]);

  // ── Shared DnD handlers (wraps both sidebar + grid) ────────────────────────
  function handleDragStart(e) {
    const id = String(e.active.id);
    if (id.startsWith('oh-')) {
      setActiveDrag({ type: 'officeHour', id, data: e.active.data?.current?.officeHour });
    } else if (sections.some(s => s.id === id)) {
      setActiveDrag({ type: 'section', id });
    } else {
      setActiveDrag({ type: 'course', id });
    }
  }

  async function handleDragEnd(e) {
    const prev = activeDrag;
    setActiveDrag(null);
    const { active, over } = e;
    if (!over || !active) return;

    // Only act on drops over grid cells (id format: "Day|minutes")
    const overId = String(over.id);
    if (!overId.includes('|')) return;

    const [day, minStr] = overId.split('|');
    const startTime = fromMinutes(parseInt(minStr));

    if (prev?.type === 'section') {
      const sec = sections.find(s => s.id === active.id);
      if (!sec) return;
      const origStart  = sec.startTime ?? sec.start_time ?? '';
      const origEnd    = sec.endTime   ?? sec.end_time   ?? '';
      const duration   = timeToMin(origEnd) - timeToMin(origStart);
      if (day === sec.day && startTime === origStart.substring(0,5)) return;

      const origGroup = DAY_GROUPS[sec.day] ?? 'single';
      const newGroup  = DAY_GROUPS[day]     ?? 'single';

      // If dropped onto a different day group → show confirmation first
      if (origGroup !== newGroup && origGroup !== 'single') {
        setGroupChangeModal({ sec, newDay: day, newStartTime: startTime, duration });
        return;
      }

      await moveSection(sec.id, {
        instructorId: sec.instructorId ?? sec.instructor_id,
        venueId:      sec.venueId      ?? sec.venue_id,
        day, startTime, endTime: fromMinutes(timeToMin(startTime) + duration),
      });
      // Reload to show all siblings at new time
      if (schedule) loadView(schedule.id, view, filterId);
    } else if (prev?.type === 'course') {
      setSectionModal({
        mode: 'add',
        initial: { courseId: active.id, day, startTime, duration: DAY_DURATION[day] ?? 50 },
      });
    } else if (prev?.type === 'officeHour' && prev?.data) {
      const oh = prev.data;
      const ohStart = oh.start_time ?? oh.startTime ?? '';
      const ohEnd   = oh.end_time   ?? oh.endTime   ?? '';
      const duration = timeToMin(ohEnd) - timeToMin(ohStart);
      const newEnd   = fromMinutes(timeToMin(startTime) + duration);
      try {
        // Delete old, create new at new day/time
        await api.deleteInstructorOfficeHour(oh.instructor_id ?? filterId, oh.id);
        await api.addInstructorOfficeHour(oh.instructor_id ?? filterId, {
          day, startTime, endTime: newEnd,
        });
        // Reload view to reflect the change
        if (schedule) loadView(schedule.id, view, filterId);
      } catch(err) {
        showToast('Failed to move office hours.', 'error');
      }
    }
  }

  function handleDragCancel() { setActiveDrag(null); }

  // ── Group change confirmation ──────────────────────────────────────────────
  async function confirmGroupChange() {
    if (!groupChangeModal || !schedule) return;
    const { sec, newDay, newStartTime, duration } = groupChangeModal;
    setGroupChangeModal(null);

    const newGroup   = DAY_GROUPS[newDay] ?? 'single';
    const newDays    = newGroup !== 'single' ? GROUP_DAYS[newGroup] : [newDay];
    const newEndTime = fromMinutes(timeToMin(newStartTime) + duration);

    // Delete old group siblings then create new group
    try {
      await import('../api/index.js').then(async api => {
        // Delete all old siblings via the service (which handles group deletion)
        await api.deleteSection(sec.id);
        // Create new sections for the new day group
        for (const d of newDays) {
          await api.createSection(schedule.id, {
            courseId:      sec.courseId      ?? sec.course_id,
            instructorId:  sec.instructorId  ?? sec.instructor_id,
            venueId:       sec.venueId       ?? sec.venue_id,
            sectionNumber: sec.sectionNumber ?? sec.section_number,
            day:           d,
            startTime:     newStartTime,
            endTime:       newEndTime,
          });
        }
      });
      showToast(`✓ Section moved to ${GROUP_LABELS[newGroup] ?? newDay}.`, 'success');
      loadView(schedule.id, view, filterId);
    } catch(err) {
      showToast('Failed to change group.', 'error');
    }
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function handleSave() {
    if (saveBlocked) return;
    if (softPending.length > 0) { setShowSoftModal(true); return; }
    await doSave(false);
  }
  async function doSave(confirmSoft) {
    setShowSoftModal(false);
    try {
      const r = await saveSchedule(confirmSoft);
      showToast(r.saved ? '✓ Schedule saved.' : 'Conflicts remain.', r.saved ? 'success' : 'error');
    } catch { showToast('Save failed.', 'error'); }
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  function handleExport() {
    if (!schedule) return;
    setShowExport(true);
  }

  async function doExport(exportView, exportFilterId) {
    if (!schedule) return;
    const { getExportUrl } = await import('../api/index.js');
    const url   = getExportUrl(schedule.id, exportView, exportFilterId);
    const token = localStorage.getItem('token');
    try {
      const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = `${schedule.semester}-${exportView}-schedule.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('✓ Excel downloaded.', 'success');
    } catch { showToast('Export failed.', 'error'); }
  }

  function handleBlockClick(section) { setSectionModal({ mode: 'edit', initial: { section } }); }
  function handleOHClick(oh) { setOhModal({ officeHour: oh, instructorId: filterId }); }

  function handleModalClose() {
    setSectionModal(null);
    // Always reload after any modal action (add/edit/delete may affect siblings)
    if (schedule) loadView(schedule.id, view, filterId);
  }
  function handleOpenAdd()            { setSectionModal({ mode: 'add',  initial: {} }); }
  function handleSuggest() {
    if (!schedule) return;
    setShowSuggest(true);
  }

  async function runSuggest(courseConfigs) {
    setShowSuggest(false);
    showToast('⏳ Calculating best schedule…', 'info');
    try {
      const { suggestSchedule } = await import('../api/index.js');
      const result = await suggestSchedule(schedule.id, courseConfigs);
      dispatch({ type:'SET_CONFLICTS', conflicts: result.conflicts ?? [] });
      await loadView(schedule.id, view, filterId);
      const hard = (result.conflicts??[]).filter(c=>c.severity==='Hard').length;
      const soft = (result.conflicts??[]).filter(c=>c.severity==='Soft').length;
      showToast(
        `✓ Suggested — ${hard} hard, ${soft} soft conflicts.`,
        hard > 0 ? 'error' : soft > 0 ? 'warn' : 'success'
      );
    } catch(err) {
      showToast('Suggest failed: ' + (err.response?.data?.error ?? err.message), 'error');
    }
  }
  function showToast(msg, type='info') {
    setToast({ message: msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  // Drag overlay content
  const activeSection = activeDrag?.type === 'section'
    ? sections.find(s => s.id === activeDrag.id) : null;
  const activeCourse  = activeDrag?.type === 'course'
    ? courses.find(c => c.id === activeDrag.id) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="scheduler-root">
        <TopBar onSave={handleSave} onSuggest={handleSuggest} onExport={handleExport} />

        <div className="scheduler-body">
          <SidePanel showToast={showToast} onAddSection={handleOpenAdd} onEditSection={sec => sec && setSectionModal({ mode:'edit', initial:{ section: sec } })} />

          <main className="scheduler-main">
            <div className="view-label">
              {view === VIEWS.TEACHER && filterId ? '👤 Teacher View'
                : view === VIEWS.VENUE && filterId ? '🏛 Venue View'
                : '📋 Course View'}
              {!filterId && view !== VIEWS.COURSE && (
                <span className="view-hint"> — select a {view} from the sidebar</span>
              )}
              <span className="view-hint" style={{ marginLeft:'auto', fontSize:'.73rem' }}>
                Click a block to edit · Drag a course card to add a section
              </span>
            </div>

            <div className="grid-scroll-container">
              <ScheduleGrid onBlockClick={handleBlockClick} onOHClick={handleOHClick} />
            </div>
          </main>
        </div>

        {showSoftModal && (
          <SoftConflictModal
            conflicts={softPending}
            onConfirm={() => doSave(true)}
            onCancel={() => setShowSoftModal(false)}
          />
        )}

        {sectionModal && (
          <SectionModal
            mode={sectionModal.mode}
            initial={sectionModal.initial}
            onClose={handleModalClose}
            showToast={showToast}
          />
        )}

        {showSuggest && (
        <SuggestModal
          onConfirm={runSuggest}
          onClose={() => setShowSuggest(false)}
        />
      )}

      {groupChangeModal && (
        <GroupChangeModal
          sec={groupChangeModal.sec}
          newDay={groupChangeModal.newDay}
          newStartTime={groupChangeModal.newStartTime}
          onConfirm={confirmGroupChange}
          onCancel={() => setGroupChangeModal(null)}
        />
      )}

      {showExport && (
          <ExportModal
            onExport={doExport}
            onClose={() => setShowExport(false)}
          />
        )}

        {toast && (
          <div className={`toast toast-${toast.type}`} role="alert">{toast.message}</div>
        )}
      </div>

      <DragOverlay>
        {activeSection && (
          <div style={{
            background:'#e0f2fe', border:'2px solid #0284c7',
            borderRadius:6, padding:'6px 10px',
            fontFamily:'var(--font-mono)', fontSize:'.78rem', fontWeight:600,
            boxShadow:'0 4px 16px rgba(0,0,0,.2)',
          }}>
            {activeSection.courseCode ?? activeSection.course_code} §{activeSection.sectionNumber ?? activeSection.section_number}
          </div>
        )}
        {activeCourse && (
          <div style={{
            background: LEVEL_COLORS[activeCourse.academic_level]?.bg ?? '#e0f2fe',
            border: `2px dashed ${LEVEL_COLORS[activeCourse.academic_level]?.border ?? '#0284c7'}`,
            color: LEVEL_COLORS[activeCourse.academic_level]?.text ?? '#0c4a6e',
            borderRadius:6, padding:'6px 10px',
            fontFamily:'var(--font-mono)', fontSize:'.78rem', fontWeight:600,
            boxShadow:'0 4px 16px rgba(0,0,0,.2)',
          }}>
            {activeCourse.course_code} → drop on grid
          </div>
        )}
        {activeDrag?.type === 'officeHour' && (
          <div style={{
            background:'#f3f4f6', border:'2px dashed #6b7280',
            borderRadius:6, padding:'6px 10px',
            fontSize:'.78rem', fontStyle:'italic', color:'#6b7280',
            boxShadow:'0 4px 16px rgba(0,0,0,.2)',
          }}>
            Office Hours → drop to move
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function timeToMin(t) {
  if (!t) return 0;
  const [h,m] = t.substring(0,5).split(':').map(Number);
  return (h||0)*60+(m||0);
}
