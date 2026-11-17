import { num, str } from '../types';
import type { ToolDef } from '../types';

/**
 * The whiteboard, reached from an ordinary turn.
 *
 * Declared here and answered elsewhere. The board store lives in the app's main process — its
 * location comes from the app's own user-data path and a change has to be serialised against the
 * person dragging a note on the same surface — so main intercepts these names before they reach
 * this server, the way it already does for the recovery shell. The definitions below are what the
 * model reads; the `run` bodies are the impossible-by-construction path where no interception was
 * in place, and say so rather than pretending to have drawn something.
 *
 * The board is a structured scene, which is why these tools are about objects rather than pixels.
 * Nothing here draws: it adds, moves, retitles and removes things that a person can then pick up
 * and move themselves.
 */

const unreachable = (name: string) => async (): Promise<string> => {
  throw new Error(
    `${name} is handled by the Antimatter app itself; route your turn through the app rather than this server process.`
  );
};

export const whiteboardTools: ToolDef[] = [
  {
    name: 'whiteboard_read',
    description:
      "Read this conversation's whiteboard: every object on it with its position, text, author " +
      'and grouping. The whiteboard is a shared planning surface — the person can put notes, ' +
      'comments and images on it and so can you, and both of you can move anything on it. Read ' +
      'it before adding to it, so what you add relates to what is already there rather than ' +
      'landing on top of it.',
    inputSchema: { type: 'object', properties: {} },
    run: unreachable('whiteboard_read'),
  },
  {
    name: 'whiteboard_add',
    description:
      'Put one object on the whiteboard. A note is a block of text someone can move and edit; ' +
      'a comment is attached to another object by its id and travels with it. Positions are ' +
      'surface coordinates, the same ones whiteboard_read reports, so place things beside what ' +
      'they relate to rather than at the origin. Returns the id of what you added.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: str('note, text or comment.'),
        text: str('What it says.'),
        x: num('Horizontal position on the surface.'),
        y: num('Vertical position on the surface.'),
        anchor: str('For a comment: the id of the object it is about.'),
        parent: str('Optional group id to put it in.'),
      },
      required: ['kind', 'text'],
    },
    run: unreachable('whiteboard_add'),
  },
  {
    name: 'whiteboard_update',
    description:
      'Change an object already on the whiteboard: its text, its position, or both. Use this to ' +
      'tidy a surface — moving related notes together says something a new note cannot. You ' +
      'cannot change who authored an object.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('The id of the object, from whiteboard_read.'),
        text: str('Replacement text, if it should change.'),
        x: num('New horizontal position, if it should move.'),
        y: num('New vertical position, if it should move.'),
      },
      required: ['id'],
    },
    run: unreachable('whiteboard_update'),
  },
  {
    name: 'whiteboard_remove',
    description:
      'Take one object off the whiteboard. Prefer this for something you put there yourself; ' +
      "removing the person's own notes discards their thinking, so say what you would remove and " +
      'why instead, unless they asked.',
    inputSchema: {
      type: 'object',
      properties: { id: str('The id of the object to remove.') },
      required: ['id'],
    },
    run: unreachable('whiteboard_remove'),
  },
];
