import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, FileCode2, ListTree, PanelBottom, Waypoints, X } from 'lucide-react';
import { beginDrag } from '../plugins/drag';
import { CodeEditor } from './CodeEditor';
import { ConsolePane } from './ConsolePane';
import { Toolbar } from './Toolbar';
import { FrameworkProjectPanel } from './FrameworkProjectPanel';
import { NilInspector } from './NilInspector';
import { NyOutline } from './NyOutline';
import { CodeWelcome } from './CodeWelcome';
import { NativeProjectControls, useNativeProject } from './NativeProjectControls';
import { ProjectBoard } from './ProjectBoard';
import { CODE_PANE_EVENT } from './workspaceUi';
import { actions, isDirty, useEnvironment, type CodeWorkspaceContext } from './store';

/** Code keeps source at the center, with project commands above and task results below. */
const MIN_CONSOLE = 100;
const MIN_EDITOR = 160;

interface Props {
  onLeave(): void;
  workspaceContext?: CodeWorkspaceContext;
  onChooseWorkspace?(): Promise<string | null>;
  onBindWorkspace?(path: string): Promise<string | null>;
}

export function EnvironmentPage({ onLeave, workspaceContext, onChooseWorkspace, onBindWorkspace }: Props) {
  const state = useEnvironment();
  const [consoleHeight, setConsoleHeight] = useState(200);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [outline, setOutline] = useState(true);
  const [closing, setClosing] = useState<string | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const editorHost = useRef<HTMLDivElement>(null);
  const consoleHost = useRef<HTMLDivElement>(null);
  const file = state.files.find((entry) => entry.path === state.activePath) ?? null;
  const native = useNativeProject(state.root, state.activePath);
  useLayoutEffect(() => {
    if (!workspaceContext || !onChooseWorkspace || !onBindWorkspace) return;
    void actions.followWorkspace(workspaceContext, { chooseWorkspace: onChooseWorkspace, bindWorkspace: onBindWorkspace });
  }, [workspaceContext?.threadId, workspaceContext?.path, workspaceContext?.title, workspaceContext?.available,
    workspaceContext?.reason, workspaceContext?.ready, onChooseWorkspace, onBindWorkspace]);
  const source = !!file && /\.(ny|matrix|mat)$/i.test(file.path);

  useEffect(() => { setClosing(null); }, [state.root]);
  useEffect(() => {
    const reveal = () => setConsoleOpen(true);
    window.addEventListener(CODE_PANE_EVENT, reveal);
    return () => window.removeEventListener(CODE_PANE_EVENT, reveal);
  }, []);
  useEffect(() => { if (state.debug.phase !== 'stopped' || state.nyBuilding) setConsoleOpen(true); }, [state.debug.phase, state.nyBuilding]);
  const consoleCeiling = () => Math.max(MIN_CONSOLE, (editorHost.current?.clientHeight ?? MIN_EDITOR) + (consoleHost.current?.clientHeight ?? consoleHeight) - MIN_EDITOR);
  const resizeConsole = (height: number, ceiling = consoleCeiling()) => setConsoleHeight(Math.min(Math.max(MIN_CONSOLE, height), ceiling));

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Code workspace">
    <FrameworkProjectPanel nativeProject={native.project} />
    {state.pendingWorkspace && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-ink" role="alert">
      <span className="min-w-0 flex-1">{!state.pendingWorkspace.ready ? 'Finding this chat’s folder…' : <>Code is still open in <strong>{state.boundChatTitle || 'the previous folder'}</strong>. {state.files.some(isDirty) ? 'Keep your unsaved changes before switching' : 'Stop the current task before switching'} to <strong>{state.pendingWorkspace.title || 'the active chat'}</strong>.</>}</span>
      {state.pendingWorkspace.ready && <>
        <button type="button" disabled={state.busy || state.workspaceSwitching} className="rounded bg-primary px-2 py-1 text-on-primary disabled:opacity-40" onClick={() => void actions.switchWorkspace('save')}>{state.files.some(isDirty) ? 'Save & switch' : 'Stop & switch'}</button>
        {state.files.some(isDirty) && <button type="button" disabled={state.busy || state.workspaceSwitching} className="rounded border border-line px-2 py-1 text-ink-2 disabled:opacity-40" onClick={() => void actions.switchWorkspace('discard')}>Discard & switch</button>}
        <button type="button" className="px-2 py-1 text-ink-2" onClick={onLeave}>Back to chat</button>
      </>}
    </div>}
    {state.workspaceUnavailable && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning"><p className="flex-1">{state.workspaceUnavailable}</p><button type="button" disabled={state.busy || state.workspaceSwitching} onClick={() => void actions.chooseFolder()} className="font-medium hover:underline">Choose chat folder</button></div>}
    <div className="flex min-w-0 shrink-0 items-center border-b border-line bg-surface-2">
      <button type="button" onClick={onLeave} title="Back to chat" className="flex shrink-0 items-center gap-1 border-r border-line px-2.5 py-2 text-[11px] text-ink-2 transition hover:bg-surface-3 hover:text-ink"><ArrowLeft size={12} />Chat</button>
      <div className="flex min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="Open files">
        {state.files.length === 0 ? <span className="px-3 py-2 text-[11px] text-ink-3">Welcome</span> : state.files.map(entry => {
          const selected = entry.path === state.activePath;
          const dirty = isDirty(entry);
          return <div key={entry.path} className={`group flex min-w-0 shrink-0 items-center gap-1 border-r border-t-2 border-line px-2 py-1.5 text-[11px] transition ${selected ? 'border-t-primary bg-surface text-ink' : 'border-t-transparent text-ink-3 hover:bg-surface-3/60 hover:text-ink-2'}`}>
            <button type="button" role="tab" aria-selected={selected} onClick={() => actions.select(entry.path)} className="flex min-w-0 items-center gap-1.5" title={entry.path}><FileCode2 size={11} className={selected ? 'text-primary' : ''} /><span className="max-w-[180px] truncate">{entry.path.split('/').pop()}</span></button>
            <button type="button" aria-label={`Close ${entry.path}`} title={dirty ? 'Unsaved changes' : 'Close file'} onClick={() => dirty ? setClosing(entry.path) : actions.close(entry.path)} className="rounded p-0.5 text-ink-3 transition hover:text-ink">
              {dirty && <span className="block size-1.5 rounded-full bg-primary group-hover:hidden" />}<X size={10} className={dirty ? 'hidden group-hover:block' : ''} />
            </button>
          </div>;
        })}
      </div>
    </div>
    <NativeProjectControls native={native} />
    <Toolbar native={native.context} loading={native.loading} />
    <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-line-soft bg-surface px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-3" title={file?.path ?? state.root}>{file?.path ?? (state.root || 'No folder open')}</span>
      <button type="button" aria-pressed={boardOpen} aria-label={boardOpen ? 'Show source editor' : 'Show project board'} disabled={!state.root} onClick={() => setBoardOpen(!boardOpen)} className={`inline-flex items-center gap-1 text-[10px] ${boardOpen ? 'text-primary' : 'text-ink-3'} hover:text-ink disabled:opacity-40`}><Waypoints size={12} />{boardOpen ? 'Source' : 'Board'}</button>
      {source && <button type="button" aria-pressed={outline} onClick={() => setOutline(!outline)} className={`inline-flex items-center gap-1 text-[10px] ${outline ? 'text-primary' : 'text-ink-3'} hover:text-ink`}><ListTree size={12} />Outline</button>}
      <button type="button" aria-pressed={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)} className={`inline-flex items-center gap-1 text-[10px] ${consoleOpen ? 'text-primary' : 'text-ink-3'} hover:text-ink`}><PanelBottom size={12} />Panels</button>
    </div>
    {closing && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-ink" role="alert">
      <span className="min-w-0 flex-1">Save changes to <span className="font-mono">{closing}</span> before closing?</span>
      <button type="button" className="rounded bg-primary px-2 py-1 text-on-primary" onClick={async () => { const path = closing; if (await actions.save(path)) { actions.close(path); setClosing(null); } }}>Save & close</button>
      <button type="button" className="rounded border border-line px-2 py-1 text-ink-2" onClick={() => { actions.close(closing); setClosing(null); }}>Discard</button>
      <button type="button" className="px-2 py-1 text-ink-2" onClick={() => setClosing(null)}>Keep open</button>
    </div>}
    {state.error && <button type="button" onClick={() => actions.clearError()} title="Dismiss error" className="shrink-0 border-b border-danger/40 bg-danger/10 px-3 py-2 text-left text-[11px] text-danger">{state.error}</button>}
    <div ref={editorHost} className="flex min-h-0 flex-1 overflow-hidden bg-surface">
      {state.root && <div className={`min-h-0 min-w-0 flex-1 ${boardOpen ? '' : 'hidden'}`}><ProjectBoard project={native.project} onOpenSource={() => setBoardOpen(false)} /></div>}
      <div className={`min-h-0 min-w-0 flex-1 ${boardOpen ? 'hidden' : 'flex'}`}>
      {file ? /\.nil$/i.test(file.path)
        ? <NilInspector key={`${state.root}:${file.path}`} path={file.path} refreshKey={file.modified} onReveal={(path, line) => void actions.reveal(path, line)} />
        : <><div className="min-w-0 flex-1"><CodeEditor key={state.root} file={file} /></div>{outline && source && <div className="w-56 max-w-[30%] shrink-0 border-l border-line"><NyOutline key={state.root} file={file} onReveal={(path, line) => void actions.reveal(path, line)} /></div>}</>
        : <CodeWelcome projectName={state.project?.name} entry={state.project?.entry.startsWith(`${state.root}/`) ? state.project.entry.slice(state.root.length + 1) : state.project?.entry} onOpenEntry={state.project ? () => void actions.openFile(state.project!.entry.startsWith(`${state.root}/`) ? state.project!.entry.slice(state.root.length + 1) : state.project!.entry) : undefined} />}
      </div>
    </div>
    {consoleOpen && <div role="separator" aria-label="Resize code panels" aria-orientation="horizontal" aria-valuemin={MIN_CONSOLE} aria-valuenow={consoleHeight} tabIndex={0} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); resizeConsole(consoleHeight + (event.key === 'ArrowUp' ? 24 : -24)); } }} onPointerDown={event => { const ceiling = consoleCeiling(); beginDrag(event, ({ dy }) => resizeConsole(consoleHeight - dy, ceiling)); }} className="h-1 shrink-0 cursor-row-resize bg-line transition-colors hover:bg-primary/60 focus-visible:bg-primary focus-visible:outline-none" title="Drag to resize panels" />}
    <div ref={consoleHost} className={`flex shrink-0 flex-col overflow-hidden ${consoleOpen ? '' : 'invisible'}`} style={{ height: consoleOpen ? consoleHeight : 0 }} aria-hidden={!consoleOpen}><ConsolePane /></div>
  </div>;
}
