// NEW-FU-634 (issue #2b): detect when a proposed office-hour block would overlap the
// instructor's OWN class meetings — the R-04 case the backend flags as a Hard conflict —
// and suggest a conflict-free slot, so the UI can warn BEFORE the user saves rather than
// after. Pure functions (no React / no API) so they're reusable by the sidebar OH form,
// OfficeHourModal, and the dedicated OH subscreen (#5), and verifiable in isolation.

const OH_MIN = 8 * 60;   // 08:00 — office-hours window start
const OH_MAX = 16 * 60;  // 16:00 — office-hours window end

export function ohToMin(hhmm) {
  const [h, m] = String(hhmm ?? '').slice(0, 5).split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
}
function fromMin(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
function sectionSlot(s) {
  return { day: s.day, start: ohToMin(s.startTime ?? s.start_time), end: ohToMin(s.endTime ?? s.end_time) };
}
// Half-open overlap: adjacent blocks (10:00–11:00 / 11:00–12:00) do NOT clash.
function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }

// The instructor's class meetings (same day, time-overlapping) the proposed OH would hit.
export function findOfficeHourClassClashes(oh, instructorSections) {
  const start = ohToMin(oh.startTime), end = ohToMin(oh.endTime);
  if (!oh.day || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const out = [];
  for (const s of instructorSections || []) {
    if (s.day !== oh.day) continue;
    const slot = sectionSlot(s);
    if (Number.isFinite(slot.start) && Number.isFinite(slot.end) && overlaps(start, end, slot.start, slot.end)) {
      out.push(s);
    }
  }
  return out;
}

// A conflict-free OH slot of the same duration, same day if possible, within 08:00–16:00,
// avoiding the instructor's classes AND their other office hours. null if the day is full.
export function suggestFreeOfficeHour(oh, instructorSections, otherOfficeHours = [], stepMin = 30) {
  const start = ohToMin(oh.startTime), end = ohToMin(oh.endTime);
  const dur = (Number.isFinite(start) && Number.isFinite(end) && end > start) ? end - start : 60;
  const sameDay = (arr, mapper) => (arr || []).filter(x => x.day === oh.day).map(mapper);
  const blocked = [
    ...sameDay(instructorSections, sectionSlot),
    ...sameDay(otherOfficeHours, o => ({ start: ohToMin(o.start_time ?? o.startTime), end: ohToMin(o.end_time ?? o.endTime) })),
  ].filter(b => Number.isFinite(b.start) && Number.isFinite(b.end));
  const isFree = (st) => !blocked.some(b => overlaps(st, st + dur, b.start, b.end));
  const anchor = Number.isFinite(start) ? start : OH_MIN;
  const cands = [];
  for (let st = OH_MIN; st + dur <= OH_MAX; st += stepMin) cands.push(st);
  cands.sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor)); // nearest the user's pick first
  for (const st of cands) if (isFree(st)) return { day: oh.day, startTime: fromMin(st), endTime: fromMin(st + dur) };
  return null;
}

// Human label for a clashing section, e.g. "SWE 363 §03 on Sunday 11:00–12:15".
export function clashLabel(s) {
  const code = s.courseCode ?? s.course_code ?? 'class';
  const num = s.sectionNumber ?? s.section_number ?? '';
  const g = (s.gender ?? 'M') === 'F' ? 'F' : '';
  const t = `${String(s.startTime ?? s.start_time ?? '').slice(0, 5)}–${String(s.endTime ?? s.end_time ?? '').slice(0, 5)}`;
  return `${code} §${g}${num} on ${s.day} ${t}`;
}
