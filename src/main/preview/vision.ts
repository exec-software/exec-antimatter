/**
 * Giving the model eyes.
 *
 * Qwen3-Coder-Next reads and writes code better than anything else we run, and cannot see. Asked
 * for a GIMP clone it will write the whole tkinter application, launch it, and then debug the
 * layout by reading its own source again — because that is the only sense it has. It reaches for
 * screenshots on its own; what it lacked was somewhere to send them.
 *
 * So the picture never enters the conversation. A tool takes it to a model that can see, asks the
 * question the coder wrote, and brings back a paragraph of text — which is a tool result like any
 * other. That keeps `Message.content` a string, keeps carbons and transcripts as they are, and
 * means the coder needs no vision of its own: it gets a colleague who has some.
 *
 * The request is built here and nowhere else, because vision support is a capability rather than
 * a model-name guess. beholdd v1 can proxy the multimodal array through to llama-server; native
 * beholdd v2 accepts text-only arrays but deliberately rejects `image_url` until it has a real
 * projector path. Loopback sources are selected first and run automatically. A configured remote
 * source remains a compatibility path, but the tool loop names its redacted destination and asks
 * for approval on every call before it reads the image or sends any pixels.
 */

/** What a look costs at most. Long enough for a real description, short enough to stay a step. */
const DEFAULT_MAX_TOKENS = 800;

/** A look that has not answered by now is not going to; the turn should not hang on it. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** A vision answer is hundreds of tokens, not an unbounded download into Electron's main process. */
export const MAX_VISION_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_VISION_ERROR_BYTES = 64 * 1024;

/**
 * What the seeing model is told it is for.
 *
 * Written for the coder on the other end rather than for a person: it is about to act on this,
 * so a missed detail is a wrong edit. Verbatim text matters most — a traceback in a terminal or a
 * label on a button is the answer, and a paraphrase of it is not.
 */
export const VISION_BRIEF = [
  'You are the eyes of a programmer who cannot see the screen and is about to change code based',
  'on what you say. Describe what is actually in the image, not what it ought to be.',
  '',
  'Read every piece of text you can make out, exactly as written — error messages, labels,',
  'menu items, paths, numbers. Say where things are in relation to each other, and give sizes',
  'and positions when they matter. Call out anything broken or wrong: overlapping widgets, a',
  'control off the edge, an empty area that should hold something, clipped text, a stack trace.',
  '',
  'If the image does not show what the question assumes, say so plainly rather than inventing it.',
  'If some text is too small or blurred to read, say that instead of guessing at it.',
].join('\n');

export interface VisionSource {
  /** The OpenAI-compatible base, up to and including /v1. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** A configured source, including the human-facing provider name used in an approval prompt. */
export interface ConfiguredVisionSource extends VisionSource {
  provider: string;
}

/** The only destination facts allowed into activities, approvals, and durable transcripts. */
export interface PublicVisionDestination {
  provider: string;
  model: string;
  baseUrl: string;
}

export interface LookRequest extends VisionSource {
  image: Buffer;
  /** `image/png` or `image/jpeg` — whatever the file actually is. */
  mediaType: string;
  /** What the caller wants to know. Empty asks for a plain description. */
  question: string;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A non-secret identity for an HTTP endpoint: no URL credentials, query tokens, or fragment. */
export function publicVisionEndpoint(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function publicVisionDestination(source: ConfiguredVisionSource): PublicVisionDestination {
  const baseUrl = publicVisionEndpoint(source.baseUrl);
  if (!baseUrl) throw new Error('A vision source must use an http or https URL.');
  const provider = source.provider.trim().slice(0, 240) || 'Unnamed source';
  const model = source.model.trim().slice(0, 240);
  if (!model) throw new Error('A vision source must name a model.');
  return { provider, model, baseUrl };
}

/** Whether a configured URL is a usable HTTP endpoint for vision transport. */
export function isVisionEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

/** The only URLs eligible to receive workspace pixels without a per-call approval prompt. */
export function isLoopbackVisionEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (!isVisionEndpoint(value)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '[::1]') return true;
    const octets = host.split('.');
    return (
      octets.length === 4 &&
      octets.every((octet) => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255) &&
      Number(octets[0]) === 127
    );
  } catch {
    return false;
  }
}

/**
 * The pixel-bearing endpoint for a source that has already crossed the tool-policy boundary.
 *
 * Query parameters are retained because some compatible servers require them, but fragments are
 * never sent. Embedded URL credentials are rejected even though the public identity redacts them:
 * secrets belong in `apiKey`, where they cannot be confused with the approved destination.
 */
function visionCompletionEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('The configured vision source is not a valid URL, so no image was sent.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The configured vision source must use http or https, so no image was sent.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('The configured vision source has URL credentials; move them to its API-key field. No image was sent.');
  }
  parsed.hash = '';
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/chat/completions`;
  return parsed.toString();
}

/**
 * The chat body for one look.
 *
 * Exported for its own sake: this shape is the whole integration, and it is worth being able to
 * assert on it without a server.
 */
export function lookBody(request: Omit<LookRequest, 'signal' | 'timeoutMs'>): Record<string, unknown> {
  const asked = request.question.trim() || 'Describe this image.';
  return {
    model: request.model,
    messages: [
      { role: 'system', content: VISION_BRIEF },
      {
        role: 'user',
        content: [
          { type: 'text', text: asked },
          {
            type: 'image_url',
            image_url: { url: `data:${request.mediaType};base64,${request.image.toString('base64')}` },
          },
        ],
      },
    ],
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: 0,
    stream: false,
  };
}

/** The answer out of an OpenAI-shaped reply, whichever of the places it is in. */
export function answerOf(payload: unknown): string {
  const choice = (
    payload as {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown }; text?: unknown }[];
    }
  )?.choices?.[0];
  if (!choice) return '';
  const content = choice.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  // Some servers answer a content-array request with a content array.
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'string' ? part : ((part as { text?: unknown })?.text ?? '')))
      .filter((part): part is string => typeof part === 'string')
      .join('')
      .trim();
    if (joined) return joined;
  }
  if (typeof choice.text === 'string' && choice.text.trim()) return choice.text.trim();
  // A reasoning model that spends its budget thinking answers with an empty `content` and a
  // full `reasoning_content`. It did look at the picture and it did say what it saw, so hand
  // that back rather than reporting an empty answer from a model that was not silent.
  const reasoning = choice.message?.reasoning_content;
  return typeof reasoning === 'string' ? reasoning.trim() : '';
}

/**
 * A server that could not start the model, as against one that looked and answered badly.
 *
 * Worth telling apart because they ask for opposite things. A poor answer is worth another look at
 * a smaller crop; a model that never loaded will not load for a second look either — the room it
 * needs does not appear because it was asked twice. Measured here: with a 90 GiB checkpoint
 * resident on a 96 GiB pool, the eyes could not load at all, and the turn spent two rounds finding
 * that out twice before giving up on its own.
 */
const NEVER_LOADED = /fail(?:ed|ure) to load|could not load|failed to start|no inference engine|out of memory|unknown model|no model registered/i;

/** The useful half of an OpenAI error envelope, for a message someone can act on. */
function failureText(status: number, body: string): string {
  try {
    const error = (JSON.parse(body) as { error?: { message?: string } | string })?.error;
    const message = typeof error === 'string' ? error : error?.message;
    if (message) return message.slice(0, 400);
  } catch {
    // Not JSON; the body itself is the best we have.
  }
  const trimmed = body.trim();
  return trimmed ? trimmed.slice(0, 400) : `HTTP ${status}`;
}

/**
 * Reads a fetch body with a decoded-byte ceiling and cancels the stream as soon as it crosses it.
 * `response.text()` and `response.json()` otherwise keep allocating until a peer stops sending.
 */
async function boundedResponseText(response: Response, limit: number, kind: string): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The vision server's ${kind} exceeded the ${Math.round(limit / 1024)} KiB response limit.`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`The vision server's ${kind} exceeded the ${Math.round(limit / 1024)} KiB response limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Ask the seeing model about one image.
 *
 * A server without a projector loaded answers this with an error rather than a description, and
 * that error is worth passing through verbatim: "this model does not support images" is the one
 * sentence that explains the whole failure, and summarising it would lose it.
 */
export async function look(request: LookRequest): Promise<string> {
  // This is the transport primitive. `withPreview` calls it only with the opaque source prepared
  // before policy; non-loopback use therefore reaches here only after this exact call is approved.
  const url = visionCompletionEndpoint(request.baseUrl);
  const publicEndpoint = publicVisionEndpoint(request.baseUrl) ?? 'the configured endpoint';
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const stopWithCaller = () => timeout.abort();
  request.signal?.addEventListener('abort', stopWithCaller, { once: true });

  try {
    const response = await fetch(url, {
      method: 'POST',
      // No endpoint may redirect this pixel-bearing POST to an unapproved Location.
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
      },
      body: JSON.stringify(lookBody(request)),
      signal: timeout.signal,
    });

    if (!response.ok) {
      const body = await boundedResponseText(response, MAX_VISION_ERROR_BYTES, 'error body');
      const why = failureText(response.status, body);
      throw new Error(
        `${request.model} could not look at it: ${why}` +
          (NEVER_LOADED.test(why)
            ? ' Nothing was seen: the server could not start the model, which is not a problem with the picture, ' +
              'and looking again will fail the same way. Say so and carry on without it.'
            : '')
      );
    }

    const body = await boundedResponseText(response, MAX_VISION_RESPONSE_BYTES, 'answer');
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`${request.model} returned an invalid JSON answer.`);
    }
    const answer = answerOf(payload);
    if (!answer) throw new Error(`${request.model} returned an empty answer.`);
    return answer;
  } catch (error) {
    if (timeout.signal.aborted && !request.signal?.aborted) {
      throw new Error(
        `${request.model} did not answer within ${Math.round((request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s. ` +
          'A large image on a cold model can take a while; try again, or ask about a smaller crop.'
      );
    }
    if (error instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(error.message)) {
      throw new Error(`Could not reach the seeing model at ${publicEndpoint}: the network request failed.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', stopWithCaller);
  }
}
