/** Isolated opt-in UI fixture. No real preload, settings, network, or inference process. */
import { createRoot } from 'react-dom/client';
import type { HagExperimentalAPI, HagExperimentalState } from '../../src/api/hag';
import { useHagExperimental, type HagAction } from '../../renderer/src/lib/useHagExperimental';
import { HagExperimentalPanel } from '../../renderer/src/components/settings/HagExperimentalPanel';
import { HagWelcomeDialog } from '../../renderer/src/components/setup/HagWelcomeDialog';
import { ChatComposer } from '../../renderer/src/components/chat/ChatComposer';
import { HagPreviewNotice } from '../../renderer/src/components/chat/HagPreviewNotice';
import { initializeAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';

let state: HagExperimentalState = {
  showWelcome: true, enabled: false, available: true, unavailableReason: null, status: 'disabled', error: null,
  model: { id: 'qwen3-0.6b-hag-16k', name: 'Qwen3-0.6B', maxEvaluatedTokens: 1024 },
  sourceId: 'bundled-hag-experimental', modelDownloadBytes: 639447744, downloadProgress: null,
};
const actions: HagAction[] = [];
const submitted: string[] = [];
const unexpected: string[] = [];
const previousChoice = { providerId: 'local-openmythos-27b', modelId: 'openmythos-27b' };
const listeners = new Set<(value: HagExperimentalState) => void>();
let stateReads = 0;
let failure: string | null = null;
let finishDownload: (() => void) | null = null;
const publish = (patch: Partial<HagExperimentalState>) => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(structuredClone(state));
  return structuredClone(state);
};
const invoke = (action: HagAction) => {
  actions.push(action);
  if (failure) { const error = failure; failure = null; throw new Error(error); }
};
const api: HagExperimentalAPI = {
  state: async () => { stateReads++; return structuredClone(state); },
  onChanged: (callback) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  enable: async () => {
    invoke('enable');
    if (state.modelDownloadBytes) {
      publish({ status: 'downloading', downloadProgress: { receivedBytes: 123000000, totalBytes: 639447744 } });
      await new Promise<void>((resolve) => { finishDownload = resolve; });
    }
    return publish({ enabled: true, status: 'stopped', showWelcome: false, modelDownloadBytes: 0, downloadProgress: null, error: null });
  },
  disable: async () => { invoke('disable'); return publish({ enabled: false, status: 'disabled', error: null }); },
  dismissWelcome: async () => { invoke('dismissWelcome'); return publish({ showWelcome: false }); },
};

// The fixture provides no host bridge. Unexpected access fails visibly instead of reaching the
// real profile, opening a file chooser, selecting a model, or starting a dictation/model service.
const forbidden = (name: string) => () => { unexpected.push(name); throw new Error(`Unexpected fixture API call: ${name}`); };
Object.assign(window, { electronAPI: new Proxy({
  hag: api,
  appearance: { initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, onChanged: () => () => undefined },
  model: { get: async () => structuredClone(previousChoice), set: forbidden('model.set') },
  workspace: { chooseDirectory: forbidden('workspace.chooseDirectory') },
}, { get(target, key) {
  if (typeof key === 'symbol' || key in target) return Reflect.get(target, key);
  unexpected.push(String(key)); throw new Error(`Unexpected fixture API access: ${String(key)}`);
} }) });
initializeAppearance(window.electronAPI.appearance);

function Fixture() {
  const controller = useHagExperimental(api);
  return <main className="min-h-screen bg-surface p-6 text-ink">
    <h1 className="text-lg font-semibold">Settings · Experimental</h1>
    {!controller.state?.showWelcome && <div className="mt-4 max-w-xl"><HagExperimentalPanel /></div>}
    {controller.state?.enabled && <div className="mt-4 max-w-xl">
      <ChatComposer threadId="fixture" onSubmit={(text) => { submitted.push(text); return true; }}
        providers={[{ id: state.sourceId, name: 'Beholdd HAG (experimental)', kind: 'beholdd', protocol: 'openai-chat',
          baseUrl: 'http://fixture.invalid/v1', credentialConfigured: false, supportsStreaming: true,
          models: [{ id: state.model.id, name: state.model.name }] }]}
        providerId={state.sourceId} modelId={state.model.id} onOpenModels={() => undefined}
        access={{ directory: null, mode: 'ask' }} onChangeAccess={() => undefined} workspace={null} workspaceConfirmed={false} onConfirmWorkspace={() => undefined}
        textOnly sourceNotice={<HagPreviewNotice sourceId={state.sourceId} />} />
    </div>}
    {controller.state?.showWelcome && <HagWelcomeDialog controller={controller} />}
  </main>;
}
Object.assign(window, { hagSmoke: {
  actions,
  submitted,
  unexpected,
  previousChoice: () => structuredClone(previousChoice),
  stateReads: () => stateReads,
  state: () => structuredClone(state),
  failNextAction: (message: string) => { failure = message; },
  finishDownload: () => { if (!finishDownload) throw new Error('No download is pending.'); finishDownload(); finishDownload = null; },
  publish,
} });
createRoot(document.getElementById('root')!).render(<Fixture />);
