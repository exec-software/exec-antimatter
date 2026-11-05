import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProviderConfig } from '../src/api/types';
import { AgentModelResolutionError, resolveAgentModel } from '../src/main/agents/modelResolution';
import * as profiles from '../src/main/agents/profiles';
import * as registry from '../src/main/agents/registry';
import * as runner from '../src/main/agents/runner';
import * as tasks from '../src/main/agents/tasks';

const source = (id: string, name: string, models: string[]): ProviderConfig => ({
  id,
  name,
  apiKey: '',
  baseUrl: `http://${id}.invalid/v1`,
  models: models.map((model) => ({ id: model, name: model })),
  supportsStreaming: true,
});

const cpu = source('cpu', 'Local CPU', ['general', 'coder']);
const gpu = source('gpu', 'Local GPU', ['fast', 'coder']);

test('a pinned source and model are both hard constraints', () => {
  assert.deepEqual(resolveAgentModel([cpu, gpu], 'gpu', 'fast', { providerId: 'cpu', model: 'general' }), {
    source: gpu,
    model: 'fast',
  });

  assert.throws(
    () => resolveAgentModel([cpu, gpu], 'gpu', 'general', { providerId: 'cpu', model: 'general' }),
    (error: unknown) =>
      error instanceof AgentModelResolutionError &&
      /Local GPU \[gpu\].*does not advertise model "general"/.test(error.message)
  );
  assert.throws(
    () => resolveAgentModel([cpu, gpu], 'gone', 'general', null),
    /Pinned inference source "gone" is not configured/
  );
});

test('a source-less model resolves only through one exact catalog match', () => {
  assert.deepEqual(resolveAgentModel([cpu, gpu], null, 'general', { providerId: 'gpu', model: 'fast' }), {
    source: cpu,
    model: 'general',
  });
  assert.throws(
    () => resolveAgentModel([cpu, gpu], null, 'missing', { providerId: 'gpu', model: 'fast' }),
    /No connected inference source advertises model "missing"/
  );
  assert.throws(
    () => resolveAgentModel([cpu, gpu], null, 'coder', { providerId: 'gpu', model: 'fast' }),
    /Model "coder" is advertised by multiple inference sources.*Local CPU \[cpu\].*Local GPU \[gpu\].*pin its source/
  );
});

test('only an unpinned agent may fall back, and a stale last-used model is never sent', () => {
  assert.deepEqual(resolveAgentModel([cpu, gpu], null, null, { providerId: 'gpu', model: 'fast' }), {
    source: gpu,
    model: 'fast',
  });
  assert.deepEqual(resolveAgentModel([cpu, gpu], null, null, { providerId: 'gpu', model: 'removed' }), {
    source: cpu,
    model: 'general',
  });
  assert.deepEqual(resolveAgentModel([source('empty', 'Empty', []), gpu], null, null, null), {
    source: gpu,
    model: 'fast',
  });
});

test('an agent run reports a constrained-resolution failure without starting inference', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-agent-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  registry.useRoot(join(root, 'agents'));
  profiles.useRoot(join(root, 'profiles'));
  tasks.useConfigPath(join(root, 'tasks.json'));

  registry.save({
    id: 'legacy',
    name: 'Legacy',
    description: 'test',
    tags: [],
    provider: null,
    model: 'shared',
    tools: [],
    maxRounds: 1,
    access: 'read',
    prompt: 'Test.',
  });
  const task = tasks.add({ agentId: 'legacy', title: 'Resolve', prompt: 'Run.', startNow: true });
  let runtimeStarted = false;
  let delivered = '';
  runner.configure({
    resolveProvider: () => {
      throw new AgentModelResolutionError('Model "shared" is ambiguous; pin its source.');
    },
    defaultWorkspace: () => root,
    defaultWorkspaceConfirmed: () => true,
    onActivity: () => undefined,
    onContent: () => undefined,
    onChange: () => undefined,
    onResult: (_task, result) => {
      delivered = result.ending ?? '';
    },
    createRuntime: async () => {
      runtimeStarted = true;
      throw new Error('must not start');
    },
  });

  const result = await runner.runNow(task);
  assert.equal(result.ending, 'Model "shared" is ambiguous; pin its source.');
  assert.equal(delivered, result.ending);
  assert.equal(tasks.find(task.id)?.error, result.ending);
  assert.equal(tasks.find(task.id)?.state, 'failed');
  assert.equal(runtimeStarted, false);
});
