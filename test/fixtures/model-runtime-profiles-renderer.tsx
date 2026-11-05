import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelCard } from '../../renderer/src/components/hub/ModelLibrary';
import { initializeAppearance, saveAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import type { ModelRuntimeProfilesAPI, ModelRuntimeProfileState } from '../../src/api/modelRuntimeProfiles';
import type { ProviderConfig } from '../../renderer/src/types';

initializeAppearance({ initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, update: async (patch) => ({ ...DEFAULT_APPEARANCE, ...patch }), onChanged: () => () => {} });
const source: ProviderConfig = { id: 'local', name: 'Local server', kind: 'llama-cpp', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:8080/v1', models: [{ id: 'deepseek', name: 'DeepSeek V4 Flash', deployment: 'local', contextWindow: 131072, quantization: 'UD-Q2_K_XL' }] };
let state: ModelRuntimeProfileState = { sourceId: 'local', modelId: 'deepseek', supported: true, captured: false, busy: false, applying: false, profiles: [], activeProfileId: null, actual: { contextTokens: 131072, parallel: 1 } };
const calls: Array<{ action: string; args: unknown[] }> = [];
const listeners = new Set<(event: { sourceId: string; modelId: string }) => void>();
let applyFailure = false; let pendingApply: (() => void) | null = null; let pendingRead: ((state: ModelRuntimeProfileState) => void) | null = null;
const clone = <T,>(value: T): T => structuredClone(value);
const changed = () => { for (const listener of listeners) listener({ sourceId: 'local', modelId: 'deepseek' }); };
const api: ModelRuntimeProfilesAPI = {
  state: async (sourceId, modelId) => {
    calls.push({ action: 'state', args: [sourceId, modelId] });
    if (sourceId === 'slow') return new Promise((resolve) => { pendingRead = resolve; });
    if (sourceId === 'provider') return { ...clone(state), sourceId, modelId, supported: false, recoveryOnly: false, reason: 'Provider manages its own engine capacity.', profiles: [] };
    return clone(state);
  },
  capture: async (...args) => { calls.push({ action: 'capture', args }); state = { ...state, captured: true, activeProfileId: 'baseline', profiles: [
    { id: 'baseline', name: 'Straight shot', contextTokens: 131072, parallel: 1, baseline: true, createdAt: 1, updatedAt: 1 },
    { id: 'orchestration', name: 'Orchestration', contextTokens: 32768, parallel: 2, baseline: false, createdAt: 1, updatedAt: 1 },
  ] }; return clone(state); },
  copy: async (...args) => { calls.push({ action: 'copy', args }); const profile = state.profiles.find((entry) => entry.id === args[2])!; state = { ...state, profiles: [...state.profiles, { ...profile, id: 'copy', name: `${profile.name} copy`, baseline: false }] }; return clone(state); },
  update: async (...args) => { calls.push({ action: 'update', args }); state = { ...state, profiles: state.profiles.map((profile) => profile.id === args[2] ? { ...profile, ...args[3] } : profile) }; return clone(state); },
  remove: async (...args) => { calls.push({ action: 'remove', args }); const profile = state.profiles.find((entry) => entry.id === args[2]);
    if (profile?.baseline || profile?.id === state.activeProfileId) throw new Error('Protected profiles cannot be removed.');
    state = { ...state, profiles: state.profiles.filter((profile) => profile.id !== args[2]) }; return clone(state); },
  apply: async (...args) => { calls.push({ action: 'apply', args }); state = { ...state, applying: true }; changed();
    await new Promise<void>((resolve) => { pendingApply = resolve; }); state = { ...state, applying: false };
    if (applyFailure) { changed(); throw new Error(state.recoveryOnly ? 'Straight shot recovery failed. The engine is still stopped.' : 'The engine failed verification; the previous profile was restored.'); }
    const profile = state.profiles.find((entry) => entry.id === args[2])!; state = { ...state, supported: true, recoveryOnly: false, reason: undefined, activeProfileId: profile.id, actual: { contextTokens: profile.contextTokens, parallel: profile.parallel } }; changed(); return clone(state); },
  onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
window.electronAPI = { modelRuntimeProfiles: api } as typeof window.electronAPI;
let setSource: (id: string) => void;
function Fixture() {
  const [sourceId, changeSource] = useState('local'); setSource = changeSource;
  return <main className="min-h-screen bg-surface p-4 text-ink"><div className="mx-auto max-w-3xl">
    <ModelCard source={{ ...source, id: sourceId }} model={source.models[0]} selected onUse={() => { throw new Error('Runtime profile controls cannot reroute a conversation.'); }} actionLabel="Use model" selectedLabel="Selected" />
  </div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
Object.assign(window, { runtimeProfilesSmoke: {
  source: (id: string) => setSource(id), busy: (value: boolean) => { state = { ...state, busy: value }; changed(); },
  failEngine: () => { state = { ...state, supported: true, recoveryOnly: true, reason: 'The local engine stopped before its configuration could be verified.', actual: null, activeProfileId: null }; changed(); },
  failApply: (value: boolean) => { applyFailure = value; }, releaseApply: () => { pendingApply?.(); pendingApply = null; },
  releaseRead: () => { pendingRead?.({ ...clone(state), sourceId: 'slow', reason: 'STALE SOURCE' }); pendingRead = null; },
  appearance: saveAppearance,
  click: (label: string) => {
    const button = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label || button.textContent?.trim() === label);
    if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`); button.click();
  },
  select: (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Saved engine profiles"] button')].find((button) => button.textContent?.startsWith(label));
    if (!button || button.disabled) throw new Error(`Profile unavailable: ${label}`); button.click();
  },
  edit: (label: string, value: string) => {
    const input = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
    if (!input || input.disabled) throw new Error(`Input unavailable: ${label}`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
  },
  snapshot: () => ({ text: document.body.textContent, calls, state: clone(state), focused: document.activeElement?.textContent, inputs: [...document.querySelectorAll('input')].map((input) => ({ label: input.getAttribute('aria-label'), value: input.value, disabled: input.disabled, maxLength: input.maxLength })), buttons: [...document.querySelectorAll('button')].map((button) => ({ label: button.getAttribute('aria-label') ?? button.textContent?.trim(), disabled: button.disabled })), alert: document.querySelector('[role="alert"]')?.textContent ?? null }),
} });
