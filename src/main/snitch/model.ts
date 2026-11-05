/**
 * Snitch's domain model — issues, requests, releases and projects.
 *
 * The shapes and the on-disk format come from exec-snitch, deliberately: a project is a YAML
 * file beside two directories of Markdown, which is a format an agent can read and write with
 * the file tools it already has. Antimatter adds one thing to it — the pipeline block — so an
 * item can carry where it is in the fix/QA loop without a second database to keep in sync.
 */

export type ItemKind = 'issue' | 'request';
export type ItemStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
/** Severity on an issue, priority on a request: one scale, two names in the UI. */
export type ItemValue = 'critical' | 'high' | 'medium' | 'low';
export type ReleaseStatus = 'draft' | 'active' | 'archived';

export const ITEM_STATUSES: ItemStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
export const ITEM_VALUES: ItemValue[] = ['critical', 'high', 'medium', 'low'];
export const RELEASE_STATUSES: ReleaseStatus[] = ['draft', 'active', 'archived'];

/**
 * Where an item sits in the automated fix loop.
 *
 * `idle` is every item nobody has dispatched. The three middle stages are the only ones the
 * orchestrator will pick up, and the two terminal ones are how a dispatch stops without being
 * silently forgotten.
 */
export type PipelineStage = 'idle' | 'queued' | 'fixing' | 'qa' | 'verified' | 'failed';

export const ACTIVE_STAGES: PipelineStage[] = ['queued', 'fixing', 'qa'];

export interface PipelineState {
  stage: PipelineStage;
  /** Monotonic dispatch ownership token; stale workers cannot settle a later dispatch. */
  generation: number;
  /** Completed fix→QA cycles. Capped, so a bug that cannot be fixed stops rather than loops. */
  attempt: number;
  /** Consecutive runner failures in this stage. Persisted so restarting cannot reset the ceiling. */
  failures: number;
  updatedAt: string | null;
  /** The last thing that happened: a fix summary, a QA verdict, or why it stopped. */
  note: string | null;
}

export interface SnitchItem {
  kind: ItemKind;
  id: string;
  title: string;
  status: ItemStatus;
  value: ItemValue;
  created: string;
  updated: string;
  versionFound: string | null;
  versionFixed: string | null;
  releaseId: string | null;
  description: string;
  steps: string[];
  expected: string;
  actual: string;
  pipeline: PipelineState;
}

export interface SnitchRelease {
  id: string;
  version: string;
  name: string;
  date: string;
  status: ReleaseStatus;
  issueCount: number;
  requestCount: number;
}

export interface SnitchProject {
  name: string;
  path: string;
  created: string;
  updated: string;
  version: string;
  issuePrefix: string;
  requestPrefix: string;
  /**
   * The checkout this project's bugs live in. A dispatched fix runs here, which is what makes
   * one-click fixing useful and also why the UI never hides which directory it is.
   */
  repo: string | null;
  issuesDir: string;
  requestsDir: string;
  releases: SnitchRelease[];
}

export interface ProjectSummary {
  name: string;
  path: string;
  version: string;
  repo: string | null;
  issuePrefix: string;
  requestPrefix: string;
  openItems: number;
  totalItems: number;
  /** Items the orchestrator is currently working, so the project list can show a live count. */
  activeItems: number;
}

export interface ProjectDetail extends SnitchProject {
  items: SnitchItem[];
}

export interface ItemDraft {
  title: string;
  description?: string;
  value?: ItemValue;
  steps?: string[];
  expected?: string;
  actual?: string;
  versionFound?: string | null;
}

export const idlePipeline = (): PipelineState => ({
  stage: 'idle',
  generation: 0,
  attempt: 0,
  failures: 0,
  updatedAt: null,
  note: null,
});

export const isOpen = (status: ItemStatus): boolean => status === 'open' || status === 'in_progress';

export const isActiveStage = (stage: PipelineStage): boolean => ACTIVE_STAGES.includes(stage);

const enumOr = <T extends string>(allowed: readonly T[], raw: string | undefined, fallback: T): T =>
  allowed.find((entry) => entry === raw?.trim().toLowerCase()) ?? fallback;

export const parseStatus = (raw: string | undefined): ItemStatus => enumOr(ITEM_STATUSES, raw, 'open');
export const parseValue = (raw: string | undefined): ItemValue => enumOr(ITEM_VALUES, raw, 'medium');
export const parseReleaseStatus = (raw: string | undefined): ReleaseStatus => enumOr(RELEASE_STATUSES, raw, 'draft');
export const parseStage = (raw: string | undefined): PipelineStage =>
  enumOr(['idle', 'queued', 'fixing', 'qa', 'verified', 'failed'] as const, raw, 'idle');
