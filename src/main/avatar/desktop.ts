import { BrowserWindow, ipcMain, Menu, screen, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import { join } from 'node:path';
import { AVATARS, AvatarSettingsStore, avatarPosition, type DesktopAvatarSettings } from './settings';
import type { VoiceCommand, VoiceState } from '../../api/voice';
import type { AppearanceSettings } from '../../api/appearance';
import { isAppearancePage } from '../appearance';

export type AvatarVoiceState = Pick<VoiceState, 'active' | 'phase' | 'muted' | 'speaking'>;

export interface AvatarRuntime {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  ipc: Pick<typeof ipcMain, 'handle' | 'removeHandler'>;
  workAreas(): Rectangle[];
  menu(template: MenuItemConstructorOptions[], window?: BrowserWindow): void;
}
const DESKTOP_RUNTIME: AvatarRuntime = {
  createWindow: (options) => new BrowserWindow(options),
  ipc: ipcMain,
  workAreas: () => screen.getAllDisplays().map((display) => display.workArea),
  menu: (template, window) => Menu.buildFromTemplate(template).popup({ window }),
};
const CHANNELS = ['avatar:get', 'avatar:update', 'avatar:openApp', 'avatar:menu', 'avatar:voice-control'];
const VOICE_COMMANDS = new Set<VoiceCommand>(['open', 'stop', 'toggleMute', 'interrupt']);

/** A separate, opt-in desktop companion. Untrusted previews never receive this bridge. */
export class DesktopAvatar {
  private window: BrowserWindow | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPosition: { x: number; y: number } | null = null;
  private stopping = false;
  private initialized = false;
  private loading: Promise<void> | null = null;
  private lastVisible = false;
  private readonly store: AvatarSettingsStore;
  constructor(private readonly options: {
    dataDirectory: string;
    mainDirectory: string;
    isMainSender: (event: IpcMainInvokeEvent) => boolean;
    showMain: () => void;
    activity: () => { running: number; approvals: number };
    voice?: () => AvatarVoiceState;
    onVoiceCommand?: (command: VoiceCommand) => void | Promise<void>;
    onVisibilityChange?: (visible: boolean) => void;
  }, private readonly runtime: AvatarRuntime = DESKTOP_RUNTIME) {
    this.store = new AvatarSettingsStore(join(options.dataDirectory, 'desktop-avatar.json'));
  }
  initialize(): void {
    if (this.initialized || this.stopping) return;
    this.initialized = true;
    const authorize = (event: IpcMainInvokeEvent) => {
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted avatar frame.');
      if (!this.options.isMainSender(event) && event.sender !== this.window?.webContents) throw new Error('Untrusted avatar request.');
    };
    this.runtime.ipc.handle('avatar:get', (event) => { authorize(event); return this.snapshot(); });
    this.runtime.ipc.handle('avatar:update', async (event, patch: unknown) => {
      authorize(event);
      if (!patch || typeof patch !== 'object') throw new Error('Invalid avatar settings.');
      const input = patch as Record<string, unknown>;
      if ('enabled' in input && typeof input.enabled !== 'boolean') throw new Error('Invalid avatar visibility.');
      if ('kind' in input && !AVATARS.includes(input.kind as never)) throw new Error('Unknown avatar.');
      const next = this.store.update({ ...('enabled' in input ? { enabled: input.enabled as boolean } : {}),
        ...('kind' in input ? { kind: input.kind as DesktopAvatarSettings['kind'] } : {}) });
      await this.apply(next);
      return this.snapshot();
    });
    this.runtime.ipc.handle('avatar:openApp', (event) => { authorize(event); this.options.showMain(); });
    this.runtime.ipc.handle('avatar:voice-control', async (event, command: unknown) => {
      authorize(event);
      if (typeof command !== 'string' || !VOICE_COMMANDS.has(command as VoiceCommand)) throw new Error('Unknown voice control.');
      if (!this.options.onVoiceCommand) throw new Error('Voice controls are unavailable. Open Antimatter.');
      // No free-form transcript, approval, task cancellation, or mic-start request is accepted.
      // Opening voice shows the consent/configuration UI; only that main UI can start capture.
      await this.options.onVoiceCommand(command as VoiceCommand);
      return this.snapshot();
    });
    this.runtime.ipc.handle('avatar:menu', (event) => {
      authorize(event);
      const settings = this.store.get();
      this.runtime.menu([
        { label: 'Open Antimatter', click: this.options.showMain },
        ...AVATARS.map((kind) => ({ label: kind[0].toUpperCase() + kind.slice(1), type: 'radio' as const, checked: settings.kind === kind,
          click: () => { void this.update({ kind }).catch(console.error); } })),
        { type: 'separator' },
        { label: 'Hide avatar', click: () => { void this.update({ enabled: false }).catch(console.error); } },
      ], this.window ?? undefined);
    });
    void this.apply(this.store.get()).catch((error) => console.error('[avatar] restore failed:', error));
  }
  async update(patch: Partial<DesktopAvatarSettings>): Promise<void> { await this.apply(this.store.update(patch)); }
  snapshot() {
    const voice = this.options.voice?.();
    return { ...this.store.get(), ...this.options.activity(), ...(voice ? {
      voice: { active: voice.active, phase: voice.phase, muted: voice.muted, speaking: voice.speaking },
    } : {}) };
  }
  /** Actual visible surface, not a saved enabled preference while a page is loading/crashed. */
  visible(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible() && !this.window.isMinimized());
  }
  ownsWebContents(contents: Electron.WebContents): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && !contents.isDestroyed() && this.window.webContents === contents);
  }
  sendAppearance(settings: AppearanceSettings): void {
    if (!this.window || this.window.isDestroyed()) return;
    const contents = this.window.webContents;
    if (this.ownsWebContents(contents) && isAppearancePage(contents.getURL(), 'avatar.html', join(this.options.mainDirectory, '../renderer'), process.env.VITE_DEV_SERVER_URL)) {
      contents.send('appearance:changed', settings);
    }
  }
  private notifyVisibility(): void {
    const visible = this.visible();
    if (this.lastVisible === visible) return;
    this.lastVisible = visible;
    try { this.options.onVisibilityChange?.(visible); }
    catch (error) { console.error('[avatar] visibility callback failed:', error); }
  }
  private flushPosition(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    if (!this.pendingPosition) return;
    try {
      this.store.update(this.pendingPosition);
      this.pendingPosition = null;
    } catch (error) { console.error('[avatar] position not saved:', error); }
  }
  private async apply(settings: DesktopAvatarSettings): Promise<void> {
    if (this.stopping) return;
    if (!settings.enabled) {
      if (this.window && !this.window.isDestroyed()) this.window.hide();
      this.notifyVisibility();
      return;
    }
    if (this.loading) { await this.loading; return; }
    if (this.window && !this.window.isDestroyed()) {
      this.window.showInactive();
      this.notifyVisibility();
      this.window.webContents.send('avatar:state', this.snapshot());
      return;
    }
    const position = avatarPosition(settings, this.runtime.workAreas());
    const window = this.runtime.createWindow({ ...position, width: 180, height: 208, frame: false, transparent: true,
      alwaysOnTop: true, skipTaskbar: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, show: false,
      title: 'Antimatter avatar', webPreferences: { preload: join(this.options.mainDirectory, '../preload/avatar.js'),
        nodeIntegration: false, contextIsolation: true, sandbox: true } });
    this.window = window;
    window.on('show', () => this.notifyVisibility());
    window.on('hide', () => { this.flushPosition(); this.notifyVisibility(); });
    window.on('minimize', () => this.notifyVisibility());
    window.on('restore', () => this.notifyVisibility());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('render-process-gone', () => {
      // Never keep a blank, always-on-top window after the renderer dies. The next explicit show retries.
      if (!window.isDestroyed()) window.destroy();
    });
    window.on('close', (event) => {
      if (this.stopping) return;
      event.preventDefault();
      void this.update({ enabled: false }).catch(console.error);
    });
    window.on('move', () => {
      if (this.window !== window || window.isDestroyed()) return;
      // Capture while the native window is alive. Only the disk write is debounced, so a
      // hide, renderer crash, or quit before the timeout cannot discard the final drag.
      const [x, y] = window.getPosition();
      this.pendingPosition = { x, y };
      if (this.moveTimer) clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => this.flushPosition(), 400);
    });
    window.on('closed', () => {
      if (this.window !== window) return;
      this.flushPosition();
      this.window = null;
      this.notifyVisibility();
      if (this.timer) clearInterval(this.timer);
      if (this.moveTimer) clearTimeout(this.moveTimer);
      this.timer = null;
      this.moveTimer = null;
    });
    const loading = (async () => {
      try {
        if (process.env.VITE_DEV_SERVER_URL) await window.loadURL(new URL('avatar.html', process.env.VITE_DEV_SERVER_URL).href);
        else await window.loadFile(join(this.options.mainDirectory, '../renderer/avatar.html'));
        if (this.stopping || window.isDestroyed()) return;
        // Settings may have changed while the page was loading; publish only the latest choice.
        window.webContents.send('avatar:state', this.snapshot());
        if (this.store.get().enabled) { window.showInactive(); this.notifyVisibility(); }
        if (!this.timer) this.timer = setInterval(() => {
          try {
            if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
              this.window.webContents.send('avatar:state', this.snapshot());
            }
          } catch (error) { console.error('[avatar] status update failed:', error); }
        }, 1000);
      } catch (error) {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
    })();
    this.loading = loading;
    try { await loading; } finally { if (this.loading === loading) this.loading = null; }
  }
  dispose(): void {
    this.stopping = true;
    this.flushPosition();
    if (this.initialized) for (const channel of CHANNELS) this.runtime.ipc.removeHandler(channel);
    this.initialized = false;
    if (this.timer) clearInterval(this.timer);
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.window?.destroy();
    this.window = null;
    this.notifyVisibility();
    this.timer = null;
    this.moveTimer = null;
  }
}
