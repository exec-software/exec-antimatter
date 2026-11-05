import { DEFAULT_APPEARANCE, normalizeAppearance, type AppearanceSettings, type AppearanceAPI, type ReadonlyAppearanceAPI } from '../../src/api/appearance';
import { applyDisplacerTokens } from './displacer';

let current: AppearanceSettings = Object.freeze({ ...DEFAULT_APPEARANCE });
let bridge: ReadonlyAppearanceAPI | undefined;
let dispose: (() => void) | undefined;
let generation = 0;
let revision = 0;
const listeners = new Set<(settings: AppearanceSettings) => void>();
export const getAppearance = (): AppearanceSettings => current;
export function subscribeAppearance(listener: (settings: AppearanceSettings) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function receive(settings: AppearanceSettings): void {
  current = Object.freeze(normalizeAppearance(settings));
  revision++;
  if (typeof document !== 'undefined') applyDisplacerTokens(current);
  for (const listener of listeners) listener(current);
}

/** Preload's initial snapshot is available before React/standalone-window first paint. */
export function initializeAppearance(api?: ReadonlyAppearanceAPI): () => void {
  dispose?.();
  const instance = ++generation;
  bridge = api;
  receive(api?.initial ?? DEFAULT_APPEARANCE);
  const unsubscribe = api?.onChanged((next) => { if (generation === instance) receive(next); });
  // Close the gap between preload's first-paint snapshot and subscription without allowing a
  // late read to overwrite a newer event or a user selection.
  const observed = revision;
  void api?.get().then((next) => {
    if (generation === instance && revision === observed) receive(next);
  }).catch(() => { /* Keep the validated initial snapshot; saving still reports failures. */ });
  const cleanup = () => {
    unsubscribe?.();
    if (generation === instance) { generation++; bridge = undefined; }
  };
  dispose = cleanup;
  return cleanup;
}

/** Do not claim a preference was saved (or recolor the app) until main has persisted it. */
export async function saveAppearance(patch: Partial<AppearanceSettings>): Promise<AppearanceSettings> {
  const api = bridge as AppearanceAPI | undefined;
  if (!api?.update) throw new Error('Appearance settings are unavailable. Reopen Antimatter and try again.');
  const instance = generation;
  const observed = revision;
  const saved = await api.update(patch);
  if (generation === instance && revision === observed) receive(saved);
  return saved;
}
