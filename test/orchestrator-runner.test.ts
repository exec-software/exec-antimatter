import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatRequest, Message, StreamResult } from '../src/api/types';
import type { ServiceConfig } from '../src/main/orchestrator/config';
import { createRunner } from '../src/main/orchestrator/runner';
import type { Issue } from '../src/main/orchestrator/types';
import type { StreamingProvider, ToolRuntime } from '../src/main/toolLoop';

const issue: Issue = {
  id: 'issue-1',
  identifier: 'AM-1',
  title: 'Keep context',
  description: 'Use the same transcript.',
  priority: 1,
  state: 'Todo',
  branchName: null,
  url: null,
  labels: ['test'],
  blockedBy: [{ id: 'blocker-1', identifier: 'AM-0', state: 'Done' }],
  createdAt: null,
  updatedAt: null,
};

const config: ServiceConfig = {
  tracker: {
    kind: 'file', endpoint: '/tmp/issues', apiKey: null, projectSlug: null,
    activeStates: ['Todo'], terminalStates: ['Done'],
  },
  pollIntervalMs: 30_000,
  workspaceRoot: '/tmp',
  hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1_000 },
  agent: { maxConcurrentAgents: 1, maxTurns: 2, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {} },
  runner: {
    command: 'antimatter', turnTimeoutMs: 5_000, readTimeoutMs: 1_000, stallTimeoutMs: 5_000,
    approvalPolicy: 'never', providerId: null, model: null,
  },
};

test('runs continuation turns on the same expanded transcript and renders retry metadata', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-runner-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const requests: ChatRequest[] = [];
  const script: StreamResult[] = [
    {
      content: '',
      toolCalls: [{
        id: 'call-1', type: 'function',
        function: { name: 'antimatter__read_file', arguments: '{"path":"one"}' },
      }],
    },
    { content: 'First turn complete.', toolCalls: [] },
    {
      content: '',
      toolCalls: [{
        id: 'call-2', type: 'function',
        function: { name: 'antimatter__read_file', arguments: '{"path":"two"}' },
      }],
    },
    { content: 'Second turn complete.', toolCalls: [] },
  ];
  const provider: StreamingProvider = {
    async stream(request, callback) {
      requests.push(request);
      const result = script.shift();
      if (!result) throw new Error('provider script exhausted');
      if (result.content) callback({ id: 'chunk', content: result.content });
      return result;
    },
  };
  const toolRuntime: ToolRuntime = {
    enabledTools: () => [{
      serverId: 'antimatter', serverName: 'Antimatter tools',
      tool: {
        name: 'read_file', description: 'Read.', enabled: true,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }],
    async callTool(_server, _name, args) {
      return { ok: true, text: `contents:${args.path}` };
    },
  };
  const endings: string[] = [];
  let checks = 0;
  const runner = createRunner({
    toolRuntime,
    resolveProvider: () => ({
      provider,
      providerId: 'test',
      model: 'test',
      maxOutputTokens: 512,
      budgetTokens: 4_096,
    }),
    onActivity: () => undefined,
    onContent: () => undefined,
    onTurnEnd: (_issue, result) => endings.push(result.content),
    log: () => undefined,
  });

  await runner({
    issue,
    workspace: { path: workspace, workspaceKey: 'AM-1', createdNow: false },
    attempt: 2,
    config,
    promptTemplate: 'Attempt={{ attempt }} blocker={{ issue.blockedBy | json }}',
    signal: new AbortController().signal,
    touch: () => undefined,
    shouldContinue: async () => {
      checks += 1;
      return true;
    },
  });

  const opening = requests[0].messages.find((message) => message.role === 'user')?.content ?? '';
  assert.match(opening, /Attempt=2/);
  assert.match(opening, /"identifier":"AM-0"/);
  const continued = requests[2].messages;
  assert.ok(continued.some((message) => message.role === 'tool' && message.content === 'contents:one'));
  assert.ok(continued.some((message) => message.role === 'user' && /same session/.test(message.content)));
  assert.equal(continued.filter((message) => message.role === 'system').length, 1);
  assert.deepEqual(endings, ['First turn complete.', 'Second turn complete.']);
  assert.equal(checks, 2);
});

test('an unattended run never approves a command that reaches past its workspace', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-runner-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const command = (id: string, line: string) => ({
    id,
    type: 'function' as const,
    function: { name: 'antimatter__run_command', arguments: JSON.stringify({ command: line }) },
  });
  const script: StreamResult[] = [
    { content: '', toolCalls: [command('c1', 'pip3 install --break-system-packages pillow')] },
    { content: '', toolCalls: [command('c2', 'python3 -m venv .venv')] },
    { content: 'Done.', toolCalls: [] },
  ];
  const told: string[] = [];
  const provider: StreamingProvider = {
    async stream(request) {
      const last = request.messages[request.messages.length - 1];
      if (last.role === 'tool') told.push(last.content ?? '');
      return script.shift()!;
    },
  };
  const ran: string[] = [];
  const toolRuntime: ToolRuntime = {
    enabledTools: () => [{
      serverId: 'antimatter', serverName: 'Antimatter tools',
      tool: { name: 'run_command', description: 'Run.', enabled: true, inputSchema: { type: 'object', properties: {} } },
    }],
    async callTool(_server, _name, args) {
      ran.push(String(args.command));
      return { ok: true, text: 'exit 0' };
    },
  };
  const logs: string[] = [];
  const runner = createRunner({
    toolRuntime,
    resolveProvider: () => ({ provider, providerId: 'test', model: 'test', maxOutputTokens: 512, budgetTokens: 4_096 }),
    onActivity: () => undefined,
    onContent: () => undefined,
    log: (entry) => logs.push(entry.message),
  });

  // approvalPolicy "never" is full access.
  await runner({
    issue,
    workspace: { path: workspace, workspaceKey: 'AM-1', createdNow: false },
    attempt: null,
    config: { ...config, agent: { ...config.agent, maxTurns: 1 } },
    promptTemplate: 'Fix it.',
    signal: new AbortController().signal,
    touch: () => undefined,
    shouldContinue: async () => false,
  });

  assert.deepEqual(ran, ['python3 -m venv .venv']);
  assert.ok(logs.some((line) => /^approval_refused run_command \(danger\): pip's --break-system-packages/.test(line)), logs.join('\n'));
  assert.match(told[0], /^run_command was declined, so nothing ran\. It was put to the user because it reaches past the project/);
});

test('a QA stage is read-only in both access mode and the offered toolset', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-runner-qa-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const qaIssue: Issue = { ...issue, state: 'QA', labels: [...issue.labels, 'stage:qa'] };
  const requests: ChatRequest[] = [];
  const script: StreamResult[] = [
    {
      content: '',
      toolCalls: [{
        id: 'read-1', type: 'function',
        function: { name: 'antimatter__read_file', arguments: '{"path":"changed.ts"}' },
      }],
    },
    { content: 'The change is correct.\n\nQA: PASS', toolCalls: [] },
  ];
  const provider: StreamingProvider = {
    async stream(request) {
      requests.push(request);
      return script.shift()!;
    },
  };
  const called: string[] = [];
  const tool = (name: string, serverId = 'antimatter') => ({
    serverId, serverName: serverId === 'antimatter' ? 'Antimatter tools' : 'Untrusted collision',
    tool: { name, description: name, enabled: true, inputSchema: { type: 'object', properties: {} } },
  });
  const toolRuntime: ToolRuntime = {
    enabledTools: () => [tool('read_file'), tool('write_file'), tool('run_command'), tool('read_file', 'untrusted.plugin')],
    async callTool(_server, name) {
      called.push(name);
      return { ok: true, text: 'source' };
    },
  };
  const checkpoints: Message[][] = [];
  const endings: Array<{ accessMode: string; messages: Message[]; rounds: number; toolCalls: number; reason: string }> = [];
  const runner = createRunner({
    toolRuntime,
    resolveProvider: () => ({ provider, providerId: 'qa-source', model: 'qa-model', maxOutputTokens: 512, budgetTokens: 4_096 }),
    onActivity: () => undefined,
    onContent: () => undefined,
    onTranscript: (_issue, snapshot) => checkpoints.push(snapshot.messages),
    onTurnEnd: (_issue, result) => endings.push(result),
    log: () => undefined,
  });

  await runner({
    issue: qaIssue,
    workspace: { path: workspace, workspaceKey: 'AM-1', createdNow: false },
    attempt: null,
    config: { ...config, agent: { ...config.agent, maxTurns: 1 } },
    promptTemplate: 'Review it.',
    signal: new AbortController().signal,
    touch: () => undefined,
    shouldContinue: async () => false,
  });

  assert.equal(requests[0].accessMode, 'read');
  assert.deepEqual(requests[0].tools?.map((entry) => entry.function.name), ['antimatter__read_file']);
  assert.deepEqual(called, ['read_file']);
  assert.ok(checkpoints.some((messages) => messages.some((message) => message.role === 'tool' && message.content === 'source')));
  assert.equal(endings.length, 1);
  assert.equal(endings[0].accessMode, 'read');
  assert.equal(endings[0].rounds, 2);
  assert.equal(endings[0].toolCalls, 1);
  assert.equal(endings[0].reason, 'finished');
  assert.ok(endings[0].messages.some((message) => message.role === 'tool' && message.content === 'source'));
});

test('a cancelled turn still emits its final audit snapshot', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-runner-cancel-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const controller = new AbortController();
  const provider: StreamingProvider = {
    async stream(_request, _callback, _onAlive, signal) {
      return await new Promise<StreamResult>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
        controller.abort();
      });
    },
  };
  const endings: Array<{ cancelled: boolean; ok: boolean; error?: string }> = [];
  const runner = createRunner({
    toolRuntime: {
      enabledTools: () => [{
        serverId: 'antimatter',
        serverName: 'Antimatter tools',
        tool: {
          name: 'read_file',
          description: 'Read.',
          enabled: true,
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      }],
      callTool: async () => ({ ok: true, text: '' }),
    },
    resolveProvider: () => ({
      provider,
      providerId: 'test',
      model: 'test',
      maxOutputTokens: 512,
      budgetTokens: 4_096,
    }),
    onActivity: () => undefined,
    onContent: () => undefined,
    onTurnEnd: (_issue, result) => endings.push(result),
    log: () => undefined,
  });

  await assert.rejects(
    runner({
      issue,
      workspace: { path: workspace, workspaceKey: 'AM-1', createdNow: false },
      attempt: null,
      config: { ...config, agent: { ...config.agent, maxTurns: 1 } },
      promptTemplate: 'Fix it.',
      signal: controller.signal,
      touch: () => undefined,
      shouldContinue: async () => false,
    }),
    /orchestrator cancelled turn/
  );

  assert.equal(endings.length, 1);
  assert.equal(endings[0].cancelled, true);
  assert.equal(endings[0].ok, false);
  assert.match(endings[0].error ?? '', /orchestrator cancelled turn/);
});

test('a stall abort is audited as a failure so it spends the retry ceiling', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-runner-stall-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const controller = new AbortController();
  const provider: StreamingProvider = {
    async stream(_request, _callback, _onAlive, signal) {
      return await new Promise<StreamResult>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
        controller.abort('stalled');
      });
    },
  };
  const endings: Array<{ cancelled: boolean; ok: boolean; error?: string }> = [];
  const runner = createRunner({
    toolRuntime: {
      enabledTools: () => [{
        serverId: 'antimatter',
        serverName: 'Antimatter tools',
        tool: {
          name: 'read_file',
          description: 'Read.',
          enabled: true,
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      }],
      callTool: async () => ({ ok: true, text: '' }),
    },
    resolveProvider: () => ({
      provider,
      providerId: 'test',
      model: 'test',
      maxOutputTokens: 512,
      budgetTokens: 4_096,
    }),
    onActivity: () => undefined,
    onContent: () => undefined,
    onTurnEnd: (_issue, result) => endings.push(result),
    log: () => undefined,
  });

  await assert.rejects(
    runner({
      issue,
      workspace: { path: workspace, workspaceKey: 'AM-1', createdNow: false },
      attempt: null,
      config: { ...config, agent: { ...config.agent, maxTurns: 1 } },
      promptTemplate: 'Fix it.',
      signal: controller.signal,
      touch: () => undefined,
      shouldContinue: async () => false,
    }),
    /stall timeout/
  );

  assert.equal(endings.length, 1);
  assert.equal(endings[0].cancelled, false);
  assert.equal(endings[0].ok, false);
  assert.match(endings[0].error ?? '', /stall timeout/);
});
