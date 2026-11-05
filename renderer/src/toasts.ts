import {
  buildToast,
  placeToast,
  type Toast,
  type ToastInput,
} from '../../src/api/toasts';

/**
 * The live toast list, as an external store so `useSyncExternalStore` can read it without the
 * host re-rendering the application on every tick.
 *
 * Deliberately not React context. A toast is raised from places that are not components — a
 * saved-settings callback, an IPC event handler, a catch block in a module — and threading a
 * hook through all of those would have meant each of them becoming a component's problem.
 */

let toasts: readonly Toast[] = Object.freeze([]);
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Handlers by action id, registered by whoever can carry the action out. */
const handlers = new Map<string, (toast: Toast) => void>();
let counter = 0;

export const getToasts = (): readonly Toast[] => toasts;

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(next: readonly Toast[]): void {
  toasts = Object.freeze(next);
  for (const listener of listeners) listener();
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) { clearTimeout(timer); timers.delete(id); }
}

export function dismissToast(id: string): void {
  clearTimer(id);
  if (!toasts.some((toast) => toast.id === id)) return;
  publish(toasts.filter((toast) => toast.id !== id));
}

/**
 * Raise a toast. Returns its id, or null when the input was not a toast — a notice failing to
 * appear must never be the reason an operation reports failure, so this swallows rather than
 * throws and leaves a trace in the console instead.
 */
export function showToast(input: ToastInput): string | null {
  let toast: Toast;
  try {
    toast = buildToast(input, `toast-${++counter}`, Date.now());
  } catch (cause) {
    console.error('[toasts] refused:', cause);
    return null;
  }
  // A keyed replacement inherits the slot but not the old deadline: the update is new news.
  const replaced = toast.key === null ? undefined : toasts.find((candidate) => candidate.key === toast.key);
  if (replaced) clearTimer(replaced.id);
  const next = placeToast(toasts, toast);
  // Anything pushed out by the cap must not leave a timer behind holding a reference to it.
  for (const dropped of toasts) {
    if (!next.includes(dropped)) clearTimer(dropped.id);
  }
  publish(next);
  if (toast.timeoutMs !== null) {
    timers.set(toast.id, setTimeout(() => dismissToast(toast.id), toast.timeoutMs));
  }
  return toast.id;
}

/**
 * Register what an action id does. Returns a disposer, so a page that can carry out an action
 * only while it is mounted stops claiming it on the way out — an action whose handler has gone
 * dismisses the toast rather than appearing to work.
 */
export function onToastAction(id: string, handler: (toast: Toast) => void): () => void {
  handlers.set(id, handler);
  return () => { if (handlers.get(id) === handler) handlers.delete(id); };
}

/** Run an action and retire its toast. An unclaimed action still retires it. */
export function runToastAction(toastId: string, actionId: string): void {
  const toast = toasts.find((candidate) => candidate.id === toastId);
  dismissToast(toastId);
  if (!toast) return;
  const handler = handlers.get(actionId);
  if (!handler) {
    console.warn(`[toasts] no handler for action "${actionId}"`);
    return;
  }
  // A throwing handler must not take the host down with it; the toast is already gone.
  try { handler(toast); } catch (cause) { console.error(`[toasts] action "${actionId}" failed:`, cause); }
}

/** Tests, and a window tearing down. */
export function resetToasts(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  handlers.clear();
  publish([]);
}
