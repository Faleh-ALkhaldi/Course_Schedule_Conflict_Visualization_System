import React, { createContext, useContext, useReducer, useCallback } from 'react';
import * as api from '../api/index.js';

export const VIEWS = { COURSE: 'course', TEACHER: 'teacher', VENUE: 'venue' };
export const DAYS  = ['Sunday','Monday','Tuesday','Wednesday','Thursday'];

// Sun/Tue/Thu = 50 min, Mon/Wed = 75 min
export const DAY_DURATION = {
  Sunday: 50, Monday: 75, Tuesday: 50, Wednesday: 75, Thursday: 50,
};

export const SLOT_STEP  = 5;
const SLOT_START = 7 * 60;
const SLOT_END   = 22 * 60;

export function fromMinutes(m) {
  return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
}
export function toMinutes(t) {
  if (!t) return 0;
  const [h,mn] = t.substring(0,5).split(':').map(Number);
  return (h||0)*60+(mn||0);
}
export function generateSlots() {
  const slots = [];
  for (let m = SLOT_START; m < SLOT_END; m += SLOT_STEP) slots.push(fromMinutes(m));
  return slots;
}
export function isLabelSlot(slot) {
  return slot.endsWith(':00') || slot.endsWith(':30');
}

export const LEVEL_COLORS = {
  Freshman:  { bg:'#daeef3', border:'#1f6b7a', text:'#0d3d46' },
  Sophomore: { bg:'#e2efda', border:'#2d6a2e', text:'#1a3d1b' },
  Junior:    { bg:'#fff2cc', border:'#b8860b', text:'#6b4e00' },
  Senior:    { bg:'#e8e0f5', border:'#6b3fa0', text:'#3b1f5e' },
  Graduate:  { bg:'#e8d5f0', border:'#6b1f3a', text:'#3d0f21' },
};
export const SOFT_CONFLICT_BG = '#fffacd';
export const HARD_CONFLICT_BG = '#ffd5d5';
export const PX_PER_MIN = 2.2;

const initialState = {
  user:null, token:localStorage.getItem('token')||null,
  schedule:null, sections:[], officeHours:[], conflicts:[],
  courses:[], instructors:[], venues:[],
  view:VIEWS.COURSE, filterId:null,
  loading:false, saveBlocked:false, softPending:[], error:null,
};

function reducer(state, action) {
  switch(action.type) {
    case 'SET_AUTH':       return { ...state, user:action.user, token:action.token };
    case 'LOGOUT':         return { ...initialState, token:null };
    case 'SET_LOADING':    return { ...state, loading:action.value, error:null };
    case 'SET_ERROR':      return { ...state, error:action.error, loading:false };
    case 'SET_REFERENCE':  return { ...state,
      courses:     action.courses     ?? state.courses,
      instructors: action.instructors ?? state.instructors,
      venues:      action.venues      ?? state.venues,
    };
    case 'SET_SCHEDULE':   return { ...state, schedule:action.schedule };
    case 'SET_VIEW_DATA':  return { ...state, sections:action.sections, officeHours:action.officeHours??[], loading:false };
    case 'SET_CONFLICTS':  return { ...state,
      conflicts:   action.conflicts,
      saveBlocked: action.conflicts.some(c => c.severity === 'Hard' && !c.confirmed),
      softPending: action.conflicts.filter(c => c.severity === 'Soft' && !c.confirmed),
    };
    case 'SET_VIEW':       return { ...state, view:action.view, filterId:action.filterId??null, sections:[], officeHours:[], conflicts:[] };
    case 'UPSERT_SECTION': {
      // section may be null when backend returns group update (reload handles it)
      if (!action.section) return state;
      const idx = state.sections.findIndex(s=>s.id===action.section.id);
      return { ...state, sections: idx>=0
        ? state.sections.map((s,i)=>i===idx?action.section:s)
        : [...state.sections, action.section] };
    }
    case 'REMOVE_SECTION':     return { ...state, sections:    state.sections.filter(s=>s.id!==action.id) };
    case 'ADD_INSTRUCTOR':     return { ...state, instructors: [...state.instructors, action.instructor] };
    case 'REMOVE_INSTRUCTOR':  return { ...state, instructors: state.instructors.filter(i=>i.id!==action.id) };
    case 'ADD_VENUE':          return { ...state, venues:      [...state.venues, action.venue] };
    case 'REMOVE_VENUE':       return { ...state, venues:      state.venues.filter(v=>v.id!==action.id) };
    case 'ADD_COURSE':         return { ...state, courses:     [...state.courses, action.course] };
    case 'REMOVE_COURSE':      return { ...state, courses:     state.courses.filter(c=>c.id!==action.id) };
    default: return state;
  }
}

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    user: (() => { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } })(),
  });

  const doLogin = useCallback(async (username, password) => {
    dispatch({ type:'SET_LOADING', value:true });
    try {
      const { token, user } = await api.login(username, password);
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      dispatch({ type:'SET_AUTH', user, token });
    } catch(err) {
      dispatch({ type:'SET_ERROR', error:err.response?.data?.error||'Login failed' });
      throw err;
    }
  }, []);

  const doLogout = useCallback(() => {
    localStorage.removeItem('token'); localStorage.removeItem('user');
    dispatch({ type:'LOGOUT' });
  }, []);

  const loadReference = useCallback(async () => {
    const [courses, instructors, venues] = await Promise.all([
      api.getCourses(), api.getInstructors(), api.getVenues(),
    ]);
    dispatch({ type:'SET_REFERENCE', courses, instructors, venues });
  }, []);

  const loadView = useCallback(async (scheduleId, view, filterId) => {
    dispatch({ type:'SET_LOADING', value:true });
    try {
      const data = await api.getSections(scheduleId, view, filterId);
      dispatch({ type:'SET_VIEW_DATA', sections:data.sections??data, officeHours:data.officeHours??[] });
      const conflicts = await api.getConflicts(scheduleId);
      dispatch({ type:'SET_CONFLICTS', conflicts:conflicts.conflicts??[] });
    } catch { dispatch({ type:'SET_ERROR', error:'Failed to load schedule data.' }); }
  }, []);

  const moveSection = useCallback(async (sectionId, updates) => {
    const { section, conflicts:result } = await api.updateSection(sectionId, updates);
    // section may be null for group updates — reload whole view to get all siblings
    if (section) {
      dispatch({ type:'UPSERT_SECTION', section });
    }
    dispatch({ type:'SET_CONFLICTS', conflicts:result.conflicts??[] });
    return result;
  }, []);

  const addSection = useCallback(async (scheduleId, data) => {
    const { section, conflicts:result } = await api.createSection(scheduleId, data);
    if (section) {
      dispatch({ type:'UPSERT_SECTION', section });
    }
    dispatch({ type:'SET_CONFLICTS', conflicts:result.conflicts??[] });
    return { section, conflictResult:result };
  }, []);

  const removeSection = useCallback(async (sectionId) => {
    try {
      await api.deleteSection(sectionId);
      // Backend deletes all siblings — clear sections so grid updates
      dispatch({ type:'SET_VIEW_DATA', sections:[], officeHours:[] });
    } catch(err) {
      console.error('Delete section failed:', err.response?.data?.error ?? err.message);
      throw err;
    }
  }, []);

  const addInstructor = useCallback(async (data) => {
    const instructor = await api.createInstructor(data);
    dispatch({ type:'ADD_INSTRUCTOR', instructor });
    return instructor;
  }, []);

  const removeInstructor = useCallback(async (id) => {
    await api.deleteInstructor(id);
    dispatch({ type:'REMOVE_INSTRUCTOR', id });
  }, []);

  const addVenue = useCallback(async (data) => {
    const venue = await api.createVenue(data);
    dispatch({ type:'ADD_VENUE', venue });
    return venue;
  }, []);

  const removeVenue = useCallback(async (id) => {
    await api.deleteVenue(id);
    dispatch({ type:'REMOVE_VENUE', id });
  }, []);

  const addCourse = useCallback(async (data) => {
    const course = await api.createCourse(data);
    dispatch({ type:'ADD_COURSE', course });
    return course;
  }, []);

  const removeCourse = useCallback(async (id) => {
    try {
      await api.deleteCourse(id);
      dispatch({ type:'REMOVE_COURSE', id });
      // Also clear sections since course deletion removes all its sections
      dispatch({ type:'SET_VIEW_DATA', sections:[], officeHours:[] });
    } catch(err) {
      console.error('Delete course failed:', err.response?.data?.error ?? err.message);
      throw err;
    }
  }, []);

  const saveSchedule = useCallback(async (confirmSoft=false) => {
    if (!state.schedule) return;
    try {
      const result = await api.saveSchedule(state.schedule.id, confirmSoft);
      dispatch({ type:'SET_CONFLICTS', conflicts:result.conflictResult?.conflicts??[] });
      return result;
    } catch(err) {
      const r = err.response?.data;
      if (r?.conflictResult) dispatch({ type:'SET_CONFLICTS', conflicts:r.conflictResult.conflicts??[] });
      throw err;
    }
  }, [state.schedule]);

  const switchView = useCallback((view, filterId=null) => {
    dispatch({ type:'SET_VIEW', view, filterId });
  }, []);

  return (
    <AppContext.Provider value={{
      ...state,
      doLogin, doLogout, loadReference, loadView,
      moveSection, addSection, removeSection,
      addInstructor, removeInstructor,
      addVenue, removeVenue,
      addCourse, removeCourse,
      saveSchedule, switchView, dispatch,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => useContext(AppContext);
