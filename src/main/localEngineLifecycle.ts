import { createConnection } from 'node:net';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { SourceReadiness } from './sourceReadiness';
import { abortableRead, LocalInferenceQueue } from './localInferenceQueue';

/**
 * Lifecycle for the local llama.cpp model servers that run as user systemd units.
 *
 * These are the engines reached through ordinary configured sources (`http://127.0.0.1:8086/v1`
 * and friends), as opposed to the bundled router in llamaVulkan.ts which this app spawns itself.
 * They used to be `enabled` into `default.target`, so every one of them loaded its checkpoint at
 * login whether or not Antimatter was ever opened — and because the carveout cannot hold all of
 * them at once, login raced them and the OOM killer picked the winners.
 *
 * So ownership moves here. The rules, in order of importance:
 *
 *   1. Nothing loads until a chat actually needs it. `ensureRunning` is called from the request
 *      preflight, not from app startup.
 *   2. Only a unit this module started is ever stopped. A server that was already up when we
 *      first looked is `external`: someone started it by hand, or re-enabled it, and it is not
 *      ours to take away. This mirrors how llamaVulkan refuses to adopt a listener it did not
 *      spawn, and the reason is the same — the thing on the other end of that port may be
 *      serving somebody else.
 *   3. A crash is retried a bounded number of times and then left alone. The unit drop-ins set
 *      `Restart=no` deliberately ("a failed model must not repeatedly exhaust memory during
 *      unattended restarts"); supervising from in here must not quietly undo that. Three tries
 *      with widening gaps is enough to ride out a transient failure and far too few to thrash.
 *   4. While the window is hidden, an engine is released as soon as it falls idle. Backgrounding
 *      the app is the user saying they are done with it, and the carveout is the scarce resource
 *      on this box. Work already in flight — a background agent turn, say — still finishes.
 *   5. A start never displaces an engine that is mid-answer. These units declare `Conflicts=` on
 *      one another, and systemd honours it by stopping the sibling when a new one starts. When
 *      that sibling is serving a turn, the start is refused with a reason rather than cutting the
 *      response off — the same call the app-managed Vulkan preflight makes for its own engines.
 */

/** Widening gaps, then stop. The last entry is not a delay; exhausting the list means giving up. */
const RESTART_DELAYS_MS = [2_000, 8_000, 30_000];
/** A server that has stayed healthy this long has recovered; its failure count starts over. */
const HEALTHY_RESET_MS = 5 * 60_000;
const SUPERVISE_INTERVAL_MS = 5_000;
/** Cold start reads tens of gigabytes off NVMe into VRAM. The units allow 600s; so do we. */
const STARTUP_TIMEOUT_MS = 600_000;
const READY_POLL_MS = 500;
const MAX_LOG_LINES = 50;
const MAX_UNITS = 512;

const UNIT = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*\.service$/;
/**
 * `foo@.service` is a template, not a unit: it has no instance name, and `systemctl show` rejects
 * it outright — which would fail the whole batched call and take discovery down with it. A real
 * user session has several (`gnome-session-manager@`, `systemd-ask-password@`), so they are
 * dropped before any name is handed to systemd.
 */
const TEMPLATE = /@\.service$/;
export const isAddressableUnit = (name: string): boolean => UNIT.test(name) && !TEMPLATE.test(name);
const PROPERTIES = 'Id,LoadState,ActiveState,MainPID,ExecStart';
const exec = promisify(execFile);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export type EngineOwnership = 'app' | 'external';

export interface LocalEngineState {
  sourceId: string;
  unit: string;
  endpoint: string;
  model: string | null;
  ownership: EngineOwnership;
  running: boolean;
  /** The endpoint answered for this model the last time we looked. */
  ready: boolean;
  startedAt: number | null;
  /** Consecutive unexpected exits since the last sustained healthy period. */
  failures: number;
  /** True once the retry budget is spent. Cleared by the next explicit request. */
  gaveUp: boolean;
  lastError: string | null;
  logs: string[];
}

export interface LocalEngineLifecycleOptions {
  /** True while a completion or stream is open against this source. */
  busy(sourceId: string): boolean;
  /** True while an engine profile switch is restarting a unit; supervision stands down. */
  applying?(): boolean;
  /** Test seam: arguments to `systemctl --user`, never shell source. */
  command?(args: string[]): Promise<string>;
  probe?(endpoint: string, path: '/health' | '/v1/models'): Promise<unknown>;
  portFree?(endpoint: string): Promise<boolean>;
  /** Read-only startup validation, injected for tests. */
  fileAvailable?(path: string, executable: boolean): boolean;
  now?(): number;
  sleep?(milliseconds: number): Promise<void>;
  startupTimeoutMs?: number;
  log?(line: string): void;
}

interface UnitFacts { id: string; state: string; pid: number; argv: string[] }
export interface LocalEngineSource { sourceId: string; baseUrl: string; model?: string | null }

const fileAvailable = (path: string, executable: boolean): boolean => {
  try {
    if (!isAbsolute(path) || !statSync(path).isFile()) return false;
    accessSync(path, constants.R_OK | (executable ? constants.X_OK : 0));
    return true;
  } catch { return false; }
};

/** systemd's display joins paths with spaces; collect a file value through the next option. */
const fileArgument = (argv: string[], flags: string[]): string | null => {
  let result: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const flag = flags.find((name) => argv[i] === name || argv[i].startsWith(`${name}=`));
    if (!flag) continue;
    const values = argv[i] === flag ? [] : [argv[i].slice(flag.length + 1)];
    while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) values.push(argv[++i]);
    result = values.join(' ');
  }
  return result;
};

interface Record_ {
  sourceId: string;
  unit: string;
  endpoint: string;
  model: string | null;
  ownership: EngineOwnership;
  running: boolean;
  startedAt: number | null;
  failures: number;
  gaveUp: boolean;
  lastError: string | null;
  logs: string[];
  /** Set when the window is hidden and the source was still busy; released once it falls idle. */
  releaseWhenIdle: boolean;
  /** When the server was last observed healthy, for the failure-count reset. */
  healthySince: number | null;
}

/**
 * Loopback HTTP only, and only the paths a llama-server root is served under. Anything else is
 * either a remote provider — not ours to manage — or an endpoint we cannot reason about.
 */
export function engineEndpoint(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash ||
      !['/', '/v1', '/v1/'].includes(url.pathname)) return null;
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}

/**
 * systemd renders ExecStart as `{ path=X ; argv[]=A B C ; ignore_errors=no ; ... }`. The argv is
 * space-joined with no quoting, so it cannot be trusted as an exact command — an argument with a
 * space in it is indistinguishable from two arguments. It is read here only to answer "which unit
 * is configured to listen on this port", where the value is a bare number and the ambiguity
 * cannot bite. The authoritative argv for a *running* server still comes from /proc, in
 * localRuntimeService.
 */
export function execStartArgv(property: string): string[] {
  const argv: string[] = [];
  for (const match of property.matchAll(/argv\[\]=(.*?)\s;\s/g)) {
    argv.push(...match[1].trim().split(/\s+/).filter(Boolean));
  }
  return argv;
}

/** Both `--port 8086` and `--port=8086`, matching the flag spellings llama-server accepts. */
export function portInArgv(argv: string[]): string | null {
  let port: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--port') { port = argv[i + 1] ?? null; i += 1; }
    else if (argv[i].startsWith('--port=')) port = argv[i].slice('--port='.length);
  }
  return port && /^\d+$/.test(port) ? port : null;
}

export function parseUnitFacts(output: string): UnitFacts[] {
  return output.trim().split(/\n\s*\n/).flatMap((block) => {
    const properties: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) properties[line.slice(0, at)] = line.slice(at + 1);
    }
    if (!UNIT.test(properties.Id ?? '') || properties.LoadState !== 'loaded') return [];
    return [{ id: properties.Id, state: properties.ActiveState ?? '', pid: Number(properties.MainPID ?? 0),
      argv: execStartArgv(properties.ExecStart ?? '') }];
  });
}

async function loopbackPortFree(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80) });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(new Error('The local engine port could not be checked safely.'));
    });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('The local engine port check timed out.')); });
  });
}

async function loopbackProbe(endpoint: string, path: string): Promise<unknown> {
  const response = await fetch(`${endpoint}${path}`, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`The local server's ${path} endpoint returned HTTP ${response.status}.`);
  const text = (await response.text()).slice(0, 1_048_576);
  return JSON.parse(text);
}

export class LocalEngineLifecycle {
  private readonly records = new Map<string, Record_>();
  private readonly command: NonNullable<LocalEngineLifecycleOptions['command']>;
  private readonly probe: NonNullable<LocalEngineLifecycleOptions['probe']>;
  private readonly portFree: NonNullable<LocalEngineLifecycleOptions['portFree']>;
  private readonly fileAvailable: NonNullable<LocalEngineLifecycleOptions['fileAvailable']>;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  /** One lifecycle action at a time, so a stop can never overtake the start it belongs to. */
  private readonly operations = new LocalInferenceQueue();
  private timer: NodeJS.Timeout | null = null;
  private visible = true;
  private stopped = false;

  constructor(private readonly options: LocalEngineLifecycleOptions) {
    this.command = options.command ??
      (async (args) => (await exec('systemctl', ['--user', ...args], { timeout: 30_000, maxBuffer: 1_048_576 })).stdout);
    this.probe = options.probe ?? loopbackProbe;
    this.portFree = options.portFree ?? loopbackPortFree;
    this.fileAvailable = options.fileAvailable ?? fileAvailable;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private note(record: Record_, line: string): void {
    record.logs = [...record.logs, `${new Date(this.now()).toISOString()} ${line}`].slice(-MAX_LOG_LINES);
    this.options.log?.(`[local-engine] ${record.unit}: ${line}`);
  }

  private queue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.operations.run(operation, signal);
  }

  private busy(record: Record_): boolean {
    return [...this.records].some(([sourceId, candidate]) => candidate === record && this.options.busy(sourceId));
  }

  private forget(record: Record_): void {
    for (const [sourceId, candidate] of this.records) if (candidate === record) this.records.delete(sourceId);
  }

  private async unit(name: string): Promise<UnitFacts | null> {
    if (!UNIT.test(name)) return null;
    return parseUnitFacts(await this.command(['show', name, `--property=${PROPERTIES}`]))
      .find((facts) => facts.id === name) ?? null;
  }

  /**
   * The units configured to stop when this one starts, from its `Conflicts=` property.
   *
   * The loopback engines are siblings that cannot share the carveout and say so with systemd
   * `Conflicts=`. The relation is bidirectional in systemd's transaction engine — either side may
   * declare it — so callers read both this unit's set and the other unit's. An unreadable property
   * is treated as "no known conflict": the preflight should not refuse a legitimate start just
   * because `systemctl show` hiccuped.
   */
  private async conflictsOf(name: string): Promise<Set<string>> {
    const conflicts = new Set<string>();
    if (!isAddressableUnit(name)) return conflicts;
    let output: string;
    try { output = await this.command(['show', name, '--property=Conflicts']); } catch { return conflicts; }
    for (const line of output.split('\n')) {
      const at = line.indexOf('=');
      if (at < 0 || line.slice(0, at) !== 'Conflicts') continue;
      for (const token of line.slice(at + 1).trim().split(/\s+/)) if (isAddressableUnit(token)) conflicts.add(token);
    }
    return conflicts;
  }

  /**
   * A busy engine this start would take down, if any.
   *
   * Starting a unit stops every sibling systemd has been told it conflicts with, and one of those
   * siblings may be mid-answer for a turn nobody asked to end. Refusing here is the same call the
   * app-managed Vulkan preflight makes; without it the request dies as a broken stream, far from
   * the cause. A sibling that does not conflict — a perception model beside the coder — is left
   * alone, because starting it displaces nothing.
   */
  private async conflictingBusy(unit: string): Promise<string | null> {
    const busy = [...new Set(this.records.values())].filter((other) =>
      other.unit !== unit && isAddressableUnit(other.unit) && this.busy(other));
    if (!busy.length) return null;
    const forward = await this.conflictsOf(unit);
    for (const other of busy) {
      if (forward.has(other.unit)) return other.unit;
      if ((await this.conflictsOf(other.unit)).has(unit)) return other.unit;
    }
    return null;
  }

  /**
   * Find the llama-server unit configured for this port, running or not. Discovery by configured
   * ExecStart rather than by live process is the whole point: a stopped engine has no process to
   * inspect, and a stopped engine is the normal case now that nothing autostarts.
   */
  private async unitForEndpoint(endpoint: string): Promise<string> {
    const port = new URL(endpoint).port || '80';
    const listed = await this.command(['list-unit-files', '--type=service', '--no-legend', '--no-pager', '--plain']);
    const names = listed.split('\n').map((line) => line.trim().split(/\s+/)[0])
      .filter(isAddressableUnit).slice(0, MAX_UNITS);
    if (!names.length) throw new Error(`No user services are installed, so nothing serves ${endpoint}.`);
    const facts = parseUnitFacts(await this.command(['show', ...names, `--property=${PROPERTIES}`]));
    const matches = facts.filter((unit) =>
      unit.argv.length > 0 && basename(unit.argv[0]) === 'llama-server' && portInArgv(unit.argv) === port);
    if (!matches.length) {
      throw new Error(`No llama-server user service is configured to listen on ${endpoint}. Start that server yourself, or add a unit for it.`);
    }
    if (matches.length > 1) {
      throw new Error(`More than one user service is configured for ${endpoint}: ${matches.map((unit) => unit.id).join(', ')}. Antimatter will not guess which one to start.`);
    }
    return matches[0].id;
  }

  /**
   * A source that names exactly one model is held to serving that model: the wrong checkpoint on
   * the right port is a misconfiguration worth reporting, not a ready engine. A multi-model
   * source cannot be checked that way from the preflight, which only knows the source, so it is
   * held to the weaker claim that the server is up and serving something.
   */
  private async healthy(endpoint: string, model: string | null, signal?: AbortSignal): Promise<boolean> {
    try {
      signal?.throwIfAborted();
      const health = await abortableRead(this.probe(endpoint, '/health'), signal) as { status?: unknown };
      if (health?.status !== 'ok') return false;
      const models = await abortableRead(this.probe(endpoint, '/v1/models'), signal) as { data?: Array<{ id?: unknown }> };
      signal?.throwIfAborted();
      const served = models?.data ?? [];
      return model === null ? served.length > 0 : served.some((entry) => entry.id === model);
    } catch { signal?.throwIfAborted(); return false; }
  }

  /** Refresh ownership without starting or stopping anything. A departed external owner is forgotten. */
  private async inspectRecord(record: Record_, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const facts = await abortableRead(this.unit(record.unit), signal);
    const unitStopped = facts && ['inactive', 'failed'].includes(facts.state) && facts.pid === 0;
    if (unitStopped || (!facts && record.ownership === 'external')) {
      const free = await abortableRead(this.portFree(record.endpoint), signal);
      signal?.throwIfAborted();
      if (this.records.get(record.sourceId) !== record) return;
      record.running = !free;
      record.healthySince = null;
      if (record.ownership === 'external' && free) this.forget(record);
      // A listener remaining after our unit exited belongs to somebody else.
      else if (!free) record.ownership = 'external';
    } else {
      signal?.throwIfAborted();
      // Missing/unreadable app units are not proof of retirement. stopRecord verifies it.
      record.running = true;
    }
  }

  inspectStates(): Promise<LocalEngineState[]> {
    return this.queue(async () => {
      for (const record of new Set(this.records.values())) await this.inspectRecord(record);
      return this.states();
    });
  }

  /**
   * A stopped server is startable only if the existing first-request lifecycle can identify its
   * exact unit and local startup files. This never starts, resets, adopts or supervises a unit.
   * Call after an unreachable health observation; a live/loading server keeps its own status.
   */
  async startability(source: LocalEngineSource): Promise<SourceReadiness> {
    const endpoint = engineEndpoint(source.baseUrl);
    if (!endpoint) return { state: 'unreachable' };
    try {
      if (this.stopped) throw new Error('Antimatter is shutting down.');
      let existing = this.records.get(source.sourceId);
      if (existing && existing.endpoint !== endpoint) throw new Error('This source endpoint changed. Restart Antimatter before managing its new engine.');
      if (existing?.ownership === 'external') {
        await this.inspectRecord(existing);
        existing = this.records.get(source.sourceId);
      }
      if (existing?.ownership === 'external') throw new Error('This server is managed outside Antimatter. Restart it yourself.');
      // Always rediscover: settings or unit files may have changed since a previous request.
      const name = await this.unitForEndpoint(endpoint);
      if (existing && existing.unit !== name) throw new Error('The user service for this source changed. Restart Antimatter before using it.');
      const facts = await this.unit(name);
      if (!facts || basename(facts.argv[0] ?? '') !== 'llama-server' || portInArgv(facts.argv) !== (new URL(endpoint).port || '80')) {
        throw new Error('The local engine configuration changed. Check its user service.');
      }
      if (!['inactive', 'failed'].includes(facts.state) || facts.pid !== 0) {
        throw new Error(`${name} is ${facts.state || 'unavailable'} but is not answering yet.`);
      }
      if (!this.fileAvailable(facts.argv[0], true)) throw new Error(`The llama-server executable for ${name} is missing or cannot run.`);
      const model = fileArgument(facts.argv, ['-m', '--model']);
      const preset = fileArgument(facts.argv, ['--models-preset']);
      if (!model && !preset) throw new Error(`The local model configuration for ${name} could not be verified.`);
      for (const path of [model, preset, fileArgument(facts.argv, ['-mm', '--mmproj'])].filter((path): path is string => path !== null)) {
        if (!this.fileAvailable(path, false)) throw new Error(`A model or preset file for ${name} is missing or unreadable: ${path}`);
      }
      if (!await this.portFree(endpoint)) throw new Error(`Something else is already listening on ${endpoint}.`);
      const serving = await this.conflictingBusy(name);
      if (serving) throw new Error(`${serving} is serving a request. Wait for it to finish before switching engines.`);
      const failure = existing?.lastError ?? (facts.state === 'failed' ? `${name} previously failed.` : null);
      return { state: 'startable', detail: failure
        ? `${failure} Send a message to retry starting this local engine.`
        : 'This local engine is stopped. It will start when you send a message.' };
    } catch (error) { return { state: 'unreachable', detail: message(error) }; }
  }

  private async waitHealthy(record: Record_, signal?: AbortSignal, model: string | null = record.model): Promise<void> {
    const deadline = this.now() + (this.options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    while (this.now() < deadline) {
      signal?.throwIfAborted();
      const facts = await abortableRead(this.unit(record.unit), signal);
      if (!facts) throw new Error(`${record.unit} is no longer available.`);
      if (facts.state === 'failed') {
        throw new Error(`${record.unit} failed to start. Check \`journalctl --user -u ${record.unit}\`.`);
      }
      if (facts.state === 'active' && await this.healthy(record.endpoint, model, signal)) {
        signal?.throwIfAborted();
        record.running = true;
        record.healthySince = this.now();
        return;
      }
      await abortableRead(this.sleep(READY_POLL_MS), signal);
    }
    throw new Error(`${model ?? record.unit} did not become ready within ${Math.round((this.options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS) / 1000)}s.`);
  }

  /**
   * Called from the request preflight, before any model input leaves the process. Returns once the
   * server behind this source is answering for this model, having started its unit if needed.
   */
  ensureRunning(source: LocalEngineSource, signal?: AbortSignal): Promise<void> {
    return this.queue(() => this.ensureUnlocked({ ...source, model: source.model ?? null }, signal), signal);
  }

  private async ensureUnlocked(source: { sourceId: string; baseUrl: string; model: string | null }, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.stopped) throw new Error('Antimatter is shutting down.');
    const endpoint = engineEndpoint(source.baseUrl);
    // Not a local loopback llama-server source: a remote provider needs no lifecycle from us.
    if (!endpoint) return;
    let existing = this.records.get(source.sourceId) ?? [...this.records.values()].find((record) => record.endpoint === endpoint);
    if (existing && existing.endpoint !== endpoint) throw new Error('This source endpoint changed. Restart Antimatter before managing its new engine.');
    if (existing) this.records.set(source.sourceId, existing);
    if (existing && await this.healthy(endpoint, source.model, signal)) {
      existing.running = true;
      existing.gaveUp = false;
      existing.lastError = null;
      existing.releaseWhenIdle = false;
      if (existing.healthySince === null) existing.healthySince = this.now();
      return;
    }
    // Something is already answering for this model and it is not a server we started. Leave it
    // entirely alone: use it, never supervise it, and never stop it.
    if (!existing && await this.healthy(endpoint, source.model, signal)) {
      let unit = '(unknown)';
      try { unit = await this.unitForEndpoint(endpoint); } catch { /* An ad-hoc server has no unit. */ }
      signal?.throwIfAborted();
      const record = this.record(source, endpoint, unit, 'external');
      record.healthySince = this.now();
      this.note(record, 'already serving; Antimatter did not start it and will not stop it');
      return;
    }
    if (existing?.ownership === 'external') {
      await this.inspectRecord(existing, signal);
      existing = this.records.get(source.sourceId);
    }
    if (existing?.ownership === 'external') {
      throw new Error(`${source.model ?? existing.unit} is served by a process Antimatter did not start, and it is not answering. Restart it yourself.`);
    }

    const unit = existing?.unit ?? await this.unitForEndpoint(endpoint);
    const facts = await this.unit(unit);
    signal?.throwIfAborted();
    if (!facts) throw new Error(`${unit} is no longer available.`);
    const alreadyRunning = !['inactive', 'failed'].includes(facts.state) || facts.pid !== 0;
    // An active/loading unit is external even before its health endpoint becomes ready.
    const record = existing ?? this.record(source, endpoint, unit, alreadyRunning ? 'external' : 'app');
    record.gaveUp = false;
    record.lastError = null;
    record.releaseWhenIdle = false;

    let startedHere = false;
    try {
      if (!alreadyRunning) {
      // Never attach this source to, or take credit for, a listener we did not spawn.
      if (!await this.portFree(endpoint)) {
        throw new Error(`Something else is already listening on ${endpoint}, so ${unit} was not started.`);
      }
      // Starting this unit stops whichever conflicting sibling is running. If that sibling is
      // serving a turn, doing so would cut it off, so refuse and say why instead.
      const serving = await this.conflictingBusy(unit);
      if (serving) {
        throw new Error(`${serving} is serving a request. Wait for it to finish before switching engines.`);
      }
      signal?.throwIfAborted();
      if (facts.state === 'failed') await this.command(['reset-failed', unit]);
      signal?.throwIfAborted();
      this.note(record, 'starting');
      record.startedAt = this.now();
      startedHere = true;
      await this.command(['start', unit]);
      record.running = true;
      }
      await this.waitHealthy(record, signal, source.model);
    } catch (error) {
      if (signal?.aborted) {
        // Wait for verified retirement before releasing the provider lease / next transition.
        if (startedHere) await this.stopRecord(record, 'the requesting turn was cancelled');
        else if (!existing && record.ownership === 'app') this.forget(record);
        signal.throwIfAborted();
      }
      if (!startedHere && !existing && record.ownership === 'app') this.forget(record);
      record.lastError = message(error);
      this.note(record, `did not become ready: ${record.lastError}`);
      throw error;
    }
    this.note(record, 'ready');
    if (record.ownership === 'app') this.supervise();
  }

  private record(source: { sourceId: string; model: string | null }, endpoint: string, unit: string, ownership: EngineOwnership): Record_ {
    const record: Record_ = { sourceId: source.sourceId, unit, endpoint, model: source.model, ownership,
      running: ownership === 'external',
      startedAt: null, failures: 0, gaveUp: false, lastError: null, logs: [],
      releaseWhenIdle: false, healthySince: null };
    this.records.set(source.sourceId, record);
    return record;
  }

  /** The window became visible again: keep engines resident while the user is looking at them. */
  foreground(): void {
    this.visible = true;
    for (const record of this.records.values()) record.releaseWhenIdle = false;
    this.supervise();
  }

  /**
   * The window was closed to the tray. Engines go with it — immediately for the idle ones, and as
   * soon as it finishes for a source still serving a turn, so backgrounding never abandons work
   * an agent is in the middle of.
   */
  background(): Promise<void> {
    this.visible = false;
    return this.releaseIdle('the window was closed');
  }

  private async releaseIdle(reason: string): Promise<void> {
    for (const record of new Set(this.records.values())) {
      if (record.ownership !== 'app') continue;
      if (this.busy(record)) { record.releaseWhenIdle = true; continue; }
      await this.queue(() => this.stopRecord(record, reason)).catch((error) =>
        this.options.log?.(`[local-engine] ${record.unit}: stop failed: ${message(error)}`));
    }
  }

  private async stopRecord(record: Record_, reason: string): Promise<void> {
    if (record.ownership !== 'app' || this.records.get(record.sourceId) !== record) return;
    this.note(record, `stopping (${reason})`);
    await this.command(['stop', record.unit]);
    const retired = await this.unit(record.unit);
    if (!retired || !['inactive', 'failed'].includes(retired.state) || retired.pid !== 0) {
      throw new Error(`${record.unit} retirement could not be confirmed; another engine was not started.`);
    }
    this.forget(record);
  }

  /** Full application exit. Everything we started comes down, in-flight turns included. */
  async stopOnQuit(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const record of new Set(this.records.values())) {
      if (record.ownership !== 'app') continue;
      await this.queue(() => this.stopRecord(record, 'Antimatter is quitting'))
        .catch((error) => this.options.log?.(`[local-engine] ${record.unit}: stop failed: ${message(error)}`));
    }
  }

  private supervise(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.tick(), SUPERVISE_INTERVAL_MS);
    this.timer.unref?.();
  }

  /**
   * One supervision pass. Only app-owned engines are watched, only while the window is visible,
   * and never while an engine profile switch is deliberately bouncing a unit.
   */
  async tick(): Promise<void> {
    if (this.stopped || this.options.applying?.()) return;
    for (const record of new Set(this.records.values())) {
      if (record.ownership !== 'app') continue;
      if (!this.visible) {
        if (record.releaseWhenIdle && !this.busy(record)) {
          await this.queue(() => this.stopRecord(record, 'the window is closed and the turn finished'))
            .catch((error) => this.options.log?.(`[local-engine] ${record.unit}: stop failed: ${message(error)}`));
        }
        continue;
      }
      if (record.gaveUp) continue;
      let facts: UnitFacts | null;
      try { facts = await this.unit(record.unit); } catch { continue; }
      if (!facts) continue;
      if (facts.state === 'active') {
        record.running = true;
        if (record.healthySince !== null && this.now() - record.healthySince >= HEALTHY_RESET_MS && record.failures) {
          this.note(record, `healthy for ${Math.round(HEALTHY_RESET_MS / 60_000)} minutes; clearing ${record.failures} recorded failure(s)`);
          record.failures = 0;
        }
        continue;
      }
      // The unit died while we were meant to be keeping it up.
      record.running = false;
      const delay = RESTART_DELAYS_MS[record.failures];
      record.failures += 1;
      record.healthySince = null;
      record.startedAt = null;
      if (delay === undefined) {
        record.gaveUp = true;
        record.lastError = `${record.unit} stopped ${record.failures} times and was not restarted again.`;
        this.note(record, 'giving up after repeated failures; start it from Models → Inference servers when the cause is fixed');
        continue;
      }
      this.note(record, `exited unexpectedly (${facts.state}); restarting in ${delay / 1000}s (attempt ${record.failures} of ${RESTART_DELAYS_MS.length})`);
      await this.sleep(delay);
      if (this.stopped || !this.visible || this.options.applying?.()) continue;
      try {
        await this.queue(async () => {
          // An intentional stop may have completed during this supervisor's restart delay.
          // Never resurrect the stale record after another backend has taken ownership.
          if (this.records.get(record.sourceId) !== record || this.stopped || !this.visible || this.options.applying?.()) return;
          if (!await this.portFree(record.endpoint)) {
            throw new Error(`something else is listening on ${record.endpoint}`);
          }
          const current = await this.unit(record.unit);
          if (current?.state === 'active') return;
          if (current?.state === 'failed') await this.command(['reset-failed', record.unit]);
          record.startedAt = this.now();
          await this.command(['start', record.unit]);
          await this.waitHealthy(record);
        });
        record.lastError = null;
        this.note(record, 'restarted');
      } catch (error) {
        record.lastError = message(error);
        this.note(record, `restart failed: ${record.lastError}`);
      }
    }
  }

  states(): LocalEngineState[] {
    return [...this.records].map(([sourceId, record]) => ({
      sourceId, unit: record.unit, endpoint: record.endpoint, model: record.model,
      ownership: record.ownership, running: record.running, ready: record.running && record.healthySince !== null,
      startedAt: record.startedAt, failures: record.failures, gaveUp: record.gaveUp,
      lastError: record.lastError, logs: [...record.logs],
    }));
  }

  /** Whether this source is one we are managing, for the inference panel's controls. */
  owns(sourceId: string): boolean {
    return this.records.get(sourceId)?.ownership === 'app';
  }

  /** Explicit stop from the inference panel. Only ever stops a unit Antimatter started. */
  async stopSource(sourceId: string): Promise<void> {
    const record = this.records.get(sourceId);
    if (!record) return;
    if (record.ownership !== 'app') {
      throw new Error(`${record.model ?? record.unit} is managed outside Antimatter and cannot be stopped here.`);
    }
    await this.queue(() => this.stopRecord(record, 'stopped from the inference panel'));
  }
}
