import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent, type Rectangle, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AppEventBus } from './appEvents';
import { isAppearancePage } from './appearance';
import { isDetachableToolWindow, type DetachedBounds, type DetachedShellSnapshot, type DetachedShellAction, type DetachedModelChoice } from '../api/detachedWindows';

const CHANNELS = ['create', 'close', 'dock', 'focus', 'list', 'ready', 'publish-shell', 'action', 'resolve-action'];
const PANEL_EVENTS = new Set(['agents:changed', 'agents:activity', 'agents:content', 'snitch:changed', 'orchestrator:log', 'orchestrator:activity', 'orchestrator:content', 'orchestrator:carbon']);

/** Keep the entire window reachable after unplugging a monitor; reject corrupt persisted geometry. */
export function detachedBounds(value: unknown, workArea: Rectangle): Rectangle {
  const input = value as Partial<DetachedBounds> | null;
  const finite = (key: keyof DetachedBounds, fallback: number) => typeof input?.[key] === 'number' && Number.isFinite(input[key]) ? Math.round(input[key]!) : fallback;
  const width = Math.min(workArea.width, Math.max(280, finite('width', 500)));
  const height = Math.min(workArea.height, Math.max(180, finite('height', 400)));
  return {
    x: Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, finite('x', workArea.x + 40))),
    y: Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, finite('y', workArea.y + 40))),
    width, height,
  };
}

interface WindowRecord { window: BrowserWindow; toolWindowId: string; closing: 'closed' | 'docked'; loaded: Promise<void> }
interface Options {
  mainWindow(): BrowserWindow | null;
  showMain(): void;
  events: AppEventBus;
  background(): string;
  rendererDirectory?: string;
  devServerUrl?: string;
  createWindow?(bounds: Rectangle): BrowserWindow;
  ipc?: Pick<typeof ipcMain, 'handle' | 'removeHandler'>;
  workArea?(bounds?: DetachedBounds): Rectangle;
}

/** Owns only app-created panel windows. It never grants them the main renderer's IPC authority. */
export class DetachedWindowManager {
  private windows = new Map<string, WindowRecord>();
  private pending = new Map<string, { record: WindowRecord; finish(choice: DetachedModelChoice | null): void }>();
  private shell: DetachedShellSnapshot | null = null;
  private revision = 0;
  private initialized = false;
  private disposing = false;
  private unsubscribe?: () => void;
  private readonly ipc;
  private readonly rendererDirectory;
  constructor(private readonly options: Options) {
    this.ipc = options.ipc ?? ipcMain;
    this.rendererDirectory = options.rendererDirectory ?? join(__dirname, '../renderer');
  }

  ownsWebContents(contents: WebContents): boolean {
    return [...this.windows.values()].some(({ window }) => !window.isDestroyed() && window.webContents === contents);
  }
  /** For narrowly shared native UI actions; ownership alone does not authorize a subframe or navigated page. */
  ownsFrame(event: IpcMainInvokeEvent): boolean {
    try { this.owner(event); return true; } catch { return false; }
  }
  private main(event: IpcMainInvokeEvent): boolean {
    const owner = this.options.mainWindow();
    return !!owner && !owner.isDestroyed() && event.sender === owner.webContents && event.senderFrame === event.sender.mainFrame
      && isAppearancePage(event.senderFrame?.url ?? '', 'index.html', this.rendererDirectory, this.options.devServerUrl);
  }
  private requireMain(event: IpcMainInvokeEvent): void {
    if (!this.main(event)) throw new Error('This action is only available in the main Antimatter window.');
  }
  private owner(event: IpcMainInvokeEvent, id?: string): WindowRecord {
    const record = [...this.windows.values()].find(({ window }) => !window.isDestroyed() && window.webContents === event.sender);
    if (!record || (id !== undefined && record.toolWindowId !== id) || event.senderFrame !== event.sender.mainFrame
      || !isAppearancePage(event.senderFrame?.url ?? '', 'detached.html', this.rendererDirectory, this.options.devServerUrl)) {
      throw new Error('This action is only available in its detached Antimatter panel.');
    }
    return record;
  }
  private notify(channel: string, payload: unknown): void {
    const main = this.options.mainWindow();
    if (main && !main.isDestroyed() && !main.webContents.isDestroyed()) main.webContents.send(channel, payload);
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.unsubscribe = this.options.events.subscribe(({ channel, payload }) => {
      if (PANEL_EVENTS.has(channel)) this.broadcast(channel, payload);
    });
    const handle = (name: string, callback: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => this.ipc.handle(`detached:${name}`, callback);
    handle('create', (event, id: string, bounds?: DetachedBounds) => { this.requireMain(event); return this.create(id, bounds); });
    for (const kind of ['close', 'dock', 'focus'] as const) {
      handle(kind, (event, id: string) => {
        if (!this.main(event)) this.owner(event, id);
        const record = this.windows.get(id);
        if (!record || record.window.isDestroyed()) return;
        if (kind === 'focus') { record.window.show(); record.window.focus(); return; }
        record.closing = kind === 'dock' ? 'docked' : 'closed';
        record.window.close();
        if (kind === 'dock') this.options.showMain();
      });
    }
    handle('list', (event) => { this.requireMain(event); return [...this.windows.values()].filter(({ window }) => !window.isDestroyed()).map((record) => this.state(record)); });
    handle('ready', (event) => ({ toolWindowId: this.owner(event).toolWindowId, revision: this.revision, shell: this.shell }));
    handle('publish-shell', (event, shell: DetachedShellSnapshot) => {
      this.requireMain(event);
      this.shell = shell;
      this.broadcast('detached:shell', { revision: ++this.revision, shell });
    });
    handle('action', (event, action: DetachedShellAction) => {
      const record = this.owner(event);
      this.validateAction(action);
      // A new picker supersedes this window's previous picker. Closed windows cannot receive choices.
      for (const pending of this.pending.values()) if (pending.record === record) pending.finish(null);
      this.options.showMain();
      const requestId = randomUUID();
      return new Promise<DetachedModelChoice | null>((resolve) => {
        const timer = setTimeout(() => finish(null), 10 * 60_000);
        timer.unref();
        const finish = (choice: DetachedModelChoice | null) => { clearTimeout(timer); this.pending.delete(requestId); resolve(choice); };
        this.pending.set(requestId, { record, finish });
        this.notify('detached:action', { requestId, action });
      });
    });
    handle('resolve-action', (event, requestId: string, choice: DetachedModelChoice | null) => {
      this.requireMain(event);
      if (choice && (typeof choice.providerId !== 'string' || typeof choice.modelId !== 'string')) throw new Error('Invalid model choice.');
      this.pending.get(requestId)?.finish(choice);
    });
  }

  private validateAction(action: DetachedShellAction): void {
    if (!action || typeof action !== 'object') throw new Error('Invalid panel action.');
    if (action.type === 'openPage' && ['hub', 'orchestrator'].includes(action.page)) return;
    if (action.type === 'selectProvider' && typeof action.providerId === 'string' && action.providerId.length <= 256) return;
    if (action.type === 'openModelLibrary') {
      if (action.request === undefined) return;
      if (!action.request || typeof action.request.title !== 'string') throw new Error('Invalid model picker.');
      for (const value of Object.values(action.request)) if (value !== null && value !== undefined && (typeof value !== 'string' || value.length > 4096)) throw new Error('Invalid model picker.');
      return;
    }
    throw new Error('Unsupported panel action.');
  }
  private state(record: WindowRecord) { return { toolWindowId: record.toolWindowId, bounds: record.window.getBounds() }; }
  private broadcast(channel: string, payload: unknown): void {
    for (const { window } of this.windows.values()) if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
  appearanceChanged(settings: unknown, background: string): void {
    for (const { window } of this.windows.values()) if (!window.isDestroyed()) window.setBackgroundColor(background);
    this.broadcast('appearance:changed', settings);
  }

  async create(id: string, saved?: DetachedBounds): Promise<{ toolWindowId: string; bounds: DetachedBounds }> {
    if (!this.initialized || this.disposing) throw new Error('Detached windows are unavailable.');
    if (!isDetachableToolWindow(id)) throw new Error('This panel cannot be detached.');
    const existing = this.windows.get(id);
    if (existing && !existing.window.isDestroyed()) { await existing.loaded; existing.window.show(); existing.window.focus(); return this.state(existing); }
    const safe = detachedBounds(saved, { x: -100000, y: -100000, width: 200000, height: 200000 });
    const area = this.options.workArea?.(saved) ?? (saved ? screen.getDisplayMatching(safe) : screen.getPrimaryDisplay()).workArea;
    const bounds = detachedBounds(saved, area);
    const window = this.options.createWindow?.(bounds) ?? new BrowserWindow({
      ...bounds, minWidth: Math.min(280, area.width), minHeight: Math.min(180, area.height), title: 'Antimatter', show: false,
      backgroundColor: this.options.background(),
      webPreferences: { preload: join(__dirname, '../preload/index.js'), nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: true },
    });
    const record: WindowRecord = { window, toolWindowId: id, closing: 'closed', loaded: Promise.resolve() };
    this.windows.set(id, record);
    let lastBounds = bounds;
    const capture = () => {
      if (window.isDestroyed()) return;
      lastBounds = window.getBounds();
      this.notify('detached:bounds', { toolWindowId: id, bounds: lastBounds });
    };
    window.on('move', capture);
    window.on('resize', capture);
    window.on('close', capture);
    window.on('closed', () => {
      if (this.windows.get(id) !== record) return;
      this.windows.delete(id);
      for (const pending of this.pending.values()) if (pending.record === record) pending.finish(null);
      if (!this.disposing) this.notify('detached:changed', { toolWindowId: id, bounds: lastBounds, kind: record.closing });
    });
    // A panel never navigates to arbitrary content with the application preload still attached.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-redirect', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    record.loaded = (this.options.devServerUrl
      ? window.loadURL(new URL('detached.html', this.options.devServerUrl).href)
      : window.loadFile(join(this.rendererDirectory, 'detached.html'))).then(() => {
      if (window.isDestroyed() || this.windows.get(id) !== record) throw new Error('The detached panel closed while loading.');
      window.show();
      this.notify('detached:changed', { ...this.state(record), kind: 'opened' });
    }).catch((error: unknown) => { if (!window.isDestroyed()) window.destroy(); throw error; });
    await record.loaded;
    return this.state(record);
  }

  dispose(): void {
    this.disposing = true;
    this.unsubscribe?.();
    for (const pending of this.pending.values()) pending.finish(null);
    for (const { window } of this.windows.values()) if (!window.isDestroyed()) window.destroy();
    this.windows.clear();
    for (const name of CHANNELS) this.ipc.removeHandler(`detached:${name}`);
    this.initialized = false;
  }
}
