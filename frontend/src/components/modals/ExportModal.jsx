import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
// NEW-FU-503 (Phase 123): shared SVG icons replace emoji glyphs.
import Ico from '../shared/Icons.jsx';
import { useApp } from '../../context/AppContext.jsx';
import * as api from '../../api/index.js';
import './SectionModal.css';

// Per-format presentation metadata. The button label, file picker accept
// list, and validation messaging all key off this table so adding a new
// format only requires adding one entry.
// NEW-FU-574 (Batch 21): dropped the emoji glyphs for a clean, formal look.
const EXPORT_FORMATS = [
  { id: 'xlsx', label: 'Excel',  ext: '.xlsx', desc: 'Round-trips with import. Best for editing.' },
  { id: 'pdf',  label: 'PDF',    ext: '.pdf',  desc: 'Printable, fixed layout.' },
  { id: 'docx', label: 'Word',   ext: '.docx', desc: 'Editable document with tables.' },
  { id: 'png',  label: 'Image',  ext: '.png',  desc: 'Snapshot of the current view (rendered in browser).' },
];

// NEW-FU-666: end-user venue-type labels for the picker (never the code-base "LectureHall").
const VENUE_TYPE_LABEL = { LectureHall: 'Lecture Hall', Laboratory: 'Laboratory', Multipurpose: 'Multipurpose' };

const IMPORT_FORMATS = [
  { id: 'xlsx', label: 'Excel', accept: '.xlsx' },
  { id: 'docx', label: 'Word',  accept: '.docx' },
  { id: 'pdf',  label: 'PDF',   accept: '.pdf' },
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

export default function ExportModal({ onExport, onClose, showToast, initialTab = 'export' }) {
  useFocusTrap();
  // NEW-FU-35: Escape dismisses the modal, matching the established pattern
  // in SoftConflictModal / OfficeHourModal / GroupChangeModal.
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const { view, filterId, instructors, venues, schedule, loadView, loadReference, dispatch, clearHistory } = useApp();

  // NEW-FU-574 (Batch 21): the modal is single-purpose — it opens straight from the
  // toolbar's Export OR Import button (initialTab), and the Export/Import tab switcher
  // was removed (Export was redundantly exposing an Import entry point that already has
  // its own dedicated button). `tab` is therefore fixed to whichever button opened it.
  const tab = initialTab; // 'export' | 'import'
  const [choice,   setChoice]   = useState('full');
  const [format,   setFormat]   = useState('xlsx');
  const [instrId,  setInstrId]  = useState(filterId ?? '');
  const [venueId,  setVenueId]  = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  // NEW-FU-660: when a scoped (instructor/venue) file would create conflicts, the
  // backend returns { needsDecision } instead of merging; we stash it here to render
  // the 3-option dialog. Picking an option re-imports the same staged file with a mode.
  const [decision, setDecision] = useState(null);
  // NEW-H7: stage the picked file instead of uploading immediately. The user
  // must explicitly click "Import" — picking the wrong file no longer wipes
  // the schedule.
  const [stagedFile, setStagedFile] = useState(null);
  const fileRef = useRef();

  // The current format's metadata — used for the button label and the toast.
  const fmtMeta = EXPORT_FORMATS.find(f => f.id === format) ?? EXPORT_FORMATS[0];

  // NEW: empty-schedule guard. A visual-grid export of an instructor or venue
  // that has NO section in the current schedule produces a blank grid — and
  // (now that the resource lists are owned per term, not derived from sections)
  // the picker can legitimately list instructors/venues with zero classes. We
  // fetch the whole schedule's sections ONCE (the unfiltered course view returns
  // every section with its instructorId/venueId) and flag the entries that have
  // no class, so they can be marked "· no classes" and disabled in the picker.
  //
  // `null` means "not loaded yet / fetch failed" — in that state we disable
  // nothing, so a transient backend hiccup can never block a legitimate export.
  const [scheduleSections, setScheduleSections] = useState(null);
  useEffect(() => {
    if (!schedule?.id) return;
    let cancelled = false;
    api.getSections(schedule.id, 'course')
      .then(data => { if (!cancelled) setScheduleSections(data?.sections ?? data ?? []); })
      .catch(() => { if (!cancelled) setScheduleSections(null); });
    return () => { cancelled = true; };
  }, [schedule?.id]);

  const sectionsLoaded   = scheduleSections !== null;
  const usedInstructorIds = useMemo(
    () => new Set((scheduleSections ?? []).map(s => s.instructorId).filter(Boolean)),
    [scheduleSections]
  );
  const usedVenueIds = useMemo(
    () => new Set((scheduleSections ?? []).map(s => s.venueId).filter(Boolean)),
    [scheduleSections]
  );
  // Helpers: an entry "has classes" if we haven't loaded sections yet (don't
  // over-disable) OR it appears on at least one section.
  const instructorHasClasses = (id) => !sectionsLoaded || usedInstructorIds.has(id);
  const venueHasClasses       = (id) => !sectionsLoaded || usedVenueIds.has(id);

  // If the pre-selected instructor/venue (carried in from the active view's
  // filterId) turns out to have no classes once sections load, clear it so the
  // disabled option can't sit selected and arm an empty-grid download.
  useEffect(() => {
    if (sectionsLoaded && instrId && !usedInstructorIds.has(instrId)) setInstrId('');
  }, [sectionsLoaded, instrId, usedInstructorIds]);
  useEffect(() => {
    if (sectionsLoaded && venueId && !usedVenueIds.has(venueId)) setVenueId('');
  }, [sectionsLoaded, venueId, usedVenueIds]);

  function handleExport() {
    const view  = choice === 'teacher' ? 'teacher' : choice === 'venue' ? 'venue' : 'full';
    const fid   = choice === 'teacher' ? instrId : choice === 'venue' ? venueId : null;
    if (choice === 'teacher' && !instrId) return;
    if (choice === 'venue'   && !venueId) return;

    // NEW-FU-667: PNG is now generated SERVER-SIDE — the same scoped, theme-independent grid the
    // PDF renders, rasterized to an image — so it flows through the SAME backend endpoint as
    // xlsx/docx/pdf. (It used to capture the live DOM via html2canvas, which gave the wrong scope
    // and leaked the current theme/view.) A venue/instructor image now shows exactly that entity.
    onExport(view, fid, format);
    onClose();
  }

  function handleFileChange(e) {
    setStagedFile(e.target.files?.[0] ?? null);
    setImportResult(null);
    setDecision(null);
  }

  // NEW-FU-660: `mode` is undefined on the first ("preview") import; when the user
  // picks an option in the conflict dialog it re-imports the SAME staged file with the
  // chosen merge mode ('entity-only' | 'with-conflicts' | 'conflict-free').
  async function handleImport(mode) {
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
    // NEW-FU-662: client-side size pre-check (defense in depth; the backend re-enforces the
    // same 10 MB cap and never trusts this). Real exports are a few hundred KB at most.
    if (stagedFile.size > 10 * 1024 * 1024) {
      showToast?.('That file is too large (max 10 MB). A schedule export is only a few hundred KB.', 'error');
      return;
    }
    setImporting(true); setImportResult(null);
    try {
      const result = await api.importSchedule(schedule.id, stagedFile, inferred, mode);

      // NEW-FU-660: a scoped file that would conflict comes back needing a decision —
      // show the 3-option dialog instead of treating it as a finished import.
      if (result.needsDecision) {
        setDecision(result);
        setImporting(false);
        return;
      }
      setDecision(null);
      setImportResult(result);
      // Reload all reference data (courses, instructors, venues may have changed)
      await loadReference();
      dispatch({ type:'SET_CONFLICTS', conflicts: result.conflicts?.conflicts ?? [] });
      await loadView(schedule.id, view, filterId);
      clearHistory?.();   // NEW-FU-549 (Batch 16): import changed the schedule → reset undo history
      // NEW-FU-660: tailor the toast to merge (scoped) vs replace (whole-term).
      let summary;
      if (result.scope === 'instructor' || result.scope === 'venue') {
        if (result.mode === 'entity-only') summary = result.message || `Added ${result.entity}.`;
        else {
          const movedMsg  = result.moved ? ` · ${result.moved} moved to free slots` : '';
          const confMsg   = result.newConflicts ? ` · ${result.newConflicts} conflict(s)` : '';
          summary = `Merged ${result.entity}: ${result.created} section(s) added${movedMsg}${confMsg}.`;
        }
      } else {
        const skippedMsg = result.skipped ? ` (${result.skipped} duplicate row(s) skipped)` : '';
        const errMsg = result.errors?.length ? ` · ${result.errors.length} row(s) had errors` : '';
        summary = `Imported ${result.created} section(s) from ${inferred.toUpperCase()}${skippedMsg}${errMsg}.`;
      }
      const toastKind = (result.errors?.length || result.newConflicts) ? 'warning' : 'success';
      showToast && showToast('✓ ' + summary, toastKind);
      setStagedFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch(err) {
      const msg = err.response?.data?.error ?? 'Import failed.';
      setImportResult({ created: 0, skipped: 0, errors: [msg] });
      showToast && showToast('Import failed: ' + msg, 'error');
    } finally { setImporting(false); }
  }

  // NEW-FU-660: the three conflict-dialog options, worded per scope.
  const decisionOptions = decision ? (decision.scope === 'venue' ? [
    { mode:'entity-only',    title:'Add the venue only',            desc:'Just its capacity & type — no courses assigned.' },
    { mode:'with-conflicts', title:'Add everything, keep conflicts', desc:'Add the venue, its courses & instructors, and proceed even with the conflicts.' },
    { mode:'conflict-free',  title:'Add everything, conflict-free',  desc:'Add it all, but move conflicting classes to free times — nothing is dropped.' },
  ] : [
    { mode:'entity-only',    title:'Add the instructor only',        desc:'With their office hours — no courses assigned.' },
    { mode:'with-conflicts', title:'Add everything, keep conflicts', desc:'Add the instructor, their courses & venues, and proceed even with the conflicts.' },
    { mode:'conflict-free',  title:'Add everything, conflict-free',  desc:'Add it all, but move conflicting classes to free times — nothing is dropped.' },
  ]) : [];

  // Pre-compute the inferred format of the staged file so we can render a
  // warning chip before the user clicks Import.
  const stagedFormat = inferImportFormat(stagedFile);

  return (
    <div className="sm-overlay" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="sm-card" role="dialog" aria-modal="true" aria-label={tab==='import' ? 'Import schedule' : 'Export schedule'} style={{ width:560, maxWidth:'95vw' }}>
        <div className="sm-header">
          {/* NEW-FU-574 (Batch 21): single-purpose title, no emoji; the Export/Import
              tab switcher was removed (Import has its own dedicated toolbar button). */}
          <h2 className="sm-title">{tab==='import' ? 'Import Schedule' : 'Export Schedule'}</h2>
          <button className="sm-close" onClick={onClose}>×</button>
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
                      <span className="exp-title"><Ico name="clipboard" /> Whole-Term Schedule</span>
                      <span className="exp-desc">The full term: week grid + every section + all instructors, venues & office hours. Re-importing replaces a term.</span>
                    </div>
                  </label>

                  <label className="exp-option">
                    <input type="radio" name="exp" value="teacher"
                      checked={choice==='teacher'} onChange={()=>setChoice('teacher')} />
                    <div className="exp-label">
                      <span className="exp-title"><Ico name="user" /> Instructor View</span>
                      <span className="exp-desc">Only this instructor — their week, their sections, their office hours & rooms. Nothing else from the term.</span>
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
                          background:'var(--bg-elevated)',
                          color: instrId ? 'var(--fg)' : 'var(--fg-muted)',
                          border: `2px solid ${instrId ? 'var(--teal-500, #14b8a6)' : '#f59e0b'}`,
                          borderRadius:8, cursor:'pointer',
                          boxShadow: instrId ? 'none' : '0 0 0 3px rgba(245, 158, 11, .12)',
                          transition:'border-color .15s, box-shadow .15s',
                        }}
                      >
                        <option value="">Select an instructor…</option>
                        {instructors.map(i => {
                          const hasClasses = instructorHasClasses(i.id);
                          return (
                            <option key={i.id} value={i.id} disabled={!hasClasses}>
                              {i.name}{hasClasses ? '' : ' · no classes'}
                            </option>
                          );
                        })}
                      </select>
                      {!instrId && (
                        <div style={{
                          marginTop:4, fontSize:'.72rem', color:'var(--warn-fg)', fontWeight:500,
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
                      <span className="exp-title"><Ico name="pin" /> Venue View</span>
                      <span className="exp-desc">Only this venue — its week, its sections, its capacity & the instructors who use it. Nothing else from the term.</span>
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
                          background:'var(--bg-elevated)',
                          color: venueId ? 'var(--fg)' : 'var(--fg-muted)',
                          border: `2px solid ${venueId ? 'var(--teal-500, #14b8a6)' : '#f59e0b'}`,
                          borderRadius:8, cursor:'pointer',
                          boxShadow: venueId ? 'none' : '0 0 0 3px rgba(245, 158, 11, .12)',
                          transition:'border-color .15s, box-shadow .15s',
                        }}
                      >
                        <option value="">Select a venue…</option>
                        {venues.map(v => {
                          const hasClasses = venueHasClasses(v.id);
                          return (
                            <option key={v.id} value={v.id} disabled={!hasClasses}>
                              {v.name} ({VENUE_TYPE_LABEL[v.type] ?? v.type}){hasClasses ? '' : ' · no classes'}
                            </option>
                          );
                        })}
                      </select>
                      {!venueId && (
                        <div style={{
                          marginTop:4, fontSize:'.72rem', color:'var(--warn-fg)', fontWeight:500,
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
                          background: active ? 'rgba(13,148,136,.08)' : 'var(--bg-elevated)',
                          border: `1.5px solid ${active ? 'var(--teal-500)' : 'var(--slate-200)'}`,
                          color: active ? 'var(--teal-700, #0f766e)' : 'var(--fg-dim)',
                          fontWeight: active ? 600 : 500, fontSize:'.82rem',
                          transition:'background .15s, border-color .15s',
                        }}
                      >
                        <span style={{ fontWeight:700, fontSize:'.92rem' }}>{f.label}</span>
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
                color:'var(--text-secondary)', lineHeight:1.6, marginBottom:12
              }}>
                <strong>Supported formats:</strong>{' '}
                {IMPORT_FORMATS.map(f => `${f.label} (${f.accept})`).join(' · ')} — Excel, Word & PDF all round-trip losslessly.
                <br/><br/>
                The importer matches each file to how it was exported:
                <ul style={{margin:'4px 0 0', paddingLeft:18}}>
                  <li><strong>Whole-term file</strong> → <strong>replaces</strong> this term entirely (this term keeps its own name).</li>
                  <li><strong>Instructor file</strong> → <strong>merges</strong> that instructor — its classes, rooms & office hours — into this term, keeping everything already here.</li>
                  <li><strong>Venue file</strong> → <strong>merges</strong> that venue — its classes, capacity & the instructors who use it — into this term.</li>
                </ul>
                If a merge would clash with what's already scheduled, you'll be asked how to proceed (add anyway, find conflict-free times, or add the instructor/venue only).<br/>
                Images cannot be imported.
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
                        background:'var(--danger-bg)', color:'var(--danger-fg)',
                        fontSize:'.72rem', fontWeight:600,
                      }}>NOT IMPORTABLE</span>
                    )}
                    {stagedFormat === null && (
                      <span style={{
                        marginLeft:8, padding:'1px 8px', borderRadius:10,
                        background:'var(--warn-bg)', color:'var(--warn-fg)',
                        fontSize:'.72rem', fontWeight:600,
                      }}>UNSUPPORTED TYPE</span>
                    )}
                  </div>
                )}
              </div>

              {importing && (
                <div style={{textAlign:'center',color:'var(--teal-500)',padding:'8px',fontSize:'.85rem'}}>
                  Importing…
                </div>
              )}

              {importResult && (
                <div style={{
                  /* NEW-FU-631 (audit): theme tokens so the result box matches dark mode
                     (was hardcoded light #fee2e2/#dcfce7 — a light panel inside a dark modal). */
                  background: importResult.errors?.length ? 'var(--danger-bg)' : 'var(--success-bg)',
                  border: `1px solid ${importResult.errors?.length ? 'var(--danger-fg)' : 'var(--success-fg)'}`,
                  borderRadius:8, padding:'10px 12px', fontSize:'.8rem',
                }}>
                  {/* NEW-FU-661: the icon + header reflect the OUTCOME — a pure rejection
                      (nothing imported, ≥1 error) shows an alert icon and "Import canceled",
                      not a misleading check + "0 section(s) imported". Partial/clean imports
                      keep the count summary. */}
                  <div style={{fontWeight:600, marginBottom:4,
                    color: importResult.errors?.length ? 'var(--danger-fg)' : 'inherit'}}>
                    <Ico name={importResult.errors?.length ? 'alert' : 'check'} />{' '}
                    {importResult.created === 0 && importResult.errors?.length
                      ? "Couldn't import this file"
                      : <>{importResult.created} section(s) imported
                          {importResult.skipped ? ` · ${importResult.skipped} duplicate(s) skipped` : ''}
                          {importResult.errors?.length ? ` · ${importResult.errors.length} error(s)` : ''}</>}
                  </div>
                  {importResult.errors?.map((e,i) => (
                    <div key={i} style={{color:'var(--danger-fg)',fontSize:'.75rem'}}>{e}</div>
                  ))}
                </div>
              )}

              {/* NEW-FU-660: scoped-merge conflict dialog. Merging this instructor/venue
                  would clash with what's already scheduled — let the user choose how. */}
              {decision && !importing && (
                <div style={{
                  background:'var(--warn-bg)', border:'1px solid var(--warn-fg)',
                  borderRadius:8, padding:'12px 14px', marginTop:12,
                }}>
                  <div style={{fontWeight:700, fontSize:'.86rem', color:'var(--warn-fg)', marginBottom:4}}>
                    Merging {decision.scope} “{decision.entity}” causes {decision.conflictCount} conflict(s)
                  </div>
                  <div style={{fontSize:'.76rem', color:'var(--text-secondary)', marginBottom:10}}>
                    {decision.courseCount} class group(s) in this file. Choose how to add it:
                    {decision.conflictSummaries?.length ? (
                      <ul style={{margin:'4px 0 0', paddingLeft:18}}>
                        {decision.conflictSummaries.map((s,i)=>(
                          <li key={i} style={{fontSize:'.72rem'}}>{s}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <div style={{display:'flex', flexDirection:'column', gap:8}}>
                    {decisionOptions.map(opt => (
                      <button
                        key={opt.mode}
                        type="button"
                        onClick={() => handleImport(opt.mode)}
                        style={{
                          textAlign:'left', padding:'9px 12px', borderRadius:8, cursor:'pointer',
                          background:'var(--bg-elevated)', border:'1.5px solid var(--slate-200)',
                          display:'flex', flexDirection:'column', gap:2,
                        }}
                      >
                        <span style={{fontWeight:600, fontSize:'.82rem', color:'var(--fg)'}}>{opt.title}</span>
                        <span style={{fontSize:'.72rem', color:'var(--slate-500)'}}>{opt.desc}</span>
                      </button>
                    ))}
                    <button type="button" className="sm-btn-cancel" style={{alignSelf:'flex-start', marginTop:2}}
                      onClick={() => setDecision(null)}>Cancel merge</button>
                  </div>
                </div>
              )}

              <div className="sm-actions" style={{marginTop:12}}>
                <button className="sm-btn-cancel" onClick={onClose}>Close</button>
                <button
                  className="sm-btn-save"
                  onClick={() => handleImport()}
                  disabled={!stagedFile || importing || stagedFormat === 'image' || stagedFormat === null || !!decision}
                  style={(!stagedFile || stagedFormat === 'image' || stagedFormat === null)
                    ? { background:'var(--slate-200)', borderColor:'var(--slate-200)', color:'var(--slate-500)' }
                    : undefined}
                >
                  {importing ? 'Importing…' : 'Import →'}
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
