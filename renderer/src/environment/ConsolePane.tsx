import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { AlertCircle, AlertTriangle, Braces, CheckCheck, Info, Layers, SearchCode, TerminalSquare } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { FONT_STACK } from '../plugins/terminal/session';
import { followTerminalAppearance, terminalThemeFor } from '../plugins/terminal/theme';
import { getAppearance } from '../appearance';
import { actions, useEnvironment } from './store';
import { CODE_PANE_EVENT, type CodePane } from './workspaceUi';

/**
 * The bottom pane: what the program printed, and what the debugger can see.
 *
 * The output half is a real terminal rather than a scrolling <pre>, because the processes it
 * shows are run under a pty and print terminal bytes — colour, carriage returns, progress bars.
 * Rendering those as text produces a mess of escape codes, and stripping them throws away most
 * of what a test runner is trying to tell you.
 */

type Tab = CodePane;

function Output() {
  const state = useEnvironment();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!host.current || term.current) return;

    const terminal = new Terminal({
      fontFamily: FONT_STACK,
      fontSize: 12,
      theme: terminalThemeFor(getAppearance()),
      cursorBlink: false,
      // Nothing types into this except a program asking for input; a block cursor implies more.
      cursorStyle: 'underline',
      scrollback: 10_000,
      convertEol: true,
    });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(host.current);
    addon.fit();

    term.current = terminal;
    fit.current = addon;
    const stopAppearance = followTerminalAppearance(terminal);

    // A program that prompts should be answerable without switching to the terminal panel.
    const typed = terminal.onData((data) => void window.electronAPI.environment.input(data));
    const stop = window.electronAPI.onEnvironmentOutput(({ data }) => terminal.write(data));
    const stopNative = window.electronAPI.nativeProject?.onProgress(({ output }) => terminal.write(output));
    const exited = window.electronAPI.onEnvironmentExit(({ code, signal }) => {
      const how = signal ? `signal ${signal}` : `exit ${code}`;
      terminal.write(`\r\n\x1b[2m— ${how} —\x1b[0m\r\n`);
    });

    const observer = new ResizeObserver(() => {
      try {
        addon.fit();
        void window.electronAPI.environment.resize(terminal.cols, terminal.rows);
      } catch {
        // Fitting a pane with no size yet throws; the next resize will land.
      }
    });
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      typed.dispose();
      stop();
      stopNative?.();
      exited();
      stopAppearance();
      terminal.dispose();
      term.current = null;
    };
  }, []);

  // A new run starts on a clean screen; the scrollback of the last one is not context for this one.
  useEffect(() => {
    if (state.outputEpoch > 0) term.current?.clear();
  }, [state.outputEpoch]);

  return <div ref={host} className="h-full min-h-0 w-full" />;
}

function Variables() {
  const state = useEnvironment();
  const [expression, setExpression] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const paused = state.debug.phase === 'paused';
  const selectedFrame = state.debug.frames.find((frame) => frame.id === state.debug.selectedFrameId) ?? state.debug.frames[0];
  const nyFrame = /\.(ny|matrix|mat)$/i.test(selectedFrame?.file ?? '');

  useEffect(() => { setAnswer(null); }, [state.debug.selectedFrameId, paused]);

  const evaluate = async () => {
    if (!expression.trim()) return;
    try {
      setAnswer(await window.electronAPI.environment.evaluate(expression, selectedFrame?.id));
    } catch (error) {
      setAnswer((error as Error).message);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {state.debug.variables.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-ink-3">
            {paused ? 'This frame has no locals.' : 'Nothing is paused. Set a breakpoint and press Debug.'}
          </p>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <tbody>
              {state.debug.variables.map((variable) => (
                <tr key={variable.name} className="border-b border-line-soft">
                  <td className="w-1/3 truncate px-2 py-1 text-accent" title={variable.name}>
                    {variable.name}
                  </td>
                  <td className="truncate px-2 py-1 text-ink" title={variable.value}>
                    {variable.value}
                  </td>
                  <td className="w-16 truncate px-2 py-1 text-ink-3">{variable.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="shrink-0 border-t border-line p-1.5">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 font-mono text-[11px] text-primary">›</span>
          <input
            value={expression}
            onChange={(event) => setExpression(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void evaluate();
            }}
            disabled={!paused}
            placeholder={paused ? nyFrame ? 'inspect a name or member in this frame' : 'evaluate in this frame' : 'paused only'}
            title={nyFrame ? 'NIL supports read-only name and member inspection' : 'Evaluate in the selected stack frame'}
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-line bg-surface-3 px-2 py-0.5 font-mono text-[11px] text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none disabled:opacity-50"
          />
        </div>
        {answer !== null && (
          <p className="mt-1 truncate px-3 font-mono text-[11px] text-ink-2" title={answer}>
            {answer}
          </p>
        )}
      </div>
    </div>
  );
}

function CallStack() {
  const state = useEnvironment();

  if (state.debug.frames.length === 0) {
    return <p className="px-3 py-3 text-[11px] text-ink-3">No stack — nothing is paused.</p>;
  }

  return (
    <div className="h-full overflow-auto">
      {state.debug.frames.map((frame, index) => (
        <button
          key={frame.id}
          type="button"
          onClick={() => void actions.selectDebugFrame(frame.id)}
          className={`flex w-full min-w-0 items-baseline gap-2 border-b border-line-soft px-2 py-1 text-left font-mono text-[11px] transition hover:bg-surface-3/60 ${
            (state.debug.selectedFrameId ?? state.debug.frames[0]?.id) === frame.id ? 'bg-surface-3 text-ink' : 'text-ink-2'
          }`}
          title={frame.file ? `${frame.file}:${frame.line}` : 'This library frame has no source map'}
        >
          <span className="w-4 shrink-0 text-ink-3">{index}</span>
          <span className="min-w-0 flex-1 truncate">{frame.name}</span>
          <span className="shrink-0 truncate text-ink-3">
            {frame.file ? `${frame.file.split('/').pop()}:${frame.line}` : 'source unavailable'}
          </span>
        </button>
      ))}
    </div>
  );
}

function Problems() {
  const state = useEnvironment();
  if (state.diagnostics.length === 0) return <div className="flex items-center gap-2 px-3 py-4 text-[11px] text-ink-3"><CheckCheck size={14} className="text-success" /><span>No reported problems. Check the project to validate saved source.</span></div>;
  return <div className="h-full overflow-auto" aria-label="Source problems">
    {state.diagnostics.map((diagnostic, index) => {
      const path = diagnostic.path ?? state.activePath;
      const line = diagnostic.range.start.line + 1;
      const column = diagnostic.range.start.character + 1;
      const Icon = diagnostic.severity === 2 ? AlertTriangle : diagnostic.severity === 3 || diagnostic.severity === 4 ? Info : AlertCircle;
      const tone = diagnostic.severity === 2 ? 'text-warning' : diagnostic.severity === 3 || diagnostic.severity === 4 ? 'text-info' : 'text-danger';
      const relativePath = path?.startsWith(`${state.root}/`) ? path.slice(state.root.length + 1) : path;
      return <button key={`${path}:${line}:${column}:${index}`} type="button" disabled={!path} onClick={() => path && void actions.reveal(relativePath!, line)} title={path ? `${path}:${line}:${column}` : diagnostic.message} className="flex w-full items-start gap-2 border-b border-line-soft px-3 py-2 text-left text-[11px] hover:bg-surface-2 disabled:cursor-default">
        <Icon size={13} className={`mt-0.5 shrink-0 ${tone}`} /><span className="min-w-0 flex-1"><span className="block whitespace-pre-wrap break-words text-ink-2">{diagnostic.message}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-ink-3">{relativePath ?? diagnostic.source ?? 'Compiler'}{path ? `:${line}:${column}` : ''}{diagnostic.source && path ? ` · ${diagnostic.source}` : ''}</span></span>
      </button>;
    })}
  </div>;
}

function BuildOutput() {
  const state = useEnvironment();
  const artifact = state.buildResult?.artifact;
  const relativeArtifact = artifact?.startsWith(`${state.root}/`) ? artifact.slice(state.root.length + 1) : artifact;
  return <div className="h-full overflow-auto px-3 py-2 text-[11px]">
    {state.nativeResult && <p className={`mb-2 ${state.nativeResult.success ? 'text-success' : 'text-danger'}`}>{state.nativeResult.cancelled ? 'Cancelled.' : state.nativeResult.success ? 'Project action passed.' : 'Project action failed.'}</p>}
    {state.buildResult && <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className={state.buildResult.success ? 'text-success' : 'text-danger'}>{state.buildResult.success ? artifact ? 'Build succeeded.' : 'Check passed.' : 'Check or build failed.'}</span>
      {artifact && <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-3" title={artifact}>{relativeArtifact}</span>}
      {artifact && /\.nil$/i.test(artifact) && <button type="button" onClick={() => void actions.openFile(relativeArtifact!)} className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-ink-2 hover:border-primary hover:text-ink"><SearchCode size={12} />Inspect NIL</button>}
    </div>}
    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-2">{state.buildOutput || (state.task === 'check' || state.task === 'build' ? 'Working…' : 'Compiler and project output appears here after Check or Build.')}</pre>
  </div>;
}

export function ConsolePane() {
  const state = useEnvironment();
  const [tab, setTab] = useState<Tab>('output');
  const [output, setOutput] = useState<'program' | 'build'>('program');
  useEffect(() => {
    const select = (event: Event) => {
      const pane = (event as CustomEvent<CodePane>).detail;
      if (['output', 'problems', 'variables', 'stack'].includes(pane)) setTab(pane);
    };
    window.addEventListener(CODE_PANE_EVENT, select);
    return () => window.removeEventListener(CODE_PANE_EVENT, select);
  }, []);
  useEffect(() => { setTab('output'); setOutput('program'); }, [state.root]);
  useEffect(() => {
    if (state.task === 'check' || state.task === 'build') { setOutput('build'); setTab('output'); }
    if (state.task === 'run' || state.task === 'debug') { setOutput('program'); setTab('output'); }
  }, [state.task]);
  useEffect(() => { if (state.run) { setOutput('program'); setTab('output'); } }, [state.run?.id]);
  useEffect(() => {
    if (state.buildResult) { setOutput('build'); setTab(!state.buildResult.success && state.buildResult.diagnostics.length ? 'problems' : 'output'); }
  }, [state.buildResult]);
  useEffect(() => {
    if (state.nativeResult) {
      setOutput(state.nativeAction === 'run' ? 'program' : 'build');
      setTab(!state.nativeResult.success && state.nativeResult.diagnostics.length ? 'problems' : 'output');
    }
  }, [state.nativeResult, state.nativeAction]);
  // Stopping somewhere is the moment the variables matter; don't make it a click away.
  useEffect(() => {
    if (state.debug.phase === 'paused') setTab('variables');
    if (state.debug.phase === 'stopped') setTab('output');
  }, [state.debug.phase]);

  const tabs: { id: Tab; label: string; icon: typeof TerminalSquare; badge?: number }[] = [
    { id: 'output', label: 'Output', icon: TerminalSquare },
    { id: 'problems', label: 'Problems', icon: AlertCircle, badge: state.diagnostics.length },
    { id: 'variables', label: 'Variables', icon: Braces, badge: state.debug.variables.length },
    { id: 'stack', label: 'Call stack', icon: Layers, badge: state.debug.frames.length },
  ];
  return <div className="flex min-h-0 flex-1 flex-col bg-surface-0">
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-line bg-surface-2 px-1.5" role="tablist" aria-label="Code panels">
      {tabs.map(({ id, label, icon: Icon, badge }) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`flex items-center gap-1.5 border-b-2 px-2 py-1.5 text-[11px] transition ${tab === id ? 'border-primary text-ink' : 'border-transparent text-ink-3 hover:text-ink-2'}`}><Icon size={11} />{label}{!!badge && <span className={`rounded px-1 text-[9px] ${id === 'problems' ? 'bg-warning/10 text-warning' : 'text-ink-3'}`}>{badge}</span>}</button>)}
      {tab === 'output' && <div className="ml-auto flex items-center gap-0.5 px-1 text-[10px]" role="group" aria-label="Output source">{(['program', 'build'] as const).map(source => <button key={source} type="button" aria-pressed={output === source} onClick={() => setOutput(source)} className={`rounded px-1.5 py-0.5 ${output === source ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink'}`}>{source === 'program' ? 'Program' : 'Build'}</button>)}</div>}
      {state.debug.error && <span className="ml-2 truncate text-[10px] text-danger" title={state.debug.error}>{state.debug.error}</span>}
    </div>
    <div className="relative min-h-0 flex-1" role="tabpanel" aria-label={tabs.find(entry => entry.id === tab)?.label}>
      {/* Terminal stays mounted across tabs and hiding panels so output is never discarded. */}
      <div className={`absolute inset-0 p-1 ${tab === 'output' && output === 'program' ? '' : 'invisible'}`} aria-hidden={tab !== 'output' || output !== 'program'}><Output /></div>
      {tab === 'output' && output === 'build' && <div className="absolute inset-0"><BuildOutput /></div>}
      {tab === 'problems' && <div className="absolute inset-0"><Problems /></div>}
      {tab === 'variables' && <div className="absolute inset-0"><Variables /></div>}
      {tab === 'stack' && <div className="absolute inset-0"><CallStack /></div>}
    </div>
  </div>;
}
