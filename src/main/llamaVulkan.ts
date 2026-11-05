import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { isAbsolute, join } from 'node:path';
import type { InferenceSource } from './sourceStore';
import { ensurePrivateDirectory, writePrivateFileAtomic } from './privateState';
import type { SourceReadiness } from './sourceReadiness';
import { abortableRead, LocalInferenceQueue } from './localInferenceQueue';

export const SOURCE_ID = 'bundled-llama-vulkan';
export const SOURCE_NAME = 'llama.cpp compatibility (Vulkan)';
export const BUNDLED_BEHOLDD_SOURCE_ID = 'bundled-beholdd';
export const MODEL_ID = 'qwen3-coder-30b';
export const MODEL_NAME = 'Qwen3-Coder 30B A3B Instruct Q8_0';
export const MODEL_ENV = 'ANTIMATTER_LLAMA_VULKAN_MODEL';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 6769;

const MAX_LOG_LINES = 200;
const STARTUP_TIMEOUT_MS = 15_000;
const ENDPOINT_TIMEOUT_MS = 750;
const ENDPOINT_RETRY_MS = 100;
const ENDPOINT_STABILITY_MS = 100;
const STOP_GRACE_MS = 5_000;
const STOP_FORCE_WAIT_MS = 1_000;

export interface LlamaVulkanStatus {
  running: boolean;
  ready: boolean;
  ownership: 'app' | null;
  pid: number | null;
  startedAt: number | null;
  host: typeof DEFAULT_HOST;
  port: typeof DEFAULT_PORT;
  modelPath: string | null;
  lastExit: { code: number | null; signal: NodeJS.Signals | null; at: number } | null;
  logs: string[];
}

export interface LlamaVulkanConnection {
  baseUrl: string;
  apiKey: string;
}

export interface ManagedConnection extends LlamaVulkanConnection {
  modelId: string;
}

/** Refuse a switch rather than terminating a managed source which is serving another turn. */
export function managedSourceConflict(
  targetProviderId: string,
  busy: (providerId: string) => boolean
): string | null {
  if (targetProviderId === SOURCE_ID && busy(BUNDLED_BEHOLDD_SOURCE_ID)) {
    return 'Beholdd (native) is serving a request; wait for it to finish before switching to Vulkan';
  }
  if (targetProviderId !== SOURCE_ID && busy(SOURCE_ID)) {
    return `${SOURCE_NAME} is serving a request; wait for it to finish before switching sources`;
  }
  return null;
}

export interface ManagedModel {
  sourceId: string;
  modelId: string;
  modelPath: string;
  preset: string;
}
let currentModel: ManagedModel | null = null;
export const managedSourceId = (): string | null => currentModel?.sourceId ?? null;

let child: ChildProcess | null = null;
let ownedGroupPid: number | null = null;
let currentApiKey: string | null = null;
let startedAt: number | null = null;
let ready = false;
let lastExit: LlamaVulkanStatus['lastExit'] = null;
let logs: string[] = [];
let shuttingDown = false;
let processGeneration = 0;

/** The shared port is a connection only for the live process and model this app owns. */
export function ownedConnection(sourceId: string, state: {
  model: ManagedModel | null;
  ready: boolean;
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'> | null;
  groupPid: number | null;
  groupAlive: boolean;
  apiKey: string | null;
}): ManagedConnection | null {
  if (state.model?.sourceId !== sourceId || !state.ready || !state.apiKey || !state.child ||
    state.groupPid === null || state.child.pid !== state.groupPid || !state.groupAlive ||
    state.child.exitCode !== null || state.child.signalCode !== null) return null;
  return { baseUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}/v1`, apiKey: state.apiKey, modelId: state.model.modelId };
}

/** Main-process-only inspection access. Reading this never starts or adopts a listener. */
export const connectionFor = (sourceId: string): ManagedConnection | null => ownedConnection(sourceId, {
  model: currentModel, ready, child, groupPid: ownedGroupPid,
  groupAlive: ownedGroupPid !== null && processGroupExists(ownedGroupPid), apiKey: currentApiKey,
});

/** A failed start must not poison later lifecycle requests. */
export class LifecycleQueue extends LocalInferenceQueue {}

const lifecycle = new LifecycleQueue();

const appendLog = (line: string): void => {
  const safe = currentApiKey ? line.split(currentApiKey).join('[redacted]') : line;
  logs = [...logs, safe].slice(-MAX_LOG_LINES);
};

const vendorRoot = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, 'vendor', 'llama-vulkan')
    : join(app.getAppPath(), 'vendor', 'llama-vulkan');

const runtimeRoot = (): string => join(app.getPath('userData'), 'llama-vulkan');
const presetPath = (): string => join(runtimeRoot(), 'models.ini');
const apiKeyPath = (): string => join(runtimeRoot(), 'api-key');

export function configuredModelPath(env: NodeJS.ProcessEnv = process.env, requireExisting = false): string | null {
  const configured = env[MODEL_ENV]?.trim();
  if (!configured) return null;
  if (!isAbsolute(configured)) throw new Error(`${MODEL_ENV} must be an absolute path`);
  if (/[\0\r\n]/.test(configured)) throw new Error(`${MODEL_ENV} contains a character that cannot be written to a preset`);
  if (!existsSync(configured)) {
    if (requireExisting) throw new Error(`Vulkan compatibility model not found: ${configured}`);
    return configured;
  }
  const canonical = realpathSync(configured);
  if (!statSync(canonical).isFile()) throw new Error(`Vulkan compatibility model is not a regular file: ${configured}`);
  return canonical;
}

/**
 * One explicit Vulkan-only router entry. `load-on-startup = false` keeps the 30B checkpoint out of
 * memory until this source receives a request. Naming Vulkan0 selects the accelerator; leaving
 * n-gpu-layers unset lets router fit adapt GPU/CPU placement to available Vulkan memory.
 */
export function renderPreset(modelPath: string): string {
  if (!isAbsolute(modelPath) || /[\0\r\n]/.test(modelPath)) throw new Error('invalid model path for llama.cpp preset');
  return [
    'version = 1',
    '',
    '[*]',
    'stop-timeout = 10',
    '',
    `[${MODEL_ID}]`,
    `model = ${modelPath}`,
    'device = Vulkan0',
    'fit = on',
    'fit-ctx = 8192',
    'ctx-size = 32768',
    'parallel = 1',
    'load-on-startup = false',
    '',
  ].join('\n');
}

/** Exact loopback-only router command. The random credential is read from a 0600 file, not argv. */
export function routerArguments(modelsPreset: string, keyFile: string, port = DEFAULT_PORT): string[] {
  return [
    '--models-preset',
    modelsPreset,
    '--models-max',
    '1',
    '--models-autoload',
    '--host',
    DEFAULT_HOST,
    '--port',
    String(port),
    '--api-key-file',
    keyFile,
    '--cors-origins',
    'localhost',
    '--no-webui',
  ];
}

export function sourceConfig(env: NodeJS.ProcessEnv = process.env): InferenceSource | null {
  const modelPath = configuredModelPath(env);
  // `--skip-model` still exports the deterministic install path, but an unusable managed source
  // must not appear in the picker. Restarting after the checkpoint is installed seeds it normally.
  if (!modelPath || !existsSync(modelPath)) return null;
  return {
    id: SOURCE_ID,
    name: SOURCE_NAME,
    kind: 'llama-cpp',
    protocol: 'openai-chat',
    // Per-process credentials are injected by the request preflight and never persisted.
    apiKey: '',
    baseUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}/v1`,
    // fit-ctx is the guaranteed floor on constrained GPUs. Budget to that honest floor rather
    // than sending a 32K prompt to a worker which had to fit itself down to 8K.
    models: [{ id: MODEL_ID, name: MODEL_NAME, contextWindow: 8_192 }],
    supportsStreaming: true,
    createdAt: Date.now(),
  };
}

export function isExpectedModelList(statusCode: number | undefined, body: string, modelId = MODEL_ID): boolean {
  if (!statusCode || statusCode < 200 || statusCode >= 300) return false;
  try {
    const parsed = JSON.parse(body) as { object?: unknown; data?: Array<{ id?: unknown }> };
    return (
      parsed?.object === 'list' &&
      Array.isArray(parsed.data) &&
      parsed.data.some((model) => model && typeof model === 'object' && model.id === modelId)
    );
  } catch {
    return false;
  }
}

function endpointAnswers(apiKey: string, timeoutMs = ENDPOINT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const probe = request(
      {
        hostname: DEFAULT_HOST,
        port: DEFAULT_PORT,
        path: '/v1/models',
        method: 'GET',
        timeout: timeoutMs,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > 1024 * 1024) {
            response.destroy();
            finish(false);
            return;
          }
          chunks.push(buffer);
        });
        response.once('end', () =>
          finish(isExpectedModelList(response.statusCode, Buffer.concat(chunks).toString('utf8'), currentModel?.modelId ?? MODEL_ID))
        );
        response.once('error', () => finish(false));
      }
    );
    probe.once('timeout', () => probe.destroy());
    probe.once('error', () => finish(false));
    probe.end();
  });
}

export function listenerOccupied(timeoutMs = ENDPOINT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host: DEFAULT_HOST, port: DEFAULT_PORT });
    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Negative pid addresses the detached Unix process group created for the router and its workers. */
export function processGroupTarget(pid: number, platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? pid : -pid;
}

type SignalProcess = (pid: number, signal: NodeJS.Signals | 0) => void;

export function processGroupExists(pid: number, signal: SignalProcess = process.kill): boolean {
  try {
    signal(processGroupTarget(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Both identities are required because a Unix pid can be reused after the retired group exits. */
export function ownsProcessGeneration(
  expectedGeneration: number,
  expectedPid: number,
  currentGeneration: number,
  currentPid: number | null
): boolean {
  return expectedGeneration === currentGeneration && expectedPid === currentPid;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Gracefully stop the whole owned group, then force the group and wait for it to disappear. */
export async function terminateProcessGroup(
  pid: number,
  graceMs = STOP_GRACE_MS,
  forceWaitMs = STOP_FORCE_WAIT_MS,
  signal: SignalProcess = process.kill
): Promise<boolean> {
  const target = processGroupTarget(pid);
  try {
    signal(target, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }

  const waitUntil = async (deadline: number): Promise<boolean> => {
    while (Date.now() < deadline) {
      if (!processGroupExists(pid, signal)) return true;
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    return !processGroupExists(pid, signal);
  };

  if (await waitUntil(Date.now() + graceMs)) return true;
  try {
    signal(target, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
  return waitUntil(Date.now() + forceWaitMs);
}

export function isLiveCandidate(process: ChildProcess, current: ChildProcess | null): boolean {
  return current === process && process.exitCode === null && process.signalCode === null;
}

async function confirmLiveEndpoint(process: ChildProcess, apiKey: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  await abortableRead(delay(ENDPOINT_STABILITY_MS), signal);
  if (shuttingDown || !isLiveCandidate(process, child)) return false;
  if (!(await abortableRead(endpointAnswers(apiKey), signal)) || shuttingDown || !isLiveCandidate(process, child)) return false;
  await abortableRead(delay(ENDPOINT_STABILITY_MS), signal);
  if (shuttingDown || !isLiveCandidate(process, child)) return false;
  return (await abortableRead(endpointAnswers(apiKey), signal)) && !shuttingDown && isLiveCandidate(process, child);
}

async function waitForEndpoint(process: ChildProcess, apiKey: string, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!shuttingDown && isLiveCandidate(process, child) && Date.now() < deadline) {
    // Give a bind loser time to report its exit before an authenticated probe. Then require two
    // answers with liveness checks after every await: a foreign process which wins the port race
    // must never be adopted merely because it can mimic /v1/models.
    signal?.throwIfAborted();
    if (await confirmLiveEndpoint(process, apiKey, signal)) return true;
    await abortableRead(delay(ENDPOINT_RETRY_MS), signal);
  }
  return false;
}

const publicStatus = (): LlamaVulkanStatus => {
  const running = ownedGroupPid !== null && processGroupExists(ownedGroupPid);
  let modelPath: string | null = null;
  try {
    modelPath = currentModel?.modelPath ?? configuredModelPath();
  } catch {
    // Status and quit cleanup must remain available even when the launcher's environment is bad.
  }
  return {
    running,
    ready,
    ownership: running ? 'app' : null,
    pid: ownedGroupPid,
    startedAt,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    modelPath,
    lastExit,
    logs,
  };
};

export const status = (): LlamaVulkanStatus => publicStatus();

/** Read-only evidence for an inactive owned router, with no credentials or port adoption. */
export function managedModelStartupReadiness(modelPath: string | null, binaryPath: string): SourceReadiness {
  try {
    if (!modelPath || !isAbsolute(modelPath) || !statSync(modelPath).isFile()) throw new Error('The managed model file is unavailable.');
    accessSync(modelPath, constants.R_OK);
    if (!isAbsolute(binaryPath) || !statSync(binaryPath).isFile()) throw new Error('The managed llama-server runtime is not installed.');
    accessSync(binaryPath, constants.R_OK | constants.X_OK);
    return { state: 'startable', detail: 'This local workload will start when you send a message.' };
  } catch {
    return { state: 'unreachable', detail: 'The managed model or llama-server runtime is missing or unreadable. Check its installation in Models.' };
  }
}

export function startupReadiness(selection?: ManagedModel): SourceReadiness {
  if (shuttingDown) return { state: 'unreachable', detail: 'Antimatter is shutting down.' };
  try {
    return managedModelStartupReadiness(selection?.modelPath ?? configuredModelPath(process.env, true),
      join(vendorRoot(), 'runtime', 'llama-server'));
  } catch (error) { return { state: 'unreachable', detail: error instanceof Error ? error.message : String(error) }; }
}

async function startUnlocked(selection?: ManagedModel, signal?: AbortSignal): Promise<LlamaVulkanConnection> {
  signal?.throwIfAborted();
  const modelPath = selection?.modelPath ?? configuredModelPath(process.env, true);
  if (!modelPath || !isAbsolute(modelPath) || !existsSync(modelPath) || !statSync(modelPath).isFile()) throw new Error('The managed model file is unavailable.');
  const requested: ManagedModel = selection ?? { sourceId: SOURCE_ID, modelId: MODEL_ID, modelPath, preset: renderPreset(modelPath) };
  if (currentModel && (currentModel.sourceId !== requested.sourceId || currentModel.preset !== requested.preset)) await stopUnlocked();
  signal?.throwIfAborted();
  currentModel = requested;
  if (shuttingDown) throw new Error(`${SOURCE_NAME} is shutting down`);
  const runningChild = child;
  if (runningChild && currentApiKey && (await confirmLiveEndpoint(runningChild, currentApiKey, signal))) {
    signal?.throwIfAborted();
    ready = true;
    return { baseUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}/v1`, apiKey: currentApiKey };
  }

  if (ownedGroupPid !== null && processGroupExists(ownedGroupPid)) {
    const stopped = await terminateProcessGroup(ownedGroupPid);
    if (!stopped) throw new Error(`${SOURCE_NAME} left an owned process group running`);
  }
  child = null;
  ownedGroupPid = null;
  currentApiKey = null;
  ready = false;

  // Never attach credentials to, route through, or terminate a listener Antimatter did not spawn.
  if (await listenerOccupied()) {
    throw new Error(`${SOURCE_NAME} port ${DEFAULT_PORT} is already in use; refusing to adopt that listener`);
  }
  signal?.throwIfAborted();

  const root = vendorRoot();
  const binary = join(root, 'runtime', 'llama-server');
  if (!existsSync(binary)) throw new Error(`${SOURCE_NAME} is not installed (expected ${binary})`);
  const stateRoot = runtimeRoot();
  const cacheRoot = join(stateRoot, 'cache');
  const configRoot = join(stateRoot, 'config');
  ensurePrivateDirectory(stateRoot);
  ensurePrivateDirectory(cacheRoot);
  ensurePrivateDirectory(configRoot);
  writePrivateFileAtomic(presetPath(), requested.preset);

  const apiKey = randomBytes(32).toString('hex');
  writePrivateFileAtomic(apiKeyPath(), `${apiKey}\n`);
  logs = [];
  lastExit = null;
  startedAt = Date.now();
  appendLog(
    `$ llama-server --models-preset ${presetPath()} --models-max 1 --host ${DEFAULT_HOST} --port ${DEFAULT_PORT} --api-key-file ${apiKeyPath()}`
  );
  const next = spawn(
    binary,
    routerArguments(presetPath(), apiKeyPath()),
    {
      cwd: join(root, 'runtime'),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LLAMA_CACHE: cacheRoot,
        XDG_CONFIG_HOME: configRoot,
      },
    }
  );
  // `spawn()` reports loader/permission failures on the next tick and may return no pid. Consume
  // the event before inspecting pid so an invalid packaged binary can never become an unhandled
  // ChildProcess error that crashes the Electron main process.
  next.once('error', (error) => appendLog(`spawn failed: ${error.message}`));
  const groupPid = next.pid;
  if (!groupPid) {
    next.kill('SIGKILL');
    startedAt = null;
    rmSync(apiKeyPath(), { force: true });
    throw new Error(`${SOURCE_NAME} did not return a process id`);
  }
  child = next;
  const generation = ++processGeneration;
  ownedGroupPid = groupPid;
  currentApiKey = apiKey;

  for (const stream of [next.stdout, next.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) appendLog(line.trimEnd());
      }
    });
  }
  next.once('exit', (code, signal) => {
    const group = next.pid ?? null;
    lastExit = { code, signal: signal as NodeJS.Signals | null, at: Date.now() };
    appendLog(`llama-server exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`);
    if (child === next) {
      child = null;
      ready = false;
      startedAt = null;
    }
    // A router can die before one of its model workers. Retire the process group immediately;
    // retaining a dead leader's pid until a later restart risks that number being reused. Keep
    // this cleanup on the lifecycle queue: an older exit must never erase a newer start's key.
    if (group !== null && ownedGroupPid === group) {
      void lifecycle.run(async () => {
        if (!ownsProcessGeneration(generation, group, processGeneration, ownedGroupPid)) return;
        let stopped = false;
        try {
          stopped = await terminateProcessGroup(group, 250, 250);
        } catch (error) {
          appendLog(`worker cleanup failed: ${(error as Error).message}`);
        }
        if (!ownsProcessGeneration(generation, group, processGeneration, ownedGroupPid)) return;
        if (!stopped) {
          appendLog(`worker cleanup left process group ${group} running`);
          return;
        }
        ownedGroupPid = null;
        currentApiKey = null;
        rmSync(apiKeyPath(), { force: true });
      });
    }
  });

  try {
    if (!(await waitForEndpoint(next, apiKey, signal))) {
      const detail = logs.slice(-8).join('\n');
      throw new Error(
        `${SOURCE_NAME} did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s${detail ? `:\n${detail}` : ''}`
      );
    }
    signal?.throwIfAborted();
  } catch (error) {
    // This start created the group. Retire it before releasing the request's provider lease.
    if ((await stopUnlocked()).running) {
      throw new Error(`${SOURCE_NAME} startup could not be retired; another engine was not started.`);
    }
    throw error;
  }

  ready = true;
  appendLog(`${SOURCE_NAME} router is ready; ${requested.modelId} remains unloaded until its first request`);
  return { baseUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}/v1`, apiKey };
}

async function stopUnlocked(): Promise<LlamaVulkanStatus> {
  const pid = ownedGroupPid;
  if (pid === null) {
    currentApiKey = null;
    rmSync(apiKeyPath(), { force: true });
    return publicStatus();
  }
  const stopped = await terminateProcessGroup(pid);
  if (!stopped) appendLog(`${SOURCE_NAME} process group ${pid} survived SIGKILL`);
  if (ownedGroupPid === pid) {
    ownedGroupPid = stopped ? null : pid;
    child = null;
    currentApiKey = null;
    rmSync(apiKeyPath(), { force: true });
    ready = false;
    startedAt = null;
  }
  return publicStatus();
}

export const start = (selection?: ManagedModel, signal?: AbortSignal): Promise<LlamaVulkanConnection> =>
  lifecycle.run(() => startUnlocked(selection, signal), signal);
export const stop = (): Promise<LlamaVulkanStatus> => lifecycle.run(stopUnlocked);

/** Full app exit only. Closing the window to the tray never calls this. */
export const stopOnQuit = (): Promise<LlamaVulkanStatus> => {
  shuttingDown = true;
  return lifecycle.run(stopUnlocked);
};

export function manifest(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(vendorRoot(), 'manifest.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
