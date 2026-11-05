import type { RemoteDesktopTurn, RemoteDesktopTurnsSnapshot } from '../../api/remoteDesktopTurns';

/** Host-owned lifetimes, independent of whether a desktop renderer is currently attached. */
export class RemoteDesktopTurns {
  private revision = 0;
  private readonly turns = new Map<string, RemoteDesktopTurn>();

  constructor(private readonly changed: (snapshot: RemoteDesktopTurnsSnapshot) => void) {}

  snapshot(): RemoteDesktopTurnsSnapshot {
    return { revision: this.revision, turns: [...this.turns.values()].map((turn) => ({ ...turn })) };
  }

  begin(turn: RemoteDesktopTurn): void {
    this.turns.set(turn.runId, { ...turn });
    this.publish();
  }

  finish(runId: string, failed: boolean, finishedAt: number): void {
    if (!this.turns.delete(runId)) return;
    this.publish({ runId, failed, finishedAt });
  }

  private publish(finished?: RemoteDesktopTurnsSnapshot['finished']): void {
    this.revision += 1;
    try {
      this.changed({ ...this.snapshot(), ...(finished ? { finished } : {}) });
    } catch (error) {
      // Presentation must not cancel model work or prevent its authoritative cleanup.
      console.error('[remote] could not publish desktop turn state:', error);
    }
  }
}
