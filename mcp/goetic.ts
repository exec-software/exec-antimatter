/**
 * The Goetic client, shared by the agent's tools (`mcp/tools/goetic.ts`) and the Goetic tool
 * window's IPC handlers (`src/main/goetic.ts`).
 *
 * Goetic is a work tracker that speaks a versioned machine API and authenticates callers as
 * agent identities rather than as people: the credential is a bearer token belonging to one
 * agent, scoped per board and per action, and revocable from Goetic's side. Antimatter holds
 * such a token and acts as itself. It never borrows a person's browser session, and it has no
 * way to mint, widen or rotate a credential — that is deliberately a browser-only operation in
 * Goetic, so a compromised agent cannot promote itself.
 *
 * Two properties are enforced here rather than left to callers:
 *
 * - **The token only goes to loopback over plain HTTP.** Goetic binds 127.0.0.1 and its preview
 *   has no TLS, so a plain-HTTP request to anything else would put a long-lived credential on
 *   the wire. https is allowed for a real deployment behind TLS termination.
 * - **The token is never returned to the renderer and never appears in a message.** The panel
 *   is told whether a token is configured, not what it is, and `describeError` rebuilds the
 *   message from the response rather than echoing the request.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface GoeticConfig {
  url: string;
  token: string;
}

/** What the renderer is allowed to know about the credential. */
export interface GoeticConfigView {
  url: string;
  configured: boolean;
  /** The token's identity segment only — it names the agent and proves nothing. */
  agentId: string | null;
  source: 'environment' | 'file' | 'unset';
}

export const DEFAULT_GOETIC_URL = 'http://127.0.0.1:3000';

/**
 * Resolved per call rather than once at import, so the path follows the process's actual home
 * directory instead of whatever it was when this module first loaded. That matters for a test
 * harness, and it costs nothing at runtime.
 */
const configPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.HOME || env.USERPROFILE || homedir(), '.antimatter', 'goetic.json');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const TOKEN_SHAPE = /^gta_[0-9a-f]{32}\.[0-9a-f]{64}$/;

function readConfigFile(env: NodeJS.ProcessEnv = process.env): Partial<GoeticConfig> {
  try {
    const parsed = JSON.parse(readFileSync(configPath(env), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const url = typeof parsed.url === 'string' ? parsed.url : undefined;
    const token = typeof parsed.token === 'string' ? parsed.token : undefined;
    return { url, token };
  } catch {
    return {};
  }
}

/**
 * The environment wins over the file, so an orchestrated or containerised run can be pointed at
 * a different workspace without rewriting a file the desktop also uses.
 */
export function goeticConfig(env: NodeJS.ProcessEnv = process.env): GoeticConfig & { source: GoeticConfigView['source'] } {
  const stored = readConfigFile(env);
  const envToken = env.GOETIC_TOKEN?.trim();
  const token = envToken || stored.token?.trim() || '';
  return {
    url: (env.GOETIC_URL?.trim() || stored.url?.trim() || DEFAULT_GOETIC_URL).replace(/\/+$/, ''),
    token,
    source: envToken ? 'environment' : token ? 'file' : 'unset',
  };
}

/** The agent identity a token names, or null. Parsing it reveals nothing the server did not. */
export function tokenAgentId(token: string): string | null {
  return TOKEN_SHAPE.test(token) ? token.slice(4, 36) : null;
}

export function goeticConfigView(env: NodeJS.ProcessEnv = process.env): GoeticConfigView {
  const config = goeticConfig(env);
  return {
    url: config.url,
    configured: Boolean(config.token),
    agentId: tokenAgentId(config.token),
    source: config.source,
  };
}

/**
 * Saves the credential 0600 in the user's own directory, written to a temporary file and renamed
 * so a crash cannot leave a half-written token behind. An empty token clears the credential
 * rather than storing a blank one.
 */
export function saveGoeticConfig(
  update: { url?: string; token?: string | null },
  env: NodeJS.ProcessEnv = process.env
): GoeticConfigView {
  const stored = readConfigFile(env);
  const url = (update.url ?? stored.url ?? DEFAULT_GOETIC_URL).trim().replace(/\/+$/, '');
  checkedBase(url);
  const token = update.token === undefined ? (stored.token ?? '') : (update.token ?? '').trim();
  if (token && !TOKEN_SHAPE.test(token)) {
    throw new Error('That is not a Goetic agent token. Expected gta_<32 hex>.<64 hex>, as Goetic prints it once at mint.');
  }
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ url, token }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return {
    url,
    configured: Boolean(token),
    agentId: tokenAgentId(token),
    source: token ? 'file' : 'unset',
  };
}

/** Refuses a base URL that would put a bearer token on the wire in clear. */
function checkedBase(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Goetic URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Goetic URL must be http or https, got ${url.protocol}`);
  }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new Error(
      `Refusing to send a Goetic agent token to ${url.hostname} over plain HTTP. ` +
        'Use a loopback address, or https for a deployment behind TLS termination.'
    );
  }
  return url;
}

export interface GoeticReply<T = any> {
  status: number;
  ok: boolean;
  body: T;
  /** Set when the server replayed a recorded response for our Idempotency-Key. */
  replayed: boolean;
}

export class GoeticError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'GoeticError';
  }
}

/** Goetic answers every failure in one shape; this turns it into a sentence worth reading. */
function describeError(status: number, body: any, path: string): GoeticError {
  const error = body && typeof body === 'object' ? body.error : undefined;
  if (error && typeof error.message === 'string') {
    return new GoeticError(error.message, status, String(error.code ?? 'error'));
  }
  if (status === 404) {
    return new GoeticError(
      `Goetic has no route ${path}. This Goetic may predate its machine API; GET /api/v1/meta reports the supported surface.`,
      status,
      'not_found'
    );
  }
  return new GoeticError(`Goetic answered ${status} for ${path}.`, status, 'error');
}

export interface GoeticCallOptions {
  /** Makes a repeated mutation replay one recorded response instead of acting twice. */
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export async function goeticCall<T = any>(
  method: string,
  path: string,
  body?: unknown,
  options: GoeticCallOptions = {}
): Promise<GoeticReply<T>> {
  const config = goeticConfig(options.env);
  if (!config.token) {
    throw new GoeticError(
      'No Goetic agent token is configured. Set GOETIC_TOKEN, or open the Goetic panel and paste the token ' +
        'Goetic printed when the identity was admitted. Antimatter cannot mint one: in Goetic that is a ' +
        'browser-only operation, on purpose.',
      401,
      'unconfigured'
    );
  }
  const base = checkedBase(config.url);
  const target = new URL(path.startsWith('/') ? path.slice(1) : path, `${base.origin}/`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new GoeticError(
      `Could not reach Goetic at ${base.origin}: ${reason}. Is it running? Goetic listens on loopback only.`,
      0,
      'unreachable'
    );
  }

  const text = await response.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GoeticError(
        `Goetic answered ${response.status} with a body that is not JSON. Is ${base.origin} really Goetic?`,
        response.status,
        'malformed_reply'
      );
    }
  }
  if (!response.ok) throw describeError(response.status, parsed, path);
  return {
    status: response.status,
    ok: true,
    body: parsed as T,
    replayed: response.headers.get('idempotency-replayed') === 'true',
  };
}

/**
 * A stable Idempotency-Key for one intended change.
 *
 * An agent that retries after a timeout must not create a second card, and it cannot know
 * whether the first attempt landed. Hashing the operation and its arguments means the retry
 * presents the same key and Goetic replays its own recorded answer. The key is derived, not
 * random, precisely so that a retry can reproduce it without having kept any state.
 */
export function idempotencyKey(operation: string, parts: unknown): string {
  const digest = createHash('sha256').update(`${operation}\u0000${JSON.stringify(parts)}`).digest('hex');
  return `antimatter-${operation}-${digest.slice(0, 32)}`;
}
