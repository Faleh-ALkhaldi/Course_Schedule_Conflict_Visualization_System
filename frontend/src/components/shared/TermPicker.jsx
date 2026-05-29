import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as api from '../../api';
import { AddTermModal } from './AddTermModal.jsx';
import { DeleteTermModal } from './DeleteTermModal.jsx';
import { RenameTermModal } from './RenameTermModal.jsx';
import './TermPicker.css';

// NEW-FU-165: clickable Term chip in the top toolbar. Replaces the
// static SEMESTER_DISPLAY map with a live dropdown that:
//   • lists every term in the DB with course/section/instructor/venue stats
//   • lets admins create + delete terms (with two-stage confirmation)
//   • switches the active schedule on click of any term row
//
// Active-term storage: URL query param `?term=252`. URL is the single
// source of truth — bookmarkable, history-aware, survives reload. Falls
// back to the first term in the list if no query param is present.

const fmtSpan = (startsAt, endsAt) => {
  if (!startsAt || !endsAt) return '';
  const fmt = iso => {
    const [y, m, d] = iso.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[m - 1]} ${d}, ${y}`;
  };
  return `${fmt(startsAt)} – ${fmt(endsAt)}`;
};

export function TermPicker({ activeCode, isAdmin, onSwitchTerm, liveHardCount, liveSoftCount }) {
  const [open, setOpen]       = useState(false);
  const [terms, setTerms]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [delTarget, setDelTarget] = useState(null);   // term object or null
  const [renameTarget, setRenameTarget] = useState(null); // term object or null
  const [error, setError]     = useState(null);
  // NEW-FU-188: filter input. Empty string = no filter. Matches code
  // (substring, case-insensitive) OR label (substring, case-insensitive).
  const [filter, setFilter]   = useState('');
  // NEW-FU-194: when ON, request includes archived terms; when OFF, the
  // server omits them and the query rides the partial index
  // idx_schedules_active. Defaults OFF so the hot path stays cheap.
  const [showArchived, setShowArchived] = useState(false);
  const filterRef             = useRef(null);
  const popRef                = useRef(null);
  const btnRef                = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listTerms(activeCode, showArchived);
      setTerms(list);
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load terms.');
    } finally {
      setLoading(false);
    }
  }, [activeCode, showArchived]);

  // NEW-FU-190: prime the terms list on mount AND whenever the active
  // term changes — the chip's conflict badge needs activeTerm.hard/soft
  // counts even before the user opens the dropdown. Also refresh on
  // every open so newly-saved conflict counts surface immediately.
  useEffect(() => { refresh(); }, [activeCode, refresh]);
  useEffect(() => {
    if (open) {
      refresh();
      // NEW-FU-188: focus the filter input shortly after the dropdown
      // renders so Cmd+K → type-to-search is a single mental step.
      setTimeout(() => filterRef.current?.focus(), 20);
    } else {
      setFilter(''); // reset filter when closed
    }
  }, [open, refresh]);

  // NEW-FU-188: filtered view. Matches code (substring, case-insensitive)
  // OR label (substring, case-insensitive). Sorted same as upstream.
  const filteredTerms = useMemo(() => {
    if (!filter) return terms;
    const q = filter.toLowerCase();
    return terms.filter(t =>
      t.code.toLowerCase().includes(q) ||
      (t.label || '').toLowerCase().includes(q) ||
      (t.season || '').toLowerCase().includes(q)
    );
  }, [terms, filter]);

  // Close on outside click + Esc.
  useEffect(() => {
    if (!open) return;
    const onDocClick = e => {
      if (!popRef.current || popRef.current.contains(e.target)) return;
      if (btnRef.current && btnRef.current.contains(e.target))   return;
      setOpen(false);
    };
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown',   onKey);
    };
  }, [open]);

  // NEW-FU-186: global Cmd+K (macOS) / Ctrl+K shortcut to toggle the
  // picker without reaching for the mouse. Matches Slack / Linear /
  // Notion conventions. preventDefault stops the browser's default
  // address-bar focus / Quick Find from firing.
  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Display label for the chip itself: prefer the active term's friendly
  // label (e.g. "Spring 2026"); fall back to the raw code.
  const activeTerm = terms.find(t => t.isActive) || terms.find(t => t.code === activeCode);
  const chipLabel  = activeTerm?.label || activeCode || '—';

  // NEW-FU-314 (Phase 29): prefer the LIVE conflict counts passed from
  // the parent (derived from the conflicts array, which updates on every
  // mutation). Falls back to the stale terms[] snapshot when the parent
  // doesn't pass them (e.g., the dropdown row for non-active terms still
  // shows their last-evaluated count from the API). Active-term badge:
  // always uses live counts — that's the surface the user is editing.
  const chipHardCount = (typeof liveHardCount === 'number')
    ? liveHardCount
    : (activeTerm?.hardConflictCount ?? 0);
  const chipSoftCount = (typeof liveSoftCount === 'number')
    ? liveSoftCount
    : (activeTerm?.softConflictCount ?? 0);

  function handlePick(t) {
    if (t.code === activeCode) {
      setOpen(false);
      return;
    }
    onSwitchTerm(t);
    setOpen(false);
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`tp-chip ${open ? 'open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        title={
          // NEW-FU-190 / FU-314: tooltip uses LIVE counts (Phase 29) so
          // it stays in sync with current mutations, not the stale
          // terms[] snapshot from the last list-fetch.
          (chipHardCount > 0 || chipSoftCount > 0)
            ? `Switch academic term (Cmd+K) · ${chipHardCount} hard, ${chipSoftCount} soft conflict${chipSoftCount === 1 ? '' : 's'}`
            : 'Switch academic term (Cmd+K)'
        }
      >
        {/* NEW-FU-215: friendly label leads; code demoted to a small
            monospace tag. When the activeCode has no friendly mapping
            yet (race / new code), fall back to showing the code itself
            as the primary label so the chip never looks empty. */}
        <span className="tp-chip-label">{chipLabel !== activeCode ? chipLabel : `Term ${activeCode}`}</span>
        {chipLabel !== activeCode && (
          <span className="tp-chip-code">{activeCode}</span>
        )}
        {/* NEW-FU-190: conflict badge on the chip. Red dot + count when
            the ACTIVE term has hard conflicts; amber when only soft;
            hidden when neither. Helps users notice problems on the term
            they're actually working on, not just sibling terms in the
            dropdown. */}
        {/* NEW-FU-314 (Phase 29): badges use live counts (chipHardCount /
            chipSoftCount) so they update immediately when the user
            resolves or creates conflicts — no dropdown-reopen or page-
            refresh needed. */}
        {chipHardCount > 0 && (
          <span className="tp-chip-badge tp-chip-badge-hard">{chipHardCount}</span>
        )}
        {chipHardCount === 0 && chipSoftCount > 0 && (
          <span className="tp-chip-badge tp-chip-badge-soft">{chipSoftCount}</span>
        )}
        <span className="tp-chip-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div ref={popRef} className="tp-popover" role="listbox" aria-label="Academic terms">
          <div className="tp-popover-head">
            <span className="tp-popover-title">Academic terms</span>
            {loading && <span className="tp-popover-loading">Loading…</span>}
          </div>

          {/* NEW-FU-188: type-to-search. Auto-focused on open so Cmd+K
              then typing flows naturally. Esc clears filter first; if
              already empty, Esc bubbles up to close the picker. */}
          <div className="tp-filter-wrap">
            <input
              ref={filterRef}
              type="text"
              className="tp-filter-input"
              placeholder="Search by code or label (e.g. 252, Spring, Summer)"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape' && filter) {
                  e.preventDefault();
                  e.stopPropagation();
                  setFilter('');
                }
              }}
            />
            {filter && (
              <span className="tp-filter-count">
                {filteredTerms.length} of {terms.length}
              </span>
            )}
          </div>

          {error && <div className="tp-error">{error}</div>}

          <ul className="tp-list">
            {filteredTerms.length === 0 && !loading && (
              <li className="tp-empty">
                {terms.length === 0 ? 'No terms yet. Add one to get started.'
                                    : `No terms match "${filter}".`}
              </li>
            )}
            {filteredTerms.map(t => (
              <li
                key={t.code}
                className={`tp-row ${t.isActive ? 'active' : ''} ${t.isArchived ? 'archived' : ''}`}
                role="option"
                aria-selected={t.isActive}
                tabIndex={0}
                /* NEW-FU-178: hover tooltip surfaces status + (when
                   archived) the archived timestamp. NEW-FU-222 dropped
                   the original "Created" segment — the row already
                   shows the term's calendar dates inline, and the
                   creation timestamp was admin-internal noise that
                   competed with the load-bearing fields. */
                title={
                  `Status: ${t.status}` +
                  (t.isArchived && t.archivedAt ? ` · Archived: ${new Date(t.archivedAt).toLocaleDateString()}` : '')
                }
                onClick={() => handlePick(t)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePick(t); } }}
              >
                {/* NEW-FU-216: two-line layout that ends the truncation
                    bug (".tp-row-label" got squeezed to "S..." by sibling
                    grid columns). Line 1 leads with the friendly label
                    so the reader's first scan answers "which term";
                    line 2 holds date + stats + conflict badges. Actions
                    sit on the right, full row height. */}
                <span className="tp-row-check" aria-hidden="true">{t.isActive ? '✓' : ''}</span>
                <div className="tp-row-main">
                  <div className="tp-row-line-title">
                    <span className="tp-row-label">{t.label || `Term ${t.code}`}</span>
                    <span className="tp-row-code-chip" aria-label={`Code ${t.code}`}>{t.code}</span>
                    {/* NEW-FU-194: archived pill takes precedence over status. */}
                    {t.isArchived && (
                      <span className="tp-status-pill tp-status-archived" title={`Archived${t.archivedAt ? ` on ${new Date(t.archivedAt).toLocaleDateString()}` : ''}`}>
                        📦 Archived
                      </span>
                    )}
                    {!t.isArchived && (
                      <span className={`tp-status-pill tp-status-${(t.status||'Draft').toLowerCase()}`} title={`Status: ${t.status||'Draft'}`}>
                        {t.status === 'Finalized' ? '🔒' : ''}{(t.status||'Draft').replace(/([A-Z])/g, ' $1').trim()}
                      </span>
                    )}
                  </div>
                  {/* NEW-FU-226: split into two lines so each "group of
                      info or utility" gets its own row. Line 2 = date
                      span alone; line 3 = conflict pills + stats icons.
                      Previously these shared one .tp-row-line-meta line
                      with only `gap` between them — visually cramped at
                      narrow widths. */}
                  <div className="tp-row-line-date">
                    <span className="tp-row-span">{fmtSpan(t.startsAt, t.endsAt)}</span>
                  </div>
                  <div className="tp-row-line-stats">
                    <span className="tp-row-stats" aria-label="term stats">
                      {/* NEW-FU-184: conflict-count badges — only visible when
                          non-zero so admins spot problematic terms at a
                          glance without cluttering happy-path rows. */}
                      {t.hardConflictCount > 0 && (
                        <span className="tp-conflict-pill tp-conflict-hard" title={`${t.hardConflictCount} hard conflict${t.hardConflictCount === 1 ? '' : 's'}`}>
                          🔴 {t.hardConflictCount}
                        </span>
                      )}
                      {t.softConflictCount > 0 && (
                        <span className="tp-conflict-pill tp-conflict-soft" title={`${t.softConflictCount} soft conflict${t.softConflictCount === 1 ? '' : 's'}`}>
                          🟡 {t.softConflictCount}
                        </span>
                      )}
                      <span title="Courses">📚 {t.courseCount}</span>
                      <span title="Sections">📋 {t.sectionCount}</span>
                      <span title="Instructors">👤 {t.instructorCount}</span>
                      <span title="Venues">🏛 {t.venueCount}</span>
                    </span>
                  </div>
                </div>
                {isAdmin && !t.isActive && !t.isArchived && (
                  <div className="tp-row-actions">
                    {/* NEW-FU-189: lock / unlock. Toggles Draft ↔ Finalized.
                        Backend refuses Draft → Finalized when hard conflicts
                        exist (we surface that as an inline error). */}
                    <button
                      type="button"
                      className="tp-row-lock"
                      title={t.status === 'Finalized' ? 'Unlock (Finalized → Draft)' : 'Lock (Draft → Finalized)'}
                      onClick={async e => {
                        e.stopPropagation();
                        try {
                          const next = t.status === 'Finalized' ? 'Draft' : 'Finalized';
                          await api.setTermStatus(t.code, next);
                          await refresh();
                        } catch (err) {
                          setError(err.response?.data?.error || 'Status change failed.');
                        }
                      }}
                    >{t.status === 'Finalized' ? '🔓' : '🔒'}</button>
                    {/* NEW-FU-185 + NEW-FU-227: rename. The original
                        ✎ thin-pencil glyph was the only monochrome
                        ASCII button in a cluster of colored emoji
                        siblings (🔓/🔒, 📦, 🗑), reading as passive
                        decoration. 🏷️ ("label tag") is semantically
                        tighter — renaming a term = changing its
                        label — and matches the visual weight of the
                        rest of the cluster. */}
                    <button
                      type="button"
                      className="tp-row-edit"
                      title="Rename this term"
                      onClick={e => { e.stopPropagation(); setRenameTarget(t); }}
                    >🏷️</button>
                    {/* NEW-FU-194: archive button — single-click, idempotent
                        on the server, no confirmation dialog because
                        unarchive is one click away. Hidden on archived
                        rows (replaced by the unarchive button below). */}
                    <button
                      type="button"
                      className="tp-row-archive"
                      title="Archive this term (hide from default view)"
                      onClick={async e => {
                        e.stopPropagation();
                        try {
                          await api.archiveTerm(t.code, activeCode);
                          await refresh();
                        } catch (err) {
                          setError(err.response?.data?.error || 'Archive failed.');
                        }
                      }}
                    >📦</button>
                    <button
                      type="button"
                      className="tp-row-del"
                      title="Delete this term"
                      onClick={e => { e.stopPropagation(); setDelTarget(t); }}
                    >🗑</button>
                  </div>
                )}
                {isAdmin && t.isArchived && (
                  <div className="tp-row-actions">
                    {/* NEW-FU-194: unarchive — restore to the default view.
                        No active-term guard needed; restoring is safe. */}
                    <button
                      type="button"
                      className="tp-row-unarchive"
                      title="Restore (unarchive) this term"
                      onClick={async e => {
                        e.stopPropagation();
                        try {
                          await api.unarchiveTerm(t.code);
                          await refresh();
                        } catch (err) {
                          setError(err.response?.data?.error || 'Unarchive failed.');
                        }
                      }}
                    >↩</button>
                    <button
                      type="button"
                      className="tp-row-del"
                      title="Delete this term"
                      onClick={e => { e.stopPropagation(); setDelTarget(t); }}
                    >🗑</button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {isAdmin && (
            <div className="tp-popover-foot">
              <button
                type="button"
                className="tp-add-btn"
                onClick={() => setAddOpen(true)}
              >+ Add new term</button>
              {/* NEW-FU-194: show-archived toggle. We don't know the
                  archived count when the toggle is OFF (no fetch yet);
                  the label updates after the first ON-fetch returns. */}
              <button
                type="button"
                className={`tp-archive-toggle ${showArchived ? 'on' : ''}`}
                onClick={() => setShowArchived(v => !v)}
                title={showArchived ? 'Hide archived terms from the list' : 'Include archived terms in the list'}
              >
                {showArchived
                  ? `Hide archived (${terms.filter(t => t.isArchived).length})`
                  : 'Show archived'}
              </button>
            </div>
          )}
        </div>
      )}

      {addOpen && (
        <AddTermModal
          existingCodes={terms.map(t => t.code)}
          onClose={() => setAddOpen(false)}
          onCreated={async (created) => {
            setAddOpen(false);
            await refresh();
            // Auto-switch to the newly-created term.
            onSwitchTerm(created);
          }}
        />
      )}

      {delTarget && (
        <DeleteTermModal
          term={delTarget}
          activeCode={activeCode}
          onClose={() => setDelTarget(null)}
          onDeleted={async () => {
            setDelTarget(null);
            await refresh();
          }}
        />
      )}

      {renameTarget && (
        <RenameTermModal
          term={renameTarget}
          activeCode={activeCode}
          existingCodes={terms.map(t => t.code)}
          onClose={() => setRenameTarget(null)}
          onRenamed={async () => {
            setRenameTarget(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}
