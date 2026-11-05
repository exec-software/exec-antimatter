import { NO_TURNS, type LiveTurns } from './liveTurns';

/**
 * The live-turn record, held at module scope rather than in `App`'s `useState`.
 *
 * A Fast Refresh of `App` remounts it and drops its component state, but the main process keeps
 * an interactive turn running across a hot update — it aborts only on a navigation
 * (see `abortInteractiveTurns`), not on HMR. When the two disagreed, the window drew an idle
 * composer over a conversation main was still answering, and the next send was refused with
 * "already has a turn running". A store that outlives the component keeps the window's view of
 * what is running in step with main's, so a hot update no longer strands a live turn.
 *
 * The record is otherwise exactly what `live-turns` produces: pure folds over an immutable map.
 * This module owns only the mutable cell and its subscribers.
 */
let state: LiveTurns = NO_TURNS;
const listeners = new Set<() => void>();

export const subscribeTurns = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The current record without subscribing — for the ref that leads React's render. */
export const currentTurns = (): LiveTurns => state;

/**
 * Fold a change into the live record and wake the subscribers. A change that returns the same
 * map (see the identity guards in `live-turns`) does not notify, so a settled run's late frame
 * cannot churn every consumer.
 */
export function updateTurns(change: (current: LiveTurns) => LiveTurns): LiveTurns {
  const next = change(state);
  if (next === state) return state;
  state = next;
  for (const listener of listeners) listener();
  return state;
}
