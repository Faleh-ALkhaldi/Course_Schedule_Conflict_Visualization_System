// NEW-FU-280 (Phase 56): Add Instructor as a proper modal.
//
// Background: through Phase 55, the Add-Instructor form was an inline
// `<form className="sp-form">` inside SidePanel.jsx. It inherited the
// narrow sidebar width via the sidebar's flex chain, and the bare
// <input> elements rendered with the browser default chrome — no
// consistent border-radius, no focus ring, no labels above the fields.
// Side by side with the Phase 55 Add-Course modal it looked unfinished.
//
// Promoting it to a modal (same `.sm-overlay` / `.sm-card` chrome as
// Add Course and Add Section) gives us:
//   • Full-width 480px card that escapes the sidebar's narrow scope.
//   • The same labelled `.sm-field` rows used everywhere else.
//   • An auto-derived KFUPM email preview the user can edit — common
//     case (Faleh Khaldi → faleh.khaldi@kfupm.edu.sa) is one tab away
//     from done, but full names with hyphens or non-ASCII initials
//     can still be overridden by hand.
//
// All "+ Add Instructor" entry points (SidePanel sidebar, SectionModal
// "+ New" shortcut) route through this component — single source of
// truth, no more divergent inline forms.

import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import { getSuggestedOfficeHour } from '../../api/index.js';
import './SectionModal.css';

// Derive a kfupm.edu.sa email from a free-form full name.
//
//   "Faleh Al-Khaldi"        → "faleh.al-khaldi@kfupm.edu.sa"
//   "  Mahmoud  El   Sayed " → "mahmoud.el.sayed@kfupm.edu.sa"
//   "محمد"                    → "" (non-Latin: leave for user to type)
//
// Strategy:
//   1. Lowercase + trim + collapse internal whitespace.
//   2. Drop characters that aren't a-z, 0-9, hyphen, or whitespace —
//      this kills accents (until normalize'd), apostrophes ("O'Brien"
//      → "o.brien"), and any stray punctuation.
//   3. Split on whitespace, drop empties, join with '.'.
//   4. If the result is empty (e.g. a non-Latin name), return ''. The
//      user can type the local-part by hand — better than emitting a
//      meaningless `@kfupm.edu.sa`.
function deriveEmail(fullName) {
  if (!fullName) return '';
  const cleaned = fullName
    .normalize('NFD')                        // separate accents into combining marks
    .replace(/[̀-ͯ]/g, '')         // strip the combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]/g, ' ')          // keep only letters, digits, '-', ws
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (cleaned.length === 0) return '';
  return `${cleaned.join('.')}@kfupm.edu.sa`;
}

// NEW-FU-510 (Batch 2): the full-name field accepts only English letters plus
// space, HYPHEN and APOSTROPHE — the seed already has "HASAN AL-KAF" and
// "AL-KHALDI", so a letters-only filter would corrupt those. Digits and other
// punctuation (the "3738 @#$" case) are stripped at the source. We also
// upper-case live to match the stored convention (the backend's
// normalizeInstructorName upper-cases server-side; this keeps the input and the
// saved value identical so there's no surprise jump on save).
const NAME_DISALLOWED = /[^A-Za-z\s'-]/g;
const NAME_ALLOWED_RE = /^[A-Za-z\s'-]+$/;
function sanitizeName(raw) {
  return raw.replace(NAME_DISALLOWED, '').toUpperCase();
}

// NEW-FU-511 (Batch 2): add one hour to an "HH:MM" time, clamped to 16:00 — the
// office-hours upper edge. Used to auto-move the end time when the user sets a
// start at/after the current end (office hours are a +1h block).
const OH_MAX_MIN = 16 * 60; // 16:00
function plusOneHourClamped(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.min(h * 60 + m + 60, OH_MAX_MIN);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// `onCreated` (optional): if provided, the new instructor object is
// passed to it after a successful POST. Used by SectionModal's "+ New"
// shortcut so the form can auto-select the freshly-created instructor.
// SidePanel doesn't pass it — the new entry just appears in the
// sidebar list via the ADD_INSTRUCTOR reducer action.
export default function AddInstructorModal({ onClose, showToast, onCreated }) {
  const { addInstructor } = useApp();

  // Escape closes — universal modal contract.
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const [name, setName]   = useState('');
  // `emailTouched` lets the email field auto-update from the name until
  // the user explicitly types into it. After that, the user's input
  // wins and the field is no longer regenerated on every keystroke.
  const [email, setEmail]               = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');

  // NEW-FU-461 (Phase 109): capture office hours up front (pre-filled with a sensible
  // default) so the new instructor is never flagged for having none. Days Sun–Thu;
  // the real office-hours window is roughly 08:00–14:00.
  const OH_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
  const [oh, setOh] = useState({ day: 'Sunday', startTime: '10:00', endTime: '11:00' });
  useEffect(() => {
    getSuggestedOfficeHour()
      .then(d => setOh({ day: d.day, startTime: (d.startTime || '10:00').slice(0, 5), endTime: (d.endTime || '11:00').slice(0, 5) }))
      .catch(() => {});
  }, []);

  const derivedEmail = useMemo(() => deriveEmail(name), [name]);
  const displayedEmail = emailTouched ? email : derivedEmail;

  function handleNameChange(e) {
    // NEW-FU-510 (Batch 2): sanitize (letters/space/hyphen/apostrophe only) and
    // upper-case at the source, so disallowed characters never appear in the
    // field and the displayed value matches what the backend will store.
    const clean = sanitizeName(e.target.value);
    setName(clean);
    // When the user hasn't touched email, keep our derived value in
    // state so the submit handler sees the right value if they hit
    // Enter without ever focusing the email field. deriveEmail lowercases
    // internally, so feeding it the ALL-CAPS name still yields a lowercase email.
    if (!emailTouched) setEmail(deriveEmail(clean));
  }
  function handleEmailChange(e) {
    setEmailTouched(true);
    setEmail(e.target.value);
  }
  // NEW-FU-511 (Batch 2): when the start time moves to at/after the end time,
  // auto-move the end to start+1h (capped at 16:00) so the block stays valid
  // instead of bouncing the user with an ordering error. Office hours = +1h.
  function handleOhStartChange(e) {
    const start = clampOH(e.target.value);
    setOh(o => ({
      ...o,
      startTime: start,
      endTime: start >= o.endTime ? plusOneHourClamped(start) : o.endTime,
    }));
  }

  // Light client-side validation. The backend re-validates both fields
  // (controllers/index.js#createInstructor) — this is just to keep the
  // submit button accurate and the inline-error feedback fast.
  const trimmedName  = name.trim();
  const trimmedEmail = (emailTouched ? email : derivedEmail).trim();
  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail);
  // NEW-FU-466 (Phase 112): office hours may only be 08:00–16:00 (8 AM–4 PM) —
  // the same window the editor and backend enforce. Out-of-window blocks Add.
  // NEW-FU-496 (Phase 120): check BOTH endpoints against BOTH edges (so a start
  // AFTER 16:00 is caught, not just start<08:00 / end>16:00), and clamp the time
  // inputs so an out-of-window value can't be entered at all (runtime prevention).
  const OH_MIN = '08:00', OH_MAX = '16:00';
  const clampOH = v => !v ? v : (v < OH_MIN ? OH_MIN : v > OH_MAX ? OH_MAX : v);
  const ohWindowOk = oh.startTime >= OH_MIN && oh.startTime <= OH_MAX &&
                     oh.endTime   >= OH_MIN && oh.endTime   <= OH_MAX;
  const ohOrderOk  = oh.startTime < oh.endTime;
  const ohValid = !!oh.day && !!oh.startTime && !!oh.endTime && ohWindowOk && ohOrderOk;
  // NEW-FU-510 (Batch 2): belt-and-suspenders charset gate. handleNameChange
  // already strips disallowed characters at the source, but this also blocks Save
  // if anything slips through (e.g. a value set programmatically).
  const nameCharsetOk = trimmedName.length === 0 || NAME_ALLOWED_RE.test(trimmedName);
  const canSubmit = trimmedName.length > 0 && nameCharsetOk && emailLooksValid && ohValid && !busy;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setError('');
    try {
      const instructor = await addInstructor({
        name:  trimmedName,
        email: trimmedEmail,
        officeHours: { day: oh.day, startTime: oh.startTime, endTime: oh.endTime },
      });
      // NEW-FU-434 (Phase 106 item 6): note when this real instructor auto-replaced a placeholder.
      showToast(
        instructor.replacedDummy
          ? `✓ ${instructor.name} added — replaced placeholder ${instructor.replacedDummy.name}.`
          : `✓ Instructor ${instructor.name} added.`,
        'success');
      if (onCreated) onCreated(instructor);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to add instructor.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sm-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sm-card" style={{ maxWidth: 480 }}>
        <div className="sm-header">
          <h2 className="sm-title">+ Add Instructor</h2>
          <button className="sm-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form className="sm-form" onSubmit={handleSubmit}>
          <div className="sm-field">
            <label htmlFor="aim-name">Full name</label>
            <input id="aim-name" autoFocus required
              placeholder="e.g. Faleh Al-Khaldi"
              value={name}
              onChange={handleNameChange} />
          </div>

          <div className="sm-field">
            <label htmlFor="aim-email">
              KFUPM email
              <span className="sm-optional"> &nbsp;auto-derived; edit if needed</span>
            </label>
            <input id="aim-email" type="email" required
              placeholder="firstname.lastname@kfupm.edu.sa"
              value={displayedEmail}
              onChange={handleEmailChange} />
            {!emailTouched && derivedEmail && (
              <div className="sm-end-preview">
                Will save as <strong>{derivedEmail}</strong>
              </div>
            )}
          </div>

          {/* NEW-FU-461 (Phase 109): office hours — pre-filled + required, so a new
              instructor never shows a "no office hours" flag once assigned to a course. */}
          <div className="sm-field">
            <label>Office hours <span className="sm-optional">&nbsp;when students can drop by</span></label>
            <div className="sm-row">
              <select value={oh.day} onChange={e => setOh(o => ({ ...o, day: e.target.value }))} aria-label="Office hours day">
                {OH_DAYS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <input type="time" min={OH_MIN} max={OH_MAX} value={oh.startTime}
                onChange={handleOhStartChange} aria-label="Office hours start time" />
              <input type="time" min={OH_MIN} max={OH_MAX} value={oh.endTime}
                onChange={e => setOh(o => ({ ...o, endTime: clampOH(e.target.value) }))} aria-label="Office hours end time" />
            </div>
            {/* NEW-FU-496 (Phase 120): the window message takes priority and is
                always named — an ordering-only error still tells the user the
                acceptable 8:00 AM–4:00 PM window, so they're never left guessing. */}
            {!ohValid
              ? <p className="sm-inline-error" role="alert"><span>{
                  (!oh.day || !oh.startTime || !oh.endTime) ? 'Pick a day, a start time and an end time.'
                  : !ohWindowOk ? 'Office hours can only be between 8:00 AM and 4:00 PM.'
                  : 'Start time must be before the end time (office hours are 8:00 AM–4:00 PM).'}</span></p>
              : <p className="sm-hint">Pre-filled from the usual pattern — adjust if you like (8:00 AM–4:00 PM). You can add more later.</p>}
          </div>

          {error && <div className="sm-error">{error}</div>}

          <div className="sm-actions">
            <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="sm-btn-save" disabled={!canSubmit}>
              {busy ? '…' : 'Add Instructor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
