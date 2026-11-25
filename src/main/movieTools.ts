import { randomUUID } from 'node:crypto';
import {
  SHOT_SIZES,
  describeProduction,
  type MovieShot,
  type Production,
  type ProductionEdit,
  type ShotSize,
} from '../api/movie';
import type { TurnToolContext } from '../api/toolArguments';

/**
 * The Movie tools, answered in this process.
 *
 * Intercepted before they reach the tool server for the reason the whiteboard tools are: the
 * production store is here, and an edit has to be serialised against the person dragging a shot
 * on the same timeline. The definitions the model reads live in `mcp/tools/movie.ts`.
 *
 * Which production is not a tool argument — it is whichever one the person has open in the
 * workbench, read from the universe's own layout. A model that could name a production could
 * name any of them, including one belonging to work it was never shown.
 *
 * Every refusal here names what to do instead. These tools are used mid-turn by a model that
 * cannot see the screen, so "no shot sc-3" is a dead end and "no shot sc-3; read the production
 * again" is a turn that recovers.
 */

export interface MovieToolDeps {
  /** Throws with a readable reason when the Movie universe is not open on this machine. */
  assertOpen: () => void;
  /** The production the person has open, or null. */
  openProductionId: () => string | null;
  read: (productionId: string) => Production;
  edit: (productionId: string, edits: readonly ProductionEdit[]) => Production;
}

const text = (value: unknown, limit = 8_000): string => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
const seconds = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0.1), 300) : fallback;

/**
 * The author to record for something a turn added.
 *
 * A production distinguishes a person, a model and a generator — a delegated agent is recorded
 * as the model it is, under the agent's own name, so the document can still say which run put a
 * shot in. A call with no turn context is a model with no name rather than a person, because the
 * one thing authorship must never do is attribute a machine's work to the person.
 */
const authorFor = (turn?: TurnToolContext) =>
  turn?.actor ? { kind: 'model' as const, name: turn.actor } : { kind: 'model' as const, name: turn?.model };

const size = (value: unknown): ShotSize | undefined => {
  const name = text(value, 32).toLowerCase();
  return SHOT_SIZES.includes(name as ShotSize) ? (name as ShotSize) : undefined;
};

export function movieToolHandler(deps: MovieToolDeps) {
  /** The open production, or a refusal that says what the person has to do. */
  const openProduction = (): { id: string; production: Production } => {
    deps.assertOpen();
    const id = deps.openProductionId();
    if (!id) {
      throw new Error(
        'No production is open in the Movie workbench. Ask the person to open or create one before changing a film.'
      );
    }
    return { id, production: deps.read(id) };
  };

  const requireShot = (production: Production, id: string): MovieShot => {
    const shot = production.shots.find((entry) => entry.id === id);
    if (!shot) throw new Error(`No shot ${id} is in this production; call movie_read again before changing it.`);
    return shot;
  };

  return async (toolName: string, args: Record<string, unknown>, turn?: TurnToolContext): Promise<string> => {
    const { id, production } = openProduction();

    if (toolName === 'movie_read') return describeProduction(production);

    if (toolName === 'movie_set_brief') {
      const patch: Partial<Pick<Production, 'title' | 'brief' | 'lookbook'>> = {};
      const brief = text(args.brief);
      const look = text(args.look);
      const title = text(args.title, 500);
      if (brief) patch.brief = brief;
      if (look) patch.lookbook = look;
      if (title) patch.title = title;
      if (!Object.keys(patch).length) throw new Error('movie_set_brief needs a brief, a look, or a title.');
      deps.edit(id, [{ op: 'set', patch }]);
      return `Updated the production's ${Object.keys(patch).join(', ')}.`;
    }

    if (toolName === 'movie_add_beat') {
      const title = text(args.title, 500);
      if (!title) throw new Error('movie_add_beat needs a title for the beat.');
      const beatId = `beat-${randomUUID().slice(0, 8)}`;
      const next = deps.edit(id, [
        {
          op: 'add-board',
          board: {
            id: beatId,
            title,
            summary: text(args.summary),
            author: authorFor(turn),
            at: new Date().toISOString(),
          },
        },
      ]);
      return next.boards.some((board) => board.id === beatId)
        ? `Added beat ${beatId}.`
        : 'The storyboard refused that beat; it may be full.';
    }

    if (toolName === 'movie_add_shot') {
      const slug = text(args.slug, 500);
      if (!slug) throw new Error('movie_add_shot needs a slug: one line saying what happens in the shot.');
      const beat = text(args.beat, 128);
      if (beat && !production.boards.some((board) => board.id === beat)) {
        // Named rather than dropped: the model chose that id for a reason, and a shot silently
        // detached from its beat is a structure that quietly stops meaning anything.
        throw new Error(`No beat ${beat} is in this production; call movie_read again.`);
      }
      const before = text(args.before, 128);
      if (before && !production.shots.some((shot) => shot.id === before)) {
        throw new Error(`No shot ${before} to put this one before; call movie_read again.`);
      }
      const shotId = `shot-${randomUUID().slice(0, 8)}`;
      const edits: ProductionEdit[] = [
        {
          op: 'add-shot',
          shot: {
            id: shotId,
            slug,
            intent: text(args.intent),
            prompt: text(args.prompt),
            ...(size(args.size) ? { size: size(args.size) } : {}),
            seconds: seconds(args.seconds, 4),
            ...(beat ? { boardId: beat } : {}),
            takes: [],
            author: authorFor(turn),
            at: new Date().toISOString(),
          },
          ...(before ? { before } : {}),
        },
      ];
      // Into the cut by default: a shot nobody placed is a shot the person has to remember to
      // place, and the point of slugs is that the cut is real from the first one.
      if (args.in_cut !== false) edits.push({ op: 'cut-insert', shotId, before: before || null });
      const next = deps.edit(id, edits);
      if (!next.shots.some((shot) => shot.id === shotId)) {
        return 'The production refused that shot; it may have reached its limit.';
      }
      const placed = next.cut.findIndex((entry) => entry.shotId === shotId);
      return placed < 0
        ? `Added shot ${shotId}, not in the cut.`
        : `Added shot ${shotId} at cut position ${placed + 1}. It has no footage yet and plays as a slug.`;
    }

    if (toolName === 'movie_update_shot') {
      const shotId = text(args.id, 128);
      if (!shotId) throw new Error('movie_update_shot needs the id of the shot to change.');
      requireShot(production, shotId);
      const patch: Partial<Omit<MovieShot, 'id' | 'takes' | 'author' | 'at'>> = {};
      const slug = text(args.slug, 500);
      const intent = text(args.intent);
      const prompt = text(args.prompt);
      if (slug) patch.slug = slug;
      if (intent) patch.intent = intent;
      if (prompt) patch.prompt = prompt;
      if (size(args.size)) patch.size = size(args.size);
      if (typeof args.seconds === 'number') patch.seconds = seconds(args.seconds, 4);
      if (!Object.keys(patch).length) {
        throw new Error('movie_update_shot needs at least one of slug, intent, prompt, size or seconds.');
      }
      deps.edit(id, [{ op: 'update-shot', id: shotId, patch }]);
      return `Updated ${shotId} (${Object.keys(patch).join(', ')}). Takes already rendered keep the prompt they were made from.`;
    }

    if (toolName === 'movie_remove_shot') {
      const shotId = text(args.id, 128);
      if (!shotId) throw new Error('movie_remove_shot needs the id of the shot to remove.');
      const shot = requireShot(production, shotId);
      deps.edit(id, [{ op: 'remove-shot', id: shotId }]);
      // Said out loud because it is the irreversible half, and because a model reordering with
      // the wrong tool should learn that from the result rather than from the person.
      return shot.takes.length
        ? `Removed ${shotId} and its ${shot.takes.length} take${shot.takes.length === 1 ? '' : 's'}.`
        : `Removed ${shotId}.`;
    }

    if (toolName === 'movie_order_cut') {
      const wanted = (Array.isArray(args.shots) ? args.shots : []).map((entry) => text(entry, 128)).filter(Boolean);
      if (!wanted.length) {
        throw new Error('movie_order_cut needs the shot ids in the order they should play. To empty the cut, remove each shot from it.');
      }
      const known = new Set(production.shots.map((shot) => shot.id));
      const missing = wanted.filter((shotId) => !known.has(shotId));
      if (missing.length) throw new Error(`These are not shots in this production: ${missing.join(', ')}. Call movie_read again.`);
      const unique = [...new Set(wanted)];
      // Cleared then rebuilt in one write, so the document is never stored half-ordered.
      const edits: ProductionEdit[] = [
        ...production.cut.map((entry) => ({ op: 'cut-remove' as const, shotId: entry.shotId })),
        ...unique.map((shotId) => ({ op: 'cut-insert' as const, shotId, before: null })),
      ];
      const next = deps.edit(id, edits);
      const dropped = production.cut.filter((entry) => !unique.includes(entry.shotId)).length;
      return `The cut is now ${next.cut.length} shot${next.cut.length === 1 ? '' : 's'}.${
        dropped ? ` ${dropped} shot${dropped === 1 ? ' was' : 's were'} taken out of the cut but kept, with their takes.` : ''
      }`;
    }

    if (toolName === 'movie_select_take') {
      const shotId = text(args.shot, 128);
      if (!shotId) throw new Error('movie_select_take needs the shot id.');
      const shot = requireShot(production, shotId);
      const takeId = text(args.take, 128);
      if (!takeId) {
        deps.edit(id, [{ op: 'select-take', shotId, takeId: null }]);
        return `${shotId} now plays as a slug. Its ${shot.takes.length} take${shot.takes.length === 1 ? '' : 's'} are still there.`;
      }
      if (!shot.takes.some((take) => take.id === takeId)) {
        throw new Error(`${shotId} has no take ${takeId}; call movie_read again to see what it has.`);
      }
      deps.edit(id, [{ op: 'select-take', shotId, takeId }]);
      return `${shotId} now plays take ${takeId}. Its position in the cut has not changed.`;
    }

    throw new Error(`${toolName} is not a Movie tool.`);
  };
}

export const MOVIE_TOOL_NAMES = [
  'movie_read',
  'movie_set_brief',
  'movie_add_beat',
  'movie_add_shot',
  'movie_update_shot',
  'movie_remove_shot',
  'movie_order_cut',
  'movie_select_take',
] as const;
