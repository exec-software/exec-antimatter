/**
 * The whiteboard: one surface a person and a model plan on together.
 *
 * A structured scene rather than a bitmap, and that is the whole design. If a board were pixels,
 * the model could only look at it — the vision path can read a diagram, roughly, and say what it
 * sees. As objects with ids and positions it can be *read exactly*, so "the note you labelled
 * auth flow" is a reference rather than a guess, and the model contributes by adding objects that
 * are then as draggable as anything a person put there. That difference is what makes it a room
 * both parties are in rather than a picture one of them posts at the other.
 *
 * It also means a board can become something. A planning surface whose contents are typed can be
 * turned into a task list, a brief, an ADR. A screenshot cannot.
 *
 * Flat list, parent ids for grouping. Dragging is editing x and y. The simplicity is not an
 * accident: every tool of this shape converges on it because anything richer has to be
 * maintained through every move, resize and undo.
 */

/** What a board object is. Ink, images and groups are the second wave; the model carries them now
 *  so a board written today still parses once they arrive. */
export type BoardObjectKind = 'note' | 'text' | 'ink' | 'image' | 'comment' | 'group';

export const BOARD_OBJECT_KINDS: readonly BoardObjectKind[] = ['note', 'text', 'ink', 'image', 'comment', 'group'];

/**
 * Who put it there.
 *
 * Not decoration. On a shared surface this is how a person tells their own note from a
 * suggestion at a glance, and it is what makes "clear everything the model added" one action
 * instead of an archaeology exercise. It is also provenance: the same instinct as the carbon.
 */
export type BoardAuthorKind = 'person' | 'model' | 'agent';

export interface BoardAuthor {
  kind: BoardAuthorKind;
  /** The model or agent name, when it was not a person. */
  name?: string;
}

export interface BoardObject {
  id: string;
  kind: BoardObjectKind;
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** note, text and comment. */
  text?: string;
  /** ink: a flat [x, y, x, y, …] path, relative to the object's own origin. */
  points?: number[];
  /** image: the content-addressed asset id. */
  asset?: string;
  /** comment: the object it is attached to, so it travels with what it is about. */
  anchor?: string;
  /** group membership. */
  parent?: string;
  color?: string;
  author: BoardAuthor;
  /** ISO creation time. */
  at: string;
  /** The turn that added it, joining a board back to the carbon that explains it. */
  turn?: string;
}

export interface Board {
  version: 1;
  threadId: string;
  objects: BoardObject[];
  updatedAt: string;
}

/** A board is a persisted document read back from disk, so everything about it is bounded. */
export const BOARD_OBJECT_LIMIT = 5_000;
export const BOARD_TEXT_LIMIT = 10_000;
export const BOARD_POINT_LIMIT = 20_000;
export const BOARD_ID_LIMIT = 128;
/** Far enough for any plausible surface; past it a coordinate is a bug, not a position. */
export const BOARD_COORDINATE_LIMIT = 1_000_000;

export const emptyBoard = (threadId: string): Board => ({
  version: 1,
  threadId,
  objects: [],
  updatedAt: new Date().toISOString(),
});

const str = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.slice(0, limit);
  return trimmed || undefined;
};

const coordinate = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(-BOARD_COORDINATE_LIMIT, Math.min(BOARD_COORDINATE_LIMIT, value));
};

const author = (value: unknown): BoardAuthor => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<BoardAuthor>;
  const kind: BoardAuthorKind =
    source.kind === 'model' || source.kind === 'agent' ? source.kind : 'person';
  const name = str(source.name, BOARD_ID_LIMIT);
  return name ? { kind, name } : { kind };
};

/**
 * Normalize one object, or reject it.
 *
 * Rejection is per object rather than per board: a single malformed entry — a torn write, a tool
 * that sent a bad coordinate — costs that object, not the afternoon's planning around it.
 */
export function normalizeBoardObject(value: unknown): BoardObject | null {
  const source = (value && typeof value === 'object' ? value : null) as Partial<BoardObject> | null;
  if (!source) return null;
  const id = str(source.id, BOARD_ID_LIMIT);
  if (!id) return null;
  const kind = BOARD_OBJECT_KINDS.includes(source.kind as BoardObjectKind)
    ? (source.kind as BoardObjectKind)
    : null;
  if (!kind) return null;
  const x = coordinate(source.x);
  const y = coordinate(source.y);
  if (x === undefined || y === undefined) return null;

  const object: BoardObject = {
    id,
    kind,
    x,
    y,
    author: author(source.author),
    at: str(source.at, 64) ?? new Date().toISOString(),
  };
  const width = coordinate(source.width);
  const height = coordinate(source.height);
  if (width !== undefined && width > 0) object.width = width;
  if (height !== undefined && height > 0) object.height = height;
  const text = str(source.text, BOARD_TEXT_LIMIT);
  if (text) object.text = text;
  const asset = str(source.asset, BOARD_ID_LIMIT);
  if (asset) object.asset = asset;
  const anchor = str(source.anchor, BOARD_ID_LIMIT);
  if (anchor) object.anchor = anchor;
  const parent = str(source.parent, BOARD_ID_LIMIT);
  if (parent && parent !== id) object.parent = parent;
  const color = str(source.color, 32);
  if (color) object.color = color;
  const turn = str(source.turn, BOARD_ID_LIMIT);
  if (turn) object.turn = turn;
  if (Array.isArray(source.points)) {
    const points = source.points
      .slice(0, BOARD_POINT_LIMIT)
      .map((entry) => coordinate(entry))
      .filter((entry): entry is number => entry !== undefined);
    // A path needs whole pairs; an odd tail would be read as a point at an undefined coordinate.
    if (points.length >= 2) object.points = points.slice(0, points.length - (points.length % 2));
  }
  return object;
}

export function normalizeBoard(value: unknown, threadId: string): Board {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<Board>;
  const seen = new Set<string>();
  const objects: BoardObject[] = [];
  for (const entry of Array.isArray(source.objects) ? source.objects : []) {
    const object = normalizeBoardObject(entry);
    // A duplicate id would make every later reference ambiguous, so the first one wins.
    if (!object || seen.has(object.id)) continue;
    seen.add(object.id);
    objects.push(object);
    if (objects.length >= BOARD_OBJECT_LIMIT) break;
  }
  // A parent or anchor pointing at something that is gone would strand the object invisibly, so
  // the reference is dropped and the object keeps its own position.
  for (const object of objects) {
    if (object.parent && !seen.has(object.parent)) delete object.parent;
    if (object.anchor && !seen.has(object.anchor)) delete object.anchor;
  }
  return {
    version: 1,
    threadId,
    objects,
    updatedAt: str(source.updatedAt, 64) ?? new Date().toISOString(),
  };
}

/** The edits a person or a tool can make. Deliberately small: add, change, move, remove. */
export type BoardEdit =
  | { op: 'add'; object: unknown }
  | { op: 'update'; id: string; patch: Partial<Omit<BoardObject, 'id' | 'author' | 'at'>> }
  | { op: 'remove'; id: string };

/**
 * Apply edits, returning a new board.
 *
 * Author and creation time are not patchable. Letting an update rewrite them would make the one
 * thing the board is relied on to answer — who put this here — editable by whoever came second.
 */
export function applyBoardEdits(board: Board, edits: readonly BoardEdit[]): Board {
  let objects = board.objects;
  for (const edit of edits) {
    if (edit.op === 'add') {
      const object = normalizeBoardObject(edit.object);
      if (!object || objects.some((entry) => entry.id === object.id)) continue;
      if (objects.length >= BOARD_OBJECT_LIMIT) continue;
      objects = [...objects, object];
      continue;
    }
    if (edit.op === 'remove') {
      const remaining = objects.filter((entry) => entry.id !== edit.id);
      // Removing a group or an anchor must not leave children pointing at nothing.
      objects = remaining.map((entry) => {
        const next = { ...entry };
        if (next.parent === edit.id) delete next.parent;
        if (next.anchor === edit.id) delete next.anchor;
        return next;
      });
      continue;
    }
    objects = objects.map((entry) => {
      if (entry.id !== edit.id) return entry;
      const merged = normalizeBoardObject({ ...entry, ...edit.patch, id: entry.id, kind: entry.kind, author: entry.author, at: entry.at });
      return merged ?? entry;
    });
  }
  return objects === board.objects ? board : { ...board, objects, updatedAt: new Date().toISOString() };
}

/**
 * The board as text, which is how a model reads it without vision.
 *
 * Positions are included because layout carries meaning on a planning surface — two notes side
 * by side are related, and a model that cannot see that is guessing. Rounded, because nobody
 * needs a note's position to the pixel and the precision would just cost context on every turn.
 */
export function describeBoard(board: Board): string {
  if (!board.objects.length) return 'The whiteboard is empty.';
  const byId = new Map(board.objects.map((object) => [object.id, object]));
  const who = (object: BoardObject): string =>
    object.author.kind === 'person' ? 'you' : object.author.name ?? object.author.kind;
  const lines = board.objects.map((object) => {
    const parts = [`${object.kind} ${object.id}`, `at ${Math.round(object.x)},${Math.round(object.y)}`];
    if (object.text) parts.push(`"${object.text.length > 200 ? `${object.text.slice(0, 200)}…` : object.text}"`);
    if (object.asset) parts.push('image');
    if (object.anchor) parts.push(`about ${object.anchor}${byId.has(object.anchor) ? '' : ' (missing)'}`);
    if (object.parent) parts.push(`in group ${object.parent}`);
    if (object.points) parts.push(`ink, ${object.points.length / 2} points`);
    parts.push(`by ${who(object)}`);
    return `- ${parts.join(', ')}`;
  });
  return `The whiteboard holds ${board.objects.length} object${board.objects.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}
