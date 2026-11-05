import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PensieveCorpus, PensieveExperimentalState, PensieveRequest } from '../api/pensieve';
import { ensurePrivateDirectory, writePrivateFileAtomic } from './privateState';

interface Saved { version: 1; enabled: boolean }
export function parsePensieveSettings(value: unknown): Saved {
  const saved = value as Partial<Saved> | null;
  return saved?.version === 1 && typeof saved.enabled === 'boolean'
    ? { version: 1, enabled: saved.enabled } : { version: 1, enabled: false };
}

/** Paths are application configuration, never fields accepted from a model or renderer. */
export function discoverPensievePaths(options: {
  resourcesPath?: string; appPath: string; environment?: NodeJS.ProcessEnv;
}): { runtimeRoot: string; curriculumPath: string; python: string } {
  const environment = options.environment ?? process.env;
  const candidates = [options.resourcesPath && join(options.resourcesPath, 'vendor', 'pensieve'),
    join(options.appPath, 'vendor', 'pensieve')].filter((path): path is string => !!path);
  const bundled = candidates.find((path) => existsSync(join(path, 'pensieve', 'bridge.py'))) ?? candidates[0];
  const runtimeRoot = resolve(environment.ANTIMATTER_PENSIEVE_RUNTIME || bundled);
  return { runtimeRoot, curriculumPath: resolve(environment.ANTIMATTER_PENSIEVE_CURRICULUM || join(runtimeRoot, 'curriculum.json')),
    python: environment.ANTIMATTER_PENSIEVE_PYTHON || 'python3' };
}

export interface PensieveBridgeInput {
  runtimeRoot: string; curriculumPath: string; store: string; request: PensieveRequest;
  python?: string; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number;
}
const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);
const abortError = () => Object.assign(new Error('Pensieve operation cancelled.'), { name: 'AbortError' });

/** Bounded, one-shot app-owned process. Its module path cannot come from a project. */
export function runPensieveBridge(input: PensieveBridgeInput): Promise<unknown> {
  if (input.signal?.aborted) return Promise.reject(abortError());
  const payload = JSON.stringify(input.request);
  if (Buffer.byteLength(payload) > 16 * 1024 * 1024) return Promise.reject(new Error('Pensieve request exceeded 16 MiB.'));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PYTHON')));
  environment.PYTHONPATH = input.runtimeRoot;
  environment.PYTHONNOUSERSITE = '1';
  environment.PYTHONDONTWRITEBYTECODE = '1';
  environment.PYTHONUNBUFFERED = '1';
  return new Promise((resolveResult, reject) => {
    const child = spawn(input.python ?? 'python3', ['-s', '-m', 'pensieve.bridge', '--store', input.store,
      '--curriculum', input.curriculumPath], {
      cwd: input.runtimeRoot, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let settled = false;
    let failure: Error | null = null;
    let output = ''; let diagnostics = ''; let bytes = 0; let diagnosticBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { /* The process may already have exited. */ }
    };
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(finishTimer);
      input.signal?.removeEventListener('abort', cancel);
      if (!failure) clearTimeout(killTimer);
      error ? reject(error) : resolveResult(result);
    };
    const stop = (error: Error) => {
      if (settled || failure) return;
      failure = error; child.stdin.destroy(); kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 250);
      // Even a misbehaving process cannot hold the UI or shutdown indefinitely.
      finishTimer = setTimeout(() => { kill('SIGKILL'); finish(error); }, 2000);
    };
    const cancel = () => stop(abortError());
    const timer = setTimeout(() => stop(new Error('Pensieve bridge timed out.')), input.timeoutMs ?? 30_000);
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) cancel();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > (input.maxOutputBytes ?? 4 * 1024 * 1024)) stop(new Error('Pensieve bridge output exceeded its limit.'));
      else output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      diagnosticBytes += Buffer.byteLength(chunk);
      if (diagnosticBytes > 64 * 1024) stop(new Error('Pensieve bridge diagnostics exceeded their limit.'));
      else diagnostics += chunk;
    });
    child.stdin.on('error', (error) => { if (!failure) stop(new Error(`Pensieve bridge input failed: ${error.message}`)); });
    child.once('error', (error) => finish(new Error(`Could not start Pensieve bridge: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (failure) { finish(failure); return; }
      if (code !== 0) {
        finish(new Error(`Pensieve bridge exited ${signal ? `on ${signal}` : `with code ${code}`}.${diagnostics.trim() ? ` ${diagnostics.trim().slice(-2000)}` : ''}`));
        return;
      }
      try {
        const response = JSON.parse(output);
        if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') throw new Error('invalid response envelope');
        if (!response.ok) { finish(new Error(`Pensieve: ${typeof response.error === 'string' ? response.error : 'bridge operation failed'}`)); return; }
        if (!Object.hasOwn(response, 'result')) throw new Error('missing result');
        finish(undefined, response.result);
      } catch (error) { finish(new Error(`Pensieve bridge returned invalid JSON: ${describe(error)}`)); }
    });
    if (!failure) child.stdin.end(payload + '\n');
  });
}

export interface PensieveExperimentalOptions {
  directory: string; runtimeRoot: string; curriculumPath: string; python?: string;
  changed?(state: PensieveExperimentalState): void;
  /** Local process adapter for hardware-free lifecycle tests; never exposed over IPC. */
  bridge?: typeof runPensieveBridge;
}

export class PensieveExperimental {
  private saved: Saved;
  private phase: PensieveExperimentalState['status'];
  private error: string | null = null;
  private corpus: PensieveCorpus | null = null;
  private unavailableReason: string | null = null;
  private statistics: PensieveExperimentalState['statistics'] = null;
  private projectId: string | null = null;
  private pending: Promise<void> = Promise.resolve();
  private active = new Set<AbortController>();
  private generation = 0;

  constructor(private readonly options: PensieveExperimentalOptions) {
    this.options = { ...options, directory: resolve(options.directory), runtimeRoot: resolve(options.runtimeRoot), curriculumPath: resolve(options.curriculumPath) };
    try { this.saved = parsePensieveSettings(JSON.parse(readFileSync(join(options.directory, 'settings.json'), 'utf8'))); }
    catch { this.saved = { version: 1, enabled: false }; }
    this.phase = this.saved.enabled ? 'enabled' : 'disabled';
    this.inspectBundle();
    if (this.saved.enabled && this.unavailableReason) { this.phase = 'error'; this.error = this.unavailableReason; }
  }
  get enabled(): boolean { return this.saved.enabled; }
  /**
   * Whether the bundle this process can actually reach is usable.
   *
   * Separate from `enabled` because the two answer different questions, and conflating them made
   * an experimental feature able to kill an ordinary turn: `vendor/pensieve/` is gitignored apart
   * from its manifest (the corpus is not distributable), so a fresh checkout has the setting still
   * switched on from a previous run and no `bridge.py` to honour it. Every turn then failed with
   * `Pensieve bundle unavailable: ENOENT …` — on every model, since the bundle has nothing to do
   * with which model is answering. A turn must not depend on an experiment that cannot run.
   */
  get available(): boolean { return this.unavailableReason === null; }
  private save(): void { writePrivateFileAtomic(join(this.options.directory, 'settings.json'), JSON.stringify(this.saved, null, 2) + '\n'); }
  private changed(): void { this.options.changed?.(this.state()); }
  state(): PensieveExperimentalState {
    return { enabled: this.enabled, status: this.phase, available: this.unavailableReason === null,
      unavailableReason: this.unavailableReason, corpus: this.corpus && { ...this.corpus, languages: [...this.corpus.languages] },
      statistics: this.statistics && { ...this.statistics }, projectId: this.projectId, error: this.error };
  }
  private inspectBundle(): void {
    try {
      if (!statSync(join(this.options.runtimeRoot, 'pensieve', 'bridge.py')).isFile()) throw new Error('Pensieve bridge module is missing.');
      if (statSync(this.options.curriculumPath).size > 64 * 1024 * 1024) throw new Error('Pensieve curriculum exceeded 64 MiB.');
      const curriculum = JSON.parse(readFileSync(this.options.curriculumPath, 'utf8'));
      if (curriculum.schema_version !== 1 || typeof curriculum.id !== 'string' || !curriculum.id ||
          !Array.isArray(curriculum.entries) || !curriculum.entries.length) throw new Error('Pensieve curriculum format is unsupported or empty.');
      const languages = [...new Set<string>(curriculum.entries.map((entry: { language?: unknown }) =>
        typeof entry.language === 'string' ? entry.language : 'unknown'))].sort();
      this.corpus = { id: curriculum.id, entryCount: curriculum.entries.length, languages,
        sdkVersion: typeof curriculum.sdk?.source_revision === 'string' ? curriculum.sdk.source_revision : null };
      this.unavailableReason = null;
    } catch (error) { this.corpus = null; this.unavailableReason = `Pensieve bundle unavailable: ${describe(error)}`; }
  }
  private store(name: string): string {
    ensurePrivateDirectory(this.options.directory);
    const directory = join(this.options.directory, 'projects', name);
    ensurePrivateDirectory(join(this.options.directory, 'projects'));
    ensurePrivateDirectory(directory);
    const store = join(directory, 'memory.pensieve');
    if (!existsSync(store)) closeSync(openSync(store, 'wx', 0o600));
    const stat = lstatSync(store);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Pensieve store is not an owned file.');
    chmodSync(store, 0o600);
    return store;
  }
  private async call(store: string, request: PensieveRequest, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', abort, { once: true }); this.active.add(controller);
    try {
      return await (this.options.bridge ?? runPensieveBridge)({ runtimeRoot: resolve(this.options.runtimeRoot),
        curriculumPath: resolve(this.options.curriculumPath), python: this.options.python,
        store, request, signal: controller.signal });
    } finally { signal?.removeEventListener('abort', abort); this.active.delete(controller); }
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.pending.then(operation, operation);
    this.pending = pending.then(() => undefined, () => undefined);
    return pending;
  }
  enable(): Promise<PensieveExperimentalState> {
    const generation = this.generation;
    return this.queue(async () => {
      if (generation !== this.generation) throw abortError();
      this.inspectBundle();
      this.error = null; this.phase = 'checking'; this.changed();
      try {
        if (this.unavailableReason) throw new Error(this.unavailableReason);
        const result = await this.call(this.store('validation'), { op: 'status' });
        if (generation !== this.generation) throw abortError();
        this.acceptStatus(result, null);
        this.saved = { version: 1, enabled: true }; this.save();
        this.phase = 'ready'; this.changed(); return this.state();
      } catch (error) {
        if (generation === this.generation) {
          this.saved = { version: 1, enabled: false }; this.phase = 'error'; this.error = describe(error);
          this.save(); this.changed();
        }
        throw error;
      }
    });
  }
  async disable(): Promise<PensieveExperimentalState> {
    this.generation++; this.saved = { version: 1, enabled: false }; this.save();
    for (const controller of this.active) controller.abort();
    this.phase = 'disabled'; this.error = null; this.changed();
    return this.state();
  }
  private acceptStatus(result: unknown, projectId: string | null): void {
    const status = result as { corpus?: PensieveCorpus; events?: unknown; experiences?: unknown; repairs?: unknown } | null;
    if (!status?.corpus || status.corpus.id !== this.corpus?.id || status.corpus.entryCount !== this.corpus.entryCount) {
      throw new Error('Pensieve bridge did not confirm the pinned curriculum.');
    }
    this.projectId = projectId;
    this.statistics = projectId && [status.events, status.experiences, status.repairs].every((count) => Number.isSafeInteger(count) && Number(count) >= 0)
      ? { events: status.events as number, experiences: status.experiences as number, repairs: status.repairs as number } : null;
  }
  invoke<T = unknown>(projectRoot: string, request: PensieveRequest, signal?: AbortSignal): Promise<T> {
    if (!this.enabled) return Promise.reject(new Error('Pensieve is disabled. Enable it in Experimental settings.'));
    const generation = this.generation;
    return this.queue(async () => {
      if (!this.enabled || generation !== this.generation || signal?.aborted) throw abortError();
      try {
        if (this.unavailableReason) throw new Error(this.unavailableReason);
        const canonicalProject = realpathSync(projectRoot);
        if (!statSync(canonicalProject).isDirectory()) throw new Error('Pensieve requires an existing project directory.');
        const directory = realpathSync(this.options.directory);
        const relation = relative(canonicalProject, directory);
        if (!relation || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))) {
          throw new Error('Pensieve memory must be stored outside the project workspace.');
        }
        const projectId = createHash('sha256').update(canonicalProject).digest('hex');
        const result = await this.call(this.store(projectId), request, signal);
        if (!this.enabled || generation !== this.generation) throw abortError();
        if (request.op === 'status') this.acceptStatus(result, projectId);
        this.error = null; this.phase = 'ready'; this.changed();
        return result as T;
      } catch (error) {
        if (this.enabled && generation === this.generation && (error as Error)?.name !== 'AbortError') {
          this.error = describe(error); this.phase = 'error'; this.changed();
        }
        throw error;
      }
    });
  }
}
