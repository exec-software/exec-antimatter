/** Limits hostile or broken HTTP peers without constraining streamed generation. */
export const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
export const MAX_PROVIDER_JSON_BYTES = 16 * 1024 * 1024;

export function redactProviderSecrets(text: string, ...secrets: Array<string | undefined>): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return safe;
}

/** A diagnostic destination without URL credentials, query tokens, or fragments. */
export function publicProviderEndpoint(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return 'the configured endpoint';
  }
}

export async function boundedResponseText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`response exceeded ${Math.round(limit / 1024)} KiB`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`response exceeded ${Math.round(limit / 1024)} KiB`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export async function boundedResponseJson(response: Response, limit = MAX_PROVIDER_JSON_BYTES): Promise<unknown> {
  return JSON.parse(await boundedResponseText(response, limit));
}
