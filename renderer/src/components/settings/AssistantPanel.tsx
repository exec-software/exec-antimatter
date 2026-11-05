import { useEffect, useRef, useState } from 'react';
import { ASSISTANT_NAME_LIMIT, ASSISTANT_PERSONALITY_LIMIT, DEFAULT_ASSISTANT, type AssistantSettings } from '../../../../src/api/setup';

export const setupError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

const field = 'w-full rounded-md border border-line bg-surface-3 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';

export function AssistantFields({ value, onChange, disabled = false }: {
  value: AssistantSettings; onChange(value: AssistantSettings): void; disabled?: boolean;
}) {
  return <div className="space-y-3">
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink">Assistant name</span>
      <input className={field} value={value.name} maxLength={ASSISTANT_NAME_LIMIT} disabled={disabled}
        onChange={(event) => onChange({ ...value, name: event.target.value })} placeholder="Antimatter" />
    </label>
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink">Personality and working style</span>
      <textarea className={`${field} resize-y leading-relaxed`} value={value.personality} rows={5} maxLength={ASSISTANT_PERSONALITY_LIMIT}
        disabled={disabled} onChange={(event) => onChange({ ...value, personality: event.target.value })}
        placeholder="For example: warm and direct, curious about my ideas, concise by default. Explain tradeoffs and tell me when you disagree." />
    </label>
    <p className="text-xs leading-relaxed text-ink-3">Applies to your main assistant. Specialist agents keep their own roles. Saved locally and included in prompts sent to your selected model.</p>
  </div>;
}

export function AssistantPanel({ onOpenSetup }: { onOpenSetup?: () => void }) {
  const [saved, setSaved] = useState<AssistantSettings | null>(null);
  const [draft, setDraft] = useState<AssistantSettings>({ ...DEFAULT_ASSISTANT });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const editing = useRef({ draft, saved });
  editing.current = { draft, saved };
  useEffect(() => {
    let cancelled = false;
    let changed = false;
    const unsubscribe = window.electronAPI.setup.onChanged((state) => {
      changed = true;
      if (cancelled) return;
      const current = editing.current;
      setSaved(state.assistant);
      setDraft({
        name: !current.saved || current.draft.name === current.saved.name ? state.assistant.name : current.draft.name,
        personality: !current.saved || current.draft.personality === current.saved.personality ? state.assistant.personality : current.draft.personality,
      });
      setNote('');
    });
    window.electronAPI.setup.get().then((state) => {
      if (!cancelled && !changed) { setSaved(state.assistant); setDraft(state.assistant); }
    }).catch((cause) => { if (!cancelled) setError(setupError(cause)); });
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  const changed = !!saved && (draft.name !== saved.name || draft.personality !== saved.personality);
  const save = async () => {
    if (!saved || !changed || busy) return;
    setBusy(true); setError(''); setNote('');
    try {
      const patch: Partial<AssistantSettings> = {};
      if (saved.name !== draft.name) patch.name = draft.name;
      if (saved.personality !== draft.personality) patch.personality = draft.personality;
      const state = await window.electronAPI.setup.updateAssistant(patch);
      setSaved(state.assistant); setDraft(state.assistant); setNote('Assistant saved.');
    } catch (cause) { setError(setupError(cause)); }
    finally { setBusy(false); }
  };
  return <div>
    {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}
    <AssistantFields value={draft} onChange={setDraft} disabled={!saved || busy} />
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {onOpenSetup && <button type="button" onClick={onOpenSetup} className="mr-auto text-xs text-accent hover:underline">Open setup wizard</button>}
      {note && !changed && <span role="status" className="text-xs text-accent">{note}</span>}
      {changed && <button type="button" disabled={busy} onClick={() => setDraft(saved!)} className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-2">Undo</button>}
      <button type="button" disabled={!changed || busy || !draft.name.trim()} onClick={() => void save()} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary disabled:opacity-50">{busy ? 'Saving…' : 'Save assistant'}</button>
    </div>
  </div>;
}
