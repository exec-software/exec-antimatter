import { useEffect, useRef, useState } from 'react';
import { DEFAULT_ASSISTANT, type AssistantSettings } from '../../../../src/api/setup';
import type { Person } from '../../types';
import { AssistantFields, setupError } from '../settings/AssistantPanel';
import { WorkloadCatalog } from './WorkloadCatalog';
import { SetupExtras } from './SetupExtras';

const EMPTY_PERSON: Person = { name: '', pronouns: '', about: '', updatedAt: 0 };
const titles = ['About you', 'Your assistant', 'Your models', 'Finishing touches'];
const LAST = titles.length - 1;
const field = 'w-full rounded-md border border-line bg-surface-3 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';

export function SetupWizard({ onClose, onOpenModels, onOpenRemoteSettings }: {
  onClose(): void;
  onOpenModels(): void;
  onOpenRemoteSettings(): void;
}) {
  const [step, setStep] = useState(0);
  const [person, setPerson] = useState<Person>({ ...EMPTY_PERSON });
  const [savedPerson, setSavedPerson] = useState<Person>({ ...EMPTY_PERSON });
  const [assistant, setAssistant] = useState<AssistantSettings>({ ...DEFAULT_ASSISTANT });
  const [savedAssistant, setSavedAssistant] = useState<AssistantSettings>({ ...DEFAULT_ASSISTANT });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let cancelled = false;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void Promise.all([window.electronAPI.user.get(), window.electronAPI.setup.get()]).then(([who, state]) => {
      if (!cancelled) { setPerson(who); setSavedPerson(who); setAssistant(state.assistant); setSavedAssistant(state.assistant); setLoaded(true); }
    }).catch((cause) => { if (!cancelled) setError(setupError(cause)); });
    title.current?.focus();
    return () => { cancelled = true; previous?.focus(); };
  }, []);
  useEffect(() => { title.current?.focus(); }, [step]);
  const saveCurrent = async () => {
    if (step === 0) {
      const patch: Partial<Person> = {};
      for (const key of ['name', 'pronouns', 'about'] as const) if (person[key] !== savedPerson[key]) patch[key] = person[key];
      if (Object.keys(patch).length) {
        const next = await window.electronAPI.user.set(patch);
        setPerson(next); setSavedPerson(next);
      }
    } else if (step === 1) {
      const patch: Partial<AssistantSettings> = {};
      if (assistant.name !== savedAssistant.name) patch.name = assistant.name;
      if (assistant.personality !== savedAssistant.personality) patch.personality = assistant.personality;
      if (Object.keys(patch).length) {
        const state = await window.electronAPI.setup.updateAssistant(patch);
        setAssistant(state.assistant); setSavedAssistant(state.assistant);
      }
    }
  };
  const next = async () => {
    setBusy(true); setError('');
    try {
      await saveCurrent();
      if (step === LAST) { await window.electronAPI.setup.complete(); onClose(); }
      else setStep(step + 1);
    } catch (cause) { setError(setupError(cause)); }
    finally { setBusy(false); }
  };
  /** Leaving the wizard for a Settings section still counts as having run setup. */
  const finishThen = async (go: () => void) => {
    setBusy(true); setError('');
    try { await window.electronAPI.setup.complete(); onClose(); go(); }
    catch (cause) { setError(setupError(cause)); }
    finally { setBusy(false); }
  };
  const skip = async (openModels = false) => {
    setBusy(true); setError('');
    try {
      await window.electronAPI.setup.complete();
      onClose(); if (openModels) onOpenModels();
    } catch (cause) { setError(setupError(cause)); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="setup-title" className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, a[href]');
        if (!focusable?.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === title.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <div className="border-b border-line px-6 py-5">
        <p className="text-xs font-medium text-accent">Make Antimatter yours · {step + 1} of {titles.length}</p>
        <h2 ref={title} tabIndex={-1} id="setup-title" className="mt-1 text-xl font-semibold text-ink outline-none">{titles[step]}</h2>
        <p className="mt-1 text-xs text-ink-3">You can revisit setup from Settings. Existing choices are loaded for you.</p>
      </div>
      <div className="overflow-y-auto px-6 py-5">
        {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
        {!loaded ? <p role="status" className="text-sm text-ink-3">{error ? 'Setup could not load your settings. Close and try again.' : 'Loading your settings…'}</p> : step === 0 ? <div className="space-y-3">
          <p className="text-sm text-ink-2">Tell your assistant what to call you and what you would like it to know. Every field is optional.</p>
          <label className="block"><span className="mb-1 block text-xs font-medium text-ink">Your name</span><input className={field} value={person.name} maxLength={60} disabled={busy} onChange={(event) => setPerson({ ...person, name: event.target.value })} placeholder="What should I call you?" /></label>
          <label className="block"><span className="mb-1 block text-xs font-medium text-ink">Pronouns</span><input className={field} value={person.pronouns} maxLength={40} disabled={busy} onChange={(event) => setPerson({ ...person, pronouns: event.target.value })} placeholder="For example, they/them" /></label>
          <label className="block"><span className="mb-1 block text-xs font-medium text-ink">About you</span><textarea className={`${field} resize-y`} value={person.about} rows={4} maxLength={2000} disabled={busy} onChange={(event) => setPerson({ ...person, about: event.target.value })} placeholder="Your work, interests, and how you like to collaborate." /></label>
          <p className="text-xs text-ink-3">Saved locally and included in prompts sent to your selected model.</p>
        </div> : step === 1 ? <AssistantFields value={assistant} onChange={setAssistant} disabled={busy} />
          : step === 2 ? <WorkloadCatalog onOpenModels={() => void skip(true)} />
            : <SetupExtras disabled={busy} onOpenRemoteSettings={() => { void finishThen(onOpenRemoteSettings); }} />}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-6 py-4">
        <button type="button" disabled={busy} onClick={() => void skip()} className="mr-auto text-xs text-ink-3 hover:text-ink disabled:opacity-50">Skip setup</button>
        {step > 0 && <button type="button" disabled={busy} onClick={() => setStep(step - 1)} className="rounded-md border border-line px-3 py-2 text-xs text-ink-2 disabled:opacity-50">Back</button>}
        <button type="button" disabled={busy || !loaded || (step === 1 && !assistant.name.trim())} onClick={() => void next()} className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-on-primary disabled:opacity-50">{busy ? 'Saving…' : step === LAST ? 'Finish setup' : 'Save and continue'}</button>
      </div>
    </div>
  </div>;
}
