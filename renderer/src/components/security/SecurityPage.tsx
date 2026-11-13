import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileCode, RefreshCw, Search, Shield, Square, Trash2, X } from 'lucide-react';
import type { SecurityAPI, SecurityExportFormat, SecurityFinding, SecurityMode, SecurityReport, SecurityReview, SecurityState, SecurityTriage } from '../../../../src/api/security';
import { ConfirmDialog } from '../ConfirmDialog';
import { sameSecurityReview, securityReviewDraftKey, securityReviewDrafts, type SecurityReviewDraft } from '../../lib/securityReviewDrafts';

const button = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-3 disabled:opacity-40';
const field = 'rounded-md border border-line bg-surface-2 px-2.5 py-2 text-xs text-ink';
const clean = (cause: unknown) => (cause instanceof Error ? cause.message : 'The operation failed.').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
const time = (value: number) => new Date(value).toLocaleString();

function FindingEditor({ finding, draftKey, busy, onSave, onOpenFile }: { finding: SecurityFinding; draftKey: string; busy: boolean; onSave(value: SecurityReview, expected: SecurityReview): Promise<SecurityFinding | null>; onOpenFile(path: string, line: number): void }) {
  const [stored, setStored] = useState(() => securityReviewDrafts.read(draftKey));
  const mounted = useRef(false), inFlight = useRef(false), latest = useRef(stored);
  latest.current = stored;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current: SecurityReview = { status: finding.status, note: finding.note };
  const draft = stored.draft, value = draft?.value ?? current;
  const conflict = !!draft && !sameSecurityReview(draft.base, current);
  const persist = (next: SecurityReviewDraft | null) => setStored(securityReviewDrafts.write(draftKey, next));
  const edit = (value: SecurityReview) => {
    const base = draft?.base ?? current;
    // Persist inside the edit event, before navigation can unmount this editor.
    persist(sameSecurityReview(base, value) && sameSecurityReview(base, current) ? null : { version: 1, base, value });
  };
  const save = async () => {
    if (!draft || conflict || busy || inFlight.current || stored.unreadable) return;
    inFlight.current = true;
    try {
      if (!await onSave(draft.value, draft.base)) return;
      const cleared = securityReviewDrafts.clear(draftKey, draft);
      if (mounted.current && latest.current.draft === draft) setStored(cleared);
    } finally { inFlight.current = false; }
  };
  return <section className="rounded-lg border border-line bg-surface-2 p-4" aria-label="Finding review">
    <h3 className="text-sm font-medium text-ink">{finding.description}</h3><p className="mt-1 break-all font-mono text-[11px] text-ink-3">{finding.file}:{finding.line}</p>
    <p className="mt-2 text-xs text-ink-3">Rule: {finding.rule} · {finding.severity} · {finding.mode === 'secrets' ? 'Matched credentials are omitted from reports.' : 'Review the source before deciding whether this is a vulnerability.'}</p>
    <button type="button" className={`${button} mt-3`} onClick={() => onOpenFile(finding.file, finding.line)}><FileCode size={13} />Open source</button>
    {stored.error && <div role="alert" className="mt-3 space-y-2 text-xs text-danger"><p>{stored.error}</p><button type="button" className={button} disabled={busy} onClick={() => setStored(stored.unreadable ? securityReviewDrafts.read(draftKey) : securityReviewDrafts.write(draftKey, draft))}>{stored.unreadable ? 'Retry recovery' : 'Retry draft storage'}</button></div>}
    <label className="mt-4 block text-xs text-ink-2">Status<select className={`${field} ml-3`} value={value.status} disabled={busy || stored.unreadable} onChange={(event) => edit({ ...value, status: event.target.value as SecurityTriage })}><option value="open">Open</option><option value="dismissed">Dismissed</option><option value="resolved">Resolved</option></select></label>
    <label className="mt-4 block text-xs text-ink-2">Review notes<textarea rows={4} maxLength={1000} value={value.note} disabled={busy || stored.unreadable} onChange={(event) => edit({ ...value, note: event.target.value })} className={`${field} mt-1 block w-full`} /></label>
    {draft && <p role="status" className="mt-2 text-[11px] text-ink-3">Unsaved draft. It stays on this device when you leave this page{stored.error ? '.' : ' or restart Antimatter.'} Save review applies it to this report.</p>}
    {conflict && <div role="alert" className="mt-3 space-y-2 text-xs text-warning"><p>The saved review changed after this draft began. Compare it with your draft before saving.</p><p>Saved status: {finding.status}</p><p className="whitespace-pre-wrap break-words">Saved notes: {finding.note || '(No notes)'}</p><button type="button" className={button} disabled={busy} onClick={() => persist({ ...draft!, base: current })}>Keep my draft</button></div>}
    <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || !draft || conflict || stored.unreadable || sameSecurityReview(value, current)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save review'}</button>
      {(draft || stored.unreadable) && <button type="button" className={button} disabled={busy} onClick={() => persist(null)}>Discard draft</button>}</div>
    <p className="mt-3 text-[11px] text-ink-3">A resolved finding reopens if a later scan still finds it. Dismissals carry forward only while the file is unchanged.</p>
  </section>;
}

interface SecurityPageProps { api: SecurityAPI; threadId: string; workspace: string | null; onClose(): void; onOpenFile(path: string, line: number): void }
export function SecurityPage(props: SecurityPageProps) {
  return <WorkspaceSecurityPage key={`${props.threadId}:${props.workspace ?? ''}`} {...props} />;
}
function WorkspaceSecurityPage({ api, threadId, workspace, onClose, onOpenFile }: SecurityPageProps) {
  const [state, setState] = useState<SecurityState>({ reports: [], running: null });
  const [selected, setSelected] = useState(''); const [findingId, setFindingId] = useState('');
  const [modes, setModes] = useState<SecurityMode[]>(['secrets', 'code']);
  const [search, setSearch] = useState(''); const [status, setStatus] = useState<SecurityTriage | 'all'>('open');
  const [severity, setSeverity] = useState('all'); const [limit, setLimit] = useState(200);
  const [format, setFormat] = useState<SecurityExportFormat>('sarif');
  const [loading, setLoading] = useState(false); const [scanning, setScanning] = useState(false); const [saving, setSaving] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [removing, setRemoving] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!workspace) return;
    const current = generation.current; setLoading(true);
    try { const next = await api.list(threadId); if (current === generation.current) { setState(next); setSelected((id) => next.reports.some((report) => report.id === id) ? id : next.reports[0]?.id ?? ''); } }
    catch (cause) { if (current === generation.current) setError(clean(cause)); }
    finally { if (current === generation.current) setLoading(false); }
  }, [api, threadId, workspace]);
  useEffect(() => {
    generation.current++; setState({ reports: [], running: null }); setSelected(''); setFindingId(''); setError(''); setNotice(''); setScanning(false);
    void refresh(); const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
    return () => { generation.current++; window.clearInterval(timer); };
  }, [refresh]);
  const report = state.reports.find((report) => report.id === selected) ?? null;
  const running = scanning || !!state.running;
  const findings = (report?.findings ?? []).filter((finding) => (status === 'all' || finding.status === status) && (severity === 'all' || finding.severity === severity)
    && `${finding.file} ${finding.description} ${finding.rule}`.toLowerCase().includes(search.trim().toLowerCase()));
  const focused = report?.findings.find((finding) => finding.id === findingId);
  const replace = (report: SecurityReport) => setState((current) => ({ ...current, reports: current.reports.some((entry) => entry.id === report.id)
    ? current.reports.map((entry) => entry.id === report.id ? report : entry) : [report, ...current.reports].slice(0, 10) }));
  const scan = async () => {
    const current = generation.current; setScanning(true); setError(''); setNotice('');
    try { const result = await api.scan(threadId, { modes }); if (current === generation.current) { replace(result); setSelected(result.id); setFindingId(''); setState((value) => ({ ...value, running: null })); } }
    catch (cause) { if (current === generation.current) setError(clean(cause)); }
    finally { if (current === generation.current) { setScanning(false); void refresh(); } }
  };
  const save = async (value: SecurityReview, expected: SecurityReview): Promise<SecurityFinding | null> => {
    if (!report || !focused) return null; const current = generation.current; setSaving(true); setError('');
    try { const result = await api.triage(threadId, { reportId: report.id, findingId: focused.id, ...value, expected }); if (current === generation.current) replace(result); return result.findings.find((entry) => entry.id === focused.id) ?? null; }
    catch (cause) { if (current === generation.current) { setError(clean(cause)); void refresh(); } return null; }
    finally { if (current === generation.current) setSaving(false); }
  };
  const exportReport = async () => {
    if (!report) return; const current = generation.current; setSaving(true); setError('');
    try { const result = await api.exportReport(threadId, report.id, format); if (result.path && current === generation.current) setNotice(`Saved ${result.path}`); }
    catch (cause) { if (current === generation.current) setError(clean(cause)); }
    finally { if (current === generation.current) setSaving(false); }
  };
  return <div className="absolute inset-0 flex flex-col bg-surface">
    <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3"><Shield size={17} className="text-primary" /><h1 className="mr-auto text-sm font-semibold">Security</h1>
      <button type="button" className={button} disabled={loading || !workspace} onClick={() => void refresh()}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} />Refresh</button>
      <button type="button" className={button} onClick={onClose}><X size={13} />Done</button></header>
    <div className="min-h-0 flex-1 overflow-y-auto p-5"><div className="mx-auto max-w-6xl space-y-4">
      <section className="rounded-lg border border-line bg-surface-2 p-4"><p className="break-all text-xs text-ink-3">{workspace ?? 'Choose a chat workspace before scanning.'}</p>
        <div className="mt-3 flex flex-wrap items-center gap-4">{(['secrets', 'code'] as const).map((mode) => <label key={mode} className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={modes.includes(mode)} disabled={running} onChange={(event) => setModes((current) => event.target.checked ? [...current, mode] : current.filter((entry) => entry !== mode))} />{mode === 'secrets' ? 'Credentials and secrets' : 'Risky code patterns'}</label>)}
          {running ? <button type="button" className={button} onClick={() => { const current = generation.current; void api.cancel(threadId).catch((cause) => { if (current === generation.current) setError(clean(cause)); }); }}><Square size={12} />Cancel scan</button>
            : <button type="button" className={`${button} ml-auto`} disabled={!workspace || !modes.length} onClick={() => void scan()}><Shield size={13} />Scan workspace</button>}</div>
        <p className="mt-3 text-[11px] leading-5 text-ink-3">Local, read-only checks. Project scripts are never run. Scans cover text files up to 512 KiB, with limits of 20,000 files, 64 MiB, 2,000 findings, and one minute. Generated folders are excluded. The last 10 reports are kept per project.</p>
        {running && <p role="status" className="mt-2 text-xs text-primary">Scanning…</p>}
      </section>
      {error && <p role="alert" className="rounded border border-danger/40 p-3 text-xs text-danger">{error}</p>}
      {notice && <p role="status" className="break-all text-xs text-ink-2">{notice}</p>}
      {state.reports.length > 0 ? <>
        <div className="flex flex-wrap items-center gap-2"><label className="min-w-0 flex-1 text-xs text-ink-3">Report<select aria-label="Security report" className={`${field} ml-2 max-w-full`} value={selected} onChange={(event) => { setSelected(event.target.value); setFindingId(''); }}>
          {state.reports.map((report) => <option key={report.id} value={report.id}>{time(report.completedAt)} · {report.findings.length} findings{report.cancelled ? ' · cancelled' : report.truncated ? ' · incomplete' : ''}</option>)}</select></label>
          <select aria-label="Report format" className={field} value={format} onChange={(event) => setFormat(event.target.value as SecurityExportFormat)}><option value="sarif">SARIF</option><option value="json">JSON</option><option value="markdown">Markdown</option></select>
          <button type="button" className={button} disabled={saving || !report} onClick={() => void exportReport()}><Download size={13} />Export</button>
          <button type="button" className={button} disabled={saving || !report} onClick={() => setRemoving(true)}><Trash2 size={13} />Remove report</button></div>
        {report && <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[['Open', report.findings.filter((finding) => finding.status === 'open').length], ['High severity', report.findings.filter((finding) => finding.severity === 'high' && finding.status === 'open').length], ['Files scanned', report.scannedFiles], ['Files skipped', report.skippedFiles]].map(([label, count]) => <div key={label} className="rounded-lg border border-line p-3"><p className="text-xl font-semibold">{count}</p><p className="mt-1 text-xs text-ink-3">{label}</p></div>)}</div>
          <details open={report.cancelled || report.truncated || report.skippedFiles > 0 || report.skippedLines > 0} className="rounded-lg border border-line p-3 text-xs text-ink-3"><summary className="cursor-pointer">Scan coverage{report.cancelled || report.truncated ? ' · incomplete' : ''}</summary><ul className="mt-2 list-inside list-disc space-y-1">{report.limitations.map((line) => <li key={line}>{line}</li>)}</ul></details>
          <div className="flex flex-wrap gap-2"><label className="flex min-w-48 flex-1 items-center gap-2"><Search size={14} className="text-ink-3" /><input aria-label="Filter security findings" placeholder="Filter findings" className={`${field} w-full`} value={search} onChange={(event) => { setSearch(event.target.value); setLimit(200); }} /></label>
            <select aria-label="Finding status" className={field} value={status} onChange={(event) => { setStatus(event.target.value as SecurityTriage | 'all'); setLimit(200); }}><option value="all">All statuses</option><option value="open">Open</option><option value="dismissed">Dismissed</option><option value="resolved">Resolved</option></select>
            <select aria-label="Finding severity" className={field} value={severity} onChange={(event) => { setSeverity(event.target.value); setLimit(200); }}><option value="all">All severities</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div>
          <div className={`grid items-start gap-4 ${focused ? 'xl:grid-cols-[minmax(0,1fr)_340px]' : ''}`}><div className="min-w-0 rounded-lg border border-line">
            {findings.length ? <><ul className="divide-y divide-line">{findings.slice(0, limit).map((finding) => <li key={finding.id}><button type="button" data-finding={finding.id} onClick={() => setFindingId(finding.id)} className={`block w-full px-4 py-3 text-left hover:bg-surface-2 ${focused?.id === finding.id ? 'bg-surface-3' : ''}`}>
              <span className="flex items-center gap-2 text-xs"><span className={finding.severity === 'high' ? 'text-danger' : 'text-ink-3'}>{finding.severity}</span><span className="min-w-0 flex-1 truncate text-ink">{finding.description}</span><span className="text-ink-3">{finding.status}</span></span><span className="mt-1 block truncate font-mono text-[11px] text-ink-3">{finding.file}:{finding.line}</span></button></li>)}</ul>
              {findings.length > limit && <button type="button" className={`${button} m-3`} onClick={() => setLimit((value) => value + 200)}>Show more ({findings.length - limit})</button>}</>
              : <p className="p-5 text-sm text-ink-3">{report.findings.length ? 'No findings match these filters.' : 'No patterns matched in the scanned files. Review scan coverage for skipped content.'}</p>}
          </div>{focused && workspace && <FindingEditor key={`${report.id}:${focused.id}`} finding={focused} draftKey={securityReviewDraftKey(workspace, report.id, focused.id)} busy={saving} onSave={save} onOpenFile={onOpenFile} />}</div>
        </>}
      </> : !running && <p className="py-8 text-center text-sm text-ink-3">No saved scans for this project.</p>}
    </div></div>
    {removing && report && <ConfirmDialog title="Remove this report?" message="This removes the saved scan and its review notes. Project files are unchanged." confirmLabel="Remove report" tone="danger" onCancel={() => setRemoving(false)} onConfirm={() => {
      const current = generation.current; setRemoving(false); void api.remove(threadId, report.id).then(() => { if (current === generation.current) { setFindingId(''); void refresh(); } }).catch((cause) => { if (current === generation.current) setError(clean(cause)); });
    }} />}
  </div>;
}
