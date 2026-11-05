import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { MODEL_RUNTIME_PROFILE_LIMITS as LIMITS } from '../api/modelRuntimeProfiles';
import { writePrivateFileAtomic } from './privateState';

/** Context tokens are per inference slot. llama-server's --ctx-size is the total across slots.
 *
 *  `modelPath` is the quantization axis: absent means "whatever the unit's own -m says", which is
 *  every profile written before quant switching existed. Present means this profile re-points the
 *  engine at a different file of the same model. It is kept optional, and serialized last, so the
 *  `# Settings:` metadata of an existing override stays byte-identical — `verifyOwnedOverride`
 *  compares the whole rendered file, so a gratuitous key would invalidate every saved profile. */
export interface LocalRuntimeSettings { contextTokens: number; parallel: number; modelPath?: string }
export interface LocalExecutableIdentity { path: string; dev: number; ino: number; size: number; mtimeMs: number }
/** Host-private persisted evidence, never an IPC payload or a model-supplied configuration. */
export interface LocalRuntimeBinding {
  version: 1;
  sourceId: string;
  model: string;
  endpoint: string;
  unit: string;
  baselineArgv: string[];
  executable: LocalExecutableIdentity;
  unitFingerprint: string;
  baseline: LocalRuntimeSettings;
  uid: number;
}
export interface LocalRuntimeProcess { uid: number; argv: string[]; executable: LocalExecutableIdentity }
export interface LocalRuntimeServiceOptions {
  busy(sourceId: string): boolean | string;
  systemdDirectory?: string;
  uid?: number;
  /** Test seam: arguments to systemctl --user, never shell source. */
  command?(args: string[]): Promise<string>;
  process?(pid: number): LocalRuntimeProcess;
  probe?(endpoint: string, path: '/health' | '/props' | '/v1/models' | '/slots'): Promise<unknown>;
  /** Recovery may start a stopped service only when its loopback port has no other listener. */
  portFree?(endpoint: string): Promise<boolean>;
  sleep?(milliseconds: number): Promise<void>;
  now?(): number;
  startupTimeoutMs?: number;
}

interface Unit {
  id: string; state: string; pid: number; fragment: string; dropIns: string[]; reload: boolean;
}
const UNIT = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*\.service$/;
const OWNED_FILE = 'zz-antimatter-runtime-profile.conf';
const HEADER = '# Managed by Antimatter runtime profiles. Do not edit.\n';
const PROPERTIES = 'Id,LoadState,ActiveState,SubState,MainPID,FragmentPath,DropInPaths,NeedDaemonReload';
const exec = promisify(execFile);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const cleanText = (value: unknown, max = 512): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/**
 * A weights file this may be pointed at. Existence is deliberately NOT required here: validation
 * also runs when parsing an override already on disk, and a deleted checkpoint must still be
 * parseable so the baseline can be restored rather than the unit left stranded.
 */
function validateModelPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('A profile model path must be plain text under 4096 characters.');
  }
  if (!isAbsolute(value)) throw new Error('A profile model path must be absolute.');
  if (!/\.gguf$/i.test(value)) throw new Error('A profile model path must be a .gguf file.');
  return value;
}

export function validateLocalRuntimeSettings(value: LocalRuntimeSettings): LocalRuntimeSettings {
  if (!value || !Number.isSafeInteger(value.contextTokens) || value.contextTokens < LIMITS.minContextTokens || value.contextTokens > LIMITS.maxContextTokens ||
      !Number.isSafeInteger(value.parallel) || value.parallel < 1 || value.parallel > LIMITS.maxParallel ||
      value.contextTokens * value.parallel > LIMITS.maxTotalContextTokens) {
    throw new Error('Engine settings require 512–2,097,152 context tokens per slot, 1–16 slots, and at most 2,097,152 total context tokens.');
  }
  // Key order is contractual: modelPath last, omitted when absent, so JSON.stringify of a
  // pre-quant profile is unchanged.
  return { contextTokens: value.contextTokens, parallel: value.parallel,
           ...(value.modelPath === undefined ? {} : { modelPath: validateModelPath(value.modelPath) }) };
}

function endpointOf(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('The local model endpoint is invalid.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('Engine profiles support direct loopback HTTP llama-server endpoints only.');
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}

export function isLocalRuntimeBinding(value: unknown): value is LocalRuntimeBinding {
  if (!value || typeof value !== 'object') return false;
  const v = value as LocalRuntimeBinding;
  try {
    if (v.version !== 1 || !cleanText(v.sourceId, 256) || !cleanText(v.model) || !UNIT.test(v.unit) ||
        endpointOf(v.endpoint) !== v.endpoint || !Number.isSafeInteger(v.uid) || v.uid < 0 ||
        !Array.isArray(v.baselineArgv) || !v.baselineArgv.length || v.baselineArgv.length > 512 ||
        !v.baselineArgv.every((arg) => typeof arg === 'string' && arg.length <= 65536 && !/[\u0000-\u001f\u007f]/.test(arg)) ||
        !isAbsolute(v.baselineArgv[0]) || !/^[a-f0-9]{64}$/.test(v.unitFingerprint) ||
        !v.executable || !isAbsolute(v.executable.path) || basename(v.executable.path) !== 'llama-server' ||
        ![v.executable.dev, v.executable.ino, v.executable.size, v.executable.mtimeMs].every(Number.isFinite)) return false;
    validateLocalRuntimeSettings(v.baseline);
    return true;
  } catch { return false; }
}

function identity(path: string): LocalExecutableIdentity {
  const canonical = realpathSync(path);
  const stats = statSync(canonical);
  if (!stats.isFile()) throw new Error('The server executable is not a regular file.');
  return { path: canonical, dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
}
function localProcess(pid: number): LocalRuntimeProcess {
  const root = `/proc/${pid}`;
  const argv = readFileSync(join(root, 'cmdline'), 'utf8').split('\0');
  if (argv.at(-1) === '') argv.pop();
  return { uid: statSync(root).uid, argv, executable: identity(join(root, 'exe')) };
}
async function localProbe(endpoint: string, path: string): Promise<unknown> {
  const response = await fetch(`${endpoint}${path}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`The local server's ${path} endpoint returned HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length') ?? 0) > 1_048_576) throw new Error('The local server response is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The local server returned no response body.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1_048_576) { await reader.cancel(); throw new Error('The local server response is too large.'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function localPortFree(endpoint: string): Promise<boolean> {
  const url = new URL(endpointOf(endpoint));
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

function parseUnits(output: string): Unit[] {
  return output.trim().split(/\n\s*\n/).flatMap((block) => {
    const p = Object.fromEntries(block.split('\n').map((line) => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    if (!UNIT.test(p.Id ?? '') || p.LoadState !== 'loaded') return [];
    return [{ id: p.Id, state: p.ActiveState, pid: Number(p.MainPID), fragment: p.FragmentPath,
      dropIns: (p.DropInPaths ?? '').split(' ').filter(Boolean), reload: p.NeedDaemonReload === 'yes' }];
  });
}
function option(argv: string[], names: string[]): string | undefined {
  let value: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const name = names.find((candidate) => argv[i] === candidate || argv[i].startsWith(`${candidate}=`));
    if (!name) continue;
    value = argv[i] === name ? argv[++i] : argv[i].slice(name.length + 1);
  }
  return value;
}
export function runtimeProfileArgv(baseline: string[], settings: LocalRuntimeSettings): string[] {
  const valid = validateLocalRuntimeSettings(settings);
  const argv = [...baseline];
  const changes = [
    { names: ['--ctx-size', '-c'], value: String(valid.contextTokens * valid.parallel) },
    { names: ['--parallel', '-np'], value: String(valid.parallel) },
    // Only when the profile names one. Absent leaves the unit's own -m untouched, which is what
    // every pre-quant profile must keep doing.
    ...(valid.modelPath ? [{ names: ['--model', '-m'], value: valid.modelPath }] : []),
  ];
  for (const { names, value } of changes) {
    let found = false;
    for (let i = 1; i < argv.length; i++) {
      const name = names.find((candidate) => argv[i] === candidate || argv[i].startsWith(`${candidate}=`));
      if (!name) continue;
      found = true;
      if (argv[i] === name) {
        if (i + 1 >= argv.length) throw new Error('The original server command has an incomplete engine flag.');
        argv[++i] = value;
      } else argv[i] = `${name}=${value}`;
    }
    if (!found) argv.push(names[0], value);
  }
  return argv;
}
/** The weights an argv points at, or undefined when it names none. */
export function modelInArgv(argv: string[]): string | undefined {
  return option(argv, ['--model', '-m']);
}

function settingsInArgv(argv: string[]): LocalRuntimeSettings {
  const context = option(argv, ['--ctx-size', '-c']);
  const parallel = option(argv, ['--parallel', '-np']);
  if (!context || !parallel || !/^\d+$/.test(context) || !/^\d+$/.test(parallel)) {
    throw new Error('The app-owned profile command has no verifiable engine allocation.');
  }
  return validateLocalRuntimeSettings({ contextTokens: Number(context) / Number(parallel), parallel: Number(parallel) });
}
function systemdWord(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('The original command contains unsupported control characters.');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}
export function runtimeProfileOverride(binding: LocalRuntimeBinding, argv: string[],
                                       settings: LocalRuntimeSettings): string {
  const valid = validateLocalRuntimeSettings(settings);
  // Defence in depth: the argv being written must actually carry the allocation being recorded.
  const inArgv = settingsInArgv(argv);
  if (inArgv.contextTokens !== valid.contextTokens || inArgv.parallel !== valid.parallel) {
    throw new Error('The app-owned profile command does not match its recorded engine allocation.');
  }
  if (valid.modelPath && modelInArgv(argv) !== valid.modelPath) {
    throw new Error('The app-owned profile command does not match its recorded model path.');
  }
  // ':' suppresses systemd's environment expansion; doubled '%' suppresses specifier expansion.
  // No shell is involved, so literal $, quotes, spaces, and shell punctuation remain argv data.
  return `${HEADER}# Binding: ${hash(binding)}\n# Settings: ${JSON.stringify(valid)}\n[Service]\nExecStart=\nExecStart=:${argv.map(systemdWord).join(' ')}\n`;
}

/** The settings an override on disk records, which is the only authority for its model path:
 *  `/props` reports context and slots but never which file they were loaded from. */
export function overrideSettings(contents: string): LocalRuntimeSettings {
  const metadata = /^# Settings: (.+)$/m.exec(contents)?.[1];
  return validateLocalRuntimeSettings(JSON.parse(metadata ?? 'null'));
}

/** No live process is needed to prove this is one exact override generated for this binding. */
function verifyOwnedOverride(binding: LocalRuntimeBinding, contents: string): void {
  let settings: LocalRuntimeSettings;
  try { settings = overrideSettings(contents); }
  catch { throw new Error('The stopped engine’s profile override has no valid Antimatter settings record. It was left untouched.'); }
  if (contents !== runtimeProfileOverride(binding, runtimeProfileArgv(binding.baselineArgv, settings), settings)) {
    throw new Error('The stopped engine’s profile override changed outside Antimatter. It was left untouched.');
  }
}

export class LocalRuntimeServiceManager {
  private readonly uid: number;
  private readonly directory: string;
  private readonly command: NonNullable<LocalRuntimeServiceOptions['command']>;
  private readonly process: NonNullable<LocalRuntimeServiceOptions['process']>;
  private readonly probe: NonNullable<LocalRuntimeServiceOptions['probe']>;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly options: LocalRuntimeServiceOptions) {
    this.uid = options.uid ?? process.getuid?.() ?? -1;
    this.directory = options.systemdDirectory ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
    this.command = options.command ?? (async (args) => (await exec('systemctl', ['--user', ...args], { timeout: 30_000, maxBuffer: 1_048_576 })).stdout);
    this.process = options.process ?? localProcess;
    this.probe = options.probe ?? localProbe;
  }
  get isApplying(): boolean { return this.pending > 0; }

  private owned(unit: string): string { return join(this.directory, `${unit}.d`, OWNED_FILE); }
  private async unit(name: string): Promise<Unit> {
    if (!UNIT.test(name)) throw new Error('The registered service identity is invalid.');
    const units = parseUnits(await this.command(['show', name, `--property=${PROPERTIES}`]));
    const unit = units.find((entry) => entry.id === name);
    if (!unit) throw new Error('The registered user service is no longer available.');
    return unit;
  }
  private file(path: string): string | null {
    if (!existsSync(path)) return null;
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== this.uid || stats.size > 1_048_576) {
      throw new Error('A service configuration file is not an owned regular file.');
    }
    return readFileSync(path, 'utf8');
  }
  private fingerprint(unit: Unit): string {
    if (!isAbsolute(unit.fragment)) throw new Error('The service has no persistent unit file.');
    const own = this.owned(unit.id);
    const directory = dirname(own);
    if (existsSync(directory)) {
      const stats = lstatSync(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== this.uid) throw new Error('The service drop-in directory is not user-owned.');
    }
    const entries = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.conf')).map((name) => join(directory, name)) : [];
    const files = [...new Set([unit.fragment, ...unit.dropIns, ...entries].filter((path) => path !== own))].sort();
    return hash(files.map((path) => {
      const contents = this.file(path);
      if (contents === null) throw new Error('A service configuration file disappeared.');
      return [path, contents];
    }));
  }
  private processFor(unit: Unit): LocalRuntimeProcess {
    if (unit.state !== 'active' || !Number.isSafeInteger(unit.pid) || unit.pid <= 1) throw new Error('The registered model service is not running.');
    const current = this.process(unit.pid);
    if (current.uid !== this.uid || !current.argv.length || !isAbsolute(current.argv[0]) ||
        basename(current.executable.path) !== 'llama-server' || !equal(identity(current.argv[0]), current.executable)) {
      throw new Error('The service MainPID is not a user-owned direct llama-server process.');
    }
    return current;
  }
  private binding(binding: LocalRuntimeBinding): void {
    if (!isLocalRuntimeBinding(binding) || binding.uid !== this.uid) throw new Error('The saved local engine binding is invalid.');
  }
  private async settings(binding: Pick<LocalRuntimeBinding, 'endpoint' | 'model'>): Promise<LocalRuntimeSettings> {
    const health = await this.probe(binding.endpoint, '/health') as { status?: unknown };
    if (health?.status !== 'ok') throw new Error('The local model is not healthy yet.');
    const props = await this.probe(binding.endpoint, '/props') as { model_alias?: unknown; total_slots?: number; default_generation_settings?: { n_ctx?: number } };
    const models = await this.probe(binding.endpoint, '/v1/models') as { data?: Array<{ id?: unknown }> };
    if (props?.model_alias !== binding.model || !models?.data?.some((model) => model.id === binding.model)) {
      throw new Error('The endpoint is not serving the registered model.');
    }
    return validateLocalRuntimeSettings({ contextTokens: props.default_generation_settings?.n_ctx ?? 0, parallel: props.total_slots ?? 0 });
  }
  private async idle(binding: LocalRuntimeBinding, settings?: LocalRuntimeSettings): Promise<void> {
    const reason = this.options.busy(binding.sourceId);
    if (reason) throw new Error(typeof reason === 'string' ? reason : 'Finish or stop active model work before switching engine profiles.');
    const slots = await this.probe(binding.endpoint, '/slots');
    if (!Array.isArray(slots) || !slots.length || (settings && slots.length !== settings.parallel) ||
        slots.some((slot) => !slot || typeof slot !== 'object' ||
          !('is_processing' in slot ? slot.is_processing === false : slot.state === 'idle' || slot.state === 0))) {
      throw new Error('The local engine has active work, or its /slots endpoint cannot confirm it is idle.');
    }
    // Work may have begun while the engine was being inspected.
    const after = this.options.busy(binding.sourceId);
    if (after) throw new Error(typeof after === 'string' ? after : 'The model became busy before its profile could be changed.');
  }
  private assertFiles(binding: LocalRuntimeBinding, unit: Unit, reloadAllowed = false): void {
    if ((!reloadAllowed && unit.reload) || this.fingerprint(unit) !== binding.unitFingerprint) {
      throw new Error('The model service configuration changed outside Antimatter. Restore or re-register it before switching profiles.');
    }
  }
  private async inspected(binding: LocalRuntimeBinding): Promise<{ unit: Unit; current: LocalRuntimeProcess; settings: LocalRuntimeSettings; override: string | null }> {
    this.binding(binding);
    const unit = await this.unit(binding.unit);
    this.assertFiles(binding, unit);
    const current = this.processFor(unit);
    if (!equal(current.executable, binding.executable)) throw new Error('The registered llama-server executable changed.');
    const override = this.file(this.owned(binding.unit));
    const live = await this.settings(binding);
    if (override === null && !equal(live, binding.baseline)) throw new Error('The original engine no longer reports its saved baseline context and parallel slots.');
    // `/props` reports context and slots but never the file they came from, so the override's own
    // record is the only authority for an active quantization. Context and slots stay verified
    // against the live engine; only the model path is taken from the override, and the argv
    // comparison below is what proves that path is the one actually running.
    // An override that cannot be parsed is not an error to raise here: it means the file was
    // changed outside Antimatter, and the argv/contents comparison below is what says so. Raising
    // a settings-validation error instead would mask a foreign edit as a malformed-config error.
    let recorded: LocalRuntimeSettings | null = null;
    if (override !== null) {
      try { recorded = overrideSettings(override); } catch { recorded = null; }
    }
    const settings = recorded?.modelPath
      ? validateLocalRuntimeSettings({ ...live, modelPath: recorded.modelPath })
      : live;
    const expectedArgv = override === null ? binding.baselineArgv : runtimeProfileArgv(binding.baselineArgv, settings);
    if (!equal(current.argv, expectedArgv) ||
        (override !== null && override !== runtimeProfileOverride(binding, expectedArgv, settings))) {
      throw new Error('The running command or Antimatter profile override changed outside the saved profile.');
    }
    const after = await this.unit(binding.unit);
    this.assertFiles(binding, after);
    if (after.pid !== unit.pid) throw new Error('The model service restarted during inspection. Retry after it settles.');
    return { unit, current, settings, override };
  }

  async discover(input: { sourceId: string; baseUrl: string; model: string }): Promise<LocalRuntimeBinding | null> {
    if (!cleanText(input.sourceId, 256) || !cleanText(input.model)) throw new Error('The source or model identity is invalid.');
    const endpoint = endpointOf(input.baseUrl);
    const port = new URL(endpoint).port || '80';
    const listed = await this.command(['list-units', '--type=service', '--state=running', '--no-legend', '--no-pager', '--plain']);
    const names = listed.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter((name) => UNIT.test(name)).slice(0, 512);
    if (!names.length) return null;
    const units = parseUnits(await this.command(['show', ...names, `--property=${PROPERTIES}`]));
    const candidates: Array<{ unit: Unit; current: LocalRuntimeProcess }> = [];
    for (const unit of units) {
      try {
        const current = this.processFor(unit);
        if (option(current.argv, ['--port']) !== port) continue;
        candidates.push({ unit, current });
      } catch { /* Unrelated user services and vanished processes are not model candidates. */ }
    }
    if (!candidates.length) return null;
    if (candidates.length !== 1) throw new Error('More than one user llama-server service matches this port.');
    const { unit, current } = candidates[0];
    if (unit.reload) throw new Error('Reload the externally changed service configuration before registering engine profiles.');
    if (this.file(this.owned(unit.id)) !== null) throw new Error('An Antimatter engine override already exists. Use its saved runtime binding to restore it.');
    const baseline = await this.settings({ endpoint, model: input.model });
    const binding: LocalRuntimeBinding = { version: 1, sourceId: input.sourceId, model: input.model, endpoint,
      unit: unit.id, baselineArgv: [...current.argv], executable: { ...current.executable },
      unitFingerprint: this.fingerprint(unit), baseline, uid: this.uid };
    this.binding(binding);
    await this.inspected(binding);
    return binding;
  }

  async inspect(binding: LocalRuntimeBinding): Promise<LocalRuntimeSettings> { return (await this.inspected(binding)).settings; }

  apply(binding: LocalRuntimeBinding, settings: LocalRuntimeSettings): Promise<LocalRuntimeSettings> {
    return this.enqueue(binding, validateLocalRuntimeSettings(settings));
  }
  restore(binding: LocalRuntimeBinding): Promise<LocalRuntimeSettings> { return this.enqueue(binding, null); }

  private enqueue(binding: LocalRuntimeBinding, requested: LocalRuntimeSettings | null): Promise<LocalRuntimeSettings> {
    const frozen = structuredClone(binding);
    this.pending += 1;
    const next = this.tail.catch(() => {}).then(() => this.change(frozen, requested));
    this.tail = next;
    return next.finally(() => { this.pending -= 1; });
  }
  private writeOwned(binding: LocalRuntimeBinding, contents: string | null): void {
    const path = this.owned(binding.unit);
    // Re-read before removal/replacement to reject symlink substitution.
    this.file(path);
    if (contents === null) rmSync(path, { force: true });
    else writePrivateFileAtomic(path, contents);
  }
  private async waitReady(binding: LocalRuntimeBinding, expected: LocalRuntimeSettings, argv: string[], oldPid: number): Promise<LocalRuntimeSettings> {
    const now = this.options.now ?? Date.now;
    const end = now() + (this.options.startupTimeoutMs ?? 600_000);
    let last = 'The model is starting.';
    while (now() < end) {
      const unit = await this.unit(binding.unit);
      this.assertFiles(binding, unit);
      if (unit.state === 'failed') throw new Error('The model service failed to start.');
      if (unit.state === 'active' && unit.pid !== oldPid) {
        const current = this.processFor(unit);
        if (!equal(current.executable, binding.executable) || !equal(current.argv, argv)) throw new Error('The restarted service is not using the expected executable and arguments.');
        let settings: LocalRuntimeSettings | null = null;
        try { settings = await this.settings(binding); } catch (error) { last = errorMessage(error); }
        if (settings) {
          // Only the allocation is checked against the live server, because only the allocation
          // is something it reports: `/props` gives n_ctx and total_slots and never the file the
          // weights came from. The model path is verified above, and more strongly — the argv
          // equality check compares the exact `-m` the process was started with.
          if (settings.contextTokens !== expected.contextTokens || settings.parallel !== expected.parallel) {
            throw new Error(`The restarted server reported ${settings.contextTokens} tokens per slot and ${settings.parallel} slots instead of the selected profile.`);
          }
          // Report the live-verified allocation together with the path the argv check proved is
          // running, so a caller sees the quantization it asked for rather than silently losing it.
          return expected.modelPath
            ? validateLocalRuntimeSettings({ ...settings, modelPath: expected.modelPath })
            : settings;
        }
      }
      await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(500);
    }
    throw new Error(`The model did not become ready before the startup timeout. ${last}`);
  }
  private assertAppIdle(binding: LocalRuntimeBinding): void {
    const busy = this.options.busy(binding.sourceId);
    if (busy) throw new Error(typeof busy === 'string' ? busy : 'Finish or stop active model work before restoring the original engine.');
  }
  private stoppedForRecovery(binding: LocalRuntimeBinding, unit: Unit): void {
    this.binding(binding);
    this.assertFiles(binding, unit);
    if (!['inactive', 'failed'].includes(unit.state) || unit.pid !== 0) {
      throw new Error('The engine is not fully stopped. Wait for it to settle before restoring Straight shot.');
    }
    if (!equal(identity(binding.baselineArgv[0]), binding.executable) || !equal(identity(binding.executable.path), binding.executable)) {
      throw new Error('The saved llama-server executable changed. Straight shot was not started.');
    }
  }
  private async recoverBaseline(binding: LocalRuntimeBinding, unit: Unit): Promise<LocalRuntimeSettings> {
    this.stoppedForRecovery(binding, unit);
    const override = this.file(this.owned(binding.unit));
    if (override !== null) verifyOwnedOverride(binding, override);
    this.assertAppIdle(binding);
    if (!await (this.options.portFree ?? localPortFree)(binding.endpoint)) {
      throw new Error('Another process is listening on this engine’s port. Straight shot was not started.');
    }
    this.assertAppIdle(binding);
    this.stoppedForRecovery(binding, await this.unit(binding.unit));
    if (this.file(this.owned(binding.unit)) !== override) throw new Error('The profile override changed before recovery.');
    let restarted = false;
    let changed = false;
    try {
      if (override !== null) { this.writeOwned(binding, null); changed = true; }
      await this.command(['daemon-reload']);
      this.assertAppIdle(binding);
      this.stoppedForRecovery(binding, await this.unit(binding.unit));
      if (this.file(this.owned(binding.unit)) !== null) throw new Error('Another process changed the profile override during recovery.');
      if (!await (this.options.portFree ?? localPortFree)(binding.endpoint)) throw new Error('Another process started using the engine port during recovery.');
      this.assertAppIdle(binding);
      restarted = true;
      await this.command(['restart', binding.unit]);
      return await this.waitReady(binding, binding.baseline, binding.baselineArgv, 0);
    } catch (error) {
      if (!restarted && changed && this.file(this.owned(binding.unit)) === null) {
        // A cancelled preflight has not touched a process. Restore our own previous file; never
        // undo another process's override, or restart work that appeared in the meantime.
        try {
          const current = await this.unit(binding.unit);
          this.assertFiles(binding, current, true);
          if (!['inactive', 'failed'].includes(current.state) || current.pid !== 0) throw new Error('The service changed during recovery.');
          this.writeOwned(binding, override);
          await this.command(['daemon-reload']);
        } catch (rollback) { throw new Error(`${errorMessage(error)} Recovery preparation could not be undone: ${errorMessage(rollback)}`); }
      }
      if (restarted) throw new Error(`The original service settings were restored, but the engine could not be verified: ${errorMessage(error)} Retry Straight shot after resolving the startup problem.`);
      throw error;
    }
  }
  private async change(binding: LocalRuntimeBinding, requested: LocalRuntimeSettings | null): Promise<LocalRuntimeSettings> {
    if (requested === null) {
      this.binding(binding);
      const unit = await this.unit(binding.unit);
      if (['inactive', 'failed'].includes(unit.state)) return this.recoverBaseline(binding, unit);
    }
    const before = await this.inspected(binding);
    const expected = requested ?? binding.baseline;
    const argv = requested ? runtimeProfileArgv(binding.baselineArgv, requested) : binding.baselineArgv;
    const contents = requested ? runtimeProfileOverride(binding, argv, requested) : null;
    if (equal(before.settings, expected) && before.override === contents) return before.settings;
    await this.idle(binding, before.settings);
    const boundary = await this.unit(binding.unit);
    this.assertFiles(binding, boundary);
    const boundaryProcess = this.processFor(boundary);
    if (boundary.pid !== before.unit.pid || !equal(boundaryProcess, before.current) ||
        this.file(this.owned(binding.unit)) !== before.override) throw new Error('The model service changed before the profile switch.');
    let changed = false;
    let restartAttempted = false;
    try {
      this.writeOwned(binding, contents);
      changed = true;
      await this.command(['daemon-reload']);
      await this.idle(binding, before.settings);
      const restart = await this.unit(binding.unit);
      this.assertFiles(binding, restart);
      if (restart.pid !== before.unit.pid || !equal(this.processFor(restart), before.current) ||
          this.file(this.owned(binding.unit)) !== contents) throw new Error('The model service changed during the profile switch.');
      restartAttempted = true;
      await this.command(['restart', binding.unit]);
      return await this.waitReady(binding, expected, argv, before.unit.pid);
    } catch (error) {
      if (!changed) throw error;
      try {
        if (this.file(this.owned(binding.unit)) !== contents) throw new Error('The profile override was edited by another process; it was left untouched.');
        const current = await this.unit(binding.unit);
        this.assertFiles(binding, current, true);
        if (!restartAttempted && current.pid === before.unit.pid && equal(this.processFor(current).argv, before.current.argv)) {
          // No process change occurred. Undo only our pending configuration even if new work
          // arrived; daemon-reload does not stop or restart the model serving that work.
          this.writeOwned(binding, before.override);
          await this.command(['daemon-reload']);
        } else {
          const busy = this.options.busy(binding.sourceId);
          if (busy) throw new Error(typeof busy === 'string' ? busy : 'New model work prevents rollback.');
          // A failed or starting replacement has no readable slots. A healthy process must still
          // be idle before rollback, so external users cannot be interrupted by a failed verify.
          if (current.state === 'active') {
            let healthy = false;
            try { healthy = (await this.probe(binding.endpoint, '/health') as { status?: unknown })?.status === 'ok'; }
            catch { /* A failed startup may have no healthy HTTP listener to inspect. */ }
            if (healthy) await this.idle(binding);
          }
          this.writeOwned(binding, before.override);
          await this.command(['daemon-reload']);
          await this.command(['restart', binding.unit]);
          await this.waitReady(binding, before.settings, before.current.argv, current.pid);
        }
      } catch (rollback) {
        throw new Error(`${errorMessage(error)} Rollback could not complete: ${errorMessage(rollback)}`);
      }
      throw new Error(`${errorMessage(error)} The previous engine settings were restored.`);
    }
  }
}
