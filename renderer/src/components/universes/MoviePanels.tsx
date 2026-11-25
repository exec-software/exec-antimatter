import { useMemo, useState } from 'react';
import {
  Clapperboard,
  Film,
  GripVertical,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  SHOT_SIZES,
  cutSeconds,
  entrySeconds,
  shotPrompt,
  timecode,
  type MovieShot,
  type Production,
  type ProductionEdit,
  type ShotSize,
} from '../../../../src/api/movie';
import type { UniverseGeneratorView, UniversePanelKind } from '../../../../src/api/universes';

/**
 * The Movie universe's panels.
 *
 * All of them in one file because they are one surface: every panel is a view of the same
 * production document and they share the selection, the edit function and the vocabulary.
 * Splitting them into eight files would mean eight copies of the same five props and a shared
 * types module nobody reads.
 *
 * The thing worth knowing while reading these: a shot with no takes is not an empty slot. It has
 * a length, it sits in the cut, it plays as a slug, and the timeline is meaningful before
 * anything has been rendered. Every panel here is written so that state looks deliberate rather
 * than broken — because for most of the work, it is. The reasoning is in src/api/movie.ts.
 */

export interface MoviePanelProps {
  kind: UniversePanelKind;
  production: Production;
  edit: (edits: ProductionEdit[]) => void;
  selectedShotId: string | null;
  onSelectShot: (id: string | null) => void;
  generators: UniverseGeneratorView[];
  /** Opens this universe's settings, where a generator is configured. */
  onConfigureGenerators: () => void;
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** The URL a take or still is drawn from. See the media scheme in src/main/index.ts. */
export const mediaUrl = (productionId: string, path: string): string =>
  `antimatter-media://movie/${encodeURIComponent(productionId)}/${path.split('/').map(encodeURIComponent).join('/')}`;

const fieldClass =
  'w-full rounded-md border border-line bg-surface-3 px-2.5 py-2 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';
const labelClass = 'mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-3';

/** A panel's own frame, so every region looks like the same workbench. */
export function Pane({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-line bg-surface-2 px-3 py-1.5">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{title}</h2>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

/** The brief: the thing everything else in the production is an attempt at. */
function BriefPanel({ production, edit }: MoviePanelProps) {
  return (
    <Pane title="Brief">
      <div className="space-y-3 p-3">
        <div>
          <label className={labelClass} htmlFor="movie-title">Title</label>
          <input
            id="movie-title"
            className={fieldClass}
            value={production.title}
            onChange={(event) => edit([{ op: 'set', patch: { title: event.target.value } }])}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="movie-brief">What this film is</label>
          <textarea
            id="movie-brief"
            rows={6}
            className={`${fieldClass} resize-y`}
            placeholder="A sentence or a page. Written for a person, not for a model."
            value={production.brief}
            onChange={(event) => edit([{ op: 'set', patch: { brief: event.target.value } }])}
          />
        </div>
        <div>
          {/* Prepended to every generated shot. Kept apart from the brief because one is for
              people and one is sent to a model; conflating them is how house style ends up
              half-applied, present in the shots written after someone edited the brief. */}
          <label className={labelClass} htmlFor="movie-look">Look — sent with every shot</label>
          <textarea
            id="movie-look"
            rows={4}
            className={`${fieldClass} resize-y`}
            placeholder="35mm, handheld, overcast, muted palette…"
            value={production.lookbook}
            onChange={(event) => edit([{ op: 'set', patch: { lookbook: event.target.value } }])}
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className={labelClass} htmlFor="movie-aspect">Aspect</label>
            <input
              id="movie-aspect"
              className={fieldClass}
              value={production.aspect}
              onChange={(event) => edit([{ op: 'set', patch: { aspect: event.target.value } }])}
            />
          </div>
          <div className="w-24">
            <label className={labelClass} htmlFor="movie-fps">fps</label>
            <input
              id="movie-fps"
              type="number"
              min={1}
              max={120}
              className={fieldClass}
              value={production.fps}
              onChange={(event) => edit([{ op: 'set', patch: { fps: Number(event.target.value) || 24 } }])}
            />
          </div>
        </div>
      </div>
    </Pane>
  );
}

/** Beats, before they are shots. One beat commonly becomes three. */
function BoardsPanel({ production, edit }: MoviePanelProps) {
  const addBoard = () =>
    edit([
      {
        op: 'add-board',
        board: { id: newId('beat'), title: 'New beat', summary: '', author: { kind: 'person' }, at: new Date().toISOString() },
      },
    ]);

  /**
   * A beat becomes a shot, carrying its words across.
   *
   * The link is kept so the shot knows where it came from, which is what lets the storyboard
   * still mean something after the shot list has been rewritten around it.
   */
  const toShot = (boardId: string, title: string, summary: string) =>
    edit([
      {
        op: 'add-shot',
        shot: {
          id: newId('shot'),
          slug: title,
          intent: summary,
          prompt: '',
          seconds: 4,
          boardId,
          takes: [],
          author: { kind: 'person' },
          at: new Date().toISOString(),
        },
      },
    ]);

  return (
    <Pane
      title="Storyboard"
      action={
        <button type="button" onClick={addBoard} className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink" title="Add a beat">
          <Plus size={13} />
        </button>
      }
    >
      {!production.boards.length ? (
        <p className="p-3 text-xs text-ink-3">
          Beats are the story before it is shots. Add a few, shuffle them until the shape is right, then turn each one
          into the shots it needs.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {production.boards.map((board) => {
            const shots = production.shots.filter((shot) => shot.boardId === board.id).length;
            return (
              <li key={board.id} className="group p-3">
                <input
                  className="w-full bg-transparent text-xs font-medium text-ink focus:outline-none"
                  value={board.title}
                  onChange={(event) => edit([{ op: 'update-board', id: board.id, patch: { title: event.target.value } }])}
                />
                <textarea
                  rows={2}
                  placeholder="What happens here."
                  className="mt-1 w-full resize-y bg-transparent text-[11px] text-ink-2 placeholder:text-ink-3 focus:outline-none"
                  value={board.summary}
                  onChange={(event) => edit([{ op: 'update-board', id: board.id, patch: { summary: event.target.value } }])}
                />
                <div className="mt-1 flex items-center gap-2 text-[10px] text-ink-3">
                  <span>{shots ? `${shots} shot${shots === 1 ? '' : 's'}` : 'no shots yet'}</span>
                  <button
                    type="button"
                    onClick={() => toShot(board.id, board.title, board.summary)}
                    className="ml-auto rounded px-1.5 py-0.5 text-primary opacity-0 transition group-hover:opacity-100 hover:bg-primary/10"
                  >
                    Make a shot
                  </button>
                  <button
                    type="button"
                    onClick={() => edit([{ op: 'remove-board', id: board.id }])}
                    className="rounded p-0.5 text-ink-3 opacity-0 transition group-hover:opacity-100 hover:text-danger"
                    title="Remove this beat"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Pane>
  );
}

/** Every shot, whether or not it has footage. */
function ShotsPanel({ production, edit, selectedShotId, onSelectShot }: MoviePanelProps) {
  const inCut = useMemo(() => new Set(production.cut.map((entry) => entry.shotId)), [production.cut]);

  const addShot = () => {
    const id = newId('shot');
    edit([
      {
        op: 'add-shot',
        shot: {
          id,
          slug: 'New shot',
          intent: '',
          prompt: '',
          seconds: 4,
          takes: [],
          author: { kind: 'person' },
          at: new Date().toISOString(),
        },
      },
      // Straight into the cut: a shot nobody put anywhere is a shot you have to remember to
      // place, and the whole point of slugs is that the cut exists from the first one.
      { op: 'cut-insert', shotId: id, before: null },
    ]);
    onSelectShot(id);
  };

  return (
    <Pane
      title="Shots"
      action={
        <button type="button" onClick={addShot} className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink" title="Add a shot">
          <Plus size={13} />
        </button>
      }
    >
      {!production.shots.length ? (
        <p className="p-3 text-xs text-ink-3">
          No shots yet. A shot does not need footage to be real — give it a slug and a length and it will hold its place
          in the cut until you have something to put in it.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {production.shots.map((shot, index) => (
            <li key={shot.id}>
              <button
                type="button"
                onClick={() => onSelectShot(shot.id)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left transition ${
                  selectedShotId === shot.id ? 'bg-surface-3' : 'hover:bg-surface-3/60'
                }`}
              >
                <span className="mt-0.5 w-6 shrink-0 font-mono text-[10px] text-ink-3">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-ink">{shot.slug}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-3">
                    <span>{shot.seconds}s</span>
                    {shot.size && <span>· {shot.size}</span>}
                    <span>
                      ·{' '}
                      {shot.takes.length
                        ? `${shot.takes.length} take${shot.takes.length === 1 ? '' : 's'}`
                        : 'slug'}
                    </span>
                    {!inCut.has(shot.id) && <span className="text-warning">· not in the cut</span>}
                  </span>
                </span>
                {/* The one piece of state worth a colour: whether this shot has footage chosen. */}
                <span
                  aria-hidden
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${shot.selectedTakeId ? 'bg-primary' : 'bg-ink-3/40'}`}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

/** The selected shot, at size: its footage if it has any, its intent if it does not. */
function ViewerPanel({ production, selectedShotId }: MoviePanelProps) {
  const shot = production.shots.find((entry) => entry.id === selectedShotId) ?? null;
  const take = shot?.takes.find((entry) => entry.id === shot.selectedTakeId) ?? null;

  return (
    <Pane title={shot ? shot.slug : 'Viewer'}>
      <div className="flex h-full min-h-0 items-center justify-center bg-surface p-4">
        {!shot ? (
          <p className="max-w-sm text-center text-xs text-ink-3">
            Pick a shot to see it here.
          </p>
        ) : take ? (
          <video
            key={take.id}
            src={mediaUrl(production.id, take.path)}
            controls
            className="max-h-full max-w-full rounded border border-line bg-black"
          />
        ) : (
          /* The slug. Shown as a frame rather than an error, because for most of the work this
             is what a shot correctly looks like. */
          <div className="flex aspect-video w-full max-w-2xl flex-col items-center justify-center gap-2 rounded border border-dashed border-line bg-surface-2 p-6 text-center">
            <Film size={22} className="text-ink-3" />
            <p className="text-sm text-ink">{shot.slug}</p>
            {shot.intent && <p className="max-w-md text-xs text-ink-2">{shot.intent}</p>}
            <p className="text-[10px] uppercase tracking-wide text-ink-3">
              {shot.seconds}s slug · no footage yet
            </p>
          </div>
        )}
      </div>
    </Pane>
  );
}

/** Everything about the selected shot, including what it would be rendered from. */
function InspectorPanel({ production, edit, selectedShotId, generators, onConfigureGenerators }: MoviePanelProps) {
  const shot = production.shots.find((entry) => entry.id === selectedShotId) ?? null;
  const video = generators.filter((entry) => entry.spec.kind === 'video');
  const usable = video.filter((entry) => !entry.problem);

  if (!shot) {
    return (
      <Pane title="Shot">
        <p className="p-3 text-xs text-ink-3">Pick a shot to work on it.</p>
      </Pane>
    );
  }

  const patch = (value: Partial<Omit<MovieShot, 'id' | 'takes' | 'author' | 'at'>>) =>
    edit([{ op: 'update-shot', id: shot.id, patch: value }]);

  return (
    <Pane title="Shot">
      <div className="space-y-3 p-3">
        <div>
          <label className={labelClass} htmlFor="shot-slug">Slug</label>
          <input id="shot-slug" className={fieldClass} value={shot.slug} onChange={(event) => patch({ slug: event.target.value })} />
        </div>
        <div>
          <label className={labelClass} htmlFor="shot-intent">What it is for</label>
          <textarea
            id="shot-intent"
            rows={3}
            className={`${fieldClass} resize-y`}
            placeholder="Why this shot exists in the film."
            value={shot.intent}
            onChange={(event) => patch({ intent: event.target.value })}
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className={labelClass} htmlFor="shot-size">Size</label>
            <select
              id="shot-size"
              className={fieldClass}
              value={shot.size ?? ''}
              onChange={(event) => patch({ size: (event.target.value || undefined) as ShotSize | undefined })}
            >
              <option value="">unspecified</option>
              {SHOT_SIZES.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </div>
          <div className="w-24">
            <label className={labelClass} htmlFor="shot-seconds">Seconds</label>
            <input
              id="shot-seconds"
              type="number"
              min={0.5}
              step={0.5}
              className={fieldClass}
              value={shot.seconds}
              onChange={(event) => patch({ seconds: Number(event.target.value) || 1 })}
            />
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor="shot-prompt">Prompt — what a generator is sent</label>
          <textarea
            id="shot-prompt"
            rows={4}
            className={`${fieldClass} resize-y`}
            placeholder="Left empty, the shot's intent is sent instead."
            value={shot.prompt}
            onChange={(event) => patch({ prompt: event.target.value })}
          />
          {/* Shown in full because the look is prepended invisibly, and a prompt you cannot see
              is a prompt you cannot debug when the render comes back wrong. */}
          {production.lookbook && (
            <p className="mt-1 rounded bg-surface-3/60 p-2 font-mono text-[10px] leading-relaxed text-ink-3">
              {shotPrompt(production, shot)}
            </p>
          )}
        </div>

        <div className="border-t border-line pt-3">
          <h3 className={labelClass}>Takes</h3>
          {!shot.takes.length ? (
            <p className="text-[11px] text-ink-3">Nothing rendered or imported yet.</p>
          ) : (
            <ul className="space-y-1">
              {shot.takes.map((take, index) => (
                <li key={take.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => edit([{ op: 'select-take', shotId: shot.id, takeId: take.id }])}
                    className={`flex-1 rounded px-2 py-1 text-left text-[11px] transition ${
                      shot.selectedTakeId === take.id ? 'bg-primary/10 text-primary' : 'text-ink-2 hover:bg-surface-3'
                    }`}
                  >
                    Take {index + 1}
                    <span className="ml-1.5 text-ink-3">
                      {take.width}×{take.height} · {take.seconds}s{take.seed !== undefined ? ` · seed ${take.seed}` : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => edit([{ op: 'remove-take', shotId: shot.id, takeId: take.id }])}
                    className="rounded p-1 text-ink-3 hover:text-danger"
                    title="Delete this take"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/*
          Generating. The control reports the real state rather than offering an action that
          cannot happen: with nothing configured it says so and points at where to fix it, which
          is more useful than a button that fails on press.
        */}
        <div className="border-t border-line pt-3">
          <h3 className={labelClass}>Render</h3>
          {!usable.length ? (
            <div className="space-y-2">
              <p className="text-[11px] text-ink-3">
                {video.length
                  ? video[0].problem
                  : 'No video generator is available in this release.'}
              </p>
              <button
                type="button"
                onClick={onConfigureGenerators}
                className="rounded-md border border-line px-2.5 py-1.5 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink"
              >
                Set up a generator
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-ink-2">
                Ready: {usable.map((entry) => entry.spec.name).join(', ')}.
              </p>
              <button
                type="button"
                disabled
                title="The render queue lands in the next release."
                className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1.5 text-[11px] text-primary opacity-60"
              >
                <Sparkles size={12} />
                Render this shot
              </button>
              <p className="text-[10px] text-ink-3">
                Queueing renders is not switched on yet. Generators configured here are ready for it.
              </p>
            </div>
          )}
        </div>
      </div>
    </Pane>
  );
}

/** What has been asked of the generators. */
function QueuePanel({ generators, onConfigureGenerators }: MoviePanelProps) {
  return (
    <Pane title="Renders">
      <div className="space-y-3 p-3">
        <ul className="space-y-2">
          {generators.map((entry) => (
            <li key={entry.spec.id} className="rounded border border-line p-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-ink">{entry.spec.name}</span>
                <span
                  className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${
                    entry.problem ? 'bg-surface-3 text-ink-3' : 'bg-primary/10 text-primary'
                  }`}
                >
                  {entry.problem ? 'not set up' : 'ready'}
                </span>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-ink-3">{entry.spec.note}</p>
              <p className="mt-1 text-[10px] text-ink-3">
                Up to {entry.spec.capabilities.maxWidth}×{entry.spec.capabilities.maxHeight},{' '}
                {entry.spec.capabilities.maxSeconds}s, {entry.spec.capabilities.fps}fps
                {entry.spec.capabilities.audio ? ', with audio' : ', silent'}.
              </p>
              {entry.spec.weights && (
                <p className="mt-1 text-[10px] text-ink-3">
                  {entry.spec.weights.repoId} — {entry.spec.weights.licence}
                </p>
              )}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onConfigureGenerators}
          className="rounded-md border border-line px-2.5 py-1.5 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink"
        >
          Configure generators
        </button>
      </div>
    </Pane>
  );
}

/** Notes that belong to the production rather than to any one conversation. */
function NotesPanel({ production, edit }: MoviePanelProps) {
  return (
    <Pane title="Notes">
      <textarea
        rows={14}
        className="h-full w-full resize-none bg-transparent p-3 text-xs text-ink placeholder:text-ink-3 focus:outline-none"
        placeholder="Anything that is about the film but not about one shot."
        value={production.notes}
        onChange={(event) => edit([{ op: 'set', patch: { notes: event.target.value } }])}
      />
    </Pane>
  );
}

/**
 * The cut.
 *
 * Shots in order, each as wide as it is long, so the rhythm of the film is visible before any of
 * it has been rendered. Dragging reorders; a shot with no footage draws as a slug rather than a
 * gap, which is the whole point.
 */
function TimelinePanel({ production, edit, selectedShotId, onSelectShot }: MoviePanelProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const total = cutSeconds(production);
  /** Pixels per second, picked so a short film is readable without scrolling forever. */
  const scale = 26;

  const loose = production.shots.filter((shot) => !production.cut.some((entry) => entry.shotId === shot.id));

  return (
    <Pane
      title={`Timeline — ${production.cut.length} shot${production.cut.length === 1 ? '' : 's'}, ${timecode(total)}`}
      action={
        loose.length ? (
          <button
            type="button"
            onClick={() => edit(loose.map((shot) => ({ op: 'cut-insert' as const, shotId: shot.id, before: null })))}
            className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10"
          >
            Add {loose.length} loose shot{loose.length === 1 ? '' : 's'}
          </button>
        ) : undefined
      }
    >
      {!production.cut.length ? (
        <p className="p-3 text-xs text-ink-3">
          Nothing in the cut yet. Add shots and they will line up here — slugs included, so you can feel the pacing
          before you spend a GPU-hour on it.
        </p>
      ) : (
        <div className="flex items-stretch gap-1 overflow-x-auto p-3">
          {production.cut.map((entry) => {
            const shot = production.shots.find((candidate) => candidate.id === entry.shotId);
            if (!shot) return null;
            const seconds = entrySeconds(production, entry);
            const take = shot.takes.find((candidate) => candidate.id === shot.selectedTakeId);
            return (
              <div
                key={entry.shotId}
                draggable
                onDragStart={() => setDragging(entry.shotId)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!dragging || dragging === entry.shotId) return;
                  // Remove then re-insert: the cut is an order, and moving within it is exactly
                  // those two operations. Doing it in one edit keeps it a single document write.
                  edit([
                    { op: 'cut-remove', shotId: dragging },
                    { op: 'cut-insert', shotId: dragging, before: entry.shotId },
                  ]);
                  setDragging(null);
                }}
                onClick={() => onSelectShot(shot.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectShot(shot.id);
                  }
                }}
                style={{ width: Math.max(72, seconds * scale) }}
                className={`group relative flex shrink-0 cursor-grab flex-col justify-between rounded border p-1.5 text-left transition ${
                  selectedShotId === shot.id ? 'border-primary bg-primary/10' : 'border-line bg-surface-2 hover:border-primary/40'
                } ${dragging === entry.shotId ? 'opacity-40' : ''}`}
              >
                <span className="flex items-center gap-1">
                  <GripVertical size={10} className="shrink-0 text-ink-3" />
                  <span className="truncate text-[10px] text-ink">{shot.slug}</span>
                </span>
                <span className="flex items-center justify-between text-[9px] text-ink-3">
                  <span>{seconds.toFixed(1)}s</span>
                  {take ? <Film size={9} /> : <span className="italic">slug</span>}
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    edit([{ op: 'cut-remove', shotId: shot.id }]);
                  }}
                  title="Take out of the cut"
                  className="absolute right-0.5 top-0.5 rounded p-0.5 text-ink-3 opacity-0 transition group-hover:opacity-100 hover:text-danger"
                >
                  <X size={9} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Pane>
  );
}

/** A library of what the production holds. Placed last because it is the least load-bearing. */
function LibraryPanel({ production }: MoviePanelProps) {
  const takes = production.shots.flatMap((shot) => shot.takes.map((take) => ({ shot, take })));
  return (
    <Pane title={`Library — ${takes.length} take${takes.length === 1 ? '' : 's'}`}>
      {!takes.length ? (
        <p className="p-3 text-xs text-ink-3">Nothing rendered or imported yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {takes.map(({ shot, take }) => (
            <li key={take.id} className="flex items-center gap-2 px-3 py-2 text-[11px]">
              <Clapperboard size={12} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-ink-2">{shot.slug}</span>
              <span className="shrink-0 text-ink-3">{take.seconds}s</span>
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

const PANELS: Record<UniversePanelKind, (props: MoviePanelProps) => JSX.Element> = {
  brief: BriefPanel,
  boards: BoardsPanel,
  shots: ShotsPanel,
  viewer: ViewerPanel,
  inspector: InspectorPanel,
  queue: QueuePanel,
  notes: NotesPanel,
  timeline: TimelinePanel,
  library: LibraryPanel,
};

/**
 * One panel, chosen by kind.
 *
 * An unknown kind draws an honest placeholder rather than nothing: a manifest from a newer
 * expansion than this release can name a panel this build has never heard of, and a blank region
 * would read as a bug in the workbench rather than a version mismatch.
 */
export function MoviePanel(props: MoviePanelProps) {
  const Panel = PANELS[props.kind];
  if (!Panel) {
    return (
      <Pane title="Unavailable">
        <p className="p-3 text-xs text-ink-3">
          This panel needs a newer version of Antimatter than the one you are running.
        </p>
      </Pane>
    );
  }
  return <Panel {...props} />;
}
