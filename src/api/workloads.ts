export interface WorkloadFile { path: string; size: number; sha256: string; }

/**
 * A multimodal checkpoint ships its projector as a separate `mmproj` file, which the download
 * queue groups as its own `projector` variant. It is downloaded and verified alongside the
 * weights and passed to the runtime as `mmproj`; without it the server starts, answers text,
 * and reports no vision or audio support.
 */
export interface WorkloadProjector { variantKey: string; file: WorkloadFile; }

export interface Workload {
  id: string;
  name: string;
  description: string;
  engine: string;
  hardware: string;
  evidence: string;
  evidenceRefs: string[];
  repoId: string;
  revision: string;
  variantKey: string;
  quantization: string;
  files: WorkloadFile[];
  /** Present only for a checkpoint whose perception comes through a separate projector file. */
  projector?: WorkloadProjector;
  /** What this workload adds beyond text, when it adds anything. */
  modalities?: string[];
  contextTokens: number;
  maxOutputTokens: number;
  maxToolCallsPerMessage: number;
  /** Optional RPC peers are supplied by the person, never copied from a developer's LAN. */
  requiresPeers: boolean;
}

export interface WorkloadView extends Workload {
  /** Weights plus projector, so progress is measured against what must actually land. */
  bytes: number;
  deployment?: { sourceId: string; modelId: string; peers: string[] };
  /**
   * The combined transfer state. A workload with a projector has two queue records; this
   * reports the weaker of the two, so it reads `ready` only once every file is verified.
   */
  download: null | {
    id: string;
    state: 'queued' | 'downloading' | 'paused' | 'failed' | 'ready';
    bytesDone: number;
    error: string | null;
    path: string | null;
  };
}

export interface WorkloadsAPI {
  list(): Promise<WorkloadView[]>;
  download(id: string): Promise<WorkloadView[]>;
  configure(id: string, peers: string[]): Promise<WorkloadView[]>;
}
