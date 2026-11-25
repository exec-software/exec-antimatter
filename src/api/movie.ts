/**
 * The Movie universe's document: a production.
 *
 * The traditional shape — Lightroom's, and every NLE's — is a one-way ladder. Import, organise,
 * select, edit, grade, export. It assumes the footage already exists and that the work is
 * choosing among it. That assumption is what generation breaks. When a shot can be *made* at any
 * point, a pipeline that treats "the media" as the input and "the cut" as the output has the
 * dependency backwards half the time: you cut first to find out what is missing, then generate
 * the missing thing, then cut again.
 *
 * So a production here is built the other way round, and this is the whole design:
 *
 *     A shot is an intent that may or may not have media yet.
 *
 * Every shot carries what it is *for* — a line of description, a prompt, references, a duration
 * — independently of any file. A shot with no takes is still a real shot: it occupies its place
 * in the cut, it has a length, it plays as a slug. Generating a take fills it in. Generating
 * another take gives you a choice without disturbing the cut, because the cut points at the
 * shot, never at a file. Dragging footage you shot yourself onto a shot is the same operation as
 * a generator finishing one; neither is privileged.
 *
 * That is why there is no "import" stage and no library-first flow. The two consequences worth
 * knowing:
 *
 * - **Re-generating never costs you the edit.** The timeline survives every take, including the
 *   one where you changed the prompt and started again.
 * - **The cut is meaningful before any pixels exist.** You can lay out a five-minute film in
 *   slugs, watch its rhythm, and only then spend GPU-hours on the shots that survived.
 *
 * Stored as one JSON document per production, in the Movie universe's own root. Bounded
 * everywhere, because this is a file on disk that a tool call can also write to.
 */

export const PRODUCTION_SHOT_LIMIT = 2_000;
export const PRODUCTION_TAKE_LIMIT = 64;
export const PRODUCTION_BOARD_LIMIT = 500;
export const PRODUCTION_TEXT_LIMIT = 8_000;
export const PRODUCTION_LINE_LIMIT = 500;
export const PRODUCTION_ID_LIMIT = 128;
/** Thirty seconds a shot is already long for anything a generator makes; past five minutes it is a mistake. */
export const SHOT_SECONDS_LIMIT = 300;

/** Who put it there — the same provenance question the whiteboard answers, for the same reason. */
export type MovieAuthorKind = 'person' | 'model' | 'generator';

export interface MovieAuthor {
  kind: MovieAuthorKind;
  /** The model, agent or generator name, when it was not a person. */
  name?: string;
}

/**
 * One rendered or imported piece of media for a shot.
 *
 * Takes are append-only in spirit: the point of keeping them is that you can go back to the one
 * from before you changed your mind. `seed` and `prompt` are recorded per take rather than taken
 * from the shot, because the shot's prompt moves on and the take's did not.
 */
export interface MovieTake {
  id: string;
  /**
   * Where the media is, relative to the production's own assets directory.
   *
   * Relative rather than absolute so a production survives the thing every absolute path dies
   * of: the library moving. Copy the directory to another machine, or point Antimatter at a
   * different root, and every take still resolves.
   */
  path: string;
  /** A still for the timeline, where one has been made. Relative, like `path`. */
  posterPath?: string;
  seconds: number;
  width: number;
  height: number;
  /** Whether this take carries its own audio. */
  audio: boolean;
  /** The prompt this take was actually made from, which the shot's current prompt may no longer be. */
  prompt?: string;
  seed?: number;
  generatorId?: string;
  author: MovieAuthor;
  at: string;
  /** What the generator changed about the request to fit its own limits. */
  notes?: string[];
}

/** How a shot is framed. Free text would be unsearchable and an enum would be wrong by Tuesday. */
export const SHOT_SIZES = ['establishing', 'wide', 'medium', 'close', 'insert', 'macro'] as const;
export type ShotSize = typeof SHOT_SIZES[number];

export interface MovieShot {
  id: string;
  /** The slug line: what happens, in one line, readable in the timeline at a glance. */
  slug: string;
  /** What this shot is for, in prose. The intent, not the prompt. */
  intent: string;
  /** What a generator is actually sent. Kept apart from intent: one is for people. */
  prompt: string;
  negative?: string;
  size?: ShotSize;
  /** How long the shot runs in the cut, whether or not it has media. */
  seconds: number;
  /** The board this shot came from, when it came from one. */
  boardId?: string;
  takes: MovieTake[];
  /** Which take is in the cut. Absent means the shot plays as a slug. */
  selectedTakeId?: string;
  /** Reference stills for image-to-video, relative to the production's assets. */
  references?: string[];
  author: MovieAuthor;
  at: string;
}

/**
 * A beat of the story, before it is shots.
 *
 * Boards exist because the unit you think in is not the unit you render. One board becomes three
 * shots; two boards collapse into one. Keeping them as a separate, reorderable layer is what
 * lets the structure change without rewriting every prompt underneath it.
 */
export interface MovieBoard {
  id: string;
  title: string;
  summary: string;
  /** A sketch or still for the card, relative to the production's assets. */
  imagePath?: string;
  author: MovieAuthor;
  at: string;
}

/**
 * The cut: shot ids in order, with optional trims.
 *
 * Ids rather than embedded shots, so a shot can be re-generated, retitled or re-framed and stay
 * exactly where it was. A `from`/`to` pair trims the selected take without destroying it.
 */
export interface MovieCutEntry {
  shotId: string;
  /** Seconds into the selected take. Absent means from the start. */
  from?: number;
  to?: number;
}

export interface Production {
  version: 1;
  id: string;
  title: string;
  /** The brief: what this film is, in the person's own words. The thing everything else serves. */
  brief: string;
  /** House look, aspect, pacing — prose that is prepended to every generated shot's prompt. */
  lookbook: string;
  aspect: string;
  fps: number;
  boards: MovieBoard[];
  shots: MovieShot[];
  cut: MovieCutEntry[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export const emptyProduction = (id: string, title: string): Production => ({
  version: 1,
  id,
  title: title || 'Untitled production',
  brief: '',
  lookbook: '',
  aspect: '16:9',
  fps: 24,
  boards: [],
  shots: [],
  cut: [],
  notes: '',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const str = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, limit);
  return trimmed || undefined;
};

const number = (value: unknown, low: number, high: number, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, low), high);
};

const PROMPT_NAME_LIMIT = 128;

const author = (value: unknown): MovieAuthor => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<MovieAuthor>;
  const kind: MovieAuthorKind =
    source.kind === 'model' || source.kind === 'generator' ? source.kind : 'person';
  const name = str(source.name, PROMPT_NAME_LIMIT);
  return name ? { kind, name } : { kind };
};

function normalizeTake(value: unknown): MovieTake | null {
  const source = (value && typeof value === 'object' ? value : null) as Partial<MovieTake> | null;
  if (!source) return null;
  const id = str(source.id, PRODUCTION_ID_LIMIT);
  const path = str(source.path, 1024);
  if (!id || !path) return null;
  const take: MovieTake = {
    id,
    path,
    seconds: number(source.seconds, 0, SHOT_SECONDS_LIMIT, 0),
    width: number(source.width, 0, 16_384, 0),
    height: number(source.height, 0, 16_384, 0),
    audio: source.audio === true,
    author: author(source.author),
    at: str(source.at, 64) ?? new Date().toISOString(),
  };
  const poster = str(source.posterPath, 1024);
  if (poster) take.posterPath = poster;
  const prompt = str(source.prompt, PRODUCTION_TEXT_LIMIT);
  if (prompt) take.prompt = prompt;
  const generatorId = str(source.generatorId, 64);
  if (generatorId) take.generatorId = generatorId;
  if (typeof source.seed === 'number' && Number.isFinite(source.seed)) take.seed = Math.floor(source.seed);
  if (Array.isArray(source.notes)) {
    const notes = source.notes.map((entry) => str(entry, PRODUCTION_LINE_LIMIT)).filter((entry): entry is string => !!entry).slice(0, 16);
    if (notes.length) take.notes = notes;
  }
  return take;
}

function normalizeShot(value: unknown): MovieShot | null {
  const source = (value && typeof value === 'object' ? value : null) as Partial<MovieShot> | null;
  if (!source) return null;
  const id = str(source.id, PRODUCTION_ID_LIMIT);
  if (!id) return null;
  const takes: MovieTake[] = [];
  const seenTakes = new Set<string>();
  for (const entry of Array.isArray(source.takes) ? source.takes : []) {
    const take = normalizeTake(entry);
    if (!take || seenTakes.has(take.id)) continue;
    seenTakes.add(take.id);
    takes.push(take);
    if (takes.length >= PRODUCTION_TAKE_LIMIT) break;
  }
  const shot: MovieShot = {
    id,
    slug: str(source.slug, PRODUCTION_LINE_LIMIT) ?? 'Untitled shot',
    intent: str(source.intent, PRODUCTION_TEXT_LIMIT) ?? '',
    prompt: str(source.prompt, PRODUCTION_TEXT_LIMIT) ?? '',
    seconds: number(source.seconds, 0.1, SHOT_SECONDS_LIMIT, 4),
    takes,
    author: author(source.author),
    at: str(source.at, 64) ?? new Date().toISOString(),
  };
  const negative = str(source.negative, PRODUCTION_TEXT_LIMIT);
  if (negative) shot.negative = negative;
  if (SHOT_SIZES.includes(source.size as ShotSize)) shot.size = source.size as ShotSize;
  const boardId = str(source.boardId, PRODUCTION_ID_LIMIT);
  if (boardId) shot.boardId = boardId;
  // A selection pointing at a take that is gone would play nothing and explain nothing.
  const selected = str(source.selectedTakeId, PRODUCTION_ID_LIMIT);
  if (selected && seenTakes.has(selected)) shot.selectedTakeId = selected;
  if (Array.isArray(source.references)) {
    const references = source.references.map((entry) => str(entry, 1024)).filter((entry): entry is string => !!entry).slice(0, 16);
    if (references.length) shot.references = references;
  }
  return shot;
}

function normalizeBoard(value: unknown): MovieBoard | null {
  const source = (value && typeof value === 'object' ? value : null) as Partial<MovieBoard> | null;
  if (!source) return null;
  const id = str(source.id, PRODUCTION_ID_LIMIT);
  if (!id) return null;
  const board: MovieBoard = {
    id,
    title: str(source.title, PRODUCTION_LINE_LIMIT) ?? 'Untitled beat',
    summary: str(source.summary, PRODUCTION_TEXT_LIMIT) ?? '',
    author: author(source.author),
    at: str(source.at, 64) ?? new Date().toISOString(),
  };
  const imagePath = str(source.imagePath, 1024);
  if (imagePath) board.imagePath = imagePath;
  return board;
}

export function normalizeProduction(value: unknown, id: string): Production {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<Production>;
  const base = emptyProduction(id, str(source.title, PRODUCTION_LINE_LIMIT) ?? '');

  const boards: MovieBoard[] = [];
  const boardIds = new Set<string>();
  for (const entry of Array.isArray(source.boards) ? source.boards : []) {
    const board = normalizeBoard(entry);
    if (!board || boardIds.has(board.id)) continue;
    boardIds.add(board.id);
    boards.push(board);
    if (boards.length >= PRODUCTION_BOARD_LIMIT) break;
  }

  const shots: MovieShot[] = [];
  const shotIds = new Set<string>();
  for (const entry of Array.isArray(source.shots) ? source.shots : []) {
    const shot = normalizeShot(entry);
    if (!shot || shotIds.has(shot.id)) continue;
    // A shot pointing at a beat that is gone keeps the shot and loses the link.
    if (shot.boardId && !boardIds.has(shot.boardId)) delete shot.boardId;
    shotIds.add(shot.id);
    shots.push(shot);
    if (shots.length >= PRODUCTION_SHOT_LIMIT) break;
  }

  const cut: MovieCutEntry[] = [];
  const inCut = new Set<string>();
  for (const entry of Array.isArray(source.cut) ? source.cut : []) {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Partial<MovieCutEntry>;
    const shotId = str(record.shotId, PRODUCTION_ID_LIMIT);
    // A cut entry for a deleted shot would be a gap nobody can select or remove.
    if (!shotId || !shotIds.has(shotId) || inCut.has(shotId)) continue;
    inCut.add(shotId);
    const item: MovieCutEntry = { shotId };
    if (typeof record.from === 'number' && Number.isFinite(record.from)) item.from = number(record.from, 0, SHOT_SECONDS_LIMIT, 0);
    if (typeof record.to === 'number' && Number.isFinite(record.to)) item.to = number(record.to, 0, SHOT_SECONDS_LIMIT, 0);
    // A trim that ends before it starts is not a trim.
    if (item.from !== undefined && item.to !== undefined && item.to <= item.from) delete item.to;
    cut.push(item);
    if (cut.length >= PRODUCTION_SHOT_LIMIT) break;
  }

  return {
    ...base,
    brief: str(source.brief, PRODUCTION_TEXT_LIMIT) ?? '',
    lookbook: str(source.lookbook, PRODUCTION_TEXT_LIMIT) ?? '',
    aspect: str(source.aspect, 16) ?? '16:9',
    fps: Math.round(number(source.fps, 1, 120, 24)),
    notes: str(source.notes, PRODUCTION_TEXT_LIMIT) ?? '',
    boards,
    shots,
    cut,
    createdAt: str(source.createdAt, 64) ?? base.createdAt,
    updatedAt: str(source.updatedAt, 64) ?? base.updatedAt,
  };
}

/**
 * The edits a person or a tool can make.
 *
 * Small on purpose, and the same set for both. A model that can do things to a production the
 * person cannot undo by hand would be a model whose work you have to accept wholesale.
 */
export type ProductionEdit =
  | { op: 'set'; patch: Partial<Pick<Production, 'title' | 'brief' | 'lookbook' | 'aspect' | 'fps' | 'notes'>> }
  | { op: 'add-board'; board: unknown; before?: string }
  | { op: 'update-board'; id: string; patch: Partial<Omit<MovieBoard, 'id' | 'author' | 'at'>> }
  | { op: 'remove-board'; id: string }
  | { op: 'move-board'; id: string; before: string | null }
  | { op: 'add-shot'; shot: unknown; before?: string }
  | { op: 'update-shot'; id: string; patch: Partial<Omit<MovieShot, 'id' | 'takes' | 'author' | 'at'>> }
  | { op: 'remove-shot'; id: string }
  | { op: 'add-take'; shotId: string; take: unknown }
  | { op: 'remove-take'; shotId: string; takeId: string }
  | { op: 'select-take'; shotId: string; takeId: string | null }
  | { op: 'cut-insert'; shotId: string; before: string | null }
  | { op: 'cut-remove'; shotId: string }
  | { op: 'cut-trim'; shotId: string; from?: number; to?: number };

/** Insert `item` before `beforeId`, or at the end when it is null or not found. */
function insert<T>(list: readonly T[], item: T, beforeId: string | null | undefined, idOf: (entry: T) => string): T[] {
  if (!beforeId) return [...list, item];
  const index = list.findIndex((entry) => idOf(entry) === beforeId);
  if (index < 0) return [...list, item];
  return [...list.slice(0, index), item, ...list.slice(index)];
}

/**
 * Apply edits, returning a new production.
 *
 * Author and creation time are not patchable, for the reason the whiteboard gives: the one thing
 * a shared document is relied on to answer is who put this here. Every edit is re-normalized, so
 * no sequence of valid-looking patches can leave a document the reader would reject.
 */
export function applyProductionEdits(production: Production, edits: readonly ProductionEdit[]): Production {
  let next = production;
  let changed = false;
  const touch = (value: Production) => {
    next = value;
    changed = true;
  };

  for (const edit of edits) {
    switch (edit.op) {
      case 'set': {
        const patch = edit.patch ?? {};
        touch({ ...next, ...patch });
        break;
      }
      case 'add-board': {
        const board = normalizeBoard(edit.board);
        if (!board || next.boards.some((entry) => entry.id === board.id)) break;
        if (next.boards.length >= PRODUCTION_BOARD_LIMIT) break;
        touch({ ...next, boards: insert(next.boards, board, edit.before, (entry) => entry.id) });
        break;
      }
      case 'update-board': {
        if (!next.boards.some((entry) => entry.id === edit.id)) break;
        touch({
          ...next,
          boards: next.boards.map((entry) =>
            entry.id === edit.id ? normalizeBoard({ ...entry, ...edit.patch, id: entry.id, author: entry.author, at: entry.at }) ?? entry : entry
          ),
        });
        break;
      }
      case 'remove-board': {
        if (!next.boards.some((entry) => entry.id === edit.id)) break;
        touch({ ...next, boards: next.boards.filter((entry) => entry.id !== edit.id) });
        break;
      }
      case 'move-board': {
        const board = next.boards.find((entry) => entry.id === edit.id);
        if (!board || edit.before === edit.id) break;
        const without = next.boards.filter((entry) => entry.id !== edit.id);
        touch({ ...next, boards: insert(without, board, edit.before, (entry) => entry.id) });
        break;
      }
      case 'add-shot': {
        const shot = normalizeShot(edit.shot);
        if (!shot || next.shots.some((entry) => entry.id === shot.id)) break;
        if (next.shots.length >= PRODUCTION_SHOT_LIMIT) break;
        touch({ ...next, shots: insert(next.shots, shot, edit.before, (entry) => entry.id) });
        break;
      }
      case 'update-shot': {
        if (!next.shots.some((entry) => entry.id === edit.id)) break;
        touch({
          ...next,
          shots: next.shots.map((entry) =>
            entry.id === edit.id
              ? normalizeShot({ ...entry, ...edit.patch, id: entry.id, takes: entry.takes, author: entry.author, at: entry.at }) ?? entry
              : entry
          ),
        });
        break;
      }
      case 'remove-shot': {
        if (!next.shots.some((entry) => entry.id === edit.id)) break;
        touch({
          ...next,
          shots: next.shots.filter((entry) => entry.id !== edit.id),
          // Removing a shot must take its place in the cut with it, or the cut names a ghost.
          cut: next.cut.filter((entry) => entry.shotId !== edit.id),
        });
        break;
      }
      case 'add-take': {
        const take = normalizeTake(edit.take);
        const shot = next.shots.find((entry) => entry.id === edit.shotId);
        if (!take || !shot || shot.takes.some((entry) => entry.id === take.id)) break;
        if (shot.takes.length >= PRODUCTION_TAKE_LIMIT) break;
        touch({
          ...next,
          shots: next.shots.map((entry) =>
            entry.id !== edit.shotId
              ? entry
              : // A new take is selected when nothing was: the common case is the first render,
                // and leaving it unselected would show a slug beside finished footage.
                { ...entry, takes: [...entry.takes, take], selectedTakeId: entry.selectedTakeId ?? take.id }
          ),
        });
        break;
      }
      case 'remove-take': {
        const shot = next.shots.find((entry) => entry.id === edit.shotId);
        if (!shot || !shot.takes.some((entry) => entry.id === edit.takeId)) break;
        touch({
          ...next,
          shots: next.shots.map((entry) => {
            if (entry.id !== edit.shotId) return entry;
            const takes = entry.takes.filter((take) => take.id !== edit.takeId);
            const updated = { ...entry, takes };
            if (updated.selectedTakeId === edit.takeId) {
              // Falling back to the newest surviving take keeps the cut playing something.
              const fallback = takes[takes.length - 1];
              if (fallback) updated.selectedTakeId = fallback.id;
              else delete updated.selectedTakeId;
            }
            return updated;
          }),
        });
        break;
      }
      case 'select-take': {
        const shot = next.shots.find((entry) => entry.id === edit.shotId);
        if (!shot) break;
        if (edit.takeId !== null && !shot.takes.some((take) => take.id === edit.takeId)) break;
        touch({
          ...next,
          shots: next.shots.map((entry) => {
            if (entry.id !== edit.shotId) return entry;
            const updated = { ...entry };
            if (edit.takeId === null) delete updated.selectedTakeId;
            else updated.selectedTakeId = edit.takeId;
            return updated;
          }),
        });
        break;
      }
      case 'cut-insert': {
        if (!next.shots.some((entry) => entry.id === edit.shotId)) break;
        if (next.cut.some((entry) => entry.shotId === edit.shotId)) break;
        touch({ ...next, cut: insert(next.cut, { shotId: edit.shotId }, edit.before, (entry) => entry.shotId) });
        break;
      }
      case 'cut-remove': {
        if (!next.cut.some((entry) => entry.shotId === edit.shotId)) break;
        touch({ ...next, cut: next.cut.filter((entry) => entry.shotId !== edit.shotId) });
        break;
      }
      case 'cut-trim': {
        if (!next.cut.some((entry) => entry.shotId === edit.shotId)) break;
        touch({
          ...next,
          cut: next.cut.map((entry) => {
            if (entry.shotId !== edit.shotId) return entry;
            const item: MovieCutEntry = { shotId: entry.shotId };
            const from = edit.from ?? entry.from;
            const to = edit.to ?? entry.to;
            if (typeof from === 'number') item.from = from;
            if (typeof to === 'number') item.to = to;
            return item;
          }),
        });
        break;
      }
      default:
        break;
    }
  }

  if (!changed) return production;
  // Re-normalized rather than trusted: patches are shallow merges and a tool call supplies them.
  return { ...normalizeProduction(next, production.id), updatedAt: new Date().toISOString() };
}

/** How long a cut entry runs: its trim, else the selected take, else the shot's own length. */
export function entrySeconds(production: Production, entry: MovieCutEntry): number {
  const shot = production.shots.find((candidate) => candidate.id === entry.shotId);
  if (!shot) return 0;
  const take = shot.takes.find((candidate) => candidate.id === shot.selectedTakeId);
  const full = take?.seconds || shot.seconds;
  const from = entry.from ?? 0;
  const to = entry.to ?? full;
  return Math.max(0, Math.min(to, full) - Math.min(from, full));
}

export const cutSeconds = (production: Production): number =>
  production.cut.reduce((total, entry) => total + entrySeconds(production, entry), 0);

/** A duration as a reader of timecode expects it. */
export function timecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * The full prompt a shot is rendered from: the production's look, then the shot's own words.
 *
 * Composed here rather than at the call site so that the workbench, a tool call and the queue
 * all send the same text — a shot that renders differently depending on who pressed the button
 * is not reproducible, which defeats keeping the seed.
 */
export function shotPrompt(production: Production, shot: MovieShot): string {
  const parts = [production.lookbook.trim(), shot.prompt.trim() || shot.intent.trim() || shot.slug.trim()];
  return parts.filter(Boolean).join('\n\n').slice(0, PRODUCTION_TEXT_LIMIT);
}

/**
 * The production as text, which is how a model reads it without a screen.
 *
 * Written as a document rather than a dump: a model that is going to add shots needs the brief
 * and the shape of the cut far more than it needs every take's path. Takes are counted, not
 * listed, for the same reason — and because a production late in the work has thousands.
 */
export function describeProduction(production: Production): string {
  const lines: string[] = [
    `Production "${production.title}" — ${production.aspect}, ${production.fps}fps.`,
  ];
  if (production.brief) lines.push('', 'Brief:', production.brief);
  if (production.lookbook) lines.push('', 'Look:', production.lookbook);

  if (production.boards.length) {
    lines.push('', `Beats (${production.boards.length}):`);
    for (const board of production.boards) {
      lines.push(`- ${board.id}: ${board.title}${board.summary ? ` — ${board.summary}` : ''}`);
    }
  }

  if (!production.shots.length) {
    lines.push('', 'No shots yet.');
  } else {
    lines.push('', `Shots (${production.shots.length}):`);
    for (const shot of production.shots) {
      const state = shot.takes.length
        ? `${shot.takes.length} take${shot.takes.length === 1 ? '' : 's'}${shot.selectedTakeId ? '' : ', none selected'}`
        : 'no footage yet';
      const place = production.cut.findIndex((entry) => entry.shotId === shot.id);
      lines.push(
        `- ${shot.id}: ${shot.slug} [${shot.size ?? 'unspecified'}, ${shot.seconds}s, ${state}, ${place < 0 ? 'not in the cut' : `cut position ${place + 1}`}]`
      );
      if (shot.intent) lines.push(`    intent: ${shot.intent}`);
    }
  }

  lines.push('', `Cut: ${production.cut.length} shot${production.cut.length === 1 ? '' : 's'}, ${timecode(cutSeconds(production))}.`);
  if (production.notes) lines.push('', 'Notes:', production.notes);
  return lines.join('\n');
}

/**
 * What a production looks like from the outside: enough to choose one, without opening it.
 *
 * `unrendered` is here because it is the number that actually says how much work is left — a
 * production with sixty shots and two takes is not a production that is nearly finished, and a
 * shot count on its own would suggest it is.
 */
export interface ProductionSummary {
  id: string;
  title: string;
  shots: number;
  unrendered: number;
  seconds: number;
  updatedAt: string;
}

export const summarizeProduction = (production: Production): ProductionSummary => ({
  id: production.id,
  title: production.title,
  shots: production.shots.length,
  unrendered: production.shots.filter((shot) => !shot.selectedTakeId).length,
  seconds: cutSeconds(production),
  updatedAt: production.updatedAt,
});
