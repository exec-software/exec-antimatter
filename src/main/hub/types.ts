/**
 * The Model Hub's vocabulary: what a Hugging Face search returns, what one repository offers to
 * download, and what Antimatter remembers about a download while it runs and after it lands.
 *
 * The renderer keeps a structural copy of these in renderer/src/types, like every other IPC shape.
 */

export type HubSort = 'downloads' | 'likes' | 'trending' | 'updated' | 'created';

/** GGUF is the only format Antimatter's engines load, so it is the default; `any` browses the rest. */
export type HubFormat = 'gguf' | 'any';

/** `auto` is approved on request, `manual` by the author. Either way a token is required. */
export type HubGating = false | 'auto' | 'manual';

export interface HubSearchQuery {
  text: string;
  sort: HubSort;
  format: HubFormat;
  /** A pipeline tag such as `text-generation`; null for every task. */
  task: string | null;
  author?: string | null;
  /** Opaque continuation from the previous page's `nextCursor`. */
  cursor?: string | null;
  limit?: number;
}

/** What a repository's GGUF files declare about the model inside them. */
export interface HubGgufFacts {
  architecture: string | null;
  contextLength: number | null;
  /** Parameter count, not bytes. */
  parameters: number | null;
}

export interface HubModelSummary {
  id: string;
  author: string | null;
  downloads: number;
  likes: number;
  updatedAt: string | null;
  task: string | null;
  gated: HubGating;
  private: boolean;
  tags: string[];
  gguf: HubGgufFacts | null;
}

export interface HubSearchPage {
  models: HubModelSummary[];
  nextCursor: string | null;
}

export interface HubFile {
  /** Path inside the repository, forward slashes, never absolute. */
  path: string;
  size: number;
  /** The LFS object id, which for every GGUF on the Hub is the file's SHA-256. */
  sha256: string | null;
}

/**
 * One thing a person would choose to download: a single GGUF, or every shard of a split one.
 * A shard on its own is useless, so shards are never offered separately.
 */
export interface HubVariant {
  /** Stable within a repository revision. */
  key: string;
  /** The quantization when the name carries one (`Q4_K_M`), otherwise the file's stem. */
  label: string;
  quant: string | null;
  files: HubFile[];
  bytes: number;
  /** Declared shard count; can exceed `files.length` when a repository is missing a shard. */
  shards: number;
  /** `projector` is a vision model's mmproj: needed beside a model, never a model on its own. */
  role: 'model' | 'projector';
  complete: boolean;
}

export interface HubModelDetail {
  id: string;
  /** The commit every file below was listed at. Downloads pin it. */
  revision: string;
  gated: HubGating;
  private: boolean;
  task: string | null;
  license: string | null;
  updatedAt: string | null;
  gguf: HubGgufFacts | null;
  variants: HubVariant[];
  /** Files that are not GGUF, so a repository with nothing loadable says so instead of looking empty. */
  otherFiles: number;
}

export type DownloadState = 'queued' | 'downloading' | 'paused' | 'failed' | 'ready';

/** What a running download is doing inside the `downloading` state. */
export type DownloadPhase = 'checking' | 'transferring' | 'finishing' | 'registering';

export type RegistrationTarget = 'bundled' | 'external';

export type RegistrationStatus =
  /** Listed on the source and addressable by its model id. */
  | 'registered'
  /** Written into configuration, waiting for the engine to restart with it. */
  | 'pending'
  /** The engine cannot load this architecture, so nothing was registered. */
  | 'unsupported'
  | 'failed';

export interface Registration {
  target: RegistrationTarget;
  sourceId: string | null;
  sourceName: string;
  status: RegistrationStatus;
  /** The id this model answers to on that source. */
  modelId: string | null;
  detail: string | null;
  at: number;
}

export interface DownloadFile extends HubFile {
  done: boolean;
}

export interface DownloadRecord {
  id: string;
  repoId: string;
  revision: string;
  variantKey: string;
  label: string;
  role: HubVariant['role'];
  files: DownloadFile[];
  bytesTotal: number;
  bytesDone: number;
  state: DownloadState;
  phase: DownloadPhase | null;
  error: string | null;
  /** The cache root this download writes into, fixed at enqueue so a settings change cannot orphan it. */
  root: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Absolute path of the first file once it is in place: what an engine is pointed at. */
  path: string | null;
  architecture: string | null;
  /** Quantization parsed from the selected Hub variant name, when it names one. */
  quantization?: string | null;
  contextLength: number | null;
  /**
   * `general.file_type` from the header. Absent on records written before it was kept — which is
   * why it is read back at startup — and null once read from a header that does not carry one.
   */
  fileType?: number | null;
  /** The id this model is registered under where Antimatter chooses the name. */
  modelId: string;
  registrations: Registration[];
  /** Live transfer rate, never persisted. */
  bytesPerSecond?: number;
}
