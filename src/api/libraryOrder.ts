/**
 * Sorting and reordering for the Model Library tree.
 *
 * Pure, and in `api` rather than `main`, because the renderer does the sorting and cannot import
 * across the main-process project boundary. The store that persists the list lives in
 * `main/libraryOrder.ts` and re-exports these so there is one implementation of the ordering
 * rules rather than one on each side of the IPC.
 */

/**
 * Sort by the stored order, then by whatever the caller already preferred.
 *
 * The existing ranking — the conversation's own model first, then anything resident — is still
 * the right answer for a model nobody has placed by hand. So a stored position wins where there
 * is one, and everything else keeps the order it arrived in, which leaves that ranking intact
 * below the dragged rows rather than replacing it with alphabetical noise.
 */
export function applyLibraryOrder<T>(items: readonly T[], key: (item: T) => string, order: readonly string[]): T[] {
  const position = new Map(order.map((entry, index) => [entry, index]));
  return items
    .map((item, index) => ({ item, index, placed: position.get(key(item)) }))
    .sort((left, right) => {
      if (left.placed !== undefined && right.placed !== undefined) return left.placed - right.placed;
      // Unplaced sorts after placed, so connecting a source does not reshuffle a curated tree.
      if (left.placed !== undefined) return -1;
      if (right.placed !== undefined) return 1;
      return left.index - right.index;
    })
    .map((entry) => entry.item);
}

/**
 * Move one key to sit before another, returning the list to store.
 *
 * Built from the keys actually on screen rather than from the stored list, because the stored
 * list can hold models that are hidden, filtered out, or gone. Dropping a row between two visible
 * rows has to mean what it looks like, so the visible arrangement is written out whole.
 */
export function reorderLibrary(visible: readonly string[], moved: string, before: string | null): string[] {
  // Dropping a row on itself is a no-op, not a move to the end. Without this the filtered list
  // no longer contains the target, `indexOf` answers -1, and the row silently travels.
  if (moved === before) return [...visible];
  const without = visible.filter((key) => key !== moved);
  if (!visible.includes(moved)) return [...without];
  const at = before === null ? without.length : without.indexOf(before);
  const index = at < 0 ? without.length : at;
  return [...without.slice(0, index), moved, ...without.slice(index)];
}
