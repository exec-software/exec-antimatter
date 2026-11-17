import { randomUUID } from 'node:crypto';
import { describeBoard, type BoardEdit, type BoardObjectKind, type BoardUpdatePatch } from '../api/whiteboard';
import type { TurnToolContext } from '../api/toolArguments';
import * as whiteboard from './whiteboard';

/**
 * The whiteboard tools, answered in this process.
 *
 * The board store is here — its location comes from the app's user-data path, and an edit has to
 * be serialised against the person dragging a note on the same surface — so these names are
 * intercepted before they reach the tool server, the way the recovery shell already is. The
 * definitions the model reads live in `mcp/tools/whiteboard.ts`.
 *
 * Which conversation's board is not a tool argument. It cannot be: a model that could name the
 * thread could name somebody else's, so it arrives from the turn context the app injects and the
 * model never sees it.
 */

export interface WhiteboardToolDeps {
  /** Whether the experiment is on; off means the tools refuse rather than create a store. */
  enabled: () => boolean;
  read: (threadId: string) => ReturnType<typeof whiteboard.read>;
  edit: (threadId: string, edits: readonly BoardEdit[]) => ReturnType<typeof whiteboard.edit>;
}

const ADDABLE: readonly BoardObjectKind[] = ['note', 'text', 'comment'];

/** Where a new object goes when the model does not say. Not the origin: that is where the first
 *  note went, and stacking everything there hides it. */
const scatter = (): number => Math.round((Math.random() - 0.5) * 400);

const text = (value: unknown, limit = 10_000): string => (typeof value === 'string' ? value.slice(0, limit) : '');
const coordinate = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * The author to record for something a turn added.
 *
 * An agent is named as an agent so a board can say which delegated run put an object down; a
 * chat turn is the model. A call with no turn context is still the model rather than a person,
 * because the one thing authorship must never do is attribute a machine's work to the person.
 */
const authorFor = (turn?: TurnToolContext) =>
  turn?.actor ? { kind: 'agent' as const, name: turn.actor } : { kind: 'model' as const, name: turn?.model };

export function whiteboardToolHandler(deps: WhiteboardToolDeps) {
  return async (toolName: string, args: Record<string, unknown>, turn?: TurnToolContext): Promise<string> => {
    if (!deps.enabled()) {
      throw new Error('The whiteboard is not enabled; it is an experimental feature and is switched off.');
    }
    const threadId = turn?.thread;
    if (!threadId) {
      // A board belongs to a conversation. Without one there is nothing to write to, and
      // inventing a thread id would quietly start a board nobody can find.
      throw new Error('This turn is not attached to a conversation, so it has no whiteboard.');
    }

    if (toolName === 'whiteboard_read') return describeBoard(deps.read(threadId));

    if (toolName === 'whiteboard_add') {
      const kind = ADDABLE.includes(args.kind as BoardObjectKind) ? (args.kind as BoardObjectKind) : 'note';
      const body = text(args.text);
      if (!body) throw new Error('whiteboard_add needs the text for the object.');
      const anchor = text(args.anchor, 128);
      if (kind === 'comment' && !anchor) {
        throw new Error('A comment needs an anchor: the id of the object it is about.');
      }
      const board = deps.read(threadId);
      if (anchor && !board.objects.some((object) => object.id === anchor)) {
        // Named rather than silently dropped: the model chose that id for a reason, and a comment
        // about nothing is worse than a refusal it can correct.
        throw new Error(`No object ${anchor} is on the whiteboard; read it again before commenting.`);
      }
      const id = `${kind[0]}-${randomUUID().slice(0, 8)}`;
      const next = deps.edit(threadId, [{
        op: 'add',
        object: {
          id,
          kind,
          x: coordinate(args.x) ?? scatter(),
          y: coordinate(args.y) ?? scatter(),
          width: kind === 'comment' ? 160 : 180,
          height: kind === 'comment' ? 80 : 120,
          text: body,
          ...(anchor ? { anchor } : {}),
          ...(text(args.parent, 128) ? { parent: text(args.parent, 128) } : {}),
          author: authorFor(turn),
          at: new Date().toISOString(),
          ...(turn?.turn ? { turn: turn.turn } : {}),
        },
      }]);
      return next.objects.some((object) => object.id === id)
        ? `Added ${kind} ${id} to the whiteboard.`
        : 'The whiteboard refused that object; it may be full.';
    }

    if (toolName === 'whiteboard_update') {
      const id = text(args.id, 128);
      if (!id) throw new Error('whiteboard_update needs the id of the object to change.');
      const board = deps.read(threadId);
      if (!board.objects.some((object) => object.id === id)) {
        throw new Error(`No object ${id} is on the whiteboard; read it again.`);
      }
      const patch: BoardUpdatePatch = {};
      const body = text(args.text);
      if (body) patch.text = body;
      const x = coordinate(args.x);
      const y = coordinate(args.y);
      if (x !== undefined) patch.x = x;
      if (y !== undefined) patch.y = y;
      if (!Object.keys(patch).length) throw new Error('whiteboard_update needs text, a position, or both.');
      deps.edit(threadId, [{ op: 'update', id, patch }]);
      return `Updated ${id}.`;
    }

    if (toolName === 'whiteboard_remove') {
      const id = text(args.id, 128);
      if (!id) throw new Error('whiteboard_remove needs the id of the object to remove.');
      const board = deps.read(threadId);
      const target = board.objects.find((object) => object.id === id);
      if (!target) throw new Error(`No object ${id} is on the whiteboard; read it again.`);
      deps.edit(threadId, [{ op: 'remove', id }]);
      return target.author.kind === 'person'
        ? `Removed ${id}, which the person had put there.`
        : `Removed ${id}.`;
    }

    throw new Error(`${toolName} is not a whiteboard tool.`);
  };
}

export const WHITEBOARD_TOOL_NAMES = [
  'whiteboard_read',
  'whiteboard_add',
  'whiteboard_update',
  'whiteboard_remove',
] as const;
