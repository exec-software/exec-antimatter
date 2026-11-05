import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createHash } from 'node:crypto';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CREATE_ONLY_TOOL_ARGUMENT } from '../api/toolArguments';
import type { McpServerConfig } from './mcpStore';
import * as store from './mcpStore';
import * as editLock from './editLock';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
}

export interface McpServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  connecting: boolean;
  error: string | null;
  serverInfo: { name?: string; version?: string } | null;
  tools: McpTool[];
}

export interface McpConnectionError {
  serverId: string;
  serverName: string;
  message: string;
}

interface Session {
  client: Client;
  transport: StdioClientTransport;
  serverInfo: { name?: string; version?: string } | null;
  tools: McpTool[];
  workspace: string;
  closed: boolean;
  /** Captured at launch; a changed reviewed plugin definition cannot reuse this process. */
  managedIdentity: string | null;
  close(): Promise<void>;
}

const sessions = new Map<string, Session>();
/** Every managed process, including isolated runs and handshakes not yet in the global map. */
const managedTransports = new Map<Session, string>();
const connecting = new Set<string>();
const errors = new Map<string, string>();

export interface ManagedMcpServerConfig extends McpServerConfig { fingerprint?: string }
export const MANAGED_SERVER_PREFIX = 'plugin.';
let managedServers: () => readonly ManagedMcpServerConfig[] = () => [];

/** Derived from the explicitly reviewed extension registry, never persisted in mcpStore. */
export function configureManagedServers(provider: () => readonly ManagedMcpServerConfig[]): void {
  managedServers = provider;
}

const isManaged = (id: string): boolean => id.startsWith(MANAGED_SERVER_PREFIX);
const managedIdentity = (config: ManagedMcpServerConfig): string => createHash('sha256').update(JSON.stringify({
  command: config.command, args: config.args, env: Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  fingerprint: config.fingerprint ?? null,
})).digest('hex');

/** Re-read on every boundary. A corrupt/unreadable registry revokes access rather than using cache. */
function managedConfigurations(): ManagedMcpServerConfig[] {
  try {
    const result: ManagedMcpServerConfig[] = [];
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const config of managedServers()) {
      if (!config || typeof config.id !== 'string' || !/^plugin\.[A-Za-z0-9._-]+$/.test(config.id) ||
          typeof config.command !== 'string' || !config.command || config.command.includes('\0') ||
          typeof config.name !== 'string' || typeof config.enabled !== 'boolean' ||
          !Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
          (config.disabledTools !== undefined && (!Array.isArray(config.disabledTools) || config.disabledTools.some((name) => typeof name !== 'string'))) ||
          (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env) ||
            Object.entries(config.env).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0')))) ||
          (config.fingerprint !== undefined && typeof config.fingerprint !== 'string')) continue;
      if (seen.has(config.id)) { duplicates.add(config.id); continue; }
      seen.add(config.id);
      // A manifest can never claim the bundled-server environment or trust tier.
      result.push({ ...config, args: [...config.args], env: { ...config.env }, builtin: false });
    }
    return result.filter((config) => !duplicates.has(config.id));
  } catch (error) {
    console.error('[mcp] managed extension configuration unavailable:', error);
    return [];
  }
}

function configurations(): ManagedMcpServerConfig[] {
  // Reserve this namespace even when a legacy/user-authored store entry tries to claim it.
  return [...store.list().filter((config) => !isManaged(config.id)), ...managedConfigurations()];
}

function managedSessionAllowed(id: string, session: Session | undefined, toolName?: string): boolean {
  if (!isManaged(id)) return true;
  const current = managedConfigurations().find((config) => config.id === id && config.enabled);
  return !!current && !!session && !session.closed && session.managedIdentity === managedIdentity(current) &&
    !(toolName && current.disabledTools?.includes(toolName));
}

function assertManagedLaunch(config: ManagedMcpServerConfig): void {
  if (!isManaged(config.id)) return;
  const current = managedConfigurations().find((entry) => entry.id === config.id && entry.enabled);
  if (!current || managedIdentity(current) !== managedIdentity(config)) {
    throw new Error(`${config.name} was disabled or changed after review. Enable the reviewed plugin again before using it.`);
  }
}

const toolsOf = (config: McpServerConfig, session: Session | undefined): McpTool[] => {
  const disabled = new Set(config.disabledTools ?? []);
  return (session?.tools ?? []).map((tool) => ({ ...tool, enabled: !disabled.has(tool.name) }));
};

const statusFor = (config: McpServerConfig): McpServerStatus => {
  const candidate = sessions.get(config.id);
  const session = !candidate?.closed && managedSessionAllowed(config.id, candidate) ? candidate : undefined;
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    connected: !!session,
    connecting: connecting.has(config.id),
    error: errors.get(config.id) ?? null,
    serverInfo: session?.serverInfo ?? null,
    tools: toolsOf(config, session),
  };
};

export const statuses = (): McpServerStatus[] => configurations().map(statusFor);

export async function readTools(client: Pick<Client, 'listTools'>): Promise<McpTool[]> {
  const listedTools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }> = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const listed = await client.listTools(cursor ? { cursor } : undefined);
    listedTools.push(
      ...(listed.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
      }))
    );

    const next = listed.nextCursor;
    if (!next) break;
    if (seenCursors.has(next)) throw new Error(`MCP tools/list repeated cursor ${JSON.stringify(next)}.`);
    seenCursors.add(next);
    cursor = next;
  }

  return listedTools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    enabled: true,
  }));
}

/**
 * Our built-in server is the user's coding shell, so it needs the same SSH agent, proxies,
 * toolchains, virtual environments, and graphical session as the desktop app. Do not pass
 * launch-mode variables that would alter grandchildren, or Codex host-control variables that
 * belong to the process which happened to launch Antimatter during development.
 */
function builtinParentEnvironment(parent: NodeJS.ProcessEnv): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (name === 'ELECTRON_RUN_AS_NODE' || name.startsWith('ELECTRON_OVERRIDE')) continue;
    if (name.startsWith('CODEX_')) continue;
    inherited[name] = value;
  }
  return inherited;
}

/** Third-party servers get the SDK safe set; our own coding server gets the developer environment. */
export function childEnvironment(
  config: Pick<McpServerConfig, 'builtin' | 'env'>,
  workspace: string,
  parent: NodeJS.ProcessEnv = process.env,
  safe: Record<string, string> = getDefaultEnvironment()
): Record<string, string> {
  return {
    ...(config.builtin ? builtinParentEnvironment(parent) : safe),
    ...(config.env ?? {}),
    [store.WORKSPACE_ENV]: workspace,
    [store.ANTIMATTER_WORKSPACE_ENV]: workspace,
  };
}

function transportFor(config: McpServerConfig, workspace: string): StdioClientTransport {
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: childEnvironment(config, workspace),
    stderr: 'ignore',
  });
}

/** Opens one owned MCP session and closes every partial resource if initialization fails. */
async function openSession(
  config: McpServerConfig,
  workspace: string,
  signal?: AbortSignal,
  onUnexpectedClose?: (session: Session) => void
): Promise<Session> {
  assertManagedLaunch(config);
  if (signal?.aborted) throw new Error('the run was cancelled while connecting tools');
  const transport = transportFor(config, workspace);
  const client = new Client({ name: 'antimatter', version: '1.0.0' }, { capabilities: {} });
  let intentionalClose = false;
  let closeInFlight: Promise<void> | null = null;
  const session: Session = {
    client,
    transport,
    serverInfo: null,
    tools: [],
    workspace,
    closed: false,
    managedIdentity: isManaged(config.id) ? managedIdentity(config) : null,
    async close() {
      if (closeInFlight) return closeInFlight;
      intentionalClose = true;
      session.closed = true;
      closeInFlight = client.close().catch(() => {}).finally(() => managedTransports.delete(session));
      await closeInFlight;
    },
  };
  if (isManaged(config.id)) managedTransports.set(session, config.id);
  client.onclose = () => {
    session.closed = true;
    managedTransports.delete(session);
    if (!intentionalClose) onUnexpectedClose?.(session);
  };

  const cancel = () => void session.close();
  signal?.addEventListener('abort', cancel, { once: true });

  try {
    await client.connect(transport);
    if (signal?.aborted) throw new Error('the run was cancelled while connecting tools');
    if (session.closed) throw new Error(`${config.name} closed while connecting.`);
    assertManagedLaunch(config);
    const tools = await readTools(client);
    if (signal?.aborted) throw new Error('the run was cancelled while connecting tools');
    if (session.closed) throw new Error(`${config.name} closed while listing tools.`);
    assertManagedLaunch(config);
    session.serverInfo = (client.getServerVersion() as { name?: string; version?: string } | undefined) ?? null;
    session.tools = tools;
    return session;
  } catch (error) {
    await session.close();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export async function connect(id: string, workspaceOverride?: string): Promise<McpServerStatus> {
  const config = configurations().find((entry) => entry.id === id);
  if (!config) throw new Error(`No MCP server named ${id}`);
  const workspace = workspaceOverride ?? store.workspace();
  const existing = sessions.get(id);
  if (existing?.workspace === workspace && !existing.closed && managedSessionAllowed(id, existing)) return statusFor(config);
  if (existing) await disconnect(id);

  connecting.add(id);
  errors.delete(id);
  try {
    const session = await openSession(config, workspace, undefined, (closed) => {
      if (sessions.get(id) !== closed) return;
      sessions.delete(id);
      errors.set(id, `${config.name} closed unexpectedly.`);
    });
    if (session.closed) throw new Error(`${config.name} closed while connecting.`);
    sessions.set(id, session);
    return statusFor(config);
  } catch (error) {
    errors.set(id, (error as Error).message);
    return statusFor(config);
  } finally {
    connecting.delete(id);
  }
}

export async function disconnect(id: string): Promise<McpServerStatus | null> {
  const session = sessions.get(id);
  if (session) {
    sessions.delete(id);
    await session.close();
  }
  const config = configurations().find((entry) => entry.id === id);
  return config ? statusFor(config) : null;
}

/**
 * Connects all enabled configs. Kept separate from the store so the important invariant is
 * testable: existing sessions must still reach connect(), which owns workspace retargeting.
 */
export async function connectEnabledServers(
  configs: Pick<McpServerConfig, 'id' | 'enabled'>[],
  workspaceOverride: string | undefined,
  connectServer: (id: string, workspaceOverride?: string) => Promise<unknown>
): Promise<void> {
  await Promise.all(
    configs
      // connect() is deliberately idempotent for a matching workspace and reconnects for a
      // different one. Do not pre-filter existing sessions here: workspace leases call this
      // method specifically to retarget an already-connected stdio server before a run.
      .filter((config) => config.enabled)
      .map((config) => connectServer(config.id, workspaceOverride))
  );
}

/** Connects every enabled server, in parallel; failures land in each server's status. */
export async function connectEnabled(workspaceOverride?: string): Promise<McpServerStatus[]> {
  await reconcileManagedServers();
  await connectEnabledServers(configurations(), workspaceOverride, connect);
  return statuses();
}

export async function refresh(id: string): Promise<McpServerStatus | null> {
  const session = sessions.get(id);
  if (session && !managedSessionAllowed(id, session)) await disconnect(id);
  else if (session) session.tools = await readTools(session.client);
  const config = configurations().find((entry) => entry.id === id);
  return config ? statusFor(config) : null;
}

/** Called under the app's MCP-control lease after enabling, disabling, or reviewing plugins. */
export async function reconcileManagedServers(): Promise<void> {
  const revoked = new Set<Session>();
  for (const [session, id] of managedTransports) {
    if (!managedSessionAllowed(id, session)) revoked.add(session);
  }
  for (const [id, session] of sessions) {
    if (isManaged(id) && (revoked.has(session) || !managedSessionAllowed(id, session))) {
      sessions.delete(id);
      revoked.add(session);
    }
  }
  // Closing the transport also rejects a call already in flight. Revocation never waits for
  // the parent model to issue another request, and does not affect any bundled/user server.
  await Promise.all([...revoked].map((session) => session.close()));
}

export interface ToolCallResult {
  ok: boolean;
  text: string;
  raw?: unknown;
  /** False when no live transport existed, rather than a connected tool returning an error. */
  attempted?: boolean;
  /**
   * What this call put in front of the person, when it put anything there.
   *
   * Carried rather than described, because the transcript has to find it again: the Preview
   * section is rebuilt from the calls a conversation made, and a screenshot that took the
   * default path never mentioned that path in its arguments. Reading it back out of the
   * result's prose worked until the prose was reworded.
   */
  preview?: { kind: 'image' | 'page'; target: string; title: string; workspace?: string };
}

/** Tools that change a workspace file. Their calls hold the edit lock so a quit waits for them. */
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

interface ToolTransportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Internal precondition for a salvaged, truncated first write. Never advertised to a model. */
  createOnly?: boolean;
}

/** Adds app-private execution preconditions only on the bundled tool that understands them. */
export function toolArgumentsForTransport(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  createOnly = false
): Record<string, unknown> {
  return createOnly && serverId === store.BUILTIN_ID && toolName === 'write_file'
    ? { ...args, [CREATE_ONLY_TOOL_ARGUMENT]: true }
    : args;
}

type BuiltinToolHandler = (
  toolName: string,
  args: Record<string, unknown>,
  options?: ToolTransportOptions
) => Promise<string>;

/**
 * Calls to the built-in server that the app answers itself rather than round-tripping to the
 * child process.
 *
 * The recovery shell registers recovery_status/recovery_use here (src/main/recovery/wire.ts):
 * those tools are listed by the child so a model knows they exist, but their work — reporting on
 * and driving a state machine that lives in this process — has no counterpart in the child, so
 * the call is answered in-process. Anything else keeps the ordinary path.
 */
const builtinToolHandlers = new Map<string, BuiltinToolHandler>();

export function registerBuiltinTool(toolName: string, handler: BuiltinToolHandler): void {
  builtinToolHandlers.set(toolName, handler);
}

async function callSessionTool(
  session: Session | undefined,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  options?: ToolTransportOptions
): Promise<ToolCallResult> {
  if (!managedSessionAllowed(serverId, session, toolName)) {
    await session?.close();
    return { ok: false, text: `${serverId} was disabled or its reviewed configuration changed. Re-enable the reviewed plugin and start a new run.`, attempted: false };
  }
  const builtin = serverId === store.BUILTIN_ID ? builtinToolHandlers.get(toolName) : undefined;
  if (builtin) {
    try {
      return { ok: true, text: await builtin(toolName, args, options), attempted: true };
    } catch (error) {
      return { ok: false, text: (error as Error).message, attempted: true };
    }
  }
  // A dev reload can kill this process while the agent's own write is being applied: the edit
  // that changed the watched source file also named the reload, and the write's result dies with
  // the transport unless the quit waits for it. Hold the lock across the whole round trip — the
  // reply has to reach the tool loop, not just the disk, or the model retries into the same kill.
  const lease = WRITE_TOOLS.has(toolName) ? editLock.acquire() : null;
  try {
    if (!session || session.closed) return { ok: false, text: `${serverId} is not connected`, attempted: false };

    const timeout = options?.timeoutMs ?? 300_000;
    const transportedArgs = toolArgumentsForTransport(serverId, toolName, args, options?.createOnly);
    const result = await session.client.callTool(
      { name: toolName, arguments: transportedArgs },
      undefined,
      { signal: options?.signal, timeout, maxTotalTimeout: timeout }
    );
    // Tool results are content blocks; flatten the text ones for the model and the UI.
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((block: { type?: string; text?: string }) =>
        block?.type === 'text' ? (block.text ?? '') : `[${block?.type ?? 'unknown'} content]`
      )
      .join('\n')
      .trim();
    return {
      ok: !result.isError,
      text: text || (result.isError ? 'tool reported an error' : ''),
      raw: result,
      attempted: true,
    };
  } catch (error) {
    return { ok: false, text: (error as Error).message, attempted: true };
  } finally {
    lease?.release();
  }
}

export async function callTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  options?: ToolTransportOptions
): Promise<ToolCallResult> {
  return callSessionTool(sessions.get(serverId), serverId, toolName, args, options);
}

/** Every tool the model may use right now: enabled tools on connected, enabled servers. */
export function enabledTools(): { serverId: string; serverName: string; tool: McpTool }[] {
  return enabledToolsFrom(configurations(), sessions);
}

function enabledToolsFrom(
  configs: McpServerConfig[],
  source: Map<string, Session>
): { serverId: string; serverName: string; tool: McpTool }[] {
  return configs
    .filter((config) => config.enabled && managedSessionAllowed(config.id, source.get(config.id)))
    .flatMap((config) =>
      toolsOf(config, source.get(config.id)?.closed ? undefined : source.get(config.id))
        .filter((tool) => tool.enabled)
        .map((tool) => ({ serverId: config.id, serverName: config.name, tool }))
    );
}

/**
 * An isolated tool runtime for one chat/agent workspace. Each concurrent run owns its stdio
 * children, so configured orchestrator concurrency is real and no process can be retargeted by
 * a different run between tool calls.
 */
export interface WorkspaceRuntime {
  enabledTools(): { serverId: string; serverName: string; tool: McpTool }[];
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: ToolTransportOptions
  ): Promise<ToolCallResult>;
  connectionErrors(): McpConnectionError[];
  shutdown(): Promise<void>;
}

export async function createWorkspaceRuntime(workspace: string, signal?: AbortSignal): Promise<WorkspaceRuntime> {
  const configs = configurations().filter((config) => config.enabled);
  const local = new Map<string, Session>();
  const connectionErrors = new Map<string, McpConnectionError>();

  await Promise.all(
    configs.map(async (config) => {
      try {
        const session = await openSession(config, workspace, signal, (closedSession) => {
          if (local.get(config.id) !== closedSession) return;
          local.delete(config.id);
          connectionErrors.set(config.id, {
            serverId: config.id,
            serverName: config.name,
            message: `${config.name} closed unexpectedly.`,
          });
        });
        if (!session.closed) local.set(config.id, session);
      } catch (error) {
        if (!signal?.aborted) {
          const message = (error as Error).message;
          connectionErrors.set(config.id, { serverId: config.id, serverName: config.name, message });
          console.error(`[mcp] ${config.name} could not connect for ${workspace}:`, error);
        }
      }
    })
  );
  if (signal?.aborted) {
    await Promise.all([...local.values()].map((session) => session.close()));
    throw new Error('the run was cancelled while connecting tools');
  }

  let closed = false;
  return {
    enabledTools: () => (closed ? [] : enabledToolsFrom([
      ...configs.filter((config) => !isManaged(config.id)), ...managedConfigurations(),
    ], local)),
    connectionErrors: () => [...connectionErrors.values()],
    callTool: (serverId, toolName, args, options) =>
      closed
        ? Promise.resolve({ ok: false, text: `${serverId} is not connected`, attempted: false })
        : callSessionTool(local.get(serverId), serverId, toolName, args, options),
    async shutdown() {
      if (closed) return;
      closed = true;
      const open = [...local.values()];
      local.clear();
      await Promise.all(open.map((session) => session.close()));
    },
  };
}

export async function shutdown(): Promise<void> {
  const open = new Set([...sessions.values(), ...managedTransports.keys()]);
  sessions.clear();
  await Promise.all([...open].map((session) => session.close()));
}
