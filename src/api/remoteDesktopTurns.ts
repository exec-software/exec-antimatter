/** Main-process turn ownership mirrored into the desktop, without device credentials. */
export interface RemoteDesktopTurn {
  threadId: string;
  runId: string;
  responseMessageId: string;
  providerId: string;
  modelId: string;
  sourceName: string;
  startedAt: number;
}

export interface RemoteDesktopTurnsSnapshot {
  revision: number;
  turns: RemoteDesktopTurn[];
  finished?: { runId: string; failed: boolean; finishedAt: number };
}
