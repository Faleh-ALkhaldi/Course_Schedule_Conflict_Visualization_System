import React from 'react';
import { useApp, VIEWS } from '../../context/AppContext.jsx';
import { TermPicker } from './TermPicker.jsx';
// NEW-FU-503 (Phase 123): shared SVG icons replace the mixed emoji glyphs.
import Ico from './Icons.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import './TopBar.css';

// NEW-FU-165: legacy semester → term-code display map. Kept for the
// transitional period where the DB still has the seed's "Fall-2025" label;
// once a user has only canonical YYT-coded terms, this map is unused
// (the TermPicker shows the real codes directly).
const SEMESTER_DISPLAY = {
  'Fall-2025': '252',
};
const displayCode = (sem) => (sem ? (SEMESTER_DISPLAY[sem] || sem) : '');

// NEW-FU-549 (Batch 16): platform-correct modifier glyph for shortcut hints.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';

export default function TopBar({ onSave, onSuggest, onExport, onImport, onSwitchTerm, onUnlock, onLogout, onUndo, onRedo }) {
  const { user, doLogout, schedule, view, filterId, saveBlocked, softPending, loading, switchView, conflicts,
          canUndo, canRedo, undoLabel, redoLabel } = useApp();
  const isAdmin = user?.role === 'admin';
  // NEW-FU-314 (Phase 29): derive live conflict counts from the conflicts
  // array in app state. The badge displayed on the term chip was reading
  // from terms[].hardConflictCount/softConflictCount loaded once when the
  // term list was fetched — so it stayed stale after the user resolved a
  // conflict and only refreshed on full page reload or dropdown open.
  // The `conflicts` array IS updated live (SET_CONFLICTS reducer fires
  // on every mutation), so deriving from it gives instant feedback.
  const liveHardCount = React.useMemo(
    () => (conflicts || []).filter(c => c.severity === 'Hard').length,
    [conflicts],
  );
  const liveSoftCount = React.useMemo(
    () => (conflicts || []).filter(c => c.severity === 'Soft' && !c.confirmed).length,
    [conflicts],
  );
  // NEW-FU-165: pass the RAW `semester` to TermPicker so the backend's
  // active-term comparison matches the DB value. The display label
  // (e.g. "Fall-2025" → "252") is shown ONLY on the chip itself via the
  // TermPicker's per-term `label`. activeCode here is the DB lookup key.
  const activeCode = schedule?.semester ?? null;
  // NEW-FU-203: pre-disable mutation buttons on archived schedules. The API
  // returns 409 on these anyway (FU-201), but disabling avoids a flash of
  // error toast for the user-initiated click.
  const isArchived = Boolean(schedule?.archived_at);
  // NEW-FU-465 (Phase 110): the top button is a stateful toggle — on a draft term it
  // SAVES (finalizes + locks); on a finalized term it UNLOCKS (un-finalizes → draft).
  const isFinalized = schedule?.status === 'Finalized';
  // NEW-FU-482 (Phase 116): mutation actions (Suggest, Import) are blocked when the term is
  // finalized OR archived. Unlock stays available so a finalized term can be un-finalized.
  const isLocked = isArchived || isFinalized;

  const viewTabs = [
    { id: VIEWS.COURSE,  label: 'Course View'  },
    { id: VIEWS.TEACHER, label: 'Instructor View' },
    { id: VIEWS.VENUE,   label: 'Venue View'   },
  ];

  const hasSoftOnly = !saveBlocked && softPending.length > 0;
  // NEW-FU-503 (Phase 123): stateful label keeps its three meanings, rendered
  // with the shared SVG icons instead of 🔴 / ⚠️ / ✓ emoji.
  // NEW-FU-614 (Batch 31 item 3): the top-bar commit button FINALIZES the term (saveSchedule
  // sets status=Finalized; section edits already auto-persist live). Label it "Finalize" so it
  // matches the term-level finalize/lock action; once finalized it flips to a "Locked" button
  // (below) whose click unlocks. The blocked state still reads "Conflicts" (can't finalize).
  const saveLabel   = saveBlocked
    ? <><Ico name="alert" /><span>Conflicts</span></>
    : hasSoftOnly
    ? <><Ico name="alert" /><span>Finalize</span></>
    : <><Ico name="check" /><span>Finalize</span></>;
  const saveClass   = saveBlocked ? 'topbar-btn danger' : hasSoftOnly ? 'topbar-btn warn' : 'topbar-btn success';

  // NEW-FU-56: in teacher/venue view without a filter selected, Suggest's
  // post-action loadView would 400 against the stricter FU-47 backend.
  // Rather than relying on the runSuggest gate alone, disable the button
  // up-front so the affordance matches the actual capability. Save & Export
  // remain enabled (Save is independent; Export already has a separate
  // dialog with explicit view selection).
  const incompleteFilter = (view === VIEWS.TEACHER || view === VIEWS.VENUE) && !filterId;

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-icon"><Ico name="grid" /></span>
        <span className="topbar-title">SchedulerSWE</span>
        {/* NEW-FU-165: clickable term chip replaces the static label */}
        {schedule && (
          <TermPicker
            activeCode={activeCode}
            isAdmin={isAdmin}
            onSwitchTerm={onSwitchTerm}
            liveHardCount={liveHardCount}
            liveSoftCount={liveSoftCount}
          />
        )}
      </div>

      <nav className="topbar-views" role="tablist">
        {viewTabs.map(tab => (
          <button key={tab.id} role="tab"
            aria-selected={view === tab.id}
            className={`topbar-tab ${view === tab.id ? 'active' : ''}`}
            onClick={() => switchView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="topbar-actions">
        {/* NEW-FU-549 (Batch 16): Undo / Redo. Disabled when the respective stack is
            empty or the term is read-only; tooltip shows the shortcut + next action. */}
        <div className="topbar-undo-group">
          <button className="topbar-btn icon-only" onClick={onUndo} disabled={!canUndo}
            aria-label="Undo"
            title={canUndo ? `Undo ${undoLabel} (${MOD}Z)` : `Nothing to undo (${MOD}Z)`}>
            <Ico name="undo" />
          </button>
          <button className="topbar-btn icon-only" onClick={onRedo} disabled={!canRedo}
            aria-label="Redo"
            title={canRedo ? `Redo ${redoLabel} (${MOD}⇧Z)` : `Nothing to redo (${MOD}⇧Z)`}>
            <Ico name="redo" />
          </button>
        </div>
        <button className="topbar-btn suggest" onClick={onSuggest}
          disabled={!schedule || loading || incompleteFilter || isLocked}
          title={
            isFinalized ? 'Term is finalized — unlock it first to regenerate.'
            : isArchived ? 'Term is archived — unarchive to regenerate.'
            : incompleteFilter ? `Select a ${view} from the sidebar first`
            : undefined
          }>
          <Ico name="sparkles" /><span>Suggest</span>
        </button>
        {isFinalized ? (
          // NEW-FU-614 (Batch 31 item 3): finalized → show a LOCK button (the locked state),
          // replacing the "Finalize" button in place. Clicking it still unlocks (un-finalizes),
          // exactly as before — the label just reflects the state ("Locked") instead of the verb.
          <button className="topbar-btn warn" onClick={onUnlock}
            disabled={!schedule || loading || isArchived}
            title="This term is finalized & locked. Click to unlock it so you can edit again.">
            <Ico name="lock" /><span>Locked</span></button>
        ) : (
          <button className={saveClass} onClick={onSave}
            disabled={!schedule || loading || saveBlocked || isArchived}
            title={isArchived ? 'Term is archived — unarchive to save.' : undefined}>{saveLabel}</button>
        )}
        {/* NEW-FU-228 (Phase 97): Import is now its own top-bar button instead
            of being buried as a tab inside the Export modal. */}
        <button className="topbar-btn import" onClick={onImport}
          disabled={!schedule || isLocked}
          title={isFinalized ? 'Term is finalized — unlock it first to import.' : isArchived ? 'Term is archived — unarchive to import.' : 'Import a schedule from Excel / Word / PDF'}>
          <Ico name="upload" /><span>Import</span></button>
        <button className="topbar-btn export" onClick={onExport}
          disabled={!schedule}><Ico name="download" /><span>Export</span></button>
        <ThemeToggle />
        <div className="topbar-user">
          <span className="topbar-username">{user?.username}</span>
          {/* NEW-FU-476 (Phase 114): confirm before logging out (onLogout asks via the
              styled dialog); fall back to a direct logout only if no handler is wired.
              NEW-FU-501 (Phase 123): icon-only button gets an explicit aria-label. */}
          <button className="topbar-logout" onClick={onLogout || doLogout} title="Sign out"
            aria-label="Sign out"><Ico name="power" /></button>
        </div>
      </div>
    </header>
  );
}
