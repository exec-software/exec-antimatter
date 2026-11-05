import { useCallback, useEffect, useState } from 'react';
import { Check, Network, Pencil, Play, Plus, Star, Trash2, X } from 'lucide-react';
import type { ModelWorkload, ModelWorkloadsView, WorkloadSettings } from '../../../../src/api/modelWorkloads';
import type { InferenceNode } from '../../../../src/api/nodes';
import { thinkingSupport } from '../../../../src/api/thinking';
import type { ModelProfile, ProviderConfig, ThinkingLevel } from '../../types';

/**
 * The workloads belonging to one model: ADR 0001's middle level.
 *
 * A workload is a modular unit of *how this model is used* — one Omni owning `image`, `audio`,
 * `coding 32k` and `coding 64k` — and each is launchable on its own. Launching one selects it for
 * chat, which is why the action lives here rather than only in an orchestration profile.
 *
 * Deliberately not here: slot count and anything else about the serving process. That belongs to
 * the inference servers in Settings. A workload chooses how much of the window a server offers to
 * use; it does not reconfigure the server.
 */
const field =
  'w-full rounded border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';
const button =
  'flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';

const message = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
};

const thousands = (value: number | undefined): string =>
  value === undefined ? '—' : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);

/** A one-line reading of what a workload changes, so a row says something without expanding. */
function summarise(settings: WorkloadSettings, resolved: ModelProfile | null): string {
  const parts: string[] = [];
  parts.push(`${thousands(settings.contextTokens ?? resolved?.contextTokens)} window`);
  if (settings.maxOutputTokens) parts.push(`${thousands(settings.maxOutputTokens)} reply`);
  if (settings.maxToolCallsPerMessage) parts.push(`${settings.maxToolCallsPerMessage} calls`);
  if (settings.thinkingLevel && settings.thinkingLevel !== 'default') parts.push(`thinking ${settings.thinkingLevel}`);
  if (settings.compaction === 'drop') parts.push('drop on overflow');
  if (settings.instructions?.trim()) parts.push('own brief');
  if (settings.nodes?.length) parts.push(`${settings.nodes.length} box${settings.nodes.length > 1 ? 'es' : ''}`);
  return parts.join(' · ');
}

const NUMERIC = [
  { key: 'contextTokens' as const, label: 'Window', hint: 'Tokens this workload uses. Blank follows the server.' },
  { key: 'maxOutputTokens' as const, label: 'Reply ceiling', hint: 'Blank derives it from the window.' },
  { key: 'maxToolCallsPerMessage' as const, label: 'Tool calls', hint: 'Most calls one reply may ask for.' },
];

function Editor({ source, workload, busy, onSave, onCancel }: {
  source: ProviderConfig;
  workload: ModelWorkload;
  busy: boolean;
  onSave(patch: { name: string; description: string; settings: WorkloadSettings }): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(workload.name);
  const [description, setDescription] = useState(workload.description);
  const [settings, setSettings] = useState<WorkloadSettings>(workload.settings);
  const [nodes, setNodes] = useState<InferenceNode[] | null>(null);
  const support = thinkingSupport(source, workload.id);

  // Probed on open rather than with the panel: each unreachable box costs a timeout, and a
  // roster nobody is looking at should not be paying for that.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.nodes.list()
      .then((found) => { if (!cancelled) setNodes(found); })
      .catch(() => { if (!cancelled) setNodes([]); });
    return () => { cancelled = true; };
  }, []);

  const numeric = (key: typeof NUMERIC[number]['key'], raw: string) => {
    const next = { ...settings };
    // An empty box means "no opinion", which is what removing the key expresses. Storing 0 would
    // be a different claim, and resolution reads it as "use the default" rather than as blank.
    if (!raw.trim()) delete next[key];
    else next[key] = Math.max(1, Math.trunc(Number(raw) || 0));
    setSettings(next);
  };

  return <div className="mt-2 space-y-2.5 rounded-md border border-line bg-surface-3/40 p-3">
    <div className="grid gap-2.5 sm:grid-cols-2">
      <label className="block"><span className="mb-1 block text-[10px] font-medium text-ink-2">Name</span>
        <input className={field} value={name} maxLength={60} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      <label className="block"><span className="mb-1 block text-[10px] font-medium text-ink-2">Description</span>
        <input className={field} value={description} maxLength={500} disabled={busy}
          onChange={(event) => setDescription(event.target.value)} placeholder="What this workload is for" /></label>
    </div>
    <div className="grid gap-2.5 sm:grid-cols-3">
      {NUMERIC.map(({ key, label, hint }) => (
        <label key={key} className="block"><span className="mb-1 block text-[10px] font-medium text-ink-2">{label}</span>
          <input className={field} type="number" min={1} inputMode="numeric" disabled={busy}
            value={settings[key] ?? ''} onChange={(event) => numeric(key, event.target.value)} placeholder="server default" />
          <span className="mt-0.5 block text-[10px] leading-snug text-ink-3">{hint}</span></label>
      ))}
    </div>
    <div className="grid gap-2.5 sm:grid-cols-2">
      <label className="block"><span className="mb-1 block text-[10px] font-medium text-ink-2">Thinking</span>
        <select className={field} disabled={busy || support.levels.length === 1}
          value={settings.thinkingLevel ?? 'default'}
          onChange={(event) => setSettings({ ...settings, thinkingLevel: event.target.value as ThinkingLevel })}>
          {support.levels.map((level) => <option key={level} value={level}>{level === 'default' ? 'Model default' : level}</option>)}
        </select></label>
      <label className="block"><span className="mb-1 block text-[10px] font-medium text-ink-2">On overflow</span>
        <select className={field} disabled={busy} value={settings.compaction ?? 'summarize'}
          onChange={(event) => setSettings({ ...settings, compaction: event.target.value as 'summarize' | 'drop' })}>
          <option value="summarize">Summarize what falls out</option>
          <option value="drop">Drop it</option>
        </select></label>
    </div>
    <fieldset className="rounded border border-line p-2.5">
      <legend className="flex items-center gap-1.5 px-1 text-[10px] font-medium text-ink-2">
        <Network size={11} />Distribution
      </legend>
      {nodes === null ? <p role="status" className="text-[10px] text-ink-3">Probing boxes…</p>
        : !nodes.length ? <p className="text-[10px] leading-relaxed text-ink-3">
          Only this machine. Recipes under <code className="text-ink-2">~/.antimatter/recipes</code> name
          the peers a model needs; boxes listed there appear here too.
        </p>
        : <>
          <ul className="space-y-1">
            {nodes.map((node) => {
              const chosen = settings.nodes?.includes(node.key) ?? false;
              return <li key={node.key}>
                <label className="flex items-center gap-2 text-[11px]">
                  <input type="checkbox" checked={chosen} disabled={busy} onChange={(event) => {
                    const current = new Set(settings.nodes ?? []);
                    if (event.target.checked) current.add(node.key); else current.delete(node.key);
                    const next = { ...settings };
                    if (current.size) next.nodes = [...current]; else delete next.nodes;
                    setSettings(next);
                  }} />
                  <span className={chosen ? 'text-ink' : 'text-ink-2'}>{node.name}</span>
                  <span className="font-mono text-[10px] text-ink-3">{node.key}</span>
                  {/* A figure is shown only where something measured it: the driver on this
                      box, a paired node agent on another. A box with neither says so. */}
                  <span className="ml-auto text-[10px] tabular-nums text-ink-3"
                    title={capacityTitle(node)}>
                    {node.memoryTotal !== null
                      ? `${((node.memoryFree ?? 0) / 1024 ** 3).toFixed(0)} of ${(node.memoryTotal / 1024 ** 3).toFixed(0)} GiB free`
                      : node.local || node.paired ? 'capacity unknown' : 'not measured'}
                  </span>
                  <span className={`text-[10px] ${node.reachable ? 'text-success' : 'text-ink-3'}`}>
                    {node.local ? 'this machine' : node.reachable ? 'answering' : node.startable ? 'down · startable' : 'down'}
                  </span>
                </label>
              </li>;
            })}
          </ul>
          {nodes.some((node) => node.agentError) && <ul className="mt-1.5 space-y-0.5">
            {nodes.filter((node) => node.agentError).map((node) => (
              <li key={`${node.key}-error`} className="text-[10px] leading-snug text-warning">
                {node.name}: {node.agentError}
              </li>
            ))}
          </ul>}
          {nodes.some((node) => node.checkpoints.length) && <p className="mt-1.5 text-[10px] leading-relaxed text-ink-3">
            Holds already: {nodes.filter((node) => node.checkpoints.length)
              .map((node) => `${node.name} — ${node.checkpoints.map((held) => held.name).join(', ')}`)
              .join(' · ')}
          </p>}
          <p className="mt-2 text-[10px] leading-relaxed text-ink-3">
            Recorded, not applied. The runtime takes its RPC peers on the command line, so
            selecting boxes here says what this workload expects and reports whether they answer —
            it does not reconfigure a server. A box reports its free memory only once a node agent
            on it has been paired, under Settings → Models &amp; providers → Inference nodes.
          </p>
        </>}
    </fieldset>
    <label className="block"><span className="mb-1 block text-[10px] font-medium text-ink-2">Standing brief</span>
      <textarea className={`${field} resize-y`} rows={3} disabled={busy} value={settings.instructions ?? ''}
        onChange={(event) => setSettings({ ...settings, instructions: event.target.value })}
        placeholder="Instructions that travel with this workload." /></label>
    <div className="flex gap-2">
      <button type="button" disabled={busy || !name.trim()} className="rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-on-primary disabled:opacity-50"
        onClick={() => onSave({ name: name.trim(), description: description.trim(), settings })}>
        {busy ? 'Saving…' : 'Save workload'}
      </button>
      <button type="button" disabled={busy} className={button} onClick={onCancel}><X size={12} />Cancel</button>
    </div>
  </div>;
}

/** Where a capacity figure came from, said out loud rather than implied by its presence. */
const capacityTitle = (node: InferenceNode): string => {
  if (node.capacityFrom === 'driver') return 'Read from this machine\'s own driver.';
  if (node.capacityFrom === 'agent') return 'Reported by a paired node agent on that box.';
  if (node.paired) return 'That box is paired but published no memory figures.';
  return 'Nothing on that box has measured this. A probe only proves its port is open.';
};

export function WorkloadPanel({ source, model, activeWorkloadId, isChatModel, onLaunch }: {
  source: ProviderConfig;
  model: { id: string; name: string };
  /** The workload the chat selection names, when this is the model it is on. */
  activeWorkloadId?: string;
  isChatModel: boolean;
  onLaunch(workloadId?: string): void;
}) {
  const [view, setView] = useState<ModelWorkloadsView | null>(null);
  const [resolved, setResolved] = useState<ModelProfile | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    void Promise.all([
      window.electronAPI.modelWorkloads.list(source.id, model.id),
      window.electronAPI.modelWorkloads.resolve(source.id, model.id).catch(() => null),
    ]).then(([next, profile]) => { setView(next); setResolved(profile); })
      .catch((cause) => setError(message(cause)));
  }, [source.id, model.id]);

  useEffect(() => { setEditing(null); load(); }, [load]);

  const act = async (run: () => Promise<ModelWorkloadsView>) => {
    setBusy(true); setError('');
    try { setView(await run()); setEditing(null); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };

  const api = window.electronAPI.modelWorkloads;
  const workloads = view?.workloads ?? [];

  return <section aria-label={`Workloads for ${model.name}`} className="border-t border-line px-4 py-4">
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-64 flex-1">
        <h2 className="text-sm font-medium text-ink">Workloads — {model.name}</h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
          Ways of using this model: a window, a brief and limits, named so they can be launched on
          their own or assigned to a slot in an orchestration profile. Slot count belongs to the
          server, in Settings.
        </p>
      </div>
      <button type="button" className={button} disabled={busy}
        onClick={() => void act(() => api.create(source.id, model.id, { name: `Workload ${workloads.length + 1}` }))}>
        <Plus size={12} />New workload
      </button>
    </div>

    {error && <p role="alert" className="mb-2 text-[11px] text-danger">{error}</p>}

    {!view ? <p role="status" className="text-[11px] text-ink-3">Reading workloads…</p>
      : !workloads.length ? <div className="rounded-lg border border-dashed border-line px-3 py-5 text-center">
        <p className="text-[11px] text-ink-3">
          No workloads yet. This model runs on its resolved defaults — a
          {' '}{thousands(resolved?.contextTokens)} window from {resolved?.contextSource ?? 'default'}.
        </p>
        <button type="button" className={`${button} mx-auto mt-2`} disabled={busy}
          onClick={() => void act(() => api.create(source.id, model.id, { name: 'Default', description: 'The general-purpose way of using this model.' }))}>
          <Plus size={12} />Create the first one
        </button>
      </div>
        : <ul className="space-y-2">
          {workloads.map((workload) => {
            const isDefault = workload.id === view.defaultId;
            // Active only when this model is the chat model *and* names this workload — or names
            // none and this is the default, which is what a bare model selection resolves to.
            const running = isChatModel && (activeWorkloadId ? activeWorkloadId === workload.id : isDefault);
            return <li key={workload.id}
              className={`rounded-lg border p-3 ${running ? 'border-accent/60 bg-accent/10' : 'border-line bg-surface-2'}`}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h3 className="text-xs font-medium text-ink">{workload.name}</h3>
                {isDefault && <span className="flex items-center gap-1 text-[10px] text-ink-3"><Star size={9} />default</span>}
                {running && <span className="flex items-center gap-1 text-[10px] text-accent"><Check size={9} />in use</span>}
                <span className="ml-auto text-[10px] tabular-nums text-ink-3">{summarise(workload.settings, resolved)}</span>
              </div>
              {workload.description && <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{workload.description}</p>}

              <div className="mt-2.5 flex flex-wrap gap-2">
                <button type="button" disabled={busy || running} onClick={() => onLaunch(workload.id)}
                  className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-on-primary disabled:opacity-40">
                  <Play size={11} />{running ? 'Running' : 'Launch'}
                </button>
                <button type="button" className={button} disabled={busy}
                  onClick={() => setEditing(editing === workload.id ? null : workload.id)}>
                  <Pencil size={11} />{editing === workload.id ? 'Close' : 'Edit'}
                </button>
                {!isDefault && <button type="button" className={button} disabled={busy}
                  onClick={() => void act(() => api.setDefault(source.id, model.id, workload.id))}>
                  <Star size={11} />Make default
                </button>}
                <button type="button" className={`${button} hover:border-danger/60 hover:text-danger`} disabled={busy}
                  onClick={() => void act(() => api.remove(source.id, model.id, workload.id))}>
                  <Trash2 size={11} />Remove
                </button>
              </div>

              {editing === workload.id && <Editor source={source} workload={workload} busy={busy}
                onCancel={() => setEditing(null)}
                onSave={(patch) => void act(() => api.update(source.id, model.id, workload.id, patch))} />}
            </li>;
          })}
        </ul>}
  </section>;
}
