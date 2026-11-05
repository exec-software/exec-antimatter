import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServiceConfig } from '../src/main/orchestrator/config';
import {
  LINEAR_ISSUES_BY_STATES_QUERY,
  LINEAR_ISSUE_RELATIONS_QUERY,
  LINEAR_ISSUE_STATES_QUERY,
  LINEAR_PAGE_SIZE,
  LinearTracker,
  type LinearTransport,
} from '../src/main/orchestrator/tracker';
import { OrchestratorError } from '../src/main/orchestrator/types';

const config = (patch: Partial<ServiceConfig['tracker']> = {}): ServiceConfig => ({
  tracker: {
    kind: 'linear',
    endpoint: 'https://linear.example/graphql',
    apiKey: 'lin_api_key',
    projectSlug: 'antimatter',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done'],
    ...patch,
  },
  pollIntervalMs: 30_000,
  workspaceRoot: '/tmp/linear-tracker-test',
  hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 60_000 },
  agent: { maxConcurrentAgents: 1, maxTurns: 20, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {} },
  runner: {
    command: 'codex app-server',
    turnTimeoutMs: 3_600_000,
    readTimeoutMs: 5_000,
    stallTimeoutMs: 300_000,
    approvalPolicy: null,
    providerId: null,
    model: null,
  },
});

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const errorCode = (expected: OrchestratorError['code']) => (error: unknown): boolean => {
  assert.ok(error instanceof OrchestratorError);
  assert.equal(error.code, expected);
  return true;
};

test('fetches all active Linear pages with auth, project filtering, and normalized issue data', async () => {
  const requests: Array<{ url: string; init: RequestInit; body: { query: string; variables: Record<string, unknown> } }> = [];
  const pages = [
    {
      data: {
        issues: {
          nodes: [
            {
              id: 'issue-1',
              identifier: 'AM-1',
              title: 'Implement the tracker',
              description: 'Read Linear.',
              priority: 2,
              state: { name: 'Todo' },
              branchName: 'nathan/am-1',
              url: 'https://linear.app/acme/issue/AM-1',
              labels: { nodes: [{ name: 'Backend' }, { name: 'URGENT' }] },
              inverseRelations: {
                nodes: [
                  {
                    type: 'blocks',
                    issue: {
                      id: 'issue-0',
                      identifier: 'AM-0',
                      state: { name: 'In Progress' },
                    },
                  },
                  {
                    type: 'related',
                    issue: { id: 'issue-x', identifier: 'AM-X', state: { name: 'Todo' } },
                  },
                ],
              },
              createdAt: '2026-09-01T10:00:00.000Z',
              updatedAt: '2026-09-02T11:00:00.000Z',
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
        },
      },
    },
    {
      data: {
        issues: {
          nodes: [
            {
              id: 'issue-2',
              identifier: 'AM-2',
              title: 'Second page',
              priority: 2.5,
              state: { name: 'In Progress' },
              labels: { nodes: [] },
              inverseRelations: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  ];

  const transport: LinearTransport = async (input, init = {}) => {
    requests.push({
      url: String(input),
      init,
      body: JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> },
    });
    return reply(pages[requests.length - 1]);
  };

  const issues = await new LinearTracker(config(), { transport }).fetchCandidateIssues();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://linear.example/graphql');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(new Headers(requests[0].init.headers).get('Authorization'), 'lin_api_key');
  assert.equal(requests[0].body.query, LINEAR_ISSUES_BY_STATES_QUERY);
  assert.match(requests[0].body.query, /project: \{ slugId: \{ eq: \$projectSlug \} \}/);
  assert.match(requests[0].body.query, /inverseRelations\(first: \$relationFirst\)/);
  assert.deepEqual(requests[0].body.variables, {
    projectSlug: 'antimatter',
    stateNames: ['Todo', 'In Progress'],
    first: LINEAR_PAGE_SIZE,
    relationFirst: LINEAR_PAGE_SIZE,
    after: null,
  });
  assert.equal(requests[1].body.variables.after, 'cursor-1');

  assert.equal(issues.length, 2);
  assert.deepEqual(issues[0].labels, ['backend', 'urgent']);
  assert.deepEqual(issues[0].blockedBy, [
    { id: 'issue-0', identifier: 'AM-0', state: 'In Progress' },
  ]);
  assert.equal(issues[0].createdAt, Date.parse('2026-09-01T10:00:00.000Z'));
  assert.equal(issues[1].priority, null);
});

test('refreshes issue states in 50-id batches with the required ID variable type', async () => {
  const batches: string[][] = [];
  const transport: LinearTransport = async (_input, init = {}) => {
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: { issueIds: string[]; projectSlug: string };
    };
    assert.equal(body.query, LINEAR_ISSUE_STATES_QUERY);
    assert.match(body.query, /\$issueIds: \[ID!\]!/);
    assert.equal(body.variables.projectSlug, 'antimatter');
    batches.push(body.variables.issueIds);
    return reply({
      data: {
        issues: {
          nodes: body.variables.issueIds.map((id) => ({ id, state: { name: id === 'issue-50' ? 'Done' : 'Todo' } })),
        },
      },
    });
  };
  const ids = Array.from({ length: 51 }, (_unused, index) => `issue-${index}`);

  const states = await new LinearTracker(config(), { transport }).fetchIssueStatesByIds(ids);

  assert.deepEqual(batches.map((batch) => batch.length), [50, 1]);
  assert.equal(states.size, 51);
  assert.equal(states.get('issue-0'), 'Todo');
  assert.equal(states.get('issue-50'), 'Done');
});

test('paginates blocker relations beyond the embedded first page', async () => {
  const firstBlockers = Array.from({ length: LINEAR_PAGE_SIZE }, (_unused, index) => ({
    type: 'blocks',
    issue: { id: `blocker-${index}`, identifier: `AM-${index}`, state: { name: 'Done' } },
  }));
  let requests = 0;
  const transport: LinearTransport = async (_input, init = {}) => {
    requests += 1;
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    if (body.query === LINEAR_ISSUES_BY_STATES_QUERY) {
      return reply({
        data: {
          issues: {
            nodes: [{
              id: 'issue-many-blockers', identifier: 'AM-999', title: 'Wait for everything',
              state: { name: 'Todo' }, labels: { nodes: [] },
              inverseRelations: {
                nodes: firstBlockers,
                pageInfo: { hasNextPage: true, endCursor: 'relations-1' },
              },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
    assert.equal(body.query, LINEAR_ISSUE_RELATIONS_QUERY);
    assert.deepEqual(body.variables, { issueId: 'issue-many-blockers', first: LINEAR_PAGE_SIZE, after: 'relations-1' });
    return reply({
      data: {
        issue: {
          inverseRelations: {
            nodes: [{
              type: 'blocks',
              issue: { id: 'blocker-50', identifier: 'AM-50', state: { name: 'In Progress' } },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
  };

  const [result] = await new LinearTracker(config(), { transport }).fetchCandidateIssues();
  assert.equal(requests, 2);
  assert.equal(result.blockedBy.length, 51);
  assert.deepEqual(result.blockedBy.at(-1), {
    id: 'blocker-50',
    identifier: 'AM-50',
    state: 'In Progress',
  });
});

test('maps Linear protocol failures to stable orchestrator error codes', async (context) => {
  await context.test('GraphQL errors', async () => {
    const transport: LinearTransport = async () => reply({ errors: [{ message: 'bad filter' }] });
    await assert.rejects(
      () => new LinearTracker(config(), { transport }).fetchCandidateIssues(),
      errorCode('linear_graphql_errors')
    );
  });

  await context.test('HTTP status errors', async () => {
    const transport: LinearTransport = async () => reply({ error: 'unauthorized' }, 401);
    await assert.rejects(
      () => new LinearTracker(config(), { transport }).fetchCandidateIssues(),
      errorCode('linear_api_status')
    );
  });

  await context.test('missing pagination cursor', async () => {
    const transport: LinearTransport = async () =>
      reply({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } });
    await assert.rejects(
      () => new LinearTracker(config(), { transport }).fetchCandidateIssues(),
      errorCode('linear_missing_end_cursor')
    );
  });

  await context.test('request timeout', async () => {
    const transport: LinearTransport = async () => new Promise<Response>(() => {});
    await assert.rejects(
      () => new LinearTracker(config(), { transport, timeoutMs: 5 }).fetchCandidateIssues(),
      errorCode('linear_api_request')
    );
  });
});
