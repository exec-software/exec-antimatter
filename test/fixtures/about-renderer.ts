/** Standalone About window with no preload or real application access. */
import '../../renderer/src/about.css';

type Appearance = { theme: 'dark' | 'light'; secondaryAccent: string };
let appearance: Appearance = { theme: 'light', secondaryAccent: '#7352b6' };
const listeners = new Set<(value: Appearance) => void>();
const actions: string[] = [];
Object.assign(window, {
  electronAPI: {
    ...(new URLSearchParams(window.location.search).get('appearance') === 'missing' ? {} : {
      appearance: {
        initial: structuredClone(appearance),
        get: async () => structuredClone(appearance),
        onChanged: (callback: (value: Appearance) => void) => {
          listeners.add(callback);
          return () => { listeners.delete(callback); };
        },
      },
    }),
    about: {
      info: { name: 'Antimatter', description: 'Appearance smoke fixture', version: '1.0.0',
        electron: 'test-electron', chrome: 'test-chrome', node: 'test-node', platform: 'linux', architecture: 'x64', copyrightYear: '2026' },
      close: async () => { actions.push('close'); },
    },
  },
  aboutSmoke: {
    actions,
    emitAppearance: (next: Appearance) => {
      appearance = structuredClone(next);
      for (const callback of listeners) callback(structuredClone(appearance));
    },
    appearanceListeners: () => listeners.size,
  },
});
await import('../../renderer/src/about');
