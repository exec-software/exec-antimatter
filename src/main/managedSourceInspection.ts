import type { InferenceSource } from './sourceStore';
import type { ManagedConnection } from './llamaVulkan';
import type { ProbeResult } from './probe';
import type { WireProtocol } from '../api/types';
import { refreshSource, type SourceRefreshResult } from './sourceRefresh';
import type { SourceReadiness } from './sourceReadiness';

interface ConnectionAccess {
  connectionFor(sourceId: string): ManagedConnection | null;
}

const unavailable = (): ProbeResult => ({
  ok: false, latencyMs: 0, models: [], error: 'This workload server is inactive or changed. Send it a message, or start its server in Settings → Models & providers → Inference servers, before testing or refreshing its connection.',
});

const unchanged = (before: ManagedConnection, after: ManagedConnection | null): boolean =>
  !!after && before.apiKey === after.apiKey && before.baseUrl === after.baseUrl && before.modelId === after.modelId;

/** Ephemeral router credentials are used only by the probe, never by the persistence path. */
export async function inspectManagedSource(source: InferenceSource, persist: boolean, deps: ConnectionAccess & {
  probe(baseUrl: string, apiKey?: string, protocol?: WireProtocol): Promise<ProbeResult>;
  current(id: string): InferenceSource | null;
  save(source: InferenceSource): InferenceSource;
}): Promise<SourceRefreshResult> {
  const connection = deps.connectionFor(source.id);
  if (!connection) return { probe: unavailable(), saved: null };
  return refreshSource(source, persist, {
    current: deps.current,
    save: (next) => {
      if (!unchanged(connection, deps.connectionFor(source.id))) throw new Error('This workload server changed during refresh. Send it a message, then refresh its connection again.');
      return deps.save(next);
    },
    probe: async () => {
      const observed = await deps.probe(connection.baseUrl, connection.apiKey, source.protocol);
      // The router can switch while an observation is in flight. An answer from a retired
      // generation must not populate a different workload's catalog, even on the same port.
      if (!unchanged(connection, deps.connectionFor(source.id))) return unavailable();
      if (!observed.ok) return observed;
      const models = observed.models.filter((model) => model.id === connection.modelId);
      if (!models.length) return { ...observed, ok: false, models: [], error: 'The configured workload model is unavailable. Check its server in Settings → Models & providers → Inference servers before sending another message.' };
      return { ...observed, models };
    },
  });
}

/** An inactive router may be started by a later request; it is not an unreachable source. */
export async function managedSourceReadiness(sourceId: string, deps: ConnectionAccess & {
  read(source: { baseUrl: string; apiKey: string }): Promise<SourceReadiness>;
  startup?(): SourceReadiness | Promise<SourceReadiness>;
}): Promise<SourceReadiness> {
  const inactive = async (): Promise<SourceReadiness> => {
    try { return await deps.startup?.() ?? { state: 'unknown' }; }
    catch (error) { return { state: 'unreachable', detail: error instanceof Error ? error.message : String(error) }; }
  };
  const connection = deps.connectionFor(sourceId);
  if (!connection) return inactive();
  const result = await deps.read(connection);
  return unchanged(connection, deps.connectionFor(sourceId)) ? result : inactive();
}
