import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFileAtomic } from './privateState';
import { applyBoardEdits, emptyBoard, normalizeBoard, type Board, type BoardEdit } from '../api/whiteboard';

/**
 * Whiteboards, one per conversation.
 *
 * Per chat rather than per workspace, because a board is the planning for *this* discussion —
 * two conversations about the same repository are two different plans, and merging them would be
 * nobody's intent. It also means a deleted conversation can take its board with it.
 *
 * Outside the workspace for the same reason: a board is not a project artefact. Nothing here
 * should turn up in a diff, and nothing in the project should be lost by discarding a board.
 */

let root = join(homedir(), '.antimatter', 'boards');

export const useRoot = (path: string): void => {
  root = path;
};

export const location = (): string => root;

/** Thread ids reach a file name, so anything that could walk out of the directory is refused. */
export function assertThreadId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid conversation id for a whiteboard.');
  return id;
}

const pathFor = (threadId: string): string => join(root, `${threadId}.json`);

export function read(threadId: string): Board {
  const id = assertThreadId(threadId);
  const file = pathFor(id);
  if (!existsSync(file)) return emptyBoard(id);
  try {
    return normalizeBoard(JSON.parse(readFileSync(file, 'utf8')), id);
  } catch (error) {
    // A board nobody can parse is an empty board rather than a broken page. The file is left
    // alone: overwriting it would destroy the only copy of whatever was salvageable by hand.
    console.error(`[whiteboard] unreadable board for ${id}, showing an empty one:`, error);
    return emptyBoard(id);
  }
}

export function save(threadId: string, board: unknown): Board {
  const id = assertThreadId(threadId);
  const settled = normalizeBoard(board, id);
  mkdirSync(root, { recursive: true });
  writePrivateFileAtomic(pathFor(id), `${JSON.stringify(settled, null, 2)}\n`);
  return settled;
}

/**
 * Apply edits to the stored board.
 *
 * Read, apply, write, in main rather than in the renderer, so a tool call and a person dragging
 * a note cannot each write a whole board over the other's change. Edits are small and the file
 * is one conversation's worth, so the cost of reading it per edit is not worth a cache that
 * would have to be invalidated by both of them.
 */
export function edit(threadId: string, edits: readonly BoardEdit[]): Board {
  const id = assertThreadId(threadId);
  const next = applyBoardEdits(read(id), edits);
  return save(id, next);
}

/** A conversation's board goes when the conversation does. */
export function remove(threadId: string): void {
  const id = assertThreadId(threadId);
  rmSync(pathFor(id), { force: true });
}

/** Which conversations have a board, for a future index; cheap because it is one directory. */
export function list(): string[] {
  try {
    return readdirSync(root)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}
