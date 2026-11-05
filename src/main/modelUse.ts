/**
 * Which models are answering something right now.
 *
 * Only needed so that freeing memory can be an informed choice. Unloading a model mid-turn ends
 * that turn, and the Library should say so before it happens — but it must not be forbidden,
 * because the case that most needs unloading is a worker that has already stopped answering
 * while a turn sits waiting on it. Refusing there would block the one recovery that works.
 *
 * A count rather than a flag: the same model answers a conversation and the agents that
 * conversation started, and those are separate holds that end at different times.
 */

export interface ModelHold {
  providerId: string;
  modelId: string;
  /** How many turns are on it, so "1 turn" and "3 turns" can be said honestly. */
  turns: number;
}

const key = (providerId: string, modelId: string) => `${providerId}\u0000${modelId}`;

const holds = new Map<string, ModelHold>();

/** Marks a model busy until the returned function is called. Safe to call twice. */
export function hold(providerId: string, modelId: string): () => void {
  if (!providerId || !modelId) return () => undefined;
  const id = key(providerId, modelId);
  const existing = holds.get(id);
  if (existing) existing.turns += 1;
  else holds.set(id, { providerId, modelId, turns: 1 });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = holds.get(id);
    if (!current) return;
    current.turns -= 1;
    if (current.turns <= 0) holds.delete(id);
  };
}

export const inUse = (): ModelHold[] => [...holds.values()].map((entry) => ({ ...entry }));

/** How many turns are on one model. Zero when it is idle. */
export const turnsOn = (providerId: string, modelId: string): number =>
  holds.get(key(providerId, modelId))?.turns ?? 0;

/** Tests only: no production path clears every hold at once. */
export const reset = (): void => holds.clear();
