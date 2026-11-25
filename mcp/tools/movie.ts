import { bool, num, str } from '../types';
import type { ToolDef } from '../types';

/**
 * The Movie universe, reached from an ordinary turn.
 *
 * Declared here and answered elsewhere, for the reason the whiteboard tools give: the production
 * store lives in the app's main process, its location comes from the app's own user-data path,
 * and an edit has to be serialised against the person dragging a shot on the same timeline. Main
 * intercepts these names before they reach this server. The definitions below are what the model
 * reads; the `run` bodies are the impossible-by-construction path where no interception was in
 * place, and say so rather than pretending to have changed a film.
 *
 * Which production is not a tool argument. A model that could name one could name any of them,
 * so it is whichever production the person has open in the workbench.
 *
 * The thing to understand before reading these: a shot does not need footage to be real. It has
 * a slug, a length and a place in the cut whether or not anything has been rendered for it. That
 * is why `movie_add_shot` does not take a file and `movie_read` reports shots with no takes as a
 * normal state rather than a problem — laying out a film in slugs before spending GPU-hours on
 * it is the intended way to work, not a half-finished version of it.
 */

const unreachable = (name: string) => async (): Promise<string> => {
  throw new Error(
    `${name} is handled by the Antimatter app itself; route your turn through the app rather than this server process.`
  );
};

export const movieTools: ToolDef[] = [
  {
    name: 'movie_read',
    description:
      "Read the production open in the Movie workbench: its brief, its look, its beats, every " +
      'shot with its length and whether it has footage yet, and the cut in order. Read it before ' +
      'changing anything, so what you add fits the film that is already there. A shot with no ' +
      'takes is not a mistake — it is a slug holding its place in the cut until something is ' +
      'rendered for it.',
    inputSchema: { type: 'object', properties: {} },
    run: unreachable('movie_read'),
  },
  {
    name: 'movie_set_brief',
    description:
      "Change the production's framing. `brief` is what the film is, in prose, for a person to " +
      'read. `look` is house style — lens, light, palette, pace — and is prepended to every ' +
      "shot's prompt when it is rendered, so put there what should be true of every shot and " +
      'nowhere else. Omit a field to leave it alone.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: str('What the film is, in prose.'),
        look: str('House style, sent with every rendered shot.'),
        title: str("The production's title."),
      },
    },
    run: unreachable('movie_set_brief'),
  },
  {
    name: 'movie_add_beat',
    description:
      'Add a beat to the storyboard: a unit of story, before it is shots. Use these to lay out ' +
      'structure that is still moving — one beat commonly becomes three shots, and two collapse ' +
      'into one. Returns the id of what you added.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('The beat, in a few words.'),
        summary: str('What happens in it.'),
      },
      required: ['title'],
    },
    run: unreachable('movie_add_beat'),
  },
  {
    name: 'movie_add_shot',
    description:
      'Add one shot. A shot is an intent, not a file: give it a slug, what it is for, and how ' +
      'long it runs, and it takes its place in the cut immediately with no footage. `prompt` is ' +
      'what a generator would be sent — leave it out and the intent is used instead. ' +
      '`before` is the id of the shot to put this one in front of; omit it to add at the end. ' +
      'Returns the id of the new shot.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: str('One line: what happens in this shot.'),
        intent: str('Why this shot exists in the film.'),
        prompt: str('What a generator should be sent for it.'),
        size: str('establishing, wide, medium, close, insert or macro.'),
        seconds: num('How long it runs. Defaults to 4.'),
        beat: str('The id of the beat this shot came from.'),
        before: str('Put it before this shot id; omit to add at the end.'),
        in_cut: bool('Whether to place it in the cut as well. Defaults to true.'),
      },
      required: ['slug'],
    },
    run: unreachable('movie_add_shot'),
  },
  {
    name: 'movie_update_shot',
    description:
      'Change a shot. Only the fields you give are changed. Changing the prompt does not touch ' +
      "takes that were already rendered: each take keeps the prompt it was actually made from, " +
      'so earlier footage stays explicable.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('The shot id.'),
        slug: str('One line: what happens in this shot.'),
        intent: str('Why this shot exists in the film.'),
        prompt: str('What a generator should be sent for it.'),
        size: str('establishing, wide, medium, close, insert or macro.'),
        seconds: num('How long it runs.'),
      },
      required: ['id'],
    },
    run: unreachable('movie_update_shot'),
  },
  {
    name: 'movie_remove_shot',
    description:
      'Remove a shot and take it out of the cut. Its takes go with it, so do not use this to ' +
      "reorder — `movie_order_cut` does that without destroying anything.",
    inputSchema: {
      type: 'object',
      properties: { id: str('The shot id.') },
      required: ['id'],
    },
    run: unreachable('movie_remove_shot'),
  },
  {
    name: 'movie_order_cut',
    description:
      'Set the order of the cut: every shot id you want in it, in the order they should play. ' +
      'Shots you leave out are taken out of the cut but not deleted — they keep their takes and ' +
      'can be put back. This is how to restructure a film; it never costs any footage.',
    inputSchema: {
      type: 'object',
      properties: {
        shots: {
          type: 'array',
          items: { type: 'string' },
          description: 'Shot ids, in the order they should play.',
        },
      },
      required: ['shots'],
    },
    run: unreachable('movie_order_cut'),
  },
  {
    name: 'movie_select_take',
    description:
      "Choose which of a shot's takes is in the cut, by take id. Pass an empty take id to put " +
      'the shot back to a slug without deleting anything. The cut position never changes.',
    inputSchema: {
      type: 'object',
      properties: {
        shot: str('The shot id.'),
        take: str('The take id, or empty to play the shot as a slug.'),
      },
      required: ['shot'],
    },
    run: unreachable('movie_select_take'),
  },
];

export const MOVIE_TOOL_NAMES = movieTools.map((tool) => tool.name);
