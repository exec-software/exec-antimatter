import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PensieveLibraryPanel } from '../../renderer/src/components/settings/PensieveLibraryPanel';
import { FeaturesPage } from '../../renderer/src/components/features/FeaturesPage';
import { initializeAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import type { LibraryEntry, PensieveLibraryAPI, PensieveLibraryState } from '../../src/api/pensieveLibrary';
import type { FeaturesAPI, FeatureState } from '../../src/api/features';
import { flushFormDrafts } from '../../renderer/src/lib/formDrafts';

initializeAppearance({ initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, update: async (patch) => ({ ...DEFAULT_APPEARANCE, ...patch }), onChanged: () => () => {} });
const clone = <T,>(value: T): T => structuredClone(value);
const memoryChanged = new Set<() => void>(), featuresChanged = new Set<() => void>();
let revision = 1, enabled = false, workspace = '/fixture/project-a', entryId = 0, closed = false;
let entries: LibraryEntry[] = [{ id: 'shipped', title: 'Rust reference', content: '<script>window.untrusted=true</script>\nReference text', kind: 'reference', language: 'rust', origin: 'shipped', scope: 'global', enabled: true, updatedAt: null }];
const mutations: unknown[] = [];
const storageSet = Storage.prototype.setItem, storageRemove = Storage.prototype.removeItem;
let failDraftWrite = false, failDraftRemove = false;
Storage.prototype.setItem = function (key, value) { if (failDraftWrite && key.startsWith('antimatter.form-draft.')) throw new Error('Synthetic quota failure'); storageSet.call(this, key, value); };
Storage.prototype.removeItem = function (key) { if (failDraftRemove && key.startsWith('antimatter.form-draft.')) throw new Error('Synthetic remove failure'); storageRemove.call(this, key); };
const memoryState = (root?: string | null): PensieveLibraryState => clone({ revision, enabled, entries, project: root ?? null, notice: null });
const memoryApi: PensieveLibraryAPI = {
  get: async (root) => memoryState(root),
  update: async (input) => {
    if (input.revision !== revision) throw new Error('The library changed. Reload it before saving.');
    const value = input.mutation, entry = 'id' in value ? entries.find((item) => item.id === value.id) : undefined;
    if ((value.kind === 'save' || value.kind === 'delete') && entry?.origin === 'shipped') throw new Error('Shipped entries are read-only.');
    mutations.push(clone(input));
    if (value.kind === 'enable') enabled = value.enabled;
    if (value.kind === 'toggle' && entry) entry.enabled = value.enabled;
    if (value.kind === 'delete') entries = entries.filter((item) => item.id !== value.id);
    if (value.kind === 'save') {
      const next: LibraryEntry = { id: value.id ?? `custom-${++entryId}`, title: value.title, content: value.content, kind: value.entryKind, language: value.language, scope: value.scope, origin: 'custom', enabled: entry?.enabled ?? true, updatedAt: Date.now() };
      if (entry) Object.assign(entry, next); else entries.push(next);
    }
    revision++; memoryChanged.forEach((callback) => callback()); return memoryState(input.workspace);
  },
  onChanged: (callback) => { memoryChanged.add(callback); return () => memoryChanged.delete(callback); },
};
let features: FeatureState = { revision: 1, applications: [{ id: 'existing', name: 'Existing app', features: [{ key: 'search', description: 'Enable search', defaultEnabled: false, enabled: false, override: null }] }], audit: [], api: { enabled: false, endpoint: null, error: null } };
const featureApi: FeaturesAPI = {
  get: async () => clone(features),
  update: async (expected, mutation) => {
    if (expected !== features.revision) throw new Error('Feature settings changed. Reload before saving.');
    mutations.push(clone(mutation));
    if (mutation.kind === 'application') {
      const existing = features.applications.find((item) => item.id === mutation.id);
      if (existing) existing.name = mutation.name; else features.applications.push({ id: mutation.id, name: mutation.name, features: [] });
    } else if (mutation.kind === 'remove-application') features.applications = features.applications.filter((item) => item.id !== mutation.id);
    else {
      const app = features.applications.find((item) => item.id === mutation.application);
      if (!app) throw new Error('Application is missing.');
      const flag = app.features.find((item) => item.key === mutation.key);
      if (mutation.kind === 'declare') {
        const next = { key: mutation.key, description: mutation.description, defaultEnabled: mutation.defaultEnabled, override: flag?.override ?? null, enabled: flag?.override ?? mutation.defaultEnabled };
        if (flag) Object.assign(flag, next); else app.features.push(next);
      } else if (mutation.kind === 'override' && flag) { flag.override = mutation.value; flag.enabled = mutation.value ?? flag.defaultEnabled; }
      else if (mutation.kind === 'remove-feature') app.features = app.features.filter((item) => item.key !== mutation.key);
    }
    features.revision++; featuresChanged.forEach((callback) => callback()); return clone(features);
  },
  configureApi: async (enabled) => { features.api = { enabled, endpoint: enabled ? '/fixture/sdk.sock' : null, error: null }; features.revision++; featuresChanged.forEach((callback) => callback()); return clone(features); },
  onChanged: (callback) => { featuresChanged.add(callback); return () => featuresChanged.delete(callback); },
};
window.electronAPI = { pensieveLibrary: memoryApi, pensieve: { getState: async () => ({ enabled: false, available: true, status: 'disabled' }), onChanged: () => () => {} } } as unknown as typeof window.electronAPI;
let show: (page: string) => void, selectWorkspace: (next: string) => void;
function Fixture() {
  const [page, setPage] = useState('memory'), [root, setRoot] = useState(workspace);
  show = setPage; selectWorkspace = setRoot;
  return <div className="relative h-screen overflow-auto bg-surface p-6 text-ink">
    {page === 'memory' && <div className="mx-auto max-w-3xl"><PensieveLibraryPanel workspace={root} /></div>}
    {page === 'features' && <FeaturesPage api={featureApi} onClose={() => { closed = true; setPage('other'); }} />}
    {page === 'other' && <p>Another settings section</p>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
const scope = () => document.querySelector('[role="alertdialog"]') ?? document;
Object.assign(window, { settingsSmoke: {
  storageFailure: (write: boolean, remove = false) => { failDraftWrite = write; failDraftRemove = remove; },
  savedDraft: (key: string, text: string) => storageSet.call(localStorage, `antimatter.form-draft.${key}`, text),
  draftBlockers: () => flushFormDrafts(),
  page: (page: string) => show(page),
  workspace: (next: string) => { workspace = next; selectWorkspace(next); },
  click: (label: string) => {
    const items = [...scope().querySelectorAll<HTMLButtonElement>('button')];
    const element = items.find((item) => item.getAttribute('aria-label') === label) ?? items.find((item) => item.textContent?.trim() === label);
    if (!element || element.disabled) throw new Error(`Button unavailable: ${label}`); element.click();
  },
  change: (label: string, value: string) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`);
    if (!element || element.disabled) throw new Error(`Field unavailable: ${label}`);
    const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  },
  toggle: (label: string) => {
    const element = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((item) => item.getAttribute('aria-label') === label || item.closest('label')?.textContent?.trim() === label);
    if (!element || element.disabled) throw new Error(`Checkbox unavailable: ${label}`); element.click();
  },
  memoryConflict: () => { const entry = entries.find((item) => item.origin === 'custom'); if (entry) entry.content = 'External saved content'; revision++; memoryChanged.forEach((callback) => callback()); },
  featureConflict: () => { features.applications[0].features[0].description = 'SDK changed this description'; features.revision++; featuresChanged.forEach((callback) => callback()); },
  snapshot: () => ({ memory: memoryState(workspace), features: clone(features), mutations, closed, text: document.body.innerText,
    form: Object.fromEntries([...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input[aria-label],select[aria-label],textarea[aria-label]')].map((item) => [item.getAttribute('aria-label'), { value: item.value, disabled: item.disabled }])),
    saveDisabled: [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === 'Save')?.disabled,
    storage: Object.fromEntries(Object.entries(localStorage)) }),
} });
