import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { ModelRuntimeProfile, ModelRuntimeProfileState, ModelRuntimeProfilesAPI } from '../../../../src/api/modelRuntimeProfiles';
import { MODEL_RUNTIME_PROFILE_LIMITS as limits } from '../../../../src/api/modelRuntimeProfiles';
import { ConfirmDialog } from '../ConfirmDialog';

const button = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:cursor-default disabled:opacity-50';
const field = 'mt-1 block w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink focus:border-primary/60 focus:outline-none disabled:text-ink-3';
const readable = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
interface Draft { name: string; context: string; parallel: string; quant: string }
/** '' means the profile names no quantization, so the service's own `-m` stands. */
const draftOf = (profile: ModelRuntimeProfile): Draft => ({ name: profile.name, context: String(profile.contextTokens), parallel: String(profile.parallel), quant: profile.modelPath ?? '' });
const amount = (value: number) => value.toLocaleString();
const size = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** A saved engine allocation is separate from the model's prompt and routing profiles. */
export function ModelRuntimeProfiles({ sourceId, modelId, api }: { sourceId: string; modelId: string; api?: ModelRuntimeProfilesAPI }) {
  const scope = `${sourceId}\0${modelId}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const mounted = useRef(true); const sequence = useRef(0); const operation = useRef(0);
  const [snapshot, setSnapshot] = useState<{ scope: string; state: ModelRuntimeProfileState } | null>(null);
  const [selectedId, setSelectedId] = useState(''); const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(false); const [pending, setPending] = useState(''); const [error, setError] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<{ scope: string; id: string } | null>(null);
  const state = snapshot?.scope === scope ? snapshot.state : null;
  const restricted = !!state && (!state.supported || !!state.recoveryOnly);
  const baseline = state?.profiles.find((profile) => profile.baseline);
  const selected = state?.profiles.find((profile) => profile.id === selectedId) ?? state?.profiles.find((profile) => profile.id === state.activeProfileId) ?? state?.profiles[0];
  const draft = selected ? restricted ? draftOf(selected) : drafts[selected.id] ?? draftOf(selected) : null;
  const dirty = !!selected && !!draft && (draft.name !== selected.name || Number(draft.context) !== selected.contextTokens || Number(draft.parallel) !== selected.parallel || draft.quant !== (selected.modelPath ?? ''));
  // Only offered when the model's directory holds more than one servable quantization; the main
  // process returns none rather than a single-entry list, so there is no pointless control.
  const quants = state?.quantizations ?? [];
  // A profile may name a quantization that has since been deleted. Keep showing it rather than
  // silently rewriting the profile to something else.
  const quantMissing = !!draft?.quant && !quants.some((variant) => variant.path === draft.quant);
  const valid = !!draft?.name.trim() && draft.name.trim().length <= 100 && Number.isSafeInteger(Number(draft.context)) && Number(draft.context) >= limits.minContextTokens && Number(draft.context) <= limits.maxContextTokens && Number.isSafeInteger(Number(draft.parallel)) && Number(draft.parallel) >= 1 && Number(draft.parallel) <= limits.maxParallel && Number(draft.context) * Number(draft.parallel) <= limits.maxTotalContextTokens;
  const selectedLocked = restricted || (!!selected && (selected.baseline || selected.id === state?.activeProfileId));
  const saving = !!pending || !!state?.applying;
  const removal = !restricted && pendingRemoval?.scope === scope ? state?.profiles.find((profile) => profile.id === pendingRemoval.id && !profile.baseline && profile.id !== state.activeProfileId) : null;

  const adopt = useCallback((next: ModelRuntimeProfileState) => {
    if (currentScope.current !== scope || next.sourceId !== sourceId || next.modelId !== modelId) return;
    setSnapshot({ scope, state: next });
  }, [scope, sourceId, modelId]);
  const refresh = useCallback(async () => {
    if (!api) return;
    const request = ++sequence.current;
    const current = () => mounted.current && currentScope.current === scope && sequence.current === request;
    setLoading(true);
    try { const next = await api.state(sourceId, modelId); if (current()) adopt(next); }
    catch (cause) { if (current()) setError(readable(cause)); }
    finally { if (current()) setLoading(false); }
  }, [api, scope, sourceId, modelId, adopt]);

  useEffect(() => {
    mounted.current = true; setSelectedId(''); setDrafts({}); setSnapshot(null); setPending(''); setError(''); setPendingRemoval(null);
    void refresh();
    const unsubscribe = api?.onChanged((event) => { if (event.sourceId === sourceId && event.modelId === modelId) void refresh(); });
    return () => { mounted.current = false; sequence.current++; operation.current++; unsubscribe?.(); };
  }, [api, sourceId, modelId, refresh]);

  const mutate = async (action: 'capture' | 'copy' | 'save' | 'apply' | 'remove', targetId?: string) => {
    const selectedProfile = targetId ? state?.profiles.find((profile) => profile.id === targetId) : selected;
    if (!api || saving || (action !== 'capture' && !selectedProfile)) return;
    if (restricted && !(state?.recoveryOnly && action === 'apply' && selectedProfile?.baseline)) return;
    if (action === 'remove' && (selectedProfile?.baseline || selectedProfile?.id === state?.activeProfileId)) return;
    const request = ++operation.current;
    const current = () => mounted.current && currentScope.current === scope && operation.current === request;
    const before = new Set(state?.profiles.map((profile) => profile.id));
    setPending(action); setError(''); sequence.current++;
    try {
      const next = action === 'capture' ? await api.capture(sourceId, modelId)
        : action === 'copy' ? await api.copy(sourceId, modelId, selectedProfile!.id)
        : action === 'apply' ? await api.apply(sourceId, modelId, selectedProfile!.id)
        : action === 'remove' ? await api.remove(sourceId, modelId, selectedProfile!.id)
        // modelPath is sent ONLY when the control was offered. Sending null unconditionally would
        // mean a save that merely renames a profile clears its quantization whenever discovery
        // came back empty — a transient unreadable directory would quietly rewrite the profile.
        // Omitting the key leaves the stored choice alone.
        : await api.update(sourceId, modelId, selectedProfile!.id, { name: draft!.name.trim(), contextTokens: Number(draft!.context), parallel: Number(draft!.parallel), ...(quants.length ? { modelPath: draft!.quant || null } : {}) });
      if (!current()) return;
      // An event-triggered read started before this response must not replace its newer state.
      sequence.current++; setLoading(false); adopt(next);
      if (action === 'copy') setSelectedId(next.profiles.find((profile) => !before.has(profile.id))?.id ?? selectedProfile!.id);
      if (action === 'apply' && state?.recoveryOnly) setSelectedId(selectedProfile!.id);
      if (action === 'remove') setSelectedId(next.activeProfileId ?? next.profiles.find((profile) => profile.baseline)?.id ?? next.profiles[0]?.id ?? '');
      if (action === 'save' || action === 'remove') setDrafts((current) => { const next = { ...current }; delete next[selectedProfile!.id]; return next; });
    } catch (cause) {
      if (current()) { setError(readable(cause)); void refresh(); }
    } finally { if (current()) { setPending(''); setLoading(false); } }
  };
  const edit = (patch: Partial<Draft>) => { if (selected) setDrafts((current) => ({ ...current, [selected.id]: { ...(current[selected.id] ?? draftOf(selected)), ...patch } })); };

  return <section aria-label="Engine profiles" className="border-t border-line bg-surface-3/35 p-3.5">
    <div className="flex items-center justify-between gap-2"><h4 className="text-xs font-medium text-ink">Engine profiles</h4>
      <button type="button" aria-label="Refresh engine profiles" className={button} disabled={!api || loading || saving} onClick={() => { setError(''); void refresh(); }}><RefreshCw size={11} /></button>
    </div>
    <p className="mt-1 text-[11px] leading-relaxed text-ink-3">Save context per slot, parallel request capacity, and which quantization to serve for this model. Applying a profile reloads its local engine when it is idle; the model’s chat and agent assignments stay the same.</p>
    {!api && <p className="mt-3 text-xs text-ink-3">Engine profile controls are unavailable in this window.</p>}
    {loading && !state && <p role="status" className="mt-3 text-xs text-ink-3">Reading engine settings…</p>}
    {state && !state.supported && !state.captured && <p className="mt-3 text-xs text-ink-3">{state.reason || 'This source does not expose a supported local engine service.'}</p>}
    {state && (state.supported || state.captured) && <>
      {state.reason && <p className="mt-2 text-[11px] text-ink-2">{state.reason}</p>}
      {state.recoveryOnly && <div className="mt-3 rounded-md border border-primary/35 bg-primary/5 p-2.5">
        <p className="text-xs font-medium text-ink">Engine recovery</p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-2">The engine’s configuration could not be verified. Saved profiles are preserved. Restore Straight shot to reload the original configuration and verify it before continuing.</p>
        {baseline && <button type="button" className={`${button} mt-2 border-primary/50 text-primary`} disabled={saving || state.busy} onClick={() => void mutate('apply', baseline.id)}>{pending === 'apply' ? 'Restoring Straight shot…' : 'Restore Straight shot'}</button>}
      </div>}
      {state.actual && <p className="mt-3 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-[11px] text-ink-2">Verified engine: {amount(state.actual.contextTokens)} tokens per slot · {state.actual.parallel} parallel {state.actual.parallel === 1 ? 'slot' : 'slots'} · {amount(state.actual.contextTokens * state.actual.parallel)} total context{state.actual.modelPath ? <> · <span className="font-mono">{quants.find((variant) => variant.path === state.actual!.modelPath)?.quant ?? state.actual.modelPath.split('/').pop()}</span></> : ''}</p>}
      {!state.captured ? <div className="mt-3">
        <p className="text-[11px] leading-relaxed text-ink-3">Capture the current configuration as a protected Straight shot profile and create an editable Orchestration profile with up to 32,768 tokens per slot and 2 parallel slots. Capturing leaves the running engine unchanged.</p>
        <button type="button" className={`${button} mt-2 border-primary/50 text-primary`} disabled={saving || state.busy} onClick={() => void mutate('capture')}>{pending === 'capture' ? 'Capturing…' : 'Create engine profiles'}</button>
      </div> : <>
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Saved engine profiles">{state.profiles.map((profile) => <button type="button" key={profile.id} aria-pressed={profile.id === selected?.id} className={`${button} ${profile.id === selected?.id ? 'border-primary/50 bg-primary/10 text-primary' : ''}`} disabled={saving} onClick={() => setSelectedId(profile.id)}>
          {profile.id === state.activeProfileId && <Check size={11} />}<span className="max-w-[220px] truncate">{profile.name}</span>{profile.id === state.activeProfileId && <span className="text-[9px]">Active</span>}{!restricted && drafts[profile.id] && <span title="Unsaved edits">*</span>}
        </button>)}</div>
        {selected && draft && <>
          {selected.baseline && !restricted && <p className="mt-2 text-[11px] leading-relaxed text-ink-3">Straight shot preserves the original service configuration. Apply it to restore those exact settings, or make a copy to edit.</p>}
          {!selected.baseline && selectedLocked && !restricted && <p className="mt-2 text-[11px] text-ink-3">This profile is active. Make a copy to change its settings.</p>}
          {restricted && <p className="mt-2 text-[11px] text-ink-3">Saved configuration · read only until the engine is verified.</p>}
          <div className={`mt-3 grid grid-cols-1 gap-2 ${quants.length ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3'}`}>
            <label className="text-[11px] text-ink-3">Profile name<input aria-label="Engine profile name" className={field} value={draft.name} disabled={selectedLocked || saving} onChange={(event) => edit({ name: event.target.value })} maxLength={100} /></label>
            {!!quants.length && <label className="text-[11px] text-ink-3">Quantization<select aria-label="Engine quantization" className={`${field} font-mono`} value={draft.quant} disabled={selectedLocked || saving} onChange={(event) => edit({ quant: event.target.value })}>
              <option value="">Service default</option>
              {quants.map((variant) => <option key={variant.path} value={variant.path}>{variant.quant} · {size(variant.bytes)}{variant.shards > 1 ? ` · ${variant.shards} shards` : ''}</option>)}
              {quantMissing && <option value={draft.quant}>Missing file</option>}
            </select></label>}
            <label className="text-[11px] text-ink-3">Context per slot<input aria-label="Engine context per slot" className={`${field} font-mono`} value={draft.context} disabled={selectedLocked || saving} type="number" min={limits.minContextTokens} max={limits.maxContextTokens} step={1} onChange={(event) => edit({ context: event.target.value })} /></label>
            <label className="text-[11px] text-ink-3">Parallel slots<input aria-label="Engine parallel slots" className={`${field} font-mono`} value={draft.parallel} disabled={selectedLocked || saving} type="number" min={1} max={limits.maxParallel} step={1} onChange={(event) => edit({ parallel: event.target.value })} /></label>
          </div>
          {valid && <p className="mt-2 text-[10px] leading-relaxed text-ink-3">{amount(Number(draft.context) * Number(draft.parallel))} total context tokens configured across slots. More slots or context require more memory. Prompt context limits may further restrict each request.</p>}
          {quantMissing && <p className="mt-2 text-[10px] text-danger">This profile names a weights file that is no longer on disk. Choose another quantization, or the service default, before applying it.</p>}
          {!!quants.length && draft.quant !== (selected.modelPath ?? '') && <p className="mt-2 text-[10px] text-ink-3">Changing the quantization reloads the engine onto different weights. A lower quantization is smaller and, on a model that reads all its weights each token, faster — at some cost in precision.</p>}
          {!restricted && <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={button} disabled={saving || dirty} onClick={() => void mutate('copy')}><Copy size={11} />{pending === 'copy' ? 'Copying…' : 'Make a copy'}</button>
            {!selectedLocked && <button type="button" className={button} disabled={saving || !dirty || !valid} onClick={() => void mutate('save')}><Save size={11} />{pending === 'save' ? 'Saving…' : 'Save profile'}</button>}
            {dirty && <button type="button" className={button} disabled={saving} onClick={() => setDrafts((current) => { const next = { ...current }; delete next[selected.id]; return next; })}>Discard edits</button>}
            <button type="button" className={`${button} border-primary/50 text-primary`} disabled={saving || dirty || state.busy || state.activeProfileId === selected.id} onClick={() => void mutate('apply')}>{pending === 'apply' ? 'Reloading engine…' : state.activeProfileId === selected.id ? 'Applied' : 'Apply profile'}</button>
            {!selectedLocked && <button type="button" className={`${button} hover:border-danger/60 hover:text-danger`} disabled={saving} onClick={() => setPendingRemoval({ scope, id: selected.id })}><Trash2 size={11} />{pending === 'remove' ? 'Deleting…' : 'Delete profile'}</button>}
          </div>}
          {dirty && <p className="mt-2 text-[10px] text-ink-3">Save these edits before copying or applying. Saving alone leaves the current engine unchanged.</p>}
          {dirty && !valid && <p className="mt-2 text-[10px] text-danger">Enter a name of 1–100 characters, {amount(limits.minContextTokens)}–{amount(limits.maxContextTokens)} context tokens per slot, and 1–{limits.maxParallel} slots, with at most {amount(limits.maxTotalContextTokens)} total context tokens.</p>}
        </>}
      </>}
      {state.busy && <p role="status" className="mt-2 text-[11px] text-ink-3">This engine has an active turn. Wait for it to finish before capturing or applying a profile.</p>}
      {saving && (pending === 'apply' || state.applying) && <p role="status" className="mt-2 text-[11px] text-primary">Reloading the model and verifying its context and parallel capacity. This can take several minutes.</p>}
      {!state.actual && state.captured && !state.recoveryOnly && <p className="mt-2 text-[11px] text-ink-3">The current engine settings could not be verified. Refresh after the source is available.</p>}
    </>}
    {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
    {removal && !saving && <ConfirmDialog title="Delete this engine profile?" message={`“${removal.name}” and its unsaved edits will be removed. The active engine configuration stays the same.`} confirmLabel="Delete saved profile" tone="danger"
      onCancel={() => setPendingRemoval(null)} onConfirm={() => { setPendingRemoval(null); void mutate('remove', removal.id); }} />}
  </section>;
}
