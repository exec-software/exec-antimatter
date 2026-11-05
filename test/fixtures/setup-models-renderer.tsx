/** Isolated UI acceptance fixture. IPC/state are synthetic; no application preload or network. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import { SetupWizard } from '../../renderer/src/components/setup/SetupWizard';
import { ModelLibrary } from '../../renderer/src/components/hub/ModelLibrary';
import { InferenceDebugOverlay } from '../../renderer/src/components/developer/InferenceDebugOverlay';
import type { ProviderConfig, ModelProfile, ProfileOverride, Person, OrchestrationProfileInfo, ModelMetadataPatch } from '../../renderer/src/types';
import type { SetupState } from '../../src/api/setup';
import type { InferenceMetricsEvent } from '../../renderer/src/lib/inferenceMetrics';
import type { WorkloadView } from '../../src/api/workloads';

const clone = <T,>(value: T): T => structuredClone(value);
const subscribe = () => () => undefined;
const actions: string[] = [];
const writes: Array<{ kind: string; value: unknown }> = [];
const failures = new Set<string>();
const maybeFail = (kind: string) => { if (failures.delete(kind)) throw new Error(`Synthetic ${kind} write failure`); };
let person: Person = JSON.parse(localStorage.getItem('fixture.person') ?? JSON.stringify({ name: 'Sam', pronouns: 'they/them', about: 'I build things.', updatedAt: 1 }));
let setup: SetupState = JSON.parse(localStorage.getItem('fixture.setup') ?? JSON.stringify({ assistant: { name: 'Antimatter', personality: '' }, completedAt: null, showOnStartup: true }));
let providers: ProviderConfig[] = [
  { id: 'local', name: 'Workstation', baseUrl: 'http://127.0.0.1:8080/v1', kind: 'llama-cpp', protocol: 'openai-chat', models: [
    { id: 'qwen3-32b', name: 'Local thinker', deployment: 'local', contextWindow: 131072, quantization: 'Q8_0' },
    { id: 'qwen3-coder-30b', name: 'Local coder', deployment: 'local', contextWindow: 131072, quantization: 'Q8_0' },
  ] },
  { id: 'cluster', name: 'GPU cluster', baseUrl: 'http://gpu.example.invalid:8080/v1', kind: 'llama-cpp', protocol: 'openai-chat', models: [
    { id: 'mimo-v2-flash', name: 'Distributed thinker', deployment: 'distributed', contextWindow: 131072, quantization: 'Q4_K_M' },
  ] },
  { id: 'cloud', name: 'Cloud API', baseUrl: 'https://api.example.invalid/v1', kind: 'openai', protocol: 'openai-responses', models: [
    { id: 'gpt-5.1', name: 'Provider thinker', deployment: 'provider', contextWindow: 131072 },
  ] },
];
let profiles: OrchestrationProfileInfo[] = [
  { id: 'profile-local', name: 'Local assistant team', description: 'Local specialists.', deployment: 'local', roles: { default: { provider: 'local', model: 'qwen3-32b' } } },
  { id: 'profile-distributed', name: 'Distributed assistant team', description: 'Models across GPUs.', deployment: 'distributed', roles: { default: { provider: 'cluster', model: 'mimo-v2-flash' } } },
  { id: 'profile-provider', name: 'Provider assistant team', description: 'Hosted specialists.', deployment: 'provider', roles: { default: { provider: 'cloud', model: 'gpt-5.1' } } },
];
let profileId: string | null = null;
const modelProfiles: Record<string, ModelProfile> = {};
const profile = (source: string, model: string): ModelProfile => modelProfiles[`${source}:${model}`] ?? {
  modelId: model, instructions: '', contextTokens: 131072, maxOutputTokens: 16384, maxToolCallsPerMessage: 16,
  contextSource: 'server', outputSource: 'default', toolCallSource: 'default', compaction: 'summarize', thinkingLevel: 'default',
};
// Real catalog names, text, and byte sizes; synthetic download records keep this entirely offline.
const workloadBase = { evidence: 'Isolated UI fixture. No download or runtime is started.', evidenceRefs: [], repoId: 'fixture/model', revision: 'a'.repeat(40), files: [], contextTokens: 131072, maxOutputTokens: 16384, maxToolCallsPerMessage: 16, download: null };
const workloads: WorkloadView[] = [
  { ...workloadBase, id: 'qwen3-coder-30b-q8', name: 'Qwen3-Coder 30B',
    description: 'A practical starting point for local coding, editing, and tools. The same Q8 checkpoint as the Antimatter installer.',
    engine: 'llama.cpp Vulkan',
    hardware: '30.25 GiB download. GPU offload adapts to available memory; leave room for the OS and context. A 16–24 GiB GPU uses CPU spill.',
    quantization: 'Q8_0', variantKey: 'Q8_0', requiresPeers: false, bytes: 32483934528 },
  { ...workloadBase, id: 'deepseek-v4-flash-0731-q2', name: 'DeepSeek V4 Flash 0731',
    description: 'The established single large GPU generalist, using the UD-Q2_K_XL checkpoint.',
    engine: 'llama.cpp Vulkan b11223',
    hardware: '90.18 GiB download. The recorded setup uses a 96 GiB GPU memory allocation, 131,072 context tokens, and one slot. Smaller machines need another setup.',
    quantization: 'UD-Q2_K_XL', variantKey: 'UD-Q2_K_XL', requiresPeers: false, bytes: 96832508352 },
  { ...workloadBase, id: 'mimo-v26-flash-mxfp4', name: 'MiMo V2.6 Flash RL',
    description: 'The large reasoning workload used across multiple machines. Download the exact MXFP4 file set, then connect the GPU peers for your setup.',
    engine: 'llama.cpp Vulkan with matching RPC peers',
    hardware: '155.87 GiB download. Requires combined memory beyond one 96 GiB GPU; configure your own peers. All peers must run the same llama.cpp build.',
    quantization: 'MXFP4', variantKey: 'MXFP4', requiresPeers: true, bytes: 167369465152 },
];
let refreshProviders: () => void = () => undefined;
const forbidden = (name: string) => async () => { actions.push(name); throw new Error(`Unexpected lifecycle action: ${name}`); };
window.electronAPI = {
  appearance: { initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, onChanged: subscribe },
  user: {
    get: async () => clone(person),
    set: async (patch: Partial<Person>) => { maybeFail('user'); person = { ...person, ...patch, updatedAt: Date.now() }; localStorage.setItem('fixture.person', JSON.stringify(person)); writes.push({ kind: 'user', value: patch }); return clone(person); },
  },
  setup: {
    get: async () => clone(setup),
    updateAssistant: async (patch: Partial<SetupState['assistant']>) => { maybeFail('assistant'); setup = { ...setup, assistant: { ...setup.assistant, ...patch } }; localStorage.setItem('fixture.setup', JSON.stringify(setup)); writes.push({ kind: 'assistant', value: patch }); return clone(setup); },
    complete: async () => { maybeFail('complete'); setup = { ...setup, completedAt: Date.now(), showOnStartup: false }; localStorage.setItem('fixture.setup', JSON.stringify(setup)); writes.push({ kind: 'complete', value: setup.completedAt }); return clone(setup); },
    onChanged: subscribe,
  },
  workloads: { list: async () => clone(workloads), download: forbidden('download'), configure: forbidden('configure') },
  onHubDownloads: subscribe,
  providers: {
    updateModel: async (sourceId: string, modelId: string, patch: ModelMetadataPatch) => {
      maybeFail('metadata');
      providers = providers.map(source => source.id !== sourceId ? source : { ...source, models: source.models.map(model => model.id === modelId ? { ...model, ...patch } : model) });
      writes.push({ kind: 'metadata', value: { sourceId, modelId, patch } }); refreshProviders(); return clone(providers.find(source => source.id === sourceId));
    },
    declareModel: forbidden('declare'), removeModel: forbidden('remove'),
  },
  profiles: {
    get: async (sourceId: string, modelId: string) => clone(profile(sourceId, modelId)),
    set: async (sourceId: string, modelId: string, patch: ProfileOverride | null) => { maybeFail('profile'); const key = `${sourceId}:${modelId}`; if (!patch) delete modelProfiles[key]; else modelProfiles[key] = { ...profile(sourceId, modelId), ...patch }; writes.push({ kind: 'profile', value: { sourceId, modelId, patch } }); return clone(profile(sourceId, modelId)); },
  },
  listProfiles: async () => ({ profiles: clone(profiles), selectedId: profileId }),
  selectProfile: async (id: string | null) => { profileId = id; return id; },
  renameProfile: async (id: string, name: string) => { profiles = profiles.map(p => p.id === id ? { ...p, name } : p); return clone(profiles.find(p => p.id === id)); },
  setProfileMode: async (id: string, deployment: 'local' | 'distributed' | 'provider') => { profiles = profiles.map(p => p.id === id ? { ...p, deployment } : p); return clone(profiles.find(p => p.id === id)); },
  residency: { list: async () => [], unload: forbidden('unload') },
} as unknown as typeof window.electronAPI;

const events: InferenceMetricsEvent[] = [
  { id: 'fixture-run', round: 1, providerId: 'local', model: 'qwen3-32b', metrics: { phase: 'complete', requestStartedAt: 1, requestDurationMs: 5400, firstTokenMs: 450, firstTokenKind: 'reasoning', promptTokens: 8192, prefillTokens: 4096, cachedPromptTokens: 4096, completionTokens: 240, reasoningTokens: 100, promptMs: 400, promptTokensPerSecond: 10240, decodeMs: 4800, decodeTokensPerSecond: 50 } },
  { id: 'fixture-run', round: 2, providerId: 'local', model: 'qwen3-32b', metrics: { phase: 'complete', requestStartedAt: 6000, requestDurationMs: 1300, firstTokenMs: 280, firstTokenKind: 'tool' } },
];
let openSetup: () => void = () => undefined;
let showDebug: () => void = () => undefined;
function Fixture() {
  const [sources, setSources] = useState(providers);
  const [wizard, setWizard] = useState(true);
  const [debug, setDebug] = useState(false);
  const [chosen, setChosen] = useState({ source: 'local', model: 'qwen3-32b' });
  refreshProviders = () => setSources([...providers]);
  openSetup = () => setWizard(true); showDebug = () => setDebug(true);
  return <main className="relative flex h-screen flex-col bg-surface text-ink">
    <ModelLibrary providers={sources} providerId={chosen.source} modelId={chosen.model} onUseModel={(source, model) => setChosen({ source, model })} onOpenSettings={() => actions.push('settings')} />
    {wizard && <SetupWizard onClose={() => setWizard(false)} onOpenModels={() => setWizard(false)} />}
    {debug && <InferenceDebugOverlay events={events} active={false} sourceName="Workstation" onClose={() => setDebug(false)} />}
  </main>;
}
Object.assign(window, { setupSmoke: { actions, writes, fail: (kind: string) => failures.add(kind), openSetup: () => openSetup(), showDebug: () => showDebug(),
  state: () => clone({ person, setup, providers, modelProfiles, profiles }), profile: (source: string, model: string) => clone(profile(source, model)) } });
initializeAppearance(window.electronAPI.appearance);
createRoot(document.getElementById('root')!).render(<Fixture />);
