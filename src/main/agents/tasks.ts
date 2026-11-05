import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from '../privateState';
import type { AgentActivity, Task, TaskParent, TaskReply, TaskSource, TaskState } from './types';

/**
 * The task queue.
 *
 * One shape for every kind of work, whatever asked for it: something you dispatched by hand,
 * something the router decided belonged elsewhere, something on a schedule. They differ by
 * `source` and nothing else, which is what lets one list answer "what are my agents doing" — a
 * question that becomes unanswerable the moment scheduled work lives somewhere separate.
 */

interface StoreFile {
  version: 1;
  tasks: Task[];
}

/** Finished tasks are history, not state. Enough to see the day, not enough to become a log. */
const KEEP_FINISHED = 200;

let configPath = join(homedir(), '.antimatter', 'tasks.json');
let cache: StoreFile | null = null;
let listener: (() => void) | null = null;

export const useConfigPath = (path: string): void => {
  configPath = path;
  cache = null;
};

export const onChange = (callback: () => void): void => {
  listener = callback;
};

const read = (): StoreFile => {
  if (cache) return cache;
  const ownsDirectory = migratePrivateDirectory(dirname(configPath));
  if (!existsSync(configPath)) {
    cache = { version: 1, tasks: [] };
    return cache;
  }
  if (ownsDirectory) migratePrivateFile(configPath);
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as StoreFile;
    // Rows written before tasks carried a reply address have no such field. Normalise on the way
    // in so the rest of the code can read `task.reply` without asking which build wrote it.
    cache =
      parsed?.version === 1 && Array.isArray(parsed.tasks)
        ? { version: 1, tasks: parsed.tasks.map((task) => ({ ...task, reply: task.reply ?? null, parent: task.parent ?? null, paused: task.paused === true })) }
        : { version: 1, tasks: [] };
  } catch (error) {
    console.error('[tasks] unreadable store, starting empty:', error);
    cache = { version: 1, tasks: [] };
  }
  return cache;
};

function write(next: StoreFile): void {
  // Trim finished work rather than the queue: a pending task is never dropped to save space.
  const finished = next.tasks.filter((task) => task.state === 'done' || task.state === 'failed' || task.state === 'cancelled');
  const live = next.tasks.filter((task) => task.state === 'queued' || task.state === 'running');
  const kept = finished.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, KEEP_FINISHED);

  cache = { version: 1, tasks: [...live, ...kept] };
  writePrivateFileAtomic(configPath, `${JSON.stringify(cache, null, 2)}\n`);
  listener?.();
}

export const list = (): Task[] =>
  [...read().tasks].sort((a, b) => {
    // Live work first, then by when it was asked for.
    const rank = (task: Task) => (task.state === 'running' ? 0 : task.state === 'queued' ? 1 : 2);
    return rank(a) - rank(b) || b.createdAt - a.createdAt;
  });

export const find = (id: string): Task | null => read().tasks.find((task) => task.id === id) ?? null;

export interface NewTask {
  agentId: string;
  title: string;
  prompt: string;
  source?: TaskSource;
  workspace?: string | null;
  /** Minutes between runs, for repeating work. Null or absent for one-shot. */
  everyMinutes?: number | null;
  /** Set by the router, so the conversation that gave up the turn gets the answer back. */
  reply?: TaskReply | null;
  /** Set when a chat turn hands work to an agent itself and waits for it. */
  parent?: TaskParent | null;
  /**
   * Create it already running, for a caller that runs it immediately rather than queueing it.
   * Written as running in the same step, so the queue's worker can never claim it in between.
   */
  startNow?: boolean;
}

export function add(input: NewTask): Task {
  const now = Date.now();
  if (input.everyMinutes !== null && input.everyMinutes !== undefined &&
      (!Number.isSafeInteger(input.everyMinutes) || input.everyMinutes < 1 || input.everyMinutes > 525_600)) {
    throw new Error('A repeat interval must be a whole number from 1 to 525,600 minutes.');
  }
  const repeats = input.everyMinutes && input.everyMinutes > 0 ? Math.trunc(input.everyMinutes) : null;

  const task: Task = {
    id: randomUUID(),
    agentId: input.agentId,
    title: input.title.trim() || 'Untitled task',
    prompt: input.prompt,
    source: input.source ?? 'manual',
    reply: input.reply ?? null,
    parent: input.parent ?? null,
    state: input.startNow ? 'running' : 'queued',
    workspace: input.workspace ?? null,
    createdAt: now,
    startedAt: input.startNow ? now : null,
    finishedAt: null,
    carbonId: null,
    schedule: repeats ? `every ${repeats}m` : null,
    paused: false,
    dueAt: repeats ? now : null,
    error: null,
    summary: null,
  };

  const current = read();
  write({ ...current, tasks: [task, ...current.tasks] });
  return task;
}

export function update(id: string, patch: Partial<Task>): Task | null {
  const current = read();
  const existing = current.tasks.find((task) => task.id === id);
  if (!existing) return null;

  const next = { ...existing, ...patch, id: existing.id };
  write({ ...current, tasks: current.tasks.map((task) => (task.id === id ? next : task)) });
  return next;
}

export function remove(id: string): void {
  const current = read();
  write({ ...current, tasks: current.tasks.filter((task) => task.id !== id) });
}

/** The next task that should run, or null when the queue is idle or everything is waiting. */
export function claim(): Task | null {
  const now = Date.now();
  const ready = read()
    .tasks.filter((task) => task.state === 'queued' && !task.paused && (task.dueAt === null || task.dueAt <= now))
    .sort((a, b) => (a.dueAt ?? a.createdAt) - (b.dueAt ?? b.createdAt) || a.createdAt - b.createdAt)[0];
  if (!ready) return null;
  return update(ready.id, { state: 'running', startedAt: now, error: null });
}

/**
 * Records how a run ended. A repeating task goes back to the queue with its next due time
 * rather than staying finished, which is the whole difference between a schedule and a list.
 */
export function settle(id: string, outcome: { ok: boolean; summary?: string; error?: string; carbonId?: string }): void {
  const task = find(id);
  if (!task) return;
  // Cancellation and shutdown/recovery are authoritative terminal transitions. A late provider
  // rejection from the run they interrupted must not overwrite them.
  if (task.state !== 'running') return;

  const repeats = /^every (\d+)m$/.exec(task.schedule ?? '');
  const finishedAt = Date.now();

  if (repeats) {
    update(id, {
      state: 'queued',
      finishedAt,
      dueAt: finishedAt + Number(repeats[1]) * 60_000,
      summary: outcome.summary ?? null,
      error: outcome.error ?? null,
      carbonId: outcome.carbonId ?? task.carbonId,
    });
    return;
  }

  update(id, {
    state: outcome.ok ? 'done' : 'failed',
    finishedAt,
    summary: outcome.summary ?? null,
    error: outcome.error ?? null,
    carbonId: outcome.carbonId ?? task.carbonId,
  });
}

export function cancel(id: string): void {
  const task = find(id);
  if (!task || task.state === 'done' || task.state === 'failed') return;
  update(id, { state: 'cancelled', finishedAt: Date.now(), schedule: null, dueAt: null });
}

/** Pausing affects future runs, leaving a run already in progress to finish safely. */
export function setSchedulePaused(id: string, paused: boolean): Task {
  const task = find(id);
  const repeats = /^every (\d+)m$/.exec(task?.schedule ?? '');
  if (!task || !repeats) throw new Error('This task does not have a recurring schedule.');
  return update(id, { paused, ...(!paused && task.state === 'queued'
    ? { dueAt: Date.now() + Number(repeats[1]) * 60_000 }
    : {}) })!;
}

/**
 * Put work interrupted by an app exit back at the front of the queue.
 *
 * Except a chat turn's subagent: the turn that was waiting for it ended with the app, so running
 * it again would do the work for nobody. It is recorded as interrupted instead.
 */
export function requeueRunning(reason = 'Interrupted when Antimatter stopped; queued to resume.'): number {
  const current = read();
  let count = 0;
  const now = Date.now();
  const next = current.tasks.map((task) => {
    if (task.state !== 'running') return task;
    count += 1;
    if (task.source === 'chat') {
      return { ...task, state: 'failed' as const, finishedAt: now, error: 'Interrupted when Antimatter stopped.' };
    }
    return { ...task, state: 'queued' as const, startedAt: null, dueAt: now, error: reason };
  });
  if (count) write({ ...current, tasks: next });
  return count;
}

export const counts = (): Record<TaskState, number> => {
  const totals: Record<TaskState, number> = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const task of read().tasks) totals[task.state] += 1;
  return totals;
};

export const activity = (names: Map<string, string>): AgentActivity[] =>
  list()
    .filter((task) => task.state === 'running' || (task.state === 'queued' && !task.paused))
    .map((task) => ({
      taskId: task.id,
      agentId: task.agentId,
      agentName: names.get(task.agentId) ?? task.agentId,
      title: task.title,
      state: task.state,
      startedAt: task.startedAt,
      carbonId: task.carbonId,
    }));
