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

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useApp } from '../../context/AppContext.jsx';

// Re-use the Add Section modal's styling so spacing, button shapes,
// pill chips, and form-error look identical across modals. The card
// and overlay come from SectionModal.css (loaded once for the whole
// modals folder by the SectionModal import chain).
import './SectionModal.css';

// NEW-FU-552 (Batch 17 Issue 1): runtime input filter + validation for the course
// NAME, mirroring the Add-Instructor full-name approach and the backend rule
// (domain/courseFormat.js). The charset is the single source of truth: anything
// outside it — non-English letters (Arabic, etc.), symbols ($ # @ % …) — is stripped
// the instant it's typed, so it can never enter the field. A real course name is
// never a single word (a one-word title carries a Roman numeral, e.g. "Compilers II"),
// so a space is required.
const COURSE_NAME_DISALLOWED = /[^A-Za-z0-9 .,&()/+'-]/g;
const sanitizeCourseName = (raw) => String(raw ?? '').replace(COURSE_NAME_DISALLOWED, '');

// NEW-FU-597 (Batch 27): accurate English TITLE CASE for course names, applied LIVE as the
// user types (so the field shows "Introduction to Software Engineering" while writing) and
// again on save. Rules: capitalize the first letter of every word; lowercase the small
// "minor" words (articles / conjunctions / short prepositions) UNLESS they lead the title;
// keep Roman numerals upper ("Senior Design Project II"). Case-only ⇒ same length ⇒ the
// caret stays put while typing left-to-right. Mirrored server-side (domain/courseFormat).
const COURSE_MINOR_WORDS = new Set(['a','an','the','and','or','nor','but','for','yet','so',
  'of','to','in','on','at','by','as','up','off','per','via','with','from','into']);
const COURSE_ROMAN_RE = /^(?=[ivx])x{0,3}(ix|iv|v?i{0,3})$/i; // I, II, III, IV … X, etc.
const capCourseWord = (w) =>
  w.toLowerCase().replace(/(^|[-/'(])([a-z])/g, (_, p, c) => p + c.toUpperCase());
const titleCaseCourseName = (raw) =>
  String(raw ?? '').split(' ').map((w, i) => {
    if (w === '') return w;                                  // keep spaces (incl. trailing) mid-type
    const lower = w.toLowerCase();
    if (COURSE_ROMAN_RE.test(lower)) return w.toUpperCase(); // Roman numerals stay upper
    if (i !== 0 && COURSE_MINOR_WORDS.has(lower)) return lower; // minor word (not leading) → lower
    return capCourseWord(w);
  }).join(' ');
const COURSE_NAME_RE = /^(?!.*(.)\1{3})(?=.*[A-Za-z]{2})[A-Za-z][A-Za-z0-9 .,&()/+'-]+$/;

export default function AddCourseModal({ onClose, showToast }) {
  useFocusTrap();
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

  // NEW-FU-592 (Batch 26): clear a stale submit error the instant the user edits any
  // form field, so a backend error from a previous attempt never lingers as a stuck
  // flag over a now-valid input. (Parity with Add Venue / Add Instructor.)
  useEffect(() => { setError(''); }, [form]);

  // NEW-FU-484 (Phase 118 item 3): level-gated flags.
  // CAPSTONE = Undergraduate + Senior only.
  // EXTERNAL = Undergraduate + Junior only.
  // Plain derived consts — recalculated on every render; no useMemo needed
  // because the derivation is O(1) and the values are compared by reference
  // in the useEffect dependency array.
  const capstoneAllowed = form.category === 'UG' && form.academicLevel === 'Senior';
  const externalAllowed = form.category === 'UG' && form.academicLevel === 'Junior';
  // NEW-FU-600 (Batch 28): a lab only makes sense for a 3- or 4-credit course (4-credit MUST
  // have one; 3-credit may). 0/1/2-credit courses meet too few hours to carry a lab section, so
  // the "Has lab" flag is DISABLED for them (and cleared if credits drop into that range).
  const labAllowed = form.credits === '3' || form.credits === '4';
  // NEW-FU-595 (Batch 27): only ONE external (internship / summer-training co-op) course is
  // allowed per term. If the active term already has one, disable the External toggle with a
  // clear note. `courses` is the term-scoped reference list, so an external course here is
  // already "in" this term. (The backend create + section-create guards are the backstop.)
  const externalCourse = (courses || []).find(c => c.is_external);
  const externalTaken  = !!externalCourse;
  const externalSelectable = externalAllowed && !externalTaken;
  // NEW-FU-647: the credit value MANDATES a flag — 4 credits ⇒ Has-lab, 0 credits ⇒ Capstone.
  // These are FORCED (auto-set + locked on) so the invalid state, and the on-save error it used
  // to produce, are unreachable: the user can't save a 4-credit course without a lab, or uncheck
  // the capstone on a 0-credit course. The reconcile effect below sets them; these flags drive
  // the locked (disabled) checkbox + "required" note in the UI.
  const labForced      = form.credits === '4';
  const capstoneForced = form.credits === '0' && capstoneAllowed;
  // NEW-FU-602 (Batch 28 item 3): a 0-credit course must be a Capstone. The effect above
  // auto-ticks Capstone when the level allows it (UG Senior); this error covers the case where
  // it can't (non-Senior 0-credit) — Save is blocked until the user sets the level to Senior,
  // which enables Capstone. Mirrors the backend creditsFlagError 0cr⇒capstone gate.
  const creditCapstoneError = (form.credits === '0' && !form.isCapstone)
    ? 'A 0-credit course must be a Capstone (Senior graduation project, e.g. SWE 413). Set the academic level to Senior to enable it.'
    : null;

  // NEW-FU-422 (Phase 104 item 4): LIVE code/name validation mirroring the API
  // rule — flagged as the user types, not on Save. Code = "SWE " + 101–699.
  const codeError = (() => {
    const c = (form.courseCode || '').trim();
    if (!c) return null;                         // emptiness → handled by Save guard
    // NEW-FU-599 (Batch 28): the FIRST digit fixes the band — only 1–6 can yield 101–699, so a
    // leading 0/7/8/9 can never be valid. Flag it the INSTANT it's typed (1 digit is enough),
    // instead of waiting for all three digits — "999" or "7…" reads as out-of-range right away.
    const num = c.replace(/^SWE\s*/i, '');
    if (num && !/^[1-6]/.test(num)) return 'Course number must be 101–699 — it must start with 1–6.';
    const m = /^SWE (\d{3})$/.exec(c);
    if (!m) return 'Enter the 3-digit course number after SWE (e.g. 206).';
    const n = parseInt(m[1], 10);
    if (n < 101 || n > 699) return `Course number must be 101–699 (got ${m[1]}).`;
    return null;
  })();
  // NEW-FU-579 (Batch 24): course NUMBER ↔ academic level/category are LIVE-LINKED in BOTH
  // directions, so a mismatch can't occur (the Batch-22 blocking error is gone). The hundreds
  // digit fixes the band — 1xx Freshman, 2xx Sophomore, 3xx Junior, 4xx Senior, 5xx/6xx
  // Graduate. Typing the number sets level+category (levelForCourseNumber, in the code
  // onChange); choosing a level/category rewrites the hundreds digit (LEVEL_PREFIX +
  // withHundreds, in the chip handlers). Backend courseCodeLevelError stays the authoritative
  // backstop for any direct API call.
  const levelForCourseNumber = (n) =>
      n >= 100 && n <= 199 ? { category: 'UG', level: 'Freshman' }
    : n >= 200 && n <= 299 ? { category: 'UG', level: 'Sophomore' }
    : n >= 300 && n <= 399 ? { category: 'UG', level: 'Junior' }
    : n >= 400 && n <= 499 ? { category: 'UG', level: 'Senior' }
    : n >= 500 && n <= 699 ? { category: 'GR', level: 'Graduate' }
    : null;
  const LEVEL_PREFIX = { Freshman: '1', Sophomore: '2', Junior: '3', Senior: '4', Graduate: '5' };
  // Rewrite the hundreds digit of the code to `h`, keeping the last two digits already typed.
  const withHundreds = (code, h) => {
    const digits = (code || '').replace(/^SWE\s*/i, '').replace(/\D/g, '').slice(0, 3);
    const next = h + digits.slice(1);
    return next ? `SWE ${next}` : '';
  };
  // Graduate keeps an existing 5xx/6xx prefix (600-level is advanced-graduate — allowed);
  // otherwise it defaults to 5xx (where most graduate courses live).
  const gradHundreds = (code) => {
    const h = (code || '').replace(/^SWE\s*/i, '').replace(/\D/g, '').charAt(0);
    return h === '5' || h === '6' ? h : '5';
  };
  const nameError = (() => {
    const nm = (form.name || '').trim();
    if (!nm) return null;
    if (nm.length < 3) return 'Name must be at least 3 characters.';
    // NEW-FU-552 (Batch 17 Issue 1): mirror the backend rule — require ≥2 words and
    // the English-only title charset (the input filter already strips the rest).
    if (!/\s/.test(nm)) return 'Course name needs at least two words (e.g. "Software Architecture").';
    if (!COURSE_NAME_RE.test(nm))
      return 'Use English letters, digits, spaces and basic punctuation only — no symbols or other scripts.';
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
    || !!creditCapstoneError   // FU-602: 0-credit must be a Capstone
    || !(form.courseCode || '').trim() || !(form.name || '').trim();

  // NEW-FU-484 (Phase 118 item 3): auto-uncheck gated flags when the user switches to a
  // disallowed level/category. NEW-FU-647: also keep the CREDIT-MANDATED flags in sync —
  // 0 credits ⇒ Capstone, 4 credits ⇒ Has-lab. SET the flag the current credit mandates, and
  // when the credit CHANGES away from a mandating value, DROP the flag it had auto-set so a stale
  // auto-flag never lingers (the user re-checks it if they still want it on the new credit).
  // prevCreditsRef distinguishes a real credit change from other reconcile triggers, so a MANUAL
  // flag on a non-mandating credit (e.g. a 2-credit Senior capstone, SWE 412) survives.
  const prevCreditsRef = useRef(form.credits);
  useEffect(() => {
    const prevCredits    = prevCreditsRef.current;
    const creditsChanged = prevCredits !== form.credits;
    prevCreditsRef.current = form.credits;
    setForm(f => {
      const next = { ...f };
      // (1) permit-based clears — the level/category/term no longer allows the flag.
      if (!capstoneAllowed && f.isCapstone) next.isCapstone = false;
      // NEW-FU-595 (Batch 27): clear External when not selectable (wrong level, or term already has one).
      if ((!externalAllowed || externalTaken) && f.isExternal) next.isExternal = false;
      // NEW-FU-600 (Batch 28): clear Has-lab when credits drop to 0/1/2 (no lab allowed there).
      if (!labAllowed && f.hasLab) next.hasLab = false;
      // (2) NEW-FU-647: on a REAL credit change, drop the flag the PREVIOUS credit MANDATED
      //     (it was auto-set), so leaving 0 clears Capstone and leaving 4 clears Has-lab instead
      //     of persisting into the new credit. (3-credit then shows Has-lab as an unchecked option.)
      if (creditsChanged) {
        if (prevCredits === '0' && f.credits !== '0') next.isCapstone = false;
        if (prevCredits === '4' && f.credits !== '4') next.hasLab = false;
      }
      // (3) SET the flag the CURRENT credit MANDATES, clearing the mutually-exclusive others:
      //     0 ⇒ Capstone (when the level allows it — SWE 413; else creditCapstoneError blocks Save),
      //     4 ⇒ Has-lab (every 4-credit course carries a lab — forced so the on-save error is
      //     unreachable; backend creditsFlagError stays the backstop).
      if (f.credits === '0' && capstoneAllowed) { next.isCapstone = true; next.hasLab = false; next.isExternal = false; }
      if (f.credits === '4')                    { next.hasLab = true; next.isCapstone = false; next.isExternal = false; }
      // No flag actually changed → return the same object so we don't trigger a wasted render.
      if (next.isCapstone === f.isCapstone && next.hasLab === f.hasLab && next.isExternal === f.isExternal) return f;
      return next;
    });
  }, [capstoneAllowed, externalAllowed, externalTaken, labAllowed, form.credits]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // NEW-FU-597 (Batch 27): title-case the name on save too — belt-and-suspenders in case
      // it was set programmatically; the live onChange already keeps it title-cased.
      await addCourse({ ...form, name: titleCaseCourseName(form.name) });
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
      <div className="sm-card" role="dialog" aria-modal="true" aria-label="Add course" style={{ maxWidth: 480 }}>
        <div className="sm-header">
          <h2 className="sm-title">+ Add Course</h2>
          <button className="sm-close" onClick={onClose}>×</button>
        </div>

        <form className="sm-form" noValidate onSubmit={handleSubmit}>
          <div className="sm-field">
            <label>Course code</label>
            {/* NEW-FU-479 (Phase 115): the "SWE" prefix is fixed by the system — the user
                types only the 3-digit number (101–699); the stored code is "SWE " + digits. */}
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', padding: '0 12px', borderRadius: 8, background: 'var(--bg-app)', color: 'var(--fg-dim)', fontWeight: 700, letterSpacing: '.5px' }}>SWE</span>
              <input style={{ flex: 1 }} inputMode="numeric" maxLength={3} placeholder="206"
                aria-label="Course number (101–699)"
                aria-invalid={!!codeError || !!dupCodeError}
                value={(form.courseCode || '').replace(/^SWE\s*/i, '').replace(/\D/g, '').slice(0, 3)}
                onChange={e => { const d = e.target.value.replace(/\D/g, '').slice(0, 3); setForm(f => {
                  const next = { ...f, courseCode: d ? `SWE ${d}` : '' };
                  // NEW-FU-579 (Batch 24): the hundreds digit immediately drives level + category.
                  const band = d ? levelForCourseNumber(parseInt(d[0] + '00', 10)) : null;
                  if (band) { next.category = band.category; next.academicLevel = band.level; }
                  return next;
                }); }} />
            </div>
            {codeError && <p className="sm-inline-error" role="alert"><span>{codeError}</span></p>}
            {!codeError && dupCodeError && <p className="sm-inline-error" role="alert"><span>{dupCodeError}</span></p>}
            {/* NEW-FU-576 (Batch 22): the number must match the selected academic level. */}
          </div>

          <div className="sm-field">
            <label>Course name</label>
            <input placeholder="e.g. Software Architecture" value={form.name}
              aria-invalid={!!nameError || !!dupNameError}
              onChange={e => setForm(f => ({ ...f, name: titleCaseCourseName(sanitizeCourseName(e.target.value)) }))} />
            {nameError && <p className="sm-inline-error" role="alert"><span>{nameError}</span></p>}
            {!nameError && dupNameError && <p className="sm-inline-error" role="alert"><span>{dupNameError}</span></p>}
          </div>

          <div className="sm-field">
            <label>Category</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <Chip active={form.category === 'UG'}
                onClick={() => setForm(f => {
                  // NEW-FU-579 (Batch 24): switching to UG also rewrites the hundreds digit to
                  // match the resulting level (Graduate→Junior fallback), keeping code ↔ level in sync.
                  const level = f.academicLevel === 'Graduate' ? 'Junior' : f.academicLevel;
                  return { ...f, category: 'UG', academicLevel: level, courseCode: withHundreds(f.courseCode, LEVEL_PREFIX[level]) };
                })}
                style={{ flex: 1 }}>Undergraduate</Chip>
              <Chip active={form.category === 'GR'}
                onClick={() => setForm(f => ({ ...f, category: 'GR', academicLevel: 'Graduate', courseCode: withHundreds(f.courseCode, gradHundreds(f.courseCode)) }))}
                style={{ flex: 1 }}>Graduate</Chip>
            </div>
          </div>

          {form.category === 'UG' && (
            <div className="sm-field">
              <label>Academic level</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['Freshman', 'Sophomore', 'Junior', 'Senior'].map(l => (
                  <Chip key={l} active={form.academicLevel === l}
                    onClick={() => setForm(f => ({ ...f, academicLevel: l, courseCode: withHundreds(f.courseCode, LEVEL_PREFIX[l]) }))}
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
            {/* NEW-FU-602 (Batch 28 item 3): a 0-credit course must be a Capstone. Auto-ticked
                when the level is Senior; this flags the non-Senior case and blocks Save. */}
            {creditCapstoneError && (
              <p className="sm-inline-error" role="alert"><span>{creditCapstoneError}</span></p>
            )}
          </div>

          {/* NEW-FU-578 (Batch 23): the "Number of sections · parallel sections per term"
              control was removed. It only WROTE courses.num_sections — it never created
              any sections — so setting N>1 produced zero sections while misleadingly
              implying the course had N parallel offerings. The conflict engine counts the
              REAL section rows (not this field), so the decoupled number had no effect on
              conflict detection beyond confusing the user. A new course is now created with
              num_sections = 1 (form default below); you add sections individually in the
              section panel, or use Suggest — which has its own per-course section-count
              input — to auto-place several at once. */}

          {/* Course flags — each on its own row with the description on the
              same line as the bold label. The scoped .acm-flag-row class
              has no parent CSS interference (we're in the modal overlay,
              not the sidebar's .sp-form scope). */}
          <div className="sm-field" style={{ borderTop: '1px solid var(--slate-200)', paddingTop: 12, marginTop: 4 }}>
            <label style={{ marginBottom: 6 }}>Course flags</label>

            {/* NEW-FU-600 (Batch 28): disabled + note for 0/1/2-credit (no lab allowed). */}
            <label className="acm-flag-row" style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0',
              cursor: (labAllowed && !labForced) ? 'pointer' : 'default',
              opacity: labAllowed ? 1 : 0.45,
            }}>
              <input type="checkbox" checked={form.hasLab} style={{ marginTop: 3, flex: '0 0 auto' }}
                disabled={!labAllowed || labForced}
                onChange={() => pickFlag('hasLab')} />
              <span style={{ fontSize: '.85rem', lineHeight: 1.4, flex: 1 }}>
                <strong>Has lab sections</strong>{' '}
                <span style={{ color: 'var(--slate-500)', fontWeight: 'normal' }}>
                  — has separate lecture and lab sections.
                </span>
                {labForced && (
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--slate-400)', fontStyle: 'italic', fontSize: '.8rem' }}>
                    Required for 4-credit courses.
                  </span>
                )}
                {!labAllowed && (
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--slate-400)', fontStyle: 'italic', fontSize: '.8rem' }}>
                    Only for 3- and 4-credit courses (4-credit requires a lab).
                  </span>
                )}
              </span>
            </label>

            {/* NEW-FU-484 (Phase 118 item 3): disabled + note when level is wrong. */}
            <label className="acm-flag-row" style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0',
              cursor: (capstoneAllowed && !capstoneForced) ? 'pointer' : 'default',
              opacity: capstoneAllowed ? 1 : 0.45,
            }}>
              <input type="checkbox" checked={form.isCapstone}
                style={{ marginTop: 3, flex: '0 0 auto' }}
                disabled={!capstoneAllowed || capstoneForced}
                onChange={() => pickFlag('isCapstone')} />
              <span style={{ fontSize: '.85rem', lineHeight: 1.4, flex: 1 }}>
                <strong>Capstone</strong>{' '}
                <span style={{ color: 'var(--slate-500)', fontWeight: 'normal' }}>
                  — graduation project; has a time slot but no room, so only instructor and student clashes are checked.
                </span>
                {capstoneForced && (
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--slate-400)', fontStyle: 'italic', fontSize: '.8rem' }}>
                    Required for 0-credit courses.
                  </span>
                )}
                {!capstoneAllowed && (
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--slate-400)', fontStyle: 'italic', fontSize: '.8rem' }}>
                    Only for Undergraduate → Senior courses.
                  </span>
                )}
              </span>
            </label>

            <label className="acm-flag-row" style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0',
              cursor: externalSelectable ? 'pointer' : 'default',
              opacity: externalSelectable ? 1 : 0.45,
            }}>
              <input type="checkbox" checked={form.isExternal}
                style={{ marginTop: 3, flex: '0 0 auto' }}
                disabled={!externalSelectable}
                onChange={() => pickFlag('isExternal')} />
              <span style={{ fontSize: '.85rem', lineHeight: 1.4, flex: 1 }}>
                <strong>External</strong>{' '}
                <span style={{ color: 'var(--slate-500)', fontWeight: 'normal' }}>
                  — off-campus course (e.g., internship); not scheduled on campus, so no conflict checks.
                </span>
                {!externalAllowed && (
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--slate-400)', fontStyle: 'italic', fontSize: '.8rem' }}>
                    Only for Undergraduate → Junior courses.
                  </span>
                )}
                {/* NEW-FU-595 (Batch 27): one external course per term. */}
                {externalAllowed && externalTaken && (
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--amber-500, #d97706)', fontStyle: 'italic', fontSize: '.8rem' }}>
                    This term already has an external course ({externalCourse.course_code ?? externalCourse.courseCode}). Only one internship / co-op course is allowed per term.
                  </span>
                )}
              </span>
            </label>
          </div>

          {error && <div className="sm-error">{error}</div>}

          <div className="sm-actions">
            <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="sm-btn-save" disabled={busy || formInvalid}
              title={formInvalid ? 'Enter a valid course code (SWE 101–699) and name first' : undefined}>
              {busy ? '…' : 'Add Course'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
