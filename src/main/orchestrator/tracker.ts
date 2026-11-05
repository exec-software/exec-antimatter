import { existsSync, readFileSync } from 'node:fs';
import type { ServiceConfig } from './config';
import { OrchestratorError, type BlockerRef, type Issue } from './types';

/**
 * Issue tracker integration (spec §11).
 *
 * The orchestrator only ever sees the normalized §4.1.1 issue, so swapping trackers is a matter
 * of writing one adapter. Linear is the tracker the spec documents; a file-backed tracker is
 * provided so the scheduler can be exercised without network access or an API token.
 */

export interface Tracker {
  /** §11.1.1 — issues in the configured active states. */
  fetchCandidateIssues(): Promise<Issue[]>;
  /** §11.1.2 — used by startup terminal cleanup. */
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;
  /** §11.1.3 — current state per issue id, for reconciliation. */
  fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>>;
}

export const LINEAR_PAGE_SIZE = 50;
export const LINEAR_TIMEOUT_MS = 30_000;

/** Kept injectable so the adapter can be tested without contacting Linear. */
export type LinearTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LinearTrackerOptions {
  transport?: LinearTransport;
  /** The production default is fixed by the Symphony spec; tests may shorten it. */
  timeoutMs?: number;
}

/**
 * Kept separate from the transport code because Linear's schema is the part most likely to drift.
 * The inverse `blocks` relations point from the blocked issue back to the issue blocking it.
 */
export const LINEAR_ISSUES_BY_STATES_QUERY = `
query SymphonyIssuesByStates(
  $projectSlug: String!
  $stateNames: [String!]!
  $first: Int!
  $relationFirst: Int!
  $after: String
) {
  issues(
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $stateNames } }
    }
    first: $first
    after: $after
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue {
            id
            identifier
            state { name }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      createdAt
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

export const LINEAR_ISSUE_RELATIONS_QUERY = `
query SymphonyIssueRelations($issueId: String!, $first: Int!, $after: String) {
  issue(id: $issueId) {
    inverseRelations(first: $first, after: $after) {
      nodes {
        type
        issue {
          id
          identifier
          state { name }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

export const LINEAR_ISSUE_STATES_QUERY = `
query SymphonyIssueStates($issueIds: [ID!]!, $projectSlug: String!, $first: Int!) {
  issues(
    filter: { id: { in: $issueIds }, project: { slugId: { eq: $projectSlug } } }
    first: $first
  ) {
    nodes {
      id
      state { name }
    }
  }
}`;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const connectionNodes = (value: unknown): unknown[] | null => {
  const connection = asRecord(value);
  return connection && Array.isArray(connection.nodes) ? connection.nodes : null;
};

const linearState = (value: unknown): string | null => {
  if (typeof value === 'string') return asString(value);
  return asString(asRecord(value)?.name);
};

const linearLabels = (value: unknown): string[] => {
  const nodes = connectionNodes(value);
  if (!nodes) return [];
  const labels = nodes
    .map((node) => asString(asRecord(node)?.name)?.toLowerCase() ?? null)
    .filter((name): name is string => name !== null);
  return [...new Set(labels)];
};

const linearBlockers = (value: unknown): BlockerRef[] => {
  const nodes = connectionNodes(value);
  if (!nodes) return [];

  return nodes.flatMap((node) => {
    const relation = asRecord(node);
    if (asString(relation?.type)?.toLowerCase() !== 'blocks') return [];

    // `issue` is the blocker on an inverse `blocks` relation. The fallbacks make normalization
    // tolerant of equivalent payload shapes returned by compatible Linear proxies.
    const blocker = asRecord(relation?.issue ?? relation?.sourceIssue ?? relation?.relatedIssue);
    return [
      {
        id: asString(blocker?.id),
        identifier: asString(blocker?.identifier),
        state: linearState(blocker?.state),
      },
    ];
  });
};

/** §11.3 — priority is an integer or nothing; "2" and 2.7 are not priorities. */
const asPriority = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;

const asTimestamp = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const asBlockers = (value: unknown): BlockerRef[] =>
  Array.isArray(value)
    ? value.map((entry) => {
        const record = (entry ?? {}) as Record<string, unknown>;
        return {
          id: asString(record.id),
          identifier: asString(record.identifier),
          state: asString(record.state),
        };
      })
    : [];

/**
 * §11.3 — normalize a raw tracker payload. Returns null when the record is missing any field
 * dispatch depends on (§8.2), so a malformed row is skipped rather than dispatched blindly.
 */
export function normalizeIssue(raw: unknown): Issue | null {
  const record = (raw ?? {}) as Record<string, unknown>;
  const id = asString(record.id);
  const identifier = asString(record.identifier);
  const title = asString(record.title);
  const state = asString(record.state);
  if (!id || !identifier || !title || !state) return null;

  return {
    id,
    identifier,
    title,
    description: asString(record.description),
    priority: asPriority(record.priority),
    state,
    branchName: asString(record.branchName ?? record.branch_name),
    url: asString(record.url),
    labels: Array.isArray(record.labels)
      ? record.labels.filter((label): label is string => typeof label === 'string').map((label) => label.toLowerCase())
      : [],
    blockedBy: asBlockers(record.blockedBy ?? record.blocked_by),
    createdAt: asTimestamp(record.createdAt ?? record.created_at),
    updatedAt: asTimestamp(record.updatedAt ?? record.updated_at),
  };
}

/** Converts Linear's nested connection payload into the tracker-neutral issue model. */
export function normalizeLinearIssue(raw: unknown): Issue | null {
  const record = asRecord(raw);
  if (!record) return null;

  return normalizeIssue({
    ...record,
    state: linearState(record.state),
    labels: linearLabels(record.labels),
    blockedBy: linearBlockers(record.inverseRelations),
  });
}

/**
 * A tracker backed by a JSON file holding an array of issue records. `tracker.endpoint` is the
 * path to that file. It is re-read on every call, so editing the file is the same as someone
 * moving a ticket — which makes the whole scheduler exercisable end to end with no network.
 */
class FileTracker implements Tracker {
  constructor(
    private readonly path: string,
    private readonly activeStates: string[]
  ) {}

  private readAll(): Issue[] {
    if (!existsSync(this.path)) {
      throw new OrchestratorError('missing_tracker_project_slug', `Issue file not found: ${this.path}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      throw new OrchestratorError('workflow_parse_error', `Issue file is not valid JSON: ${(error as Error).message}`);
    }

    const rows = Array.isArray(parsed) ? parsed : (parsed as { issues?: unknown[] })?.issues;
    if (!Array.isArray(rows)) {
      throw new OrchestratorError('workflow_parse_error', `Issue file must hold an array, or an object with "issues".`);
    }

    return rows.map(normalizeIssue).filter((issue): issue is Issue => issue !== null);
  }

  private matching(states: string[]): Issue[] {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    return this.readAll().filter((issue) => wanted.has(issue.state.toLowerCase()));
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.matching(this.activeStates);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    return this.matching(states);
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const wanted = new Set(ids);
    const states = new Map<string, string>();
    for (const issue of this.readAll()) {
      if (wanted.has(issue.id)) states.set(issue.id, issue.state);
    }
    return states;
  }
}

interface LinearPage {
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** §11.2 — Linear GraphQL tracker with bounded requests and complete issue pagination. */
export class LinearTracker implements Tracker {
  private readonly transport: LinearTransport;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ServiceConfig,
    options: LinearTrackerOptions = {}
  ) {
    this.transport = options.transport ?? fetch;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : LINEAR_TIMEOUT_MS;
  }

  private credentials(): { apiKey: string; projectSlug: string } {
    const apiKey = this.config.tracker.apiKey;
    if (!apiKey) {
      throw new OrchestratorError('missing_tracker_api_key', 'tracker.api_key is required for the Linear tracker.');
    }
    const projectSlug = this.config.tracker.projectSlug;
    if (!projectSlug) {
      throw new OrchestratorError('missing_tracker_project_slug', 'tracker.project_slug is required for the Linear tracker.');
    }
    return { apiKey, projectSlug };
  }

  private async request(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { apiKey } = this.credentials();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new OrchestratorError(
            'linear_api_request',
            `Linear request timed out after ${this.timeoutMs} ms (${this.config.tracker.endpoint}).`
          )
        );
      }, this.timeoutMs);
    });

    try {
      const operation = (async () => {
        const response = await this.transport(this.config.tracker.endpoint, {
          method: 'POST',
          headers: {
            Authorization: apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
        return { response, text: await response.text() };
      })();

      const { response, text } = await Promise.race([operation, timedOut]);
      if (response.status !== 200) {
        throw new OrchestratorError(
          'linear_api_status',
          `Linear returned HTTP ${response.status}${text.trim() ? `: ${text.trim().slice(0, 500)}` : ''}`
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new OrchestratorError(
          'linear_unknown_payload',
          `Linear returned invalid JSON: ${(error as Error).message}`
        );
      }

      const envelope = asRecord(payload);
      if (!envelope) {
        throw new OrchestratorError('linear_unknown_payload', 'Linear response was not an object.');
      }
      if (Array.isArray(envelope.errors) && envelope.errors.length) {
        const messages = envelope.errors.map((entry) => asString(asRecord(entry)?.message) ?? 'unknown GraphQL error');
        throw new OrchestratorError('linear_graphql_errors', `Linear GraphQL error: ${messages.join('; ')}`);
      }

      const data = asRecord(envelope.data);
      if (!data) {
        throw new OrchestratorError('linear_unknown_payload', 'Linear response did not contain a data object.');
      }
      return data;
    } catch (error) {
      if (error instanceof OrchestratorError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new OrchestratorError('linear_api_request', `Linear request failed: ${message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private pageFrom(data: Record<string, unknown>): LinearPage {
    const connection = asRecord(data.issues);
    const nodes = connectionNodes(connection);
    const pageInfo = asRecord(connection?.pageInfo);
    if (!connection || !nodes || !pageInfo || typeof pageInfo.hasNextPage !== 'boolean') {
      throw new OrchestratorError('linear_unknown_payload', 'Linear issues connection was malformed.');
    }

    return {
      nodes,
      hasNextPage: pageInfo.hasNextPage,
      endCursor: asString(pageInfo.endCursor),
    };
  }

  /** Complete a relation connection whose first 50 entries were embedded in the issue page. */
  private async withCompleteRelations(raw: unknown): Promise<unknown> {
    const issue = asRecord(raw);
    const connection = asRecord(issue?.inverseRelations);
    const nodes = connectionNodes(connection);
    const pageInfo = asRecord(connection?.pageInfo);
    if (!issue || !connection || !nodes || pageInfo?.hasNextPage !== true) return raw;

    const issueId = asString(issue.id);
    if (!issueId) throw new OrchestratorError('linear_unknown_payload', 'Linear relation page had no issue id.');
    const allNodes = [...nodes];
    const seenCursors = new Set<string>();
    let after = asString(pageInfo.endCursor);
    if (!after) {
      throw new OrchestratorError(
        'linear_missing_end_cursor',
        `Linear reported more blocker relations for ${issueId} without an end cursor.`
      );
    }

    for (;;) {
      if (seenCursors.has(after)) {
        throw new OrchestratorError(
          'linear_missing_end_cursor',
          `Linear repeated blocker-relation cursor ${after} for ${issueId}.`
        );
      }
      seenCursors.add(after);
      const data = await this.request(LINEAR_ISSUE_RELATIONS_QUERY, {
        issueId,
        first: LINEAR_PAGE_SIZE,
        after,
      });
      const nextIssue = asRecord(data.issue);
      const nextConnection = asRecord(nextIssue?.inverseRelations);
      const nextNodes = connectionNodes(nextConnection);
      const nextPageInfo = asRecord(nextConnection?.pageInfo);
      if (!nextConnection || !nextNodes || !nextPageInfo || typeof nextPageInfo.hasNextPage !== 'boolean') {
        throw new OrchestratorError('linear_unknown_payload', 'Linear blocker-relation connection was malformed.');
      }
      allNodes.push(...nextNodes);
      if (!nextPageInfo.hasNextPage) break;
      after = asString(nextPageInfo.endCursor);
      if (!after) {
        throw new OrchestratorError(
          'linear_missing_end_cursor',
          `Linear reported more blocker relations for ${issueId} without an end cursor.`
        );
      }
    }

    return { ...issue, inverseRelations: { ...connection, nodes: allNodes, pageInfo: { hasNextPage: false, endCursor: null } } };
  }

  private async fetchMatching(states: string[]): Promise<Issue[]> {
    if (!states.length) return [];
    const { projectSlug } = this.credentials();
    const issues: Issue[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;

    for (;;) {
      const data = await this.request(LINEAR_ISSUES_BY_STATES_QUERY, {
        projectSlug,
        stateNames: states,
        first: LINEAR_PAGE_SIZE,
        relationFirst: LINEAR_PAGE_SIZE,
        after,
      });
      const page = this.pageFrom(data);
      const completeNodes = await Promise.all(page.nodes.map((node) => this.withCompleteRelations(node)));
      for (const node of completeNodes) {
        const issue = normalizeLinearIssue(node);
        if (issue) issues.push(issue);
      }

      if (!page.hasNextPage) return issues;
      if (!page.endCursor || seenCursors.has(page.endCursor)) {
        throw new OrchestratorError(
          'linear_missing_end_cursor',
          'Linear reported another issue page but did not provide a new end cursor.'
        );
      }
      seenCursors.add(page.endCursor);
      after = page.endCursor;
    }
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchMatching(this.config.tracker.activeStates);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    return this.fetchMatching(states);
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const { projectSlug } = this.credentials();
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    const states = new Map<string, string>();

    for (let offset = 0; offset < unique.length; offset += LINEAR_PAGE_SIZE) {
      const issueIds = unique.slice(offset, offset + LINEAR_PAGE_SIZE);
      const data = await this.request(LINEAR_ISSUE_STATES_QUERY, {
        issueIds,
        projectSlug,
        first: issueIds.length,
      });
      const nodes = connectionNodes(asRecord(data.issues));
      if (!nodes) {
        throw new OrchestratorError('linear_unknown_payload', 'Linear issue-state connection was malformed.');
      }

      for (const node of nodes) {
        const record = asRecord(node);
        const id = asString(record?.id);
        const state = linearState(record?.state);
        if (id && state) states.set(id, state);
      }
    }

    return states;
  }
}

/**
 * Trackers beyond the two the spec names. A kind registers itself rather than being added to a
 * switch here, so a feature that brings its own source of work — Snitch's fix pipeline is the
 * first — does not have to reach into the orchestrator to be dispatchable.
 */
const registry = new Map<string, (config: ServiceConfig) => Tracker>([
  [
    'file',
    (config) => {
      if (!config.tracker.endpoint) {
        throw new OrchestratorError('missing_tracker_project_slug', 'tracker.endpoint must be the path to the issue file.');
      }
      return new FileTracker(config.tracker.endpoint, config.tracker.activeStates);
    },
  ],
  ['linear', (config) => new LinearTracker(config)],
]);

export function registerTracker(kind: string, factory: (config: ServiceConfig) => Tracker): void {
  registry.set(kind.trim().toLowerCase(), factory);
}

export const isSupportedTrackerKind = (kind: string | null): boolean =>
  !!kind && registry.has(kind.trim().toLowerCase());

export function createTracker(config: ServiceConfig): Tracker {
  const factory = config.tracker.kind ? registry.get(config.tracker.kind) : undefined;
  if (!factory) {
    throw new OrchestratorError('unsupported_tracker_kind', `Unsupported tracker.kind: ${config.tracker.kind ?? '(none)'}`);
  }
  return factory(config);
}
