import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { VoiceCommand } from '../api/voice';
import { normalizeAppearance, type AppearanceSettings } from '../api/appearance';
import { appearanceBootstrapCss } from './appearance';

const initialAppearance = (() => {
  try { return normalizeAppearance(ipcRenderer.sendSync('appearance:initial')); }
  catch { return normalizeAppearance(null); }
})();
try {
  webFrame.insertCSS(appearanceBootstrapCss(initialAppearance), { cssOrigin: 'author' });
} catch (error) { console.warn('[appearance] first-paint styling unavailable:', error); }

// Deliberately separate from the app preload: the companion cannot run tools or read chats.
contextBridge.exposeInMainWorld('desktopAvatar', {
  appearance: {
    initial: initialAppearance,
    get: (): Promise<AppearanceSettings> => ipcRenderer.invoke('appearance:get'),
    onChanged: (callback: (settings: AppearanceSettings) => void) => {
      const listener = (_event: unknown, settings: AppearanceSettings) => callback(settings);
      ipcRenderer.on('appearance:changed', listener);
      return () => ipcRenderer.removeListener('appearance:changed', listener);
    },
  },
  get: () => ipcRenderer.invoke('avatar:get'),
  openApp: () => ipcRenderer.invoke('avatar:openApp'),
  menu: () => ipcRenderer.invoke('avatar:menu'),
  voiceControl: (command: VoiceCommand) => ipcRenderer.invoke('avatar:voice-control', command),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on('avatar:state', listener);
    return () => ipcRenderer.removeListener('avatar:state', listener);
  },
});
