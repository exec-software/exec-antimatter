const snapshots = new Set<() => Promise<void>>();
const writes = new Map<string, { pending: Promise<void>; retry: () => Promise<void>; failed: boolean }>();

export function registerDoomSnapshot(flush: () => Promise<void>): () => void {
  snapshots.add(flush); return () => { snapshots.delete(flush); };
}
/** Keep failed disk writes retryable even after the game panel has closed. */
export function persistDoomSave(token: string, write: () => Promise<void>): Promise<void> {
  const previous = writes.get(token);
  const entry = { pending: Promise.resolve(), retry: write, failed: false };
  entry.pending = (previous?.pending.catch(() => {}) ?? Promise.resolve()).then(write).then(() => {
    if (writes.get(token) === entry) writes.delete(token);
  }, (error) => { entry.failed = true; throw error; });
  writes.set(token, entry);
  return entry.pending;
}
/** Close/update must await saved slots; unsaved gameplay still uses Doom's explicit Save menu. */
export async function flushDoomSaves(): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = async () => {
      await Promise.all([...snapshots].map((snapshot) => snapshot()));
      await Promise.all([...writes.entries()].map(async ([token, entry]) => {
        try { await entry.pending; } catch { await persistDoomSave(token, entry.retry); }
      }));
      return [] as string[];
    };
    return await Promise.race([operation(), new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve(['Doom is still saving. Try again when the save finishes.']), 3000); })]);
  } catch { return ['A Doom saved game could not be written. Try again after fixing the storage error.']; }
  finally { if (timer) clearTimeout(timer); }
}
