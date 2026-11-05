/** Experimental local experience memory. This flag never changes the model selection. */
export interface PensieveCorpus {
  id: string;
  entryCount: number;
  languages: string[];
  sdkVersion: string | null;
}

export interface PensieveExperimentalState {
  enabled: boolean;
  status: 'disabled' | 'enabled' | 'checking' | 'ready' | 'error';
  available: boolean;
  unavailableReason: string | null;
  corpus: PensieveCorpus | null;
  /** Counts for the last project whose status was read, not all projects combined. */
  statistics: { events: number; experiences: number; repairs: number } | null;
  projectId: string | null;
  error: string | null;
}

export interface PensieveExperimentalAPI {
  getState(): Promise<PensieveExperimentalState>;
  setEnabled(enabled: boolean): Promise<PensieveExperimentalState>;
  onChanged(callback: (state: PensieveExperimentalState) => void): () => void;
}

export type PensieveLanguage = 'matrix' | 'ny' | 'nil' | 'shared';
export type PensieveRequest =
  | { op: 'status' }
  | { op: 'capture'; session: string; id: string; actor: string; kind: string; content: string; meta?: Record<string, unknown> }
  | { op: 'recall'; session: string; cue: string; language: PensieveLanguage; task?: string; budget_chars?: number }
  | { op: 'observe'; session: string; id: string; task: string; language?: PensieveLanguage; program?: string | Record<string, string>;
      outcome: { status: 'passed' | 'failed' | 'unknown'; verification: 'compile' | 'runtime' | 'acceptance' | 'unverified';
        text: string; source_hashes?: Record<string, string>; command?: string } };
