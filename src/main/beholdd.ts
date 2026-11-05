import { launchHag, HagProcessCleanupError, type HagProcess } from './hagProcess';
import { nativeHagPlan, nativeHagIdentity, nativeConfigText } from './nativeHagQualification';
import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { abortableRead, LocalInferenceQueue } from './localInferenceQueue';

/** beholdd v2's default listener. Legacy external servers commonly use 6767. */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 6768;

const MAX_LOG_LINES = 200;
const STOP_GRACE_MS = 5000;
const STOP_FORCE_WAIT_MS = 1000;
const STARTUP_TIMEOUT_MS = 15_000;
const ENDPOINT_TIMEOUT_MS = 500;
const ENDPOINT_RETRY_MS = 100;

export interface BeholddInfo {
  binaryPath: string;
  installed: boolean;
  manifest: Record<string, unknown> | null;
  defaultConfigPath: string;
  exampleConfigPath: string;
  defaultHost: string;
  defaultPort: number;
}

export interface BeholddStatus {
  running: boolean;
  /** The configured HTTP endpoint answered with an OpenAI model list on the latest probe. */
  ready: boolean;
  /** Only app-owned processes may be stopped or restarted from Antimatter. */
  ownership: 'app' | 'external' | null;
  pid: number | null;
  startedAt: number | null;
  host: string | null;
  port: number | null;
  configPath: string | null;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  logs: string[];
  executionScope?: string;
}

// Vendored by `npm run deps:sync`; packaged builds carry the same tree in resources.
const vendorRoot = () =>
  app.isPackaged ? join(process.resourcesPath, 'vendor', 'beholdd') : join(app.getAppPath(), 'vendor', 'beholdd');

let child: ChildProcess | null = null;
let nativeOwner: HagProcess | null = null;
let nativeGeneration = 0;
let nativeFault: string | null = null;
let nativeStarting: AbortController | null = null;
let nativeModelScope: string | null = null;
let startedAt: number | null = null;
let runningWith: { host: string; port: number; configPath: string } | null = null;
let ownedReady = false;
// A healthy listener that was already present is usable, but is not ours to terminate.
let externalEndpoint: { host: string; port: number } | null = null;
let lastExit: BeholddStatus['lastExit'] = null;
let logs: string[] = [];
let shuttingDown = false;

/** A rejection must not poison the queue for later lifecycle requests. */
export class LifecycleQueue extends LocalInferenceQueue {}

const lifecycle = new LifecycleQueue();

type StoppableProcess = Pick<EventEmitter, 'once' | 'removeListener'> &
  Pick<ChildProcess, 'exitCode' | 'kill'>;

/**
 * Ask a child to stop, escalate once, and report whether its exit was actually observed.
 * Resolving at the moment SIGKILL is sent is too early: restart could still see the old child as
 * live and decline to spawn its replacement.
 */
export function terminateChildProcess(
  process: StoppableProcess,
  graceMs = STOP_GRACE_MS,
  forceWaitMs = STOP_FORCE_WAIT_MS
): Promise<boolean> {
  if (process.exitCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      if (forceTimer) clearTimeout(forceTimer);
      process.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const graceTimer = setTimeout(() => {
      if (process.exitCode !== null) {
        finish(true);
        return;
      }
      process.kill('SIGKILL');
      forceTimer = setTimeout(() => finish(process.exitCode !== null), forceWaitMs);
    }, graceMs);

    process.once('exit', onExit);
    process.kill('SIGTERM');
  });
}

const appendLog = (line: string) => {
  logs = [...logs, line].slice(-MAX_LOG_LINES);
};

/**
 * The config used when a caller does not name one — which is the case for the Connect
 * button on a source row. beholdd v2 rejects a v1 config outright (`unknown field
 * runtime_root`), so a v2-named file sitting beside the legacy one wins.
 */
export function resolveDefaultConfig(): string {
  const home = process.env.BEHOLDD_HOME || join(homedir(), '.beholdd');
  const legacy = join(home, 'config.yaml');
  const candidates = [join(home, 'config.v2.yaml'), legacy];
  return candidates.find((candidate) => existsSync(candidate)) ?? legacy;
}

let prepareConfig: (() => string | null) | null = null;

/**
 * Lets the Model Hub put downloaded models in front of the server whenever it starts without an
 * explicit config — at launch, and from Connect or Reconnect in Settings alike. The callback returns
 * a generated configuration's path, or null to start from the default one untouched.
 */
export const usePreparedConfig = (prepare: () => string | null): void => {
  prepareConfig = prepare;
};

export const info = (): BeholddInfo => {
  const root = vendorRoot();
  const binaryPath = join(root, 'bin', 'beholdd');
  const manifestPath = join(root, 'manifest.json');

  let manifest: Record<string, unknown> | null = null;
  try {
    if (existsSync(manifestPath)) manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error('[beholdd] unreadable manifest:', error);
  }

  return {
    binaryPath,
    installed: existsSync(binaryPath),
    manifest,
    defaultConfigPath: resolveDefaultConfig(),
    exampleConfigPath: join(root, 'share', 'config.example.yaml'),
    defaultHost: DEFAULT_HOST,
    defaultPort: DEFAULT_PORT,
  };
};

export const status = (): BeholddStatus => ({
  running: nativeOwner !== null || (!!child && child.exitCode === null) || externalEndpoint !== null,
  ready: externalEndpoint !== null || ownedReady,
  ownership: nativeOwner || (child && child.exitCode === null) ? 'app' : externalEndpoint ? 'external' : null,
  pid: nativeOwner?.pid ?? child?.pid ?? null,
  startedAt,
  host: runningWith?.host ?? null,
  port: runningWith?.port ?? null,
  configPath: runningWith?.configPath ?? null,
  lastExit,
  logs,
  ...(nativeModelScope ? { executionScope: 'This service is qualified only for OpenMythos HAG. Other listed models require a CPU-only configuration or another source.' } : {}),
});

const connectHost = (host: string) => {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  return host.replace(/^\[|\]$/g, '');
};

/** A 2xx response is only ours when its body has the OpenAI model-list envelope. */
export function isModelListResponse(statusCode: number | undefined, body: string): boolean {
  if (!statusCode || statusCode < 200 || statusCode >= 300) return false;
  try {
    const parsed = JSON.parse(body) as { object?: unknown; data?: unknown };
    return !!parsed && typeof parsed === 'object' && parsed.object === 'list' && Array.isArray(parsed.data);
  } catch {
    return false;
  }
}

/** Resolve once an OpenAI-compatible model-list endpoint is accepting requests. */
export function endpointAnswers(host: string, port: number, timeoutMs = ENDPOINT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    const probe = request(
      {
        hostname: connectHost(host),
        port,
        path: '/v1/models',
        method: 'GET',
        timeout: timeoutMs,
      },
      (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          finish(false);
          return;
        }
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
          finish(isModelListResponse(response.statusCode, Buffer.concat(chunks).toString('utf8')))
        );
        response.once('error', () => finish(false));
      }
    );
    probe.once('timeout', () => probe.destroy());
    probe.once('error', () => finish(false));
    probe.end();
  });
}

/** Refresh endpoint health before exposing status to a polling renderer. */
export async function inspectStatus(): Promise<BeholddStatus> {
  // Discover an external listener without adopting it. Transitions must not assume it is empty.
  if (!nativeOwner && !nativeStarting && !child && !externalEndpoint) {
    const host = runningWith?.host ?? DEFAULT_HOST; const port = runningWith?.port ?? DEFAULT_PORT;
    if (await endpointAnswers(host, port)) {
      externalEndpoint = { host, port };
      runningWith = { host, port, configPath: runningWith?.configPath ?? resolveDefaultConfig() };
    }
  }
  if (nativeOwner) return status();
  const external = externalEndpoint;
  if (external) {
    const ready = await endpointAnswers(external.host, external.port);
    if (externalEndpoint === external && !ready) {
      externalEndpoint = null;
      if (!child) runningWith = null;
    }
  }

  const owned = child;
  const target = runningWith;
  if (owned && owned.exitCode === null && target) {
    const ready = await endpointAnswers(target.host, target.port);
    if (child === owned) ownedReady = ready;
  } else if (!owned) {
    ownedReady = false;
  }

  return status();
}

async function waitForEndpoint(
  host: string,
  port: number,
  process: ChildProcess,
  timeoutMs = STARTUP_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (child === process && process.exitCode === null && Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await abortableRead(endpointAnswers(host, port), signal)) return true;
    await abortableRead(new Promise<void>((resolve) => setTimeout(resolve, ENDPOINT_RETRY_MS)), signal);
  }
  return false;
}

async function startUnlocked(options: { configPath?: string; host?: string; port?: number }, signal?: AbortSignal): Promise<BeholddStatus> {
  signal?.throwIfAborted();
  if (shuttingDown) throw new Error('Antimatter is shutting down');
  if (nativeFault) throw new Error(`${nativeFault} Restart the native engine explicitly after resolving the cause.`);
  if (nativeOwner) return status();

  if (child && child.exitCode === null) {
    const current = runningWith;
    if (current && (await waitForEndpoint(current.host, current.port, child, STARTUP_TIMEOUT_MS, signal))) {
      signal?.throwIfAborted();
      ownedReady = true;
      return status();
    }
    ownedReady = false;
    appendLog(`beholdd is still running but did not answer HTTP within ${STARTUP_TIMEOUT_MS / 1000}s`);
    return status();
  }

  const host = options.host || DEFAULT_HOST;
  const port = options.port || DEFAULT_PORT;
  let prepareError: string | null = null;
  let prepared: string | null = null;
  if (!options.configPath) {
    try {
      prepared = prepareConfig?.() ?? null;
    } catch (error) {
      // Downloads that cannot be added must not stop the server the person already had working.
      prepareError = (error as Error).message;
    }
  }
  const configPath = options.configPath || prepared || resolveDefaultConfig();

  const installation = info();
  const configText = existsSync(configPath) ? nativeConfigText(configPath) : null;
  const native = configText === null ? null : nativeHagPlan(configText, installation.manifest);
  nativeModelScope = native?.modelId ?? null;
  if (native && (host !== DEFAULT_HOST || port !== DEFAULT_PORT)) throw new Error('The qualified native HAG service uses only 127.0.0.1:6768.');

  // A previous Antimatter crash or a separately managed service may already own this listener.
  // Probe before requiring our binary or config: an existing endpoint is usable even on a fresh
  // install, but it remains explicitly external and is never killed from Stop/Quit.
  const existingReady = await abortableRead(endpointAnswers(host, port), signal);
  signal?.throwIfAborted();
  // Quit can arrive during this probe. The contained native branch also checks its abort signal
  // after identity verification and throughout the bounded startup wait.
  if (shuttingDown) throw new Error('Antimatter is shutting down');
  if (existingReady) {
    if (native) {
      externalEndpoint = { host, port }; runningWith = { host, port, configPath };
      throw new Error('A native HAG listener already exists outside this app. Stop it before starting the qualified managed service.');
    }
    logs = [];
    lastExit = null;
    startedAt = null;
    ownedReady = false;
    runningWith = { host, port, configPath };
    externalEndpoint = { host, port };
    appendLog(`Using the existing beholdd listener at http://${connectHost(host)}:${port}`);
    return status();
  }

  externalEndpoint = null;
  const { binaryPath, installed } = installation;
  if (!installed) {
    throw new Error(`beholdd is not vendored yet — run "npm run deps:sync" (expected ${binaryPath})`);
  }
  if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);

  logs = [];
  lastExit = null;
  startedAt = Date.now();
  runningWith = { host, port, configPath };
  ownedReady = false;
  if (prepareError) appendLog(`Model Hub downloads were left out of this start: ${prepareError}`);
  appendLog(`$ beholdd serve --config ${configPath} --host ${host} --port ${port}`);

  if (native && configText !== null) {
    const generation = ++nativeGeneration;
    const operation = new AbortController(); nativeStarting = operation;
    const abort = () => operation.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const identity = await abortableRead(nativeHagIdentity(binaryPath, configPath, configText, native), operation.signal);
      operation.signal.throwIfAborted();
      if (shuttingDown) throw new Error('Antimatter is shutting down');
      nativeOwner = await launchHag({ binary: binaryPath, config: configPath, port, modelId: native.modelId,
        containment: native.containment, privateMemory: native.privateMemory, expectedModels: native.expectedModels, ...identity, signal: operation.signal,
        onExit: (reason, retired = false) => {
          if (generation !== nativeGeneration) return;
          nativeFault = reason; ownedReady = false; appendLog(reason);
          lastExit = { code: null, signal: null, at: Date.now() };
          if (retired) { nativeOwner = null; startedAt = null; runningWith = null; }
        },
      });
      if (operation.signal.aborted) {
        await nativeOwner.stop();
        nativeOwner = null;
        operation.signal.throwIfAborted();
      }
      ownedReady = true;
      appendLog(`Qualified native Beholdd is ready at http://${host}:${port}; all models are cold. Only OpenMythos HAG is qualified for execution in this service.`);
    } catch (error) {
      if (error instanceof HagProcessCleanupError) nativeOwner = error.process;
      const detail = error instanceof Error ? error.message : String(error);
      // A cleanly cancelled start is retryable; failed containment cleanup remains a hard fault.
      nativeFault = operation.signal.aborted && !nativeOwner ? null : detail;
      appendLog(detail);
      ownedReady = false;
      if (!nativeOwner) { startedAt = null; runningWith = null; }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (nativeStarting === operation) nativeStarting = null;
    }
    return status();
  }

  const next = spawn(binaryPath, ['serve', '--config', configPath, '--host', host, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HAG_TRACE_SUBMISSION: '0' },
  });
  child = next;

  for (const stream of [next.stdout, next.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) appendLog(line.trimEnd());
      }
    });
  }

  next.on('error', (error) => {
    appendLog(`spawn failed: ${error.message}`);
    lastExit = { code: null, signal: null, at: Date.now() };
    if (child === next) {
      child = null;
      ownedReady = false;
      startedAt = null;
      runningWith = null;
    }
  });
  next.on('exit', (code, signal) => {
    lastExit = { code, signal, at: Date.now() };
    appendLog(`beholdd exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`);
    if (child === next) {
      child = null;
      ownedReady = false;
      startedAt = null;
      runningWith = null;
    }
  });

  // Do not merely wait for the process to survive its first few milliseconds. A renderer can
  // send immediately after opening, so Start resolves only after the HTTP listener is actually
  // accepting requests (or after a bounded timeout that leaves the logs available for diagnosis).
  try {
    if (await waitForEndpoint(host, port, next, STARTUP_TIMEOUT_MS, signal)) {
      signal?.throwIfAborted();
      if (child === next) ownedReady = true;
      appendLog(`beholdd is ready at http://${connectHost(host)}:${port}`);
    } else if (child === next && next.exitCode === null) {
      appendLog(`beholdd is running but did not answer HTTP within ${STARTUP_TIMEOUT_MS / 1000}s`);
    }
  } catch (error) {
    if (signal?.aborted && child === next && !await terminateChildProcess(next)) {
      throw new Error('Cancelled beholdd startup could not be retired; another engine was not started.');
    }
    throw error;
  }

  return status();
}

async function stopUnlocked(): Promise<BeholddStatus> {
  const native = nativeOwner;
  if (native) {
    // This verifies the complete service and cgroup, not merely the systemd-run launcher.
    await native.stop();
    if (nativeOwner === native) nativeOwner = null;
    nativeGeneration += 1; ownedReady = false; startedAt = null; runningWith = null;
    return status();
  }
  const current = child;
  if (!current || current.exitCode !== null) {
    if (externalEndpoint) appendLog('The listener is managed outside Antimatter and was left running.');
    return status();
  }

  const exited = await terminateChildProcess(current);
  if (!exited && child === current && current.exitCode === null) {
    appendLog(`beholdd did not exit within ${STOP_FORCE_WAIT_MS / 1000}s after SIGKILL`);
  }

  return status();
}

/**
 * Stop then start, so a wedged server is one button rather than two. Sequencing lives here
 * because the renderer cannot guarantee the stop finished before the start begins.
 */
async function restartUnlocked(options: { configPath?: string; host?: string; port?: number }, signal?: AbortSignal): Promise<BeholddStatus> {
  signal?.throwIfAborted();
  if (externalEndpoint) {
    appendLog('The listener is managed outside Antimatter and cannot be restarted here.');
    return status();
  }
  await stopUnlocked();
  if (nativeOwner || (child && child.exitCode === null)) {
    throw new Error('beholdd could not be stopped; refusing to start a second server on the same listener');
  }
  nativeFault = null;
  return startUnlocked(options, signal);
}

/** Lifecycle mutations share one queue across every mounted Settings control and startup. */
export const start = (options: { configPath?: string; host?: string; port?: number }, signal?: AbortSignal): Promise<BeholddStatus> =>
  lifecycle.run(() => startUnlocked(options, signal), signal);

export const stop = (): Promise<BeholddStatus> => {
  nativeStarting?.abort();
  return lifecycle.run(stopUnlocked);
};

export const restart = (options: {
  configPath?: string;
  host?: string;
  port?: number;
}, signal?: AbortSignal): Promise<BeholddStatus> => lifecycle.run(() => restartUnlocked(options, signal), signal);

/** First-request-only admission; selection, status polling and cold registry startup do not call it. */
export const prepareModel = (modelId: string | undefined, signal?: AbortSignal): Promise<void> => lifecycle.run(async () => {
  signal?.throwIfAborted();
  if (nativeFault) throw new Error(`${nativeFault} Restart the native engine explicitly after resolving the cause.`);
  if (!nativeOwner) return;
  if (!modelId || !nativeOwner.prepareRequest) throw new Error('Native HAG request admission requires the selected model identity.');
  await nativeOwner.prepareRequest(modelId, signal);
}, signal);

/** Read-only presentation of the current qualified service scope; no startup or model I/O. */
export const qualifiedModelScope = (): string | null => nativeModelScope;

/** Best-effort stop for a full app shutdown. Hiding the window never calls this. */
export const stopOnQuit = (): Promise<BeholddStatus> => {
  shuttingDown = true;
  nativeStarting?.abort();
  return lifecycle.run(stopUnlocked);
};
