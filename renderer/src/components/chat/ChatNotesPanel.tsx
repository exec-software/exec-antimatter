import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, NotebookPen, X } from 'lucide-react';
import { chatNoteDraft } from '../../lib/chatNotes';
import { ChatNotesEditor } from './ChatNotesEditor';

interface Props { threadId: string; title: string; onClose(): void }

export function ChatNotesPanel({ threadId, title, onClose }: Props) {
  const draft = useMemo(() => chatNoteDraft(threadId), [threadId]);
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const explanationId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      void draft.flush();
      if (previous?.isConnected) {
        previous.focus();
      }
    };
  }, [draft]);

  const close = async () => {
    if (closing) {
      return;
    }
    setClosing(true);
    const error = await draft.flush();
    setClosing(false);
    if (error) {
      setCloseError(error);
    } else {
      onClose();
    }
  };

  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={headingId} aria-describedby={explanationId}
      className="flex max-h-[90vh] min-h-[380px] w-full max-w-3xl flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4 text-ink shadow-2xl outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          void close();
        }
        if (event.key === 'Tab') {
          const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex="0"]') ?? [])];
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}>
      <div className="flex items-center gap-2">
        <NotebookPen size={18} className="shrink-0 text-primary" />
        <h2 id={headingId} className="min-w-0 flex-1 truncate font-semibold">Notes · {title || 'Untitled chat'}</h2>
        <span role="status" className="flex items-center gap-1 text-xs text-ink-3">
          {state.loading || state.saving ? <LoaderCircle size={13} className="animate-spin" /> : !state.dirty && !state.error && <Check size={13} />}
          {state.loading ? 'Loading' : state.saving ? 'Saving' : state.conflict ? 'Conflicting edits' : state.deleted ? 'Chat deleted' : state.error ? 'Save needs attention' : state.dirty ? 'Unsaved' : 'Saved'}
        </span>
        <button type="button" aria-label="Close chat notes" title="Close notes" disabled={closing}
          onClick={() => { void close(); }} className="rounded p-1.5 text-ink-2 hover:bg-surface-3 disabled:opacity-40"><X size={18} /></button>
      </div>
      <p id={explanationId} className="text-xs text-ink-3">Private notes for this chat. Saved automatically; never included in the agent’s context.</p>
      {state.conflict && <section className="rounded-lg border border-primary/50 bg-primary/5 p-3 text-sm" aria-label="Conflicting notes">
        <p>These notes changed in another window. Your draft is still here. Choose which version to keep.</p>
        <details className="my-2"><summary className="cursor-pointer text-xs text-ink-2">Review the saved version</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface p-2 text-xs">{state.conflict.markdown || '(Empty notes)'}</pre>
        </details>
        <div className="flex gap-2">
          <button type="button" onClick={() => { draft.keepDraft(); setCloseError(''); }} className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary">Keep my draft</button>
          <button type="button" onClick={() => { draft.useSaved(); setCloseError(''); }} className="rounded border border-line px-3 py-1.5 text-xs">Use saved version</button>
        </div>
      </section>}
      {(state.error || closeError) && <div role="alert" className="flex items-center gap-3 rounded border border-danger/40 p-2 text-xs text-danger">
        <span className="flex-1">{state.error || closeError}</span>
        {!state.deleted && !state.conflict && <button type="button" onClick={() => { setCloseError(''); void draft.retry(); }} className="rounded border border-line px-2 py-1 text-ink">Retry save</button>}
      </div>}
      <ChatNotesEditor value={state.markdown} onChange={(value) => { draft.change(value); setCloseError(''); }}
        onCompositionChange={(composing) => draft.setComposing(composing)} disabled={state.loading || state.deleted} />
    </div>
  </div>, document.body);
}
