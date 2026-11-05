import { privateHagLaunchArgs } from './hagPrivateLaunch';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import { parseNativeBeholddInfo } from './beholddProtocol';

const exec = promisify(execFile);
const GiB = 1024 ** 3;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface HagProcess {
  stop(): Promise<void>; readonly pid?: number;
  prepareRequest?(modelId: string, signal?: AbortSignal): Promise<void>;
}
export interface HagPrivateMemory { forecastBytes: number; sourceFileBytes: number; deviceChargeBytes: number }
export class HagProcessCleanupError extends Error {
  constructor(message: string, readonly process: HagProcess) { super(message); }
}
export interface HagLaunchOptions {
  binary: string; config: string; port: number; modelId: string; signal?: AbortSignal;
  /** A qualification caller may shorten the product's finite lease, never extend it. */
  runtimeSeconds?: number;
  /** Only the native deployment qualification supplies an alternate finite policy. */
  containment?: HagContainment;
  privateMemory?: HagPrivateMemory;
  expectedModels?: Array<{ id: string; maxEvaluatedTokens?: number }>;
  /** Recheck pinned executable/config identity after waiting for resource headroom. */
  verifyIdentity?(): Promise<void>;
  identityUnchanged?(): void;
  onExit(reason: string, retired?: boolean): void;
}

/** Metadata-only eligibility. The native runtime additionally enforces physical GC 11.5.1. */
export function hagCapability(vendorRoot: string): { device: string | null; reason: string | null } {
  if (process.platform !== 'linux' || process.arch !== 'x64') return { device: null, reason: 'Experimental HAG currently requires Linux x86-64 and AMD GC 11.5.1.' };
  try {
    accessSync(join(vendorRoot, 'bin', 'beholdd'), constants.R_OK | constants.X_OK);
    accessSync('/usr/bin/systemd-run', constants.X_OK);
    accessSync('/usr/bin/systemctl', constants.X_OK);
    if (!existsSync('/sys/fs/cgroup/cgroup.controllers')) throw new Error('unified cgroups unavailable');
  } catch { return { device: null, reason: 'The packaged HAG runtime and systemd user cgroup support are required.' }; }
  try {
    const devices = readdirSync('/sys/class/drm').filter((name) => /^renderD\d+$/.test(name)).filter((name) => {
      const root = join('/sys/class/drm', name, 'device');
      return readFileSync(join(root, 'vendor'), 'utf8').trim() === '0x1002' &&
        readFileSync(join(root, 'device'), 'utf8').trim() === '0x1586';
    });
    if (devices.length !== 1) return { device: null, reason: 'HAG requires one supported AMD GC 11.5.1 device (PCI 1002:1586).' };
    const device = join('/dev/dri', devices[0]);
    accessSync(device, constants.R_OK | constants.W_OK);
    return { device, reason: null };
  } catch { return { device: null, reason: 'The supported AMD render device is unavailable or this user cannot access it.' }; }
}

export interface HagContainment {
  memoryMaxBytes: number; memoryHighBytes: number; tasksMax: number; cpuQuotaPercent: number;
  runtimeSeconds: number; startAvailableBytes: number; activeAvailableBytes: number;
  startTemperatureC: number; activeTemperatureC: number;
  startGpuTemperatureC?: number; activeGpuTemperatureC?: number;
}
export const PREVIEW_HAG_CONTAINMENT: Readonly<HagContainment> = Object.freeze({
  memoryMaxBytes: 6 * GiB, memoryHighBytes: 5632 * 1024 ** 2, tasksMax: 64, cpuQuotaPercent: 25,
  runtimeSeconds: 1800, startAvailableBytes: 12 * GiB, activeAvailableBytes: 4 * GiB,
  startTemperatureC: 60, activeTemperatureC: 90,
});

export function validateHagContainment(p: HagContainment): void {
  for (const name of ['memoryMaxBytes', 'memoryHighBytes', 'tasksMax', 'cpuQuotaPercent', 'runtimeSeconds',
    'startAvailableBytes', 'activeAvailableBytes'] as const) {
    if (!Number.isSafeInteger(p[name]) || p[name] <= 0) throw new Error(`Invalid HAG containment ${name}.`);
  }
  if (p.memoryHighBytes >= p.memoryMaxBytes || p.startAvailableBytes < p.activeAvailableBytes ||
      p.tasksMax > 256 || p.cpuQuotaPercent > 200 || p.runtimeSeconds < 30 || p.runtimeSeconds > 86400) {
    throw new Error('Invalid HAG containment bounds.');
  }
  if (![p.startTemperatureC, p.activeTemperatureC].every((v) => Number.isFinite(v) && v > 0 && v <= 90) ||
      p.startTemperatureC > p.activeTemperatureC) throw new Error('Invalid HAG CPU temperature bounds.');
  if (p.startGpuTemperatureC !== undefined || p.activeGpuTemperatureC !== undefined) {
    if (![p.startGpuTemperatureC, p.activeGpuTemperatureC].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 90) ||
        p.startGpuTemperatureC! > p.activeGpuTemperatureC!) throw new Error('Invalid HAG GPU temperature bounds.');
  }
}

export function hagSystemdArgs(options: HagLaunchOptions, unit: string): string[] {
  const policy = options.containment ?? PREVIEW_HAG_CONTAINMENT;
  validateHagContainment(policy);
  const runtimeSeconds = options.runtimeSeconds ?? policy.runtimeSeconds;
  if (!Number.isSafeInteger(runtimeSeconds) || runtimeSeconds < 30 || runtimeSeconds > policy.runtimeSeconds) {
    throw new Error(`HAG service runtime must be a whole number from 30 through ${policy.runtimeSeconds} seconds.`);
  }
  const size = (bytes: number) => bytes % GiB === 0 ? `${bytes / GiB}G` : bytes % (1024 ** 2) === 0 ? `${bytes / 1024 ** 2}M` : String(bytes);
  return ['--user', '--quiet', '--collect', '--wait', '--pipe', '--service-type=exec', `--unit=${unit}`,
    ...(options.containment ? ['--expand-environment=no'] : []),
    '-p', `MemoryMax=${size(policy.memoryMaxBytes)}`, '-p', `MemoryHigh=${size(policy.memoryHighBytes)}`, '-p', 'MemorySwapMax=0', '-p', `TasksMax=${policy.tasksMax}`,
    '-p', `CPUQuota=${policy.cpuQuotaPercent}%`, '-p', 'CPUAffinity=0 1', '-p', 'NoNewPrivileges=yes', '-p', 'OOMPolicy=stop',
    '-p', 'Restart=no', '-p', `RuntimeMaxSec=${runtimeSeconds}`, '-p', `TimeoutStopSec=${options.containment ? 65 : 5}`, '-p', 'KillMode=control-group',
    '/usr/bin/env', 'HAG_TRACE_SUBMISSION=0', 'HAG_SERVING_AUDIT=1', 'RAYON_NUM_THREADS=1',
    'OMP_NUM_THREADS=1', 'OPENBLAS_NUM_THREADS=1', 'TOKIO_WORKER_THREADS=1',
    ...(options.containment ? privateHagLaunchArgs(options.binary, options.config, options.port, unit, policy) :
      [options.binary, 'serve', '--config', options.config, '--host', '127.0.0.1', '--port', String(options.port)])];
}

function telemetry(): { available: number; temperature: number; gpuTemperature?: number } {
  const memory = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  const temperatures: number[] = [];
  const gpuTemperatures: number[] = [];
  for (const directory of readdirSync('/sys/class/hwmon')) {
    const root = join('/sys/class/hwmon', directory);
    if (readFileSync(join(root, 'name'), 'utf8').trim() === 'amdgpu') {
      for (const input of readdirSync(root).filter((name) => /^temp\d+_input$/.test(name))) {
        gpuTemperatures.push(Number(readFileSync(join(root, input), 'utf8')) / 1000);
      }
    }
    for (const label of readdirSync(root).filter((name) => /^temp\d+_label$/.test(name))) {
      if (readFileSync(join(root, label), 'utf8').trim() !== 'Tctl') continue;
      temperatures.push(Number(readFileSync(join(root, label.replace('_label', '_input')), 'utf8')) / 1000);
    }
  }
  if (!memory || !temperatures.length || temperatures.some((value) => !Number.isFinite(value) || value <= 0 || value > 150)) {
    throw new Error('HAG could not read host memory and CPU temperature safeguards.');
  }
  return { available: Number(memory[1]) * 1024, temperature: Math.max(...temperatures),
    gpuTemperature: gpuTemperatures.length ? Math.max(...gpuTemperatures) : undefined };
}

export function hagResourceFailure(sample: { available: number; temperature: number; gpuTemperature?: number }, starting = false,
  policy: HagContainment = PREVIEW_HAG_CONTAINMENT): string | null {
  if (!Number.isFinite(sample.available) || !Number.isFinite(sample.temperature)) return 'HAG resource telemetry is invalid.';
  const reserve = starting ? policy.startAvailableBytes : policy.activeAvailableBytes;
  if (sample.available < reserve) return `HAG requires ${reserve / GiB} GiB of available host memory.`;
  const maximum = starting ? policy.startTemperatureC : policy.activeTemperatureC;
  if (starting ? sample.temperature > maximum : sample.temperature >= maximum) return `HAG stopped for temperature (${sample.temperature.toFixed(1)}°C). Let the computer cool before retrying.`;
  const gpuMaximum = starting ? policy.startGpuTemperatureC : policy.activeGpuTemperatureC;
  if (gpuMaximum !== undefined) {
    if (!Number.isFinite(sample.gpuTemperature) || sample.gpuTemperature! <= 0) return 'HAG GPU temperature telemetry is invalid.';
    if (starting ? sample.gpuTemperature! > gpuMaximum : sample.gpuTemperature! >= gpuMaximum) return `HAG stopped for GPU temperature (${sample.gpuTemperature!.toFixed(1)}°C).`;
  }
  return null;
}

export function validateHagLimits(values: Record<string, string>, processStatus: string,
  policy: HagContainment = PREVIEW_HAG_CONTAINMENT): void {
  for (const [name, expected] of Object.entries({ 'memory.max': String(policy.memoryMaxBytes),
    'memory.high': String(policy.memoryHighBytes), 'memory.swap.max': '0', 'pids.max': String(policy.tasksMax) })) {
    if (values[name]?.trim() !== expected) throw new Error(`HAG containment ${name} was not applied.`);
  }
  const cpu = values['cpu.max']?.trim().split(/\s+/).map(Number);
  if (!cpu || cpu.length !== 2 || !cpu.every((n) => Number.isFinite(n) && n > 0) || cpu[0] / cpu[1] !== policy.cpuQuotaPercent / 100) {
    throw new Error('HAG CPU quota was not applied.');
  }
  if (!/^Cpus_allowed_list:\s+0-1$/m.test(processStatus) || !/^NoNewPrivs:\s+1$/m.test(processStatus)) {
    throw new Error('HAG CPU affinity or no-new-privileges containment was not applied.');
  }
}

function cgroupFailure(path: string, pid: number, policy: HagContainment, accounting?: HagPrivateMemory & { baselineBytes: number }): string | null {
  if (!path.startsWith('/') || path.split('/').includes('..')) throw new Error('Invalid HAG cgroup identity.');
  const root = '/sys/fs/cgroup' + path;
  const read = (file: string) => readFileSync(join(root, file), 'utf8').trim();
  if (accounting) {
    const members = read('cgroup.procs').split(/\s+/);
    if (members.length !== 1 || members[0] !== String(pid) || readdirSync(root, { withFileTypes: true }).some((entry) => entry.isDirectory())) {
      return 'The native HAG service is no longer a dedicated single-process cgroup.';
    }
    const beforeCurrent = read('memory.current'); const beforeStat = read('memory.stat');
    const afterStat = read('memory.stat'); const afterCurrent = read('memory.current');
    validateHagPrivateAccounting(beforeCurrent, beforeStat, afterCurrent, afterStat, accounting);
  }
  validateHagLimits(Object.fromEntries(['memory.max', 'memory.high', 'memory.swap.max', 'pids.max', 'cpu.max'].map((name) => [name, read(name)])),
    readFileSync(`/proc/${pid}/status`, 'utf8'), policy);
  if (Number(read('memory.current')) >= policy.memoryHighBytes || Number(read('memory.swap.current')) !== 0) return 'HAG stopped at its early memory limit.';
  for (const file of ['memory.events', 'pids.events']) {
    if (read(file).split('\n').some((line) => Number(line.split(/\s+/)[1]) !== 0)) return 'HAG stopped after a memory or task-limit event.';
  }
  return null;
}

export function validateHagCatalog(value: unknown, expected: Array<{ id: string; maxEvaluatedTokens?: number }>, requireCold = false): void {
  const rows = (value as { object?: unknown; data?: unknown })?.data;
  if (!Array.isArray(rows) || rows.length !== expected.length || new Set(rows.map((row) => row?.id)).size !== rows.length) {
    throw new Error('The owned HAG runtime returned a different model catalog.');
  }
  for (const model of expected) {
    const row = rows.find((candidate) => candidate?.id === model.id);
    if (!row || (requireCold && row.loaded !== false) || (model.maxEvaluatedTokens !== undefined &&
        row.execution_limits?.max_evaluated_tokens !== model.maxEvaluatedTokens)) {
      throw new Error('The owned HAG runtime did not report the required cold model and execution limit.');
    }
  }
}

/** Only actual prompts enter this gate; metadata/status/selection remain cold. */
export async function prepareHagRequest(modelId: string, admittedId: string,
  expected: Array<{ id: string; maxEvaluatedTokens?: number }>,
  guard: { verify(): Promise<void>; catalog(): Promise<unknown>; quiet(): Promise<void>; active(): void }, signal?: AbortSignal): Promise<void> {
  if (modelId !== admittedId) throw new Error('This contained native service is qualified only for OpenMythos HAG. Use a CPU-only configuration or another source for this model.');
  signal?.throwIfAborted(); await guard.verify();
  const listed = await guard.catalog() as { data?: Array<{ id?: string; loaded?: boolean }> };
  validateHagCatalog(listed, expected);
  const selected = listed.data?.find((entry) => entry.id === modelId);
  if (selected?.loaded !== true && selected?.loaded !== false) throw new Error('Native HAG did not report whether the model is cold.');
  if (!selected.loaded) await guard.quiet();
  else guard.active();
  signal?.throwIfAborted(); await guard.verify();
}

export function requireRetiredHagUnit(facts: Record<string, string>): void {
  if (!['inactive', 'failed'].includes(facts.ActiveState) || facts.MainPID !== '0' || facts.ControlPID !== '0') {
    throw new Error('The owned HAG service has not retired; another engine was not started.');
  }
}

export function parseHagAttestation(line: string, unit: string): { pid: number; baselineBytes: number; cgroup: string } | null {
  const fields = line.split(' ');
  if (fields.length !== 5 || fields[0] !== 'ANTIMATTER_HAG_ATTESTATION_V1' || fields[1] !== unit ||
      !/^[1-9][0-9]*$/.test(fields[2]) || !/^[0-9]+$/.test(fields[3]) ||
      !/^\/[a-zA-Z0-9/@_.-]+$/.test(fields[4]) || fields[4].split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..')) ||
      !fields[4].endsWith('/' + unit)) return null;
  const pid = Number(fields[2]); const baselineBytes = Number(fields[3]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(baselineBytes) || baselineBytes > 64 * 1024 ** 2) return null;
  return { pid, baselineBytes, cgroup: fields[4] };
}

export function validateHagPrivateAccounting(beforeCurrent: string, beforeStat: string, afterCurrent: string, afterStat: string,
  plan: HagPrivateMemory & { baselineBytes: number }): void {
  const number = (value: string | undefined) => {
    if (!value || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Native HAG cgroup accounting is malformed.');
    return Number(value);
  };
  const clean = (stat: string) => {
    const rows = stat.trim().split('\n').map((line) => line.trim().split(/\s+/));
    const values = Object.fromEntries(rows);
    if (new Set(rows.map((row) => row[0])).size !== rows.length) throw new Error('Native HAG cgroup statistics repeat a field.');
    return Math.max(0, number(values.file) - number(values.shmem) - number(values.file_dirty) - number(values.file_writeback) - number(values.unevictable));
  };
  if (![plan.forecastBytes, plan.sourceFileBytes, plan.deviceChargeBytes, plan.baselineBytes].every(Number.isSafeInteger) ||
      plan.sourceFileBytes <= 0 || plan.deviceChargeBytes <= 0 || plan.forecastBytes <= plan.sourceFileBytes ||
      plan.baselineBytes < 0 || plan.baselineBytes > 64 * 1024 ** 2) throw new Error('Native HAG private memory plan is malformed.');
  const current = Math.max(number(beforeCurrent.trim()), number(afterCurrent.trim()));
  const credit = Math.min(clean(beforeStat), clean(afterStat), plan.sourceFileBytes, current);
  const nonfile = current - credit + plan.deviceChargeBytes;
  const limit = plan.forecastBytes - plan.sourceFileBytes + plan.baselineBytes;
  if (!Number.isSafeInteger(limit) || limit <= 0 || plan.baselineBytes < 0 || plan.baselineBytes > 64 * 1024 ** 2 || nonfile > limit) {
    throw new Error('Native HAG stopped at its qualified nonfile memory limit.');
  }
}

async function unitFacts(unit: string, allowRetired = false): Promise<Record<string, string>> {
  let stdout: string;
  try {
    ({ stdout } = await exec('/usr/bin/systemctl', ['--user', 'show', unit,
      '--property=ActiveState,SubState,MainPID,ControlPID,ControlGroup'], { timeout: 5000, maxBuffer: 16 * 1024, env: { ...process.env, LC_ALL: 'C' } }));
  } catch (error) {
    if (allowRetired && /could not be found|not found/.test(String((error as { stderr?: unknown }).stderr))) {
      return { ActiveState: 'inactive', MainPID: '0', ControlPID: '0', ControlGroup: '' };
    }
    throw error;
  }
  return Object.fromEntries(stdout.trim().split('\n').map((line) => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
}

async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`HAG port ${port} is already in use; the existing server was left untouched.`)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve()));
  });
}

/** Confirm the process systemd owns is also the loopback listener before using HTTP. */
function ownsListener(pid: number, port: number, binary: string): boolean {
  try {
    if (realpathSync(`/proc/${pid}/exe`) !== realpathSync(binary)) return false;
    const sockets = new Set(readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      try { const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`)); return match ? [match[1]] : []; }
      catch { return []; }
    }));
    const address = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
    return readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1).some((line) => {
      const fields = line.trim().split(/\s+/); return fields[1] === address && fields[3] === '0A' && sockets.has(fields[9]);
    });
  } catch { return false; }
}

async function boundedJson(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1500) });
  if (!response.ok || !response.body) throw new Error('HAG did not return a healthy runtime descriptor.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.length;
      if (bytes > 64 * 1024) throw new Error('HAG metadata exceeds its fixed limit.'); chunks.push(item.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Own one dedicated, finite systemd service. There is no adoption or automatic restart. */
export async function launchHag(options: HagLaunchOptions): Promise<HagProcess> {
  const policy = options.containment ?? PREVIEW_HAG_CONTAINMENT;
  validateHagContainment(policy);
  if (options.containment && !options.privateMemory) throw new Error('Native HAG requires a qualified private-memory forecast.');
  const waitForQuiet = async (signal?: AbortSignal, verify?: () => Promise<void>) => {
    let quietSince = Date.now(); const quietDeadline = Date.now() + 60_000;
    for (;;) {
      options.signal?.throwIfAborted(); signal?.throwIfAborted();
      await verify?.();
      const failure = hagResourceFailure(telemetry(), true, policy);
      if (failure) quietSince = Date.now();
      if (!failure && Date.now() - quietSince >= 10_000) break;
      if (Date.now() >= quietDeadline) throw new Error(failure ?? 'HAG needs ten seconds of cool startup headroom.');
      await sleep(1000);
    }
  };
  await waitForQuiet();
  await options.verifyIdentity?.();
  await requireFreePort(options.port);
  options.signal?.throwIfAborted();
  const unit = `antimatter-hag-${process.pid}-${randomUUID()}.service`;
  const environment = { ...process.env };
  delete environment.BEHOLDD_HAG_PRIVATE_CGROUP;
  const child = spawn('/usr/bin/systemd-run', hagSystemdArgs(options, unit), { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; let exited = false; let stopping = false; let online = false;
  let monitor: ReturnType<typeof setInterval> | null = null;
  let monitoring = false; let cgroup = ''; let ownedPid = 0;
  const attestation: { value: ReturnType<typeof parseHagAttestation> } = { value: null };
  let lineBuffer = '';
  const append = (chunk: Buffer) => {
    const text = chunk.toString('utf8'); log = (log + text).slice(-8192);
    lineBuffer += text;
    while (lineBuffer.includes('\n')) {
      const newline = lineBuffer.indexOf('\n'); const line = lineBuffer.slice(0, newline); lineBuffer = lineBuffer.slice(newline + 1);
      const parsed = parseHagAttestation(line, unit);
      if (parsed && !attestation.value) attestation.value = parsed;
    }
    lineBuffer = lineBuffer.slice(-4096);
  };
  child.stdout?.on('data', append); child.stderr?.on('data', append);
  const retired = new Promise<void>((resolve) => {
    child.once('error', (error) => { log += error.message; exited = true; resolve(); });
    child.once('close', (code) => {
      exited = true; if (monitor) clearInterval(monitor); resolve();
      if (online && !stopping) {
        const reason = `HAG service stopped (exit ${code ?? 'unknown'}). Re-enable HAG to retry. ${log.slice(-500)}`;
        options.onExit(reason, false);
        void stop().then(() => options.onExit(reason, true), (error) => options.onExit(`${reason} Cleanup needs attention: ${String(error)}`, false));
      }
    });
  });
  const stop = async (): Promise<void> => {
    stopping = true; if (monitor) clearInterval(monitor);
    // The launcher can still be registering its unit when startup is cancelled.
    const registrationDeadline = Date.now() + 5000;
    while (!exited && Date.now() < registrationDeadline) {
      const facts = await unitFacts(unit, true);
      if (facts.ControlGroup || Number(facts.MainPID) > 0 || facts.ActiveState === 'activating') break;
      await sleep(100);
    }
    await exec('/usr/bin/systemctl', ['--user', 'stop', unit], { timeout: options.containment ? 72_000 : 12_000, maxBuffer: 16 * 1024 }).catch((error) => {
      if (!/not loaded|not found|could not be found/.test(String((error as { stderr?: unknown }).stderr))) throw error;
      if (!exited) child.kill('SIGTERM');
    });
    await Promise.race([retired, sleep(7000)]);
    const facts = await unitFacts(unit, exited);
    requireRetiredHagUnit(facts);
    if (!exited) throw new Error('HAG supervisor retirement could not be confirmed.');
    if (cgroup && existsSync('/sys/fs/cgroup' + cgroup) &&
      !/^populated 0$/m.test(readFileSync('/sys/fs/cgroup' + cgroup + '/cgroup.events', 'utf8'))) {
      throw new Error('The owned HAG cgroup still contains processes.');
    }
  };
  try {
    const deadline = Date.now() + 25_000;
    for (;;) {
      options.signal?.throwIfAborted();
      if (exited) throw new Error(`The contained HAG service failed to start. ${log.slice(-1000)}`);
      const facts = await unitFacts(unit, true);
      ownedPid = Number(facts.MainPID); cgroup = facts.ControlGroup;
      if (ownedPid > 0 && cgroup && basename(cgroup) === unit && ownsListener(ownedPid, options.port, options.binary)) {
        if (options.privateMemory && (!attestation.value || attestation.value.pid !== ownedPid || attestation.value.cgroup !== cgroup)) {
          throw new Error('The native HAG pre-exec cgroup attestation was not verified.');
        }
        const info = parseNativeBeholddInfo(await boundedJson(`http://127.0.0.1:${options.port}/v1/beholdd/info`));
        const listed = await boundedJson(`http://127.0.0.1:${options.port}/v1/models`) as { data?: Array<{ id?: string; execution_limits?: { max_evaluated_tokens?: number } }> };
        if (!info?.execution_backends.includes('hag') || !info.operations.unload) {
          throw new Error('The owned HAG runtime did not report a native backend and unload support.');
        }
        validateHagCatalog(listed, options.expectedModels ?? [{ id: options.modelId, maxEvaluatedTokens: 16_384 }], !!options.expectedModels);
        options.identityUnchanged?.();
        const failure = cgroupFailure(cgroup, ownedPid, policy, options.privateMemory && attestation.value ? { ...options.privateMemory, baselineBytes: attestation.value.baselineBytes } : undefined) ?? hagResourceFailure(telemetry(), false, policy);
        if (failure) throw new Error(failure);
        break;
      }
      if (Date.now() > deadline) throw new Error('The owned HAG listener did not become ready in time.');
      await sleep(200);
    }
    online = true;
    monitor = setInterval(() => {
      if (monitoring || stopping || exited) return; monitoring = true;
      void (async () => {
        const facts = await unitFacts(unit);
        if (Number(facts.MainPID) !== ownedPid || facts.ControlGroup !== cgroup || facts.ActiveState !== 'active') throw new Error('The owned HAG service identity changed.');
        options.identityUnchanged?.();
        const failure = hagResourceFailure(telemetry(), false, policy) ?? cgroupFailure(cgroup, ownedPid, policy, options.privateMemory && attestation.value ? { ...options.privateMemory, baselineBytes: attestation.value.baselineBytes } : undefined);
        if (failure) throw new Error(failure);
      })().catch(async (error) => {
        // A manual stop can finish while this asynchronous sample is in flight.
        if (stopping || exited) return;
        const reason = error instanceof Error ? error.message : String(error);
        options.onExit(reason, false);
        try { await stop(); options.onExit(reason, true); }
        catch (failure) { options.onExit(`${reason} Cleanup needs attention: ${String(failure)}`, false); }
      }).finally(() => { monitoring = false; });
    }, 2000);
    monitor.unref();
    const verifyOwned = async () => {
      if (stopping || exited) throw new Error('The native HAG owner is stopping or has exited.');
      const facts = await unitFacts(unit);
      if (Number(facts.MainPID) !== ownedPid || facts.ControlGroup !== cgroup || facts.ActiveState !== 'active' ||
          !ownsListener(ownedPid, options.port, options.binary)) throw new Error('The native HAG listener identity changed.');
      options.identityUnchanged?.();
      const failure = cgroupFailure(cgroup, ownedPid, policy, options.privateMemory && attestation.value ? { ...options.privateMemory, baselineBytes: attestation.value.baselineBytes } : undefined);
      if (failure) throw new Error(failure);
    };
    const prepareRequest = (modelId: string, signal?: AbortSignal) => prepareHagRequest(modelId, options.modelId,
      options.expectedModels ?? [{ id: options.modelId, maxEvaluatedTokens: 16_384 }], {
        verify: verifyOwned,
        catalog: () => boundedJson(`http://127.0.0.1:${options.port}/v1/models`),
        quiet: () => waitForQuiet(signal, verifyOwned),
        active: () => {
          const failure = hagResourceFailure(telemetry(), false, policy);
          if (failure) throw new Error(failure);
        },
      }, signal);
    return { stop, pid: ownedPid, ...(options.privateMemory ? { prepareRequest } : {}) };
  } catch (error) {
    await stop().catch((cleanup) => { throw new HagProcessCleanupError(`${String(error)}; HAG cleanup failed: ${String(cleanup)}`, { stop }); });
    throw error;
  }
}
