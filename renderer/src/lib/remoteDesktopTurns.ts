import type { RemoteDesktopTurnsSnapshot } from '../../../src/api/remoteDesktopTurns';
import type { ProviderConfig } from '../types';
import { beginTurn, endTurn, type LiveTurn, type LiveTurns } from './liveTurns';

export function remoteTurnForRun(turns: LiveTurns, runId: string): LiveTurn | undefined {
  return Object.values(turns).find((turn) => turn.remote?.runId === runId);
}

/** Only main owns remote turn lifetime; an absent remote turn settles without touching local work. */
export function reconcileRemoteTurns(
  turns: LiveTurns, snapshot: RemoteDesktopTurnsSnapshot, providers: readonly ProviderConfig[], now: number,
): LiveTurns {
  let next = turns;
  const incoming = new Map(snapshot.turns.map((turn) => [turn.threadId, turn]));
  for (const [threadId, turn] of Object.entries(next)) {
    if (!turn.remote || !turn.runId || incoming.get(threadId)?.runId === turn.runId) continue;
    const ending = snapshot.finished?.runId === turn.runId ? snapshot.finished : { failed: false, finishedAt: now };
    next = endTurn(next, turn.runId, ending);
  }
  for (const remote of snapshot.turns) {
    const existing = next[remote.threadId];
    const source = providers.find((provider) => provider.id === remote.providerId)
      ?? (existing?.runId === remote.runId ? existing.source : null);
    if (existing?.runId === remote.runId && existing.remote?.responseMessageId === remote.responseMessageId) {
      if (existing.source !== source) next = { ...next, [remote.threadId]: { ...existing, source } };
      continue;
    }
    next = beginTurn(next, remote.threadId, { runId: remote.runId, source, startedAt: remote.startedAt });
    next = { ...next, [remote.threadId]: { ...next[remote.threadId], remote: {
      runId: remote.runId, responseMessageId: remote.responseMessageId,
    } } };
  }
  return next;
}

/** Subscribe before fetching; a delayed initial response must not replace a newer event. */
export function subscribeRemoteTurns(
  api: {
    snapshot(): Promise<RemoteDesktopTurnsSnapshot>;
    subscribe(listener: (snapshot: RemoteDesktopTurnsSnapshot) => void): () => void;
  },
  apply: (snapshot: RemoteDesktopTurnsSnapshot) => void,
  failed: (error: unknown) => void,
): () => void {
  let disposed = false;
  let revision = -1;
  const accept = (snapshot: RemoteDesktopTurnsSnapshot) => {
    if (disposed || snapshot.revision < revision) return;
    revision = snapshot.revision;
    apply(snapshot);
  };
  const unsubscribe = api.subscribe(accept);
  void api.snapshot().then(accept).catch((error) => { if (!disposed) failed(error); });
  return () => { disposed = true; unsubscribe(); };
}
