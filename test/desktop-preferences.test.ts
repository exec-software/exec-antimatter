import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_DESKTOP_PREFERENCES, matchesShortcut, mayClickSend, normalizeDesktopPreferences, normalizeShortcut, toolIsVisible, validateDesktopPreferencesPatch } from '../src/api/desktopPreferences';
import { DesktopPreferencesStore, registerDesktopPreferencesIpc } from '../src/main/desktopPreferences';

const gesture = { key: 'n', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };

test('shortcuts require exact modifiers and respect macOS, IME, and held keys', () => {
  assert.equal(normalizeShortcut('Shift+Mod+n'), 'Mod+Shift+N');
  assert.equal(matchesShortcut(gesture, 'Mod+N', 'linux'), true);
  assert.equal(matchesShortcut(gesture, 'Mod+N', 'darwin'), false);
  assert.equal(matchesShortcut({ ...gesture, ctrlKey: false, metaKey: true }, 'Mod+N', 'darwin'), true);
  assert.equal(matchesShortcut({ ...gesture, shiftKey: true }, 'Mod+N'), false);
  assert.equal(matchesShortcut({ ...gesture, repeat: true }, 'Mod+N'), false);
  assert.equal(matchesShortcut({ ...gesture, isComposing: true }, 'Mod+N'), false);
  assert.equal(matchesShortcut({ ...gesture, key: 'Enter', ctrlKey: false }, 'Enter'), true);
  assert.equal(matchesShortcut({ ...gesture, key: 'Enter', ctrlKey: false, shiftKey: true }, 'Enter'), false);
  for (const bad of ['Mod+Ctrl+N', 'Ctrl+Ctrl+N', 'Super+N', 'Ctrl+', 'eval()']) assert.throws(() => normalizeShortcut(bad));
});

test('shortcut collisions on either OS and unsafe preference values are rejected', () => {
  for (const collision of ['Ctrl+N', 'Meta+N']) assert.throws(() => validateDesktopPreferencesPatch({ hotkeys: { ...DEFAULT_DESKTOP_PREFERENCES.hotkeys, searchChats: collision } }), /different shortcut/);
  assert.throws(() => validateDesktopPreferencesPatch({ hotkeys: { ...DEFAULT_DESKTOP_PREFERENCES.hotkeys, newChat: 'Mod+Shift+N', searchChats: 'Shift+Meta+N' } }), /different shortcut/);
  for (const invalid of [{ hotkeys: {} }, { hotkeys: { ...DEFAULT_DESKTOP_PREFERENCES.hotkeys, terminal: 'x' } }, { windowStyle: 'hidden' }, { alwaysOnTop: 1 }, { sendClickModifier: 'super' }, { toolVisibility: { preview: 'yes' } }, JSON.parse('{"toolVisibility":{"__proto__":false}}'), { unexpected: true }]) assert.throws(() => validateDesktopPreferencesPatch(invalid));
  assert.deepEqual(normalizeDesktopPreferences({ alwaysOnTop: true, windowStyle: 'broken' }), { ...DEFAULT_DESKTOP_PREFERENCES, alwaysOnTop: true });
});

test('send-click safety never treats unrelated modifiers as consent and rail defaults remain visible', () => {
  for (const modifier of ['ctrl', 'alt', 'shift', 'meta'] as const) {
    const click = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    assert.equal(mayClickSend(click, modifier), false);
    assert.equal(mayClickSend({ ...click, [`${modifier}Key`]: true }, modifier), true);
    assert.equal(mayClickSend(click, 'none'), true);
  }
  const settings = normalizeDesktopPreferences({ toolVisibility: { preview: false, terminal: true } });
  assert.equal(toolIsVisible(settings, 'preview'), false);
  assert.equal(toolIsVisible(settings, 'terminal'), true);
  assert.equal(toolIsVisible(settings, 'new-plugin'), true);
});

test('desktop state is private, durable, deeply copied, and transactional on write failure', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-preferences-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'private', 'desktop.json');
  const store = new DesktopPreferencesStore(file);
  store.update({ windowStyle: 'custom', alwaysOnTop: true, toolVisibility: { preview: false } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(new DesktopPreferencesStore(file).get(), store.get());
  const copy = store.get(); copy.hotkeys.sendMessage = 'Space'; copy.toolVisibility.preview = true;
  assert.equal(store.get().hotkeys.sendMessage, 'Enter'); assert.equal(store.get().toolVisibility.preview, false);
  const before = readFileSync(file, 'utf8');
  const failed = new DesktopPreferencesStore(file, () => { throw new Error('disk full'); });
  assert.throws(() => failed.update({ alwaysOnTop: false }), /disk full/);
  assert.equal(failed.get().alwaysOnTop, true); assert.equal(readFileSync(file, 'utf8'), before);
  rmSync(file); symlinkSync(join(root, 'outside.json'), file); writeFileSync(join(root, 'outside.json'), before);
  assert.deepEqual(new DesktopPreferencesStore(file).get(), DEFAULT_DESKTOP_PREFERENCES);
});

test('window IPC enforces caller authority, persists pin state, and uses normal close lifecycle', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-window-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new DesktopPreferencesStore(join(root, 'desktop.json'));
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = { on: (name: string, cb: (...args: any[]) => any) => handlers.set(name, cb), handle: (name: string, cb: (...args: any[]) => any) => handlers.set(name, cb) };
  let maximized = false, full = false, top = false, minimized = false, closed = false;
  const events: string[] = [];
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, isMaximized: () => maximized, isFullScreen: () => full, isAlwaysOnTop: () => top,
    minimize: () => { minimized = true; }, maximize: () => { maximized = true; }, unmaximize: () => { maximized = false; }, setFullScreen: (value: boolean) => { full = value; }, setAlwaysOnTop: (value: boolean) => { top = value; }, close: () => { closed = true; }, webContents: { isDestroyed: () => false, send: (event: string) => { events.push(event); } } });
  const authority = {};
  const service = registerDesktopPreferencesIpc({ ipcMain: ipc as any, store, getWindow: () => window as any, platform: 'linux', authorize: (event) => { if (event !== authority) throw new Error('Unauthorized'); } });
  service.attach(window as any, true);
  const call = (name: string, arg?: unknown) => handlers.get(`desktop:${name}`)!(authority, arg);
  for (const name of ['get', 'update', 'window-state', 'window-action']) assert.throws(() => handlers.get(`desktop:${name}`)!({}, 'close'), /Unauthorized/);
  const untrusted: { returnValue?: unknown } = {}; handlers.get('desktop:initial')!(untrusted); assert.equal(untrusted.returnValue, null);
  assert.equal(call('window-state').customChrome, true);
  assert.equal(call('window-action', 'toggle-maximize').maximized, true);
  assert.equal(call('window-action', 'toggle-maximize').maximized, false);
  assert.equal(call('window-action', 'toggle-fullscreen').fullscreen, true);
  assert.equal(call('window-action', 'toggle-always-on-top').alwaysOnTop, true);
  assert.equal(store.get().alwaysOnTop, true);
  call('window-action', 'minimize'); call('window-action', 'close'); assert.equal(minimized, true); assert.equal(closed, true);
  assert.throws(() => call('window-action', 'execute'), /Unknown window action/);
  assert.ok(events.includes('desktop:changed')); assert.ok(events.includes('desktop:window-state'));
});
