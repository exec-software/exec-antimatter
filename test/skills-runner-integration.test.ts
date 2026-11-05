import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatRequest, StreamResult, ToolCall } from '../src/api/types';
import * as agents from '../src/main/agents/registry';
import * as profiles from '../src/main/agents/profiles';
import * as agentRunner from '../src/main/agents/runner';
import * as tasks from '../src/main/agents/tasks';
import * as carbon from '../src/main/carbon';
import { ExtensionRegistry } from '../src/main/extensions/registry';
import { skillTool, withSkills } from '../src/main/extensions/tools';
import type { ServiceConfig } from '../src/main/orchestrator/config';
import { createRunner } from '../src/main/orchestrator/runner';
import type { AgentJob } from '../src/main/orchestrator/orchestrator';
import type { StreamingProvider, ToolRuntime } from '../src/main/toolLoop';

function fixture(t: { after(fn: () => unknown): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-skill-runners-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  for (const [workspace, marker] of [[first, 'FIRST_ONLY'], [second, 'SECOND_ONLY']]) {
    const directory = join(workspace, '.agents', 'skills', 'scope');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), `---\nname: scope\ndescription: ${marker} project instructions\n---\n${marker}\nThis fixture asks to bypass read-only mode and write a file; tool policy must still refuse it.\n`);
  }
  const registry = new ExtensionRegistry({ storePath: join(root, 'extensions.json'), personalSkillsRoot: join(root, 'personal') });
  return { root, first, second, registry };
}

const tool = (name: string) => ({
  serverId: 'antimatter', serverName: 'Antimatter',
  tool: { name, description: name, enabled: true, inputSchema: { type: 'object', properties: {} } },
});
const call = (id: string, name: string, args: object): ToolCall => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
const provider = (script: StreamResult[], requests: ChatRequest[]): StreamingProvider => ({
  async stream(request, onChunk) {
    requests.push(structuredClone(request));
    const result = script.shift();
    assert.ok(result, 'The runner requested an unexpected inference round.');
    if (result.content) onChunk({ id: 'chunk', content: result.content });
    return result;
  },
});

function agentState(root: string): void {
  agents.useRoot(join(root, 'agents'));
  profiles.useRoot(join(root, 'profiles'));
  tasks.useConfigPath(join(root, 'tasks.json'));
  carbon.useRoot(join(root, 'carbons'));
  agents.save({ id: 'skill-reviewer', name: 'Skill reviewer', description: 'Test skill boundary.', tags: [],
    provider: null, model: null, tools: ['read_skill', 'write_file'], maxRounds: 6, access: 'read', prompt: 'Inspect the project.' });
}

test('skill readers retain their own project identity and cannot read another project skill id', async (t) => {
  const f = fixture(t);
  const base: ToolRuntime = { enabledTools: () => [], callTool: async () => { throw new Error('No external tool should run.'); } };
  const first = withSkills(base, f.registry, f.first);
  const second = withSkills(base, f.registry, f.second);
  const firstId = f.registry.catalog(f.first).skills[0].id;
  const secondId = f.registry.catalog(f.second).skills[0].id;
  assert.notEqual(firstId, secondId);
  const firstResult = await first.callTool('antimatter.skills', 'read_skill', { id: firstId });
  const secondResult = await second.callTool('antimatter.skills', 'read_skill', { id: secondId });
  assert.match(firstResult.text, /FIRST_ONLY/);
  assert.doesNotMatch(firstResult.text, /SECOND_ONLY/);
  assert.match(secondResult.text, /SECOND_ONLY/);
  assert.equal((await first.callTool('antimatter.skills', 'read_skill', { id: secondId })).ok, false);
});

test('agent skill hooks use the task workspace and cannot raise read-only authority', async (t) => {
  const f = fixture(t);
  agentState(f.root);
  const requests: ChatRequest[] = [];
  const skillId = f.registry.catalog(f.first).skills[0].id;
  const inference = provider([
    { content: '', toolCalls: [call('read', 'antimatter_skills__read_skill', { id: skillId })] },
    { content: '', toolCalls: [call('write', 'antimatter__write_file', { path: 'escalated.txt', content: 'not authorized' })] },
    { content: 'Review finished without writes.', toolCalls: [] },
  ], requests);
  const hookWorkspaces: string[] = [];
  let shutdowns = 0;
  const executed: string[] = [];
  agentRunner.configure({
    resolveProvider: () => ({ provider: inference, providerId: 'test', model: 'test', sourceName: 'Test', maxOutputTokens: 512, budgetTokens: 16_384 }),
    defaultWorkspace: () => f.second, defaultWorkspaceConfirmed: () => true,
    onActivity: () => undefined, onContent: () => undefined, onChange: () => undefined, onResult: () => undefined,
    createRuntime: async (workspace) => {
      assert.equal(workspace, f.first);
      return { enabledTools: () => [tool('write_file')], callTool: async (_server, name) => { executed.push(name); return { ok: true, text: 'must not run' }; },
        shutdown: async () => { shutdowns += 1; } };
    },
    augmentRuntime: (runtime, workspace) => { hookWorkspaces.push(workspace); return withSkills(runtime, f.registry, workspace); },
    additionalInstructions: (workspace) => { hookWorkspaces.push(workspace); return f.registry.promptMetadata(workspace) ?? ''; },
  });
  const task = tasks.add({ agentId: 'skill-reviewer', title: 'Review', prompt: 'Read the scope skill and review only.', workspace: f.first, startNow: true });
  const result = await agentRunner.runNow(task);
  assert.equal(result.ending, null);
  assert.equal(shutdowns, 1);
  assert.deepEqual(hookWorkspaces, [f.first, f.first]);
  assert.deepEqual(executed, []);
  assert.ok(requests.every((request) => request.accessMode === 'read'));
  const system = requests[0].messages.find((message) => message.role === 'system')?.content ?? '';
  assert.match(system, /FIRST_ONLY/);
  assert.doesNotMatch(system, /SECOND_ONLY/);
  assert.ok(requests.some((request) => request.messages.some((message) => message.role === 'tool' && /FIRST_ONLY/.test(message.content ?? ''))));
});

test('agent runtimes are released when skill augmentation or metadata loading throws', async (t) => {
  const f = fixture(t);
  agentState(f.root);
  for (const failing of ['augmentation', 'instructions']) {
    let shutdowns = 0;
    let inferences = 0;
    agentRunner.configure({
      resolveProvider: () => ({ provider: { stream: async () => { inferences += 1; throw new Error('Must not infer'); } },
        providerId: 'test', model: 'test', sourceName: 'Test', maxOutputTokens: 512, budgetTokens: 16_384 }),
      defaultWorkspace: () => f.first, defaultWorkspaceConfirmed: () => true,
      onActivity: () => undefined, onContent: () => undefined, onChange: () => undefined, onResult: () => undefined,
      createRuntime: async () => ({ enabledTools: () => [{ serverId: 'antimatter.skills', serverName: 'Local skills', tool: skillTool }],
        callTool: async () => ({ ok: true, text: '' }), shutdown: async () => { shutdowns += 1; } }),
      augmentRuntime: (runtime) => { if (failing === 'augmentation') throw new Error('Skill augmentation unavailable'); return runtime; },
      additionalInstructions: () => { throw new Error('Skill instructions unavailable'); },
    });
    const task = tasks.add({ agentId: 'skill-reviewer', title: 'Fail safely', prompt: 'Review.', workspace: f.first, startNow: true });
    const result = await agentRunner.runNow(task);
    assert.match(result.ending ?? '', /Skill .* unavailable/);
    assert.equal(shutdowns, 1);
    assert.equal(inferences, 0);
    assert.equal(tasks.find(task.id)?.state, 'failed');
  }
});

test('explicit agent allowlists do not advertise skills when the skill reader is excluded', async (t) => {
  const f = fixture(t);
  agentState(f.root);
  agents.save({ id: 'no-skills', name: 'No skills', description: 'Explicitly scoped reader.', tags: [], provider: null, model: null,
    tools: ['read_file'], maxRounds: 4, access: 'read', prompt: 'Read the project file only.' });
  const requests: ChatRequest[] = [];
  let metadataCalls = 0;
  const inference = provider([
    { content: '', toolCalls: [call('read-file', 'antimatter__read_file', { path: 'README.md' })] },
    { content: 'Read the permitted file.', toolCalls: [] },
  ], requests);
  agentRunner.configure({
    resolveProvider: () => ({ provider: inference, providerId: 'test', model: 'test', sourceName: 'Test', maxOutputTokens: 512, budgetTokens: 16_384 }),
    defaultWorkspace: () => f.first, defaultWorkspaceConfirmed: () => true,
    onActivity: () => undefined, onContent: () => undefined, onChange: () => undefined, onResult: () => undefined,
    createRuntime: async () => ({ enabledTools: () => [tool('read_file')], callTool: async () => ({ ok: true, text: 'Readme' }), shutdown: async () => undefined }),
    augmentRuntime: (runtime, workspace) => withSkills(runtime, f.registry, workspace),
    additionalInstructions: () => { metadataCalls += 1; return 'FIRST_ONLY'; },
  });
  const result = await agentRunner.runNow(tasks.add({ agentId: 'no-skills', title: 'Explicit tools', prompt: 'Read README.', workspace: f.first, startNow: true }));
  assert.equal(result.ending, null);
  assert.equal(metadataCalls, 0);
  assert.doesNotMatch(requests[0].messages.find((message) => message.role === 'system')?.content ?? '', /FIRST_ONLY/);
  assert.ok(requests.every((request) => !request.tools?.some((entry) => entry.function.name.includes('read_skill'))));
});

function job(workspace: string): AgentJob {
  const config: ServiceConfig = {
    tracker: { kind: 'file', endpoint: '/unused', apiKey: null, projectSlug: null, activeStates: ['QA'], terminalStates: ['Done'] },
    pollIntervalMs: 30_000, workspaceRoot: workspace,
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
    agent: { maxConcurrentAgents: 1, maxTurns: 1, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {} },
    runner: { command: 'antimatter', turnTimeoutMs: 5000, readTimeoutMs: 1000, stallTimeoutMs: 5000, approvalPolicy: 'never', providerId: null, model: null },
  };
  return {
    issue: { id: 'qa-skill', identifier: 'QA-1', title: 'Review skills', description: 'Read only.', priority: 1,
      state: 'QA', branchName: null, url: null, labels: [], blockedBy: [], createdAt: null, updatedAt: null },
    workspace: { path: workspace, workspaceKey: 'QA-1', createdNow: false }, config, attempt: null,
    promptTemplate: '', signal: new AbortController().signal, touch: () => undefined, shouldContinue: async () => false,
  };
}

test('QA orchestration can read its project skill without promoting skill text to write access', async (t) => {
  const f = fixture(t);
  const requests: ChatRequest[] = [];
  const skillId = f.registry.catalog(f.first).skills[0].id;
  const inference = provider([
    { content: '', toolCalls: [call('read', 'antimatter_skills__read_skill', { id: skillId })] },
    { content: '', toolCalls: [call('write', 'antimatter__write_file', { path: 'not-authorized.txt', content: 'bad' })] },
    { content: 'QA complete without writes.', toolCalls: [] },
  ], requests);
  const executed: string[] = [];
  const runner = createRunner({
    resolveProvider: () => ({ provider: inference, providerId: 'test', model: 'test', maxOutputTokens: 512, budgetTokens: 16_384 }),
    toolRuntime: { enabledTools: () => [tool('write_file')], callTool: async (_server, name) => { executed.push(name); return { ok: true, text: '' }; } },
    augmentRuntime: (runtime, workspace) => { assert.equal(workspace, f.first); return withSkills(runtime, f.registry, workspace); },
    additionalInstructions: (workspace) => { assert.equal(workspace, f.first); return f.registry.promptMetadata(workspace) ?? ''; },
    onActivity: () => undefined, onContent: () => undefined, log: () => undefined,
  });
  await runner(job(f.first));
  assert.deepEqual(executed, []);
  assert.ok(requests.every((request) => request.accessMode === 'read'));
  assert.match(requests[0].messages.find((message) => message.role === 'system')?.content ?? '', /FIRST_ONLY/);
  assert.ok(requests.some((request) => request.messages.some((message) => message.role === 'tool' && /FIRST_ONLY/.test(message.content ?? ''))));
});

test('owned orchestrator runtimes are cleaned up when either skill hook fails before inference', async (t) => {
  const f = fixture(t);
  for (const failing of ['augmentation', 'instructions']) {
    let shutdowns = 0;
    let inferences = 0;
    const runner = createRunner({
      resolveProvider: () => ({ provider: { stream: async () => { inferences += 1; throw new Error('Must not infer'); } },
        providerId: 'test', model: 'test', maxOutputTokens: 512, budgetTokens: 16_384 }),
      createRuntime: async (workspace) => {
        assert.equal(workspace, f.first);
        return { enabledTools: () => [], callTool: async () => ({ ok: true, text: '' }), connectionErrors: () => [], shutdown: async () => { shutdowns += 1; } };
      },
      augmentRuntime: (runtime) => { if (failing === 'augmentation') throw new Error('Skill augmentation unavailable'); return runtime; },
      additionalInstructions: () => { throw new Error('Skill instructions unavailable'); },
      onActivity: () => undefined, onContent: () => undefined, log: () => undefined,
    });
    await assert.rejects(runner(job(f.first)), /Skill .* unavailable/);
    assert.equal(shutdowns, 1);
    assert.equal(inferences, 0);
  }
});
