import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { dump, load } from 'js-yaml';
import type { Model } from '../../api/types';
import { BUNDLED_BEHOLDD_ARCHITECTURES } from '../../api/beholdd';
import type { InferenceSource } from '../sourceStore';
import { forkQuantizationReason } from './gguf';
import type { DownloadRecord, Registration } from './types';
import { writePrivateFileAtomic } from '../privateState';
import { persistedModel } from '../probe';

/**
 * Getting a downloaded model in front of an engine that can run it.
 *
 * Neither beholdd takes a new model while it runs, so each gets what it can actually use:
 *
 * - The bundled beholdd (v2) reads its model list at startup and serves the `qwen3` and `qwen3moe`
 *   architectures (vendor/beholdd/share/serving.md). A supported download is added to a generated
 *   copy of its configuration and the server restarts — once nothing is mid-request on it, since
 *   a restart drops the stream of whoever is using it. Its base configuration is never edited.
 * - An external beholdd v1 (the legacy GPU server) resolves an absolute GGUF path given as the
 *   model id, and loads any architecture its llama.cpp backends know. Registering there is adding
 *   that path to the source's model list: no configuration, no restart, usable immediately.
 */

/** Architectures the bundled native beholdd runtime can execute end to end. */
export const BUNDLED_ARCHITECTURES: ReadonlySet<string> = new Set<string>(BUNDLED_BEHOLDD_ARCHITECTURES);

/**
 * The model-entry dials of the validated streaming profile (releases/linux-x86_64/beholdd.streaming.yaml),
 * used when there is no base entry to copy. Cache sizes are requested maxima; the fit planner caps them.
 */
export const STREAMING_PROFILE: Record<string, unknown> = {
  weight_mode: 'streaming',
  fit_policy: 'exact',
  allow_unsafe_storage: false,
  pinned_cache_bytes: 4_000_000_000,
  demand_cache_bytes: 6_000_000_000,
  prefetch_bytes: 1_073_741_824,
  prefetch_queue_depth: 8,
  prefetch_workers: 4,
  near_miss_prefetch: false,
};

export interface OverlayEntry {
  id: string;
  path: string;
}

export interface Overlay {
  config: Record<string, unknown>;
  /** The id each downloaded path is served under: its own, or a base entry's that already names that file. */
  ids: Map<string, string>;
  /** Paths the base configuration already served before anything was added. */
  inBase: Set<string>;
}

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * The base configuration plus downloaded models.
 *
 * New entries copy the first CPU base model's dials (budgets, weight mode, caches), because those were
 * chosen for this machine by someone who measured it; the streaming profile is the fallback. The
 * copy is written elsewhere, so relative paths in the base are made absolute against its directory.
 */
export function buildOverlay(baseText: string | null, baseDir: string, entries: OverlayEntry[]): Overlay {
  const parsed = baseText?.trim() ? load(baseText) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The beholdd configuration is not a YAML mapping.');
  }
  const base = parsed as Record<string, unknown>;
  const models = (Array.isArray(base.models) ? (base.models as Record<string, unknown>[]) : []).map((model) => {
    const entry = { ...model };
    if (typeof entry.path === 'string' && !isAbsolute(entry.path)) entry.path = resolve(baseDir, entry.path);
    return entry;
  });

  const byPath = new Map<string, string>();
  for (const model of models) {
    if (typeof model.path === 'string' && typeof model.id === 'string') byPath.set(canonical(model.path), model.id);
  }
  const taken = new Set(models.map((model) => String(model.id)));
  // A pinned HAG entry is not a template for arbitrary downloaded checkpoints. Even a CPU
  // entry can retain stale backend options, so strip these from the copied dials explicitly.
  const cpuTemplate = models.find((model) => model.execution_backend === undefined || model.execution_backend === 'cpu');
  const { id: _id, path: _path, execution_backend: _backend, hag: _hag, hag_qwen35: _qwen35,
    ...template } = cpuTemplate ?? STREAMING_PROFILE;

  const ids = new Map<string, string>();
  const inBase = new Set<string>();
  for (const entry of entries) {
    const existing = byPath.get(canonical(entry.path));
    if (existing) {
      ids.set(entry.path, existing);
      inBase.add(entry.path);
      continue;
    }
    let id = entry.id;
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${entry.id}-${suffix}`;
    taken.add(id);
    byPath.set(canonical(entry.path), id);
    ids.set(entry.path, id);
    models.push({ id, path: entry.path, ...template });
  }

  return { config: { ...base, models }, ids, inBase };
}

export function renderOverlay(config: Record<string, unknown>, basePath: string | null): string {
  const header = [
    '# Generated by Antimatter each time the bundled beholdd starts. Edits here are overwritten.',
    basePath
      ? `# Base: ${basePath}. Change settings there; they carry over.`
      : '# No base configuration existed, so model entries use the validated streaming profile.',
    '# Entries after the base models were downloaded in the Model Hub.',
    '',
  ].join('\n');
  return `${header}${dump(config, { lineWidth: -1, noRefs: true })}`;
}

/** The legacy beholdd server reports its engine on /health; beholdd v2 answers `{"status":"ok"}` and nothing else. */
export const acceptsPathModels = (health: unknown): boolean =>
  !!health && typeof health === 'object' && typeof (health as Record<string, unknown>).engine === 'string';

/** The window a server gives models it has not been told about: the one it gives most of the rest. */
export function typicalContext(models: Model[]): number | null {
  const counts = new Map<number, number>();
  for (const model of models) {
    if (model.contextWindow) counts.set(model.contextWindow, (counts.get(model.contextWindow) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [value, count] of counts) if (best === null || count > (counts.get(best) ?? 0)) best = value;
  return best;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function loopbackPort(baseUrl: string): number | null {
  try {
    const url = new URL(baseUrl);
    if (!LOOPBACK.has(url.hostname.toLowerCase())) return null;
    return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  } catch {
    return null;
  }
}

/** Puts path models registered on this source back after a refresh replaced its model list. */
export function withRegisteredModels(source: InferenceSource, records: DownloadRecord[]): InferenceSource {
  let models = source.models;
  let changed = false;
  for (const record of records) {
    if (record.state !== 'ready' || !record.path) continue;
    const registered = record.registrations.find(
      (entry) =>
        entry.sourceId === source.id &&
        (entry.status === 'registered' || (entry.target === 'bundled' && entry.status === 'pending'))
    );
    if (!registered?.modelId) continue;
    const index = models.findIndex((model) => model.id === registered.modelId);
    if (index !== -1) {
      const current = models[index];
      const decorated = downloadModel(record, models, registered.modelId, current);
      if (
        decorated.name !== current.name ||
        decorated.architecture !== current.architecture ||
        decorated.quantization !== current.quantization ||
        decorated.contextWindow !== current.contextWindow
      ) {
        models = [...models.slice(0, index), decorated, ...models.slice(index + 1)];
        changed = true;
      }
      continue;
    }
    // A pending bundled model is not selectable until the restarted server actually lists it.
    if (registered.target !== 'external' || registered.status !== 'registered') continue;
    models = [...models, downloadModel(record, models, registered.modelId)];
    changed = true;
  }
  return changed ? { ...source, models } : source;
}

function downloadModel(record: DownloadRecord, siblings: Model[], id: string, current?: Model): Model {
  const server = typicalContext(siblings.filter((model) => !isAbsolute(model.id)));
  const own = record.contextLength;
  const contextWindow = server && own ? Math.min(server, own) : (server ?? own ?? undefined);
  const architecture = current?.architecture ?? record.architecture ?? undefined;
  const quantization = current?.quantization ?? record.quantization ?? undefined;
  const effectiveContext = current?.contextWindow ?? contextWindow;
  return {
    id,
    name: current?.name ?? record.modelId,
    ...(architecture ? { architecture } : {}),
    ...(quantization ? { quantization } : {}),
    ...(effectiveContext ? { contextWindow: effectiveContext } : {}),
    // Capacity belongs to this observed server/model pair, never to a sibling or GGUF file.
    ...(current?.maxEvaluatedTokens !== undefined ? { maxEvaluatedTokens: current.maxEvaluatedTokens } : {}),
    ...(current?.vision !== undefined ? { vision: current.vision } : {}),
    ...(current?.manuallyDeclared !== undefined ? { manuallyDeclared: current.manuallyDeclared } : {}),
    ...(current?.contextWindowCurated ? { contextWindowCurated: true } : {}),
    ...(current?.visionCurated ? { visionCurated: true } : {}),
  };
}

function pathModel(record: DownloadRecord, siblings: Model[]): Model {
  return downloadModel(record, siblings, record.path!);
}

export interface BundledStatus {
  running: boolean;
  ready: boolean;
  ownership: 'app' | 'external' | null;
  host: string | null;
  port: number | null;
}

export interface RegistrarDeps {
  overlayPath: string;
  /** The configuration the bundled server would start from without any downloads. */
  basePath(): string;
  sources(): InferenceSource[];
  saveSource(source: InferenceSource): void;
  /** Where Antimatter's own server listens, or would. */
  bundledPort(): number;
  bundledStatus(): Promise<BundledStatus>;
  restartBundled(target: { host: string; port: number }): Promise<{ ready: boolean }>;
  /** A request is streaming on this source right now. */
  sourceBusy(sourceId: string): boolean;
  probe(baseUrl: string, apiKey?: string): Promise<{ ok: boolean; models: Model[]; error?: string }>;
  health(baseUrl: string): Promise<unknown>;
  /** Finished model downloads, as they stand. */
  records(): DownloadRecord[];
  setRegistrations(id: string, registrations: Registration[]): void;
  /** Source model lists changed; the renderer should refetch them. */
  changed(): void;
  log(message: string): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const COALESCE_MS = 1500;
const BUSY_POLL_MS = 2000;

export class Registrar {
  private restartWanted = false;
  private restartLoop: Promise<void> | null = null;

  constructor(private readonly deps: RegistrarDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  private bundledSource(): InferenceSource | null {
    const port = this.deps.bundledPort();
    return (
      this.deps
        .sources()
        .find((source) => (source.kind ?? 'beholdd') === 'beholdd' && loopbackPort(source.baseUrl) === port) ?? null
    );
  }

  /** The base configuration and the downloads it would be served with, without writing anything. */
  private overlay(): { overlay: Overlay; baseText: string | null; basePath: string; records: DownloadRecord[] } {
    const basePath = this.deps.basePath();
    const records = this.eligible();
    const baseText = existsSync(basePath) ? readFileSync(basePath, 'utf8') : null;
    const entries = records.map((record) => ({ id: record.modelId, path: record.path! }));
    return { overlay: buildOverlay(baseText, dirname(basePath), entries), baseText, basePath, records };
  }

  /** The id each eligible download is served under on the bundled engine. */
  private servedIds(): Map<string, string> {
    try {
      const { overlay, records } = this.overlay();
      return new Map(records.map((record) => [record.id, overlay.ids.get(record.path!) ?? record.modelId]));
    } catch (error) {
      this.deps.log(`could not read the bundled beholdd configuration: ${(error as Error).message}`);
      return new Map();
    }
  }

  private eligible(): DownloadRecord[] {
    return this.deps
      .records()
      .filter(
        (record) =>
          record.state === 'ready' &&
          record.role === 'model' &&
          !!record.path &&
          !!record.architecture &&
          BUNDLED_ARCHITECTURES.has(record.architecture) &&
          !forkQuantizationReason(record.fileType) &&
          existsSync(record.path)
      );
  }

  /** The exact overlay a start would write, or null when the base is used unchanged. */
  private preparedConfig(): string | null {
    const { overlay, baseText, basePath, records } = this.overlay();
    // Nothing to add, or everything downloaded is already named by the base: start on the base.
    if (!records.length || records.every((record) => overlay.inBase.has(record.path!))) return null;
    return renderOverlay(overlay.config, baseText === null ? null : basePath);
  }

  /** Read-only startup inspection; errors follow the same default-config fallback as start(). */
  canPrepareStart(): boolean {
    return this.preparedConfig() !== null;
  }

  /**
   * Writes the overlay for the next start of the bundled server and returns its path, or null when
   * no download needs one — then the server starts on its base configuration exactly as before.
   */
  prepareStart(): string | null {
    const config = this.preparedConfig();
    if (config === null) return null;
    writePrivateFileAtomic(this.deps.overlayPath, config);
    return this.deps.overlayPath;
  }

  /** Registers a finished download everywhere it can run. Never throws: failures are recorded. */
  async register(record: DownloadRecord): Promise<void> {
    if (record.role !== 'model' || !record.path) return;
    const registrations = [this.bundledRegistration(record, this.servedIds()), ...(await this.externalRegistrations(record))];
    this.deps.setRegistrations(record.id, registrations);
    if (registrations.some((entry) => entry.target === 'bundled' && entry.status === 'pending')) this.scheduleRestart();
  }

  /** Takes a download back out of every source it was added to. */
  unregister(record: DownloadRecord): void {
    let changed = false;
    for (const source of this.deps.sources()) {
      const models = source.models.filter((model) => model.id !== record.path);
      if (models.length !== source.models.length) {
        this.deps.saveSource({ ...source, models });
        changed = true;
      }
    }
    if (changed) this.deps.changed();
    if (record.registrations.some((entry) => entry.target === 'bundled' && entry.status !== 'unsupported')) {
      this.scheduleRestart();
    }
  }

  /** Startup: re-adds path models and reads back what the bundled server actually lists. */
  async reconcile(): Promise<void> {
    for (const record of this.deps.records()) {
      if (record.state !== 'ready' || record.role !== 'model' || !record.path) continue;
      await this.register(record);
    }
  }

  private bundledRegistration(record: DownloadRecord, served: Map<string, string>): Registration {
    const source = this.bundledSource();
    const base = {
      target: 'bundled' as const,
      sourceId: source?.id ?? null,
      sourceName: source?.name ?? 'bundled beholdd',
      at: this.now(),
    };
    if (!record.architecture) {
      return { ...base, status: 'unsupported', modelId: null, detail: 'Its GGUF header could not be read, so no engine can be chosen for it.' };
    }
    const forkReason = forkQuantizationReason(record.fileType);
    if (forkReason) return { ...base, status: 'unsupported', modelId: null, detail: forkReason };
    if (!BUNDLED_ARCHITECTURES.has(record.architecture)) {
      return {
        ...base,
        status: 'unsupported',
        modelId: null,
        detail: `The bundled engine runs ${[...BUNDLED_ARCHITECTURES].join(' and ')} models; this one is ${record.architecture}.`,
      };
    }
    const modelId = served.get(record.id) ?? record.modelId;
    const listed = source?.models.some((model) => model.id === modelId);
    return listed
      ? { ...base, status: 'registered', modelId, detail: null }
      : { ...base, status: 'pending', modelId, detail: 'Adding it to the bundled engine…' };
  }

  private async externalRegistrations(record: DownloadRecord): Promise<Registration[]> {
    const bundledPort = this.deps.bundledPort();
    const registrations: Registration[] = [];
    // A quantization no llama.cpp build here decodes is a fact about the file, not about a server,
    // so it is settled once and reported against every source rather than probed for.
    const forkReason = forkQuantizationReason(record.fileType);
    let withdrawn = false;

    for (const source of this.deps.sources()) {
      const port = loopbackPort(source.baseUrl);
      // A path is only meaningful to a server on this machine; the bundled one is handled above.
      if ((source.kind ?? 'beholdd') !== 'beholdd' || port === null || port === bundledPort) continue;
      const base = { target: 'external' as const, sourceId: source.id, sourceName: source.name, at: this.now() };

      if (forkReason) {
        // A model registered before its file type was read back is still on the source, where it
        // reads as one that works. Take it back out rather than only labelling the download.
        if (source.models.some((model) => model.id === record.path)) {
          this.deps.saveSource({ ...source, models: source.models.filter((model) => model.id !== record.path) });
          withdrawn = true;
        }
        registrations.push({ ...base, status: 'unsupported', modelId: null, detail: forkReason });
        continue;
      }

      let health: unknown = null;
      try {
        health = await this.deps.health(source.baseUrl);
      } catch {
        health = null;
      }
      if (health === null) {
        registrations.push({ ...base, status: 'failed', modelId: null, detail: `${source.name} did not answer; retry once it is running.` });
        continue;
      }
      if (!acceptsPathModels(health)) {
        registrations.push({
          ...base,
          status: 'unsupported',
          modelId: null,
          detail: `${source.name} only serves models from its own configuration.`,
        });
        continue;
      }

      if (!source.models.some((model) => model.id === record.path)) {
        this.deps.saveSource({ ...source, models: [...source.models, pathModel(record, source.models)] });
      }
      registrations.push({ ...base, status: 'registered', modelId: record.path, detail: null });
    }

    if (withdrawn || registrations.some((entry) => entry.status === 'registered')) this.deps.changed();
    return registrations;
  }

  private scheduleRestart(): void {
    this.restartWanted = true;
    if (this.restartLoop) return;
    this.restartLoop = this.restartWhenIdle()
      .catch((error) => this.deps.log(`bundled restart failed: ${(error as Error).message}`))
      .finally(() => {
        this.restartLoop = null;
        if (this.restartWanted) this.scheduleRestart();
      });
  }

  /**
   * Gives every bundled registration one status, so the UI says what is happening. With `listed`,
   * a model the server now serves becomes registered; one registered after `since` is left for the
   * next pass, because the restart that just finished never included it.
   */
  private settleBundled(status: Registration['status'], detail: string | null, listed?: Set<string>, since?: number): void {
    for (const record of this.deps.records()) {
      const current = record.registrations.find((entry) => entry.target === 'bundled');
      if (!current || current.status === 'unsupported') continue;
      if (since !== undefined && current.at > since && !listed?.has(current.modelId ?? '')) continue;
      const registered = !!current.modelId && (listed?.has(current.modelId) ?? false);
      const next: Registration = registered
        ? { ...current, status: 'registered', detail: null, at: this.now() }
        : { ...current, status, detail, at: this.now() };
      if (next.status === current.status && next.detail === current.detail) continue;
      this.deps.setRegistrations(
        record.id,
        record.registrations.map((entry) => (entry.target === 'bundled' ? next : entry))
      );
    }
  }

  private async restartWhenIdle(): Promise<void> {
    await this.sleep(COALESCE_MS);

    while (this.restartWanted) {
      const status = await this.deps.bundledStatus();
      if (!status.running) {
        this.restartWanted = false;
        this.settleBundled('pending', 'The bundled engine is stopped; it loads this when it next starts.');
        return;
      }
      if (status.ownership !== 'app') {
        this.restartWanted = false;
        this.settleBundled(
          'pending',
          `The beholdd on port ${status.port} is managed outside Antimatter; start it from Antimatter to serve downloads.`
        );
        return;
      }

      // Already serving exactly what the configuration would hold — at startup, typically. Read it back instead.
      const startedAt = this.now();
      if (await this.alreadyServing()) {
        this.restartWanted = false;
        await this.refreshBundledModels(startedAt);
        continue;
      }

      const source = this.bundledSource();
      if (source && this.deps.sourceBusy(source.id)) {
        this.settleBundled('pending', 'Waiting for the current request on the bundled engine to finish before restarting it.');
        await this.sleep(BUSY_POLL_MS);
        continue;
      }

      this.restartWanted = false;
      this.settleBundled('pending', 'Restarting the bundled engine to load it…');
      this.deps.log('restarting the bundled beholdd to apply Model Hub changes');
      const next = await this.deps.restartBundled({ host: status.host ?? '127.0.0.1', port: status.port ?? this.deps.bundledPort() });
      if (!next.ready) {
        this.settleBundled('failed', 'The bundled engine did not come back after restarting; its log is in Settings.');
        return;
      }
      await this.refreshBundledModels(startedAt);
    }
  }

  private async alreadyServing(): Promise<boolean> {
    const source = this.bundledSource();
    const baseUrl = source?.baseUrl ?? `http://127.0.0.1:${this.deps.bundledPort()}/v1`;
    const probe = await this.deps.probe(baseUrl, source?.apiKey || undefined);
    if (!probe.ok) return false;
    try {
      const expected = new Set(
        (this.overlay().overlay.config.models as Record<string, unknown>[]).map((model) => String(model.id))
      );
      const listed = new Set(probe.models.map((model) => model.id));
      return expected.size === listed.size && [...expected].every((id) => listed.has(id));
    } catch {
      return false;
    }
  }

  /** Asks the bundled server what it serves now and records that on its source. */
  private async refreshBundledModels(since: number): Promise<void> {
    const port = this.deps.bundledPort();
    const existing = this.bundledSource();
    const baseUrl = existing?.baseUrl ?? `http://127.0.0.1:${port}/v1`;
    const probe = await this.deps.probe(baseUrl, existing?.apiKey || undefined);
    if (!probe.ok) {
      this.settleBundled('failed', `The bundled engine restarted but did not list its models (${probe.error ?? 'no answer'}).`);
      return;
    }

    const previous = new Map(existing?.models.map((model) => [model.id, model]) ?? []);
    const models = probe.models.map((model) => persistedModel(model, previous.get(model.id)));
    const refreshed: InferenceSource =
      existing
        ? { ...existing, models }
        : {
            id: 'bundled-beholdd',
            name: 'Beholdd (native)',
            kind: 'beholdd',
            protocol: 'openai-chat',
            apiKey: '',
            baseUrl,
            models,
            supportsStreaming: true,
            createdAt: this.now(),
          };
    // The server can report its id/window, while the verified Hub record knows architecture and
    // quantization. Keep both sets of facts on the one source-scoped catalog entry.
    this.deps.saveSource(withRegisteredModels(refreshed, this.deps.records()));
    this.settleBundled(
      'failed',
      'The bundled engine restarted without it; check its log in Settings.',
      new Set(models.map((model) => model.id)),
      since
    );
    this.deps.changed();
  }
}
