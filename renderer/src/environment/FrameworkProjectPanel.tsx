import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FileJson2, FolderOpen, FolderPlus, RefreshCw, Settings2, X } from 'lucide-react';
import { actions, useEnvironment } from './store';
import { NEW_FRAMEWORK_PROJECT_EVENT, openCodeFolder, type ProjectStarter } from './workspaceUi';

const button = 'inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40';
const field = 'min-w-0 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink focus:border-primary focus:outline-none';
const readable = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
const defaultName = (language: ProjectStarter) => language === 'mixed' ? 'nil-project' : `${language}-project`;

export function FrameworkProjectPanel() {
  const state = useEnvironment();
  const [creating, setCreating] = useState(false);
  const [language, setLanguage] = useState<ProjectStarter>('ny');
  const [name, setName] = useState('ny-project');
  const [sdkOpen, setSdkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const root = useRef(state.root); root.current = state.root;
  const working = busy || state.busy || state.workspaceSwitching || !!state.pendingWorkspace || !!state.task || state.nyBuilding || (!!state.run && !state.run.exit) || state.debug.phase !== 'stopped';
  const status = state.sdk;
  useEffect(() => {
    const open = (event: Event) => {
      const starter = (event as CustomEvent<ProjectStarter>).detail;
      if (!['ny', 'matrix', 'mixed'].includes(starter)) return;
      setLanguage(starter); setName(defaultName(starter)); setCreating(true); setError('');
    };
    window.addEventListener(NEW_FRAMEWORK_PROJECT_EVENT, open);
    return () => window.removeEventListener(NEW_FRAMEWORK_PROJECT_EVENT, open);
  }, []);
  useEffect(() => { setError(''); }, [state.root]);
  const changeLanguage = (next: ProjectStarter) => {
    if (name === defaultName(language)) setName(defaultName(next));
    setLanguage(next);
  };
  const sdkAction = async (kind: 'choose' | 'restart') => {
    setBusy(true); setError(''); const previous = root.current;
    try {
      const next = await window.electronAPI.ny[kind === 'choose' ? 'chooseSdk' : 'restart']();
      if (next) {
        window.dispatchEvent(new Event('antimatter:ny-sdk-changed'));
        await actions.refreshProject();
      }
    } catch (reason) { if (root.current === previous) setError(readable(reason)); }
    finally { setBusy(false); }
  };
  const create = async () => {
    setBusy(true); setError('');
    try { if (await actions.createProject(name.trim(), language)) setCreating(false); }
    catch (reason) { setError(readable(reason)); }
    finally { setBusy(false); }
  };
  const validName = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/.test(name.trim());

  return <section aria-label="NIL Framework project" className="shrink-0 border-b border-line bg-surface-2">
    <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
      <div className="mr-auto flex min-w-0 flex-1 items-center gap-2">
        <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">Code</span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-ink">{state.project?.name ?? (state.root.split('/').filter(Boolean).pop() || 'NIL Framework')}</p>
          <p className="truncate text-[10px] text-ink-3">{state.projectLoading ? 'Reading project…' : state.project ? `${state.project.language === 'matrix' ? 'Matrix' : 'Ny'} entrypoint · NIL Framework` : 'Folder workspace'}</p>
        </div>
      </div>
      <button type="button" className={button} disabled={working} onClick={() => { setCreating(!creating); setError(''); }} aria-expanded={creating}><FolderPlus size={12} />New project</button>
      <button type="button" className={button} disabled={working} onClick={() => void openCodeFolder()}><FolderOpen size={12} />{state.boundThreadId ? 'Change chat folder' : 'Open folder'}</button>
      <button type="button" className={`${button} ${sdkOpen ? 'border-primary/60 text-primary' : ''}`} disabled={working} onClick={() => setSdkOpen(!sdkOpen)} aria-expanded={sdkOpen} title={status?.sdkPath ?? 'Configure the NIL Framework SDK'}><Settings2 size={12} />SDK<ChevronDown size={10} className={sdkOpen ? 'rotate-180' : ''} /></button>
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-line-soft px-3 py-1.5 text-[10px] text-ink-3"><span className="shrink-0">{state.boundThreadId ? `Chat: ${state.boundChatTitle || 'Untitled chat'}` : 'Folder workspace'}</span><span className="min-w-0 flex-1 truncate font-mono" title={state.root}>{state.root || 'No folder available'}</span></div>
    {status && !status.compiler && !sdkOpen && <div className="flex flex-wrap items-center gap-2 border-t border-warning/30 bg-warning/10 px-3 py-1.5 text-[11px] text-warning"><p className="flex-1">Choose a NIL Framework SDK to enable checking, builds and debugging.</p><button type="button" disabled={working} onClick={() => void sdkAction('choose')} className="font-medium hover:underline">Choose SDK</button></div>}
    {creating && <form className="border-t border-line-soft px-3 py-3" aria-label="New NIL Framework project" onSubmit={event => { event.preventDefault(); if (validName && !working) void create(); }}>
      <div className="mb-2 flex items-center gap-2"><p className="flex-1 text-xs font-medium text-ink">Create a runnable project</p><button type="button" className="rounded p-1 text-ink-3 hover:text-ink" onClick={() => setCreating(false)} disabled={busy} aria-label="Close new project"><X size={12} /></button></div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[130px] flex-1 flex-col gap-1 text-[10px] text-ink-3">Language<select aria-label="Project language" value={language} onChange={event => changeLanguage(event.target.value as ProjectStarter)} disabled={working} className={field}><option value="ny">Ny</option><option value="matrix">Matrix</option><option value="mixed">Ny + Matrix</option></select></label>
        <label className="flex min-w-[150px] flex-[2] flex-col gap-1 text-[10px] text-ink-3">Project name<input aria-label="Project name" autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={80} spellCheck={false} disabled={working} className={field} /></label>
        <button type="submit" disabled={working || !validName} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary disabled:opacity-40"><FolderPlus size={13} />Choose folder & create</button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">Creates a new folder with <span className="font-mono">nil.project.json</span>, source and a README. {language === 'mixed' ? 'Matrix calls a Ny module in the same project.' : 'Ready to check, build, run and debug on the NIL VM.'}</p>
      {!validName && name.length > 0 && <p className="mt-1 text-[10px] text-warning">Use letters, numbers, spaces, underscores or hyphens; omit the source extension.</p>}
    </form>}
    {sdkOpen && <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3 py-2 text-[11px]">
      <div className="min-w-[160px] flex-1"><p className={status?.compiler ? 'text-ink-2' : 'text-warning'}>{status?.message ?? 'Finding the NIL Framework SDK…'}</p>{status?.sdkPath && <p className="mt-0.5 truncate font-mono text-[10px] text-ink-3" title={status.sdkPath}>{status.sdkPath}</p>}</div>
      <button type="button" className={button} disabled={working} onClick={() => void sdkAction('choose')}><Settings2 size={12} />Choose SDK</button>
      <button type="button" className={button} disabled={working || !status?.lsp} onClick={() => void sdkAction('restart')}><RefreshCw size={12} />Restart language tools</button>
    </div>}
    {state.projectError && <div role="alert" className="flex items-start gap-2 border-t border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger"><FileJson2 size={13} className="mt-0.5 shrink-0" /><p className="flex-1">{state.projectError}</p><button type="button" className="shrink-0 hover:underline" disabled={working} onClick={() => void actions.refreshProject()}>Refresh</button></div>}
    {error && <p role="alert" className="border-t border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">{error}</p>}
  </section>;
}
