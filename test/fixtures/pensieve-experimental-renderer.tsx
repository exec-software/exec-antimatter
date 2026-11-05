/** Isolated Settings fixture. Its API cannot reach a real profile, process, or model. */
import { createRoot } from 'react-dom/client';
import type { PensieveExperimentalAPI, PensieveExperimentalState } from '../../src/api/pensieve';
import { PensieveExperimental } from '../../renderer/src/components/settings/PensieveExperimental';
import { initializeAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';

let state: PensieveExperimentalState = { enabled: false, status: 'disabled', available: true,
  unavailableReason: null, error: null, projectId: null, statistics: null,
  corpus: { id: 'nil-sdk-9e334150-curriculum-fixture-1234567890abcdef', entryCount: 203,
    languages: ['matrix', 'nil', 'ny', 'shared'], sdkVersion: '9e334150-fixture' } };
const actions: boolean[] = [];
const unexpected: string[] = [];
const listeners = new Set<(value: PensieveExperimentalState) => void>();
let stateReads = 0;
let failure: string | null = null;
let held = false;
let complete: (() => void) | null = null;
const publish = (patch: Partial<PensieveExperimentalState>) => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(structuredClone(state));
  return structuredClone(state);
};
const api: PensieveExperimentalAPI = {
  getState: async () => { stateReads++; return structuredClone(state); },
  onChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  setEnabled: async enabled => {
    actions.push(enabled);
    if (failure) { const error = failure; failure = null; throw new Error(error); }
    if (enabled && held) {
      publish({ status: 'checking' });
      await new Promise<void>(resolve => { complete = resolve; });
    }
    return publish({ enabled, status: enabled ? 'ready' : 'disabled', error: null });
  },
};
Object.assign(window, { electronAPI: new Proxy({
  pensieve: api,
  appearance: { initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, onChanged: () => () => undefined },
}, { get(target, key) {
  if (typeof key === 'symbol' || key in target) return Reflect.get(target, key);
  unexpected.push(String(key)); throw new Error(`Unexpected fixture API access: ${String(key)}`);
} }) });
initializeAppearance(window.electronAPI.appearance);
Object.assign(window, { pensieveSmoke: { actions, unexpected, stateReads: () => stateReads,
  state: () => structuredClone(state), publish, failNextAction: (message: string) => { failure = message; },
  hold: () => { held = true; }, finish: () => { held = false; if (!complete) throw new Error('No pending enable.'); complete(); complete = null; } } });
createRoot(document.getElementById('root')!).render(<main className="min-h-screen bg-surface p-6 text-ink">
  <h1 className="mb-4 text-lg font-semibold">Settings · Experimental</h1>
  <div className="max-w-2xl"><PensieveExperimental /></div>
</main>);
