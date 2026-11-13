import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Plus, Save, Trash2, X } from 'lucide-react';
import type { LibraryEntry, LibraryLanguage, LibraryMutation, PensieveLibraryState } from '../../../../src/api/pensieveLibrary';
import { PensieveExperimental } from './PensieveExperimental';
import { ConfirmDialog } from '../ConfirmDialog';
import { clearFormDraft, readFormDraft, writeFormDraft } from '../../lib/formDrafts';
import { FormDraftNotice } from './FormDraftNotice';

const field = 'rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink';
const button = 'inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs text-ink-2 hover:bg-surface-3 disabled:opacity-50';
type Draft = { id?: string; title: string; content: string; entryKind: LibraryEntry['kind']; language: LibraryLanguage; scope: 'global' | 'project' };
const blank = (): Draft => ({ title: '', content: '', entryKind: 'note', language: 'shared', scope: 'global' });
interface SavedDraft { draft: Draft; revision: number }
const validDraft = (value: unknown): value is SavedDraft => {
  if (!value || typeof value !== 'object') return false;
  const record = value as SavedDraft, draft = record.draft;
  return Number.isSafeInteger(record.revision) && record.revision >= 0 && !!draft &&
    (draft.id === undefined || typeof draft.id === 'string') && typeof draft.title === 'string' && draft.title.length <= 240 &&
    typeof draft.content === 'string' && draft.content.length <= 1024 * 1024 && ['note', 'schema', 'reference'].includes(draft.entryKind) &&
    ['shared', 'rust', 'cpp', 'matrix', 'ny', 'nil'].includes(draft.language) && ['global', 'project'].includes(draft.scope);
};

export function PensieveLibraryPanel({ workspace }: { workspace?: string | null }) {
  const draftKey = `pensieve-library.${encodeURIComponent(workspace ?? '')}`;
  const [state, setState] = useState<PensieveLibraryState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [discard, setDiscard] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const generation = useRef(0);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = generation.current, sequence = ++request.current;
    try {
      const next = await window.electronAPI.pensieveLibrary.get(workspace);
      if (current === generation.current && sequence === request.current) { setState((previous) => previous && previous.revision > next.revision ? previous : next); setError(''); }
    } catch { if (current === generation.current && sequence === request.current) setError('Could not load the memory library.'); }
  }, [workspace]);
  useEffect(() => {
    const recovered = readFormDraft(draftKey, validDraft);
    generation.current++; setState(null); setDraft(recovered?.draft ?? null); setDraftRevision(recovered?.revision ?? 0);
    setDeleteId(null); setOpen(null); setBusy(false); setDiscard(false);
    void refresh();
    const off = window.electronAPI.pensieveLibrary.onChanged(() => { void refresh(); });
    return () => { generation.current++; off(); };
  }, [refresh, draftKey]);
  const changeDraft = (next: Draft | null, revision = draftRevision) => {
    setDraft(next); setDraftRevision(revision);
    if (next) writeFormDraft(draftKey, { draft: next, revision });
    else clearFormDraft(draftKey);
  };
  const update = async (mutation: LibraryMutation, revision = state?.revision, accepted?: () => void) => {
    if (revision === undefined) return false;
    const current = generation.current; setBusy(true); setError('');
    try {
      const next = await window.electronAPI.pensieveLibrary.update({ workspace, revision, mutation });
      accepted?.();
      if (current === generation.current) { setState((previous) => previous && previous.revision > next.revision ? previous : next); return true; }
    } catch (cause) {
      if (current === generation.current) setError((cause instanceof Error ? cause.message : 'Could not save the library.')
        .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
    } finally { if (current === generation.current) setBusy(false); }
    return false;
  };
  const edit = (entry?: LibraryEntry) => {
    changeDraft(entry ? { id: entry.id, title: entry.title, content: entry.content, entryKind: entry.kind, language: entry.language, scope: entry.scope } : blank(), state?.revision ?? 0);
    setError('');
  };
  return <div className="space-y-6">
    <section className="space-y-3" aria-label="Pensieve library">
      <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">Pensieve library</h2>
        <button type="button" className={`${button} ml-auto`} disabled={!state || busy || !!draft} onClick={() => edit()}><Plus size={13} />Add entry</button></div>
      <p className="text-xs text-ink-3">Notes and reference schemas for agent recall. Shipped content is read-only. Your entries are stored privately on this device.</p>
      <FormDraftNotice key={draftKey} draftKey={draftKey} />
      {state && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={state.enabled} disabled={busy}
        onChange={(event) => { void update({ kind: 'enable', enabled: event.target.checked }); }} />Use library in chats</label>}
      <p className="text-xs text-ink-3">{state?.project ? `Project: ${state.project}` : 'Global entries'} · Changes apply to the next recall.</p>
      {state?.notice && <p className="text-xs text-warning">{state.notice}</p>}
      {error && <div role="alert" className="flex items-center gap-2 text-xs text-danger">{error}<button type="button" className={button} onClick={() => { void refresh(); }}>Reload</button></div>}
      {draft && <form className="space-y-3 rounded border border-line p-3" aria-label="Edit memory entry" onSubmit={(event) => {
        event.preventDefault();
        const savedDraft = { draft, revision: draftRevision }, key = draftKey;
        void update({ kind: 'save', ...draft }, draftRevision, () => clearFormDraft(key, savedDraft)).then((saved) => { if (saved) setDraft(null); });
      }}>
        <fieldset disabled={busy} className="space-y-3">
        <p className="text-[11px] text-ink-3">Your draft is kept when you leave this page.</p>
        <label className="block space-y-1 text-xs">Title<input aria-label="Entry title" className={`${field} block w-full`} maxLength={240} value={draft.title} required
          onChange={(event) => changeDraft({ ...draft, title: event.target.value })} /></label>
        <div className="flex flex-wrap gap-3">
          <label className="space-x-2 text-xs">Kind<select aria-label="Entry kind" className={field} value={draft.entryKind} onChange={(event) => changeDraft({ ...draft, entryKind: event.target.value as Draft['entryKind'] })}>
            <option value="note">Note</option><option value="schema">JSON schema</option><option value="reference">Reference</option></select></label>
          <label className="space-x-2 text-xs">Language<select aria-label="Entry language" className={field} value={draft.language} onChange={(event) => changeDraft({ ...draft, language: event.target.value as LibraryLanguage })}>
            {(['shared', 'rust', 'cpp', 'matrix', 'ny', 'nil'] as const).map((value) => <option key={value} value={value}>{value === 'cpp' ? 'C++' : value === 'shared' ? 'Any' : value}</option>)}</select></label>
          <label className="space-x-2 text-xs">Scope<select aria-label="Entry scope" className={field} value={draft.scope} onChange={(event) => changeDraft({ ...draft, scope: event.target.value as Draft['scope'] })}>
            <option value="global">All projects</option><option value="project" disabled={!state?.project}>This project</option></select></label>
        </div>
        <label className="block space-y-1 text-xs">Content<textarea aria-label="Entry content" className={`${field} block min-h-44 w-full font-mono`} value={draft.content} required maxLength={128 * 1024}
          onChange={(event) => changeDraft({ ...draft, content: event.target.value })} /></label>
        {state && state.revision !== draftRevision && <div className="space-y-2 rounded border border-warning/40 p-2 text-xs">
          <p role="status" className="text-warning">The library changed while you were editing. Review the saved entry before choosing which version to keep.</p>
          {draft.id && <details><summary className="cursor-pointer text-ink-2">Saved entry</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap text-ink-3">{state.entries.find((entry) => entry.id === draft.id)?.content ?? 'This entry was deleted.'}</pre></details>}
          <div className="flex gap-2"><button type="button" className={button} onClick={() => changeDraft({ ...draft, ...(draft.id && !state.entries.some((entry) => entry.id === draft.id) ? { id: undefined } : {}) }, state.revision)}>
            {draft.id && !state.entries.some((entry) => entry.id === draft.id) ? 'Keep as new entry' : 'Keep my draft'}</button>
            <button type="button" className={button} onClick={() => { const saved = state.entries.find((entry) => entry.id === draft.id); saved ? edit(saved) : changeDraft(null); }}>Use saved version</button></div>
        </div>}
        <div className="flex gap-2"><button type="submit" className={button} disabled={busy || state?.revision !== draftRevision}><Save size={13} />Save</button>
          <button type="button" className={button} disabled={busy} onClick={() => setDiscard(true)}><X size={13} />Discard</button></div>
        </fieldset>
      </form>}
      <input aria-label="Search library" placeholder="Search library" className={`${field} w-full`} value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="max-h-96 overflow-y-auto divide-y divide-line rounded border border-line">
        {state?.entries.filter((entry) => `${entry.title}\n${entry.content}`.toLowerCase().includes(query.toLowerCase())).map((entry) => <article key={entry.id}>
          <div className="flex items-center gap-2 p-2">
            <input type="checkbox" aria-label={`Enable ${entry.title}`} checked={entry.enabled} disabled={busy} onChange={(event) => { void update({ kind: 'toggle', id: entry.id, enabled: event.target.checked }); }} />
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? null : entry.id)}>
              {open === entry.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<span className="truncate">{entry.title}</span></button>
            <span className="text-[10px] text-ink-3">{entry.scope === 'project' ? 'Project' : entry.origin === 'shipped' ? 'Shipped' : 'Custom'} · {entry.kind}</span>
            {entry.origin === 'shipped' ? <Lock size={12} className="text-ink-3" aria-label="Read-only" /> : <>
              <button type="button" className={button} disabled={busy || !!draft} onClick={() => edit(entry)}>Edit</button>
              <button type="button" className={button} aria-label={`Delete ${entry.title}`} disabled={busy || !!draft} onClick={() => setDeleteId(entry.id)}><Trash2 size={12} /></button>
            </>}
          </div>
          {open === entry.id && <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-surface-2 p-3 text-xs text-ink-2">{entry.content}</pre>}
          {deleteId === entry.id && <div className="flex items-center gap-2 px-3 pb-3 text-xs">Delete this entry?
            <button type="button" className={button} disabled={busy} onClick={() => { void update({ kind: 'delete', id: entry.id }).then((saved) => { if (saved) setDeleteId(null); }); }}>Delete</button>
            <button type="button" className={button} onClick={() => setDeleteId(null)}>Keep</button></div>}
        </article>)}
        {state && !state.entries.some((entry) => `${entry.title}\n${entry.content}`.toLowerCase().includes(query.toLowerCase())) && <p className="p-3 text-xs text-ink-3">{query ? 'No matching entries.' : 'No entries yet.'}</p>}
      </div>
    </section>
    <PensieveExperimental />
    {discard && <ConfirmDialog title="Discard this memory draft?" message="The saved library entry will stay unchanged." confirmLabel="Discard draft" tone="danger"
      onCancel={() => setDiscard(false)} onConfirm={() => { changeDraft(null); setDiscard(false); }} />}
  </div>;
}
