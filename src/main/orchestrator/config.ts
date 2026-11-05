import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isSupportedTrackerKind } from './tracker';
import type { WorkflowDefinition } from './types';

/**
 * The typed view of WORKFLOW.md front matter (spec §5.3, §6).
 *
 * Everything has a defined default so a workflow file can be as short as a tracker block, and
 * unknown keys are ignored so a newer file does not break an older build (§5.3).
 */

export interface TrackerConfig {
  kind: string | null;
  endpoint: string;
  apiKey: string | null;
  projectSlug: string | null;
  activeStates: string[];
  terminalStates: string[];
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  /** Keys are normalized to lowercase (§5.3.5). */
  maxConcurrentAgentsByState: Record<string, number>;
}

/**
 * §5.3.6. The spec names this block `codex` because its reference runtime shells out to the
 * Codex app-server. Antimatter is the agent, so these become the timeouts of our own turn loop;
 * the key name is kept so the same WORKFLOW.md works against either implementation.
 */
export interface RunnerConfig {
  command: string;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  /** <= 0 disables stall detection (§5.3.6). */
  stallTimeoutMs: number;
  /**
   * §5.3.6 treats this as a pass-through agent config value. Antimatter reads one value from
   * it: `never` means run unattended with no approvals. Anything else keeps command-executing
   * and outward-facing tools refused, since no human is watching an orchestrated run.
   */
  approvalPolicy: string | null;
  /** Optional pins, so a workflow can name the source and model that does the work. */
  providerId: string | null;
  model: string | null;
}

export interface ServiceConfig {
  tracker: TrackerConfig;
  pollIntervalMs: number;
  workspaceRoot: string;
  hooks: HooksConfig;
  agent: AgentConfig;
  runner: RunnerConfig;
}

export const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress'];
export const DEFAULT_TERMINAL_STATES = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'];
export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Front matter allows an integer or a string integer for numeric fields (§5.3.2). */
function asInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** A positive integer, or the fallback: non-positive values are treated as invalid (§5.3.4). */
function asPositive(value: unknown, fallback: number): number {
  const parsed = asInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function asStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const list = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return list.length ? list : fallback;
}

/**
 * §6.1 — a value may be a literal or `$VAR_NAME`. A `$VAR` that resolves to an empty string is
 * treated as missing rather than as an empty literal, so a forgotten export fails loudly at
 * validation instead of silently authenticating as nobody.
 */
export function expandEnv(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('$')) return trimmed;

  const resolved = process.env[trimmed.slice(1)] ?? '';
  return resolved.trim() ? resolved : null;
}

/**
 * §6.1 — path fields expand `~` and `$VAR`. A bare string with no separator is preserved as
 * written, because the spec allows (while discouraging) relative workspace roots.
 */
export function expandPath(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;

  const expanded = raw.startsWith('$') ? (expandEnv(raw) ?? '') : raw;
  if (!expanded) return fallback;
  if (expanded === '~') return homedir();
  if (expanded.startsWith('~/')) return join(homedir(), expanded.slice(2));
  if (!expanded.includes('/') && !expanded.includes('\\')) return expanded;

  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
}

const asScript = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

function readByState(value: unknown): Record<string, number> {
  const source = asRecord(value);
  const result: Record<string, number> = {};

  for (const [state, limit] of Object.entries(source)) {
    const parsed = asInteger(limit, 0);
    // Invalid entries are ignored rather than failing the whole workflow (§5.3.5).
    if (parsed > 0) result[state.trim().toLowerCase()] = parsed;
  }
  return result;
}

/**
 * Builds the typed view from a parsed WORKFLOW.md.
 *
 * `baseDir` is the directory holding the workflow file. A relative `file` tracker endpoint
 * resolves against it rather than against the process working directory, which for an Electron
 * main process is not reliably the project root. A `linear` endpoint is a URL and is never
 * path-resolved (§6.1: do not rewrite URIs).
 */
export function readConfig(workflow: WorkflowDefinition, baseDir?: string): ServiceConfig {
  const root = workflow.config;
  const tracker = asRecord(root.tracker);
  const polling = asRecord(root.polling);
  const workspace = asRecord(root.workspace);
  const hooks = asRecord(root.hooks);
  const agent = asRecord(root.agent);
  const runner = asRecord(root.codex);

  const kind = typeof tracker.kind === 'string' && tracker.kind.trim() ? tracker.kind.trim().toLowerCase() : null;
  const rawEndpoint = expandEnv(tracker.endpoint);
  const endpoint =
    kind === 'file' && rawEndpoint
      ? isAbsolute(rawEndpoint)
        ? rawEndpoint
        : resolve(baseDir ?? process.cwd(), rawEndpoint)
      : (rawEndpoint ?? (kind === 'linear' ? LINEAR_ENDPOINT : ''));

  return {
    tracker: {
      kind,
      endpoint,
      apiKey: expandEnv(tracker.api_key),
      projectSlug: expandEnv(tracker.project_slug),
      activeStates: asStringList(tracker.active_states, DEFAULT_ACTIVE_STATES),
      terminalStates: asStringList(tracker.terminal_states, DEFAULT_TERMINAL_STATES),
    },
    pollIntervalMs: asPositive(polling.interval_ms, 30_000),
    workspaceRoot: expandPath(workspace.root, join(tmpdir(), 'symphony_workspaces')),
    hooks: {
      afterCreate: asScript(hooks.after_create),
      beforeRun: asScript(hooks.before_run),
      afterRun: asScript(hooks.after_run),
      beforeRemove: asScript(hooks.before_remove),
      timeoutMs: asPositive(hooks.timeout_ms, 60_000),
    },
    agent: {
      maxConcurrentAgents: asPositive(agent.max_concurrent_agents, 10),
      maxTurns: asPositive(agent.max_turns, 20),
      maxRetryBackoffMs: asPositive(agent.max_retry_backoff_ms, 300_000),
      maxConcurrentAgentsByState: readByState(agent.max_concurrent_agents_by_state),
    },
    runner: {
      command: typeof runner.command === 'string' && runner.command.trim() ? runner.command.trim() : 'antimatter',
      turnTimeoutMs: asPositive(runner.turn_timeout_ms, 3_600_000),
      readTimeoutMs: asPositive(runner.read_timeout_ms, 5_000),
      // Zero and negatives are meaningful here: they disable stall detection.
      stallTimeoutMs: asInteger(runner.stall_timeout_ms, 300_000),
      approvalPolicy:
        typeof runner.approval_policy === 'string' && runner.approval_policy.trim()
          ? runner.approval_policy.trim().toLowerCase()
          : null,
      // `provider_id` is the precise name; `provider` is accepted because it reads better.
      providerId: expandEnv(runner.provider_id ?? runner.provider),
      model: expandEnv(runner.model),
    },
  };
}

/**
 * §6.3 — the scheduler preflight. This validates only what is needed to poll and dispatch, and
 * it runs again before every dispatch cycle, so a workflow fixed on disk recovers without a
 * restart. Returns the reasons dispatch cannot proceed; empty means go.
 */
export function validateForDispatch(config: ServiceConfig): string[] {
  const problems: string[] = [];

  if (!config.tracker.kind) {
    problems.push('tracker.kind is missing');
  } else if (!isSupportedTrackerKind(config.tracker.kind)) {
    problems.push(`tracker.kind "${config.tracker.kind}" is not supported`);
  }

  if (config.tracker.kind === 'linear') {
    if (!config.tracker.apiKey) problems.push('tracker.api_key is missing (set LINEAR_API_KEY or a literal token)');
    if (!config.tracker.projectSlug) problems.push('tracker.project_slug is required for the linear tracker');
  }

  if (config.tracker.kind === 'snitch' && config.agent.maxConcurrentAgents > 1) {
    problems.push('the snitch tracker uses live project checkouts, so agent.max_concurrent_agents must be 1');
  }

  if (!config.workspaceRoot) problems.push('workspace.root resolved to an empty path');

  return problems;
}

/** §8.4 — failure backoff. Continuation retries use a flat 1s and do not come through here. */
export const backoffMs = (attempt: number, maxBackoffMs: number): number =>
  Math.min(10_000 * 2 ** Math.max(0, attempt - 1), maxBackoffMs);

export const CONTINUATION_DELAY_MS = 1_000;
