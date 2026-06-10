// NEW-FU-281 (Phase 56): Add Venue as a proper modal, with the strict
// KFUPM naming convention enforced through three structured fields
// rather than a single free-form `name` <input>.
//
// Why the structured fields:
//   The Phase 55 inline form let the user type *any* string in the
//   name box ("H-201", "lab #4", "kfupm-eb-218"…). Half the seed data
//   actually uses the registrar convention `XX-YYY[-Z]` / `XX-YYYY`
//   (e.g. `24-101`, `24-101-A`, `14-1024`), but new rows could drift.
//   By splitting the input into Building / Room / (optional) Section,
//   we make the convention the path of least resistance — the user
//   types `24` and `101`, the modal renders `24-101`, and only a value
//   that fits the regex can be submitted.
//
// Naming convention (Phase 56 prompt, extended in Phase 57):
//   • `XX-YYY`        — 2-digit building, 3-digit room
//   • `XX-YYY-Z`      — same, plus a single-character section suffix.
//                       Z is A–Z OR 0–9 (real KFUPM rooms include both
//                       letter-divided rooms like `24-101-A` and number-
//                       divided rooms like `24-231-1`).
//   • `XX-YYYY`       — 2-digit building, 4-digit room (some buildings
//                       like 76 have 4-digit room numbers — see catalog).
//
// Validation rules:
//   • building: exactly 2 digits, 01..99 (00 is reserved).
//   • room:     3 or 4 digits — leading zeros allowed for 3-digit form
//               (e.g. 003 — small offices/sub-rooms in old wings).
//   • section:  single alphanumeric character (A-Z or 0-9), optional,
//               ONLY allowed with the 3-digit room form (XX-YYYY-Z is
//               not in the convention).
//
// Cross-field rule encoded in `canSubmit`: a section suffix combined
// with a 4-digit room is rejected — the live preview shows the broken
// pattern but the Save button stays disabled and the inline-error
// explains the mismatch.
//
// NEW-FU-286 (Phase 57): the section suffix is a single-character
// `<input>` rather than a `<select>`. Two reasons:
//   1. The dropdown options have to be A-Z ∪ 0-9 = 36 entries, too
//      many for a single column without cramming.
//   2. Safari renders the native `<select>` menu pane with the OS
//      dark theme on macOS; `appearance: none` only affects the
//      closed trigger button, not the expanded menu. Replacing with
//      an input sidesteps the platform-styling rabbit hole entirely.

import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
import './SectionModal.css';

// True iff `s` is the string for an integer in [lo, hi].
// Leading zeros allowed (we want '003' to pass, not just '3').
function isIntStringInRange(s, lo, hi) {
  if (!/^\d+$/.test(s)) return false;
  const n = parseInt(s, 10);
  return Number.isInteger(n) && n >= lo && n <= hi;
}

// Compute the canonical normalized name and a validation verdict.
// Pure function — exported for unit tests if we ever add them.
//
// Returns { name, valid, reason }:
//   name   — preview string, e.g. "24-101-A" or "24-1024".
//            Always populated so the preview line has something to
//            show even mid-typing; `valid` is the gate for submit.
//   valid  — true iff the combination matches one of the three forms.
//   reason — when !valid, a human sentence for the inline error.
export function buildVenueName({ building, room, section }) {
  const bldg = (building || '').trim();
  const rm   = (room     || '').trim();
  const sec  = (section  || '').trim().toUpperCase();

  // Always render a preview, even if incomplete — gives the user a
  // visual hint of what they're constructing as they type.
  let preview = bldg;
  if (rm)  preview += `-${rm}`;
  if (sec) preview += `-${sec}`;

  if (!bldg)                                  return { name: preview, valid: false, reason: 'Building is required.' };
  if (!isIntStringInRange(bldg, 1, 99) || bldg.length !== 2)
                                              return { name: preview, valid: false, reason: 'Building must be 2 digits (01–99).' };

  if (!rm)                                    return { name: preview, valid: false, reason: 'Room is required.' };
  if (!/^\d{3,4}$/.test(rm))                  return { name: preview, valid: false, reason: 'Room must be 3 or 4 digits.' };
  if (!isIntStringInRange(rm, 1, 9999))       return { name: preview, valid: false, reason: 'Room must be at least 1.' };

  // Section suffix is only valid with 3-digit rooms — the registrar
  // convention reserves the 4-digit form for unique rooms with no
  // sub-divisions.
  //
  // NEW-FU-286 (Phase 57): suffix is one alphanumeric char (A–Z OR 0–9),
  // not just A–Z. Letter-divided sub-rooms (`24-101-A`) and number-
  // divided sub-rooms (`24-231-1`) both appear in the registrar data.
  if (sec) {
    if (!/^[A-Z1-9]$/.test(sec))              return { name: preview, valid: false, reason: 'Sub-room suffix must be a single character A–Z or 1–9 (0 is not a valid sub-room).' };
    if (rm.length !== 3)                      return { name: preview, valid: false, reason: 'Section suffix is only allowed with 3-digit rooms (XX-YYY-Z).' };
  }

  return { name: preview, valid: true, reason: '' };
}

// NEW-FU-483 (Phase 117): parse a venue name into canonical integer parts.
// Leading-zero padding on building and room is irrelevant ("002" ≡ "2" ≡ "0002").
// Suffix "0" is NOT a valid sub-room suffix (blocked at input time in Phase 114),
// so no special treatment needed here.
function parseVenueParts(name) {
  const parts = String(name || '').trim().split('-');
  const bldg   = parseInt(parts[0], 10);
  const room   = parseInt(parts[1], 10);
  const suffix = (parts[2] || '').toUpperCase();
  return { bldg, room, suffix };
}

// NEW-FU-483 (Phase 117): whole-room vs sub-room identity rule. A room may exist as
// the whole room (no suffix) OR as one-or-more named sub-rooms (with suffixes) — never
// both. Format variants ("01-002" vs "01-0002") still count as the same building+room.
//
// Rules for any given building+room:
//   • Adding a whole room (no suffix):
//       – blocked if a whole room entry already exists (any format)
//       – blocked if sub-room entries already exist
//   • Adding a sub-room (has suffix):
//       – blocked if the whole room already exists
//       – blocked if the same suffix already exists
//       – allowed when only other suffixes exist (e.g. adding -2 when -1 already exists)
//   • Nothing yet for that building+room → allow anything
//
// existingVenues may be an array of venue objects (with .name) or bare name strings.
// Returns a plain-English error message, or null when the add is allowed.
export function venueConflictError(newName, existingVenues) {
  const { bldg: nb, room: nr, suffix: ns } = parseVenueParts(newName);
  if (isNaN(nb) || isNaN(nr)) return null; // malformed — let the name validator catch it

  const sameRoom = (existingVenues || []).filter(v => {
    const { bldg, room } = parseVenueParts(v.name ?? v);
    return bldg === nb && room === nr;
  });

  if (sameRoom.length === 0) return null; // nothing registered yet — allow

  if (!ns) {
    // Attempting to add the whole room (no suffix)
    const hasWhole = sameRoom.some(v => !parseVenueParts(v.name ?? v).suffix);
    if (hasWhole) return 'This room is already registered. Pick a different room number.';
    return 'Sub-rooms of this room already exist. The whole room cannot be added alongside its sub-rooms — choose a different room or add another sub-room suffix.';
  } else {
    // Attempting to add a sub-room (has suffix)
    const wholeExists = sameRoom.some(v => !parseVenueParts(v.name ?? v).suffix);
    if (wholeExists)
      return 'The whole room is already registered. Sub-rooms cannot be added once the whole room exists — remove it first, or pick a different room number.';
    const sameSuffix = sameRoom.some(v => parseVenueParts(v.name ?? v).suffix === ns);
    if (sameSuffix)
      return 'A sub-room with this suffix already exists. Choose a different suffix.';
    return null; // different suffix, no whole room — allowed
  }
}

// `onCreated` (optional): if provided, the new venue object is passed
// to it after a successful POST. Used by SectionModal's "+ New"
// shortcut so the form can auto-select the freshly-created venue.
// SidePanel doesn't pass it — the new entry just appears in the
// sidebar list via the ADD_VENUE reducer action.
export default function AddVenueModal({ onClose, showToast, onCreated }) {
  const { addVenue, venues } = useApp();

  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // NEW-FU-483 (Phase 117): fetch ALL venues (no term filter) once on mount so the
  // duplicate check below can see venues that have zero section references in the
  // current term. The context `venues` list only contains venues that are actively
  // used (VenueRepository.findAll(termCode) JOINs sections), so unreferenced venues
  // like 01-002 are invisible to it — but they must still block conflicting adds.
  // We fall back to the context list if the fetch fails (backend is always the
  // authoritative guard anyway, so a stale client-side check is just UX polish).
  const [allVenues, setAllVenues] = useState([]);
  useEffect(() => {
    api.getVenues()                          // no term → all non-dummy venues
      .then(data => setAllVenues(Array.isArray(data) ? data : []))
      .catch(() => setAllVenues([]));        // silently fall back to context list
  }, []);                                    // run once on modal open

  const [building, setBuilding] = useState('');
  const [room,     setRoom]     = useState('');
  const [section,  setSection]  = useState('');     // '' or 'A'..'J'
  const [type,     setType]     = useState('LectureHall');
  const [capacity, setCapacity] = useState('60');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');

  const verdict = useMemo(() => buildVenueName({ building, room, section }),
    [building, room, section]);

  // NEW-FU-483 (Phase 117): whole-room vs sub-room rule replaces the old canonical-key check.
  // venueConflictError() handles format variants, whole-room blocking, sub-room coexistence.
  //
  // Use allVenues (the full DB list fetched on mount) so unreferenced venues — those with
  // zero section refs in the current term — are visible to the check. Fall back to the
  // term-scoped context list if allVenues hasn't loaded yet (empty array = no items
  // returned from the fetch yet); this only delays the error by one render cycle but the
  // backend will catch it on submit regardless.
  const dupVenueError = useMemo(() => {
    if (!verdict.valid) return null;
    const checkList = allVenues.length > 0 ? allVenues : (venues || []);
    return venueConflictError(verdict.name, checkList);
  }, [verdict, venues, allVenues]);

  const capacityNum = parseInt(capacity, 10);
  // NEW-FU-225 (Phase 97): cap lowered 10000 → 250. 10,000 seats is absurd for
  // a KFUPM classroom; 250 comfortably covers the largest real KFUPM lecture
  // hall / auditorium while rejecting nonsense entries. Mirrored in the backend
  // venue validators (controllers/index.js create + update).
  const capacityValid = Number.isInteger(capacityNum) && capacityNum >= 1 && capacityNum <= 250;

  const canSubmit = verdict.valid && capacityValid && !dupVenueError && !busy;

  // Chip-pill helper, same visual contract as AddCourseModal.
  function Chip({ active, onClick, children, style, disabled }) {
    return (
      <button type="button"
        className={`sm-daymode-btn ${active ? 'active' : ''}`}
        style={style} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setError('');
    try {
      const venue = await addVenue({
        name: verdict.name,
        type,
        capacity: capacityNum,
      });
      // NEW-FU-434 (Phase 106 item 6): note when this real venue auto-replaced a placeholder.
      showToast(
        venue.replacedDummy
          ? `✓ Venue ${venue.name} added — replaced placeholder ${venue.replacedDummy.name}.`
          : `✓ Venue ${venue.name} added.`,
        'success');
      if (onCreated) onCreated(venue);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to add venue.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sm-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sm-card" style={{ maxWidth: 520 }}>
        <div className="sm-header">
          <h2 className="sm-title">+ Add Venue</h2>
          <button className="sm-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form className="sm-form" onSubmit={handleSubmit}>

          {/* ── Structured name (Building / Room / Section) ───────────── */}
          <div className="sm-field">
            <label>
              Venue name
              <span className="sm-optional"> &nbsp;format: XX-YYY, XX-YYY-Z, or XX-YYYY</span>
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 90px', gap: 8 }}>
              <input placeholder="24" inputMode="numeric" maxLength={2}
                value={building}
                onChange={e => setBuilding(e.target.value.replace(/\D/g, '').slice(0,2))}
                aria-label="Building" />
              <input placeholder="101" inputMode="numeric" maxLength={4}
                value={room}
                onChange={e => setRoom(e.target.value.replace(/\D/g, '').slice(0,4))}
                aria-label="Room" />
              {/* NEW-FU-286 (Phase 57): one-char alphanumeric input for the
                  section suffix. Replaces the previous A–J <select>, which
                  Safari rendered with a dark native menu pane and didn't
                  offer digit suffixes (e.g. 24-231-1). The onChange filter
                  keeps the field locked to a single uppercase A–Z or 0–9
                  character — illegal input is silently dropped, matching
                  the Building/Room filter pattern. */}
              <input placeholder="A or 1" maxLength={1}
                value={section}
                onChange={e => setSection(
                  e.target.value.toUpperCase().replace(/[^A-Z1-9]/g, '').slice(0,1)
                )}
                aria-label="Section suffix (optional)" />
            </div>
            <div className="sm-end-preview" style={{ marginTop: 6 }}>
              Will save as <strong>{verdict.name || '—'}</strong>
            </div>
            {!verdict.valid && (building || room || section) && (
              <div className="sm-group-badge" style={{ color: 'var(--red-500, #dc2626)' }}>
                {verdict.reason}
              </div>
            )}
            {verdict.valid && dupVenueError && (
              <div className="sm-group-badge" style={{ color: 'var(--red-500, #dc2626)' }}>
                {dupVenueError}
              </div>
            )}
          </div>

          {/* ── Venue type ─────────────────────────────────────────────── */}
          {/* NEW-FU-287 (Phase 57): Multipurpose chip added. Migration 015
              allows 'Multipurpose' at the DB CHECK level, and R-11/R-12
              already treat it as a wildcard (Lec OK in Multipurpose, Lab
              OK in Multipurpose). Surfacing it here closes the loop so
              admins can actually create rooms of this type — previously
              the chip row only offered the two ends of the spectrum,
              forcing every shared room into a misleading label. */}
          <div className="sm-field">
            <label>Type</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <Chip active={type === 'LectureHall'}
                onClick={() => setType('LectureHall')}
                style={{ flex: 1 }}>Lecture Hall</Chip>
              <Chip active={type === 'Laboratory'}
                onClick={() => setType('Laboratory')}
                style={{ flex: 1 }}>Laboratory</Chip>
              <Chip active={type === 'Multipurpose'}
                onClick={() => setType('Multipurpose')}
                style={{ flex: 1 }}>Multipurpose</Chip>
            </div>
          </div>

          {/* ── Capacity ───────────────────────────────────────────────── */}
          <div className="sm-field">
            <label htmlFor="avm-capacity">
              Capacity
              <span className="sm-optional"> &nbsp;1–250 seats</span>
            </label>
            <input id="avm-capacity" type="number" min="1" max="250"
              value={capacity}
              onChange={e => setCapacity(e.target.value)} />
            {!capacityValid && capacity !== '' && (
              <div className="sm-group-badge" style={{ color: 'var(--red-500, #dc2626)' }}>
                Capacity must be an integer between 1 and 250.
              </div>
            )}
          </div>
          {/* NEW-FU-226 (Phase 97): the "Use the same building / room numbers as
              the KFUPM Registrar" note was removed — redundant with the format
              hint at the top of the form ("format: XX-YYY, XX-YYY-Z, or XX-YYYY"). */}

          {error && <div className="sm-error">{error}</div>}

          <div className="sm-actions">
            <button type="button" className="sm-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="sm-btn-save" disabled={!canSubmit}>
              {busy ? '…' : 'Add Venue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
