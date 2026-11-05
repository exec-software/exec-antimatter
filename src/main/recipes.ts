import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { load } from 'js-yaml';

/**
 * Recipes: models that need more than this box, and bringing the rest of it up.
 *
 * A model that does not fit on one machine is not a different kind of model — it is the same
 * request with a precondition. MiMo's weights are 155 GiB against ~96 of local VRAM, so its
 * llama-server is started with `--rpc <peer>` and the layers are split. When that peer is not
 * listening the load fails several minutes in, and what reaches the person is HTTP 500 from the
 * local server: nothing in it says which of two machines was the problem, or that a machine was
 * involved at all.
 *
 * A recipe is the missing half of that: the models it applies to, and the peers they need. Before
 * a turn goes out on one of those models, each peer is probed, and one that is down is started if
 * the recipe says how.
 *
 * Nothing about any particular network lives in this file. Hosts, ports, unit names and the
 * command that starts a peer are read from the user's own configuration, for the same reason the
 * orchestration profiles beside them are: a topology is a fact about someone's machines, not
 * about Antimatter, and it has no business in a published repository. A checkout with no recipes
 * behaves exactly as it did before.
 *
 * `~/.antimatter/recipes/*.yaml`, one per recipe:
 *
 *     id: two-box
 *     name: MiMo across both boxes
 *     models: [mimo-v26-flash]
 *     peers:
 *       - name: the second box
 *         host: 192.0.2.10
 *         port: 50052
 *         start: ssh -o BatchMode=yes {host} systemctl --user start beholdd-rpc.service
 */

export interface RecipePeer {
  /** What this machine is called when Antimatter has to talk about it. */
  name: string;
  host: string;
  port: number;
  /**
   * What to run when the peer is not answering, or null to only report it.
   *
   * Comes from the configuration file and nowhere else — never from a model, a tool call or a
   * conversation. `{host}` and `{port}` are substituted; nothing else is interpolated, so the
   * command a person wrote is the command that runs.
   */
  start: string | null;
  /** How long to wait for the port after starting it. */
  startTimeoutMs: number;
}

export interface Recipe {
  id: string;
  name: string;
  /** Model ids this recipe applies to, compared case-insensitively. */
  models: string[];
  peers: RecipePeer[];
  path: string;
}

/** Long enough for a loaded box to accept a socket, short enough not to stall a turn. */
const PROBE_TIMEOUT_MS = 2_000;
/** Default wait for a peer to come up after being started. */
const DEFAULT_START_TIMEOUT_MS = 60_000;
/** Gap between polls while waiting for a started peer. */
const START_POLL_MS = 1_000;
/** A start command that has not returned by now is not going to. */
const START_COMMAND_TIMEOUT_MS = 30_000;

let root = join(homedir(), '.antimatter', 'recipes');

export const useRoot = (path: string): void => {
  root = path;
};

export const location = (): string => root;

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

/**
 * A host is used to build a command line, so it is held to what a host can actually look like.
 * This is not a guard against a hostile configuration — the file already names a command to run —
 * but against a typo in it becoming a second command.
 */
const isUsableHost = (value: string): boolean => /^[A-Za-z0-9._:\-[\]]+$/.test(value) && value.length <= 255;

const asPort = (value: unknown): number | null => {
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
};

function asPeers(value: unknown, path: string): RecipePeer[] {
  if (!Array.isArray(value)) return [];
  const peers: RecipePeer[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const host = asString(record.host);
    const port = asPort(record.port);
    if (!host || port === null) {
      console.error(`[recipes] ${path}: a peer needs a host and a port; skipping one that has neither.`);
      continue;
    }
    if (!isUsableHost(host)) {
      console.error(`[recipes] ${path}: "${host}" is not a usable host name; skipping that peer.`);
      continue;
    }
    const seconds = Number(record.startTimeoutSeconds);
    peers.push({
      name: asString(record.name, host),
      host,
      port,
      start: asString(record.start) || null,
      startTimeoutMs:
        Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 900) * 1000 : DEFAULT_START_TIMEOUT_MS,
    });
  }
  return peers;
}

function parse(path: string): Recipe | null {
  try {
    const raw = (load(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>;
    const id = asString(raw.id, basename(path).replace(/\.ya?ml$/, ''));
    if (!id) return null;
    const models = (Array.isArray(raw.models) ? raw.models : [])
      .map((model) => asString(model))
      .filter((model): model is string => !!model);
    const peers = asPeers(raw.peers, path);
    // A recipe that names no model can never be selected, and one with no peer asks for nothing.
    if (!models.length || !peers.length) return null;
    return { id, name: asString(raw.name, id), models, peers, path };
  } catch (error) {
    console.error(`[recipes] skipping ${path}:`, error);
    return null;
  }
}

export function list(): Recipe[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => parse(join(root, name)))
      .filter((recipe): recipe is Recipe => !!recipe)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error('[recipes] unreadable directory, continuing without recipes:', error);
    return [];
  }
}

/** The recipe covering a model id, or null when the model needs only this machine. */
export function forModel(modelId: string, recipes: Recipe[] = list()): Recipe | null {
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) return null;
  return recipes.find((recipe) => recipe.models.some((model) => model.toLowerCase() === wanted)) ?? null;
}

/**
 * Whether this machine is already talking to the peer.
 *
 * Asked before the probe below, because probing the shard this exists to manage does not just
 * give the wrong answer — it causes the wrong answer, permanently.
 *
 * `ggml-rpc-server` listens with a backlog of one. It accepts a single client into the program,
 * and the kernel will hold exactly one more connection pending behind it. A probe that connects
 * and hangs up does not give that slot back: an accepted-by-the-kernel connection stays in the
 * queue until the program takes it, and the program cannot, because it is inside its serve loop
 * for llama-server. From the second probe onwards every SYN to that port is dropped without a
 * reply — which is why probing a working shard times out rather than being refused.
 *
 * So the old code poisoned the port it was checking, once per turn, and then read its own damage
 * as the peer being down: it tried to start a machine that was already running, and told the
 * person the model would fail to load while the model was loaded and answering. Reproduced here
 * against a local shard — one abandoned probe, and every later connection timed out. (It clears
 * when the real client disconnects and the program drains the queue, so a restart is the cure.)
 *
 * An established socket from this box to that endpoint settles it without touching the port. It
 * is better evidence than a fresh connection could be: not merely that something is listening,
 * but that the thing we need it for is already happening.
 *
 * Linux only, by reading the kernel's socket tables — there is no portable way to ask this, and
 * nowhere else runs the RPC split. Anything unexpected reads as false, which is the old
 * behaviour: probe, and start it if the probe says nothing is there.
 */
export async function peerInUse(host: string, port: number): Promise<boolean> {
  try {
    const { address: first } = await lookup(host);
    const addresses = new Set([first]);
    const wanted = port.toString(16).toUpperCase().padStart(4, '0');

    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
      if (!existsSync(table)) continue;
      for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
        // sl local_address rem_address st …; `01` is ESTABLISHED.
        const [, , remote, state] = line.trim().split(/\s+/);
        if (state !== '01' || !remote) continue;
        const [remoteAddress, remotePort] = remote.split(':');
        if (remotePort?.toUpperCase() !== wanted) continue;
        if (addresses.has(decodeProcAddress(remoteAddress))) return true;
      }
    }
  } catch {
    // An unreadable table, a name that will not resolve: fall through to the probe.
  }
  return false;
}

/**
 * One address out of the kernel's socket table, as dotted quad, or '' for anything else.
 *
 * Each 32-bit word is written little-endian, so `DC0200C0` decodes to the example address 192.0.2.220.
 * IPv6 is decoded only in its IPv4-mapped form, which is what a v4 peer reached over a dual-stack
 * socket looks like; a native v6 address returns '' and the caller falls back to the probe.
 */
function decodeProcAddress(hex: string): string {
  const word = hex.length === 8 ? hex : hex.length === 32 && /^0{16}0000FFFF$/i.test(hex.slice(0, 24)) ? hex.slice(24) : '';
  if (!word) return '';
  return [6, 4, 2, 0].map((at) => parseInt(word.slice(at, at + 2), 16)).join('.');
}

/** Whether something is listening, which is all that can be asked of an RPC shard over TCP. */
export function peerAnswers(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answered: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answered);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** Runs a peer's start command through the user's shell, exactly as they wrote it. */
function runStartCommand(command: string, peer: RecipePeer): Promise<void> {
  const rendered = command.replaceAll('{host}', peer.host).replaceAll('{port}', String(peer.port));
  return new Promise((resolve, reject) => {
    execFile(
      process.env.SHELL || '/bin/sh',
      ['-c', rendered],
      { timeout: START_COMMAND_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        const detail = String(stderr || error.message).trim().split('\n').slice(0, 3).join('; ');
        reject(new Error(detail || 'the start command failed'));
      }
    );
  });
}

export interface PeerOutcome {
  peer: RecipePeer;
  /** True when the peer is listening now, whether it already was or was started. */
  ready: boolean;
  /** What happened, in a form that can be shown to a person. */
  detail: string;
  /** True when this call started it, so a turn can say why it waited. */
  started: boolean;
}

export interface EnsureOptions {
  /** Told about each step, so a waiting turn can say what it is waiting for. */
  onProgress?: (message: string) => void;
  probe?: (host: string, port: number) => Promise<boolean>;
  /** Asked before `probe`; see peerInUse for why a busy shard cannot answer one. */
  inUse?: (host: string, port: number) => Promise<boolean>;
  run?: (command: string, peer: RecipePeer) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Brings every peer a recipe names up, and reports on each.
 *
 * Never throws for a peer that will not start: the caller decides whether a turn can go ahead
 * without it. Some models will still answer from one box, more slowly, and refusing the turn
 * outright would be a worse outcome than a slow one.
 */
export async function ensurePeers(recipe: Recipe, options: EnsureOptions = {}): Promise<PeerOutcome[]> {
  const probe = options.probe ?? peerAnswers;
  const inUse = options.inUse ?? peerInUse;
  const run = options.run ?? runStartCommand;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const outcomes: PeerOutcome[] = [];

  for (const peer of recipe.peers) {
    const where = `${peer.name} (${peer.host}:${peer.port})`;
    // Already attached beats listening: a shard serving this machine is the state the recipe is
    // trying to reach, and it is the one state a probe cannot see — nor safely ask. See peerInUse.
    if (await inUse(peer.host, peer.port)) {
      outcomes.push({ peer, ready: true, started: false, detail: `${where} is already serving this machine.` });
      continue;
    }
    if (await probe(peer.host, peer.port)) {
      outcomes.push({ peer, ready: true, started: false, detail: `${where} is already listening.` });
      continue;
    }
    if (!peer.start) {
      outcomes.push({
        peer,
        ready: false,
        started: false,
        detail: `${where} is not listening, and this recipe does not say how to start it.`,
      });
      continue;
    }

    options.onProgress?.(`Starting ${where}`);
    try {
      await run(peer.start, peer);
    } catch (error) {
      outcomes.push({
        peer,
        ready: false,
        started: false,
        detail: `${where} could not be started: ${(error as Error).message}`,
      });
      continue;
    }

    const deadline = now() + peer.startTimeoutMs;
    let ready = false;
    while (now() < deadline) {
      if (await probe(peer.host, peer.port)) {
        ready = true;
        break;
      }
      await sleep(START_POLL_MS);
    }
    outcomes.push({
      peer,
      ready,
      started: true,
      detail: ready
        ? `${where} was started and is listening.`
        : `${where} was started but did not answer within ${Math.round(peer.startTimeoutMs / 1000)}s.`,
    });
  }

  return outcomes;
}

/** One line for the carbon and the turn, or null when every peer was already up. */
export function summarize(recipe: Recipe, outcomes: PeerOutcome[]): string | null {
  const missing = outcomes.filter((outcome) => !outcome.ready);
  const started = outcomes.filter((outcome) => outcome.started && outcome.ready);
  if (missing.length) {
    return (
      `${recipe.name} needs ${outcomes.length === 1 ? 'another machine' : `${outcomes.length} machines`}, and ` +
      `${missing.length} of them ${missing.length === 1 ? 'is' : 'are'} not ready: ` +
      `${missing.map((outcome) => outcome.detail).join(' ')} ` +
      `A model that does not fit on one box will fail to load without ${missing.length === 1 ? 'it' : 'them'}.`
    );
  }
  if (started.length) {
    return `${recipe.name}: ${started.map((outcome) => outcome.detail).join(' ')}`;
  }
  return null;
}
