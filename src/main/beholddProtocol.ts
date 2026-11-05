import type { NativeBeholddInfo } from '../api/beholdd';
import { redactProviderSecrets } from '../api/providers/httpBody';

const INFO_LIMIT_BYTES = 64 * 1024;
const INFO_TIMEOUT_MS = 1_000;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const names = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 32 && value.every((name) =>
    typeof name === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(name)
  ) && new Set(value).size === value.length;

/** A model-list envelope or a familiar port must never be mistaken for native capability evidence. */
export function parseNativeBeholddInfo(value: unknown): NativeBeholddInfo | null {
  const body = record(value);
  if (!body || body.schema_version !== 1 || body.service !== 'beholdd'
    || body.generation !== 2 || body.runtime !== 'native') {
    return null;
  }
  const operations = record(body.operations);
  if (!names(body.execution_backends) || !body.execution_backends.length
    || !names(body.architectures) || !names(body.model_formats)
    || !operations || typeof operations.unload !== 'boolean') {
    return null;
  }
  return {
    schema_version: 1,
    service: 'beholdd',
    generation: 2,
    runtime: 'native',
    execution_backends: [...body.execution_backends],
    architectures: [...body.architectures],
    model_formats: [...body.model_formats],
    operations: { unload: operations.unload },
  };
}

/** An alternate embedded runtime is explicitly unknown, never presumed native. */
function isUnknownRuntime(value: unknown): boolean {
  const body = record(value);
  const operations = record(body?.operations);
  return body?.schema_version === 1 && body.service === 'beholdd' && body.generation === 2
    && body.runtime === 'unknown' && names(body.execution_backends) && body.execution_backends.length === 0
    && names(body.architectures) && body.architectures.length === 0
    && names(body.model_formats) && body.model_formats.length === 0 && operations?.unload === false;
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > INFO_LIMIT_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Beholdd runtime information exceeds 64 KiB.');
  }
  if (!response.body) { throw new Error('Beholdd runtime information is empty.'); }
  const reader = response.body.getReader();
  // A fetch implementation may lose abort propagation after headers (observed with Node 22
  // under GC). Cancel the reader directly: this settles a pending read independently of fetch.
  // Transport cleanup is best effort and must not become another unbounded await.
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { break; }
      bytes += value.byteLength;
      if (bytes > INFO_LIMIT_BYTES) {
        cancel();
        throw new Error('Beholdd runtime information exceeds 64 KiB.');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Probe without loading a model. Null means an older endpoint. An explicitly unknown runtime,
 * malformed responses, and unavailable services are not permission to use legacy APIs.
 */
export async function probeNativeBeholdd(
  baseUrl: string,
  options: { apiKey?: string; timeoutMs?: number } = {},
): Promise<NativeBeholddInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? INFO_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/beholdd/info`, {
      method: 'GET',
      redirect: 'error',
      headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 501) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Beholdd runtime information returned HTTP ${response.status}.`);
    }
    const text = await boundedBody(response, controller.signal);
    let body: unknown;
    try { body = JSON.parse(text); }
    catch { throw new Error('Beholdd runtime information is not valid JSON.'); }
    const native = parseNativeBeholddInfo(body);
    if (native) { return native; }
    if (isUnknownRuntime(body)) {
      throw new Error('The server has not declared a native runtime or model-unload support.');
    }
    throw new Error('The source did not return a supported native Beholdd runtime descriptor.');
  } catch (error) {
    const message = controller.signal.aborted
      ? 'Beholdd runtime information did not answer in time.'
      : error instanceof Error ? error.message : String(error);
    throw new Error(redactProviderSecrets(message, options.apiKey));
  } finally {
    clearTimeout(timer);
  }
}
