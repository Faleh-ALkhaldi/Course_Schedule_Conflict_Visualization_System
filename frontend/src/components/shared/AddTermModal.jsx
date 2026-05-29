import React, { useState, useMemo, useEffect } from 'react';
import * as api from '../../api';
import './TermPicker.css';

// NEW-FU-166: Add-term modal. Single text input with live decode preview.
// Term code regex must match server-side /^\d{2}[123]$/.
//
// Live preview shows the human-readable label + date span + seed behaviour
// (Fall/Spring copy from template; Summer starts blank).

const TERM_RE = /^\d{2}[123]$/;
// NEW-FU-218: mirror of backend assertTermCodeInRange (FU-217). Keep
// these in sync if the backend bounds change. Range chosen: 251 (Fall
// 2025) through 303 (Summer 2031) — covers a six-year planning horizon.
const CODE_MIN = 251;
const CODE_MAX = 303;

// NEW-FU-233: mirror of backend TERM_DATE_OVERRIDES (FU-223 + FU-228).
// Keep in sync when the backend adds entries — same {startMonth,
// startDay, endMonth, endDay} shape so decodePreview can use the
// override's actual dates instead of the SEASONS template guess.
const TERM_DATE_OVERRIDES = {
  '251': { startMonth: 8, startDay: 24, endMonth: 12, endDay: 29 }, // Fall 2025
  '252': { startMonth: 1, startDay: 11, endMonth: 5,  endDay: 21 }, // Spring 2026
  '253': { startMonth: 6, startDay: 14, endMonth: 8,  endDay:  9 }, // Summer 2026
  '261': { startMonth: 8, startDay: 19, endMonth: 12, endDay: 26 }, // Fall 2026
  '262': { startMonth: 1, startDay: 10, endMonth: 6,  endDay:  8 }, // Spring 2027
  '263': { startMonth: 6, startDay: 20, endMonth: 8,  endDay: 15 }, // Summer 2027
};
function hasOverride(code) {
  return Object.prototype.hasOwnProperty.call(TERM_DATE_OVERRIDES, code);
}

// Template-derived placeholder dates used to prefill the date inputs
// when the admin hasn't provided anything yet. Same template the
// backend SEASONS object uses — values mirror term.js.
const TEMPLATE_BY_SEASON = {
  '1': { startMonth: 8, startDay: 25, endMonth: 12, endDay: 28, yearOffset: 0 },
  '2': { startMonth: 1, startDay: 12, endMonth:  5, endDay: 25, yearOffset: 1 },
  '3': { startMonth: 6, startDay: 14, endMonth:  8, endDay:  6, yearOffset: 1 },
};
const pad = n => String(n).padStart(2, '0');
function templateDates(code) {
  if (!TERM_RE.test(code)) return { start: '', end: '' };
  const yy = parseInt(code.slice(0, 2), 10);
  const t  = code[2];
  const s  = TEMPLATE_BY_SEASON[t];
  const calYear = 2000 + yy + s.yearOffset;
  return {
    start: `${calYear}-${pad(s.startMonth)}-${pad(s.startDay)}`,
    end:   `${calYear}-${pad(s.endMonth)}-${pad(s.endDay)}`,
  };
}

// Month abbreviations for the preview span. Index matches calendar
// month (1 = Jan).
const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function decodePreview(code) {
  if (!TERM_RE.test(code)) return null;
  const yy = parseInt(code.slice(0, 2), 10);
  const t  = code[2];
  const ayStart = 2000 + yy;
  // Template fallback values — used when no override exists. Same
  // numbers the backend SEASONS object carries.
  const seasonTpl = {
    '1': { name: 'Fall',   yearOffset: 0, startMonth: 8, startDay: 25, endMonth: 12, endDay: 28 },
    '2': { name: 'Spring', yearOffset: 1, startMonth: 1, startDay: 12, endMonth: 5,  endDay: 25 },
    '3': { name: 'Summer', yearOffset: 1, startMonth: 6, startDay: 14, endMonth: 8,  endDay:  6 },
  };
  const s = seasonTpl[t];
  const year = ayStart + s.yearOffset;
  // NEW-FU-239: when there's an override, the preview should mirror
  // the backend's authoritative dates. Without this the modal showed
  // template guesses for codes with published overrides — confusing.
  const dates = TERM_DATE_OVERRIDES[code] || {
    startMonth: s.startMonth, startDay: s.startDay,
    endMonth:   s.endMonth,   endDay:   s.endDay,
  };
  const startStr = `${MONTH_ABBR[dates.startMonth]} ${dates.startDay}`;
  const endStr   = `${MONTH_ABBR[dates.endMonth]} ${dates.endDay}`;
  return {
    label:   `${s.name} ${year}`,
    span:    `${startStr}, ${year} – ${endStr}, ${year}`,
    season:  s.name,
    isSummer: t === '3',
  };
}

// NEW-FU-233: lightweight client-side window validator. Mirrors the
// backend's validateTermDateWindow but operates on the already-parsed
// ISO date strings. Real source of truth remains the backend; this
// just keeps the user from submitting an obvious mismatch.
function validateDateWindow(code, startISO, endISO) {
  if (!startISO || !endISO) return 'Both start and end dates are required.';
  if (startISO >= endISO)   return 'Start date must be before end date.';
  const t = code[2];
  // Acceptable month bands per season — generous on the high end so
  // KFUPM's year-to-year drift doesn't trip the validator.
  const bands = {
    '1': { startMonths: [8, 9],     endMonths: [12, 1] },  // Fall: Aug–Sep / Dec–Jan
    '2': { startMonths: [1, 2],     endMonths: [5, 6]  },  // Spring: Jan–Feb / May–Jun
    '3': { startMonths: [6, 7],     endMonths: [8, 9]  },  // Summer: Jun–Jul / Aug–Sep
  }[t];
  if (!bands) return null;
  const startMonth = parseInt(startISO.slice(5, 7), 10);
  const endMonth   = parseInt(endISO.slice(5, 7),   10);
  if (!bands.startMonths.includes(startMonth)) {
    return `Start month doesn't match this term's season (expected ${bands.startMonths.join(' or ')}).`;
  }
  if (!bands.endMonths.includes(endMonth)) {
    return `End month doesn't match this term's season (expected ${bands.endMonths.join(' or ')}).`;
  }
  return null;
}

export function AddTermModal({ existingCodes, onClose, onCreated }) {
  const [code, setCode]     = useState('');
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState(null);
  // NEW-FU-233: admin-supplied start/end when the code has no override.
  const [startsAt, setStartsAt] = useState('');
  const [endsAt,   setEndsAt]   = useState('');

  const preview = useMemo(() => decodePreview(code), [code]);
  const duplicate = code && existingCodes.includes(code);
  const validShape = TERM_RE.test(code);
  // NEW-FU-218: range check. Only meaningful after the shape passes —
  // an invalid shape already trips its own warning above this one.
  const codeNum = validShape ? parseInt(code, 10) : null;
  const outOfRange = validShape && (codeNum < CODE_MIN || codeNum > CODE_MAX);
  // NEW-FU-233: when the code has no published override, we MUST collect
  // dates from the admin. The user still sees the template's guess as
  // the prefill so they have a starting point — they just confirm or edit.
  const needsDates = validShape && !outOfRange && !hasOverride(code);
  const dateError = needsDates ? validateDateWindow(code, startsAt, endsAt) : null;
  const canCreate = validShape && !duplicate && !outOfRange && !busy
    && (!needsDates || (startsAt && endsAt && !dateError));

  // Prefill date inputs whenever the code becomes valid + un-overridden.
  // Switching to a code that DOES have an override clears them so we
  // don't accidentally submit stale values from a prior code.
  useEffect(() => {
    if (!validShape) { setStartsAt(''); setEndsAt(''); return; }
    if (!needsDates) { setStartsAt(''); setEndsAt(''); return; }
    const tpl = templateDates(code);
    setStartsAt(prev => prev || tpl.start);
    setEndsAt  (prev => prev || tpl.end);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      // NEW-FU-233: pass dates only when we actually collected them.
      // The backend ignores them when the code has an override anyway,
      // but staying explicit keeps the wire payload predictable.
      const payload = needsDates ? { startsAt, endsAt } : {};
      const created = await api.createTerm(code, payload);
      onCreated(created);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create term.');
      setBusy(false);
    }
  }

  return (
    <div className="tp-modal-overlay" onClick={onClose}>
      <div className="tp-modal" onClick={e => e.stopPropagation()}>
        <h2 className="tp-modal-title">Add new academic term</h2>
        <form onSubmit={handleCreate}>
          <label className="tp-modal-label">
            Term code (YYT)
            <input
              type="text"
              className="tp-modal-input"
              value={code}
              onChange={e => setCode(e.target.value.trim().slice(0, 3))}
              placeholder="e.g. 262"
              autoFocus
              maxLength={3}
              inputMode="numeric"
            />
            <span className="tp-modal-hint">
              YY = academic year start (25 = 2025-26), T = 1 Fall · 2 Spring · 3 Summer.
              Allowed range: <code>{CODE_MIN}</code>–<code>{CODE_MAX}</code> (Fall 2025–Summer 2031).
            </span>
          </label>

          {code && !validShape && (
            <div className="tp-preview tp-preview-warn">
              Invalid format. Use 3 digits like <code>251</code>, <code>252</code>, <code>263</code>.
            </div>
          )}

          {/* NEW-FU-218: out-of-range warning — surfaces the same constraint
              the backend will reject with 400. Disables the Create button
              via canCreate so the user gets immediate feedback. */}
          {validShape && outOfRange && (
            <div className="tp-preview tp-preview-warn">
              Term <code>{code}</code> is outside the allowed range <code>{CODE_MIN}</code>–<code>{CODE_MAX}</code>.
              Terms before Fall 2025 or after Summer 2031 can't be created.
            </div>
          )}

          {validShape && !outOfRange && duplicate && (
            <div className="tp-preview tp-preview-warn">
              Term <code>{code}</code> already exists.
            </div>
          )}

          {preview && !duplicate && !outOfRange && (
            <div className="tp-preview">
              <div className="tp-preview-row">
                <strong>{preview.label}</strong>
                {/* NEW-FU-233: when dates come from the override map,
                    show the official span inline. When they don't, the
                    admin will be supplying them below, so we suppress
                    the redundant template guess here. */}
                {!needsDates && <span>{preview.span}</span>}
              </div>
              <div className="tp-preview-row tp-preview-seed">
                {/* NEW-FU-234: terms seed from the NEAREST existing
                    term in the SAME season family (Fall ← Fall,
                    Spring ← Spring, Summer ← Summer). Summer no
                    longer starts blank by default. */}
                📋 Will copy from the nearest existing {preview.season} term
                (or start blank if no {preview.season} term exists yet).
              </div>
            </div>
          )}

          {/* NEW-FU-233: date inputs when no override exists. KFUPM
              publishes calendars ~1 year ahead, so codes 271+ require
              the admin to enter the dates manually. Prefilled with the
              template's guess so the typical "yes that looks right"
              case stays one click. */}
          {needsDates && (
            <div className="tp-modal-dates">
              <label className="tp-modal-label">
                Term start date
                <input
                  type="date"
                  className="tp-modal-input"
                  value={startsAt}
                  onChange={e => setStartsAt(e.target.value)}
                  required
                />
              </label>
              <label className="tp-modal-label">
                Term end date
                <input
                  type="date"
                  className="tp-modal-input"
                  value={endsAt}
                  onChange={e => setEndsAt(e.target.value)}
                  required
                />
              </label>
              <p className="tp-modal-hint">
                No published KFUPM calendar yet for <code>{code}</code>. Enter the
                dates from the registrar's site (or your best estimate).
              </p>
              {dateError && (
                <div className="tp-preview tp-preview-warn">{dateError}</div>
              )}
            </div>
          )}

          {error && <div className="tp-error">{error}</div>}

          <div className="tp-modal-actions">
            <button type="button" className="tp-btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="tp-btn-primary" disabled={!canCreate}>
              {busy ? 'Creating…' : 'Create term'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
