import React from 'react';
import { useApp, VIEWS } from '../../context/AppContext.jsx';
import './TopBar.css';

export default function TopBar({ onSave, onSuggest, onExport }) {
  const { user, doLogout, schedule, view, saveBlocked, softPending, loading, switchView } = useApp();

  const viewTabs = [
    { id: VIEWS.COURSE,  label: 'Course View'  },
    { id: VIEWS.TEACHER, label: 'Teacher View' },
    { id: VIEWS.VENUE,   label: 'Venue View'   },
  ];

  const hasSoftOnly = !saveBlocked && softPending.length > 0;
  const saveLabel   = saveBlocked ? '🔴 Conflicts' : hasSoftOnly ? '⚠️ Save' : '✓ Save';
  const saveClass   = saveBlocked ? 'topbar-btn danger' : hasSoftOnly ? 'topbar-btn warn' : 'topbar-btn success';

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-icon">⊞</span>
        <span className="topbar-title">SchedulerSWE</span>
        {schedule && <span className="topbar-semester">{schedule.semester}</span>}
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
        <button className="topbar-btn suggest" onClick={onSuggest}
          disabled={!schedule || loading}>✦ Suggest</button>
        <button className={saveClass} onClick={onSave}
          disabled={!schedule || loading || saveBlocked}>{saveLabel}</button>
        <button className="topbar-btn export" onClick={onExport}
          disabled={!schedule}>↓ Export</button>
        <div className="topbar-user">
          <span className="topbar-username">{user?.username}</span>
          <button className="topbar-logout" onClick={doLogout} title="Sign out">⏻</button>
        </div>
      </div>
    </header>
  );
}
