import { app } from 'electron';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from './privateState';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
  /** Tools switched off by hand; everything else on the server is offered to the model. */
  disabledTools?: string[];
  /** Ships with Antimatter, so its command and args are managed rather than user-edited. */
  builtin?: boolean;
  createdAt: number;
}

interface StoreFile {
  version: 1;
  servers: McpServerConfig[];
  /** Set once the built-in server has been introduced, so we only migrate a store once. */
  adoptedBuiltin?: boolean;
  /** Set once the media servers have been switched on, so a later deliberate off stays off. */
  enabledMedia?: boolean;
  /**
   * The working directory a person actually nominated.
   *
   * The tool servers always have *a* workspace — a leftover from last time, a default, or one
   * the orchestrator pointed them at for a run. None of those is the same as someone saying
   * "yes, edit files here", and the difference is not academic: a turn once rewrote this
   * repository's README because the tools were aimed at it and nobody had said so. Writes are
   * refused until this matches the workspace in use.
   */
  confirmedWorkspace?: string | null;
}

/** Servers an agent depends on, so they arrive switched on rather than looking broken. */
const MEDIA_SERVERS = new Set(['beholder.audio', 'beholder.image']);

const EMPTY: StoreFile = { version: 1, servers: [] };
let cache: StoreFile | null = null;

const storePath = () => join(app.getPath('userData'), 'mcp-servers.json');

/** Antimatter's own MCP server, built from mcp/ in this repository. */
export const BUILTIN_ID = 'antimatter';

/**
 * Spawn stdio servers through Electron's own binary in Node mode: no system Node needed,
 * and it keeps working inside a packaged build.
 */
export const nodeCommand = () => process.execPath;
export const nodeEnv = (extra?: Record<string, string>) => ({ ELECTRON_RUN_AS_NODE: '1', ...extra });

/** The variables our own server and the Beholder coding server read for the working tree. */
export const WORKSPACE_ENV = 'CODING_WORKSPACE_PATH';
export const ANTIMATTER_WORKSPACE_ENV = 'ANTIMATTER_WORKSPACE';

/**
 * Where the bundled server lives. In development that is dist-electron next to the sources;
 * in a packaged build it is unpacked beside the asar (see asarUnpack in package.json), because
 * a child process cannot be spawned from inside an archive.
 */
function builtinEntrypoint(): string {
  const base = app.isPackaged ? app.getAppPath().replace('app.asar', 'app.asar.unpacked') : app.getAppPath();
  return join(base, 'dist-electron', 'mcp', 'server.js');
}

export function builtinServer(workspace = homedir()): McpServerConfig {
  return {
    id: BUILTIN_ID,
    name: 'Antimatter tools',
    command: nodeCommand(),
    args: [builtinEntrypoint()],
    env: nodeEnv({ [ANTIMATTER_WORKSPACE_ENV]: workspace, [WORKSPACE_ENV]: workspace }),
    enabled: true,
    disabledTools: [],
    builtin: true,
    createdAt: Date.now(),
  };
}

/** First run: adopt the Beholder MCP servers already installed under ~/.beholder/mcp. */
export function discoverBeholderServers(): McpServerConfig[] {
  const beholderHome = join(homedir(), '.beholder');
  const root = join(beholderHome, 'mcp');
  if (!existsSync(root)) return [];

  const sharedEnv = {
    [WORKSPACE_ENV]: homedir(),
    [ANTIMATTER_WORKSPACE_ENV]: homedir(),
    NOTEBOOK_PATH: join(beholderHome, 'notebook'),
    MEMORY_PATH: join(beholderHome, 'memory'),
    BEHOLDER_IMAGE_OUTPUT_PATH: join(beholderHome, 'images'),
    BEHOLDER_AUDIO_OUTPUT_PATH: join(beholderHome, 'audio'),
  };

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, entrypoint: join(root, entry.name, 'dist', 'index.js') }))
    .filter(({ entrypoint }) => existsSync(entrypoint))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, entrypoint }) => ({
      id: name,
      name,
      command: nodeCommand(),
      args: [entrypoint],
      env: nodeEnv(sharedEnv),
      // Beholder servers are experimental and default to off; the built-in server is the
      // supported path. These two are the exception: the audio-producer and image-maker agents
      // exist only to call them, and an agent whose tools are switched off does not explain
      // itself — it fails at the first call looking like a broken agent.
      enabled: MEDIA_SERVERS.has(name),
      disabledTools: [],
      createdAt: Date.now(),
    }));
}

const read = (): StoreFile => {
  if (cache) return cache;
  const file = storePath();
  const ownsDirectory = migratePrivateDirectory(dirname(file));
  if (!existsSync(file)) {
    cache = { ...EMPTY, servers: [] };
    return cache;
  }
  if (ownsDirectory) migratePrivateFile(file);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoreFile;
    cache = parsed?.version === 1 && Array.isArray(parsed.servers) ? parsed : { ...EMPTY, servers: [] };
  } catch (error) {
    console.error('[mcp] unreadable server store, starting empty:', error);
    cache = { ...EMPTY, servers: [] };
  }
  return cache;
};

const write = (next: StoreFile) => {
  const file = storePath();
  writePrivateFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
};

export const list = (): McpServerConfig[] => read().servers;

export const save = (server: McpServerConfig): McpServerConfig => {
  const current = read();
  write({ ...current, servers: [...current.servers.filter((entry) => entry.id !== server.id), server] });
  return server;
};

export const remove = (id: string) => {
  const current = read();
  write({ ...current, servers: current.servers.filter((entry) => entry.id !== id) });
};

export const update = (id: string, patch: Partial<McpServerConfig>): McpServerConfig | null => {
  const existing = read().servers.find((entry) => entry.id === id);
  if (!existing) return null;
  return save({ ...existing, ...patch, id: existing.id });
};

export const workspace = (): string =>
  read().servers.find((server) => server.id === BUILTIN_ID)?.env?.[ANTIMATTER_WORKSPACE_ENV] ?? homedir();

/**
 * Points every server's file tools at `directory`. The value is read when a server is
 * spawned, so callers must reconnect for this to take effect.
 *
 * `confirmed` says whether a person chose this directory. Picking one in the composer is a
 * choice; the orchestrator aiming the tools at a workspace for an unattended run is not, and
 * must not silently license the next interactive turn to write there.
 */
export function setWorkspace(directory: string | null, confirmed = false): string {
  const next = directory || homedir();
  const current = read();
  write({
    ...current,
    confirmedWorkspace: confirmed ? next : (current.confirmedWorkspace ?? null),
    servers: current.servers.map((server) => ({
      ...server,
      env: { ...(server.env ?? {}), [WORKSPACE_ENV]: next, [ANTIMATTER_WORKSPACE_ENV]: next },
    })),
  });
  return next;
}

/** Records the current workspace as chosen, without moving it. */
export function confirmWorkspace(): string {
  const current = read();
  const here = workspace();
  write({ ...current, confirmedWorkspace: here });
  return here;
}

/** True when the directory the tools are pointed at is the one somebody nominated. */
export const workspaceConfirmed = (): boolean => {
  const stored = read().confirmedWorkspace;
  return !!stored && stored === workspace();
};

/**
 * Makes sure the store reflects what ships with this build: the built-in server is always
 * present with a current command and entrypoint, and anything installed on the machine is
 * adopted the first time we run. A user's enabled flag and per-tool choices are preserved.
 */
export function ensureSeeded(): McpServerConfig[] {
  const current = read();
  const firstRun = !existsSync(storePath());
  const servers = firstRun ? discoverBeholderServers() : [...current.servers];

  const existing = servers.find((server) => server.id === BUILTIN_ID);
  const fresh = builtinServer(workspace());
  const builtin: McpServerConfig = existing
    ? { ...existing, ...fresh, enabled: existing.enabled, disabledTools: existing.disabledTools ?? [], createdAt: existing.createdAt }
    : fresh;

  // One-time: when the built-in server arrives, the experimental Beholder servers step aside
  // rather than doubling every tool. They stay listed, and can be switched back on in Tools.
  const adopting = !current.adoptedBuiltin;
  // Once, for a store written before the media agents existed: switch their servers on. Tracked
  // separately from `adoptedBuiltin` so someone who turns one off afterwards keeps it off.
  const enablingMedia = !current.enabledMedia;
  const others = servers
    .filter((server) => server.id !== BUILTIN_ID)
    .map((server) => {
      if (enablingMedia && MEDIA_SERVERS.has(server.id)) return { ...server, enabled: true };
      return adopting ? { ...server, enabled: false } : server;
    });

  // Spread the current file: this rebuilds the server list, not the whole store, and dropping
  // confirmedWorkspace here would silently un-nominate the working directory on every launch.
  write({ ...current, version: 1, servers: [builtin, ...others], adoptedBuiltin: true, enabledMedia: true });
  return list();
}

export const storeLocation = () => storePath();
