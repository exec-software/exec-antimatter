import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent, Rectangle } from 'electron';
import { DesktopAvatar, type AvatarRuntime } from '../src/main/avatar/desktop';
import { AvatarSettingsStore } from '../src/main/avatar/settings';
import type { VoiceCommand } from '../src/api/voice';

class FakeWindow extends EventEmitter {
  destroyed = false;
  visible = false;
  minimized = false;
  shown = 0;
  resolve!: () => void;
  reject!: (error: Error) => void;
  loading = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  updates: unknown[] = [];
  position: [number, number] = [100, 100];
  webContents = Object.assign(new EventEmitter(), { mainFrame: {},
    setWindowOpenHandler: () => {}, send: (_channel: string, state: unknown) => { this.updates.push(state); } });
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  getPosition() { assert.equal(this.destroyed, false, 'a destroyed native window has no readable position'); return this.position; }
  move(x: number, y: number) { this.position = [x, y]; this.emit('move'); }
  showInactive() { this.visible = true; this.shown++; this.emit('show'); }
  hide() { this.visible = false; this.emit('hide'); }
  minimize() { this.minimized = true; this.emit('minimize'); }
  restore() { this.minimized = false; this.emit('restore'); }
  destroy() { this.destroyed = true; this.emit('closed'); }
  loadURL() { return this.loading; }
  loadFile() { return this.loading; }
}

function fixture(t: { after(callback: () => void): void }, options: Partial<ConstructorParameters<typeof DesktopAvatar>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'avatar-lifecycle-'));
  const windows: FakeWindow[] = [];
  const windowOptions: BrowserWindowConstructorOptions[] = [];
  const workAreas: Rectangle[] = [{ x: 0, y: 0, width: 1000, height: 800 }];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const runtime: AvatarRuntime = {
    createWindow: (options) => { windowOptions.push(options); const window = new FakeWindow();
      window.position = [options.x ?? 100, options.y ?? 100]; windows.push(window); return window as unknown as BrowserWindow; },
    ipc: { handle: (name, callback) => { assert.equal(handlers.has(name), false); handlers.set(name, callback); },
      removeHandler: (name) => { handlers.delete(name); } },
    workAreas: () => workAreas, menu: () => {},
  };
  const avatar = new DesktopAvatar({ dataDirectory: directory, mainDirectory: directory,
    isMainSender: () => false, showMain: () => {}, activity: () => ({ running: 1, approvals: 0 }), ...options }, runtime);
  avatar.initialize();
  t.after(() => { avatar.dispose(); rmSync(directory, { recursive: true, force: true }); });
  const saved = () => new AvatarSettingsStore(join(directory, 'desktop-avatar.json')).get();
  return { avatar, windows, handlers, windowOptions, workAreas, saved };
}

test('avatar stays hidden until loaded and applies the latest toggle and kind', async (t) => {
  const { avatar, windows } = fixture(t);
  const first = avatar.update({ enabled: true });
  const window = windows[0];
  await avatar.update({ enabled: false });
  const latest = avatar.update({ enabled: true, kind: 'cat' });
  assert.equal(windows.length, 1);
  assert.equal(window.shown, 0, 're-enabling must not show an unloaded transparent window');
  window.resolve();
  await Promise.all([first, latest]);
  assert.equal(window.visible, true);
  assert.equal((window.updates.at(-1) as { kind: string }).kind, 'cat');
});

test('avatar failed load is destroyed and an explicit retry creates a fresh window', async (t) => {
  const { avatar, windows } = fixture(t);
  const failed = avatar.update({ enabled: true });
  windows[0].reject(new Error('Missing avatar page'));
  await assert.rejects(failed, /Missing avatar page/);
  assert.equal(windows[0].destroyed, true);
  const retry = avatar.update({ enabled: true });
  assert.equal(windows.length, 2);
  windows[1].resolve();
  await retry;
  assert.equal(windows[1].visible, true);
  windows[1].webContents.emit('render-process-gone');
  assert.equal(windows[1].destroyed, true, 'a crashed renderer must not leave a blank always-on-top window');
});

test('avatar initialization is idempotent, rejects subframes, and disposal wins over pending load', async (t) => {
  const { avatar, windows, handlers } = fixture(t);
  avatar.initialize();
  assert.equal(handlers.size, 5);
  const loading = avatar.update({ enabled: true });
  const window = windows[0];
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  assert.equal((handlers.get('avatar:get')!(event) as { enabled: boolean }).enabled, true);
  assert.throws(() => handlers.get('avatar:get')!({ ...event, senderFrame: {} }), /Untrusted avatar frame/);
  avatar.dispose();
  window.resolve();
  await loading;
  assert.equal(handlers.size, 0);
  assert.equal(window.destroyed, true);
  assert.equal(window.shown, 0);
});

test('avatar voice bridge accepts only narrow commands from a trusted top-level frame', async (t) => {
  const commands: VoiceCommand[] = [];
  const { avatar, windows, handlers } = fixture(t, {
    voice: () => ({ active: true, phase: 'listening', muted: false, speaking: false, threadId: 'private-thread', error: 'private provider error' } as never),
    onVoiceCommand: async (command) => { commands.push(command); },
  });
  const loading = avatar.update({ enabled: true });
  const window = windows[0];
  window.resolve();
  await loading;
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  const invoke = handlers.get('avatar:voice-control')!;
  for (const command of ['open', 'stop', 'toggleMute', 'interrupt']) await invoke(event, command);
  assert.deepEqual(commands, ['open', 'stop', 'toggleMute', 'interrupt']);
  assert.deepEqual(avatar.snapshot().voice, { active: true, phase: 'listening', muted: false, speaking: false });
  for (const command of ['start', 'approve', 'cancelTask', 'sendMessage', { command: 'open' }, undefined]) {
    await assert.rejects(async () => invoke(event, command), /Unknown voice control/);
  }
  await assert.rejects(async () => invoke({ ...event, senderFrame: {} }, 'open'), /Untrusted avatar frame/);
  const unrelated = { mainFrame: {} };
  await assert.rejects(async () => invoke({ sender: unrelated, senderFrame: unrelated.mainFrame }, 'open'), /Untrusted avatar request/);
  assert.equal(commands.length, 4);
});

test('avatar actual visibility notifies once for show hide and renderer death', async (t) => {
  const transitions: boolean[] = [];
  const { avatar, windows } = fixture(t, { onVisibilityChange: (visible) => { transitions.push(visible); } });
  const loading = avatar.update({ enabled: true });
  assert.equal(avatar.snapshot().enabled, true);
  assert.equal(avatar.visible(), false, 'enabled but still loading is not a visible consent surface');
  windows[0].resolve();
  await loading;
  assert.equal(avatar.visible(), true);
  await avatar.update({ enabled: true, kind: 'cat' });
  await avatar.update({ enabled: false });
  assert.equal(avatar.visible(), false);
  await avatar.update({ enabled: true });
  windows[0].webContents.emit('render-process-gone');
  assert.equal(avatar.visible(), false);
  assert.deepEqual(transitions, [true, false, true, false]);
});

test('missing voice implementation fails visibly without widening avatar bridge', async (t) => {
  const { avatar, windows, handlers } = fixture(t);
  const loading = avatar.update({ enabled: true });
  windows[0].resolve();
  await loading;
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  assert.equal(avatar.snapshot().voice, undefined);
  await assert.rejects(async () => handlers.get('avatar:voice-control')!(event, 'open'), /Voice controls are unavailable/);
});

test('voice callback failures propagate and do not alter avatar settings', async (t) => {
  const { avatar, windows, handlers } = fixture(t, { onVoiceCommand: () => { throw new Error('Voice session ended'); } });
  const loading = avatar.update({ enabled: true });
  windows[0].resolve();
  await loading;
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  await assert.rejects(async () => handlers.get('avatar:voice-control')!(event, 'toggleMute'), /Voice session ended/);
  assert.equal(avatar.visible(), true);
  assert.equal(avatar.snapshot().enabled, true);
});

test('minimized avatar is not an accessible background microphone control surface', async (t) => {
  const transitions: boolean[] = [];
  const { avatar, windows, windowOptions } = fixture(t, { onVisibilityChange: (visible) => { transitions.push(visible); } });
  const loading = avatar.update({ enabled: true });
  windows[0].resolve();
  await loading;
  assert.equal(windowOptions[0].minimizable, false);
  assert.equal(avatar.visible(), true);
  // Some window managers can force a state despite a minimizable:false hint. isVisible stays
  // true in Electron when minimized, so lifecycle checks must also consult isMinimized.
  windows[0].minimize();
  assert.equal(windows[0].isVisible(), true);
  assert.equal(avatar.visible(), false);
  windows[0].restore();
  assert.equal(avatar.visible(), true);
  assert.deepEqual(transitions, [true, false, true]);
});

test('avatar drag coalesces writes and saves only the latest native position', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { avatar, windows, saved } = fixture(t);
  const loading = avatar.update({ enabled: true, kind: 'cat' });
  const window = windows[0];
  window.resolve();
  await loading;
  window.move(240, 200);
  t.mock.timers.tick(250);
  window.move(360, 420);
  t.mock.timers.tick(399);
  assert.equal(saved().x, null, 'dragging must not synchronously write on every movement');
  t.mock.timers.tick(1);
  assert.deepEqual(saved(), { enabled: true, kind: 'cat', x: 360, y: 420 });
});

for (const ending of ['hide', 'disable', 'dispose', 'crash', 'destroy'] as const) {
  test(`avatar preserves the final drag when ${ending} occurs before the debounce`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { avatar, windows, saved, windowOptions } = fixture(t);
    const loading = avatar.update({ enabled: true, kind: 'robot' });
    const window = windows[0];
    window.resolve();
    await loading;
    window.move(200, 180);
    t.mock.timers.tick(100);
    window.move(620, 460);
    assert.equal(saved().x, null);
    if (ending === 'hide') window.hide();
    else if (ending === 'disable') await avatar.update({ enabled: false });
    else if (ending === 'dispose') avatar.dispose();
    else if (ending === 'crash') window.webContents.emit('render-process-gone');
    else window.destroy();
    const expected = { enabled: ending !== 'disable', kind: 'robot', x: 620, y: 460 };
    assert.deepEqual(saved(), expected, 'closing must flush the cached coordinates even after native destruction');
    t.mock.timers.tick(1000);
    assert.deepEqual(saved(), expected, 'the discarded debounce must not overwrite later settings');
    if (ending === 'crash' || ending === 'destroy') {
      const retry = avatar.update({ enabled: true });
      assert.equal(windowOptions[1].x, 620);
      assert.equal(windowOptions[1].y, 460);
      windows[1].resolve();
      await retry;
    }
  });
}

test('avatar restore keeps its full bounds on negative-origin displays and recovers an unplugged display', async (t) => {
  const { avatar, windows, windowOptions, workAreas } = fixture(t);
  workAreas.unshift({ x: -1000, y: 0, width: 1000, height: 800 });
  const loading = avatar.update({ enabled: true, x: -30, y: 790 });
  windows[0].resolve();
  await loading;
  assert.equal(windowOptions[0].x, -180);
  assert.equal(windowOptions[0].y, 592);
  windows[0].move(-450, 320);
  windows[0].webContents.emit('render-process-gone');
  workAreas.shift();
  const retry = avatar.update({ enabled: true });
  assert.equal(windowOptions[1].x, 0, 'an unplugged negative-origin monitor must not strand the avatar');
  assert.equal(windowOptions[1].y, 320);
  assert.equal(windowOptions[1].width, 180);
  assert.equal(windowOptions[1].height, 208);
  windows[1].resolve();
  await retry;
});
