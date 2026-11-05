/** A headless window has no native tray/menu host. Keep every other Electron API real. */
import * as actual from 'electron';
import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
export * from 'electron';
export class BrowserWindow extends actual.BrowserWindow {
  constructor(options: Electron.BrowserWindowConstructorOptions) {
    writeSync(2, '[smoke] creating real offscreen BrowserWindow\n');
    super({ ...options, show: false,
      webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    (globalThis as any).__hagProductionSmoke.boundaries.offscreenWindows++;
    writeSync(2, '[smoke] real offscreen BrowserWindow created\n');
  }
}
export class Tray extends EventEmitter {
  constructor(..._args: unknown[]) {
    super();
    (globalThis as any).__hagProductionSmoke.boundaries.trayStartupSuppressed++;
    writeSync(2, '[smoke] headless tray constructed\n');
  }
  setToolTip(_text: string): void {}
  setContextMenu(_menu: unknown): void {}
  destroy(): void { this.removeAllListeners(); }
}
export class Menu {
  static buildFromTemplate(_template: unknown): Menu {
    (globalThis as any).__hagProductionSmoke.boundaries.menuConstructionSuppressed++;
    writeSync(2, '[smoke] headless tray menu constructed\n');
    return new Menu();
  }
  popup(): never { throw new Error('HAG smoke does not exercise native context menus'); }
}
export default { ...actual, BrowserWindow, Tray, Menu };
