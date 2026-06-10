import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
import './SectionModal.css';

// Per-format presentation metadata. The button label, file picker accept
// list, and validation messaging all key off this table so adding a new
// format only requires adding one entry.
const EXPORT_FORMATS = [
  { id: 'xlsx', label: 'Excel',  icon: '📊', ext: '.xlsx', desc: 'Round-trips with import. Best for editing.' },
  { id: 'pdf',  label: 'PDF',    icon: '📕', ext: '.pdf',  desc: 'Printable, fixed layout.' },
  { id: 'docx', label: 'Word',   icon: '📝', ext: '.docx', desc: 'Editable document with tables.' },
  { id: 'png',  label: 'Image',  icon: '🖼️', ext: '.png',  desc: 'Snapshot of the current view (rendered in browser).' },
];

const IMPORT_FORMATS = [
  { id: 'xlsx', label: 'Excel', icon: '📊', accept: '.xlsx' },
  { id: 'docx', label: 'Word',  icon: '📝', accept: '.docx' },
  { id: 'pdf',  label: 'PDF',   icon: '📕', accept: '.pdf' },
];
const IMPORT_ACCEPT = IMPORT_FORMATS.map(f => f.accept).join(',');

// Map a File to its inferred format slug (matches backend detectImportFormat).
function inferImportFormat(file) {
  if (!file) return null;
  const n = file.name.toLowerCase();
  if (n.endsWith('.xlsx')) return 'xlsx';
  if (n.endsWith('.docx')) return 'docx';
  if (n.endsWith('.pdf'))  return 'pdf';
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n)) return 'image';
  return null;
}

export default function ExportModal({ onExport, onExportImage, onClose, showToast, initialTab = 'export' }) {
  // NEW-FU-35: Escape dismisses the modal, matching the established pattern
  // in SoftConflictModal / OfficeHourModal / GroupChangeModal.
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const { view, filterId, instructors, venues, schedule, loadView, loadReference, dispatch } = useApp();

  // NEW-FU-228 (Phase 97): open on the caller's tab so the top-bar "Import"
  // button lands directly on Import instead of burying it behind Export.
  const [tab,      setTab]      = useState(initialTab); // 'export' | 'import'
  const [choice,   setChoice]   = useState('full');
  const [format,   setFormat]   = useState('xlsx');
  const [instrId,  setInstrId]  = useState(filterId ?? '');
  const [venueId,  setVenueId]  = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  // NEW-H7: stage the picked file instead of uploading immediately. The user
  // must explicitly click "Import" — picking the wrong file no longer wipes
  // the schedule.
  const [stagedFile, setStagedFile] = useState(null);
  const fileRef = useRef();

  // The current format's metadata — used for the button label and the toast.
  const fmtMeta = EXPORT_FORMATS.find(f => f.id === format) ?? EXPORT_FORMATS[0];

  function handleExport() {
    const view  = choice === 'teacher' ? 'teacher' : choice === 'venue' ? 'venue' : 'full';
    const fid   = choice === 'teacher' ? instrId : choice === 'venue' ? venueId : null;
    if (choice === 'teacher' && !instrId) return;
    if (choice === 'venue'   && !venueId) return;

    // PNG renders in the browser by capturing the live grid DOM. The parent
    // owns the actual ref (it's mounted in SchedulerPage), so we delegate.
    if (format === 'png') {
      if (typeof onExportImage !== 'function') {
        showToast?.('Image export is not wired up.', 'error');
        return;
      }
      onExportImage(view, fid);
      onClose();
      return;
    }
    // xlsx / pdf / docx all flow through the same backend endpoint.
    onExport(view, fid, format);
    onClose();
  }

  function handleFileChange(e) {
    setStagedFile(e.target.files?.[0] ?? null);
    setImportResult(null);
  }

  async function handleImport() {
    if (!stagedFile || !schedule) return;
    const inferred = inferImportFormat(stagedFile);
    if (inferred === 'image') {
      showToast?.('Images cannot be imported. Pick an Excel, Word, or PDF file.', 'error');
      return;
    }
    if (!inferred) {
      showToast?.('Unsupported file type. Use .xlsx, .docx, or .pdf.', 'error');
      return;
    }
    setImporting(true); setImportResult(null);
    try {
      const result = await api.importSchedule(schedule.id, stagedFile, inferred);
      setImportResult(result);
      // Reload all reference data (courses, instructors, venues may have changed)
      await loadReference();
      dispatch({ type:'SET_CONFLICTS', conflicts: result.conflicts?.conflicts ?? [] });
      await loadView(schedule.id, view, filterId);
      const skippedMsg = result.skipped ? ` (${result.skipped} duplicate row(s) skipped)` : '';
      const errMsg = result.errors?.length ? ` · ${result.errors.length} row(s) had errors` : '';
      // Non-Excel imports are best-effort — surface a yellow warning toast when
      // any rows were dropped so the user knows to verify.
      const toastKind = (inferred !== 'xlsx' && result.errors?.length) ? 'warning' : 'success';
      showToast && showToast(`✓ Imported ${result.created} section(s) from ${inferred.toUpperCase()}${skippedMsg}${errMsg}.`, toastKind);
      setStagedFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch(err) {
      const msg = err.response?.data?.error ?? 'Import failed.';
      setImportResult({ created: 0, skipped: 0, errors: [msg] });
      showToast && showToast('Import failed: ' + msg, 'error');
    } finally { setImporting(false); }
  }

  // Pre-compute the inferred format of the staged file so we can render a
  // warning chip before the user clicks Import.
  const stagedFormat = inferImportFormat(stagedFile);

  return (
    <div className="sm-overlay" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="sm-card" style={{ width:560, maxWidth:'95vw' }}>
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
                <label>Export view</label>
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
                      <span className="exp-title">👤 Instructor View — Visual Grid</span>
                      <span className="exp-desc">One instructor's schedule</span>
                    </div>
                  </label>
                  {choice==='teacher' && (
                    <div style={{ marginLeft:24, marginTop:2, marginBottom:2 }}>
                      <select
                        value={instrId}
                        onChange={e=>setInstrId(e.target.value)}
                        aria-label="Select instructor"
                        style={{
                          width:'calc(100% - 24px)', fontSize:'.92rem', fontWeight:500,
                          padding:'9px 12px',
                          background:'#fff',
                          color: instrId ? 'var(--slate-800, #1e293b)' : '#64748b',
                          border: `2px solid ${instrId ? 'var(--teal-500, #14b8a6)' : '#f59e0b'}`,
                          borderRadius:8, cursor:'pointer',
                          boxShadow: instrId ? 'none' : '0 0 0 3px rgba(245, 158, 11, .12)',
                          transition:'border-color .15s, box-shadow .15s',
                        }}
                      >
                        <option value="">👤  Select an instructor…</option>
                        {instructors.map(i =>
                          <option key={i.id} value={i.id}>{i.name}</option>
                        )}
                      </select>
                      {!instrId && (
                        <div style={{
                          marginTop:4, fontSize:'.72rem', color:'#b45309', fontWeight:500,
                        }}>
                          Required — pick an instructor to enable the download.
                        </div>
                      )}
                    </div>
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
                    <div style={{ marginLeft:24, marginTop:2, marginBottom:2 }}>
                      <select
                        value={venueId}
                        onChange={e=>setVenueId(e.target.value)}
                        aria-label="Select venue"
                        style={{
                          width:'calc(100% - 24px)', fontSize:'.92rem', fontWeight:500,
                          padding:'9px 12px',
                          background:'#fff',
                          color: venueId ? 'var(--slate-800, #1e293b)' : '#64748b',
                          border: `2px solid ${venueId ? 'var(--teal-500, #14b8a6)' : '#f59e0b'}`,
                          borderRadius:8, cursor:'pointer',
                          boxShadow: venueId ? 'none' : '0 0 0 3px rgba(245, 158, 11, .12)',
                          transition:'border-color .15s, box-shadow .15s',
                        }}
                      >
                        <option value="">🏛  Select a venue…</option>
                        {venues.map(v =>
                          <option key={v.id} value={v.id}>{v.name} ({v.type})</option>
                        )}
                      </select>
                      {!venueId && (
                        <div style={{
                          marginTop:4, fontSize:'.72rem', color:'#b45309', fontWeight:500,
                        }}>
                          Required — pick a venue to enable the download.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Format selector */}
              <div className="sm-field" style={{ marginTop:14 }}>
                <label>File format</label>
                <div style={{
                  display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8, marginTop:4,
                }}>
                  {EXPORT_FORMATS.map(f => {
                    const active = format === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setFormat(f.id)}
                        title={f.desc}
                        style={{
                          display:'flex', flexDirection:'column', alignItems:'center', gap:2,
                          padding:'10px 6px', borderRadius:8, cursor:'pointer',
                          background: active ? 'rgba(13,148,136,.08)' : '#fff',
                          border: `1.5px solid ${active ? 'var(--teal-500)' : 'var(--slate-200)'}`,
                          color: active ? 'var(--teal-700, #0f766e)' : 'var(--slate-700)',
                          fontWeight: active ? 600 : 500, fontSize:'.82rem',
                          transition:'background .15s, border-color .15s',
                        }}
                      >
                        <span style={{ fontSize:'1.4rem', lineHeight:1 }}>{f.icon}</span>
                        <span>{f.label}</span>
                        <span style={{ fontSize:'.65rem', color:'var(--slate-500)' }}>{f.ext}</span>
                      </button>
                    );
                  })}
                </div>
                {format === 'png' && (
                  <div style={{
                    marginTop:8, fontSize:'.75rem', color:'var(--slate-600)',
                    background:'rgba(13,148,136,.06)', borderRadius:6, padding:'6px 10px',
                  }}>
                    Image export captures the live schedule view rendered in your browser.
                  </div>
                )}
              </div>

              <div className="sm-actions" style={{marginTop:16}}>
                <button className="sm-btn-cancel" onClick={onClose}>Cancel</button>
                <button className="sm-btn-save" onClick={handleExport}
                  disabled={(choice==='teacher'&&!instrId)||(choice==='venue'&&!venueId)}>
                  Download {fmtMeta.label} →
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
                <strong>Supported formats:</strong>{' '}
                {IMPORT_FORMATS.map(f => `${f.icon} ${f.label} (${f.accept})`).join(' · ')}
                <br/>
                Each file must contain a table with columns:<br/>
                <code style={{fontSize:'.75rem',background:'var(--slate-100)',
                  padding:'1px 5px',borderRadius:3,display:'inline-block',marginTop:4}}>
                  Course Code, Course Name, Academic Level, Category, Credits, Section #, Days, Start Time, End Time, Duration (min), Instructor, Venue
                </code><br/><br/>
                <strong>Excel</strong> round-trips cleanly. <strong>Word</strong> imports parse the first table. <strong>PDF</strong> imports are best-effort — table extraction can lose rows when the layout is non-standard.<br/>
                Images cannot be imported.<br/>
                <strong style={{color:'#b91c1c'}}>Heads up:</strong> import will <strong>replace all current sections</strong> in this schedule.
              </div>

              <div className="sm-field">
                <label>Select file ({IMPORT_FORMATS.map(f=>f.accept).join(', ')})</label>
                <input
                  ref={fileRef}
                  type="file"
                  accept={IMPORT_ACCEPT}
                  onChange={handleFileChange}
                  disabled={importing}
                  style={{padding:'6px',border:'1.5px solid var(--slate-200)',
                    borderRadius:7,fontSize:'.85rem',width:'100%'}}
                />
                {stagedFile && (
                  <div style={{marginTop:6, fontSize:'.78rem', color:'var(--slate-600)'}}>
                    Selected: <strong>{stagedFile.name}</strong> ({Math.round(stagedFile.size/1024)} KB)
                    {stagedFormat && stagedFormat !== 'image' && (
                      <span style={{
                        marginLeft:8, padding:'1px 8px', borderRadius:10,
                        background:'rgba(13,148,136,.1)', color:'var(--teal-700, #0f766e)',
                        fontSize:'.72rem', fontWeight:600,
                      }}>{stagedFormat.toUpperCase()}</span>
                    )}
                    {stagedFormat === 'image' && (
                      <span style={{
                        marginLeft:8, padding:'1px 8px', borderRadius:10,
                        background:'#fee2e2', color:'#b91c1c',
                        fontSize:'.72rem', fontWeight:600,
                      }}>NOT IMPORTABLE</span>
                    )}
                    {stagedFormat === null && (
                      <span style={{
                        marginLeft:8, padding:'1px 8px', borderRadius:10,
                        background:'#fef3c7', color:'#92400e',
                        fontSize:'.72rem', fontWeight:600,
                      }}>UNSUPPORTED TYPE</span>
                    )}
                  </div>
                )}
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
                    {importResult.skipped ? ` · ${importResult.skipped} duplicate(s) skipped` : ''}
                    {importResult.errors?.length ? ` · ${importResult.errors.length} error(s)` : ''}
                  </div>
                  {importResult.errors?.map((e,i) => (
                    <div key={i} style={{color:'#dc2626',fontSize:'.75rem'}}>{e}</div>
                  ))}
                </div>
              )}

              <div className="sm-actions" style={{marginTop:12}}>
                <button className="sm-btn-cancel" onClick={onClose}>Close</button>
                <button
                  className="sm-btn-save"
                  onClick={handleImport}
                  disabled={!stagedFile || importing || stagedFormat === 'image' || stagedFormat === null}
                  style={(!stagedFile || stagedFormat === 'image' || stagedFormat === null)
                    ? { background:'var(--slate-200)', borderColor:'var(--slate-200)', color:'var(--slate-500)' }
                    : undefined}
                >
                  {importing ? '⏳ Importing…' : 'Import →'}
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
