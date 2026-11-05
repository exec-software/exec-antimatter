import type { Model, WireProtocol } from '../api/types';
import { redactProviderSecrets } from '../api/providers/httpBody';

export interface ProbedModel extends Model {
  /** beholdd reports whether a model is currently resident; other servers omit it. */
  loaded?: boolean;
  /**
   * Whether this model can be shown a picture.
   *
   * llama.cpp says so in two places and neither is guaranteed: `capabilities` on the model entry
   * lists "vision" once a projector is loaded, and `/props` reports `modalities.vision`. Undefined
   * means the server did not say, which is not the same as "no" — beholdd v1 proxies the model
   * list from llama-server but serves neither field itself.
   */
  vision?: boolean;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  models: ProbedModel[];
  error?: string;
}

/**
 * Obvious non-conversation products returned by OpenAI's account-wide `/models` catalog.
 *
 * This is intentionally only a discovery filter, never a validation rule. A gateway may expose a
 * custom Responses-capable model under any id, and the Library's explicit declaration flow must
 * remain the escape hatch. We reject only strong modality/API-family signals so future general
 * reasoning model names continue to appear without an Antimatter release.
 */
const OPENAI_RESPONSES_NON_CONVERSATION_IDS = [
  /(?:^|[-_.])embedding(?:s)?(?:[-_.]|$)/i,
  /^(?:text|code)-(?:search|similarity)-/i,
  /^(?:omni|text)-moderation(?:-|$)/i,
  /^(?:dall-e|gpt-image|chatgpt-image|sora)(?:-|$)/i,
  /^whisper(?:-|$)/i,
  /(?:^|[-_.])audio(?:[-_.]|$)/i,
  /(?:^|[-_.])transcri(?:be|ption)(?:[-_.]|$)/i,
  /(?:^|[-_.])tts(?:[-_.]|$)/i,
  /(?:^|[-_.])realtime(?:[-_.]|$)/i,
  /^(?:babbage|davinci)-002$/i,
];

export function discoverableConversationModel(modelId: string, protocol: WireProtocol): boolean {
  if (protocol !== 'openai-responses') return true;
  return !OPENAI_RESPONSES_NON_CONVERSATION_IDS.some((pattern) => pattern.test(modelId));
}

/** Applies connector eligibility without mutating the truthful catalog returned by the caller. */
export function discoverableConversationModels<T extends Model>(protocol: WireProtocol, models: T[]): T[] {
  return models.filter((model) => discoverableConversationModel(model.id, protocol));
}

/**
 * The durable part of a model observation.
 *
 * `loaded` is a point-in-time server status and must not become source configuration. Discovered
 * context and capability metadata follow later server observations, including an explicit
 * `vision: false` (which is stronger than not saying). A value explicitly curated in the Model
 * Library is the exception: refreshes must not silently replace the user's declared contract.
 * Execution caps are separate server facts: explicit numbers or null replace them regardless
 * of a curated context window. Omission is an incomplete observation and retains the prior cap.
 */
export function persistedModel(model: ProbedModel, previous?: Model): Model {
  // `manuallyDeclared` predates the explicit provenance flags in development stores. Treat only
  // values actually present on those legacy declarations as curated; an omitted field may still
  // be learned from discovery.
  const contextCurated =
    previous?.contextWindowCurated === true ||
    (previous?.manuallyDeclared === true && previous.contextWindow !== undefined);
  const visionCurated =
    previous?.visionCurated === true || (previous?.manuallyDeclared === true && previous.vision !== undefined);
  const contextWindow = contextCurated ? previous?.contextWindow : (model.contextWindow ?? previous?.contextWindow);
  const maxEvaluatedTokens = model.maxEvaluatedTokens === undefined
    ? previous?.maxEvaluatedTokens
    : model.maxEvaluatedTokens;
  const vision = visionCurated ? previous?.vision : (model.vision ?? previous?.vision);
  return {
    id: model.id,
    name: previous?.name ?? model.name,
    ...(previous?.architecture !== undefined ? { architecture: previous.architecture } : {}),
    ...(previous?.quantization !== undefined ? { quantization: previous.quantization } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxEvaluatedTokens !== undefined ? { maxEvaluatedTokens } : {}),
    ...(vision !== undefined ? { vision } : {}),
    ...(previous?.manuallyDeclared !== undefined ? { manuallyDeclared: previous.manuallyDeclared } : {}),
    ...(previous?.nameCurated ? { nameCurated: true } : {}),
    ...(previous?.deployment !== undefined ? { deployment: previous.deployment } : {}),
    ...(previous?.hidden !== undefined ? { hidden: previous.hidden } : {}),
    ...(contextCurated ? { contextWindowCurated: true } : {}),
    ...(visionCurated ? { visionCurated: true } : {}),
  };
}

/**
 * Add models newly observed on a source, refresh durable metadata on IDs already configured, and
 * drop discovered IDs the source has stopped listing.
 *
 * Adoption used to be purely additive, so that a starting or curated server could not empty the
 * user's picker. The cost of never removing anything was a picker that accumulated ids which had
 * once been listed and were no longer servable. beholdd reports its *loaded engine* alongside its
 * configured models, so probing while a model happened to be loaded adopted that engine's alias —
 * `MiMo-V2.6-Flash-RL-MXFP4` beside the real `mimo-v26-flash` — and the alias then stayed in the
 * catalog forever, selectable, pinnable and remembered across restarts, while resolving on the
 * server only for as long as that engine stayed up. Picking it later produced a turn the source
 * could not serve; on a server with a default model it produced something worse, an answer from a
 * different model under the chosen model's name.
 *
 * For an OpenAI-compatible source the model list *is* the catalog: an id it does not list is an id
 * it will not serve. So a previously discovered id that is absent from a successful observation is
 * removed. Two things are never removed — a model the user declared by hand, which is precisely the
 * case of a server that serves more than it advertises, and everything at all when the observation
 * is empty, since one odd answer should not empty a picker. Both callers additionally require the
 * probe to have succeeded before any of this runs.
 */
export function mergeProbedModels(configured: Model[], observed: ProbedModel[]): Model[] {
  const byId = new Map(observed.map((model) => [model.id, model]));
  const known = new Set(configured.map((model) => model.id));
  // An empty observation is not evidence that the catalog is empty.
  const prunable = observed.length > 0;
  /**
   * Anything the user put work into stays, whether or not the source still lists it: a model they
   * declared by hand, and one whose window or vision flag they corrected in the Library. Removing
   * those would throw away something the probe cannot reconstruct, and a source that briefly lists
   * less than usual would silently undo their edits. An id that was only ever adopted from a
   * listing carries nothing that is not in the next listing, so it is safe to drop and comes
   * straight back if the source lists it again.
   */
  const invested = (model: Model): boolean =>
    model.manuallyDeclared === true || model.contextWindowCurated === true || model.visionCurated === true ||
    model.nameCurated === true || model.deployment !== undefined || model.hidden === true;
  const stale = (model: Model): boolean => prunable && !invested(model) && !byId.has(model.id);
  let changed = configured.some(stale);
  const models = configured.filter((model) => !stale(model)).map((model) => {
    const probe = byId.get(model.id);
    if (!probe) return model;
    const merged = persistedModel(probe, model);
    if (
      merged.name === model.name &&
      merged.architecture === model.architecture &&
      merged.quantization === model.quantization &&
      merged.contextWindow === model.contextWindow &&
      merged.maxEvaluatedTokens === model.maxEvaluatedTokens &&
      merged.vision === model.vision &&
      merged.manuallyDeclared === model.manuallyDeclared &&
      merged.nameCurated === model.nameCurated &&
      merged.deployment === model.deployment &&
      merged.hidden === model.hidden &&
      merged.contextWindowCurated === model.contextWindowCurated &&
      merged.visionCurated === model.visionCurated
    ) {
      return model;
    }
    changed = true;
    return merged;
  });

  for (const model of observed) {
    if (known.has(model.id)) continue;
    known.add(model.id);
    models.push(persistedModel(model));
    changed = true;
  }
  return changed ? models : configured;
}

const withoutTrailingSlashes = (value: string) => value.replace(/\/+$/, '');
const MAX_DISCOVERY_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_DISCOVERY_PAGES = 20;
const MAX_DISCOVERED_MODELS = 20_000;
const WIRE_PROTOCOLS = new Set<WireProtocol>(['openai-chat', 'openai-responses', 'anthropic-messages']);

async function boundedResponseText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`model catalog response exceeded ${Math.round(limit / 1024 / 1024)} MiB`);
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
        throw new Error(`model catalog response exceeded ${Math.round(limit / 1024 / 1024)} MiB`);
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

/**
 * Fields servers use to report a model's context window. There is no standard one: beholdd v1
 * says `ctx_size`, llama.cpp `n_ctx`, vLLM `max_model_len`, and several others `context_length`.
 * Whatever comes back is the authority for discovered metadata, so it beats every guess
 * Antimatter could make from the model's name. An explicit Model Library override is preserved
 * separately by `persistedModel`.
 */
const CONTEXT_FIELDS = [
  'ctx_size',
  'context_length',
  'max_context_length',
  'max_model_len',
  'max_input_tokens',
  'n_ctx',
  'context_window',
];

/** `capabilities: ["completion", "vision"]` on a llama.cpp model entry, when it says at all. */
function reportedVision(entry: Record<string, unknown>): boolean | undefined {
  const capabilities = entry.capabilities;
  if (!Array.isArray(capabilities)) return undefined;
  return capabilities.some((capability) => typeof capability === 'string' && capability.toLowerCase() === 'vision');
}

function reportedContext(entry: Record<string, unknown>): number | undefined {
  for (const field of CONTEXT_FIELDS) {
    const value = entry[field];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
    // Some servers answer with the number as a string.
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  }
  return undefined;
}

/** A fixed execution cap is not a model context guess and must never be coerced or rounded. */
function reportedMaxEvaluatedTokens(entry: Record<string, unknown>): number | null | undefined {
  const limits = entry.execution_limits;
  if (limits === undefined) return undefined;
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new Error('invalid model execution_limits: expected an object');
  }
  const value = (limits as Record<string, unknown>).max_evaluated_tokens;
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('invalid model execution_limits.max_evaluated_tokens: expected a positive safe integer or null');
  }
  return value;
}

/**
 * Asks a source what it is serving. All supported connectors expose `GET {baseUrl}/models`, but
 * Anthropic authenticates that request with its own header and API-version contract.
 */
export async function probeSource(
  baseUrl: string,
  apiKey?: string,
  protocol: WireProtocol = 'openai-chat',
  timeoutMs = 6000
): Promise<ProbeResult> {
  const started = Date.now();
  if (!WIRE_PROTOCOLS.has(protocol)) {
    return {
      ok: false,
      latencyMs: 0,
      models: [],
      error: `unsupported inference wire protocol: ${String(protocol)}`,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const endpoint = `${withoutTrailingSlashes(baseUrl)}/models`;
    const entries: Record<string, unknown>[] = [];
    let next: string | null = endpoint;
    let pages = 0;
    while (next) {
      const response = await fetch(next, {
        redirect: 'error',
        headers:
          protocol === 'anthropic-messages'
            ? {
                ...(apiKey ? { 'X-Api-Key': apiKey } : {}),
                'anthropic-version': '2023-06-01',
              }
            : apiKey
              ? { Authorization: `Bearer ${apiKey}` }
              : undefined,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const statusText = redactProviderSecrets(response.statusText, apiKey);
        return { ok: false, latencyMs, models: [], error: `${response.status} ${statusText}` };
      }

      let body: unknown;
      try {
        body = JSON.parse(await boundedResponseText(response, MAX_DISCOVERY_PAGE_BYTES));
      } catch (error) {
        return {
          ok: false,
          latencyMs,
          models: [],
          error: `invalid model catalog response: ${(error as Error).message}`,
        };
      }
      if (!body || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data)) {
        return { ok: false, latencyMs, models: [], error: 'invalid model catalog response' };
      }

      const page = body as { data: unknown[]; has_more?: unknown; last_id?: unknown };
      const records = page.data.filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
      );
      entries.push(...records.slice(0, Math.max(0, MAX_DISCOVERED_MODELS - entries.length)));
      pages += 1;

      if (
        protocol !== 'anthropic-messages' ||
        page.has_more !== true ||
        typeof page.last_id !== 'string' ||
        !page.last_id ||
        pages >= MAX_DISCOVERY_PAGES ||
        entries.length >= MAX_DISCOVERED_MODELS
      ) {
        next = null;
      } else {
        const pageUrl = new URL(endpoint);
        pageUrl.searchParams.set('after_id', page.last_id);
        next = pageUrl.toString();
      }
    }

    const catalog = entries
      .map((entry) => ({
        id: String(entry.id ?? ''),
        name: typeof entry.display_name === 'string' ? entry.display_name : undefined,
        loaded: typeof entry.loaded === 'boolean' ? entry.loaded : undefined,
        contextWindow: reportedContext(entry),
        maxEvaluatedTokens: reportedMaxEvaluatedTokens(entry),
        vision: reportedVision(entry),
      }))
      .filter((entry) => entry.id)
      .map((entry) => ({
        id: entry.id,
        name: entry.name || entry.id,
        loaded: entry.loaded,
        contextWindow: entry.contextWindow,
        ...(entry.maxEvaluatedTokens !== undefined ? { maxEvaluatedTokens: entry.maxEvaluatedTokens } : {}),
        vision: entry.vision,
      }));
    const models = discoverableConversationModels(protocol, catalog);

    return { ok: true, latencyMs: Date.now() - started, models };
  } catch (error) {
    const message = (error as Error).name === 'AbortError' ? `no answer within ${timeoutMs} ms` : (error as Error).message;
    return { ok: false, latencyMs: Date.now() - started, models: [], error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the model a source has loaded can be shown a picture, asked of the server itself.
 *
 * llama.cpp answers `GET /props` with `modalities.vision`, which is the only honest answer to
 * "can this see" — it is true exactly when a projector was loaded, so it follows the running
 * process rather than a guess from the model's name. The endpoint sits at the server root, not
 * under /v1, and a source that does not serve it (beholdd, Ollama, OpenAI) reports undefined
 * rather than false: not knowing is not the same as knowing it cannot.
 */
export async function probeVision(baseUrl: string, apiKey?: string, timeoutMs = 4000): Promise<boolean | undefined> {
  const root = withoutTrailingSlashes(baseUrl).replace(/\/v\d+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${root}/props`, {
      redirect: 'error',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { modalities?: { vision?: unknown } };
    const vision = body?.modalities?.vision;
    return typeof vision === 'boolean' ? vision : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
