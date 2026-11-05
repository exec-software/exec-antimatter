/** Test-only bridge: no preload, audio devices, network, or real application state. */
import type { VoiceCommand, VoiceState } from '../../src/api/voice';
import { themeVariables } from '../../renderer/src/theme';

type State = { kind: 'atom' | 'robot' | 'cat'; running: number; approvals: number;
  voice?: Pick<VoiceState, 'active' | 'phase' | 'muted' | 'speaking'> };
let state: State = { kind: 'atom', running: 0, approvals: 0,
  voice: { active: false, phase: 'idle', muted: false, speaking: false } };
let listener: (next: State) => void = () => {};
let resolveCommand: (() => void) | undefined;
let rejectCommand: (() => void) | undefined;
const actions: string[] = [];
type Appearance = { theme: 'dark' | 'light'; secondaryAccent: string };
let appearance: Appearance = { theme: 'dark', secondaryAccent: '#33b7a6' };
const appearanceListeners = new Set<(value: Appearance) => void>();
Object.assign(window, {
  desktopAvatar: {
    ...(new URLSearchParams(window.location.search).get('appearance') === 'missing' ? {} : {
      appearance: {
        initial: structuredClone(appearance),
        get: async () => structuredClone(appearance),
        onChanged: (callback: (value: Appearance) => void) => {
          appearanceListeners.add(callback);
          return () => { appearanceListeners.delete(callback); };
        },
      },
    }),
    get: async () => structuredClone(state),
    openApp: async () => { actions.push('openApp'); },
    menu: async () => { actions.push('menu'); },
    onState: (next: (value: State) => void) => { listener = next; return () => {}; },
    voiceControl: (command: VoiceCommand) => new Promise<State>((resolve, reject) => {
      actions.push(command);
      resolveCommand = () => {
        if (state.voice && command === 'toggleMute') state.voice.muted = !state.voice.muted;
        if (state.voice && command === 'interrupt') { state.voice.speaking = false; state.voice.phase = 'listening'; }
        if (state.voice && command === 'stop') state.voice = { active: false, phase: 'idle', muted: false, speaking: false };
        resolve(structuredClone(state));
      };
      rejectCommand = () => reject(new Error('Fixture command failed'));
    }),
  },
  avatarSmoke: {
    actions,
    expectedAccent: () => themeVariables(appearance)['--color-accent'],
    emit: (next?: State) => { if (next) state = structuredClone(next); listener(structuredClone(state)); },
    resolve: () => resolveCommand?.(),
    reject: () => rejectCommand?.(),
    emitAppearance: (next: Appearance) => {
      appearance = structuredClone(next);
      for (const callback of appearanceListeners) callback(structuredClone(appearance));
    },
    appearanceListeners: () => appearanceListeners.size,
  },
});
await import('../../renderer/src/avatar');
