export interface IdleCompactionPreferences {
  enabled: boolean;
  idleMinutes: number;
  minimumTokens: number;
}

export interface IdleCompactionState {
  preferences: IdleCompactionPreferences;
  phase: 'off' | 'waiting' | 'running' | 'complete' | 'error';
  threadId: string | null;
  lastCompletedAt: number | null;
  lastCompactedMessages: number;
  error: string | null;
}

export interface IdleCompactionAPI {
  get(): Promise<IdleCompactionState>;
  update(patch: Partial<IdleCompactionPreferences>): Promise<IdleCompactionState>;
  activity(threadId: string | null): Promise<void>;
  onChanged(listener: (state: IdleCompactionState) => void): () => void;
}

export const DEFAULT_IDLE_COMPACTION: Readonly<IdleCompactionPreferences> = Object.freeze({
  enabled: false,
  idleMinutes: 5,
  minimumTokens: 8192,
});

export function validateIdleCompactionPatch(value: unknown): Partial<IdleCompactionPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid idle compaction settings.');
  }
  const patch = value as Record<string, unknown>;
  const result: Partial<IdleCompactionPreferences> = {};
  for (const [key, entry] of Object.entries(patch)) {
    if (key === 'enabled' && typeof entry === 'boolean') {
      result.enabled = entry;
    } else if (key === 'idleMinutes' && Number.isInteger(entry) && Number(entry) >= 1 && Number(entry) <= 120) {
      result.idleMinutes = Number(entry);
    } else if (key === 'minimumTokens' && Number.isInteger(entry) && Number(entry) >= 2048 && Number(entry) <= 1_000_000) {
      result.minimumTokens = Number(entry);
    } else {
      throw new Error(`Invalid idle compaction setting: ${key}.`);
    }
  }
  return result;
}
