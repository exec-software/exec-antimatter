import type { InferenceSource } from './sourceStore';
import { discoverableConversationModels, mergeProbedModels, type ProbeResult } from './probe';
import type { WireProtocol } from '../api/types';

export interface SourceRefreshDeps {
  probe(baseUrl: string, apiKey?: string, protocol?: WireProtocol): Promise<ProbeResult>;
  /** Read the source again around an asynchronous probe; a removed source stays removed. */
  current(id: string): InferenceSource | null;
  save(source: InferenceSource): InferenceSource;
}

export interface SourceRefreshResult {
  probe: ProbeResult;
  saved: InferenceSource | null;
}

/**
 * OpenCode Zen's shared catalog is heterogeneous: one `/models` response can contain models that
 * require Responses, Messages, or another native protocol. A source has exactly one protocol, so
 * adopting that generic list would advertise models through the wrong wire format. Zen models
 * are declared explicitly in the Model Library until discovery is protocol-scoped upstream.
 */
export function mayAdoptProbedCatalog(source: Pick<InferenceSource, 'kind'>): boolean {
  return source.kind !== 'opencode-zen';
}

// A slower observation must not replace a later one, even when both used the same endpoint.
// Entries are retired by their owner; an older probe cannot delete a newer probe's token.
const latestObservation = new Map<string, symbol>();

type SourceIdentity = Pick<InferenceSource, 'id' | 'baseUrl' | 'apiKey' | 'protocol' | 'kind' | 'createdAt'>;

const sameSource = (before: SourceIdentity, after: InferenceSource | null): after is InferenceSource =>
  !!after && before.id === after.id && before.baseUrl === after.baseUrl &&
  (before.protocol ?? 'openai-chat') === (after.protocol ?? 'openai-chat') &&
  (before.apiKey ?? '') === (after.apiKey ?? '') && before.kind === after.kind &&
  before.createdAt === after.createdAt;

const staleObservation = (latencyMs: number): SourceRefreshResult => ({
  probe: {
    ok: false, latencyMs, models: [],
    error: 'The source changed or a newer refresh started while checking its models. Refresh the source again.',
  },
  saved: null,
});

/**
 * Tests a configured source with its main-process credential and optionally persists what it
 * learned. Observations are merged into the existing catalog so an incomplete/transient model
 * list cannot erase curated or registered entries.
 */
export async function refreshSource(
  source: InferenceSource,
  persist: boolean,
  deps: SourceRefreshDeps
): Promise<SourceRefreshResult> {
  // Copy connection identity before yielding: callers can replace or mutate their source object.
  const identity: SourceIdentity = {
    id: source.id, baseUrl: source.baseUrl, apiKey: source.apiKey, protocol: source.protocol,
    kind: source.kind, createdAt: source.createdAt,
  };
  if (!sameSource(identity, deps.current(source.id))) return staleObservation(0);
  const adopt = persist && mayAdoptProbedCatalog(source);
  const observation = adopt ? Symbol(source.id) : null;
  if (observation) latestObservation.set(source.id, observation);

  try {
    const probe = await deps.probe(identity.baseUrl, identity.apiKey || undefined, identity.protocol);
    const current = deps.current(identity.id);
    if (!sameSource(identity, current) ||
      (observation && latestObservation.get(identity.id) !== observation)) {
      return staleObservation(probe.latencyMs);
    }
    if (!adopt || !probe.ok) return { probe, saved: null };

    // Probe results are external runtime input and custom transports can bypass probeSource's
    // normalization, so enforce protocol eligibility again. Merge with the current catalog:
    // a name, declaration, or curated field edited during the probe must survive its result.
    const observed = discoverableConversationModels(current.protocol ?? 'openai-chat', probe.models);
    const models = mergeProbedModels(current.models, observed);
    const saved = deps.save({ ...current, models });
    return { probe, saved };
  } finally {
    if (observation && latestObservation.get(identity.id) === observation) {
      latestObservation.delete(identity.id);
    }
  }
}
