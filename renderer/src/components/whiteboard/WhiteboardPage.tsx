import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Hand, Maximize2, StickyNote, Trash2, User, X } from 'lucide-react';
import type { Board, BoardEdit, BoardObject } from '../../../../src/api/whiteboard';

/**
 * The whiteboard: one surface a person and a model plan on together.
 *
 * Per conversation, and reached from beside the chat rather than from the Desk grid, because a
 * board belongs to the discussion that produced it. A Desk app reads as global; this one is not.
 *
 * Pan with the background, drag a note to move it, double-click empty space to add one. No
 * palette of tools yet: notes are the thing a planning session is mostly made of, and ink,
 * images and groups are new object types on a model that already works rather than new
 * machinery.
 *
 * Authorship is visible on every note. On a shared surface that is the difference between
 * reading your own plan and reading a conversation — you can see at a glance which parts you put
 * down and which arrived while you were thinking.
 */

interface Props {
  threadId: string | null;
  threadTitle: string;
  onLeave: () => void;
}

const NOTE_WIDTH = 180;
const NOTE_HEIGHT = 120;

/** Author colours, so the surface is readable before anything is clicked. */
const authorTone = (object: BoardObject): string =>
  object.author.kind === 'person'
    ? 'border-primary/40 bg-primary/10'
    : object.author.kind === 'agent'
      ? 'border-warning/40 bg-warning-bg/40'
      : 'border-accent/40 bg-accent/10';

export function WhiteboardPage({ threadId, threadTitle, onLeave }: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [editing, setEditing] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  /** What is being dragged, and where in the note the grab happened, so it does not jump. */
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const panFrom = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  // Escape leaves the board, for the same reason the button is labelled: a surface with one exit
  // should also answer the key everyone tries first.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !editing) onLeave();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [editing, onLeave]);

  const load = useCallback(() => {
    if (!threadId) return;
    window.electronAPI.whiteboard
      .get(threadId)
      .then(setBoard)
      .catch((cause: unknown) => {
        console.error('Could not open the whiteboard:', cause);
        setError('Could not open this whiteboard.');
      });
  }, [threadId]);

  useEffect(load, [load]);

  /**
   * Edits go to main and the answer replaces local state.
   *
   * Main reads, applies and writes, so what comes back already includes anything the model added
   * while this page was open. Trusting a local guess instead would quietly drop it.
   */
  const apply = (edits: BoardEdit[]) => {
    if (!threadId) return;
    window.electronAPI.whiteboard
      .edit(threadId, edits)
      .then(setBoard)
      .catch((cause: unknown) => {
        console.error('Could not change the whiteboard:', cause);
        setError('That change was not saved.');
        load();
      });
  };

  const addNote = (clientX: number, clientY: number) => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return;
    const id = `n-${crypto.randomUUID().slice(0, 8)}`;
    apply([{
      op: 'add',
      object: {
        id,
        kind: 'note',
        x: Math.round(clientX - rect.left - pan.x - NOTE_WIDTH / 2),
        y: Math.round(clientY - rect.top - pan.y - NOTE_HEIGHT / 2),
        width: NOTE_WIDTH,
        height: NOTE_HEIGHT,
        text: '',
        author: { kind: 'person' },
        at: new Date().toISOString(),
      },
    }]);
    setEditing(id);
  };

  if (!threadId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <p className="text-xs text-ink-3">Open a conversation to use its whiteboard.</p>
      </div>
    );
  }

  const objects = board?.objects ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-ink">Whiteboard</h2>
          <p className="truncate text-[11px] text-ink-3">{threadTitle}</p>
        </div>
        <span className="flex items-center gap-1 text-[10px] text-ink-3" title="Drag the background to pan">
          <Hand size={11} /> drag to pan
        </span>
        <button
          type="button"
          onClick={() => setPan({ x: 0, y: 0 })}
          title="Back to the origin"
          className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 hover:text-ink"
        >
          <Maximize2 size={11} />
        </button>
        <button
          type="button"
          onClick={() => addNote(window.innerWidth / 2, window.innerHeight / 2)}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink"
        >
          <StickyNote size={11} /> Note
        </button>
        {/* Labelled, not a bare X. This is a full-page view reached from a launcher, so the way
            back has to be obvious — an icon alone leaves someone who opened it by accident with
            no visible exit, which is exactly how it was reported. */}
        <button
          type="button"
          onClick={onLeave}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink"
        >
          <X size={11} /> Back to chat
        </button>
      </div>

      {error && <p className="shrink-0 bg-danger/10 px-4 py-1.5 text-[11px] text-danger">{error}</p>}

      <div
        ref={surface}
        role="application"
        aria-label="Whiteboard surface"
        onDoubleClick={(event) => {
          if (event.target === surface.current) addNote(event.clientX, event.clientY);
        }}
        onPointerDown={(event) => {
          if (event.target !== surface.current) return;
          panFrom.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
          setEditing(null);
        }}
        onPointerMove={(event) => {
          if (drag.current) {
            const rect = surface.current?.getBoundingClientRect();
            if (!rect) return;
            const id = drag.current.id;
            const x = Math.round(event.clientX - rect.left - pan.x - drag.current.dx);
            const y = Math.round(event.clientY - rect.top - pan.y - drag.current.dy);
            // Moved locally while held so the note follows the pen, and written once on release.
            setBoard((current) =>
              current ? { ...current, objects: current.objects.map((o) => (o.id === id ? { ...o, x, y } : o)) } : current);
            return;
          }
          if (panFrom.current) {
            setPan({
              x: panFrom.current.panX + (event.clientX - panFrom.current.x),
              y: panFrom.current.panY + (event.clientY - panFrom.current.y),
            });
          }
        }}
        onPointerUp={() => {
          if (drag.current) {
            const moved = objects.find((object) => object.id === drag.current!.id);
            if (moved) apply([{ op: 'update', id: moved.id, patch: { x: moved.x, y: moved.y } }]);
          }
          drag.current = null;
          panFrom.current = null;
        }}
        className="relative min-h-0 flex-1 touch-none overflow-hidden bg-surface-2"
        style={{
          backgroundImage: 'radial-gradient(circle, rgb(var(--color-line)) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      >
        {!objects.length && (
          <p className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-xs text-ink-3">
            Double-click anywhere to start a note.
          </p>
        )}

        {objects.map((object) => (
          <div
            key={object.id}
            data-object={object.id}
            onPointerDown={(event) => {
              event.stopPropagation();
              const rect = surface.current?.getBoundingClientRect();
              if (!rect) return;
              drag.current = {
                id: object.id,
                dx: event.clientX - rect.left - pan.x - object.x,
                dy: event.clientY - rect.top - pan.y - object.y,
              };
            }}
            className={`absolute rounded-lg border p-2 shadow-sm ${authorTone(object)}`}
            style={{
              left: object.x + pan.x,
              top: object.y + pan.y,
              width: object.width ?? NOTE_WIDTH,
              height: object.height ?? NOTE_HEIGHT,
            }}
          >
            <div className="flex items-center gap-1 text-[10px] text-ink-3">
              {object.author.kind === 'person' ? <User size={9} /> : <Bot size={9} />}
              <span className="truncate">{object.author.kind === 'person' ? 'you' : object.author.name ?? object.author.kind}</span>
              <button
                type="button"
                aria-label={`Delete ${object.id}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => apply([{ op: 'remove', id: object.id }])}
                className="ml-auto rounded p-0.5 text-ink-3 hover:text-danger"
              >
                <Trash2 size={9} />
              </button>
            </div>
            {editing === object.id ? (
              <textarea
                autoFocus
                defaultValue={object.text ?? ''}
                onPointerDown={(event) => event.stopPropagation()}
                onBlur={(event) => {
                  setEditing(null);
                  if (event.target.value !== (object.text ?? '')) {
                    apply([{ op: 'update', id: object.id, patch: { text: event.target.value } }]);
                  }
                }}
                className="mt-1 h-[calc(100%-1.25rem)] w-full resize-none bg-transparent text-xs text-ink focus:outline-none"
              />
            ) : (
              <p
                onDoubleClick={() => setEditing(object.id)}
                className="mt-1 h-[calc(100%-1.25rem)] overflow-hidden whitespace-pre-wrap text-xs text-ink"
              >
                {object.text || <span className="text-ink-3">Double-click to write</span>}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
