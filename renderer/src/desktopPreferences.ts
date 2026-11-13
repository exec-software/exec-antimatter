import { useEffect, useSyncExternalStore } from 'react';
import {
  DEFAULT_DESKTOP_PREFERENCES, HOTKEY_ACTIONS, matchesShortcut, normalizeDesktopPreferences,
  type DesktopPreferences, type DesktopPreferencesAPI, type HotkeyAction,
} from '../../src/api/desktopPreferences';

let current = normalizeDesktopPreferences(DEFAULT_DESKTOP_PREFERENCES);
let bridge: DesktopPreferencesAPI | undefined;
let generation = 0;
let revision = 0;
let dispose: (() => void) | undefined;
const listeners = new Set<() => void>();
export const getDesktopPreferences = () => current;
export const subscribeDesktopPreferences = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useDesktopPreferences = () => useSyncExternalStore(subscribeDesktopPreferences, getDesktopPreferences, getDesktopPreferences);
export const desktopPlatform = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? 'darwin' : 'linux';

function receive(settings: DesktopPreferences): void {
  current = normalizeDesktopPreferences(settings);
  revision++;
  for (const listener of listeners) listener();
}

export function initializeDesktopPreferences(api?: DesktopPreferencesAPI): () => void {
  dispose?.();
  bridge = api;
  const instance = ++generation;
  receive(api?.initial ?? DEFAULT_DESKTOP_PREFERENCES);
  const stop = api?.onChanged((value) => { if (generation === instance) receive(value); });
  const observed = revision;
  void api?.get().then((value) => {
    if (generation === instance && revision === observed) receive(value);
  }).catch(() => {});
  dispose = () => { stop?.(); if (generation === instance) { generation++; bridge = undefined; } };
  return dispose;
}

export async function saveDesktopPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences> {
  if (!bridge) throw new Error('Desktop settings are unavailable. Restart Antimatter and try again.');
  const instance = generation;
  const observed = revision;
  const saved = await bridge.update(patch);
  if (generation === instance && revision === observed) receive(saved);
  return saved;
}

/** App-level actions use a capture listener; the composer handles its own send shortcut. */
export function useDesktopHotkeys(actions: Partial<Record<Exclude<HotkeyAction, 'sendMessage' | 'terminal'>, () => void>>): void {
  const settings = useDesktopPreferences();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target instanceof Element && event.target.closest('[data-hotkey-recorder]')) return;
      for (const action of HOTKEY_ACTIONS) {
        if (action === 'sendMessage' || action === 'terminal' || !actions[action]) continue;
        if (!matchesShortcut(event, settings.hotkeys[action], desktopPlatform())) continue;
        event.preventDefault();
        event.stopPropagation();
        actions[action]?.();
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [settings, actions]);
}
