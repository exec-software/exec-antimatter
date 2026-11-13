export const HOTKEY_ACTIONS = ['newChat', 'searchChats', 'settings', 'toggleSidebar', 'terminal', 'sendMessage'] as const;
export type HotkeyAction = typeof HOTKEY_ACTIONS[number];
export type SendClickModifier = 'none' | 'ctrl' | 'alt' | 'shift' | 'meta';
export type WindowAction = 'minimize' | 'toggle-maximize' | 'close' | 'toggle-fullscreen' | 'toggle-always-on-top';

export interface ReplyMacro { id: string; title: string; text: string }

export interface DesktopPreferences {
  macroPadEnabled: boolean;
  doomEnabled: boolean;
  replyMacros: ReplyMacro[];
  windowStyle: 'native' | 'custom';
  alwaysOnTop: boolean;
  toolVisibility: Record<string, boolean>;
  sendClickModifier: SendClickModifier;
  hotkeys: Record<HotkeyAction, string>;
}

export const DEFAULT_DESKTOP_PREFERENCES: Readonly<DesktopPreferences> = Object.freeze({
  macroPadEnabled: false,
  doomEnabled: false,
  replyMacros: Object.freeze([]) as unknown as ReplyMacro[],
  windowStyle: 'native',
  alwaysOnTop: false,
  toolVisibility: Object.freeze({}),
  sendClickModifier: 'none',
  hotkeys: Object.freeze({
    newChat: 'Mod+N', searchChats: 'Mod+K', settings: 'Mod+,',
    toggleSidebar: 'Mod+B', terminal: 'Ctrl+`', sendMessage: 'Enter',
  }),
});

export interface DesktopWindowState {
  customChrome: boolean;
  maximized: boolean;
  fullscreen: boolean;
  alwaysOnTop: boolean;
  platform: string;
}

export interface DesktopPreferencesAPI {
  initial: DesktopPreferences;
  get(): Promise<DesktopPreferences>;
  update(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  onChanged(callback: (settings: DesktopPreferences) => void): () => void;
  windowState(): Promise<DesktopWindowState>;
  windowAction(action: WindowAction): Promise<DesktopWindowState>;
  onWindowState(callback: (state: DesktopWindowState) => void): () => void;
}

const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const NAMED_KEYS = ['Enter', 'Escape', 'Space', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function normalizeShortcut(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) throw new Error('Enter a keyboard shortcut.');
  const parts = value.trim().split('+');
  const key = parts.pop() ?? '';
  if (!key || (!/^[a-z0-9`,.\-/;='\[\]\\]$/i.test(key) && !NAMED_KEYS.includes(key) && !/^F([1-9]|1[0-2])$/.test(key))) {
    throw new Error('Choose a letter, number, function key, or named navigation key.');
  }
  if (parts.some((part) => !(MODIFIERS as readonly string[]).includes(part)) || new Set(parts).size !== parts.length
      || (parts.includes('Mod') && (parts.includes('Ctrl') || parts.includes('Meta')))) {
    throw new Error('Use each modifier once. Mod means Ctrl on Windows/Linux and Command on macOS.');
  }
  return [...MODIFIERS.filter((modifier) => parts.includes(modifier)), key.length === 1 ? key.toUpperCase() : key].join('+');
}

function validateHotkeys(value: unknown): DesktopPreferences['hotkeys'] {
  if (!isObject(value) || Object.keys(value).length !== HOTKEY_ACTIONS.length
      || Object.keys(value).some((key) => !(HOTKEY_ACTIONS as readonly string[]).includes(key))) {
    throw new Error('Provide every keyboard shortcut.');
  }
  const hotkeys = Object.fromEntries(HOTKEY_ACTIONS.map((key) => [key, normalizeShortcut(value[key])])) as DesktopPreferences['hotkeys'];
  for (const key of HOTKEY_ACTIONS) {
    if (key !== 'sendMessage' && !hotkeys[key].includes('+') && !/^F\d+$/.test(hotkeys[key])) {
      throw new Error('App shortcuts need a modifier or function key.');
    }
  }
  for (const platform of ['linux', 'darwin']) {
    const concrete = Object.values(hotkeys).map((shortcut) => normalizeShortcut(shortcut.replace('Mod+', platform === 'darwin' ? 'Meta+' : 'Ctrl+')));
    if (new Set(concrete).size !== concrete.length) throw new Error('Each action needs a different shortcut.');
  }
  return hotkeys;
}

export function validateDesktopPreferencesPatch(value: unknown): Partial<DesktopPreferences> {
  if (!isObject(value)) throw new Error('Desktop preferences must be an object.');
  if (Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(DEFAULT_DESKTOP_PREFERENCES, key))) throw new Error('Unknown desktop preference.');
  const patch: Partial<DesktopPreferences> = {};
  if (Object.prototype.hasOwnProperty.call(value, 'doomEnabled')) {
    if (typeof value.doomEnabled !== 'boolean') throw new Error('Doom must be on or off.');
    patch.doomEnabled = value.doomEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'macroPadEnabled')) {
    if (typeof value.macroPadEnabled !== 'boolean') throw new Error('Reply pad must be on or off.');
    patch.macroPadEnabled = value.macroPadEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'replyMacros')) {
    if (!Array.isArray(value.replyMacros) || value.replyMacros.length > 32) throw new Error('Save up to 32 replies.');
    const ids = new Set<string>();
    patch.replyMacros = value.replyMacros.map((entry) => {
      if (!isObject(entry) || Object.keys(entry).length !== 3 || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id)
        || ids.has(entry.id) || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 80
        || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 4000) throw new Error('Replies need a unique id, a title up to 80 characters, and text up to 4,000 characters.');
      ids.add(entry.id); return { id: entry.id, title: entry.title.trim(), text: entry.text };
    });
  }
  if (Object.prototype.hasOwnProperty.call(value, 'windowStyle')) {
    if (value.windowStyle !== 'native' && value.windowStyle !== 'custom') throw new Error('Choose native or custom window controls.');
    patch.windowStyle = value.windowStyle;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'alwaysOnTop')) {
    if (typeof value.alwaysOnTop !== 'boolean') throw new Error('Always on top must be on or off.');
    patch.alwaysOnTop = value.alwaysOnTop;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'sendClickModifier')) {
    if (!['none', 'ctrl', 'alt', 'shift', 'meta'].includes(value.sendClickModifier as string)) throw new Error('Choose a send modifier.');
    patch.sendClickModifier = value.sendClickModifier as SendClickModifier;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'hotkeys')) patch.hotkeys = validateHotkeys(value.hotkeys);
  if (Object.prototype.hasOwnProperty.call(value, 'toolVisibility')) {
    if (!isObject(value.toolVisibility) || Object.keys(value.toolVisibility).length > 256) throw new Error('Invalid tool visibility preferences.');
    const entries = Object.entries(value.toolVisibility);
    if (entries.some(([key, visible]) => !/^[a-zA-Z][\w.-]{0,99}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof visible !== 'boolean')) {
      throw new Error('Tool visibility must map tool identifiers to on or off.');
    }
    patch.toolVisibility = Object.fromEntries(entries) as Record<string, boolean>;
  }
  return patch;
}

export function normalizeDesktopPreferences(value: unknown): DesktopPreferences {
  const source = isObject(value) ? value : {};
  const next: DesktopPreferences = { ...DEFAULT_DESKTOP_PREFERENCES, toolVisibility: {}, replyMacros: [], hotkeys: { ...DEFAULT_DESKTOP_PREFERENCES.hotkeys } };
  for (const key of Object.keys(next) as (keyof DesktopPreferences)[]) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    try { Object.assign(next, validateDesktopPreferencesPatch({ [key]: source[key] })); } catch { /* Invalid disk fields keep their defaults. */ }
  }
  return next;
}

export interface KeyGesture {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}

export function matchesShortcut(event: KeyGesture, shortcut: string, platform = 'linux'): boolean {
  if (event.isComposing || event.repeat) return false;
  let parts: string[];
  try { parts = normalizeShortcut(shortcut).split('+'); } catch { return false; }
  const key = parts.pop();
  const modifiers = new Set(parts.map((part) => part === 'Mod' ? (platform === 'darwin' ? 'Meta' : 'Ctrl') : part));
  const actual = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return actual === key && event.ctrlKey === modifiers.has('Ctrl') && event.metaKey === modifiers.has('Meta')
    && event.altKey === modifiers.has('Alt') && event.shiftKey === modifiers.has('Shift');
}

export function mayClickSend(event: Pick<KeyGesture, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, modifier: SendClickModifier): boolean {
  return modifier === 'none' || event[`${modifier}Key`];
}

export function displayShortcut(shortcut: string, platform = 'linux'): string {
  return shortcut.replace('Mod', platform === 'darwin' ? 'Command' : 'Ctrl').replace('Meta', platform === 'darwin' ? 'Command' : 'Windows');
}

export const toolIsVisible = (settings: DesktopPreferences, id: string): boolean => (id !== 'reply-pad' || settings.macroPadEnabled) && (id !== 'doom' || settings.doomEnabled) && settings.toolVisibility[id] !== false;
