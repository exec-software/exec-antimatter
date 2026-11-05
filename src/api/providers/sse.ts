import type { LivenessCallback } from '../types';

export interface ServerSentEvent {
  event?: string;
  data: string;
}

function stoppedError(): Error {
  return new Error('the turn was stopped');
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * A small, dependency-free SSE reader shared by the native HTTP providers.
 *
 * It deliberately implements the wire details that matter to inference streams: arbitrary byte
 * boundaries (including inside UTF-8 characters), CRLF, multi-line data fields, comments used as
 * keepalives, and a final event whose terminating blank line was lost when the server closed.
 */
export async function* readServerSentEvents(
  response: Response,
  onAlive?: LivenessCallback,
  signal?: AbortSignal
): AsyncGenerator<ServerSentEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('the server returned no response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let reachedEof = false;

  const dispatch = (): ServerSentEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const event = { event: eventName, data: dataLines.join('\n') };
    eventName = undefined;
    dataLines = [];
    onAlive?.();
    return event;
  };

  const acceptLine = (rawLine: string): ServerSentEvent | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) return dispatch();
    if (line.startsWith(':')) {
      onAlive?.();
      return undefined;
    }

    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    return undefined;
  };

  try {
    while (true) {
      if (signal?.aborted) throw stoppedError();

      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw stoppedError();
        throw error;
      }
      if (signal?.aborted) throw stoppedError();

      if (part.done) {
        reachedEof = true;
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(part.value, { stream: true });
      }

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const event = acceptLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event) yield event;
        newline = buffer.indexOf('\n');
      }

      if (!part.done) continue;

      if (buffer) {
        const event = acceptLine(buffer);
        if (event) yield event;
        buffer = '';
      }
      const finalEvent = dispatch();
      if (finalEvent) yield finalEvent;
      return;
    }
  } finally {
    if (!reachedEof) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
