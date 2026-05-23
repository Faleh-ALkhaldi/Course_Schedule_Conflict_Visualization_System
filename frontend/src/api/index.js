import axios from 'axios';

// Resolve API base URL.
// - If VITE_API_URL starts with http(s), use it as-is.
// - If VITE_API_URL is a bare host (or host:port from a hosting platform),
//   normalize to https://<host>/api/v1.
// - Otherwise fall back to '/api/v1' so the Vite dev proxy keeps working.
function resolveApiBaseUrl() {
  const raw = import.meta.env.VITE_API_URL;
  if (!raw) return '/api/v1';
  if (/^https?:\/\//i.test(raw)) return raw;
  const hostOnly = raw.replace(/:(80|443)$/, '');
  return `https://${hostOnly}/api/v1`;
}

const API_BASE_URL = resolveApiBaseUrl();

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT on every request
api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

// Redirect to login on 401
api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// ── Auth ──────────────────────────────────────────────────────────────────────
export const login = (username, password) =>
  api.post('/auth/login', { username, password }).then(r => r.data);

// ── Reference data ────────────────────────────────────────────────────────────
export const getCourses     = () => api.get('/courses').then(r => r.data);
export const getInstructors = () => api.get('/instructors').then(r => r.data);
export const getVenues      = () => api.get('/venues').then(r => r.data);

// ── Schedules ─────────────────────────────────────────────────────────────────
export const listSchedules  = (deptId) =>
  api.get(`/departments/${deptId}/schedules`).then(r => r.data);
export const createSchedule = (data) =>
  api.post('/schedules', data).then(r => r.data);

// ── Sections ──────────────────────────────────────────────────────────────────
export const getSections = (scheduleId, view, filterId) => {
  const params = { view };
  if (view === 'teacher') params.instructorId = filterId;
  if (view === 'venue')   params.venueId      = filterId;
  return api.get(`/schedules/${scheduleId}/sections`, { params }).then(r => r.data);
};

export const createSection = (scheduleId, data) =>
  api.post(`/schedules/${scheduleId}/sections`, data).then(r => r.data);

export const updateSection = (sectionId, data) =>
  api.put(`/sections/${sectionId}`, data).then(r => r.data);

export const deleteSection = (id) =>
  api.delete(`/sections/${id}`).then(r => r.data);

// ── Conflicts & Save ──────────────────────────────────────────────────────────
export const getConflicts = (scheduleId) =>
  api.get(`/schedules/${scheduleId}/conflicts`).then(r => r.data);

export const saveSchedule = (scheduleId, confirmSoft = false) =>
  api.post(`/schedules/${scheduleId}/save`, { confirmSoft }).then(r => r.data);

// ── Export ────────────────────────────────────────────────────────────────────
export const getExportUrl = (scheduleId, view, filterId) => {
  const base = API_BASE_URL;
  const params = new URLSearchParams({ view: view || 'full' });
  if (view === 'teacher' && filterId) params.set('instructorId', filterId);
  if (view === 'venue'   && filterId) params.set('venueId',      filterId);
  return `${base}/schedules/${scheduleId}/export?${params}`;
};

// ── Instructors ───────────────────────────────────────────────────────────────
export const createInstructor = (data) =>
  api.post('/instructors', data).then(r => r.data);
export const deleteInstructor = (id) =>
  api.delete(`/instructors/${id}`).then(r => r.data);

// ── Venues ────────────────────────────────────────────────────────────────────
export const createVenue = (data) =>
  api.post('/venues', data).then(r => r.data);
export const deleteVenue = (id) =>
  api.delete(`/venues/${id}`).then(r => r.data);

// ── Courses ───────────────────────────────────────────────────────────────────
export const createCourse = (data) =>
  api.post('/courses', data).then(r => r.data);
export const deleteCourse = (id) =>
  api.delete(`/courses/${id}`).then(r => r.data);

export default api;

// ── Office Hours ──────────────────────────────────────────────────────────────
export const getInstructorOfficeHours   = (instructorId) =>
  api.get(`/instructors/${instructorId}/office-hours`).then(r => r.data);
export const addInstructorOfficeHour    = (instructorId, data) =>
  api.post(`/instructors/${instructorId}/office-hours`, data).then(r => r.data);
export const deleteInstructorOfficeHour = (instructorId, ohId) =>
  api.delete(`/instructors/${instructorId}/office-hours/${ohId}`).then(r => r.data);

// ── Suggest ──────────────────────────────────────────────────────────────────
export const suggestSchedule = (scheduleId, courseConfigs) =>
  api.post(`/schedules/${scheduleId}/suggest`, { courseConfigs }).then(r => r.data);

// ── Import ────────────────────────────────────────────────────────────────────
export const importSchedule = (scheduleId, file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post(`/schedules/${scheduleId}/import`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data);
};
