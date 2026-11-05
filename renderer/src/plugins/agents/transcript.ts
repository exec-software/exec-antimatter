/** Idempotent stream replay: overlap is already in the snapshot; a gap requires rehydration. */
export function appendAgentContent(current: string, chunk: string, offset?: number): string | null {
  if (offset === undefined) return current + chunk;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > current.length) return null;
  const alreadyPresent = current.length - offset;
  return current + chunk.slice(alreadyPresent);
}
