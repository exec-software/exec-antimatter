import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  CircleSlash,
  Cloud,
  Cpu,
  Eye,
  EyeOff,
  Layers3,
  MemoryStick,
  Plus,
  Pencil,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings2,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useOrchestrationProfiles } from '../../lib/useOrchestrationProfiles';
import { unloadUnavailableReason, useResidency } from '../../lib/useResidency';
import type { Model, ModelMetadataPatch, ModelProfile, OrchestrationProfileInfo, ProviderConfig, ResidentModel } from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import { LoadedModels } from './LoadedModels';
import { ModelRuntimeProfiles } from './ModelRuntimeProfiles';
import { bytes } from './presentation';
import { DEPLOYMENT_LABELS, MODEL_DEPLOYMENTS, modelDeployment, type ModelDeployment } from '../../../../src/api/modelDeployment';
import { filterLibraryEntries, profileDeployment } from './libraryFilters';
import { WorkloadPanel } from './WorkloadPanel';
import { OrchestrationEditor } from './OrchestrationEditor';
import { ThinkingLevelField } from '../settings/ThinkingLevelField';
import type { ThinkingLevel } from '../../../../src/api/types';

interface Props {
  providers: ProviderConfig[];
  providerId: string;
  modelId: string;
  /** `workloadId` launches one of the model's workloads; omitted uses the model's default. */
  onUseModel(providerId: string, modelId: string, workloadId?: string): void;
  onOpenSettings(): void;
  title?: string;
  description?: string;
  actionLabel?: string;
  selectedLabel?: string;
}

const button =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:cursor-default disabled:opacity-50';
const field =
  'rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';
const MODELS_PER_PAGE = 40;

const tokens = (value?: number) => {
  if (!value) return null;
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
};

const connector = (source: ProviderConfig): string => {
  switch (source.kind) {
    case 'beholdd':
      return 'Beholdd';
    case 'llama-cpp':
      return 'llama.cpp';
    case 'ollama':
      return 'Ollama';
    case 'openai':
      return source.protocol === 'openai-responses' ? 'OpenAI Responses' : 'OpenAI compatible';
    case 'anthropic':
      return 'Anthropic Messages';
    case 'opencode-zen':
      return 'OpenCode Zen';
    case 'openai-compatible':
      return 'OpenAI compatible';
    default:
      return 'OpenAI compatible';
  }
};

type VisionChoice = 'unknown' | 'yes' | 'no';

const visionChoice = (value?: boolean): VisionChoice =>
  value === true ? 'yes' : value === false ? 'no' : 'unknown';

const visionValue = (value: VisionChoice): boolean | undefined =>
  value === 'yes' ? true : value === 'no' ? false : undefined;

function DeclareModel({ providers, preferredSourceId }: { providers: ProviderConfig[]; preferredSourceId: string }) {
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState(preferredSourceId || providers[0]?.id || '');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [architecture, setArchitecture] = useState('');
  const [quantization, setQuantization] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [vision, setVision] = useState<VisionChoice>('unknown');
  const [deployment, setDeployment] = useState<ModelDeployment | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (providers.some((source) => source.id === sourceId)) return;
    setSourceId(preferredSourceId || providers[0]?.id || '');
  }, [preferredSourceId, providers, sourceId]);

  const reset = () => {
    setId('');
    setName('');
    setArchitecture('');
    setQuantization('');
    setContextWindow('');
    setVision('unknown');
    setDeployment('');
    setError('');
  };

  const declare = async () => {
    setSaving(true);
    setError('');
    try {
      await window.electronAPI.providers.declareModel(sourceId, {
        id,
        name: name || undefined,
        architecture: architecture || undefined,
        quantization: quantization || undefined,
        contextWindow: contextWindow.trim() ? Number(contextWindow) : undefined,
        vision: visionValue(vision),
        deployment: deployment || undefined,
      });
      reset();
      setOpen(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} disabled={!providers.length} className={button}>
        <Plus size={12} /> Declare model
      </button>
    );
  }

  return (
    <section className="rounded-xl border border-primary/35 bg-surface-2 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-ink">Declare a model</h3>
          <p className="mt-0.5 text-[11px] text-ink-3">
            Add an exact model id to one configured source. Connection credentials remain in the main process.
          </p>
        </div>
        <button type="button" onClick={() => { reset(); setOpen(false); }} className={button}>Cancel</button>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
          Source
          <select value={sourceId} onChange={(event) => setSourceId(event.target.value)} className={`${field} mt-1 w-full normal-case tracking-normal`}>
            {providers.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
          </select>
        </label>
        <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
          Model id
          <input value={id} onChange={(event) => setId(event.target.value)} placeholder="provider/model-id" className={`${field} mt-1 w-full font-mono normal-case tracking-normal`} />
        </label>
        <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
          Display name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Defaults to model id" className={`${field} mt-1 w-full normal-case tracking-normal`} />
        </label>
        <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
          Architecture
          <input value={architecture} onChange={(event) => setArchitecture(event.target.value)} placeholder="nemotron_h_moe" className={`${field} mt-1 w-full font-mono normal-case tracking-normal`} />
        </label>
        <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
          Quantization
          <input value={quantization} onChange={(event) => setQuantization(event.target.value)} placeholder="Q4_K_M" className={`${field} mt-1 w-full font-mono normal-case tracking-normal`} />
        </label>
        <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
          Context window
          <input value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} inputMode="numeric" placeholder="131072" className={`${field} mt-1 w-full font-mono normal-case tracking-normal`} />
        </label>
        <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
          Category
          <select value={deployment} onChange={(event) => setDeployment(event.target.value as ModelDeployment | '')} className={`${field} mt-1 w-full normal-case tracking-normal`}>
            <option value="">Automatic</option>
            {MODEL_DEPLOYMENTS.map((value) => <option key={value} value={value}>{DEPLOYMENT_LABELS[value]}</option>)}
          </select>
        </label>
        <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
          Vision
          <select value={vision} onChange={(event) => setVision(event.target.value as VisionChoice)} className={`${field} mt-1 w-full normal-case tracking-normal`}>
            <option value="unknown">Unknown</option>
            <option value="yes">Supported</option>
            <option value="no">Not supported</option>
          </select>
        </label>
      </div>
      {error && <p className="mt-2 text-[10px] text-danger">{error}</p>}
      <button type="button" onClick={() => void declare()} disabled={saving || !sourceId || !id.trim()} className={`${button} mt-3 border-primary/50 text-primary`}>
        <Plus size={11} /> {saving ? 'Declaring…' : 'Declare model'}
      </button>
    </section>
  );
}

export function ModelCard({
  source,
  model,
  selected,
  onUse,
  inspecting,
  onInspect,
  actionLabel,
  selectedLabel,
  resident,
  onUnload,
  unloadDisabledReason,
}: {
  source: ProviderConfig;
  model: Model;
  selected: boolean;
  onUse(): void;
  /** Whether this card's workloads are the ones showing below the grid. */
  inspecting?: boolean;
  /** Show this model's workloads below the grid. Not a chat selection. */
  onInspect?(): void;
  actionLabel: string;
  selectedLabel: string;
  /** Present while this model is held in memory, even when unloading is unsupported. */
  resident?: ResidentModel;
  onUnload?(sourceId: string, resident: ResidentModel): void;
  unloadDisabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<ModelProfile | null>(null);
  const [engineProfilesOpen, setEngineProfilesOpen] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [context, setContext] = useState('');
  const [output, setOutput] = useState('');
  const [toolCalls, setToolCalls] = useState('');
  const [compaction, setCompaction] = useState<'summarize' | 'drop'>('summarize');
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('default');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [displayName, setDisplayName] = useState(model.name || model.id);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(model.name || model.id);
  const [deployment, setDeployment] = useState<ModelDeployment>(modelDeployment(source, model));
  const [architecture, setArchitecture] = useState(model.architecture ?? '');
  const [quantization, setQuantization] = useState(model.quantization ?? '');
  const [catalogContext, setCatalogContext] = useState(model.contextWindow ? String(model.contextWindow) : '');
  const [catalogVision, setCatalogVision] = useState<VisionChoice>(visionChoice(model.vision));
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [metadataError, setMetadataError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    setDisplayName(model.name || model.id);
    setDeployment(modelDeployment(source, model));
    setArchitecture(model.architecture ?? '');
    setQuantization(model.quantization ?? '');
    setCatalogContext(model.contextWindow ? String(model.contextWindow) : '');
    setCatalogVision(visionChoice(model.vision));
  }, [model.name, model.id, model.architecture, model.quantization, model.contextWindow, model.vision, model.deployment, source.kind, source.baseUrl]);

  const applyProfile = (next: ModelProfile) => {
    setProfile(next);
    setInstructions(next.instructions ?? '');
    setContext(String(next.contextTokens));
    setOutput(String(next.maxOutputTokens));
    setToolCalls(String(next.maxToolCallsPerMessage));
    setCompaction(next.compaction);
    setThinkingLevel(next.thinkingLevel);
  };

  useEffect(() => {
    if (!open || profileLoaded) return;
    setProfileLoaded(true);
    setLoadingProfile(true);
    setProfileLoadFailed(false);
    setError('');
    window.electronAPI.modelWorkloads
      .resolve(source.id, model.id)
      .then((next) => {
        applyProfile(next);
        setProfileLoadFailed(false);
      })
      .catch((cause) => {
        setError((cause as Error).message);
        setProfileLoadFailed(true);
      })
      .finally(() => setLoadingProfile(false));
  }, [open, profileLoaded, source.id, model.id]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      applyProfile(
        await window.electronAPI.modelWorkloads.setDefaultSettings(source.id, model.id, {
          instructions,
          contextTokens: Number(context) || undefined,
          maxOutputTokens: Number(output) || undefined,
          maxToolCallsPerMessage: Number(toolCalls) || undefined,
          compaction,
          thinkingLevel,
        })
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError('');
    try {
      applyProfile(await window.electronAPI.modelWorkloads.setDefaultSettings(source.id, model.id, null));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveMetadata = async () => {
    setSavingMetadata(true);
    setMetadataError('');
    const patch: ModelMetadataPatch = {
      name: displayName,
      architecture: architecture || null,
      quantization: quantization || null,
      contextWindow: catalogContext.trim() ? Number(catalogContext) : null,
      vision: visionValue(catalogVision) ?? null,
      deployment,
    };
    try {
      await window.electronAPI.providers.updateModel(source.id, model.id, patch);
    } catch (cause) {
      setMetadataError((cause as Error).message);
    } finally {
      setSavingMetadata(false);
    }
  };

  const rename = async () => {
    setSavingMetadata(true);
    setMetadataError('');
    try {
      await window.electronAPI.providers.updateModel(source.id, model.id, { name: renameDraft });
      setRenaming(false);
    } catch (cause) {
      setMetadataError((cause as Error).message);
    } finally {
      setSavingMetadata(false);
    }
  };

  const toggleHidden = async () => {
    setSavingMetadata(true);
    setMetadataError('');
    try {
      await window.electronAPI.providers.updateModel(source.id, model.id, { name: model.name, hidden: !model.hidden });
    } catch (cause) {
      setMetadataError((cause as Error).message);
    } finally {
      setSavingMetadata(false);
    }
  };

  const removeModel = async () => {
    setConfirmRemove(false);
    setSavingMetadata(true);
    setMetadataError('');
    try {
      await window.electronAPI.providers.removeModel(source.id, model.id);
    } catch (cause) {
      setMetadataError((cause as Error).message);
      setSavingMetadata(false);
    }
  };

  const dirty =
    !!profile &&
    (instructions !== (profile.instructions ?? '') ||
      Number(context) !== profile.contextTokens ||
      Number(output) !== profile.maxOutputTokens ||
      Number(toolCalls) !== profile.maxToolCallsPerMessage ||
      compaction !== profile.compaction || thinkingLevel !== profile.thinkingLevel);
  const metadataDirty =
    displayName.trim() !== model.name ||
    architecture.trim() !== (model.architecture ?? '') ||
    quantization.trim() !== (model.quantization ?? '') ||
    catalogContext.trim() !== (model.contextWindow ? String(model.contextWindow) : '') ||
    catalogVision !== visionChoice(model.vision) || deployment !== modelDeployment(source, model);
  const contextValue = model.contextWindow;
  const category = modelDeployment(source, model);

  return (
    <article
      data-model={`${source.id}:${model.id}`}
      className={`rounded-xl border bg-surface-2 transition ${
        selected ? 'border-primary/60 ring-1 ring-primary/20' : inspecting ? 'border-accent/60' : 'border-line'
      }`}
    >
      <div className="p-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-primary/15 text-primary' : 'bg-surface-3 text-ink-3'}`}>
            <Cpu size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              {onInspect ? (
                <button type="button" onClick={onInspect} aria-expanded={!!inspecting}
                  title={`Show workloads for ${model.name || model.id}`}
                  className="truncate text-left text-sm font-medium text-ink hover:text-primary">
                  {model.name || model.id}
                </button>
              ) : (
                <h3 className="truncate text-sm font-medium text-ink" title={model.id}>
                  {model.name || model.id}
                </h3>
              )}
              {selected && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary">
                  <Check size={9} /> Selected
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[11px] text-ink-3" title={`${source.name} · ${model.id}`}>
              {source.name} · {model.id}
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-ink-3">
          <span className="inline-flex items-center gap-1 rounded border border-line bg-surface-3 px-1.5 py-0.5">
            {category === 'provider' ? <Cloud size={10} /> : <Server size={10} />}
            {DEPLOYMENT_LABELS[category]}
          </span>
          {model.hidden && <span className="rounded border border-line px-1.5 py-0.5">Hidden</span>}
          <span className="rounded border border-line bg-surface-3 px-1.5 py-0.5">{connector(source)}</span>
          {model.architecture && (
            <span className="rounded border border-line bg-surface-3 px-1.5 py-0.5 font-mono">{model.architecture}</span>
          )}
          {model.quantization && (
            <span className="rounded border border-line bg-surface-3 px-1.5 py-0.5 font-mono">{model.quantization}</span>
          )}
          {contextValue && (
            <span className="rounded border border-line bg-surface-3 px-1.5 py-0.5">{tokens(contextValue)} context</span>
          )}
          {model.vision === true && (
            <span className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-accent">
              <Eye size={10} /> Vision
            </span>
          )}
          {model.vision === false && (
            <span className="rounded border border-line bg-surface-3 px-1.5 py-0.5">Text only</span>
          )}
          {model.manuallyDeclared && (
            <span className="rounded border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-primary">Declared</span>
          )}
          {/* Residency is a fact about the engine right now, not about the catalog entry, so it
              sits with the other facts but is drawn in the live colours rather than the quiet ones. */}
          {resident?.state === 'live' && (
            <span className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-accent">
              <MemoryStick size={10} /> In memory
              {resident.hostBytes ? <span className="tabular-nums">· {bytes(resident.hostBytes)} host</span> : null}
            </span>
          )}
          {resident?.state === 'dead' && (
            <span
              className="inline-flex items-center gap-1 rounded border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-danger"
              title={resident.detail}
            >
              <TriangleAlert size={10} /> Worker stopped answering
            </span>
          )}
          {resident?.turns ? (
            <span className="rounded border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-primary">
              {resident.turns} turn{resident.turns === 1 ? '' : 's'} on it
            </span>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onUse} disabled={selected} className={`${button} ${selected ? '' : 'border-primary/50 text-primary'}`}>
            {selected ? selectedLabel : actionLabel}
          </button>
          {resident && onUnload && (
            <button
              type="button"
              onClick={() => onUnload(source.id, resident)}
              disabled={!!unloadDisabledReason}
              title={
                unloadDisabledReason ?? (resident.state === 'dead'
                  ? 'Drop the stopped worker so this model can be loaded again'
                  : 'Free what this model is holding. The next turn on it loads it again.')
              }
              className={button}
            >
              <CircleSlash size={12} /> {resident.state === 'dead' ? 'Clear' : 'Unload'}
            </button>
          )}
          <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className={button}>
            <SlidersHorizontal size={11} />
            {open ? 'Close settings' : 'Edit settings'}
          </button>
          {typeof window !== 'undefined' && window.electronAPI?.modelRuntimeProfiles && <button type="button" onClick={() => setEngineProfilesOpen((value) => !value)} aria-expanded={engineProfilesOpen} className={button}>
            <Server size={11} />{engineProfilesOpen ? 'Close engine profiles' : 'Engine profiles'}
          </button>}
          <button type="button" onClick={() => { setRenameDraft(model.name || model.id); setRenaming(true); setMetadataError(''); }} className={button}>
            <Pencil size={11} /> Rename
          </button>
          <button type="button" onClick={() => void toggleHidden()} disabled={savingMetadata} className={button}>
            {model.hidden ? <Eye size={11} /> : <EyeOff size={11} />}{model.hidden ? 'Restore' : 'Hide'}
          </button>
        </div>
        {renaming && <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
          <input autoFocus aria-label={`Rename ${model.name || model.id}`} value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setRenaming(false); }} className={`${field} min-w-0 flex-1`} />
          <button type="submit" disabled={savingMetadata || !renameDraft.trim()} className={button}>Save name</button>
          <button type="button" onClick={() => setRenaming(false)} className={button}>Cancel</button>
        </form>}
        {metadataError && <p role="alert" className="mt-2 text-[10px] text-danger">{metadataError}</p>}
      </div>

      {engineProfilesOpen && <ModelRuntimeProfiles sourceId={source.id} modelId={model.id} api={window.electronAPI.modelRuntimeProfiles} />}
      {open && (
        <div className="border-t border-line bg-surface-3/35 p-3.5">
          <div>
            <h4 className="text-[10px] font-medium uppercase tracking-wide text-ink-3">Catalog metadata</h4>
            <p className="mt-1 text-[10px] leading-relaxed text-ink-3">
              Durable facts for this exact source and model. Refreshing the source preserves these labels.
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
                Category
                <select value={deployment} onChange={(event) => setDeployment(event.target.value as ModelDeployment)} className={`${field} mt-1 w-full normal-case tracking-normal`}>
                  {MODEL_DEPLOYMENTS.map((value) => <option key={value} value={value}>{DEPLOYMENT_LABELS[value]}</option>)}
                </select>
              </label>
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
                Display name
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className={`${field} mt-1 w-full normal-case tracking-normal`} />
              </label>
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
                Architecture
                <input value={architecture} onChange={(event) => setArchitecture(event.target.value)} placeholder="qwen3moe" className={`${field} mt-1 w-full font-mono normal-case tracking-normal`} />
              </label>
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
                Quantization
                <input value={quantization} onChange={(event) => setQuantization(event.target.value)} placeholder="Q8_0" className={`${field} mt-1 w-full font-mono normal-case tracking-normal`} />
              </label>
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
                Catalog context window
                <input value={catalogContext} onChange={(event) => setCatalogContext(event.target.value)} inputMode="numeric" placeholder="Unknown" className={`${field} mt-1 w-full font-mono normal-case tracking-normal`} />
              </label>
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
                Vision
                <select value={catalogVision} onChange={(event) => setCatalogVision(event.target.value as VisionChoice)} className={`${field} mt-1 w-full normal-case tracking-normal`}>
                  <option value="unknown">Unknown</option>
                  <option value="yes">Supported</option>
                  <option value="no">Not supported</option>
                </select>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => void saveMetadata()} disabled={!metadataDirty || savingMetadata} className={button}>
                <Save size={11} /> Save metadata
              </button>
              {model.manuallyDeclared && (
                <button type="button" onClick={() => setConfirmRemove(true)} disabled={savingMetadata} className={`${button} hover:border-danger/60 hover:text-danger`}>
                  <Trash2 size={11} /> Remove declaration
                </button>
              )}
            </div>
          </div>

          <div className="my-4 border-t border-line" />
          <h4 className="text-[10px] font-medium uppercase tracking-wide text-ink-3">Runtime prompt and limits</h4>
          {loadingProfile && <p className="mt-1 text-[10px] text-ink-3">Loading runtime configuration…</p>}
          <label className="block text-[10px] font-medium uppercase tracking-wide text-ink-3">
            Model instructions
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              disabled={loadingProfile}
              rows={4}
              placeholder="A standing brief applied before Antimatter's workspace and safety instructions."
              className={`${field} mt-1 block w-full resize-y font-sans normal-case tracking-normal`}
            />
          </label>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-3">
            Shared by chat, routed agents, recovery, and orchestrated runs that use this exact source and model.
            {' '}An active engine profile can temporarily cap context and reply length without changing these saved preferences.
          </p>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ThinkingLevelField source={source} modelId={model.id} value={thinkingLevel} onChange={setThinkingLevel} />
            <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
              Runtime context override
              <input value={context} onChange={(event) => setContext(event.target.value)} disabled={loadingProfile} inputMode="numeric" className={`${field} mt-1 w-full font-mono`} />
            </label>
            <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
              Max reply
              <input value={output} onChange={(event) => setOutput(event.target.value)} disabled={loadingProfile} inputMode="numeric" className={`${field} mt-1 w-full font-mono`} />
            </label>
            <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
              Tool calls per reply
              <input value={toolCalls} onChange={(event) => setToolCalls(event.target.value)} disabled={loadingProfile} inputMode="numeric" className={`${field} mt-1 w-full font-mono`} />
            </label>
            <label className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
              Compaction
              <select value={compaction} onChange={(event) => setCompaction(event.target.value as 'summarize' | 'drop')} disabled={loadingProfile} className={`${field} mt-1 w-full`}>
                <option value="summarize">Summarize</option>
                <option value="drop">Drop with marker</option>
              </select>
            </label>
          </div>

          {profile && (
            <p className="mt-2 text-[10px] leading-relaxed text-ink-3">
              Context source: {profile.contextSource} · output source: {profile.outputSource} · tool-call limit:{' '}
              {profile.toolCallSource}. A reply asking for more calls than this is cut off at the limit while it is
              still being written, so the engine stops instead of decoding a batch that cannot fit the window.
            </p>
          )}
          {error && <p className="mt-2 text-[10px] text-danger">{error}</p>}
          <div className="mt-3 flex gap-2">
            {profileLoadFailed && (
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setProfileLoaded(false);
                }}
                disabled={loadingProfile}
                className={button}
              >
                <RotateCcw size={11} /> Retry loading
              </button>
            )}
            <button type="button" onClick={() => void save()} disabled={!dirty || saving || loadingProfile} className={button}>
              <Save size={11} /> Save
            </button>
            <button type="button" onClick={() => void reset()} disabled={saving || loadingProfile || !profile} className={button}>
              <RotateCcw size={11} /> Reset overrides
            </button>
          </div>
        </div>
      )}
      {confirmRemove && (
        <ConfirmDialog
          title="Remove this declared model?"
          message={`${model.name || model.id} will be removed from ${source.name}. The source connection and all other models stay intact.`}
          confirmLabel="Remove model"
          tone="danger"
          onConfirm={() => void removeModel()}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </article>
  );
}

export function ModelLibrary({
  providers,
  providerId,
  modelId,
  onUseModel,
  onOpenSettings,
  title = 'Model Library',
  description = 'One catalog for local and remote inference. Choose the model used by this conversation, then keep its prompt and runtime limits beside it.',
  actionLabel = 'Use in this chat',
  selectedLabel = 'In this chat',
}: Props) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  /**
   * Which model the workload panel is showing. Separate from the chat selection: looking at a
   * model's workloads must not change which model answers the next message.
   */
  const [inspecting, setInspecting] = useState<{ sourceId: string; modelId: string } | null>(null);
  const [activeWorkloadId, setActiveWorkloadId] = useState<string | undefined>(undefined);
  /** `new` while creating, a profile id while editing that one, null when neither. */
  const [editingProfile, setEditingProfile] = useState<string | null>(null);

  // The chat selection owns which workload is live, so read it rather than inferring one.
  useEffect(() => {
    let cancelled = false;
    const sync = () => void window.electronAPI.model.get()
      .then((choice) => { if (!cancelled) setActiveWorkloadId(choice?.workloadId); })
      .catch(() => { if (!cancelled) setActiveWorkloadId(undefined); });
    sync();
    return () => { cancelled = true; };
  }, [providerId, modelId]);
  const { profiles, profileId, error: profileError, selectProfile, refreshProfiles, renameProfile, setProfileMode } = useOrchestrationProfiles();
  const [category, setCategory] = useState<ModelDeployment>(() => {
    const source = providers.find((entry) => entry.id === providerId);
    const model = source?.models.find((entry) => entry.id === modelId);
    return source && model ? modelDeployment(source, model) : 'local';
  });
  const [showHidden, setShowHidden] = useState(false);
  const [renamingProfile, setRenamingProfile] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const residency = useResidency();
  const [unloading, setUnloading] = useState<string | null>(null);
  const [unloadError, setUnloadError] = useState('');
  const [confirmUnload, setConfirmUnload] = useState<{ sourceId: string; model: ResidentModel } | null>(null);

  /** Free one model, then ask again rather than assume: the engine is the authority, not us. */
  const free = useCallback(
    async (sourceId: string, model: ResidentModel) => {
      setConfirmUnload(null);
      const reason = unloadUnavailableReason(residency.sources.find((source) => source.sourceId === sourceId));
      if (reason) {
        setUnloadError(reason);
        return;
      }
      setUnloading(`${sourceId}:${model.id}`);
      setUnloadError('');
      try {
        await window.electronAPI.residency.unload(sourceId, model.id);
      } catch (cause) {
        setUnloadError(`Could not unload ${model.id}: ${(cause as Error).message}`);
      } finally {
        setUnloading(null);
        residency.refresh();
      }
    },
    [residency]
  );

  /**
   * A model with a turn on it is worth a question before its worker is stopped; an idle one, or
   * one whose worker has already stopped answering, is not — making someone confirm the very
   * thing they came here to clear is how a safeguard turns into an obstacle.
   */
  const requestUnload = useCallback(
    (sourceId: string, model: ResidentModel) => {
      const reason = unloadUnavailableReason(residency.sources.find((source) => source.sourceId === sourceId));
      if (reason) {
        setUnloadError(reason);
        return;
      }
      if (model.turns) setConfirmUnload({ sourceId, model });
      else void free(sourceId, model);
    },
    [free, residency.sources]
  );

  const residentKeys = useMemo(
    () => new Set(residency.resident.map((entry) => `${entry.sourceId}:${entry.id}`)),
    [residency.resident]
  );

  const entries = useMemo(() => {
    const matches = filterLibraryEntries(providers, category, query, showHidden);
    // Keep the current assignment visible when a gateway contributes more than one page, and
    // put whatever is actually in memory next: on a source with forty entries, the two that are
    // loaded are the ones someone came to this page to do something about.
    const rank = (entry: { source: ProviderConfig; model: Model }) => {
      if (entry.source.id === providerId && entry.model.id === modelId) return 0;
      return residentKeys.has(`${entry.source.id}:${entry.model.id}`) ? 1 : 2;
    };
    return matches.sort((left, right) => rank(left) - rank(right));
  }, [providers, category, query, showHidden, providerId, modelId, residentKeys]);

  useEffect(() => setPage(0), [category, showHidden, query, providers, providerId, modelId]);

  const categoryResidency = useMemo(() => {
    const sources = residency.sources.flatMap((state) => {
      const source = providers.find((entry) => entry.id === state.sourceId);
      if (!source) return [];
      const matching = source.models.filter((model) => modelDeployment(source, model) === category && (showHidden || !model.hidden));
      if (!matching.length) return [];
      return [{ ...state, models: state.models.filter((model) => matching.some((entry) => entry.id === model.id)) }];
    });
    return { ...residency, sources, resident: sources.flatMap((source) => source.models.map((model) => ({ ...model, sourceId: source.sourceId }))) };
  }, [providers, category, showHidden, residency]);
  const visibleProfiles = profiles.filter((profile) => profileDeployment(profile, providers) === category);
  const unclassifiedProfiles = profiles.filter((profile) => profileDeployment(profile, providers) === null);

  // A card can vanish under the panel — a source removed, a model hidden — so resolve it from
  // the live list each render rather than trusting the stored pair.
  const inspectingEntry = inspecting
    ? entries.find((entry) => entry.source.id === inspecting.sourceId && entry.model.id === inspecting.modelId) ?? null
    : null;
  /**
   * Loading a profile applies its role table *and* adopts its `default` slot as the chat model —
   * Q4 in ADR 0001, decided as all-in-one. A slot naming a model no source serves still selects
   * the profile: the role table is the profile's point, and the runner reports an unresolvable
   * binding far better than silently declining to load.
   */
  const loadProfile = async (profile: OrchestrationProfileInfo) => {
    await selectProfile(profile.id);
    const binding = profile.roles.default;
    if (!binding) return;
    const source = providers.find((candidate) => binding.provider
      ? candidate.id === binding.provider
      : candidate.models.some((model) => model.id === binding.model));
    if (!source?.models.some((model) => model.id === binding.model)) return;
    setActiveWorkloadId(binding.workload ?? undefined);
    onUseModel(source.id, binding.model, binding.workload ?? undefined);
  };

  const pageCount = Math.max(1, Math.ceil(entries.length / MODELS_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleEntries = entries.slice(currentPage * MODELS_PER_PAGE, (currentPage + 1) * MODELS_PER_PAGE);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[240px] flex-1">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-3">
              {description}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onOpenSettings} className={button}>
              <Settings2 size={12} /> Manage connections
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Filter model library" className="flex gap-1 rounded-lg border border-line bg-surface-2 p-1">
            {MODEL_DEPLOYMENTS.map((value) => <button key={value} type="button" onClick={() => setCategory(value)} aria-pressed={category === value}
              className={`rounded-md px-3 py-1.5 text-xs transition ${category === value ? 'bg-accent/15 text-accent' : 'text-ink-3 hover:text-ink'}`}>
              {DEPLOYMENT_LABELS[value]}
            </button>)}
          </div>
          <label className="ml-auto flex items-center gap-2 text-[11px] text-ink-3">
            <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />Show hidden models
          </label>
        </div>

        <LoadedModels
          providers={providers}
          residency={categoryResidency}
          busy={unloading}
          error={unloadError}
          onUnload={requestUnload}
        />

        <div className="mt-3">
          <DeclareModel providers={providers} preferredSourceId={providerId} />
        </div>

        <div className="relative mt-4 max-w-xl">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models and sources"
            aria-label="Search model library"
            className={`${field} w-full pl-8`}
          />
        </div>

        {entries.length ? (
          <>
            <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
              {visibleEntries.map(({ source, model }) => (
                <ModelCard
                  key={`${source.id}:${model.id}`}
                  source={source}
                  model={model}
                  selected={source.id === providerId && model.id === modelId}
                  onUse={() => onUseModel(source.id, model.id)}
                  inspecting={inspecting?.sourceId === source.id && inspecting.modelId === model.id}
                  onInspect={() => setInspecting((current) =>
                    current?.sourceId === source.id && current.modelId === model.id
                      ? null
                      : { sourceId: source.id, modelId: model.id })}
                  actionLabel={actionLabel}
                  selectedLabel={selectedLabel}
                  resident={residency.find(source.id, model.id)}
                  unloadDisabledReason={unloadUnavailableReason(residency.sources.find((entry) => entry.sourceId === source.id))}
                  onUnload={requestUnload}
                />
              ))}
            </div>
            {pageCount > 1 && (
              <nav className="mt-4 flex items-center justify-center gap-2" aria-label="Model Library pages">
                <button type="button" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={currentPage === 0} className={button}>
                  Previous
                </button>
                <span className="min-w-24 text-center text-[10px] text-ink-3">
                  Page {currentPage + 1} of {pageCount} · {entries.length} models
                </span>
                <button type="button" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={currentPage === pageCount - 1} className={button}>
                  Next
                </button>
              </nav>
            )}
          </>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-line px-5 py-10 text-center">
            <Cpu size={22} className="mx-auto text-ink-3" />
            <p className="mt-2 text-xs text-ink-2">{providers.length ? `No ${DEPLOYMENT_LABELS[category].toLowerCase()} models match these filters.` : 'No models are connected yet.'}</p>
            {!providers.length && (
              <button type="button" onClick={onOpenSettings} className={`${button} mt-3`}>
                Add a connection
              </button>
            )}
          </div>
        )}

        {/* ADR 0001: a model's workloads, bound to whichever card is being inspected. This is
            what used to read as "the profiles under this model" and genuinely was not. */}
        {inspectingEntry && (
          <div className="-mx-4 mt-6">
            <WorkloadPanel
              source={inspectingEntry.source}
              model={{ id: inspectingEntry.model.id, name: inspectingEntry.model.name || inspectingEntry.model.id }}
              activeWorkloadId={activeWorkloadId}
              isChatModel={inspectingEntry.source.id === providerId && inspectingEntry.model.id === modelId}
              onLaunch={(workloadId) => {
                setActiveWorkloadId(workloadId);
                onUseModel(inspectingEntry.source.id, inspectingEntry.model.id, workloadId);
              }}
            />
          </div>
        )}

        <section className="mt-7 border-t border-line pt-5">
          <div className="flex items-start gap-2">
            <Layers3 size={15} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <h2 className="text-sm font-medium text-ink">Orchestration profiles</h2>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
                A whole workflow: each assigns models to agent roles, one level up from the
                workloads above. Loading one applies its assignments; with none loaded, agents run
                on the chat model.
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void selectProfile(null)} aria-pressed={profileId === null} className={button}>
              {profileId === null && <Check size={11} />} Straight run
            </button>
            <button type="button" onClick={() => setEditingProfile(editingProfile === 'new' ? null : 'new')} className={button}>
              <Plus size={11} />{editingProfile === 'new' ? 'Close' : 'New profile'}
            </button>
          </div>
          <p className="mt-1 text-[10px] text-ink-3">With none loaded, agents run on the chat model.</p>
          {editingProfile === 'new' && <OrchestrationEditor providers={providers}
            onCancel={() => setEditingProfile(null)}
            onDone={() => { setEditingProfile(null); void refreshProfiles(); }} />}
          {profileError && <p role="alert" className="mt-2 text-[11px] text-danger">{profileError}</p>}
          <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
            {visibleProfiles.map((profile) => (
              <article key={profile.id} data-profile={profile.id} className={`rounded-lg border p-3 ${profileId === profile.id ? 'border-accent/60 bg-accent/10' : 'border-line bg-surface-2'}`}>
                <button type="button" onClick={() => void loadProfile(profile)} aria-pressed={profileId === profile.id} className="w-full text-left">
                  <span className="flex items-center gap-2 text-xs font-medium text-ink">
                    {profile.name}{profileId === profile.id && <Check size={12} className="ml-auto text-accent" />}
                  </span>
                  <span className="mt-1 block text-[10px] text-ink-3">{profile.description}</span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(profile.roles).map(([role, binding]) => (
                      <span key={role} className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] text-ink-3" title={`${role}: ${binding.provider ?? 'any source'} / ${binding.model}${binding.workload ? ` / ${binding.workload}` : ' / default workload'}`}>
                        {role} · {binding.model}{binding.workload ? ` · ${binding.workload}` : ''}
                      </span>
                    ))}
                  </span>
                </button>
                <div className="mt-3 flex items-center gap-2">
                  <select aria-label={`Category for ${profile.name}`} value={profileDeployment(profile, providers) ?? ''}
                    onChange={(event) => void setProfileMode(profile.id, event.target.value as ModelDeployment)} className={`${field} min-w-0 flex-1`}>
                    {MODEL_DEPLOYMENTS.map((value) => <option key={value} value={value}>{DEPLOYMENT_LABELS[value]}</option>)}
                  </select>
                  <button type="button" onClick={() => { setRenamingProfile(profile.id); setRenameDraft(profile.name); }} className={button}>
                    <Pencil size={11} /> Rename
                  </button>
                  {/* `save()` re-serialises from parsed fields, which would drop a hand-written
                      file's comments, so slot editing is offered only for generated profiles. */}
                  {!profile.builtin && (
                    <button type="button" className={button}
                      onClick={() => setEditingProfile(editingProfile === profile.id ? null : profile.id)}>
                      {editingProfile === profile.id ? 'Close' : 'Edit slots'}
                    </button>
                  )}
                </div>
                {renamingProfile === profile.id && <form className="mt-2 flex gap-2" onSubmit={(event) => {
                  event.preventDefault(); void renameProfile(profile.id, renameDraft).then((saved) => { if (saved) setRenamingProfile(null); });
                }}>
                  <input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Escape') setRenamingProfile(null); }}
                    aria-label={`Rename ${profile.name}`} className={`${field} min-w-0 flex-1`} />
                  <button type="submit" disabled={!renameDraft.trim()} className={button}>Save</button>
                  <button type="button" onClick={() => setRenamingProfile(null)} className={button}>Cancel</button>
                </form>}
                {editingProfile === profile.id && <OrchestrationEditor providers={providers} existing={profile}
                  onCancel={() => setEditingProfile(null)}
                  onDone={() => { setEditingProfile(null); void refreshProfiles(); }} />}
              </article>
            ))}
          </div>
          {!visibleProfiles.length && <p className="mt-3 text-[11px] text-ink-3">No {DEPLOYMENT_LABELS[category].toLowerCase()} routing profiles.</p>}
          {!!unclassifiedProfiles.length && <details className="mt-4 text-[11px] text-ink-3">
            <summary className="cursor-pointer">Assign categories to {unclassifiedProfiles.length} unclassified profiles</summary>
            <div className="mt-2 grid gap-2">
              {unclassifiedProfiles.map((profile) => <label key={profile.id} className="flex items-center gap-3">
                <span className="flex-1">{profile.name}</span>
                <select aria-label={`Category for ${profile.name}`} value="" onChange={(event) => void setProfileMode(profile.id, event.target.value as ModelDeployment)} className={field}>
                  <option value="" disabled>Choose category</option>
                  {MODEL_DEPLOYMENTS.map((value) => <option key={value} value={value}>{DEPLOYMENT_LABELS[value]}</option>)}
                </select>
              </label>)}
            </div>
          </details>}
        </section>
      </div>

      {confirmUnload && (
        <ConfirmDialog
          title={`Unload ${confirmUnload.model.id}?`}
          message={
            `${confirmUnload.model.turns} turn${confirmUnload.model.turns === 1 ? ' is' : 's are'} answering on this ` +
            `model right now — a conversation, an agent, or a paired device. Unloading it stops the worker, so those ` +
            `turns end where they are. What they have already written and done is kept.`
          }
          confirmLabel="Unload anyway"
          tone="danger"
          onConfirm={() => void free(confirmUnload.sourceId, confirmUnload.model)}
          onCancel={() => setConfirmUnload(null)}
        />
      )}
    </div>
  );
}
