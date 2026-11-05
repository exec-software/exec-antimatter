/** Isolated settings fixture. No application preload, network, device, or real settings store. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE, normalizeAppearance, type AppearanceSettings } from '../../src/api/appearance';
import { normalizeNotifications, validateNotificationsPatch, type NotificationSettings } from '../../src/api/notifications';
import { SettingsPage } from '../../renderer/src/components/settings/SettingsPage';
import type { SettingsTarget } from '../../renderer/src/components/settings/navigation';
import type { ProviderConfig } from '../../renderer/src/types';
import type { VoiceConfiguration } from '../../src/api/voice';

const reads: Record<string, number> = {};
const actions: string[] = [];
const cancellations: string[] = [];
let failEngineInfo = true;
const read = <T,>(name: string, value: T) => async () => { reads[name] = (reads[name] ?? 0) + 1; return structuredClone(value); };
const action = (name: string) => async () => { actions.push(name); throw new Error(`Unexpected fixture action: ${name}`); };
const subscribe = () => () => undefined;
let appearance = normalizeAppearance(JSON.parse(localStorage.getItem('fixture.appearance') ?? JSON.stringify(DEFAULT_APPEARANCE)));
let failAppearance = false;
const appearanceWrites: AppearanceSettings[] = [];
const appearanceListeners = new Set<(next: AppearanceSettings) => void>();
let notifications = normalizeNotifications(null);
const notificationWrites: NotificationSettings[] = [];
const notificationListeners = new Set<(next: NotificationSettings) => void>();
const sources: ProviderConfig[] = [{ id: 'local', name: 'Local inference', baseUrl: 'http://127.0.0.1:6768/v1', kind: 'beholdd', protocol: 'openai-chat', models: [{ id: 'qwen3-coder-30b', name: 'Qwen3 Coder 30B' }] }];
const voice: VoiceConfiguration = {
  settings: { inputSourceId: 'local', inputModel: 'omni-30b', inputMode: 'chat-audio', speechSourceId: 'local', speechModel: 'kokoro', speechVoice: 'coral', speechEnabled: true, allowRemote: false },
  sources: [{ id: 'local', name: 'Local audio', local: true, models: ['omni-30b', 'kokoro'] }],
  state: { active: false, sessionId: null, threadId: null, phase: 'idle', muted: false, speaking: false, error: null },
};
const remote = { enabled: true, running: true, address: '192.0.2.10', port: 43128, keepAwake: false, endpoint: 'https://192.0.2.10:43128', certificatePin: 'fixture', interfaces: [{ name: 'Fixture LAN', address: '192.0.2.10', internal: false }], devices: [], error: null };
const offerId = 'abcdefghijklmnopqrstuv';
window.electronAPI = {
  appearance: {
    initial: appearance,
    get: async () => appearance,
    update: async (patch: Partial<AppearanceSettings>) => {
      if (failAppearance) { failAppearance = false; throw new Error('Synthetic disk failure'); }
      appearance = normalizeAppearance({ ...appearance, ...patch });
      localStorage.setItem('fixture.appearance', JSON.stringify(appearance));
      appearanceWrites.push(appearance);
      appearanceListeners.forEach((listener) => listener(appearance));
      return appearance;
    },
    onChanged: (listener: (next: AppearanceSettings) => void) => { appearanceListeners.add(listener); return () => { appearanceListeners.delete(listener); }; },
  },
  systemFonts: { list: read('systemFonts', [{ family: 'Fixture Sans', monospace: false }, { family: 'Fixture Mono', monospace: true }]) },
  notifications: {
    get: async () => { reads.notifications = (reads.notifications ?? 0) + 1; return notifications; },
    // Validated the way main does, so a patch the real store would refuse fails here too.
    update: async (patch: Partial<NotificationSettings>) => {
      notifications = normalizeNotifications({ ...notifications, ...validateNotificationsPatch(patch) });
      notificationWrites.push(notifications);
      notificationListeners.forEach((listener) => listener(notifications));
      return notifications;
    },
    chooseSound: action('notifications.chooseSound'),
    clearSound: action('notifications.clearSound'),
    soundData: async () => null,
    turnFinished: action('notifications.turnFinished'),
    onChanged: (listener: (next: NotificationSettings) => void) => {
      notificationListeners.add(listener);
      return () => { notificationListeners.delete(listener); };
    },
    onActivate: subscribe,
  },
  developer: { get: read('developer', { screenCapture: { withoutAsking: false }, autoContinue: { enabled: false, maxContinuations: 0 } }), set: action('developer.set') },
  setup: { get: read('setup', { assistant: { name: 'Antimatter', personality: '' }, completedAt: 1, showOnStartup: false }), updateAssistant: action('setup.updateAssistant'), complete: action('setup.complete'), onChanged: subscribe },
  user: { get: read('user', { name: 'Alex', pronouns: 'they/them', about: 'I build useful software.', updatedAt: 1 }), set: action('user.set') },
  onMemoryChanged: subscribe,
  avatar: { get: read('avatar', { enabled: true, kind: 'atom', position: null }), update: action('avatar.update') },
  providers: { storeInfo: read('providers', { path: '/fixture/private/providers.json', encrypted: true }), test: action('providers.test'), refresh: action('providers.refresh'), remove: action('providers.remove'), replaceCredential: action('providers.replaceCredential'), probe: action('providers.probe'), add: action('providers.add') },
  beholdd: {
    info: async () => {
      const info = await read('engineInfo', { installed: true, binaryPath: '/fixture/beholdd', defaultConfigPath: '/fixture/beholdd.toml', exampleConfigPath: '/fixture/example.toml', defaultHost: '127.0.0.1', defaultPort: 6768, manifest: { version: '2', commit: 'fixture', builtAt: '2026-09-26T00:00:00Z' } })();
      if (failEngineInfo) { failEngineInfo = false; throw new Error('Fixture transient read failure'); }
      return info;
    },
    status: read('engineStatus', { running: true, ready: true, ownership: 'app', pid: 1234, host: '127.0.0.1', port: 6768, logs: ['Fixture server ready. No process was started.'], lastExit: null }),
    start: action('engine.start'), stop: action('engine.stop'), restart: action('engine.restart'),
  },
  hub: { state: read('downloads', { token: { configured: false, importable: null, encrypted: true }, root: { path: '/fixture/models', defaultPath: '/fixture/models', isDefault: true, freeBytes: 128_000_000_000 } }), whoami: action('hub.whoami'), setToken: action('hub.setToken'), importToken: action('hub.importToken'), setRoot: action('hub.setRoot') },
  voice: { get: read('voice', voice), onState: subscribe, configure: action('voice.configure'), probe: action('voice.probe'), begin: action('voice.begin') },
  remote: { state: read('remote', remote), configure: action('remote.configure'), revokeDevice: action('remote.revokeDevice'),
    createPairingOffer: async () => ({ id: offerId, endpoint: remote.endpoint, expiresAt: Date.now() + 300_000, capabilities: ['chat', 'approvals'], maxAccess: 'ask', qrDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X0AAAAASUVORK5CYII=' }),
    cancelPairingOffer: async (id: string) => { cancellations.push(id); },
  },
  onRemoteChanged: subscribe, onRemotePairingInvalidated: subscribe,
  updates: { state: read('updates', { version: '0.1.0-alpha.2', status: 'current', lastCheckedAt: Date.now(), automatic: true, install: { kind: 'development', canApply: false }, feed: { path: '/fixture/releases', defaultPath: '/fixture/releases', configured: false }, restart: { pending: false, blockers: [], error: null }, available: null, error: null }), check: action('updates.check'), apply: action('updates.apply'), restart: action('updates.restart'), setFeed: action('updates.setFeed'), setAutomatic: action('updates.setAutomatic') },
  onUpdateState: subscribe,
  workspace: { chooseDirectory: action('chooseDirectory'), chooseFile: action('chooseFile') },
  about: { info: { version: '0.1.0-alpha.2' }, open: action('about.open') },
} as unknown as typeof window.electronAPI;

let navigate: (target: SettingsTarget) => void;
function Fixture() {
  const [target, setTarget] = useState<SettingsTarget>({ section: 'general' });
  navigate = setTarget;
  return <SettingsPage sources={sources} target={target} onNavigate={setTarget}
    onSourcesChanged={() => actions.push('sources.changed')} onClose={() => actions.push('close')}
    onOpenMemory={() => actions.push('memory')} onOpenModels={() => actions.push('models')}
    onVoiceConfigurationChanged={() => actions.push('voice.changed')} />;
}
Object.assign(window, { settingsSmoke: { reads, actions, cancellations, offerId, appearanceWrites, notificationWrites,
  failAppearance: () => { failAppearance = true; }, navigate: (target: SettingsTarget) => navigate(target) } });
initializeAppearance(window.electronAPI.appearance);
createRoot(document.getElementById('root')!).render(<Fixture />);
