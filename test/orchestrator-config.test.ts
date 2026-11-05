import assert from 'node:assert/strict';
import test from 'node:test';
import { validateForDispatch, type ServiceConfig } from '../src/main/orchestrator/config';
import { registerTracker } from '../src/main/orchestrator/tracker';

registerTracker('snitch', () => ({
  fetchCandidateIssues: async () => [],
  fetchIssuesByStates: async () => [],
  fetchIssueStatesByIds: async () => new Map(),
}));

function config(): ServiceConfig {
  return {
    tracker: {
      kind: 'snitch', endpoint: '', apiKey: null, projectSlug: null,
      activeStates: ['Fixing'], terminalStates: ['Done'],
    },
    pollIntervalMs: 1_000,
    workspaceRoot: '/tmp/antimatter-orchestrator-config-test',
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1_000 },
    agent: { maxConcurrentAgents: 2, maxTurns: 2, maxRetryBackoffMs: 10_000, maxConcurrentAgentsByState: {} },
    runner: {
      command: 'antimatter', turnTimeoutMs: 5_000, readTimeoutMs: 1_000, stallTimeoutMs: 0,
      approvalPolicy: 'never', providerId: null, model: null,
    },
  };
}

test('snitch rejects concurrent agents because its issues borrow live project checkouts', () => {
  assert.deepEqual(validateForDispatch(config()), [
    'the snitch tracker uses live project checkouts, so agent.max_concurrent_agents must be 1',
  ]);
});

test('snitch accepts its safe single-agent setting', () => {
  const next = config();
  next.agent.maxConcurrentAgents = 1;
  assert.deepEqual(validateForDispatch(next), []);
});
