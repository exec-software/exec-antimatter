import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { ModelWorkloadsView } from '../../../../src/api/modelWorkloads';
import type { ModelDeployment } from '../../../../src/api/modelDeployment';
import { MODEL_DEPLOYMENTS, DEPLOYMENT_LABELS } from '../../../../src/api/modelDeployment';
import type { OrchestrationProfileInfo, ProviderConfig } from '../../types';

/**
 * Create or edit an orchestration profile: ADR 0001's top level.
 *
 * A row assigns one role a `(source, model, workload)` triple, which is the whole point of the
 * level — `coding 32k` from one model in one slot and an audio workload from another in the next.
 * `default` is mandatory, because a role table with a hole in it fails at dispatch, on whichever
 * agent happened to be first.
 */
const field =
  'w-full rounded border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';
const button =
  'flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';

/** The roles dispatch actually looks for, matched against an agent's own tags. */
const SUGGESTED_ROLES = ['default', 'code', 'security', 'image', 'audio'] as const;

const message = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
};

const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

interface Row {
  role: string;
  providerId: string;
  modelId: string;
  workloadId: string;
}

export function OrchestrationEditor({ providers, existing, onDone, onCancel }: {
  providers: ProviderConfig[];
  /** Absent when creating. A built-in profile is never passed here. */
  existing?: OrchestrationProfileInfo;
  onDone(saved: OrchestrationProfileInfo): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [mode, setMode] = useState<ModelDeployment | ''>(existing?.mode ?? '');
  const [rows, setRows] = useState<Row[]>(() => {
    const entries = Object.entries(existing?.roles ?? {});
    if (!entries.length) return [{ role: 'default', providerId: '', modelId: '', workloadId: '' }];
    return entries.map(([role, binding]) => ({
      role,
      providerId: binding.provider ?? '',
      modelId: binding.model,
      workloadId: binding.workload ?? '',
    }));
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Workloads per `sourceId::modelId`, fetched as rows name models. */
  const [workloads, setWorkloads] = useState<Record<string, ModelWorkloadsView>>({});

  // A row can only offer workloads once it names a model, so fetch on demand and cache.
  const needed = useMemo(
    () => rows.filter((row) => row.providerId && row.modelId).map((row) => `${row.providerId}::${row.modelId}`),
    [rows]
  );
  useEffect(() => {
    let cancelled = false;
    const missing = [...new Set(needed)].filter((slot) => !(slot in workloads));
    if (!missing.length) return;
    void Promise.all(missing.map(async (slot) => {
      const split = slot.lastIndexOf('::');
      const view = await window.electronAPI.modelWorkloads
        .list(slot.slice(0, split), slot.slice(split + 2))
        .catch(() => null);
      return [slot, view] as const;
    })).then((loaded) => {
      if (cancelled) return;
      setWorkloads((current) => {
        const next = { ...current };
        for (const [slot, view] of loaded) if (view) next[slot] = view;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [needed, workloads]);

  const update = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const save = async () => {
    setBusy(true); setError('');
    try {
      const roles: Record<string, { provider: string | null; model: string; workload?: string | null }> = {};
      for (const row of rows) {
        const role = slug(row.role);
        if (!role) throw new Error('Every row needs a role name.');
        if (!row.modelId) throw new Error(`Role "${role}" needs a model.`);
        roles[role] = {
          provider: row.providerId || null,
          model: row.modelId,
          ...(row.workloadId ? { workload: row.workloadId } : {}),
        };
      }
      if (!roles.default) throw new Error('A profile needs a default role: it is what an agent gets when its tags match nothing.');
      const id = existing?.id ?? (slug(name) || 'profile');
      onDone(await window.electronAPI.saveProfile({
        id, name: name.trim(), description: description.trim(),
        ...(mode ? { mode } : {}), roles,
      }));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };

  return <div className="mt-3 rounded-lg border border-accent/40 bg-surface-2 p-3.5">
    <div className="flex items-start justify-between gap-2">
      <h3 className="text-xs font-medium text-ink">{existing ? `Edit ${existing.name}` : 'New orchestration profile'}</h3>
      <button type="button" className={button} disabled={busy} onClick={onCancel}><X size={11} />Close</button>
    </div>

    <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
      <label className="block"><span className="mb-1 block text-[10px] font-medium text-ink-2">Name</span>
        <input className={field} value={name} maxLength={80} disabled={busy} onChange={(event) => setName(event.target.value)}
          placeholder="Single box" /></label>
      <label className="block"><span className="mb-1 block text-[10px] font-medium text-ink-2">Category</span>
        <select className={field} value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as ModelDeployment | '')}>
          <option value="">Infer from its models</option>
          {MODEL_DEPLOYMENTS.map((value) => <option key={value} value={value}>{DEPLOYMENT_LABELS[value]}</option>)}
        </select></label>
    </div>
    <label className="mt-2.5 block"><span className="mb-1 block text-[10px] font-medium text-ink-2">Description</span>
      <input className={field} value={description} maxLength={500} disabled={busy}
        onChange={(event) => setDescription(event.target.value)} placeholder="What this workflow is for." /></label>

    <p className="mt-3 text-[10px] font-medium uppercase tracking-wide text-ink-3">Slots</p>
    <p className="mt-0.5 text-[10px] leading-relaxed text-ink-3">
      A role is matched against an agent's own tags; the first tag naming a role wins, and
      <code className="mx-1 text-ink-2">default</code> is what an agent matching nothing gets.
    </p>

    <div className="mt-2 space-y-2">
      {rows.map((row, index) => {
        const source = providers.find((candidate) => candidate.id === row.providerId);
        const slot = row.providerId && row.modelId ? `${row.providerId}::${row.modelId}` : '';
        const available = slot ? workloads[slot]?.workloads ?? [] : [];
        return <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1.4fr_1.2fr_auto]">
          <input className={field} value={row.role} disabled={busy} list="orchestration-roles"
            aria-label={`Role ${index + 1}`} placeholder="role"
            onChange={(event) => update(index, { role: event.target.value })} />
          <select className={field} value={row.providerId ? `${row.providerId}::${row.modelId}` : ''} disabled={busy}
            aria-label={`Model for row ${index + 1}`}
            onChange={(event) => {
              const value = event.target.value;
              const split = value.lastIndexOf('::');
              update(index, split < 0
                ? { providerId: '', modelId: '', workloadId: '' }
                : { providerId: value.slice(0, split), modelId: value.slice(split + 2), workloadId: '' });
            }}>
            <option value="">Choose a model…</option>
            {providers.map((candidate) => candidate.models.map((model) => (
              <option key={`${candidate.id}::${model.id}`} value={`${candidate.id}::${model.id}`}>
                {model.name || model.id} — {candidate.name}
              </option>
            )))}
          </select>
          <select className={field} value={row.workloadId} disabled={busy || !slot}
            aria-label={`Workload for row ${index + 1}`}
            onChange={(event) => update(index, { workloadId: event.target.value })}>
            <option value="">
              {!slot ? 'Pick a model first' : available.length ? "The model's default" : 'No workloads defined'}
            </option>
            {available.map((workload) => (
              <option key={workload.id} value={workload.id}>
                {workload.name}{workload.id === workloads[slot]?.defaultId ? ' (default)' : ''}
              </option>
            ))}
          </select>
          <button type="button" className={`${button} justify-center`} disabled={busy || rows.length === 1}
            title={source ? `Remove the ${row.role} slot` : 'Remove this slot'}
            onClick={() => setRows((current) => current.filter((_, at) => at !== index))}>
            <Trash2 size={11} />
          </button>
        </div>;
      })}
      <datalist id="orchestration-roles">
        {SUGGESTED_ROLES.map((role) => <option key={role} value={role} />)}
      </datalist>
    </div>

    <button type="button" className={`${button} mt-2`} disabled={busy}
      onClick={() => setRows((current) => [...current, { role: '', providerId: '', modelId: '', workloadId: '' }])}>
      <Plus size={11} />Add slot
    </button>

    {error && <p role="alert" className="mt-3 text-[11px] text-danger">{error}</p>}

    <div className="mt-3 flex gap-2">
      <button type="button" disabled={busy || !name.trim()} onClick={() => void save()}
        className="rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-on-primary disabled:opacity-50">
        {busy ? 'Saving…' : existing ? 'Save profile' : 'Create profile'}
      </button>
      <button type="button" className={button} disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}
