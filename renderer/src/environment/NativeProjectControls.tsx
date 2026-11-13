import { useEffect, useState } from 'react';
import { ChevronDown, RefreshCw, Settings2 } from 'lucide-react';
import type { NativeProfile, NativeProject } from '../../../src/api/nativeProject';
import { useEnvironment } from './store';
import type { NativeToolbarContext } from './Toolbar';

interface Configuration { profile: NativeProfile; target: string; arguments: string }
const DEFAULT: Configuration = { profile: 'debug', target: '', arguments: '' };
const key = (root: string) => `antimatter.native-project.${encodeURIComponent(root)}`;
const read = (root: string): Configuration => {
  try {
    const value = JSON.parse(localStorage.getItem(key(root)) ?? 'null');
    if (value && ['debug', 'release'].includes(value.profile) && typeof value.target === 'string' && typeof value.arguments === 'string') return value;
  } catch { /* Defaults still allow the project to run. */ }
  return DEFAULT;
};

export function useNativeProject(root: string, source: string | null) {
  const [project, setProject] = useState<NativeProject | null>(null);
  const [configuration, setConfiguration] = useState<Configuration>(() => read(root));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { setConfiguration(read(root)); }, [root]);
  useEffect(() => {
    let current = true;
    setProject(null); setError(''); setLoading(!!root);
    if (root && window.electronAPI.nativeProject) {
      void window.electronAPI.nativeProject.inspect(source ?? undefined).then((value) => { if (current) setProject(value); })
        .catch((error: unknown) => { if (current) setError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (current) setLoading(false); });
    } else setLoading(false);
    return () => { current = false; };
  }, [root, source, refresh]);
  const change = (patch: Partial<Configuration>) => {
    const next = { ...configuration, ...patch }; setConfiguration(next);
    try { localStorage.setItem(key(root), JSON.stringify(next)); } catch { /* Session preferences remain usable. */ }
  };
  const context: NativeToolbarContext | undefined = project ? { project, request: { root, source: project.source ?? undefined, action: 'build', profile: configuration.profile,
    target: configuration.target || undefined, args: configuration.arguments ? configuration.arguments.split('\n') : [] } } : undefined;
  return { project, configuration, context, change, error, loading, refresh: () => setRefresh((value) => value + 1) };
}

export function NativeProjectControls({ native }: { native: ReturnType<typeof useNativeProject> }) {
  const state = useEnvironment();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  if (!native.project) return native.error ? <p role="alert" className="border-b border-line px-3 py-2 text-xs text-danger">{native.error}</p> : null;
  const { project, configuration, change } = native;
  const working = !!state.task || state.busy || state.workspaceSwitching || !!state.pendingWorkspace || state.debug.phase !== 'stopped' || !!(state.run && !state.run.exit);
  const compiler = project.kind === 'cargo' ? project.tools.cargo : project.kind === 'cmake' ? project.tools.cmake : project.kind === 'rust-file' ? project.tools.rustc : project.tools.cpp;
  const compilerName = project.kind === 'cargo' ? 'Cargo' : project.kind === 'cmake' ? 'CMake' : project.kind === 'rust-file' ? 'rustc' : 'clang++ or g++';
  const language = project.kind === 'cargo' || project.kind === 'rust-file' ? project.tools.rustAnalyzer : project.tools.clangd;
  const field = 'rounded border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-primary';
  return <section aria-label="Native project configuration" className="shrink-0 border-b border-line bg-surface-2 px-3 py-2">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-2 text-ink-3">Profile<select aria-label="Native build profile" value={configuration.profile} disabled={working}
        onChange={(event) => change({ profile: event.target.value as NativeProfile })} className={field}><option value="debug">Debug</option><option value="release">Release</option></select></label>
      <label className="flex min-w-0 flex-1 items-center gap-2 text-ink-3">Target<input aria-label="Native build target" list="native-build-targets" value={configuration.target} maxLength={160} disabled={working}
        onChange={(event) => change({ target: event.target.value })} placeholder="Default" className={`${field} min-w-0 flex-1`} /></label>
      <datalist id="native-build-targets">{[...new Set(state.nativeResult?.artifacts.map((artifact) => artifact.name) ?? [])].map((name) => <option key={name} value={name} />)}</datalist>
      <button type="button" aria-label="Project toolchain and arguments" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 rounded px-2 py-1 text-ink-2 hover:bg-surface-3"><Settings2 size={13} /><ChevronDown size={11} /></button>
      {state.nativeResult && <span role="status" className={state.nativeResult.success ? 'text-primary' : 'text-danger'}>{state.nativeResult.cancelled ? 'Cancelled' : state.nativeResult.success ? `${state.nativeResult.action === 'test' ? 'Tests' : state.nativeResult.action === 'check' ? 'Check' : 'Build'} passed` : 'Build failed'}</span>}
    </div>
    {!compiler && <p role="alert" className="mt-2 text-xs text-warning">Install {compilerName} and add it to PATH, then refresh the toolchain.</p>}
    {expanded && <div className="mt-3 flex flex-col gap-2 text-xs">
      <label className="flex flex-col gap-1 text-ink-3">Program arguments · one per line<textarea aria-label="Program arguments" rows={2} value={configuration.arguments} disabled={working}
        onChange={(event) => change({ arguments: event.target.value })} className={`${field} resize-y font-mono`} /></label>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-ink-3">Compiler</dt><dd className="truncate text-ink-2" title={compiler ?? ''}>{compiler ?? `${compilerName} missing`}</dd>
        <dt className="text-ink-3">Code intelligence</dt><dd className="truncate text-ink-2" title={language ?? ''}>{language ?? (project.kind.startsWith('rust') || project.kind === 'cargo' ? 'Install rust-analyzer' : 'Install clangd')}</dd>
        <dt className="text-ink-3">Debugger</dt><dd className="truncate text-ink-2" title={project.tools.debugger ?? ''}>{project.tools.debugger ?? 'Install lldb-dap'}</dd>
        <dt className="text-ink-3">Build files</dt><dd className="truncate font-mono text-ink-2" title={project.buildDirectory}>{project.buildDirectory}</dd>
      </dl>
      <button type="button" disabled={working} onClick={() => { setError(''); native.refresh(); void window.electronAPI.nativeProject.language.restart().catch((error: unknown) => setError(error instanceof Error ? error.message : String(error))); }} className="flex items-center gap-1 self-start rounded border border-line px-2 py-1 text-ink-2 disabled:opacity-40"><RefreshCw size={12} />Refresh toolchain</button>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>}
  </section>;
}
