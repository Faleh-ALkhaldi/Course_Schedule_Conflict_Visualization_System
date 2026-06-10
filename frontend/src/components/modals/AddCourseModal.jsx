// NEW-FU-279 (Phase 55): Add Course as a proper modal.
//
// Why a modal: the Phase 54 inline form lived inside the sidebar's
// `.sp-form` scope, which collapses its content to the sidebar's narrow
// width. Even with inline `display: flex` on each checkbox label, the
// inner `<span>` description was wrapping at sub-checkbox column widths
// (each word on its own line) because the outer column gave the content
// area effectively ~30 CSS pixels. The visual result was the broken
// "Has la / sectio / Course / has bo" rendering in the Phase 55 prompt
// screenshot.
//
// Promoting the form to a modal escapes that scope entirely — the modal
// is a `position: fixed` overlay attached to the React root, so no
// SidePanel CSS rule reaches it. Scoped class prefix `.acm-*` (Add
// Course Modal) prevents the same accident from recurring under a
// future global selector. The visual style mirrors the Add Section
// modal (`.sm-overlay` / `.sm-card`) for consistency.

import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../../context/AppContext.jsx';

// Re-use the Add Section modal's styling so spacing, button shapes,
// pill chips, and form-error look identical across modals. The card
// and overlay come from SectionModal.css (loaded once for the whole
// modals folder by the SectionModal import chain).
import './SectionModal.css';

export default function AddCourseModal({ onClose, showToast }) {
  const { addCourse, courses } = useApp();

  // Escape closes — matches every other modal in the app.
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const [form, setForm] = useState({
    courseCode: '',
    name: '',
    category: 'UG',
    academicLevel: 'Junior',
    credits: '3',
    numSections: '1',
    hasLab: false,
    isCapstone: false,
    isExternal: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // NEW-FU-484 (Phase 118 item 3): level-gated flags.
  // CAPSTONE = Undergraduate + Senior only.
  // EXTERNAL = Undergraduate + Junior only.
  // Plain derived consts — recalculated on every render; no useMemo needed
  // because the derivation is O(1) and the values are compared by reference
  // in the useEffect dependency array.
  const capstoneAllowed = form.category === 'UG' && form.academicLevel === 'Senior';
  const externalAllowed = form.category === 'UG' && form.academicLevel === 'Junior';

  // NEW-FU-422 (Phase 104 item 4): LIVE code/name validation mirroring the API
  // rule — flagged as the user types, not on Save. Code = "SWE " + 101–599.
  const codeError = (() => {
    const c = (form.courseCode || '').trim();
    if (!c) return null;                         // emptiness → handled by Save guard
    const m = /^SWE (\d{3})$/.exec(c);
    if (!m) return 'Enter the 3-digit course number after SWE (e.g. 206).';
    const n = parseInt(m[1], 10);
    if (n < 101 || n > 599) return `Course number must be 101–599 (got ${m[1]}).`;
    return null;
  })();
  const nameError = (() => {
    const nm = (form.name || '').trim();
    if (!nm) return null;
    if (nm.length < 3) return 'Name must be at least 3 characters.';
    // NEW-FU-455 (Phase 108): mirror the hardened backend rule — reject runs of 4+
    // identical chars ("hhhhhhhhhhhhhh") and names with no real 2-letter word.
    if (!/^(?!.*(.)\1{3})(?=.*[A-Za-z]{2})[A-Za-z][A-Za-z0-9 .,&()/+\-]{2,}$/.test(nm))
      return 'Name must be a real title (letters, spaces, and basic punctuation; no gibberish).';
    return null;
  })();
  // NEW-FU-457 (Phase 108): runtime DUPLICATE checks — flag a duplicate course
  // code or name INSTANTLY as the user types (the DB enforces a UNIQUE code; this
  // surfaces it up front instead of as a post-Save round-trip). Case-insensitive.
  const dupCodeError = (() => {
    const c = (form.courseCode || '').trim();
    if (!c || codeError) return null;
    return courses.some(co => (co.course_code || '').toLowerCase() === c.toLowerCase())
      ? `Course code ${c} already exists — edit that course instead.` : null;
  })();
  const dupNameError = (() => {
    const nm = (form.name || '').trim();
    if (!nm || nameError) return null;
    return courses.some(co => (co.name || '').trim().toLowerCase() === nm.toLowerCase())
      ? `A course named "${nm}" already exists.` : null;
  })();
  const formInvalid = !!codeError || !!nameError || !!dupCodeError || !!dupNameError
    || !(form.courseCode || '').trim() || !(form.name || '').trim();

  // NEW-FU-484 (Phase 118 item 3): auto-uncheck gated flags when the user
  // switches to a disallowed level/category. The useEffect dependency is the
  // derived boolean, so it fires exactly when the allowed status flips.
  // (setForm callback always reads fresh state, so no stale-closure risk.)
  useEffect(() => {
    setForm(f => {
      const next = { ...f };
      if (!capstoneAllowed && f.isCapstone) next.isCapstone = false;
      if (!externalAllowed && f.isExternal) next.isExternal = false;
      return next;
    });
  }, [capstoneAllowed, externalAllowed]); // eslint-disable-line react-hooks/exhaustive-deps

  // NEW-FU-423 (Phase 104 item 3): course type flags are mutually exclusive —
  // pick AT MOST ONE of has-lab / capstone / external. Selecting one clears the
  // others; unchecking leaves a plain lecture course (none).
  function pickFlag(flag) {
    setForm(f => ({
      ...f,
      hasLab:     flag === 'hasLab'     ? !f.hasLab     : false,
      isCapstone: flag === 'isCapstone' ? !f.isCapstone : false,
      isExternal: flag === 'isExternal' ? !f.isExternal : false,
    }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await addCourse(form);
      showToast(`✓ Course ${form.courseCode} added.`, 'success');
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to add course.');
    } finally {
      setBusy(false);
    }
  }

  // Chip-pill button helper. Reuses .sm-daymode-btn from SectionModal.css
  // so the appearance is identical to the section modal's pills.
  function Chip({ active, onClick, children, style }) {
    return (
      <button type="button"
        className={`sm-daymode-btn ${active ? 'active' : ''}`}
        style={style}
        onClick={onClick}>
        {children}
      </button>
    );
  }

  return (
    <div className="sm-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sm-card" style={{ maxWidth: 480 }}>
        <div className="sm-header">
          <h2 className="sm-title">+ Add Course</h2>
          <button className="sm-close" onClick={onClose}>×</button>
        </div>

        <form className="sm-form" noValidate onSubmit={handleSubmit}>
          <div className="sm-field">
            <label>Course code</label>
            {/* NEW-FU-479 (Phase 115): the "SWE" prefix is fixed by the system — the user
                types only the 3-digit number (101–599); the stored code is "SWE " + digits. */}
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', padding: '0 12px', borderRadius: 8, background: 'var(--surface-2, #eef2f7)', fontWeight: 700, letterSpacing: '.5px' }}>SWE</span>
              <input style={{ flex: 1 }} inputMode="numeric" maxLength={3} placeholder="206"
                aria-label="Course number (101–599)"
                aria-invalid={!!codeError || !!dupCodeError}
                value={(form.courseCode || '').replace(/^SWE\s*/i, '').replace(/\D/g, '').slice(0, 3)}
                onChange={e => { const d = e.target.value.replace(/\D/g, '').slice(0, 3); setForm(f => ({ ...f, courseCode: d ? `SWE ${d}` : '' })); }} />
            </div>
            {codeError && <p className="sm-inline-error" role="alert"><span>{codeError}</span></p>}
            {!codeError && dupCodeError && <p className="sm-inline-error" role="alert"><span>{dupCodeError}</span></p>}
          </div>

          <div className="sm-field">
            <label>Course name</label>
            <input placeholder="e.g. Software Architecture" value={form.name}
              aria-invalid={!!nameError || !!dupNameError}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            {nameError && <p className="sm-inline-error" role="alert"><span>{nameError}</span></p>}
            {!nameError && dupNameError && <p className="sm-inline-error" role="alert"><span>{dupNameError}</span></p>}
          </div>

          <div className="sm-field">
            <label>Category</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <Chip active={form.category === 'UG'}
                onClick={() => setForm(f => ({
                  ...f, category: 'UG',
                  academicLevel: f.academicLevel === 'Graduate' ? 'Junior' : f.academicLevel,
                }))}
                style={{ flex: 1 }}>Undergraduate</Chip>
              <Chip active={form.category === 'GR'}
                onClick={() => setForm(f => ({ ...f, category: 'GR', academicLevel: 'Graduate' }))}
                style={{ flex: 1 }}>Graduate</Chip>
            </div>
          </div>

          {form.category === 'UG' && (
            <div className="sm-field">
              <label>Academic level</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['Freshman', 'Sophomore', 'Junior', 'Senior'].map(l => (
                  <Chip key={l} active={form.academicLevel === l}
                    onClick={() => setForm(f => ({ ...f, academicLevel: l }))}
                    style={{ flex: '1 1 calc(50% - 3px)' }}>{l}</Chip>
                ))}
              </div>
            </div>
          )}
          {form.category === 'GR' && (
            <div className="sm-info-box">
              Academic level: <strong>Graduate</strong> (fixed for GR courses)
            </div>
          )}

          <div className="sm-field">
            <label>
              Credits
              <span className="sm-optional"> &nbsp;0–4 (0 = capstone-part-I, e.g. SWE 413)</span>
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              {['0', '1', '2', '3', '4'].map(c => (
                <Chip key={c} active={form.credits === c}
                  onClick={() => setForm(f => ({ ...f, credits: c }))}
                  style={{ flex: 1 }}>{c}</Chip>
              ))}
            </div>
          </div>

          <div className="sm-field">
            <label>
              Number of sections
              <span className="sm-optional"> &nbsp;parallel sections per term</span>
            </label>
            <input type="number" min="1" max="20" value={form.numSections}
              onChange={e => setForm(f => ({ ...f, numSections: e.target.value }))} />
          </div>

          {/* Course flags — each on its own row with the description on the
              same line as the bold label. The scoped .acm-flag-row class
              has no parent CSS interference (we're in the modal overlay,
              not the sidebar's .sp-form scope). */}
          <div className="sm-field" style={{ borderTop: '1px solid var(--slate-200)', paddingTop: 12, marginTop: 4 }}>
            <label style={{ marginBottom: 6 }}>Course flags</label>

            <label className="acm-flag-row" style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0', cursor: 'pointer',
            }}>
              <input type="checkbox" checked={form.hasLab} style={{ marginTop: 3, flex: '0 0 auto' }}
                onChange={() => pickFlag('hasLab')} />
              <span style={{ fontSize: '.85rem', lineHeight: 1.4, flex: 1 }}>
                <strong>Has lab sections</strong>{' '}
                <span style={{ color: 'var(--slate-500)', fontWeight: 'normal' }}>
                  — course has both lectures and hands-on labs; you'll choose Lecture or Lab when adding a section.
                </span>
              </span>
            </label>

            {/* NEW-FU-484 (Phase 118 item 3): disabled + note when level is wrong. */}
            <label className="acm-flag-row" style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0',
              cursor: capstoneAllowed ? 'pointer' : 'default',
              opacity: capstoneAllowed ? 1 : 0.45,
            }}>
              <input type="checkbox" checked={form.isCapstone}
                style={{ marginTop: 3, flex: '0 0 auto' }}
                disabled={!capstoneAllowed}
                onChange={() => pickFlag('isCapstone')} />
              <span style={{ fontSize: '.85rem', lineHeight: 1.4, flex: 1 }}>
                <strong>◇ Capstone</strong>{' '}
                <span style={{ color: 'var(--slate-500)', fontWeight: 'normal' }}>
                  — graduation project. A capstone has no fixed room or class time, so the
                  room and meeting-time checks are skipped; it's still checked for instructor
                  and student time clashes.
                </span>
                {!capstoneAllowed && (
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--slate-400)', fontStyle: 'italic', fontSize: '.8rem' }}>
                    Only available for Undergraduate → Senior courses.
                  </span>
                )}
              </span>
            </label>

            <label className="acm-flag-row" style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0',
              cursor: externalAllowed ? 'pointer' : 'default',
              opacity: externalAllowed ? 1 : 0.45,
            }}>
              <input type="checkbox" checked={form.isExternal}
                style={{ marginTop: 3, flex: '0 0 auto' }}
                disabled={!externalAllowed}
                onChange={() => pickFlag('isExternal')} />
              <span style={{ fontSize: '.85rem', lineHeight: 1.4, flex: 1 }}>
                <strong>✈ External</strong>{' '}
                <span style={{ color: 'var(--slate-500)', fontWeight: 'normal' }}>
                  — off-campus internship (e.g., SWE 399 Summer Training); it isn't held on
                  campus, so no scheduling-conflict checks apply.
                </span>
                {!externalAllowed && (
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--slate-400)', fontStyle: 'italic', fontSize: '.8rem' }}>
                    Only available for Undergraduate → Junior courses.
                  </span>
                )}
              </span>
            </label>
          </div>

          {error && <div className="sm-error">{error}</div>}

          <div className="sm-actions">
            <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="sm-btn-save" disabled={busy || formInvalid}
              title={formInvalid ? 'Enter a valid course code (SWE 101–599) and name first' : undefined}>
              {busy ? '…' : 'Add Course'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
