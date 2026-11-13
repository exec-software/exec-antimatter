import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Flag, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import type { FeatureApplication, FeatureMutation, FeatureState, FeaturesAPI } from '../../../../src/api/features';
import { ConfirmDialog } from '../ConfirmDialog';
import { clearFormDraft, readFormDraft, writeFormDraft } from '../../lib/formDrafts';
import { FormDraftNotice } from '../settings/FormDraftNotice';

const control = 'rounded border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink';
const button = 'inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-ink-2 hover:bg-surface-3 disabled:opacity-50';
const draftKey = 'feature-management';
type ApplicationDraft = { id: string; name: string };
type FlagDraft = { key: string; description: string; defaultEnabled: boolean };
type FeatureDraft = { selected: string; editing: boolean; revision: number } & (
  | { kind: 'application'; application: ApplicationDraft }
  | { kind: 'feature'; feature: FlagDraft; owner: ApplicationDraft }
);
const validDraft = (value: unknown): value is FeatureDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as FeatureDraft;
  const text = (item: unknown, max: number) => typeof item === 'string' && item.length <= max;
  const application = (item: ApplicationDraft | undefined) => !!item && text(item.id, 80) && text(item.name, 120);
  if (!text(draft.selected, 80) || typeof draft.editing !== 'boolean' || !Number.isSafeInteger(draft.revision) || draft.revision < 0) return false;
  return draft.kind === 'application' ? application(draft.application) : draft.kind === 'feature' && application(draft.owner) &&
    !!draft.feature && text(draft.feature.key, 80) && text(draft.feature.description, 500) && typeof draft.feature.defaultEnabled === 'boolean';
};
export function FeaturesPage({ api, onClose }: { api: FeaturesAPI; onClose(): void }) {
  const [recovered] = useState(() => readFormDraft(draftKey, validDraft));
  const [state, setState] = useState<FeatureState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(recovered?.selected ?? ''), [query, setQuery] = useState('');
  const [application, setApplication] = useState<ApplicationDraft>(recovered?.kind === 'application' ? recovered.application : { id: '', name: '' });
  const [feature, setFeature] = useState<FlagDraft>(recovered?.kind === 'feature' ? recovered.feature : { key: '', description: '', defaultEnabled: false });
  const [addingApp, setAddingApp] = useState(recovered?.kind === 'application'), [addingFeature, setAddingFeature] = useState(recovered?.kind === 'feature');
  const [editingApp, setEditingApp] = useState(recovered?.kind === 'application' && recovered.editing), [editingFeature, setEditingFeature] = useState(recovered?.kind === 'feature' && recovered.editing);
  const [appRevision, setAppRevision] = useState(recovered?.kind === 'application' ? recovered.revision : 0), [featureRevision, setFeatureRevision] = useState(recovered?.kind === 'feature' ? recovered.revision : 0);
  const [featureOwner, setFeatureOwner] = useState<FeatureApplication | null>(recovered?.kind === 'feature' ? { ...recovered.owner, features: [] } : null);
  const [closing, setClosing] = useState(false);
  const [confirm, setConfirm] = useState<FeatureMutation | null>(null);
  const request = useRef(0), mounted = useRef(false), inFlight = useRef(false);
  const draft: FeatureDraft | null = addingApp ? { kind: 'application', selected, application, editing: editingApp, revision: appRevision }
    : addingFeature && featureOwner ? { kind: 'feature', selected, feature, owner: { id: featureOwner.id, name: featureOwner.name }, editing: editingFeature, revision: featureRevision } : null;
  // Persist at commit time, before a sidebar change or window close can unmount the form.
  useLayoutEffect(() => {
    if (draft) writeFormDraft(draftKey, draft); else clearFormDraft(draftKey);
  }, [addingApp, addingFeature, selected, application, feature, featureOwner, editingApp, editingFeature, appRevision, featureRevision]);
  const accept = (next: FeatureState) => setState((previous) => previous && previous.revision > next.revision ? previous : next);
  const refresh = useCallback(async (clearError = true) => {
    const sequence = ++request.current;
    try { const next = await api.get(); if (mounted.current && sequence === request.current) { accept(next); if (clearError) setError(''); } }
    catch { if (mounted.current && sequence === request.current) setError('Could not load features.'); }
  }, [api]);
  useEffect(() => { mounted.current = true; void refresh(); const off = api.onChanged(() => { void refresh(); }); return () => { mounted.current = false; request.current++; off(); }; }, [api, refresh]);
  useEffect(() => { if (state && !addingApp && !addingFeature && !state.applications.some((entry) => entry.id === selected)) setSelected(state.applications[0]?.id ?? ''); }, [state, selected, addingApp, addingFeature]);
  const run = async (operation: () => Promise<FeatureState>) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true); setError('');
    try { const next = await operation(); if (mounted.current) accept(next); return mounted.current; }
    catch (cause) { if (mounted.current) { setError((cause instanceof Error ? cause.message : 'The feature action failed.').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')); void refresh(false); } return false; }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const update = (mutation: FeatureMutation, revision = state?.revision, accepted?: () => void) => revision === undefined ? Promise.resolve(false) : run(async () => {
    const next = await api.update(revision, mutation); accepted?.(); return next;
  });
  const current = state?.applications.find((entry) => entry.id === selected) ?? (addingFeature ? featureOwner : null);
  const duplicateApp = !editingApp && !!state?.applications.some((entry) => entry.id === application.id);
  const duplicateFeature = !editingFeature && !!current?.features.some((entry) => entry.key === feature.key);
  const appConflict = addingApp && state?.revision !== appRevision;
  const featureConflict = addingFeature && state?.revision !== featureRevision;
  const featureOwnerMissing = addingFeature && !state?.applications.some((entry) => entry.id === selected);
  return <div className="absolute inset-0 flex flex-col bg-surface">
    <header className="flex items-center gap-2 border-b border-line px-5 py-3"><Flag size={16} className="text-primary" /><h1 className="mr-auto text-sm font-semibold">Feature Management</h1>
      <button type="button" className={button} disabled={busy} onClick={() => { void refresh(); }}><RefreshCw size={13} />Refresh</button>
      <button type="button" className={button} disabled={busy} onClick={() => addingApp || addingFeature ? setClosing(true) : onClose()}><X size={13} />Done</button></header>
    <div className="min-h-0 flex-1 overflow-auto p-5"><div className="mx-auto max-w-5xl space-y-5">
      <p className="text-xs text-ink-3">Register applications and manage their feature flags. C and Matrix clients can read these settings through the local SDK.</p>
      <FormDraftNotice draftKey={draftKey} />
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {state && <section className="space-y-2 rounded border border-line p-3" aria-label="Native SDK">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={state.api.enabled} disabled={busy}
          onChange={(event) => { void run(() => api.configureApi(event.target.checked)); }} />Enable local SDK</label>
        <p className="text-xs text-ink-3">Local programs running as your OS user can manage these flags. The endpoint changes when Antimatter restarts.</p>
        {state.api.endpoint && <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs">{state.api.endpoint}</code>
          <button type="button" className={button} onClick={() => { void navigator.clipboard.writeText(state.api.endpoint!).catch(() => setError('Could not copy the endpoint.')); }}><Copy size={12} />Copy</button></div>}
        {state.api.error && <p role="alert" className="text-xs text-danger">{state.api.error}</p>}
      </section>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs">Application <select aria-label="Application" className={control} value={selected} disabled={busy || addingApp || addingFeature} onChange={(event) => setSelected(event.target.value)}>
          {!state?.applications.length && <option value="">No applications</option>}
          {state?.applications.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        <button type="button" className={button} disabled={!state || busy || addingApp || addingFeature} onClick={() => { setApplication({ id: '', name: '' }); setEditingApp(false); setAppRevision(state!.revision); setAddingApp(true); }}><Plus size={12} />Application</button>
        {current && <><button type="button" className={button} disabled={busy || addingApp || addingFeature} onClick={() => { setApplication({ id: current.id, name: current.name }); setEditingApp(true); setAppRevision(state!.revision); setAddingApp(true); }}>Rename</button>
          <button type="button" className={button} disabled={busy || addingApp || addingFeature} onClick={() => setConfirm({ kind: 'remove-application', id: current.id })}><Trash2 size={12} />Remove</button></>}
      </div>
      {addingApp && <form className="flex flex-wrap items-center gap-2 rounded border border-line p-3" onSubmit={(event) => {
        event.preventDefault(); if (duplicateApp || appConflict) return;
        void update({ kind: 'application', ...application }, appRevision, () => clearFormDraft(draftKey, draft)).then((saved) => { if (saved) { setSelected(application.id); setAddingApp(false); } });
      }}><p className="w-full text-[11px] text-ink-3">Your draft is kept when you leave this page.</p>
        <input aria-label="Application ID" placeholder="Application ID" className={control} required maxLength={80} pattern={'[a-zA-Z][a-zA-Z0-9_.\\-]{0,79}'} value={application.id} disabled={busy || editingApp} onChange={(event) => setApplication({ ...application, id: event.target.value })} />
        <input aria-label="Application name" placeholder="Name" className={control} required maxLength={120} value={application.name} disabled={busy} onChange={(event) => setApplication({ ...application, name: event.target.value })} />
        {duplicateApp && <p role="status" className="w-full text-xs text-warning">That ID already exists. Choose another application ID.</p>}
        {appConflict && state && <div className="w-full text-xs text-warning">Applications changed while you were editing. Saved name: {state.applications.find((entry) => entry.id === application.id)?.name ?? '(Not registered)'}.
          <button type="button" className={button} disabled={busy || duplicateApp} onClick={() => { if (!state.applications.some((entry) => entry.id === application.id)) setEditingApp(false); setAppRevision(state.revision); }}>Keep my changes</button></div>}
        <button type="submit" className={button} disabled={busy || duplicateApp || appConflict}>Save</button><button type="button" className={button} disabled={busy} onClick={() => setAddingApp(false)}>Discard draft</button></form>}
      {current && <section className="space-y-3" aria-label="Feature flags">
        <div className="flex gap-2"><input aria-label="Find feature" className={`${control} min-w-0 flex-1`} placeholder="Find feature" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button type="button" className={button} disabled={busy || addingApp || addingFeature} onClick={() => { setFeature({ key: '', description: '', defaultEnabled: false }); setEditingFeature(false); setFeatureRevision(state!.revision); setFeatureOwner(current); setAddingFeature(true); }}><Plus size={12} />Feature</button></div>
        {addingFeature && <form className="space-y-2 rounded border border-line p-3" onSubmit={(event) => {
          event.preventDefault(); if (duplicateFeature || featureConflict || featureOwnerMissing) return;
          void update({ kind: 'declare', application: selected, ...feature }, featureRevision, () => clearFormDraft(draftKey, draft)).then((saved) => { if (saved) setAddingFeature(false); });
        }}><p className="text-[11px] text-ink-3">Your draft is kept when you leave this page.</p>
          <div className="flex flex-wrap gap-2"><input aria-label="Feature key" placeholder="Feature key" className={control} required maxLength={80} pattern={'[a-zA-Z][a-zA-Z0-9_.\\-]{0,79}'} value={feature.key} disabled={busy || editingFeature} onChange={(event) => setFeature({ ...feature, key: event.target.value })} />
          <input aria-label="Feature description" placeholder="Description" className={`${control} min-w-0 flex-1`} maxLength={500} value={feature.description} disabled={busy} onChange={(event) => setFeature({ ...feature, description: event.target.value })} /></div>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={feature.defaultEnabled} disabled={busy} onChange={(event) => setFeature({ ...feature, defaultEnabled: event.target.checked })} />On by default</label>
          {duplicateFeature && <p role="status" className="text-xs text-warning">That key already exists. Choose another feature key.</p>}
          {featureOwnerMissing && <p role="status" className="text-xs text-warning">This application was removed. Restore it before saving.</p>}
          {featureConflict && state && <div className="text-xs text-warning">Features changed while you were editing. Saved description: {current.features.find((entry) => entry.key === feature.key)?.description ?? '(Not declared)'}.
            <button type="button" className={button} disabled={busy || duplicateFeature || featureOwnerMissing} onClick={() => { if (!current.features.some((entry) => entry.key === feature.key)) setEditingFeature(false); setFeatureRevision(state.revision); }}>Keep my changes</button></div>}
          <button type="submit" className={button} disabled={busy || duplicateFeature || featureConflict || featureOwnerMissing}>Save</button><button type="button" className={button} disabled={busy} onClick={() => setAddingFeature(false)}>Discard draft</button></form>}
        <div className="divide-y divide-line rounded border border-line">{current.features.filter((entry) => `${entry.key} ${entry.description}`.toLowerCase().includes(query.toLowerCase())).map((entry) => <div key={entry.key} className="flex flex-wrap items-center gap-3 p-3">
          <span className={`h-2 w-2 rounded-full ${entry.enabled ? 'bg-success' : 'bg-ink-3'}`} aria-label={entry.enabled ? 'Enabled' : 'Disabled'} />
          <div className="min-w-0 flex-1"><p className="break-all text-xs font-medium">{entry.key}</p><p className="text-xs text-ink-3">{entry.description || 'No description'}</p></div>
          <select aria-label={`Override ${entry.key}`} className={control} value={entry.override === null ? 'default' : String(entry.override)} disabled={busy}
            onChange={(event) => { void update({ kind: 'override', application: selected, key: entry.key, value: event.target.value === 'default' ? null : event.target.value === 'true' }); }}>
            <option value="default">Default ({entry.defaultEnabled ? 'on' : 'off'})</option><option value="true">On</option><option value="false">Off</option></select>
          <button type="button" className={button} disabled={busy || addingApp || addingFeature} onClick={() => { setFeature({ key: entry.key, description: entry.description, defaultEnabled: entry.defaultEnabled }); setEditingFeature(true); setFeatureRevision(state!.revision); setFeatureOwner(current); setAddingFeature(true); }}>Edit</button>
          <button type="button" className={button} aria-label={`Remove ${entry.key}`} disabled={busy || addingApp || addingFeature} onClick={() => setConfirm({ kind: 'remove-feature', application: selected, key: entry.key })}><Trash2 size={13} /></button>
        </div>)}{!current.features.length && <p className="p-3 text-xs text-ink-3">Add a feature here or declare one from the SDK.</p>}</div>
      </section>}
      {!!state?.audit.length && <details><summary className="cursor-pointer text-xs text-ink-2">Recent changes</summary><ul className="mt-2 space-y-1 text-xs text-ink-3">{state.audit.slice(0, 30).map((entry, index) => <li key={index}>{new Date(entry.at).toLocaleString()} · {entry.application}{entry.key ? ` / ${entry.key}` : ''} · {entry.action} · {entry.actor}</li>)}</ul></details>}
    </div></div>
    {confirm && <ConfirmDialog title="Remove this feature configuration?" message="Applications using it will receive an unavailable result until you register it again." confirmLabel="Remove" tone="danger" onCancel={() => setConfirm(null)} onConfirm={() => { const action = confirm; setConfirm(null); void update(action); }} />}
    {closing && <ConfirmDialog title="Discard these feature edits?" message="Your saved applications and flags will stay unchanged." confirmLabel="Discard edits" tone="danger" onCancel={() => setClosing(false)} onConfirm={() => { clearFormDraft(draftKey); onClose(); }} />}
  </div>;
}
