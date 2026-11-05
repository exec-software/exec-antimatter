import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { DetachedWindowManager, detachedBounds } from '../src/main/detachedWindows';
import { AppEventBus } from '../src/main/appEvents';
import { isDetachableToolWindow } from '../src/api/detachedWindows';
import { mayReadAppearance, mayUpdateAppearance } from '../src/main/appearance';

class Window extends EventEmitter {
  destroyed = false;
  shown = 0;
  bounds = { x: 10, y: 20, width: 500, height: 400 };
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: 'file:///fixture/detached.html' }, messages: [] as Array<{ channel: string; payload: any }>,
    isDestroyed: () => this.destroyed,
    send: (channel: string, payload: any) => this.webContents.messages.push({ channel, payload }),
    setWindowOpenHandler: (_handler: unknown) => {},
  });
  loading: Promise<void> = Promise.resolve();
  loadFile() { return this.loading; }
  loadURL() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  getBounds() { return this.bounds; }
  show() { this.shown++; }
  focus() {}
  close() { this.emit('close'); this.destroy(); }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  setBackgroundColor() {}
  event() { return { sender: this.webContents, senderFrame: this.webContents.mainFrame }; }
}
function fixture(t: test.TestContext) {
  const main = new Window(); main.webContents.mainFrame.url = 'file:///fixture/index.html';
  const windows: Window[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const events = new AppEventBus();
  const manager = new DetachedWindowManager({
    mainWindow: () => main as any, events, background: () => '#141414', showMain: () => main.show(), rendererDirectory: '/fixture',
    workArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    createWindow: (bounds) => { const window = new Window(); window.bounds = bounds; windows.push(window); return window as any; },
    ipc: { handle: (name, callback) => { assert.equal(handlers.has(name), false); handlers.set(name, callback); }, removeHandler: (name) => { handlers.delete(name); } },
  });
  manager.initialize(); t.after(() => manager.dispose());
  const call = (window: Window, method: string, ...args: any[]) => handlers.get(`detached:${method}`)!(window.event(), ...args);
  return { main, windows, handlers, events, manager, call };
}

test('geometry remains reachable after monitor removal and malformed geometry is bounded', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(detachedBounds({ x: 4000, y: -300, width: 500, height: 400 }, area), { x: -500, y: 0, width: 500, height: 400 });
  assert.deepEqual(detachedBounds({ x: Infinity, y: NaN, width: 20000, height: -10 }, area), { x: -1920, y: 40, width: 1920, height: 180 });
  assert.equal(isDetachableToolWindow('preview.viewer'), false);
  assert.equal(isDetachableToolWindow('terminal.shell'), false);
  assert.equal(isDetachableToolWindow('unknown.panel'), false);
});

test('shared native picker authority includes only live owned detached main frames', async (t) => {
  const f = fixture(t);
  await f.call(f.main, 'create', 'snitch.items');
  const child = f.windows[0];
  assert.equal(f.manager.ownsFrame(child.event() as any), true);
  assert.equal(f.manager.ownsFrame(f.main.event() as any), false, 'main-window authorization remains separate');
  assert.equal(f.manager.ownsFrame({ ...child.event(), senderFrame: { url: child.webContents.mainFrame.url } } as any), false);
  child.webContents.mainFrame.url = 'https://outside.invalid/detached.html';
  assert.equal(f.manager.ownsFrame(child.event() as any), false);
  child.webContents.mainFrame.url = 'file:///fixture/detached.html';
  child.destroy();
  assert.equal(f.manager.ownsFrame(child.event() as any), false);
});

test('create is idempotent, renderer ready pulls identity after load, and only panel events relay', async (t) => {
  const f = fixture(t);
  f.manager.initialize();
  await f.call(f.main, 'create', 'core.sources');
  await f.call(f.main, 'create', 'core.sources');
  assert.equal(f.windows.length, 1);
  const child = f.windows[0];
  assert.deepEqual(f.call(child, 'ready'), { toolWindowId: 'core.sources', revision: 0, shell: null });
  f.call(f.main, 'publish-shell', { workspace: '/project', conversation: null, sources: { providers: [], activeProviderId: '', activeModelId: '' } });
  assert.equal(f.call(child, 'ready').shell.workspace, '/project');
  assert.equal(f.call(child, 'ready').revision, 1);
  f.events.publish('agents:changed', { at: 1 });
  f.events.publish('chat:content', { content: 'private conversation event' });
  assert.deepEqual(child.webContents.messages.map((event) => event.channel), ['detached:shell', 'agents:changed']);
  assert.equal(f.events.listenerCount(), 1);
});

test('only main creates/publishes; detached frames control only their own panel and cannot navigate', async (t) => {
  const f = fixture(t);
  await f.call(f.main, 'create', 'core.sources');
  await f.call(f.main, 'create', 'vitals.monitor');
  const child = f.windows[0];
  assert.throws(() => f.call(child, 'create', 'agents.tasks'), /main Antimatter/);
  assert.throws(() => f.call(child, 'publish-shell', {}), /main Antimatter/);
  assert.throws(() => f.call(child, 'close', 'vitals.monitor'), /its detached/);
  assert.throws(() => f.handlers.get('detached:ready')!({ sender: child.webContents, senderFrame: { url: 'file:///fixture/detached.html' } }), /its detached/);
  child.webContents.mainFrame.url = 'https://example.test/';
  assert.throws(() => f.call(child, 'ready'), /its detached/);
  let blocked = 0;
  for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) child.webContents.emit(event, { preventDefault() { blocked++; } });
  assert.equal(blocked, 3);
  await assert.rejects(f.call(f.main, 'create', 'terminal.shell'), /cannot be detached/);
  await assert.rejects(f.call(f.main, 'create', 'arbitrary.id'), /cannot be detached/);
});

test('bounds and native close/dock reach main once; closing does not recurse into renderer', async (t) => {
  const f = fixture(t);
  await f.call(f.main, 'create', 'core.sources');
  const child = f.windows[0];
  child.bounds.x = 200; child.emit('move');
  assert.equal(f.main.webContents.messages.at(-1)?.payload.bounds.x, 200);
  f.call(child, 'dock', 'core.sources');
  assert.equal(child.destroyed, true);
  assert.deepEqual(f.main.webContents.messages.at(-1)?.payload, { toolWindowId: 'core.sources', bounds: child.bounds, kind: 'docked' });
  assert.equal(f.main.shown, 1);
  await f.call(f.main, 'create', 'core.sources');
  f.windows[1].close();
  assert.equal(f.main.webContents.messages.at(-1)?.payload.kind, 'closed');
  assert.deepEqual(f.call(f.main, 'list'), []);
  assert.equal(child.webContents.messages.some(({ channel }) => channel === 'detached:close'), false);
});

test('failed window load releases ownership and a subsequent retry can create a working window', async (t) => {
  const f = fixture(t);
  const original = (f.manager as any).options.createWindow;
  (f.manager as any).options.createWindow = (bounds: any) => { const window = original(bounds); window.loading = Promise.reject(new Error('missing detached bundle')); return window; };
  await assert.rejects(f.call(f.main, 'create', 'core.sources'), /missing detached bundle/);
  assert.equal(f.windows[0].destroyed, true);
  assert.deepEqual(f.call(f.main, 'list'), []);
  (f.manager as any).options.createWindow = original;
  await f.call(f.main, 'create', 'core.sources');
  assert.equal(f.call(f.main, 'list').length, 1);
});

test('model choice callbacks are main-owned and cannot reach a closed/reopened panel', async (t) => {
  const f = fixture(t);
  await f.call(f.main, 'create', 'agents.roster');
  const child = f.windows[0];
  const choice = f.call(child, 'action', { type: 'openModelLibrary', request: { title: 'Agent model' } });
  const requestId = f.main.webContents.messages.at(-1)?.payload.requestId;
  assert.throws(() => f.call(child, 'resolve-action', requestId, { providerId: 'spoof', modelId: 'spoof' }), /main Antimatter/);
  f.call(f.main, 'resolve-action', requestId, { providerId: 'local', modelId: 'model' });
  assert.deepEqual(await choice, { providerId: 'local', modelId: 'model' });
  const oldChoice = f.call(child, 'action', { type: 'openModelLibrary', request: { title: 'Old picker' } });
  const oldId = f.main.webContents.messages.at(-1)?.payload.requestId;
  child.close();
  assert.equal(await oldChoice, null);
  await f.call(f.main, 'create', 'agents.roster');
  f.call(f.main, 'resolve-action', oldId, { providerId: 'late', modelId: 'late' });
  assert.equal(f.windows[1].webContents.messages.length, 0);
  assert.throws(() => f.call(f.windows[1], 'action', { type: 'openPage', page: 'arbitrary' }), /Unsupported/);
});

test('application shutdown preserves restoration state and removes subscriptions and handlers', async (t) => {
  const f = fixture(t);
  await f.call(f.main, 'create', 'core.sources');
  const before = f.main.webContents.messages.length;
  f.manager.dispose();
  assert.equal(f.main.webContents.messages.length, before);
  assert.equal(f.events.listenerCount(), 0);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.windows[0].destroyed, true);
  assert.equal(mayReadAppearance('detached', true, true), true);
  assert.equal(mayUpdateAppearance('detached', true, true), false);
});
