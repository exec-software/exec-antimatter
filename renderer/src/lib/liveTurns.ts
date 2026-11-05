import type { ContextReport, LivenessNote, ProviderConfig, StreamStats } from '../types';

/**
 * Which conversations are working, and what each of them is doing.
 *
 * The window used to hold one turn: one `isStreaming`, one response id, one set of stats, one
 * error, one steer. The main process never had that limit — `ActiveTurns` reserves a turn per
 * *conversation*, which is what lets a paired phone answer one chat while the desktop answers
 * another — so the ceiling of one chat at a time was the renderer's alone, and it showed up as
 * a composer that stayed disabled in every other conversation until the first one finished.
 *
 * Keyed by conversation, because that is the thing that can only have one turn. A record
 * outlives its run: when the turn settles the run id goes to null and the stats, the error and
 * the context report stay, which is what the header reads when you come back to a chat that
 * finished while you were reading another one.
 *
 * Nothing here decides *whether* a turn may start. `beginTurn` is told to begin. The window
 * gates on `runOf` before calling it, and the main process is the authority that refuses a
 * second turn on the same conversation.
 */

export const IDLE_STATS: StreamStats = {
  phase: 'idle',
  startedAt: 0,
  firstTokenAt: 0,
  lastTokenAt: 0,
  finishedAt: 0,
  chunks: 0,
  chars: 0,
  lastAliveAt: 0,
  waitingSince: 0,
};

/** A note typed during a turn, waiting for the model to be between things. */
export interface QueuedSteer {
  runId: string;
  note: string;
  delivered: boolean;
}

export interface LiveTurn {
  /** The run in flight. Null once it has settled; the rest of the record stays readable. */
  runId: string | null;
  /** Remote text is persisted by main; retain its identities after completion to ignore late deltas. */
  remote?: { runId: string; responseMessageId: string };
  /**
   * The source that actually received this turn. The picker can move on mid-turn — from a tool
   * window, say — and the status line must keep describing where the words are coming from.
   */
  source: ProviderConfig | null;
  stats: StreamStats;
  error: string;
  context: ContextReport | null;
  steer: QueuedSteer | null;
}

export type LiveTurns = Readonly<Record<string, LiveTurn>>;

export const NO_TURNS: LiveTurns = {};

/**
 * What a conversation with no turn behind it looks like. Shared rather than rebuilt per call:
 * `turnFor` runs on every render of the chat page, and a fresh object each time would defeat
 * every memo downstream of it.
 */
export const IDLE_TURN: LiveTurn = {
  runId: null,
  source: null,
  stats: IDLE_STATS,
  error: '',
  context: null,
  steer: null,
};

/** What to show for a conversation, including one that has never run a turn. */
export function turnFor(turns: LiveTurns, threadId: string | null | undefined): LiveTurn {
  return (threadId && turns[threadId]) || IDLE_TURN;
}

/** The run in flight for a conversation, or null when it is idle. */
export function runOf(turns: LiveTurns, threadId: string | null | undefined): string | null {
  return (threadId && turns[threadId]?.runId) || null;
}

export const isRunning = (turns: LiveTurns, threadId: string | null | undefined): boolean =>
  runOf(turns, threadId) !== null;

/**
 * The conversation a run belongs to.
 *
 * Every stream event carries the response id and nothing else, so this is the routing step for
 * all of them. A run that has already settled is not found, which is the guard that stops a
 * late frame from an abandoned turn reopening the record of the turn that replaced it.
 */
export function threadOf(turns: LiveTurns, runId: string | null | undefined): string | null {
  if (!runId) return null;
  for (const [threadId, turn] of Object.entries(turns)) {
    if (turn.runId === runId) return threadId;
  }
  return null;
}

/** The conversations working right now, for the list in the rail. */
export function runningThreads(turns: LiveTurns): string[] {
  return Object.entries(turns)
    .filter(([, turn]) => turn.runId !== null)
    .map(([threadId]) => threadId);
}

export const runningCount = (turns: LiveTurns): number => runningThreads(turns).length;

/**
 * A turn begins. Its conversation's previous error, context report and steer go with the turn
 * that produced them — reading a stale failure above a running turn is how a working chat comes
 * to look broken.
 */
export function beginTurn(
  turns: LiveTurns,
  threadId: string,
  run: { runId: string; source: ProviderConfig | null; startedAt: number }
): LiveTurns {
  return {
    ...turns,
    [threadId]: {
      runId: run.runId,
      source: run.source,
      // Zero alive/token times until the source itself answers. Treating the local click as a
      // heartbeat made a connection that had not opened yet look healthy for twenty seconds.
      stats: { ...IDLE_STATS, phase: 'thinking', startedAt: run.startedAt },
      error: '',
      context: null,
      steer: null,
    },
  };
}

/**
 * A turn settles. Only the run that owns the conversation may end it, so an old `finally` that
 * unwinds after its conversation has started another turn changes nothing.
 */
export function endTurn(
  turns: LiveTurns,
  runId: string,
  ending: { failed: boolean; finishedAt: number }
): LiveTurns {
  const threadId = threadOf(turns, runId);
  if (!threadId) return turns;
  const turn = turns[threadId];
  return {
    ...turns,
    [threadId]: {
      ...turn,
      runId: null,
      source: null,
      steer: null,
      stats: {
        ...turn.stats,
        phase: ending.failed ? 'error' : 'done',
        finishedAt: ending.finishedAt,
        waitingSince: 0,
        aliveNote: undefined,
      },
    },
  };
}

/** Fold a stream event into the stats of the run it names. Unknown runs are ignored. */
export function updateStats(
  turns: LiveTurns,
  runId: string,
  change: (stats: StreamStats) => StreamStats
): LiveTurns {
  const threadId = threadOf(turns, runId);
  if (!threadId) return turns;
  const turn = turns[threadId];
  return { ...turns, [threadId]: { ...turn, stats: change(turn.stats) } };
}

/** Limit redundant presentation updates; providers and main-process watchdogs keep every beat. */
export function noteAlive(turns: LiveTurns, beat: { id: string; at: number; note?: LivenessNote }): LiveTurns {
  const threadId = threadOf(turns, beat.id);
  if (!threadId) return turns;
  const turn = turns[threadId];
  const stats = turn.stats;
  const note = beat.note;
  const changed = note !== undefined && (note.label !== stats.aliveNote?.label || note.model !== stats.aliveNote?.model || note.seconds !== stats.aliveNote?.seconds);
  const elapsed = beat.at - stats.lastAliveAt;
  if (stats.lastAliveAt && !changed && elapsed >= 0 && elapsed < 1_000) return turns;
  // No trailing timer: a quiet, stopped or replaced run must never generate synthetic activity.
  return { ...turns, [threadId]: { ...turn, stats: { ...stats, lastAliveAt: beat.at, aliveNote: note ?? stats.aliveNote } } };
}

/**
 * Record a failure against the conversation it happened in — or clear one.
 *
 * Takes a conversation rather than a run because the two cases that matter have no run: a
 * request that never started, and a delete refused because the conversation is busy.
 */
export function noteError(turns: LiveTurns, threadId: string | null, error: string): LiveTurns {
  if (!threadId) return turns;
  const turn = turns[threadId];
  if (!turn) return error ? { ...turns, [threadId]: { ...IDLE_TURN, error } } : turns;
  if (turn.error === error) return turns;
  return { ...turns, [threadId]: { ...turn, error } };
}

/** What the window looked like for a turn, filed under the conversation that turn belongs to. */
export function noteContext(turns: LiveTurns, report: ContextReport): LiveTurns {
  const threadId = threadOf(turns, report.runId);
  if (!threadId) return turns;
  return { ...turns, [threadId]: { ...turns[threadId], context: report } };
}

export function queueSteer(turns: LiveTurns, runId: string, note: string): LiveTurns {
  const threadId = threadOf(turns, runId);
  if (!threadId) return turns;
  return { ...turns, [threadId]: { ...turns[threadId], steer: { runId, note, delivered: false } } };
}

/** The model took the note up. */
export function deliverSteer(turns: LiveTurns, runId: string, note: string): LiveTurns {
  const threadId = threadOf(turns, runId);
  if (!threadId) return turns;
  const turn = turns[threadId];
  if (!turn.steer || turn.steer.runId !== runId || turn.steer.note !== note) return turns;
  return { ...turns, [threadId]: { ...turn, steer: { ...turn.steer, delivered: true } } };
}

/**
 * Put the bubble away. `only` scopes the removal to one note so the timer that clears a
 * delivered steer cannot take the next one queued in the same turn with it.
 */
export function dropSteer(
  turns: LiveTurns,
  runId: string,
  only?: { note: string; delivered: boolean }
): LiveTurns {
  const threadId = threadOf(turns, runId);
  if (!threadId) return turns;
  const turn = turns[threadId];
  if (!turn.steer || turn.steer.runId !== runId) return turns;
  if (only && (turn.steer.note !== only.note || turn.steer.delivered !== only.delivered)) return turns;
  return { ...turns, [threadId]: { ...turn, steer: null } };
}

/** A deleted conversation takes its record with it. */
export function forget(turns: LiveTurns, threadId: string): LiveTurns {
  if (!(threadId in turns)) return turns;
  const { [threadId]: _gone, ...rest } = turns;
  return rest;
}
