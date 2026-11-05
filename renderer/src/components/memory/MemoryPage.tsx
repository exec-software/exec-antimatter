import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, ChevronDown, ChevronRight, FileText, FolderOpen, Pencil, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import type { MemoryNote, MemoryPageState, MemoryPageTarget, MemoryScope, MemorySettings } from '../../types';

interface Props {
  onClose: () => void;
}

interface Draft {
  id?: string;
  name: string;
  description: string;
  content: string;
}

const EMPTY_DRAFT: Draft = { name: '', description: '', content: '' };

/** The IPC wrapper's prefix says nothing a person can act on; the message after it does. */
const reason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

const relative = (at: number): string => {
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
};

/** The same rough rate the context budget uses, so the two never disagree about a file's cost. */
const tokens = (characters: number): string => `about ${Math.max(1, Math.round(characters / 3.2)).toLocaleString()} tokens`;

/**
 * Memory: what conversations are told before they start.
 *
 * Two kinds of thing, shown together because a conversation is given both. A project's own
 * instructions are files in the project, written for anyone working in it, and are opened in the
 * editor rather than edited here. Notes are Antimatter's: the model saves them as it learns
 * something worth keeping, and this is where a person reads them, corrects them, adds their own
 * and throws away the ones that turned out wrong.
 */
export function MemoryPage({ onClose }: Props) {
  /** Another project being looked at, by root; null for the one the workspace belongs to. */
  const [project, setProject] = useState<string | null>(null);
  const [state, setState] = useState<MemoryPageState | null>(null);
  const [error, setError] = useState('');
  const target = useMemo<MemoryPageTarget>(() => (project ? { project } : {}), [project]);

  const refresh = useCallback(() => {
    window.electronAPI.memory
      .state(target)
      .then(setState)
      .catch((cause) => {
        console.error('Could not read memory:', cause);
        setError(`Could not read memory: ${reason(cause)}`);
      });
  }, [target]);

  useEffect(refresh, [refresh]);
  // A model saving a note while this is open, or another window changing one, shows up here.
  useEffect(() => window.electronAPI.onMemoryChanged(refresh), [refresh]);

  const applySettings = (patch: Partial<MemorySettings>) => {
    if (!state) return;
    setState({ ...state, settings: { ...state.settings, ...patch } });
    setError('');
    window.electronAPI.memory
      .setSettings(patch)
      .then(refresh)
      .catch((cause) => {
        setError(`Could not save that setting: ${reason(cause)}`);
        refresh();
      });
  };

  const run = (work: Promise<unknown>, what: string) =>
    work.then(refresh).catch((cause) => {
      setError(`${what}: ${reason(cause)}`);
      throw cause;
    });

  const viewingCurrent = !state || state.project.root === state.current;
  const others = state?.projects.filter((entry) => entry.root !== state.current) ?? [];

  return (
    <div className="absolute inset-0 overflow-y-auto bg-surface">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
        <Brain size={16} className="text-primary" />
        <h1 className="text-sm font-semibold text-ink">Memory</h1>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink"
        >
          <X size={12} />
          Done
        </button>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 py-5">
        {error && (
          <p role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-danger/50 bg-danger/5 px-3 py-2 text-xs text-danger">
            <span className="min-w-0 flex-1">{error}</span>
            <button type="button" onClick={() => setError('')} aria-label="Dismiss" className="shrink-0 text-danger/80 hover:text-danger">
              <X size={12} />
            </button>
          </p>
        )}

        <p className="text-xs leading-relaxed text-ink-2">
          What a conversation is told before it starts: the project&apos;s own instructions, and notes kept from earlier
          conversations. The model saves a note when it learns something worth knowing next time — a preference, a
          correction, a decision about the project — and you can read, fix, add or delete any of them here. A conversation
          keeps the notes it started with, since any it saves along the way are already in front of it; a change made on
          this page reaches open conversations on their next turn.
        </p>

        <section className="mt-5">
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-3">Settings</h2>
          <div className="mt-2 rounded-lg border border-line bg-surface-2 p-3">
            <Toggle
              checked={state?.settings.enabled ?? true}
              disabled={!state}
              onChange={(enabled) => applySettings({ enabled })}
              label="Remember between conversations"
              detail="Conversations are given the notes below, and the model can save, correct and delete its own. With “Ask first” each change is put to you; a read-only conversation can read notes but not change them."
            />
            <div className="mt-3 border-t border-line-soft pt-3">
              <Toggle
                checked={state?.settings.instructions ?? true}
                disabled={!state}
                onChange={(instructions) => applySettings({ instructions })}
                label="Read each project's instructions"
                detail="A project's AGENTS.md — or its CLAUDE.md, in a directory without one — from the top of the repository down to the workspace, up to 32 KB. Conversations, agents and orchestrated runs in the project are all given it."
              />
            </div>
          </div>
        </section>

        {state && (
          <>
            <section className="mt-6">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h2 className="text-xs font-medium uppercase tracking-wide text-ink-3">
                  {viewingCurrent ? 'This project' : 'Another project'}
                </h2>
                {(others.length > 0 || !viewingCurrent) && (
                  <label className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-3">
                    Showing
                    <select
                      value={viewingCurrent ? '' : state.project.root}
                      onChange={(event) => setProject(event.target.value || null)}
                      className="max-w-72 truncate rounded-md border border-line bg-surface-3 px-1.5 py-1 text-[11px] text-ink focus:border-primary/60 focus:outline-none"
                    >
                      <option value="">{state.current} (this workspace)</option>
                      {others.map((entry) => (
                        <option key={entry.root} value={entry.root}>
                          {entry.root} ({entry.notes} {entry.notes === 1 ? 'note' : 'notes'})
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <p className="mt-1 break-all font-mono text-[11px] text-ink-2">{state.project.root}</p>
              {viewingCurrent && state.workspace !== state.project.root && (
                <p className="mt-0.5 text-[11px] text-ink-3">
                  The workspace, {state.workspace}, is inside this repository, and shares its notes.
                </p>
              )}

              <div className="mt-3 rounded-lg border border-line bg-surface-2 p-3">
                <h3 className="text-xs font-medium text-ink">Instructions</h3>
                {state.project.instructions.length ? (
                  <ul className="mt-2 grid gap-1">
                    {state.project.instructions.map((file) => (
                      <li key={file.path} className="flex items-center gap-2 text-xs">
                        <FileText size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
                        <span className="min-w-0 truncate font-mono text-ink" title={file.path}>
                          {file.label}
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-3">{tokens(file.length)}</span>
                        {file.truncated && (
                          <span
                            className="flex shrink-0 items-center gap-1 text-[11px] text-primary"
                            title="Past the 32 KB allowance. Conversations are told the rest is there, and where."
                          >
                            <TriangleAlert size={11} aria-hidden="true" />
                            not all read
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void run(window.electronAPI.memory.openInstructions(target, file.path), 'Could not open it').catch(() => undefined)}
                          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-2 transition hover:bg-surface-3 hover:text-ink"
                        >
                          Open
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                    No AGENTS.md or CLAUDE.md here. Rules for everyone working in the project — how it is built, what not
                    to touch, how a commit is written — belong in an AGENTS.md at the top of the repository.
                  </p>
                )}
                {!state.settings.instructions && state.project.instructions.length > 0 && (
                  <p className="mt-2 text-[11px] text-ink-3">Not read into conversations while the setting above is off.</p>
                )}
              </div>

              <NoteList
                title="Notes about this project"
                scope="project"
                notes={state.project.notes}
                enabled={state.settings.enabled}
                empty="Nothing yet. Notes about the project — a decision, a constraint, where something lives — go here, for conversations in this project alone."
                onSave={(draft) => run(window.electronAPI.memory.save(target, 'project', draft), 'Could not save the note')}
                onRemove={(id) => run(window.electronAPI.memory.remove(target, 'project', id), 'Could not delete the note')}
                onOpenFolder={() =>
                  void run(window.electronAPI.memory.openFolder(target, 'project'), 'Could not open the folder').catch(() => undefined)
                }
              />
            </section>

            <section className="mt-6">
              <h2 className="text-xs font-medium uppercase tracking-wide text-ink-3">About you — every project</h2>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                {state.person.name
                  ? `Antimatter calls you ${state.person.name}${state.person.pronouns ? ` (${state.person.pronouns})` : ''}.`
                  : 'Antimatter has not been told your name.'}{' '}
                Who you are is set in Settings, under About you; what it works out about you as you work is kept here.
              </p>
              <NoteList
                title="Notes about you"
                scope="user"
                notes={state.user.notes}
                enabled={state.settings.enabled}
                empty="Nothing yet. Who you are, how you like to work, and corrections to how Antimatter works go here, and are given to every conversation."
                onSave={(draft) => run(window.electronAPI.memory.save(target, 'user', draft), 'Could not save the note')}
                onRemove={(id) => run(window.electronAPI.memory.remove(target, 'user', id), 'Could not delete the note')}
                onOpenFolder={() =>
                  void run(window.electronAPI.memory.openFolder(target, 'user'), 'Could not open the folder').catch(() => undefined)
                }
              />
            </section>

            <p className="mt-6 text-[11px] leading-relaxed text-ink-3">
              Notes are Markdown files in <span className="font-mono">{state.location}</span> — one per note, with its name
              and summary at the top — so they can be read and edited with any editor as well. They never hold passwords,
              keys or tokens: a note that looks like one is refused, because notes are sent to whichever source answers the
              conversation.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
  label,
  detail,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  detail: string;
}) {
  return (
    <label className={`flex items-start gap-2 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 accent-[rgb(var(--color-primary))]"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="mt-1 block text-xs leading-relaxed text-ink-2">{detail}</span>
      </span>
    </label>
  );
}

interface NoteListProps {
  title: string;
  scope: MemoryScope;
  notes: MemoryNote[];
  enabled: boolean;
  empty: string;
  onSave: (draft: Draft) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
  onOpenFolder: () => void;
}

function NoteList({ title, scope, notes, enabled, empty, onSave, onRemove, onOpenFolder }: NoteListProps) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-ink">
          {title}
          <span className="ml-1.5 font-normal text-ink-3">{notes.length}</span>
        </h3>
        <button
          type="button"
          onClick={onOpenFolder}
          title="Open the folder these notes are kept in"
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-3 transition hover:bg-surface-3 hover:text-ink"
        >
          <FolderOpen size={12} aria-hidden="true" />
          Folder
        </button>
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={adding}
          className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40"
        >
          <Plus size={12} aria-hidden="true" />
          Add a note
        </button>
      </div>

      {!enabled && notes.length > 0 && (
        <p className="mt-1 text-[11px] text-ink-3">Memory is off: conversations are not given these.</p>
      )}

      {adding && (
        <NoteEditor
          initial={EMPTY_DRAFT}
          scope={scope}
          onCancel={() => setAdding(false)}
          onSave={(draft) => onSave(draft).then(() => setAdding(false))}
        />
      )}

      {notes.length ? (
        <ul className="mt-2 divide-y divide-line-soft">
          {notes.map((note) => (
            <NoteRow key={note.id} note={note} onSave={onSave} onRemove={onRemove} />
          ))}
        </ul>
      ) : (
        !adding && <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{empty}</p>
      )}
    </div>
  );
}

function NoteRow({
  note,
  onSave,
  onRemove,
}: {
  note: MemoryNote;
  onSave: (draft: Draft) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (editing) {
    return (
      <li className="py-2">
        <NoteEditor
          initial={{ id: note.id, name: note.name, description: note.description, content: note.content }}
          scope={note.scope}
          onCancel={() => setEditing(false)}
          onSave={(draft) => onSave(draft).then(() => setEditing(false))}
        />
      </li>
    );
  }

  return (
    <li className="py-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="-mx-1 flex w-[calc(100%+0.5rem)] items-start gap-1.5 rounded px-1 py-1 text-left transition hover:bg-surface-3/50"
      >
        {open ? (
          <ChevronDown size={13} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
        ) : (
          <ChevronRight size={13} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-ink">{note.name}</span>
          <span className="block text-[11px] leading-relaxed text-ink-2">{note.description}</span>
        </span>
        <span className="shrink-0 pt-0.5 text-[10px] text-ink-3">{relative(note.updatedAt)}</span>
      </button>

      {open && (
        <div className="ml-5 mt-1">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-0 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-2">
            {note.content}
          </pre>
          {confirming ? (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
              <span className="text-ink">Delete “{note.name}”? Conversations stop being told it.</span>
              <button
                type="button"
                onClick={() => void onRemove(note.id).catch(() => setConfirming(false))}
                className="rounded bg-danger px-2 py-0.5 font-semibold text-on-danger"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded border border-line px-2 py-0.5 text-ink-2 hover:text-ink"
              >
                Keep
              </button>
            </div>
          ) : (
            <div className="mt-1.5 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-2 transition hover:bg-surface-3 hover:text-ink"
              >
                <Pencil size={11} aria-hidden="true" />
                Edit
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-2 transition hover:bg-danger/10 hover:text-danger"
              >
                <Trash2 size={11} aria-hidden="true" />
                Delete
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function NoteEditor({
  initial,
  scope,
  onSave,
  onCancel,
}: {
  initial: Draft;
  scope: MemoryScope;
  onSave: (draft: Draft) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const field =
    'w-full rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';
  const ready = draft.name.trim() && draft.content.trim();

  const save = () => {
    if (!ready || saving) return;
    setSaving(true);
    onSave(draft)
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };

  return (
    <form
      className="mt-2 grid gap-1.5 rounded-md border border-primary/40 bg-surface p-2"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <input
        autoFocus
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        placeholder={scope === 'user' ? 'Name — for example: Prefers short answers' : 'Name — for example: Release process'}
        aria-label="Name"
        maxLength={80}
        className={field}
      />
      <input
        value={draft.description}
        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        placeholder="One line a conversation sees first. Left empty, the note's first sentence is used."
        aria-label="Summary"
        maxLength={200}
        className={field}
      />
      <textarea
        value={draft.content}
        onChange={(event) => setDraft({ ...draft, content: event.target.value })}
        placeholder="The note. For a preference or a correction: the rule, why, and how to apply it."
        aria-label="Note"
        rows={6}
        className={`${field} resize-y font-mono leading-relaxed`}
      />
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 transition hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!ready || saving}
          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-on-primary transition hover:bg-primary-strong disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
