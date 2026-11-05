import assert from 'node:assert/strict';
import test from 'node:test';
import { actions, agentState } from '../renderer/src/plugins/agents/store';
import { appendAgentContent } from '../renderer/src/plugins/agents/transcript';
import type { AgentTask, ToolActivity } from '../renderer/src/types';

test('agent content replay is idempotent and refuses a missing prefix', () => {
  assert.equal(appendAgentContent('Hello', ' world', 5), 'Hello world');
  assert.equal(appendAgentContent('Hello world', ' world', 5), 'Hello world');
  assert.equal(appendAgentContent('Hello wo', ' world', 5), 'Hello world');
  assert.equal(appendAgentContent('', ' world', 5), null);
  assert.equal(appendAgentContent('hi', '!', -1), null);
});

test('agent store subscribes before loading and reconciles snapshots with newer streamed events', async (t) => {
  const counts = { queued: 0, running: 1, done: 0, failed: 0, cancelled: 0 };
  const task = { id: 'task', state: 'running', carbonId: 'session' } as AgentTask;
  let contentListener: (event: { taskId: string; content: string; sessionId: string; revision: number; contentOffset: number }) => void;
  let activityListener: (event: unknown) => void;
  let resolveTasks: (tasks: AgentTask[]) => void;
  const tasks = new Promise<AgentTask[]>((resolve) => { resolveTasks = resolve; });
  let resolveSession: (session: unknown) => void;
  const session = new Promise((resolve) => { resolveSession = resolve; });
  let sessionCalls = 0;
  const tool: ToolActivity = { requestId: 'task', callId: 'read', activityId: '0:0:read',
    serverId: 'antimatter', serverName: 'Tools', toolName: 'read_file', tier: 'read', args: '{}', status: 'done', contentOffset: 15 };
  const api = {
    agents: { list: async () => [], tasks: () => tasks, activity: async () => ({ active: [], busy: true, counts }),
      session: () => { sessionCalls++; return session; }, cancelTask: async () => { throw new Error('Cannot stop this task.'); } },
    onAgentsChanged: () => () => {},
    onAgentContent: (callback: typeof contentListener) => { contentListener = callback; return () => {}; },
    onAgentActivity: (callback: typeof activityListener) => { activityListener = callback; return () => {}; },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: api } });
  t.after(() => { Reflect.deleteProperty(globalThis, 'window'); });

  const starting = actions.start();
  assert.equal(typeof contentListener!, 'function', 'must subscribe before the initial task request returns');
  contentListener!({ taskId: 'task', content: 'Before ', sessionId: 'session', revision: 1, contentOffset: 0 });
  assert.equal(agentState().streaming.task, 'Before ');
  resolveTasks!([task]);
  for (let i = 0; i < 10 && sessionCalls === 0; i++) await Promise.resolve();
  assert.equal(sessionCalls, 1);
  contentListener!({ taskId: 'task', content: ' suffix', sessionId: 'session', revision: 3, contentOffset: 15 });
  activityListener!({ ...tool, runId: 'task', sessionId: 'session', revision: 4 });
  resolveSession!({ task, path: '/carbon.md', markdown: 'legacy record', transcript: {
    sessionId: 'session', revision: 2, content: 'Before snapshot', tools: [],
  } });
  await starting;
  assert.equal(agentState().streaming.task, 'Before snapshot suffix');
  assert.equal(agentState().runs.task.length, 1);
  assert.equal(agentState().runs.task[0].contentOffset, 15);
  // Electron can deliver a token represented by the snapshot after the snapshot response.
  contentListener!({ taskId: 'task', content: ' suffix', sessionId: 'session', revision: 3, contentOffset: 15 });
  assert.equal(agentState().streaming.task, 'Before snapshot suffix');
  // A repeated task starts a new session and must not append to its previous run.
  contentListener!({ taskId: 'task', content: 'Second run', sessionId: 'second-session', revision: 1, contentOffset: 0 });
  assert.equal(agentState().streaming.task, 'Second run');
  assert.deepEqual(agentState().runs.task, []);
});
