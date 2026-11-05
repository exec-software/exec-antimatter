import { redactProviderSecrets } from '../api/providers/httpBody';
import { probeNativeBeholdd } from './beholddProtocol';
import type { SourceKind } from './sourceStore';

/**
 * What a local engine is holding in memory, and putting it down again.
 *
 * Models load lazily and stay loaded. That is the right default — the alternative is paying the
 * load again on every turn — but it means a box with one card fills up with whatever has been
 * tried since the server started, and the only way back was to stop the server, which takes the
 * conversation, the agents and anything else pointed at it with it.
 *
 * Only some sources can answer this. A llama-server process is one model by construction and
 * ends when the process does; a hosted API has no memory of yours to free. Rather than guess,
 * a source that cannot say so reports `supported: false` and the Library simply does not offer
 * it — an Unload button that quietly does nothing is worse than no button.
 */

export type ResidencyState = 'live' | 'dead' | 'absent';

export interface ResidentModel {
  id: string;
  state: ResidencyState;
  /** Why a worker counts as dead, in the server's own words. */
  detail?: string;
  /** Host RSS. For a GPU-offloaded model the weights are in device memory and this is small. */
  hostBytes?: number;
  /**
   * Turns currently answering on this model, added by the main process rather than the server.
   * Only it can see them: an agent's turn and a paired phone's turn have no window of their own.
   */
  turns?: number;
}

export interface SourceResidency {
  sourceId: string;
  /** False when this kind of source has no notion of a resident model to report. */
  supported: boolean;
  /** Residency reporting alone does not promise an unload operation. */
  canUnload: boolean;
  unloadUnavailableReason?: string;
  /** Native runtimes refuse unloading during execution instead of terminating a worker. */
  unloadRequiresIdle?: boolean;
  models: ResidentModel[];
  /**
   * Device memory in use, as the server reports it for the whole card rather than per model.
   * Attributing it to one model would be a guess wearing a number's clothes.
   */
  vramBytes?: number;
  /** Set when the source could not be reached or answered with something unexpected. */
  error?: string;
}

/** Long enough for a busy engine to answer, short enough that the page does not sit blank. */
const LIST_TIMEOUT_MS = 6_000;
/** Stopping a worker and waiting for it to actually go can take longer than a read. */
const UNLOAD_TIMEOUT_MS = 30_000;
/** A server with thousands of entries is a misconfiguration, not a memory report. */
const MAX_ENTRIES = 2_000;

/** Sources that keep models resident across requests and can be asked about it. */
export const reportsResidency = (kind?: SourceKind): boolean => kind === 'beholdd' || kind === 'ollama';

const trimSlashes = (value: string): string => value.replace(/\/+$/, '');

/** Ollama's native API sits at the origin root, beside the `/v1` OpenAI compatibility layer. */
const ollamaEndpoint = (baseUrl: string, path: string): string => new URL(path, baseUrl).toString();

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
        .slice(0, MAX_ENTRIES)
    : [];

async function json(
  url: string,
  init: { apiKey?: string; method?: 'GET' | 'POST'; body?: unknown; timeoutMs: number }
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      redirect: 'error',
      headers: {
        ...(init.apiKey ? { Authorization: `Bearer ${init.apiKey}` } : {}),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        redactProviderSecrets(`${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 240)}` : ''}`, init.apiKey)
      );
    }
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

const reachError = (error: unknown, apiKey?: string): string => {
  const cause = error as Error;
  const message = cause?.name === 'AbortError' ? 'the source did not answer in time' : cause?.message || String(error);
  return redactProviderSecrets(message, apiKey);
};

/**
 * beholdd reports residency on its ordinary model list: `live` when a worker answered, `dead`
 * when one was started and is not answering, `absent` when nothing was started. The middle one
 * is the interesting case and the reason this exists — a dead worker still holds its slot.
 */
function beholddResidency(sourceId: string, body: unknown): SourceResidency {
  const page = (body ?? {}) as { data?: unknown; memory?: unknown };
  const memory = (page.memory ?? {}) as Record<string, unknown>;
  const models: ResidentModel[] = [];
  for (const entry of records(page.data)) {
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!id) continue;
    const label = entry.residency;
    const state: ResidencyState =
      label === 'live' || label === 'dead' || label === 'absent'
        ? label
        : // Older beholdd builds report only the boolean.
          entry.loaded === true
          ? 'live'
          : 'absent';
    if (state === 'absent') continue;
    models.push({
      id,
      state,
      ...(typeof entry.residency_detail === 'string' && entry.residency_detail
        ? { detail: entry.residency_detail }
        : {}),
      ...(positive(entry.host_rss_bytes) !== undefined ? { hostBytes: positive(entry.host_rss_bytes)! } : {}),
    });
  }
  return {
    sourceId,
    supported: true,
    canUnload: false,
    models,
    ...(positive(memory.vram_used_bytes) !== undefined ? { vramBytes: positive(memory.vram_used_bytes)! } : {}),
  };
}

/** Ollama lists what it is holding at `/api/ps`, separately from the catalog at `/api/tags`. */
function ollamaResidency(sourceId: string, body: unknown): SourceResidency {
  const page = (body ?? {}) as { models?: unknown };
  const models: ResidentModel[] = [];
  let vram = 0;
  for (const entry of records(page.models)) {
    const id = typeof entry.model === 'string' ? entry.model : typeof entry.name === 'string' ? entry.name : '';
    if (!id) continue;
    // `/api/ps` lists only what is loaded, so everything here is live by construction.
    const size = positive(entry.size);
    const device = positive(entry.size_vram);
    if (device) vram += device;
    models.push({ id, state: 'live', ...(size !== undefined ? { hostBytes: size } : {}) });
  }
  return { sourceId, supported: true, canUnload: true, models, ...(vram ? { vramBytes: vram } : {}) };
}

const UNKNOWN_UNLOAD_REASON =
  'This server reports residency but does not advertise model unloading. Upgrade native Beholdd to a build with unload support.';

/** The v1 worker API used explicit residency states; a native loaded boolean is not that contract. */
function reportsLegacyResidency(body: unknown): boolean {
  const page = (body ?? {}) as { data?: unknown };
  return records(page.data).some(
    (entry) => typeof entry.id === 'string' && !!entry.id &&
      (entry.residency === 'live' || entry.residency === 'dead' || entry.residency === 'absent')
  );
}

async function unloadCapability(
  source: ResidencySource,
  models?: unknown
): Promise<Pick<SourceResidency, 'canUnload' | 'unloadUnavailableReason' | 'unloadRequiresIdle'>> {
  const info = await probeNativeBeholdd(source.baseUrl, { apiKey: source.apiKey });
  if (info) {
    return info.operations.unload
      ? { canUnload: true, unloadRequiresIdle: true }
      : {
          canUnload: false,
          unloadRequiresIdle: true,
          unloadUnavailableReason: 'This native Beholdd build does not support model unloading.',
        };
  }
  const catalog = models ?? await json(`${trimSlashes(source.baseUrl)}/models`, {
    apiKey: source.apiKey,
    timeoutMs: LIST_TIMEOUT_MS,
  });
  return reportsLegacyResidency(catalog)
    ? { canUnload: true }
    : { canUnload: false, unloadUnavailableReason: UNKNOWN_UNLOAD_REASON };
}

export interface ResidencySource {
  id: string;
  baseUrl: string;
  apiKey?: string;
  kind?: SourceKind;
}

/** What one source is holding. An unreachable source reports the reason rather than nothing. */
export async function readResidency(source: ResidencySource): Promise<SourceResidency> {
  if (!reportsResidency(source.kind)) return { sourceId: source.id, supported: false, canUnload: false, models: [] };
  try {
    if (source.kind === 'ollama') {
      return ollamaResidency(
        source.id,
        await json(ollamaEndpoint(source.baseUrl, '/api/ps'), {
          apiKey: source.apiKey,
          timeoutMs: LIST_TIMEOUT_MS,
        })
      );
    }
    const models = await json(`${trimSlashes(source.baseUrl)}/models`, {
      apiKey: source.apiKey,
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const report = beholddResidency(source.id, models);
    try {
      return { ...report, ...(await unloadCapability(source, models)) };
    } catch (error) {
      // A broken capability endpoint must not erase the model list or enable a destructive action.
      return {
        ...report,
        unloadUnavailableReason: `Could not verify model unloading: ${reachError(error, source.apiKey)}`,
      };
    }
  } catch (error) {
    return { sourceId: source.id, supported: true, canUnload: false, models: [], error: reachError(error, source.apiKey) };
  }
}

/**
 * Stop the worker serving one model and free what it holds.
 *
 * Idempotent on both connectors: unloading something that is not loaded succeeds quietly, which
 * is what makes "unload everything" safe to run against a list that may already be stale.
 */
export async function unloadModel(source: ResidencySource, modelId: string): Promise<void> {
  if (!reportsResidency(source.kind)) {
    throw new Error('This source does not keep models loaded between requests, so there is nothing to unload.');
  }
  if (!modelId.trim()) throw new Error('A model id is required.');
  if (source.kind === 'ollama') {
    // Ollama frees a model by being asked for a zero-length lease on it rather than by a verb
    // of its own. No prompt is sent, so nothing is generated.
    await json(ollamaEndpoint(source.baseUrl, '/api/generate'), {
      apiKey: source.apiKey,
      method: 'POST',
      body: { model: modelId, keep_alive: 0 },
      timeoutMs: UNLOAD_TIMEOUT_MS,
    });
    return;
  }
  let capability: Awaited<ReturnType<typeof unloadCapability>>;
  try {
    // Recheck at mutation time: the UI's previous poll may describe a different server build.
    capability = await unloadCapability(source);
  } catch (error) {
    throw new Error(`Could not verify model unloading: ${reachError(error, source.apiKey)}`);
  }
  if (!capability.canUnload) {
    throw new Error(capability.unloadUnavailableReason);
  }
  await json(`${trimSlashes(source.baseUrl)}/models/${encodeURIComponent(modelId)}/unload`, {
    apiKey: source.apiKey,
    method: 'POST',
    timeoutMs: UNLOAD_TIMEOUT_MS,
  });
}
