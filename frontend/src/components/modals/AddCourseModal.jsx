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

import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext.jsx';

// Re-use the Add Section modal's styling so spacing, button shapes,
// pill chips, and form-error look identical across modals. The card
// and overlay come from SectionModal.css (loaded once for the whole
// modals folder by the SectionModal import chain).
import './SectionModal.css';

export default function AddCourseModal({ onClose, showToast }) {
  const { addCourse } = useApp();

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

        <form className="sm-form" onSubmit={handleSubmit}>
          <div className="sm-field">
            <label>Course code</label>
            <input placeholder="e.g. SWE 301" value={form.courseCode}
              onChange={e => setForm(f => ({ ...f, courseCode: e.target.value }))} required />
          </div>

          <div className="sm-field">
            <label>Course name</label>
            <input placeholder="e.g. Software Architecture" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
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
                onChange={e => setForm(f => ({ ...f, hasLab: e.target.checked }))} />
              <span style={{ fontSize: '.85rem', lineHeight: 1.4, flex: 1 }}>
                <strong>Has lab sections</strong>{' '}
                <span style={{ color: 'var(--slate-500)', fontWeight: 'normal' }}>
                  — course has both Lec and Lab; adds the Lec/Lab toggle in Add Section.
                </span>
              </span>
            </label>

            <label className="acm-flag-row" style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0', cursor: 'pointer',
            }}>
              <input type="checkbox" checked={form.isCapstone} style={{ marginTop: 3, flex: '0 0 auto' }}
                onChange={e => setForm(f => ({ ...f, isCapstone: e.target.checked }))} />
              <span style={{ fontSize: '.85rem', lineHeight: 1.4, flex: 1 }}>
                <strong>◇ Capstone</strong>{' '}
                <span style={{ color: 'var(--slate-500)', fontWeight: 'normal' }}>
                  — graduation project; skips R-05 / R-06 / R-10 / R-11 / R-12 / R-15 for this course.
                </span>
              </span>
            </label>

            <label className="acm-flag-row" style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0', cursor: 'pointer',
            }}>
              <input type="checkbox" checked={form.isExternal} style={{ marginTop: 3, flex: '0 0 auto' }}
                onChange={e => setForm(f => ({ ...f, isExternal: e.target.checked }))} />
              <span style={{ fontSize: '.85rem', lineHeight: 1.4, flex: 1 }}>
                <strong>✈ External</strong>{' '}
                <span style={{ color: 'var(--slate-500)', fontWeight: 'normal' }}>
                  — off-campus internship (e.g., SWE 399 Summer Training); every conflict rule is skipped.
                </span>
              </span>
            </label>
          </div>

          {error && <div className="sm-error">{error}</div>}

          <div className="sm-actions">
            <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="sm-btn-save" disabled={busy}>
              {busy ? '…' : 'Add Course'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
