import { useEffect, useId, useRef, useState } from 'react';
import { AudioLines, Check, RefreshCw, Save, ShieldAlert } from 'lucide-react';
import type { VoiceConfiguration, VoiceSettings } from '../../../../src/api/voice';
import type { VoiceBackendCapabilities } from '../../../../src/main/voice/backend';

interface Props {
  config: VoiceConfiguration;
  onSaved(config: VoiceConfiguration): void;
  disabled?: boolean;
  onError?(message: string): void;
  embedded?: boolean;
}

const field = 'w-full rounded-md border border-line bg-surface-0 px-2.5 py-2 text-xs text-ink outline-none focus:border-primary/70 disabled:opacity-50';
const button = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:bg-surface-3 hover:text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70';
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

export function voiceSettingsProblem(settings: VoiceSettings, sources: VoiceConfiguration['sources']): string | null {
  const input = sources.find((source) => source.id === settings.inputSourceId);
  if (!input) return 'Choose an audio input source. Add compatible sources in Settings → Models & providers.';
  if (!settings.inputModel.trim()) return 'Choose or enter an audio input model.';
  const speech = sources.find((source) => source.id === settings.speechSourceId);
  if (settings.speechEnabled && !speech) return 'Choose a speech output source, or turn spoken responses off.';
  if (settings.speechEnabled && (!settings.speechModel.trim() || !settings.speechVoice.trim())) return 'Choose a speech model and voice, or turn spoken responses off.';
  if ((!input.local || (settings.speechEnabled && speech && !speech.local)) && !settings.allowRemote) return 'A selected source is remote. Explicitly allow remote audio/text transfer below, or choose local sources.';
  return null;
}

/** Configuration is saved deliberately; probing never starts a microphone or generates speech. */
export function VoiceSettingsPanel({ config, onSaved, disabled = false, onError, embedded = false }: Props) {
  const [draft, setDraft] = useState<VoiceSettings>({ ...config.settings });
  const [busy, setBusy] = useState<'save' | 'probe' | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [probe, setProbe] = useState<VoiceBackendCapabilities | null>(null);
  const generation = useRef(0);
  const modelsId = useId();
  const speechModelsId = useId();
  const settingsKey = JSON.stringify(config.settings);
  useEffect(() => {
    setDraft({ ...config.settings }); setProbe(null); setError('');
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [settingsKey]);

  const dirty = JSON.stringify(draft) !== settingsKey;
  const problem = voiceSettingsProblem(draft, config.sources);
  // The configuration snapshot may predate Stop; the owner supplies live session state.
  const inactive = disabled;
  const input = config.sources.find((source) => source.id === draft.inputSourceId);
  const speech = config.sources.find((source) => source.id === draft.speechSourceId);
  const remote = (input && !input.local) || (draft.speechEnabled && speech && !speech.local);
  const change = (patch: Partial<VoiceSettings>) => { setDraft((value) => ({ ...value, ...patch })); setSaved(false); setError(''); setProbe(null); };
  const report = (failure: unknown) => { const message = reason(failure); setError(message); onError?.(message); };

  const save = async () => {
    if (inactive || problem || busy) return;
    const current = generation.current;
    setBusy('save'); setError(''); setSaved(false);
    try {
      const next = await window.electronAPI.voice.configure({ ...draft, inputModel: draft.inputModel.trim(), speechModel: draft.speechModel.trim(), speechVoice: draft.speechVoice.trim() });
      if (current === generation.current) { setDraft({ ...next.settings }); setSaved(true); onSaved(next); }
    } catch (failure) { if (current === generation.current) report(failure); }
    finally { setBusy(null); }
  };

  const checkInput = async () => {
    if (inactive || dirty || problem || busy || config.configurationError) return;
    const current = generation.current;
    setBusy('probe'); setError(''); setProbe(null);
    try { const next = await window.electronAPI.voice.probe(); if (current === generation.current) setProbe(next); }
    catch (failure) { if (current === generation.current) report(failure); }
    finally { setBusy(null); }
  };

  const sourceOptions = (selected: string) => <>
    <option value="">Choose a source</option>
    {selected && !config.sources.some((source) => source.id === selected) && <option value={selected}>Unavailable saved source</option>}
    {config.sources.map((source) => <option key={source.id} value={source.id}>{source.name} · {source.local ? 'local' : 'remote'}</option>)}
  </>;

  return <section aria-label="Voice settings" className={embedded ? '' : 'rounded-xl border border-line bg-surface-2 p-3'}>
    {!embedded && <h2 className="flex items-center gap-2 text-xs font-semibold text-ink"><AudioLines size={15} />Voice settings</h2>}
    <p className="mt-2 text-[11px] leading-5 text-ink-3">Speech uses existing compatible inference sources. No new keys or arbitrary endpoints are entered here. Streaming input shows words as you speak. Replies play progressively, with automatic pause detection or hold-to-talk.</p>
    {config.configurationError && <p role="alert" className="mt-2 rounded-md border border-danger/30 bg-danger/5 p-2 text-xs leading-5 text-danger">{config.configurationError} Review these settings and save them to repair the configuration.</p>}
    {inactive && <p role="status" className="mt-2 text-xs text-ink-2">Stop the active voice session before changing its source or model.</p>}
    <fieldset disabled={inactive || !!busy} className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="text-[11px] text-ink-3">Audio input source<select aria-label="Audio input source" value={draft.inputSourceId} onChange={(event) => { const next = config.sources.find((source) => source.id === event.target.value); const model = next?.models.find((id) => /moonshine.*streaming/i.test(id)); change({ inputSourceId: event.target.value, inputModel: model ?? '', ...(model ? { inputMode: 'realtime' as const } : {}) }); }} className={`${field} mt-1`}>{sourceOptions(draft.inputSourceId)}</select></label>
      <label className="text-[11px] text-ink-3">Audio input model<input aria-label="Audio input model" value={draft.inputModel} onChange={(event) => change({ inputModel: event.target.value })} list={modelsId} placeholder="Choose a listed model or enter its ID" className={`${field} mt-1`} /><datalist id={modelsId}>{input?.models.map((model) => <option key={model} value={model} />)}</datalist></label>
      <label className="text-[11px] text-ink-3">Input endpoint<select aria-label="Voice input endpoint" value={draft.inputMode} onChange={(event) => change({ inputMode: event.target.value as VoiceSettings['inputMode'] })} className={`${field} mt-1`}><option value="realtime">Live streaming · speech-to-text model</option><option value="chat-audio">Audio chat · multimodal model</option><option value="transcriptions">Transcriptions · speech-to-text model</option></select></label>
      <p className="self-end text-[10px] leading-4 text-ink-3">{draft.inputMode === 'realtime' ? 'Requires a streaming speech server. Local Moonshine Streaming supports English; audio chat remains available for other languages.' : 'Pick the mode your server implements. Audio chat transcribes a complete recording after each pause.'}</p>
      <label className="flex items-center gap-2 text-xs text-ink-2 sm:col-span-2"><input type="checkbox" checked={draft.speechEnabled} onChange={(event) => change({ speechEnabled: event.target.checked })} />Read concise responses aloud</label>
      {draft.speechEnabled && <>
        <label className="text-[11px] text-ink-3">Speech output source<select aria-label="Speech output source" value={draft.speechSourceId} onChange={(event) => change({ speechSourceId: event.target.value, speechModel: '' })} className={`${field} mt-1`}>{sourceOptions(draft.speechSourceId)}</select></label>
        <label className="text-[11px] text-ink-3">Speech model<input aria-label="Speech model" value={draft.speechModel} onChange={(event) => change({ speechModel: event.target.value })} list={speechModelsId} placeholder="Speech model ID" className={`${field} mt-1`} /><datalist id={speechModelsId}>{speech?.models.map((model) => <option key={model} value={model} />)}</datalist></label>
        <label className="text-[11px] text-ink-3">Voice<input aria-label="Speech voice" value={draft.speechVoice} onChange={(event) => change({ speechVoice: event.target.value })} placeholder="Voice supported by your speech model" className={`${field} mt-1`} /></label>
        <p className="self-end text-[10px] leading-4 text-ink-3">Output uses the selected source’s speech endpoint. A separate local speech model can be used alongside your audio input model.</p>
      </>}
      <label className={`flex items-start gap-2 rounded-md border p-2 text-[11px] leading-5 sm:col-span-2 ${remote ? 'border-warning/40 bg-warning/5 text-ink-2' : 'border-line text-ink-3'}`}><input type="checkbox" checked={draft.allowRemote} onChange={(event) => change({ allowRemote: event.target.checked })} className="mt-1" /><span><ShieldAlert size={12} className="mr-1 inline" />Allow sending microphone audio and spoken-response text to the selected remote HTTPS sources. Their privacy policies and usage charges apply. Leave off for local-only voice.</span></label>
    </fieldset>
    {problem && <p className="mt-2 text-[11px] leading-5 text-ink-3">{problem}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" onClick={() => void save()} disabled={inactive || !!busy || !!problem || (!dirty && !config.configurationError)} className={button}><Save size={12} />{busy === 'save' ? 'Saving…' : 'Save settings'}</button>
      <button type="button" onClick={() => void checkInput()} disabled={inactive || !!busy || !!problem || dirty || !!config.configurationError} title={dirty || config.configurationError ? 'Save settings before checking the input source.' : 'Read source capabilities without recording audio.'} className={button}><RefreshCw size={12} className={busy === 'probe' ? 'animate-spin' : ''} />Check saved input</button>
      {saved && !dirty && <span role="status" className="flex items-center gap-1 text-[11px] text-accent"><Check size={12} />Saved</span>}
    </div>
    {error && <p role="alert" className="mt-2 text-xs leading-5 text-danger">{error}</p>}
    {probe && <div role="status" className="mt-3 rounded-md border border-line bg-surface-0 p-2 text-[11px] leading-5 text-ink-3"><p className="text-ink-2">Input model: {probe.modelAvailable ? 'listed by source' : 'not found in source list'} · Audio input: {probe.input}</p>{probe.notes.map((note) => <p key={note}>{note}</p>)}<p>This checks the saved input source only. It does not record your microphone or verify the separate speech output model.</p></div>}
  </section>;
}
