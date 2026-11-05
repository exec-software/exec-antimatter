import type { ProviderConfig } from '../api/types';

/**
 * Whether a source can be sent a turn yet.
 *
 * A striped llama.cpp host answers `/health` with `503 {"message":"Loading model"}` for as long
 * as it is pulling weights across the network — a quarter of an hour for a 237 GiB checkpoint
 * over two RPC peers — and only then with `{"status":"ok"}`. Sending during that window is not
 * merely futile: the request selects a slot, reaches for a peer that has not finished, and the
 * host aborts. The conversation goes with it, and the load starts again from nothing.
 *
 * So this exists to hold the composer shut, not to decorate it. Which means the states it does
 * *not* claim matter as much as the one it does.
 */

export type ReadinessState = 'ready' | 'startable' | 'loading' | 'unreachable' | 'unknown';

export interface SourceReadiness {
  state: ReadinessState;
  /** A server status or an actionable explanation from the app-owned startup lifecycle. */
  detail?: string;
}

/** A health answer is a status line and a short JSON object; anything larger is not one. */
const MAX_HEALTH_BYTES = 8 * 1024;
/** Long enough for a host busy reading weights off NVMe, short enough not to stall a poll. */
const DEFAULT_TIMEOUT_MS = 4_000;

/** `/health` sits at the server root, beside `/v1`, not under it. */
const healthEndpoint = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, '').replace(/\/v\d+$/, '')}/health`;

/**
 * Only llama.cpp's own phrasing counts as loading.
 *
 * A 503 on its own means "unavailable", which is also what a crashed worker, a reverse proxy with
 * no upstream, and a rate limiter all return. Blocking the whole window on any of those would trap
 * someone inside an app they opened specifically to go and fix the thing that is down.
 */
const LOADING = /loading model|model is loading|still loading/i;

async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_HEALTH_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return '';
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  // Cancel the reader directly: some fetch implementations lose abort propagation after
  // headers. Cleanup must not itself become an unbounded await in this polling path.
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HEALTH_BYTES) {
        cancel();
        return '';
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  signal.throwIfAborted();

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** The message a server put in an OpenAI-shaped error envelope, or the raw body if it used none. */
export function healthDetail(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } | string; message?: unknown };
    const error = parsed?.error;
    const message = typeof error === 'string' ? error : (error?.message ?? parsed?.message);
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 240);
  } catch {
    // Not JSON. The body itself is the best we have.
  }
  return trimmed.slice(0, 240);
}

/**
 * Classifies one `/health` answer.
 *
 * Exported for its own sake: the mapping from a status code to "may the person type" is the whole
 * of this feature's risk, and it is worth asserting on without a server.
 */
export function classifyHealth(status: number, body: string): SourceReadiness {
  const detail = healthDetail(body);

  // A source that does not serve /health at all — OpenAI, Anthropic, beholdd — must never be
  // treated as loading. `unknown` is what lets the gate default open for everything that is not
  // a llama.cpp host midway through a load.
  if (status === 404 || status === 405 || status === 501) return { state: 'unknown' };

  if (status === 503) {
    return LOADING.test(detail ?? '') ? { state: 'loading', ...(detail ? { detail } : {}) } : { state: 'unknown', ...(detail ? { detail } : {}) };
  }

  if (status >= 200 && status < 300) return { state: 'ready' };

  // 4xx and 5xx that are not the two above say something is wrong with the request or the server,
  // neither of which is a reason to take the window away from the person.
  return { state: 'unknown', ...(detail ? { detail } : {}) };
}

/**
 * Asks one source whether it is ready.
 *
 * Every failure mode resolves to a state rather than throwing: this is polled from the renderer on
 * a timer, and a rejected promise there would either spam the console or, worse, be caught into a
 * default that blocks the composer.
 */
export async function readSourceReadiness(
  source: Pick<ProviderConfig, 'baseUrl' | 'apiKey'>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<SourceReadiness> {
  let endpoint: string;
  try {
    endpoint = healthEndpoint(new URL(source.baseUrl).toString());
  } catch {
    return { state: 'unknown' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      redirect: 'error',
      headers: source.apiKey ? { Authorization: `Bearer ${source.apiKey}` } : undefined,
      signal: controller.signal,
    });
    return classifyHealth(response.status, await boundedText(response, controller.signal));
  } catch (error) {
    // A host that is still mapping a 237 GiB checkpoint can leave a connection unanswered, so a
    // timeout is not evidence of anything in particular. Refusal is: nothing is listening.
    const cause = error as Error & { cause?: { code?: string } };
    const code = cause?.cause?.code ?? '';
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET/.test(code)) return { state: 'unreachable' };
    return { state: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/** A failed health probe is eligible for first-request startup only through its actual owner. */
export async function readSourceWithStartup(
  source: Pick<ProviderConfig, 'baseUrl' | 'apiKey'>,
  startup: () => SourceReadiness | Promise<SourceReadiness>,
  read: typeof readSourceReadiness = readSourceReadiness,
): Promise<SourceReadiness> {
  const result = await read(source);
  if (result.state !== 'unreachable') return result;
  try { return await startup(); }
  catch (error) { return { state: 'unreachable', detail: error instanceof Error ? error.message : String(error) }; }
}
