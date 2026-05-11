import React, { useState, useRef } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
import './SectionModal.css';

export default function ExportModal({ onExport, onClose, showToast }) {
  const { view, filterId, instructors, venues, schedule, loadView, loadReference, dispatch } = useApp();

  const [tab,      setTab]      = useState('export'); // 'export' | 'import'
  const [choice,   setChoice]   = useState('full');
  const [instrId,  setInstrId]  = useState(filterId ?? '');
  const [venueId,  setVenueId]  = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const fileRef = useRef();

  function handleExport() {
    if (choice === 'full')    { onExport('full', null);     onClose(); }
    else if (choice === 'teacher' && instrId) { onExport('teacher', instrId); onClose(); }
    else if (choice === 'venue'   && venueId) { onExport('venue',   venueId); onClose(); }
  }

  async function handleImport(e) {
    const file = e.target.files?.[0];
    if (!file || !schedule) return;
    setImporting(true); setImportResult(null);
    try {
      const result = await api.importSchedule(schedule.id, file);
      setImportResult(result);
      // Reload all reference data (courses, instructors, venues may have changed)
      await loadReference();
      dispatch({ type:'SET_CONFLICTS', conflicts: result.conflicts?.conflicts ?? [] });
      await loadView(schedule.id, view, filterId);
      showToast && showToast(`✓ Imported ${result.created} section(s).`, 'success');
    } catch(err) {
      const msg = err.response?.data?.error ?? 'Import failed.';
      setImportResult({ created: 0, errors: [msg] });
      showToast && showToast('Import failed: ' + msg, 'error');
    } finally { setImporting(false); }
  }

  return (
    <div className="sm-overlay" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="sm-card" style={{ maxWidth:480 }}>
        <div className="sm-header">
          <h2 className="sm-title">📊 Schedule Data</h2>
          <button className="sm-close" onClick={onClose}>×</button>
        </div>

        {/* Tabs */}
        <div className="sm-tabs">
          <button className={tab==='export'?'active':''} onClick={()=>setTab('export')}>↓ Export</button>
          <button className={tab==='import'?'active':''} onClick={()=>setTab('import')}>↑ Import</button>
        </div>

        <div className="sm-form" style={{ padding:'16px 24px 24px' }}>

          {/* ── EXPORT TAB ── */}
          {tab === 'export' && (
            <>
              <div className="sm-field">
                <label>Export format</label>
                <div style={{ display:'flex', flexDirection:'column', gap:8, marginTop:4 }}>

                  <label className="exp-option">
                    <input type="radio" name="exp" value="full"
                      checked={choice==='full'} onChange={()=>setChoice('full')} />
                    <div className="exp-label">
                      <span className="exp-title">📋 Full Semester — Table</span>
                      <span className="exp-desc">One row per section group. Importable format.</span>
                    </div>
                  </label>

                  <label className="exp-option">
                    <input type="radio" name="exp" value="teacher"
                      checked={choice==='teacher'} onChange={()=>setChoice('teacher')} />
                    <div className="exp-label">
                      <span className="exp-title">👤 Teacher View — Visual Grid</span>
                      <span className="exp-desc">One instructor's schedule with office hours</span>
                    </div>
                  </label>
                  {choice==='teacher' && (
                    <select value={instrId} onChange={e=>setInstrId(e.target.value)}
                      style={{marginLeft:24,fontSize:'.85rem',padding:'6px 8px',
                        border:'1.5px solid var(--slate-200)',borderRadius:6}}>
                      <option value="">— Select instructor —</option>
                      {instructors.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}
                    </select>
                  )}

                  <label className="exp-option">
                    <input type="radio" name="exp" value="venue"
                      checked={choice==='venue'} onChange={()=>setChoice('venue')} />
                    <div className="exp-label">
                      <span className="exp-title">🏛 Venue View — Visual Grid</span>
                      <span className="exp-desc">All sections assigned to a specific venue</span>
                    </div>
                  </label>
                  {choice==='venue' && (
                    <select value={venueId} onChange={e=>setVenueId(e.target.value)}
                      style={{marginLeft:24,fontSize:'.85rem',padding:'6px 8px',
                        border:'1.5px solid var(--slate-200)',borderRadius:6}}>
                      <option value="">— Select venue —</option>
                      {venues.map(v=><option key={v.id} value={v.id}>{v.name} ({v.type})</option>)}
                    </select>
                  )}
                </div>
              </div>

              <div className="sm-actions" style={{marginTop:16}}>
                <button className="sm-btn-cancel" onClick={onClose}>Cancel</button>
                <button className="sm-btn-save" onClick={handleExport}
                  disabled={(choice==='teacher'&&!instrId)||(choice==='venue'&&!venueId)}>
                  Download Excel →
                </button>
              </div>
            </>
          )}

          {/* ── IMPORT TAB ── */}
          {tab === 'import' && (
            <>
              <div style={{
                background:'rgba(13,148,136,.06)', border:'1px solid rgba(13,148,136,.2)',
                borderRadius:8, padding:'12px 14px', fontSize:'.82rem',
                color:'var(--slate-700)', lineHeight:1.6, marginBottom:12
              }}>
                <strong>Import format</strong> — upload an Excel file with the same columns as the
                Full Semester table export:<br/>
                <code style={{fontSize:'.75rem',background:'var(--slate-100)',
                  padding:'1px 5px',borderRadius:3,display:'inline-block',marginTop:4}}>
                  Course Code, Course Name, Academic Level, Category, Section #, Days, Start Time, End Time, Duration (min), Instructor, Venue
                </code><br/><br/>
                <strong>Days</strong> format: <code>Sunday, Tuesday, Thursday</code> or <code>Monday, Wednesday</code><br/>
                New instructors and venues will be created automatically. Instructors and venues not in the file will be removed.
              </div>

              <div className="sm-field">
                <label>Select Excel file (.xlsx)</label>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleImport}
                  disabled={importing}
                  style={{padding:'6px',border:'1.5px solid var(--slate-200)',
                    borderRadius:7,fontSize:'.85rem',width:'100%'}}
                />
              </div>

              {importing && (
                <div style={{textAlign:'center',color:'var(--teal-500)',padding:'8px',fontSize:'.85rem'}}>
                  ⏳ Importing…
                </div>
              )}

              {importResult && (
                <div style={{
                  background: importResult.errors?.length ? '#fee2e2' : '#dcfce7',
                  border: `1px solid ${importResult.errors?.length ? '#fca5a5' : '#86efac'}`,
                  borderRadius:8, padding:'10px 12px', fontSize:'.8rem',
                }}>
                  <div style={{fontWeight:600, marginBottom:4}}>
                    ✓ {importResult.created} section(s) imported
                    {importResult.errors?.length ? ` · ${importResult.errors.length} error(s)` : ''}
                  </div>
                  {importResult.errors?.map((e,i) => (
                    <div key={i} style={{color:'#dc2626',fontSize:'.75rem'}}>{e}</div>
                  ))}
                </div>
              )}

              <div className="sm-actions" style={{marginTop:12}}>
                <button className="sm-btn-cancel" onClick={onClose}>Close</button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
