/**
 * Symphony domain model (spec §4).
 *
 * Antimatter implements the Symphony orchestrator spec in-process: it is itself the coding
 * agent, so the spec's "launch a coding-agent app-server" becomes "run a turn through our own
 * provider and MCP tool loop". The scheduling vocabulary below is kept faithful to the spec so
 * the two can be read side by side.
 */

/** §4.1.1 — a blocker reference on an issue. */
export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/** §4.1.1 — normalized issue record, whatever tracker it came from. */
export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  /** Lower numbers sort first during dispatch; null sorts last. */
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  /** Always lowercase (§11.3). */
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: number | null;
  updatedAt: number | null;
}

/** §4.1.2 — the parsed WORKFLOW.md file. */
export interface WorkflowDefinition {
  /** YAML front matter root object, exactly as written. */
  config: Record<string, unknown>;
  /** Markdown body after the front matter, trimmed. */
  promptTemplate: string;
}

/** §4.1.4 */
export interface Workspace {
  path: string;
  workspaceKey: string;
  /** True only when this call created the directory, which gates the after_create hook. */
  createdNow: boolean;
}

/** §7.2 — distinct terminal reasons matter because retry logic and logs differ. */
export type RunPhase =
  | 'PreparingWorkspace'
  | 'BuildingPrompt'
  | 'LaunchingAgentProcess'
  | 'InitializingSession'
  | 'StreamingTurn'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation';

/** §4.1.5 */
export interface RunAttempt {
  issueId: string;
  issueIdentifier: string;
  /** null on the first run; >= 1 for retries and continuations. */
  attempt: number | null;
  workspacePath: string;
  startedAt: number;
  phase: RunPhase;
  error?: string;
}

/** §4.1.6 — state tracked while an agent session is live. */
export interface LiveSession {
  /** `<threadId>-<turnId>` (§4.2). */
  sessionId: string;
  threadId: string;
  turnId: string;
  lastEvent: string | null;
  lastEventAt: number | null;
  lastMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Absolute totals already counted, so deltas are not double counted (§13.5). */
  reportedInputTokens: number;
  reportedOutputTokens: number;
  reportedTotalTokens: number;
  /** Turns started within this worker's lifetime. */
  turnCount: number;
}

/** §4.1.7 */
export interface RetryEntry {
  issueId: string;
  identifier: string;
  /** 1-based within the retry queue. */
  attempt: number;
  dueAt: number;
  error: string | null;
}

/** §7.1 — the service's own claim state, distinct from tracker state. */
export type ClaimState = 'Unclaimed' | 'Claimed' | 'Running' | 'RetryQueued' | 'Released';

export interface RunningEntry {
  issue: Issue;
  attempt: RunAttempt;
  session: LiveSession | null;
  startedAt: number;
}

/** §4.1.8 — the single authoritative in-memory state the orchestrator owns. */
export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Map<string, RunningEntry>;
  /** Reserved, running, or retrying — anything that must not be dispatched again. */
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  /** Bookkeeping only; never gates dispatch. */
  completed: Set<string>;
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; secondsRunning: number };
  rateLimits: unknown | null;
}

/** §5.5 and §10.6 — named so logs and the UI can branch on cause, not on message text. */
export type OrchestratorErrorCode =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_parse_error'
  | 'template_render_error'
  | 'unsupported_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'linear_api_request'
  | 'linear_api_status'
  | 'linear_graphql_errors'
  | 'linear_unknown_payload'
  | 'linear_missing_end_cursor'
  | 'missing_agent_source'
  | 'invalid_workspace_cwd'
  | 'workspace_escape'
  | 'hook_failed'
  | 'hook_timeout'
  | 'response_timeout'
  | 'turn_timeout'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_input_required';

export class OrchestratorError extends Error {
  constructor(
    readonly code: OrchestratorErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export const emptyState = (pollIntervalMs: number, maxConcurrentAgents: number): OrchestratorState => ({
  pollIntervalMs,
  maxConcurrentAgents,
  running: new Map(),
  claimed: new Set(),
  retryAttempts: new Map(),
  completed: new Set(),
  totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
  rateLimits: null,
});

/** §4.2 — states are compared case-insensitively everywhere. */
export const normalizeState = (state: string): string => state.trim().toLowerCase();
