import { useEffect, useState } from 'react';
import { Bug, CheckCheck, CircleStop, CornerDownRight, CornerUpLeft, FileJson2, Hammer, MessageSquareCode, Octagon, Pause, Play, RedoDot, Save, SkipForward } from 'lucide-react';
import { actions, active, isDirty, useEnvironment } from './store';
import { languageName } from './highlight';
import { cursor } from './editorBridge';
import { openCodeReviewSelection } from '../plugins/codeReview/selection';
import { showCodePane } from './workspaceUi';

const button = 'inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35';
const primary = 'inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-on-primary transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-40';
const relative = (path: string, root: string) => path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

export function Toolbar() {
  const state = useEnvironment();
  const file = active();
  const [fileDebuggable, setFileDebuggable] = useState(false);
  const source = !!file && /\.(ny|matrix|mat)$/i.test(file.path);
  const nil = !!file && /\.nil$/i.test(file.path);
  const framework = !!state.project || source || nil;
  const managedCommand = file && (source || nil) ? `ny run ${JSON.stringify(file.path)}` : '';
  const managed = !!state.project || (!!managedCommand && state.command === managedCommand);
  const running = !!state.task || state.nyBuilding || (!!state.run && !state.run.exit);
  const debugging = state.debug.phase !== 'stopped';
  const paused = state.debug.phase === 'paused';
  const working = running || debugging;
  const switching = state.workspaceSwitching || !!state.pendingWorkspace || !!state.workspaceUnavailable;
  const dirty = !!file && isDirty(file);
  const canCompile = !!state.sdk?.compiler && (!state.project || !!state.sdk.builder) && !state.projectError;
  const canRun = state.project ? canCompile && (state.target === 'native' || !!state.sdk?.interpreter)
    : managed ? nil ? !!state.sdk?.interpreter : canCompile && !!state.sdk?.interpreter : !!state.command.trim();
  const nativeDebug = !!state.project && state.target === 'native';
  const canDebug = framework ? !!state.sdk?.debugger && !nativeDebug && !state.projectError && (!state.project || canCompile) : fileDebuggable;

  useEffect(() => {
    let current = true; setFileDebuggable(false);
    if (!file || framework) return;
    void window.electronAPI.environment.debuggable(file.path).then(value => { if (current) setFileDebuggable(value); }).catch(() => {});
    return () => { current = false; };
  }, [state.root, file?.path, framework]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.repeat) return;
      const modifier = event.ctrlKey || event.metaKey;
      const idle = !working && !state.busy && !state.projectLoading;
      if (event.key === 'F5') {
        event.preventDefault();
        if (event.shiftKey) { if (working) void (debugging ? actions.debugStop() : actions.stop()); }
        else if (modifier) { if (idle && canRun) { showCodePane('output'); void actions.run(); } }
        else if (paused) void actions.step('resume');
        else if (idle && canDebug) { showCodePane('output'); void actions.debug(); }
      } else if (!modifier && (event.key === 'F10' || event.key === 'F11')) {
        event.preventDefault();
        if (paused) void actions.step(event.key === 'F10' ? 'stepOver' : event.shiftKey ? 'stepOut' : 'stepInto');
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        if (idle && canCompile && (state.project || source)) { showCodePane('output'); void actions.build(); }
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [working, debugging, paused, state.busy, state.projectLoading, state.project, source, canRun, canDebug, canCompile]);

  const status = paused ? 'Paused at breakpoint' : debugging ? state.debug.phase === 'starting' ? 'Starting debugger…' : 'Debugging'
    : state.task ? `${state.task === 'check' ? 'Checking' : state.task === 'build' ? 'Building' : 'Starting'}…`
    : state.nyBuilding ? 'Compiling…' : running ? `Running · pid ${state.run?.pid ?? '—'}`
    : state.run?.exit ? state.run.exit.signal ? 'Stopped' : `Exited ${state.run.exit.code}` : file ? languageName(file.path) : 'Ready';
  const context = state.project ? relative(state.project.entry, state.root) : file?.path ?? '';

  return <div className="shrink-0 border-b border-line bg-surface-2" aria-label="Build and run">
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 py-2">
      {working ? <button type="button" onClick={() => void (debugging ? actions.debugStop() : actions.stop())} className="inline-flex items-center gap-1.5 rounded-md bg-danger px-2.5 py-1.5 text-[11px] font-semibold text-on-danger"><CircleStop size={12} />Stop</button>
        : <button type="button" onClick={() => { showCodePane('output'); void actions.run(); }} disabled={!canRun || state.busy || state.projectLoading || switching} className={primary} title={state.project ? 'Run project — Ctrl+F5 (saves all files first)' : 'Run — Ctrl+F5 (saves files first)'}><Play size={12} />Run</button>}
      <button type="button" onClick={() => { showCodePane('output'); void actions.debug(); }} disabled={!canDebug || working || state.busy || state.projectLoading || switching} title={nativeDebug ? 'Source debugging uses the NIL VM. Select NIL VM to debug.' : canDebug ? 'Debug — F5 (saves files first)' : 'A compatible debugger is required for this language'} className={button}><Bug size={12} />Debug</button>
      {(state.project || source) && <>
        <button type="button" className={button} disabled={working || state.busy || !canCompile || state.projectLoading || switching} onClick={() => { showCodePane('output'); void actions.check(); }} title="Save all files and run compiler and analyzer checks"><CheckCheck size={12} />Check</button>
        <button type="button" className={button} disabled={working || state.busy || !canCompile || state.projectLoading || switching} onClick={() => { showCodePane('output'); void actions.build(); }} title="Build — Ctrl+Shift+B (saves all files first)"><Hammer size={12} />Build</button>
      </>}
      {state.project && <label className="ml-1 inline-flex items-center gap-1.5 text-[10px] text-ink-3">Target<select aria-label="Build target" value={state.target} disabled={working || state.busy} onChange={event => actions.setTarget(event.target.value as 'vm' | 'native')} className="rounded-md border border-line bg-surface px-1.5 py-1.5 text-[11px] text-ink focus:border-primary focus:outline-none"><option value="vm">NIL VM</option><option value="native">Native</option></select></label>}
      <span className="min-w-0 flex-1" />
      <button type="button" className={button} disabled={!file || dirty || file.binary} title={dirty ? 'Save this file before reviewing its code' : 'Review selected lines, or the whole saved file'} onClick={() => {
        if (!file || dirty) return;
        const selection = cursor();
        openCodeReviewSelection({ workspace: state.root, path: file.path, ...(selection?.selection ? { startLine: selection.from, endLine: Math.max(selection.from, selection.to - (selection.selection.endsWith('\n') ? 1 : 0)) } : {}) });
      }}><MessageSquareCode size={12} />Review</button>
      <button type="button" onClick={() => void actions.save()} disabled={!file || !dirty} title="Save current file" className={button}><Save size={12} />{dirty ? 'Save' : 'Saved'}</button>
    </div>
    {(context || !managed) && <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-line-soft px-3 py-1.5">
      {managed ? <>
        <span className="shrink-0 text-[10px] text-ink-3">{state.project ? 'Entry' : nil ? 'NIL artifact' : 'Source'}</span><span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-2" title={context}>{context}</span>
        {state.project ? <button type="button" className="inline-flex items-center gap-1 text-[10px] text-ink-3 hover:text-primary" onClick={() => void actions.openFile(relative(state.project!.projectFile, state.root))} title="Edit entrypoint, import paths and analyzer settings"><FileJson2 size={11} />Project settings</button>
          : <button type="button" className="text-[10px] text-ink-3 hover:text-primary" onClick={() => actions.setCommand('')} disabled={working}>Custom command</button>}
      </> : <>
        <input aria-label="Run command" value={state.command} onChange={event => actions.setCommand(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !working && state.command.trim()) { showCodePane('output'); void actions.run(); } }} disabled={working} placeholder="command to run" spellCheck={false} title="Runs in the open folder" className="min-w-[140px] flex-1 rounded border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none" />
        {managedCommand && <button type="button" className="text-[10px] text-ink-3 hover:text-primary" onClick={() => actions.setCommand(managedCommand)} disabled={working}>Use NIL runner</button>}
      </>}
      <span className={`shrink-0 text-[10px] ${paused || working ? 'text-primary' : state.run?.exit?.code ? 'text-danger' : 'text-ink-3'}`} role="status">{status}</span>
    </div>}
    {nativeDebug && <p className="border-t border-line-soft px-3 py-1 text-[10px] text-ink-3">Native builds run directly on the host. Select NIL VM for source debugging.</p>}
    {debugging && <div className="flex items-center gap-1.5 border-t border-line-soft px-3 py-1.5" aria-label="Debugger controls">
      <button type="button" onClick={() => void actions.debugPause()} disabled={state.debug.phase !== 'running'} title="Pause execution" aria-label="Pause execution" className={button}><Pause size={12} /></button>
      <button type="button" onClick={() => void actions.step('resume')} disabled={!paused} title="Continue" aria-label="Continue" className={button}><RedoDot size={12} /></button>
      <button type="button" onClick={() => void actions.step('stepOver')} disabled={!paused} title="Step over" aria-label="Step over" className={button}><SkipForward size={12} /></button>
      <button type="button" onClick={() => void actions.step('stepInto')} disabled={!paused} title="Step into" aria-label="Step into" className={button}><CornerDownRight size={12} /></button>
      <button type="button" onClick={() => void actions.step('stepOut')} disabled={!paused} title="Step out" aria-label="Step out" className={button}><CornerUpLeft size={12} /></button>
      {state.breakpoints.length > 0 && <button type="button" onClick={() => actions.clearBreakpoints()} title="Clear every breakpoint" className={`${button} ml-auto`}><Octagon size={11} className="text-danger" />{state.breakpoints.length} breakpoints</button>}
    </div>}
  </div>;
}
