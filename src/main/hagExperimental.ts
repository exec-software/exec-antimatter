import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { HagExperimentalState } from '../api/hag';
import { HAG_SOURCE_ID, HAG_MODEL_ID } from '../api/hag';
import type { InferenceSource } from './sourceStore';
import type { SourceReadiness } from './sourceReadiness';
import { ensurePrivateDirectory, writePrivateFileAtomic } from './privateState';
import { hagCapability, launchHag, HagProcessCleanupError, type HagProcess } from './hagProcess';
import { abortableRead, LocalInferenceQueue } from './localInferenceQueue';

export { HAG_SOURCE_ID, HAG_MODEL_ID } from '../api/hag';
export const HAG_PORT = 6769;
export const HAG_MODEL_BYTES = 639_447_744;
export const HAG_MODEL_SHA256 = 'e150ed544dfe6016930c026a93913a5e3184181ebfe6ab2223ae01dd0491784c';
export const HAG_MODEL_FILE = 'Qwen3-0.6B-Q8_0.gguf';
export const HAG_BASE_URL = `http://127.0.0.1:${HAG_PORT}/v1`;
const MODEL = { id: HAG_MODEL_ID, name: 'Qwen3 0.6B · HAG experimental', maxEvaluatedTokens: 16_384 };

interface Saved { version: 1; enabled: boolean; welcomeSeen: boolean; modelPath: string | null }
const empty = (): Saved => ({ version: 1, enabled: false, welcomeSeen: false, modelPath: null });
export function parseHagSettings(value: unknown): Saved {
  const saved = value as Partial<Saved> | null;
  if (!saved || saved.version !== 1 || typeof saved.enabled !== 'boolean' ||
      typeof saved.welcomeSeen !== 'boolean' || (saved.modelPath !== null && typeof saved.modelPath !== 'string')) return empty();
  return { version: 1, enabled: saved.enabled, welcomeSeen: saved.welcomeSeen, modelPath: saved.modelPath };
}

/** Only the exact app-created source may be replaced or removed by this lifecycle. */
export function isOwnedHagSource(source: Pick<InferenceSource, 'id' | 'baseUrl' | 'kind' | 'models'>): boolean {
  return source.id === HAG_SOURCE_ID && source.baseUrl === HAG_BASE_URL && source.kind === 'beholdd' &&
    source.models.length === 1 && source.models[0].id === HAG_MODEL_ID;
}

export function hagSource(): InferenceSource {
  return { id: HAG_SOURCE_ID, name: 'Beholdd HAG (experimental)', kind: 'beholdd', protocol: 'openai-chat',
    baseUrl: HAG_BASE_URL, apiKey: '', supportsStreaming: true, createdAt: Date.now(),
    models: [{ id: HAG_MODEL_ID, name: MODEL.name, architecture: 'qwen3', quantization: 'Q8_0',
      contextWindow: 16_384, maxEvaluatedTokens: 16_384, deployment: 'local' }] };
}

export function hagConfig(modelPath: string, device: string): string {
  // JSON strings are also YAML strings; never interpolate an unquoted filesystem path.
  return `memory_budget_bytes: 6442450944\nruntime_headroom_bytes: 134217728\nmodels:\n  - id: ${HAG_MODEL_ID}\n    path: ${JSON.stringify(modelPath)}\n    execution_backend: hag\n    hag:\n      device: ${JSON.stringify(device)}\n      context_capacity: 16384\n      memory_budget_bytes: 4831838208\n    weight_mode: streaming\n    fit_policy: exact\n    allow_unsafe_storage: false\n    pinned_cache_bytes: 0\n    demand_cache_bytes: 0\n    prefetch_bytes: 0\n    prefetch_queue_depth: 0\n    prefetch_workers: 0\n    near_miss_prefetch: false\n`;
}

export async function verifyHagModel(path: string): Promise<void> {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== HAG_MODEL_BYTES) throw new Error('HAG requires the pinned Qwen3-0.6B Q8_0 checkpoint.');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) digest.update(chunk);
  const after = lstatSync(path);
  if (digest.digest('hex') !== HAG_MODEL_SHA256 || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error('The HAG checkpoint identity did not match; no model was started.');
  }
}

/** Package-controlled URL; renderers cannot supply a URL, path, checkpoint, or executable. */
export function hagDownloadUrl(vendorRoot: string): string {
  const descriptor = JSON.parse(readFileSync(join(vendorRoot, 'model.json'), 'utf8'));
  const url = new URL(descriptor.source?.url);
  if (descriptor.schemaVersion !== 1 || descriptor.sha256 !== HAG_MODEL_SHA256 || descriptor.bytes !== HAG_MODEL_BYTES ||
      descriptor.source?.repository !== 'unsloth/Qwen3-0.6B-GGUF' ||
      descriptor.source?.revision !== '50968a4468ef4233ed78cd7c3de230dd1d61a56b' ||
      descriptor.filename !== HAG_MODEL_FILE || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('The packaged HAG model download descriptor is invalid.');
  }
  return url.toString();
}

export async function downloadHagModel(url: string, target: string, progress: (bytes: number) => void, signal?: AbortSignal): Promise<void> {
  const temporary = `${target}.download-${process.pid}-${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15 * 60_000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') throw new Error(`HAG model download failed (HTTP ${response.status}).`);
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) !== HAG_MODEL_BYTES) throw new Error('HAG checkpoint download has an unexpected size.');
    file = await open(temporary, 'wx', 0o600);
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > HAG_MODEL_BYTES) throw new Error('HAG checkpoint download exceeded its fixed size.');
        await file.writeFile(value);
        progress(bytes);
      }
      if (bytes !== HAG_MODEL_BYTES) throw new Error('HAG checkpoint download was incomplete.');
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    await file.sync(); await file.close(); file = null;
    await verifyHagModel(temporary);
    renameSync(temporary, target);
  } finally {
    clearTimeout(timer); controller.abort();
    signal?.removeEventListener('abort', abort);
    await file?.close().catch(() => undefined);
    rmSync(temporary, { force: true });
  }
}

export interface HagExperimentalOptions {
  directory: string;
  vendorRoot: string;
  home: string;
  busy(): boolean;
  register(source: InferenceSource): void;
  remove(): void;
  beforeStart(signal?: AbortSignal): Promise<void>;
  changed(state: HagExperimentalState): void;
  capability?: typeof hagCapability;
  verifyModel?: typeof verifyHagModel;
  download?: typeof downloadHagModel;
  launch?: typeof launchHag;
}

export class HagExperimental {
  private saved: Saved;
  private process: HagProcess | null = null;
  private phase: HagExperimentalState['status'] = 'disabled';
  private error: string | null = null;
  private progress: HagExperimentalState['downloadProgress'] = null;
  private readonly operations = new LocalInferenceQueue();
  private verifiedPath: string | null = null;
  private stopping = false;
  private operation = new AbortController();
  private generation = 0;

  constructor(private readonly options: HagExperimentalOptions) {
    try { this.saved = parseHagSettings(JSON.parse(readFileSync(this.settingsPath, 'utf8'))); }
    catch { this.saved = empty(); }
    this.phase = this.saved.enabled ? 'stopped' : 'disabled';
  }
  private get settingsPath(): string { return join(this.options.directory, 'settings.json'); }
  private save(): void { writePrivateFileAtomic(this.settingsPath, JSON.stringify(this.saved, null, 2) + '\n'); }
  private changed(): void { this.options.changed(this.state()); }
  private queue<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.operations.run(fn, signal);
  }
  private capability() { return (this.options.capability ?? hagCapability)(this.options.vendorRoot); }
  state(): HagExperimentalState {
    const capability = this.capability();
    return { showWelcome: !this.saved.welcomeSeen, enabled: this.saved.enabled, available: capability.device !== null,
      unavailableReason: capability.reason, status: this.phase, error: this.error, model: { ...MODEL },
      sourceId: HAG_SOURCE_ID, modelDownloadBytes: this.verifiedPath ? 0 : HAG_MODEL_BYTES,
      downloadProgress: this.progress && { ...this.progress } };
  }
  /** Startup is metadata-only; consent persists, but no checkpoint is loaded or downloaded. */
  initialize(): void { if (this.saved.enabled) this.options.register(hagSource()); else this.options.remove(); }
  dismissWelcome(): HagExperimentalState { this.saved.welcomeSeen = true; this.save(); this.changed(); return this.state(); }
  readiness(): SourceReadiness {
    const state = this.state();
    if (!state.enabled || !state.available) return { state: 'unreachable', detail: state.unavailableReason ?? 'Enable the experimental HAG backend in Settings first.' };
    if (state.status === 'ready') return { state: 'ready' };
    if (state.status === 'starting' || state.status === 'downloading') return { state: 'loading', detail: 'Preparing the experimental HAG backend.' };
    if (state.status === 'error') return { state: 'unreachable', detail: state.error ?? 'HAG stopped. Disable and re-enable it in Settings to retry.' };
    return { state: 'startable', detail: 'HAG will start when you send a message.' };
  }
  enable(): Promise<HagExperimentalState> { return this.queue(async () => {
    this.operation = new AbortController();
    try {
      if (this.process && this.phase === 'ready') return this.state();
      // Re-enabling is explicit retry permission, never permission to adopt an uncertain owner.
      if (this.process && this.phase === 'error') await this.stopNow(false);
      const capability = this.capability();
      if (!capability.device) throw new Error(capability.reason ?? 'HAG is unavailable on this computer.');
      ensurePrivateDirectory(this.options.directory);
      const verify = this.options.verifyModel ?? verifyHagModel;
      const target = join(this.options.directory, 'models', HAG_MODEL_FILE);
      const candidates = [this.saved.modelPath, target,
        join(this.options.home, '.beholdd', 'models', 'qwen3-0.6b-hag', HAG_MODEL_FILE)].filter((p): p is string => !!p);
      this.error = null; this.phase = 'starting'; this.changed();
      let model: string | null = null;
      for (const candidate of [...new Set(candidates)]) {
        if (!existsSync(candidate)) continue;
        try { await verify(candidate); model = candidate; break; } catch { /* Never run an unverified local checkpoint. */ }
      }
      if (!model) {
        const url = hagDownloadUrl(this.options.vendorRoot);
        ensurePrivateDirectory(join(this.options.directory, 'models'));
        this.phase = 'downloading'; this.progress = { receivedBytes: 0, totalBytes: HAG_MODEL_BYTES }; this.changed();
        let published = 0;
        await (this.options.download ?? downloadHagModel)(url, target, (bytes) => {
          this.progress = { receivedBytes: bytes, totalBytes: HAG_MODEL_BYTES };
          if (bytes - published >= 4 * 1024 * 1024 || bytes === HAG_MODEL_BYTES) { published = bytes; this.changed(); }
        }, this.operation.signal);
        await verify(target); model = target;
      }
      this.verifiedPath = model;
      // Register first: a collision must not persist an enabled preference.
      this.options.register(hagSource());
      this.saved = { version: 1, enabled: true, welcomeSeen: true, modelPath: model };
      this.save(); this.phase = this.process ? 'ready' : 'stopped'; this.progress = null; this.changed();
      return this.state();
    } catch (error) { this.phase = 'error'; this.error = error instanceof Error ? error.message : String(error); this.progress = null; this.changed(); throw error; }
  }); }
  start(signal?: AbortSignal): Promise<void> { return this.queue(async () => {
    signal?.throwIfAborted();
    this.operation = new AbortController();
    if (!this.saved.enabled) throw new Error('Enable HAG in Settings before selecting its model.');
    if (this.process && this.phase === 'ready') return;
    if (this.phase === 'error') throw new Error(this.error ?? 'Re-enable HAG in Settings to retry.');
    const operation = this.operation;
    const abort = () => operation.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const capability = this.capability();
      if (!capability.device || !this.saved.modelPath) throw new Error(capability.reason ?? 'The HAG checkpoint is unavailable.');
      this.phase = 'starting'; this.changed();
      await abortableRead((this.options.verifyModel ?? verifyHagModel)(this.saved.modelPath), operation.signal);
      operation.signal.throwIfAborted();
      await this.options.beforeStart(operation.signal);
      operation.signal.throwIfAborted();
      const config = join(this.options.directory, 'config.yaml');
      writePrivateFileAtomic(config, hagConfig(this.saved.modelPath, capability.device));
      const generation = ++this.generation;
      this.process = await (this.options.launch ?? launchHag)({ binary: join(this.options.vendorRoot, 'bin', 'beholdd'), config,
        port: HAG_PORT, modelId: HAG_MODEL_ID, signal: operation.signal, onExit: (reason, retired = true) => {
          if (generation !== this.generation) return;
          if (retired) this.process = null;
          if (!this.stopping) { this.phase = 'error'; this.error = reason; this.changed(); }
        } });
      if (operation.signal.aborted) {
        await this.stopNow(true);
        operation.signal.throwIfAborted();
      }
      this.phase = 'ready'; this.error = null; this.changed();
    } catch (error) {
      if (error instanceof HagProcessCleanupError) this.process = error.process;
      const cancelled = operation.signal.aborted && !this.process;
      this.phase = cancelled ? 'stopped' : 'error';
      this.error = cancelled ? null : error instanceof Error ? error.message : String(error);
      this.changed(); throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }, signal); }
  stop(force = false): Promise<void> {
    if (force) this.operation.abort();
    return this.queue(() => this.stopNow(force));
  }
  private async stopNow(force: boolean): Promise<void> {
    if (!force && this.options.busy()) throw new Error('HAG is serving a request. Stop the turn before switching backends.');
    this.stopping = true;
    try { await this.process?.stop(); this.generation += 1; this.process = null; this.phase = this.saved.enabled ? 'stopped' : 'disabled'; this.changed(); }
    finally { this.stopping = false; }
  }
  disable(): Promise<HagExperimentalState> { return this.queue(async () => {
    await this.stopNow(false);
    this.options.remove();
    this.saved.enabled = false; this.saved.welcomeSeen = true; this.save();
    this.phase = 'disabled'; this.error = null; this.changed(); return this.state();
  }); }
}
