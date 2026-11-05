import type { ModelChoice } from './modelChoice';

export interface LastUsedModel {
  providerId: string;
  model: string;
}

/**
 * The live source/model inherited by an unpinned agent.
 *
 * It starts from the durable picker choice, then follows picker changes and actual chat/agent use
 * in this process. Keeping this state independent from Electron IPC makes the important transition
 * — choosing a model before the first chat turn — small enough to regression-test directly.
 */
export function createLastUsedModel(initial: ModelChoice | null) {
  let current: LastUsedModel | null =
    initial?.providerId && initial.modelId ? { providerId: initial.providerId, model: initial.modelId } : null;

  return {
    read(): LastUsedModel | null {
      return current ? { ...current } : null;
    },
    select(providerId: string, model: string): LastUsedModel | null {
      current = providerId && model ? { providerId, model } : null;
      return current ? { ...current } : null;
    },
    clear(): void {
      current = null;
    },
  };
}
