import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Square } from 'lucide-react';
import { ReplyPadPanel } from '../../renderer/src/plugins/replyPad/plugin';
import { ShellProvider } from '../../renderer/src/plugins/shell';
import { ChatComposer } from '../../renderer/src/components/chat/ChatComposer';
import { DesktopPreferencesPanel } from '../../renderer/src/components/settings/DesktopPreferencesPanel';
import { HotkeysPanel } from '../../renderer/src/components/settings/HotkeysPanel';
import { AppearancePanel } from '../../renderer/src/components/settings/AppearancePanel';
import { WindowChrome } from '../../renderer/src/components/layout/WindowChrome';
import { ToolStripe } from '../../renderer/src/plugins/ToolWindowHost';
import { registerPlugin } from '../../renderer/src/plugins/registry';
import { initializeDesktopPreferences, saveDesktopPreferences, useDesktopHotkeys } from '../../renderer/src/desktopPreferences';
import { initializeAppearance } from '../../renderer/src/appearance';
import { normalizeDesktopPreferences, validateDesktopPreferencesPatch, type DesktopPreferencesAPI, type DesktopWindowState } from '../../src/api/desktopPreferences';
import { normalizeAppearance, validateAppearancePatch, type AppearanceAPI } from '../../src/api/appearance';

let preferences = normalizeDesktopPreferences({ sendClickModifier: 'ctrl' });
let appearance = normalizeAppearance(null);
const listeners = new Set<(value: typeof preferences) => void>();
const appearanceListeners = new Set<(value: typeof appearance) => void>();
const windowListeners = new Set<(value: DesktopWindowState) => void>();
let windowState: DesktopWindowState = { customChrome: true, alwaysOnTop: false, maximized: false, fullscreen: false, platform: 'linux' };
const metrics = { sends: [] as string[], steers: [] as string[], stops: 0, newChats: 0, actions: [] as string[] };
const desktop: DesktopPreferencesAPI = {
  initial: preferences, get: async () => preferences,
  update: async (patch) => { preferences = normalizeDesktopPreferences({ ...preferences, ...validateDesktopPreferencesPatch(patch) }); for (const cb of listeners) cb(preferences); return preferences; },
  onChanged: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  windowState: async () => windowState,
  onWindowState: (cb) => { windowListeners.add(cb); return () => { windowListeners.delete(cb); }; },
  windowAction: async (action) => {
    metrics.actions.push(action);
    if (action === 'toggle-maximize') windowState = { ...windowState, maximized: !windowState.maximized };
    if (action === 'toggle-fullscreen') windowState = { ...windowState, fullscreen: !windowState.fullscreen };
    if (action === 'toggle-always-on-top') windowState = { ...windowState, alwaysOnTop: !windowState.alwaysOnTop };
    for (const cb of windowListeners) cb(windowState); return windowState;
  },
};
const appearanceApi: AppearanceAPI = { initial: appearance, get: async () => appearance,
  update: async (patch) => { appearance = normalizeAppearance({ ...appearance, ...validateAppearancePatch(patch) }); for (const cb of appearanceListeners) cb(appearance); return appearance; },
  onChanged: (cb) => { appearanceListeners.add(cb); return () => { appearanceListeners.delete(cb); }; },
};
Object.assign(window, { electronAPI: { desktop, appearance: appearanceApi, systemFonts: { list: async () => [] } }, desktopSmoke: { metrics, preferences: () => preferences, update: saveDesktopPreferences, appearance: () => appearance } });
initializeDesktopPreferences(desktop); initializeAppearance(appearanceApi);
registerPlugin({ id: 'fixture', name: 'Fixture', toolWindows: [{ id: 'preview', title: 'Preview', icon: Square, anchor: 'right', component: () => null }, { id: 'terminal', title: 'Terminal', icon: Square, anchor: 'bottom', component: () => null }] } as any);
const layout = { homeOf: (id: string) => id === 'terminal' ? 'bottom' : 'right', isOpen: () => false, toggle: () => {} } as any;

function Fixture() {
  const [running, setRunning] = useState(false);
  useDesktopHotkeys({ newChat: () => { metrics.newChats++; } });
  return <><WindowChrome /><button onClick={() => setRunning(!running)}>Toggle running</button>
    <ChatComposer threadId="test" onSubmit={(text) => { metrics.sends.push(text); return true; }} streaming={running}
      onSteer={(text) => metrics.steers.push(text)} onStop={() => { metrics.stops++; }} providers={[]} providerId="" modelId=""
      onOpenModels={() => {}} access={{ mode: 'ask' } as any} onChangeAccess={() => {}} workspace={null} workspaceConfirmed onConfirmWorkspace={() => {}} />
    <ShellProvider value={{ conversation: { id: 'test', title: 'Test chat', transcript: () => '' } } as any}><ReplyPadPanel /></ShellProvider>
    <div id="tool-stripe"><ToolStripe layout={layout} /></div><HotkeysPanel /><DesktopPreferencesPanel /><AppearancePanel /></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
