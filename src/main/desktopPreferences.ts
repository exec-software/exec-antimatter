import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  normalizeDesktopPreferences, validateDesktopPreferencesPatch,
  type DesktopPreferences, type DesktopWindowState, type WindowAction,
} from '../api/desktopPreferences';
import { writePrivateFileAtomic } from './privateState';

const MAX_SETTINGS_BYTES = 1024 * 1024;

export class DesktopPreferencesStore {
  private current: DesktopPreferences;
  constructor(private readonly file: string, private readonly write = writePrivateFileAtomic) {
    let descriptor: number | undefined;
    let value: unknown;
    try {
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stats = fstatSync(descriptor);
      if (stats.isFile() && stats.size <= MAX_SETTINGS_BYTES) {
        const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
        const length = readSync(descriptor, buffer, 0, buffer.length, 0);
        const parsed = length <= MAX_SETTINGS_BYTES ? JSON.parse(buffer.subarray(0, length).toString('utf8')) : null;
        if (parsed?.version === 1) value = parsed;
      }
    } catch { /* A missing or malformed preference file uses safe defaults. */ }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
    this.current = normalizeDesktopPreferences(value);
  }
  get(): DesktopPreferences { return normalizeDesktopPreferences(this.current); }
  update(value: unknown): DesktopPreferences {
    const next = normalizeDesktopPreferences({ ...this.current, ...validateDesktopPreferencesPatch(value) });
    if (JSON.stringify(next) === JSON.stringify(this.current)) return this.get();
    this.write(this.file, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`);
    this.current = next;
    return this.get();
  }
}

type MainWindow = Pick<BrowserWindow, 'isDestroyed' | 'isMaximized' | 'isFullScreen' | 'isAlwaysOnTop' | 'minimize'
  | 'maximize' | 'unmaximize' | 'setFullScreen' | 'setAlwaysOnTop' | 'close' | 'webContents' | 'on' | 'removeListener'>;

export function desktopWindowState(window: MainWindow, customChrome: boolean, platform: string): DesktopWindowState {
  return { customChrome, platform, maximized: window.isMaximized(), fullscreen: window.isFullScreen(), alwaysOnTop: window.isAlwaysOnTop() };
}

/** The supplied authority must identify the main window's top frame, not merely its URL. */
export function registerDesktopPreferencesIpc(options: {
  ipcMain: IpcMain;
  store: DesktopPreferencesStore;
  getWindow(): MainWindow | null;
  authorize(event: IpcMainEvent | IpcMainInvokeEvent): void;
  platform: string;
}) {
  const { ipcMain, store, getWindow, authorize, platform } = options;
  const customWindows = new WeakMap<object, boolean>();
  const currentWindow = () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) throw new Error('The main window is unavailable.');
    return window;
  };
  const state = () => {
    const window = currentWindow();
    return desktopWindowState(window, customWindows.get(window) ?? false, platform);
  };
  const broadcast = () => {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send('desktop:changed', store.get());
    window.webContents.send('desktop:window-state', state());
  };
  ipcMain.on('desktop:initial', (event) => {
    try { authorize(event); event.returnValue = store.get(); } catch { event.returnValue = null; }
  });
  ipcMain.handle('desktop:get', (event) => { authorize(event); return store.get(); });
  ipcMain.handle('desktop:update', (event, patch: unknown) => {
    authorize(event);
    const next = store.update(patch);
    currentWindow().setAlwaysOnTop(next.alwaysOnTop);
    broadcast();
    return next;
  });
  ipcMain.handle('desktop:window-state', (event) => { authorize(event); return state(); });
  ipcMain.handle('desktop:window-action', (event, action: unknown) => {
    authorize(event);
    const window = currentWindow();
    switch (action as WindowAction) {
      case 'minimize': window.minimize(); break;
      case 'toggle-maximize': if (window.isMaximized()) window.unmaximize(); else window.maximize(); break;
      case 'toggle-fullscreen': window.setFullScreen(!window.isFullScreen()); break;
      case 'toggle-always-on-top': {
        const next = store.update({ alwaysOnTop: !window.isAlwaysOnTop() });
        window.setAlwaysOnTop(next.alwaysOnTop);
        break;
      }
      case 'close': {
        const before = state();
        window.close();
        return before;
      }
      default: throw new Error('Unknown window action.');
    }
    broadcast();
    return state();
  });
  return {
    attach(window: MainWindow, customChrome: boolean): void {
      customWindows.set(window, customChrome);
      window.on('maximize', broadcast);
      window.on('unmaximize', broadcast);
      window.on('enter-full-screen', broadcast);
      window.on('leave-full-screen', broadcast);
      window.on('always-on-top-changed', broadcast);
      window.setAlwaysOnTop(store.get().alwaysOnTop);
    },
  };
}
