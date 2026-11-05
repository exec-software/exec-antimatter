import { useEffect, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import type { Person } from '../../types';

interface Props {
  /** Opens the Memory page, where what Antimatter has worked out about you is kept. */
  onOpenMemory: () => void;
}

const BLANK: Person = { name: '', pronouns: '', about: '', updatedAt: 0 };

const reason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

/**
 * Who Antimatter is talking to.
 *
 * A name is the smallest thing that makes a local assistant somebody's rather than anybody's, and
 * the one it cannot work out for itself. The pronouns field is here for the same reason the prompt
 * mentions it: without one, a model writing about you in the third person guesses from your name.
 *
 * What you write here is yours — the model is told it and never edits it. What it works out about
 * you as you work lands in Memory instead, where it can be read and thrown out.
 */
export function AboutYouPanel({ onOpenMemory }: Props) {
  const [saved, setSaved] = useState<Person | null>(null);
  const [draft, setDraft] = useState<Person>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.user
      .get()
      .then((person) => {
        if (cancelled) return;
        setSaved(person);
        setDraft(person);
      })
      .catch((cause) => {
        if (cancelled) return;
        console.error('Could not read who you are:', cause);
        setError(`Could not read this: ${reason(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The model can fill in a name it was told, so take the change rather than showing a stale
  // field — unless something is half-typed here, which is the one thing not to overwrite.
  const editing = useRef({ draft, saved });
  editing.current = { draft, saved };
  useEffect(
    () =>
      window.electronAPI.onMemoryChanged(() => {
        window.electronAPI.user
          .get()
          .then((person) => {
            setSaved(person);
            if (!dirty(editing.current.draft, editing.current.saved)) setDraft(person);
          })
          .catch((cause) => console.error('Could not read who you are:', cause));
      }),
    []
  );

  const changed = dirty(draft, saved);

  const apply = () => {
    if (!changed || busy) return;
    setBusy(true);
    setError('');
    setNote('');
    window.electronAPI.user
      .set({ name: draft.name, pronouns: draft.pronouns, about: draft.about })
      .then((person) => {
        setSaved(person);
        setDraft(person);
        setNote(person.name ? `Antimatter will call you ${person.name}.` : 'Saved.');
      })
      .catch((cause) => setError(`Could not save that: ${reason(cause)}`))
      .finally(() => setBusy(false));
  };

  const field =
    'w-full rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';

  return (
    <div>
      {error && (
        <p role="alert" className="mb-2 rounded-md border border-danger/50 bg-danger/5 px-2 py-1.5 text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <label className="min-w-48 flex-1">
          <span className="mb-1 block text-[11px] font-medium text-ink">Name</span>
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="What to call you"
            maxLength={60}
            className={field}
          />
        </label>
        <label className="w-40">
          <span className="mb-1 block text-[11px] font-medium text-ink">Pronouns</span>
          <input
            value={draft.pronouns}
            onChange={(event) => setDraft({ ...draft, pronouns: event.target.value })}
            placeholder="they/them"
            maxLength={40}
            className={field}
          />
        </label>
      </div>

      <label className="mt-2 block">
        <span className="mb-1 block text-[11px] font-medium text-ink">About you</span>
        <textarea
          value={draft.about}
          onChange={(event) => setDraft({ ...draft, about: event.target.value })}
          placeholder="Anything every conversation should know: what you work on, how you like to be worked with, what you would rather it did not do."
          rows={4}
          maxLength={2000}
          className={`${field} resize-y leading-relaxed`}
        />
      </label>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-ink-3">
          Saved locally and included in prompts sent to your selected inference provider.
          Antimatter can also learn your name and pronouns from chat; the rest is yours to write.
        </p>
        {changed && (
          <button
            type="button"
            onClick={() => setDraft(saved ?? BLANK)}
            className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 transition hover:text-ink"
          >
            Undo
          </button>
        )}
        <button
          type="button"
          onClick={apply}
          disabled={!changed || busy}
          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-on-primary transition hover:bg-primary-strong disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {note && !changed && (
        <p role="status" className="mt-1 text-[11px] text-accent">
          {note}
        </p>
      )}

      <button
        type="button"
        onClick={onOpenMemory}
        className="mt-3 flex w-full items-start gap-2 rounded-md border-t border-line-soft pt-3 text-left transition hover:text-ink"
      >
        <Brain size={14} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
        <span className="text-[11px] leading-relaxed text-ink-2">
          <span className="font-medium text-ink">Manage memory</span> · Review, edit, or delete preferences learned from your conversations.
        </span>
      </button>
    </div>
  );
}

const dirty = (draft: Person, saved: Person | null): boolean =>
  !!saved && (draft.name !== saved.name || draft.pronouns !== saved.pronouns || draft.about !== saved.about);
