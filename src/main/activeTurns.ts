/**
 * Main-process ownership for interactive conversation turns.
 *
 * Renderer state is not authoritative: a reload can create a second renderer while the first
 * request is still unwinding. Keeping this registry beside the AbortControllers guarantees that
 * one conversation can never have two models appending to the same transcript and Carbon.
 */
export class ActiveTurns {
  private readonly byThread = new Map<string, ActiveTurnRecord>();
  private readonly byRun = new Map<string, ActiveTurnRecord>();

  begin(threadId: string, runId: string, details: ActiveTurnDetails = {}): ActiveTurnRecord {
    const active = this.byThread.get(threadId);
    if (active) {
      throw new Error(
        active.runId === runId
          ? 'This turn is already running.'
          : 'This conversation already has a turn running. Stop it or wait for it to finish.'
      );
    }
    if (this.byRun.has(runId)) throw new Error('This turn is already running.');

    const record: ActiveTurnRecord = {
      threadId,
      runId,
      owner: details.owner ?? { kind: 'renderer' },
      ...(details.projectId ? { projectId: details.projectId } : {}),
      ...(details.responseMessageId ? { responseMessageId: details.responseMessageId } : {}),
      startedAt: details.startedAt ?? Date.now(),
    };
    this.byThread.set(threadId, record);
    this.byRun.set(runId, record);
    return record;
  }

  finish(threadId: string, runId: string): void {
    // An old finally block must never release a newer owner.
    const active = this.byThread.get(threadId);
    if (active?.runId !== runId) return;
    this.byThread.delete(threadId);
    if (this.byRun.get(runId) === active) this.byRun.delete(runId);
  }

  runFor(threadId: string): string | null {
    return this.byThread.get(threadId)?.runId ?? null;
  }

  recordForRun(runId: string): ActiveTurnRecord | null {
    return this.byRun.get(runId) ?? null;
  }

  list(): ActiveTurnRecord[] {
    return [...this.byThread.values()].map((record) => ({
      ...record,
      owner: { ...record.owner },
    }));
  }
}

export type TurnOwner = { kind: 'renderer' } | { kind: 'remote'; deviceId: string };

export interface ActiveTurnDetails {
  owner?: TurnOwner;
  projectId?: string;
  responseMessageId?: string;
  startedAt?: number;
}

export interface ActiveTurnRecord {
  threadId: string;
  runId: string;
  owner: TurnOwner;
  projectId?: string;
  responseMessageId?: string;
  startedAt: number;
}
