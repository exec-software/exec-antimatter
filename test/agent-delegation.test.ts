import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AccessMode, ChatRequest, Message, StreamResult, ToolCall } from '../src/api/types';
import * as delegation from '../src/main/agents/delegation';
import * as profiles from '../src/main/agents/profiles';
import * as registry from '../src/main/agents/registry';
import * as runner from '../src/main/agents/runner';
import * as tasks from '../src/main/agents/tasks';
import * as carbon from '../src/main/carbon';
import * as transcripts from '../src/main/agents/transcripts';
import { LiveAccess } from '../src/main/liveAccess';
import { isTrustedTool, tierOf } from '../src/main/toolPolicy';
import {
  runToolLoop,
  type Steering,
  type StreamingProvider,
  type ToolActivity,
  type ToolRuntime,
} from '../src/main/toolLoop';

const tool = (name: string) => ({
  serverId: 'antimatter',
  serverName: 'Antimatter tools',
  tool: { name, description: name, inputSchema: { type: 'object', properties: {} }, enabled: true },
});

const call = (id: string, name: string, args: Record<string, unknown>, server = 'antimatter'): ToolCall => ({
  id,
  type: 'function',
  function: { name: `${server}__${name}`, arguments: JSON.stringify(args) },
});

const agentCall = (id: string, name: string, args: Record<string, unknown>) =>
  call(id, name, args, delegation.SERVER_ID.replace(/[^a-zA-Z0-9_-]/g, '_'));

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until the condition holds, for state that changes on another tick. */
async function until(condition: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(5);
  }
}

interface Setup {
  workspace: string;
  /** What the subagents' own tools were asked to do. */
  ran: string[];
  /** What the subagents' model was sent, request by request. */
  requests: ChatRequest[];
  choices: Array<[string | null, string | null]>;
  /** Lets every subagent that is holding on the gate finish. */
  release(): void;
}

const briefOf = (request: ChatRequest) => request.messages.find((message) => message.role === 'user')?.content ?? '';

/**
 * A world with the starter agents, a subagent model that follows a script, and tools that only
 * record what they were asked. Nothing touches the real home directory or an MCP server.
 */
function world(
  t: { after(fn: () => unknown): void },
  script: (request: ChatRequest, signal: AbortSignal | undefined, gate: Promise<void>) => Promise<StreamResult>,
  perceives?: (model: string) => boolean
): Setup {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-delegation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  registry.useRoot(join(root, 'agents'));
  registry.ensureSeeded();
  profiles.useRoot(join(root, 'profiles'));
  tasks.useConfigPath(join(root, 'tasks.json'));
  carbon.useRoot(join(root, 'carbons'));

  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const setup: Setup = { workspace: join(root, 'work'), ran: [], requests: [], choices: [], release: () => open() };
  const provider: StreamingProvider = {
    async stream(request, callback, _alive, signal) {
      setup.requests.push(request);
      const result = await script(request, signal, gate);
      if (result.content) callback({ id: 'chunk', content: result.content });
      return result;
    },
  };
  runner.configure({
    resolveProvider: (source, model) => {
      setup.choices.push([source, model]);
      return { provider, providerId: 'sub', model: 'sub-model', maxOutputTokens: 1000, budgetTokens: 100_000, sourceName: 'Sub' };
    },
    perceives,
    defaultWorkspace: () => setup.workspace,
    defaultWorkspaceConfirmed: () => true,
    onActivity: () => undefined,
    onContent: () => undefined,
    onChange: () => undefined,
    onResult: () => undefined,
    createRuntime: async () => ({
      enabledTools: () => [tool('read_file'), tool('write_file'), tool('run_command')],
      async callTool(_server, name, args) {
        setup.ran.push(`${name} ${JSON.stringify(args)}`);
        return { ok: true, text: `${name} ok` };
      },
      shutdown: async () => undefined,
    }),
  });
  return setup;
}

/** The subagent does one thing and then reports. */
const oneStep = (request: ChatRequest, step: ToolCall, report: string): StreamResult =>
  request.messages.some((message) => message.role === 'tool')
    ? { content: report, toolCalls: [] }
    : { content: '', toolCalls: [step] };

const writesThenReports = async (request: ChatRequest): Promise<StreamResult> =>
  oneStep(request, call('w1', 'write_file', { path: 'notes.md', content: 'hi' }), 'Wrote notes.md.');

/** Holds its answer until the test opens the gate, or gives up when its run is stopped. */
const heldUntilReleased = (report: string) =>
  async (request: ChatRequest, signal: AbortSignal | undefined, gate: Promise<void>): Promise<StreamResult> => {
    if (!request.messages.some((message) => message.role === 'tool')) {
      return { content: '', toolCalls: [call('r1', 'read_file', { path: 'src/main/toolPolicy.ts' })] };
    }
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('the turn was stopped'));
      signal?.addEventListener('abort', () => reject(new Error('the turn was stopped')), { once: true });
      void gate.then(resolve);
    });
    return { content: report, toolCalls: [] };
  };

/** The chat side: whatever the conversation would do with approvals and transcript events. */
function conversation(setup: Setup, mode: AccessMode, approve = true, overrides: Partial<delegation.DelegationContext> = {}) {
  const asked: ToolActivity[] = [];
  const reported: ToolActivity[] = [];
  const chatCalls: string[] = [];
  const context: delegation.DelegationContext = {
    messageId: 'reply-1',
    threadId: 'thread-1',
    workspace: setup.workspace,
    workspaceConfirmed: true,
    mode,
    requestApproval: async (activity) => {
      asked.push(activity);
      return approve;
    },
    report: (activity) => reported.push(activity),
    ...overrides,
  };
  const chatTools: ToolRuntime = {
    enabledTools: () => [tool('read_file'), tool('write_file')],
    callTool: async (_server, name, args) => {
      chatCalls.push(`${name} ${JSON.stringify(args)}`);
      return { ok: true, text: `${name} ok` };
    },
  };
  return { asked, reported, chatCalls, agents: delegation.withAgents(chatTools, context) };
}

const starting = (args: Record<string, unknown>, callId = 'c1'): ToolActivity => ({
  runId: 'reply-1',
  callId,
  activityId: `0:0:${callId}`,
  serverId: delegation.SERVER_ID,
  serverName: delegation.SERVER_NAME,
  toolName: delegation.START_AGENT,
  tier: 'read',
  args: JSON.stringify(args),
  status: 'running',
});

/** Resolves when the next agent the turn started has finished. */
const nextSettle = (agents: delegation.Delegation) =>
  new Promise<void>((resolve) => {
    const off = agents.background.onSettle(() => {
      off();
      resolve();
    });
  });

test('the agent wrapper preserves an underlying runtime preparation boundary', async () => {
  const marker = { secret: 'runtime-only' };
  let prepared = 0;
  const base: ToolRuntime = {
    enabledTools: () => [],
    prepareTool: async (_server, _name, args) => {
      prepared += 1;
      return { args: { ...args, public_fact: 'shown' }, prepared: marker };
    },
    callTool: async () => ({ ok: true, text: 'ok' }),
  };
  const wrapped = delegation.withAgents(base, {
    messageId: 'message',
    threadId: 'thread',
    workspace: '/workspace',
    workspaceConfirmed: true,
    mode: 'full',
    requestApproval: async () => false,
    report: () => undefined,
  });

  assert.deepEqual(await wrapped.runtime.prepareTool?.('antimatter', 'read_file', { path: 'a.txt' }), {
    args: { path: 'a.txt', public_fact: 'shown' },
    prepared: marker,
  });
  assert.deepEqual(await wrapped.runtime.prepareTool?.(delegation.SERVER_ID, delegation.START_AGENT, { task: 'x' }), {
    args: { task: 'x' },
  });
  assert.equal(prepared, 1, 'agent-owned tools do not pass through the wrapped runtime preflight');
});

const start = (agents: delegation.Delegation, args: Record<string, unknown>, options: { signal?: AbortSignal; callId?: string } = {}) =>
  agents.runtime.callTool(delegation.SERVER_ID, delegation.START_AGENT, args, {
    signal: options.signal,
    activity: starting(args, options.callId),
  });

const report = /^Antimatter: an agent you started has finished\. This message is from the app, not from the user\.\n\n/;

test('the conversation is offered start_agent and wait_for_agents, listing the agents it can reach', (t) => {
  const setup = world(t, writesThenReports);
  const { agents } = conversation(setup, 'full');
  const offered = agents.runtime.enabledTools();
  const names = offered.map((candidate) => candidate.tool.name);
  assert.deepEqual(names, ['read_file', 'write_file', 'start_agent', 'wait_for_agents', 'send_agent_message', 'stop_agent']);

  const entry = offered.find((candidate) => candidate.tool.name === 'start_agent')!;
  assert.equal(entry.serverId, delegation.SERVER_ID);
  const schema = entry.tool.inputSchema as { properties: { agent: { enum: string[] } }; required: string[] };
  assert.ok(schema.properties.agent.enum.includes('test-writer'));
  assert.deepEqual(schema.required, ['agent', 'task']);
  assert.match(entry.tool.description, /returns at once/);
  assert.match(entry.tool.description, /- shell-runner: .*\(tools: run_command, read_file, list_directory; 8 rounds\)/);

  const wait = offered.find((candidate) => candidate.tool.name === 'wait_for_agents')!;
  assert.equal((wait.tool.inputSchema as { required?: string[] }).required, undefined);
});

test('with no agents installed there is nothing to offer', (t) => {
  const setup = world(t, writesThenReports);
  for (const agent of registry.list()) registry.remove(agent.id);
  const { agents } = conversation(setup, 'full');
  assert.deepEqual(agents.runtime.enabledTools().map((entry) => entry.tool.name), ['read_file', 'write_file']);
});

test('start_agent returns at once, and the agent works on after it', async (t) => {
  const setup = world(t, writesThenReports);
  const chat = conversation(setup, 'full');
  const args = { agent: 'test-writer', task: 'Write notes.md saying hi.', title: 'Write the notes' };
  const settled = nextSettle(chat.agents);

  const result = await start(chat.agents, args);

  const [task] = tasks.list();
  assert.equal(result.ok, true);
  assert.equal(
    result.text,
    `Started Test writer on "Write the notes" as task ${task.id.slice(0, 8)}. It is working now, so carry on with your own part. ` +
      'Its report will be given to you when it finishes.'
  );
  // The call came back before any of the run happened.
  assert.equal(setup.requests.length, 0);
  assert.equal(task.state, 'running');
  assert.equal(task.source, 'chat');
  assert.deepEqual(task.parent, { threadId: 'thread-1', messageId: 'reply-1' });
  assert.equal(task.workspace, setup.workspace);
  assert.equal(chat.agents.background.running(), 1);
  assert.equal(chat.agents.background.ready(), 0);
  // The conversation hears at once which task its call became.
  assert.deepEqual(chat.reported[0].subagent, { taskId: task.id, agentId: 'test-writer', agentName: 'Test writer', title: 'Write the notes' });
  assert.equal(chat.reported[0].activityId, '0:0:c1');

  await settled;
  assert.deepEqual(setup.ran, ['write_file {"path":"notes.md","content":"hi"}']);
  // It saw only the brief it was given, under its own standing prompt, told to stop once it is done.
  assert.match(briefOf(setup.requests[0]), /## Task: Write the notes\n\nWrite notes\.md saying hi\.$/);
  assert.match(briefOf(setup.requests[0]), /at most 12 rounds of tool calls.*Answer as soon as the task is done: a reply with no tool call ends the run, and that reply is your report\./s);
  assert.match(setup.requests[0].messages[0].content ?? '', /Each reply you write holds at most 1000 tokens/);
  assert.equal(tasks.find(task.id)?.state, 'done');
  assert.equal(chat.agents.background.running(), 0);
  assert.equal(chat.agents.background.ready(), 1);

  // The row that started it now carries the report, and says the run is over.
  const final = chat.reported.at(-1)!;
  assert.equal(final.activityId, '0:0:c1');
  assert.equal(final.status, 'done');
  assert.equal(final.subagent?.finished, true);
  assert.match(
    final.result ?? '',
    /^Test writer finished "Write the notes" \(task [0-9a-f]{8}; 2 round\(s\), 1 tool call\(s\)\)\.\n\nWrote notes\.md\.$/
  );
  assert.equal(chat.asked.length, 0, 'full access asks nobody');

  // Given to the model once, between steps, with a mark for the transcript.
  const [delivered] = chat.agents.background.take();
  assert.match(delivered.note, report);
  assert.ok(delivered.note.endsWith(final.result!));
  assert.equal(delivered.activity.toolName, delegation.AGENT_REPORT);
  assert.equal(delivered.activity.activityId, `report:${task.id}`);
  assert.equal(delivered.activity.status, 'done');
  assert.equal(delivered.activity.subagent?.finished, true);
  assert.deepEqual(chat.agents.background.take(), []);
  assert.equal(chat.agents.background.ready(), 0);
});

test('the report is what the agent said last, not every note it wrote on the way', async (t) => {
  const setup = world(t, async (request) =>
    request.messages.some((message) => message.role === 'tool')
      ? { content: 'Two problems: an unchecked path, and a missing tier.', toolCalls: [] }
      : { content: 'Reading the policy first.', toolCalls: [call('r1', 'read_file', { path: 'src/main/toolPolicy.ts' })] }
  );
  const chat = conversation(setup, 'full');
  const settled = nextSettle(chat.agents);
  await start(chat.agents, { agent: 'security-reviewer', task: 'Review toolPolicy.ts.', title: 'Review' });
  await settled;
  const [delivered] = chat.agents.background.take();
  assert.match(delivered.note, /Security reviewer finished "Review" \(task [0-9a-f]{8}; 2 round\(s\), 1 tool call\(s\)\)\.\n\nTwo problems: an unchecked path, and a missing tier\.$/);
  assert.doesNotMatch(delivered.note, /Reading the policy first/);
});

test('under "ask", the agent asks the conversation, and the conversation sees how it went', async (t) => {
  const setup = world(t, writesThenReports);
  const chat = conversation(setup, 'ask');
  const settled = nextSettle(chat.agents);
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.md.' });
  await settled;

  const [task] = tasks.list();
  assert.equal(chat.asked.length, 1);
  const question = chat.asked[0];
  assert.equal(question.toolName, 'write_file');
  assert.equal(question.awaitingApproval, true);
  assert.equal(question.serverName, 'Test writer · Antimatter tools');
  // Occurrence ids repeat across runs, so the conversation gets one that cannot collide.
  assert.equal(question.activityId, `${task.id}:0:0:w1`);
  assert.ok(question.approvalId?.startsWith(`${task.id}:`));

  const settledCall = chat.reported.filter((activity) => activity.activityId === question.activityId);
  assert.deepEqual(settledCall.map((activity) => activity.status), ['running', 'done']);
  assert.deepEqual(setup.ran, ['write_file {"path":"notes.md","content":"hi"}']);
  // Its other calls stay in its own transcript: the conversation heard only of the start, the
  // approved call, and the end.
  assert.equal(chat.reported.length, 4);
});

test('a refusal in the conversation is a refusal for the agent', async (t) => {
  const setup = world(t, writesThenReports);
  const chat = conversation(setup, 'ask', false);
  const settled = nextSettle(chat.agents);
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.md.' });
  await settled;
  assert.equal(chat.asked.length, 1);
  assert.deepEqual(setup.ran, []);
  const question = chat.reported.filter((activity) => activity.activityId === chat.asked[0].activityId);
  assert.equal(question.at(-1)?.status, 'denied');
});

test('a read-only conversation lends its agents nothing more', async (t) => {
  const setup = world(t, writesThenReports);
  const chat = conversation(setup, 'read');
  const settled = nextSettle(chat.agents);
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.md.' });
  await settled;
  // Refused outright, without a question nobody could say yes to.
  assert.deepEqual(setup.ran, []);
  assert.equal(chat.asked.length, 0);
  assert.equal(delegation.narrower('full', 'read'), 'read');
  assert.equal(delegation.narrower('read', 'full'), 'read');
  assert.equal(delegation.narrower('full', 'ask'), 'ask');
});

test('a child inherits its own parent model, while explicit agent pins still win', async (t) => {
  const setup = world(t, writesThenReports);
  const chat = conversation(setup, 'full', true, { parentModel: { providerId: 'this-chat', model: 'this-model' } });
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.' });
  await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.deepEqual(setup.choices, [['this-chat', 'this-model']]);
  registry.save({ ...registry.find('test-writer')!, provider: 'pinned-source', model: 'pinned-model' });
  await start(chat.agents, { agent: 'test-writer', task: 'Write more notes.' });
  await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.deepEqual(setup.choices[1], ['pinned-source', 'pinned-model']);
});

test('a chat child keeps the conversation model while an unattended run follows the profile', async (t) => {
  const setup = world(t, writesThenReports);
  profiles.save({
    id: 'orchestrated',
    name: 'Orchestrated',
    description: 'test',
    roles: {
      default: { provider: 'profile-source', model: 'profile-model' },
      code: { provider: 'profile-source', model: 'profile-model' },
    },
  });
  profiles.select('orchestrated');

  // A child the conversation starts inherits the conversation's model. The turn is open and its
  // source is already serving it, so a profile role on a different source would start a second,
  // conflicting engine and stop the one the conversation is talking to.
  const chat = conversation(setup, 'full', true, { parentModel: { providerId: 'this-chat', model: 'this-model' } });
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.' });
  await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.deepEqual(setup.choices[0], ['this-chat', 'this-model']);

  // A run nobody is watching has no conversation model to inherit, so the selected profile is the
  // background-agent policy that supplies the role's model.
  const unattended = tasks.add({ agentId: 'test-writer', title: 'Unattended', prompt: 'Write notes.', startNow: true });
  await runner.runNow(unattended);
  assert.deepEqual(setup.choices[1], ['profile-source', 'profile-model']);

  profiles.select(null);
});

test('a chat child keeps a perception role binding the conversation model cannot serve', async (t) => {
  const setup = world(t, writesThenReports, (model) => model === 'profile-vision');
  profiles.save({
    id: 'orchestrated',
    name: 'Orchestrated',
    description: 'test',
    roles: {
      default: { provider: 'profile-source', model: 'profile-model' },
      image: { provider: 'vision-source', model: 'profile-vision' },
    },
  });
  profiles.select('orchestrated');

  // The image agent's role binds a model that can see. Inheriting the conversation's text-only
  // model would lose the one thing the role was bound for, so the binding stands even though a
  // chat turn started the run.
  const chat = conversation(setup, 'full', true, { parentModel: { providerId: 'this-chat', model: 'this-model' } });
  await start(chat.agents, { agent: 'image-maker', task: 'Draw a cat.' });
  await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.deepEqual(setup.choices[0], ['vision-source', 'profile-vision']);

  profiles.select(null);
});

test('a child respects a live parent permission downgrade before its next tool call', async (t) => {
  const setup = world(t, async (request, _signal, gate) => {
    await gate;
    return writesThenReports(request);
  });
  let access: AccessMode = 'full';
  const chat = conversation(setup, 'full', true, { currentMode: () => access });
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.' });
  await until(() => setup.requests.length === 1, 'initial generation');
  access = 'read';
  setup.release();
  await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.deepEqual(setup.ran, []);
  assert.deepEqual(chat.asked, []);
});

test('new agents start with the current parent permissions, not dispatch-time permissions', async (t) => {
  const setup = world(t, writesThenReports);
  const chat = conversation(setup, 'read', true, { currentMode: () => 'full' });
  const settled = nextSettle(chat.agents);
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.' });
  await settled;
  assert.equal(setup.requests[0].accessMode, 'full');
  assert.match(setup.requests[0].messages[0].content, /Permissions are set to full access/i);
  assert.equal(setup.ran.length, 1);
  assert.deepEqual(chat.asked, []);
});

for (const nextMode of ['full', 'read'] as const) {
  test(`a pending child approval re-evaluates when its parent changes ask to ${nextMode}`, { timeout: 5000 }, async (t) => {
    const setup = world(t, writesThenReports);
    const access = new LiveAccess(); access.begin('parent', 'ask');
    let pending: { signal?: AbortSignal; approve: (allowed: boolean) => void } | undefined;
    const chat = conversation(setup, 'ask', true, {
      currentMode: () => access.get('parent')!,
      onAccessChange: (listener) => access.subscribe('parent', listener),
      requestApproval: (_activity, signal) => new Promise<boolean>((resolve) => {
        pending = { signal, approve: resolve };
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      }),
    });
    t.after(() => chat.agents.stop());
    const settled = nextSettle(chat.agents);
    await start(chat.agents, { agent: 'test-writer', task: 'Write notes.' });
    await until(() => !!pending, 'child approval');
    access.update('parent', nextMode);
    pending!.approve(true); // A stale UI approval cannot beat the new read-only policy.
    await settled;
    assert.equal(pending!.signal?.aborted, true, 'the old approval is removed');
    assert.equal(setup.ran.length, nextMode === 'full' ? 1 : 0);
    assert.equal(setup.requests.at(-1)?.accessMode, nextMode);
  });
}

test('upgrading the parent cannot raise a child above its own ask-first limit', { timeout: 5000 }, async (t) => {
  const setup = world(t, writesThenReports);
  registry.save({ ...registry.find('test-writer')!, access: 'ask' });
  const access = new LiveAccess(); access.begin('parent', 'ask');
  let pending: { signal?: AbortSignal; approve: (allowed: boolean) => void } | undefined;
  const chat = conversation(setup, 'ask', true, {
    currentMode: () => access.get('parent')!,
    onAccessChange: (listener) => access.subscribe('parent', listener),
    requestApproval: (_activity, signal) => new Promise<boolean>((resolve) => { pending = { signal, approve: resolve }; }),
  });
  t.after(() => chat.agents.stop());
  const settled = nextSettle(chat.agents);
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.' });
  await until(() => !!pending, 'bounded child approval');
  access.update('parent', 'full');
  await pause(5);
  assert.equal(pending!.signal?.aborted, false);
  assert.deepEqual(setup.ran, []);
  pending!.approve(true);
  await settled;
  assert.equal(setup.ran.length, 1);
  assert.equal(setup.requests.at(-1)?.accessMode, 'ask');
});

test('stopping between start_agent returning and launch prevents inference entirely', async (t) => {
  const setup = world(t, writesThenReports);
  const chat = conversation(setup, 'full');
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.' });
  runner.stop(tasks.list()[0].id);
  await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.deepEqual(setup.requests, []);
  assert.deepEqual(setup.choices, []);
  assert.equal(tasks.list()[0].state, 'cancelled');
});

test('guidance sent immediately after start_agent is retained before its deferred launch', async (t) => {
  const setup = world(t, writesThenReports);
  const chat = conversation(setup, 'full');
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.' });
  const sent = await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.SEND_AGENT_MESSAGE,
    { agent: tasks.list()[0].id, message: 'Include a regression test.' });
  assert.equal(sent.ok, true);
  await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.ok(setup.requests[0].messages.some((message) => message.role === 'user' && message.content === 'Include a regression test.'));
});

test('agent guidance reaches the same run at a safe boundary and cannot target another parent', async (t) => {
  const setup = world(t, async (request, signal, gate) => {
    if (request.messages.some((message) => message.role === 'user' && message.content === 'Focus on cancellation.')) {
      return { content: 'Cancellation checked.', toolCalls: [] };
    }
    return heldUntilReleased('Initial report.')(request, signal, gate);
  });
  const chat = conversation(setup, 'full');
  await start(chat.agents, { agent: 'researcher', task: 'Review the code.' });
  await until(() => setup.requests.length === 2, 'agent reading');
  const task = tasks.list()[0];
  const other = conversation(setup, 'full');
  const refused = await other.agents.runtime.callTool(delegation.SERVER_ID, delegation.SEND_AGENT_MESSAGE,
    { agent: task.id, message: 'Not your agent.' });
  assert.equal(refused.ok, false);
  const sent = await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.SEND_AGENT_MESSAGE,
    { agent: task.id, message: 'Focus on cancellation.' });
  assert.equal(sent.ok, true);
  setup.release();
  const waited = await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.match(waited.text, /Cancellation checked/);
  assert.equal(tasks.list().length, 1);
});

test('the parent can stop one owned task without stopping its other agent', async (t) => {
  const setup = world(t, heldUntilReleased('Done.'));
  const chat = conversation(setup, 'full');
  await start(chat.agents, { agent: 'researcher', task: 'Review.' });
  await start(chat.agents, { agent: 'explorer', task: 'Explore.' });
  await until(() => setup.requests.length === 4, 'both agents reading');
  const researcher = tasks.list().find((task) => task.agentId === 'researcher')!;
  assert.equal((await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.STOP_AGENT, { agent: researcher.id })).ok, true);
  await until(() => chat.agents.background.running() === 1, 'one cancellation');
  assert.equal(tasks.list().find((task) => task.agentId === 'explorer')?.state, 'running');
  setup.release();
  await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.equal(tasks.find(researcher.id)?.state, 'cancelled');
});

test('agent control names are read-tier only on the app-owned server', () => {
  for (const name of [delegation.SEND_AGENT_MESSAGE, delegation.STOP_AGENT]) {
    assert.equal(tierOf(name, delegation.SERVER_ID), 'read');
    assert.equal(tierOf(name, 'untrusted'), 'danger');
    assert.equal(isTrustedTool(name, 'untrusted'), false);
  }
});

test('reports are bounded independently from complete child transcripts', async (t) => {
  const report = 'x'.repeat(delegation.MAX_REPORT_CHARS + 1000);
  const setup = world(t, async (request) => oneStep(request, call('r1', 'read_file', { path: 'README.md' }), report));
  const chat = conversation(setup, 'full');
  await start(chat.agents, { agent: 'researcher', task: 'Read it.' });
  const waited = await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.ok(waited.text.length < delegation.MAX_REPORT_CHARS + 500);
  assert.match(waited.text, /Report shortened/);
  const task = tasks.list()[0];
  const snapshot = transcripts.read(task.id, task.carbonId)!;
  assert.ok(snapshot.content.includes(report));
  assert.equal(snapshot.tools.length, 1);
  assert.equal(snapshot.tools[0].status, 'done');
  assert.equal(snapshot.tools[0].contentOffset, 0);
  transcripts.retain(new Set());
  assert.deepEqual(transcripts.read(task.id, task.carbonId), snapshot, 'structured history survives discarding live memory');
});

test('an agent that does not exist, or a missing brief, starts nothing', async (t) => {
  const setup = world(t, writesThenReports);
  const chat = conversation(setup, 'full');
  const missing = await start(chat.agents, { agent: 'gimp-builder', task: 'Build GIMP.' });
  assert.equal(missing.ok, false);
  assert.equal(missing.attempted, false);
  assert.match(missing.text, /no agent named "gimp-builder"\. Installed agents: .*shell-runner/);

  const empty = await start(chat.agents, { agent: 'shell-runner', task: '  ' });
  assert.equal(empty.ok, false);
  assert.deepEqual(tasks.list(), []);
  assert.equal(chat.agents.background.running(), 0);
  await pause(10);
  assert.equal(setup.requests.length, 0);
});

test('stopping the conversation stops its agent, and the report says so', async (t) => {
  const setup = world(t, heldUntilReleased('Tests pass.'));
  const chat = conversation(setup, 'full');
  const controller = new AbortController();
  const settled = nextSettle(chat.agents);
  await start(chat.agents, { agent: 'shell-runner', task: 'Run the tests.' }, { signal: controller.signal });
  await until(() => setup.requests.length === 2, 'the agent to be holding');

  controller.abort();
  await settled;

  const [task] = tasks.list();
  assert.equal(task.state, 'cancelled');
  const [delivered] = chat.agents.background.take();
  assert.equal(delivered.activity.status, 'failed');
  assert.match(delivered.note, /Shell runner stopped before it finished "Run the tests": the turn was stopped \(task /);
  assert.equal(chat.reported.at(-1)?.status, 'failed');
});

test('stop() ends whatever the turn left running', async (t) => {
  const setup = world(t, heldUntilReleased('Done.'));
  const chat = conversation(setup, 'full');
  await start(chat.agents, { agent: 'shell-runner', task: 'Run the tests.' }, { callId: 'a' });
  await start(chat.agents, { agent: 'explorer', task: 'Map the tree.' }, { callId: 'b' });
  assert.equal(chat.agents.background.running(), 2);
  await until(() => setup.requests.length === 4, 'both agents to be holding');

  chat.agents.stop();
  await until(() => chat.agents.background.running() === 0, 'both agents to end');
  assert.deepEqual(tasks.list().map((task) => task.state), ['cancelled', 'cancelled']);
  assert.equal(chat.agents.background.ready(), 2);
});

test('an agent stopped from its own panel is reported as the user\'s decision', async (t) => {
  const setup = world(t, heldUntilReleased('Tests pass.'));
  const chat = conversation(setup, 'full');
  const settled = nextSettle(chat.agents);
  await start(chat.agents, { agent: 'shell-runner', task: 'Run the tests.' });
  await until(() => setup.requests.length === 2, 'the agent to be holding');

  runner.stop(tasks.list()[0].id);
  await settled;
  const [delivered] = chat.agents.background.take();
  assert.match(delivered.note, /Shell runner was stopped by the user before it finished "Run the tests" \(task /);
  assert.equal(tasks.list()[0].state, 'cancelled');
});

test('wait_for_agents gives the reports it waited for, and they are not given again', async (t) => {
  const setup = world(t, writesThenReports);
  const chat = conversation(setup, 'full');
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.md.', title: 'Notes' });

  const waited = await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.equal(waited.ok, true);
  assert.match(waited.text, /^Test writer finished "Notes" \(task [0-9a-f]{8}; 2 round\(s\), 1 tool call\(s\)\)\.\n\nWrote notes\.md\.$/);
  assert.equal(chat.agents.background.ready(), 0);
  assert.deepEqual(chat.agents.background.take(), []);

  const again = await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {});
  assert.equal(again.text, 'No agent is running, and every report has already been given to you.');
  const named = await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, { agents: ['explorer'] });
  assert.match(named.text, /^None of those agents is running or has a report waiting\./);
});

test('wait_for_agents can wait for one agent, and says who is still out', async (t) => {
  const setup = world(t, (request, signal, gate) =>
    /Run the tests/.test(briefOf(request)) ? heldUntilReleased('Tests pass.')(request, signal, gate) : writesThenReports(request)
  );
  const chat = conversation(setup, 'full');
  await start(chat.agents, { agent: 'shell-runner', task: 'Run the tests.' }, { callId: 'a' });
  await start(chat.agents, { agent: 'test-writer', task: 'Write notes.md.', title: 'Notes' }, { callId: 'b' });
  const shellTask = tasks.list().find((task) => task.agentId === 'shell-runner')!;

  const waited = await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, { agents: ['test-writer'] });
  assert.match(waited.text, /^Test writer finished "Notes"/);
  assert.match(waited.text, /\n\n---\n\nStill running: Shell runner\. Each report will be given to you when it finishes\.$/);

  // By the id it was given, with a limit: it gives up and says so.
  const limited = await chat.agents.runtime.callTool(delegation.SERVER_ID, delegation.WAIT_FOR_AGENTS, {
    agents: [shellTask.id.slice(0, 8)],
    timeout_seconds: 0.05,
  });
  assert.equal(
    limited.text,
    'Stopped waiting after 0.05 seconds.\n\n---\n\nStill running: Shell runner. Each report will be given to you when it finishes.'
  );

  const settled = nextSettle(chat.agents);
  setup.release();
  await settled;
  assert.match(chat.agents.background.take()[0].note, /Shell runner finished "Run the tests"/);
});

/** A chat model that follows a script, one reply per request, and remembers what it was sent. */
function chatModel(script: Array<(messages: Message[]) => StreamResult | Promise<StreamResult>>) {
  const requests: Message[][] = [];
  const provider: StreamingProvider = {
    async stream(request, callback) {
      requests.push([...request.messages]);
      const step = script.shift();
      if (!step) throw new Error('chat script exhausted');
      const result = await step(request.messages);
      if (result.content) callback({ id: 'chunk', content: result.content });
      return result;
    },
  };
  return { provider, requests };
}

const turnRequest: ChatRequest = {
  messages: [{ id: 'u', role: 'user', content: 'Review toolPolicy.ts for security problems, and meanwhile fix the README typo.' }],
  model: 'chat-model',
  providerId: 'chat',
  useTools: true,
};

const lastMessage = (messages: Message[]) => messages[messages.length - 1];

test('a single inference slot queues three subagents and their parent without blocking dispatch', { timeout: 5000 }, async (t) => {
  // One shared backend slot, as with llama-server --parallel 1. Tool execution happens after
  // stream() releases that slot; waiting for agents must never reserve it for the parent.
  let tail = Promise.resolve();
  let active = 0;
  let maximumActive = 0;
  const singleSlot = (work: () => Promise<StreamResult>): Promise<StreamResult> => {
    const result = tail.then(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try { return await work(); }
      finally { active -= 1; }
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const setup = world(t, (request, _signal, gate) => singleSlot(async () => {
    await gate;
    return oneStep(request, call('read', 'read_file', { path: 'README.md' }), 'Read README.md.');
  }));
  const chat = conversation(setup, 'full');
  t.after(() => { setup.release(); chat.agents.stop(); });
  const model = chatModel([
    () => ({ content: '', toolCalls: ['explorer', 'code-reviewer', 'security-reviewer'].map((agent, index) =>
      agentCall(`start-${index}`, 'start_agent', { agent, task: 'Read README.md.', title: agent })) }),
    () => ({ content: '', toolCalls: [agentCall('wait', 'wait_for_agents', {})] }),
    (messages) => {
      const reports = lastMessage(messages).content ?? '';
      for (const agent of ['Explorer', 'Code reviewer', 'Security reviewer']) assert.match(reports, new RegExp(`${agent} finished`));
      return { content: 'All three agents finished on one inference slot.', toolCalls: [] };
    },
  ]);
  const provider: StreamingProvider = {
    stream: (request, callback, alive, signal) => singleSlot(() => model.provider.stream(request, callback, alive, signal)),
  };
  const turn = runToolLoop({
    provider,
    toolRuntime: chat.agents.runtime,
    background: chat.agents.background,
    request: turnRequest,
    runId: 'reply-1',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  await until(() => setup.requests.length === 3, 'all three agents to request the single slot');
  assert.equal(chat.agents.background.running(), 3, 'dispatch does not depend on available inference slots');
  assert.deepEqual(tasks.list().map((task) => task.state), ['running', 'running', 'running']);
  assert.equal(active, 1, 'one agent is generating while the others are queued');
  setup.release();

  const result = await turn;
  assert.equal(result.reason, 'finished');
  assert.equal(result.content, 'All three agents finished on one inference slot.');
  assert.deepEqual(tasks.list().map((task) => task.state), ['done', 'done', 'done']);
  assert.equal(setup.ran.length, 3);
  assert.equal(setup.requests.length, 6, 'each agent completed its tool round and final reply');
  assert.equal(maximumActive, 1, 'parent and agent generations shared the same slot throughout');
  assert.equal(active, 0);
});

test('the turn carries on while its agent works, and answers with the report', async (t) => {
  const setup = world(t, heldUntilReleased('Two findings: an unchecked path, and a missing tier.'));
  const chat = conversation(setup, 'full');
  const waiting: boolean[] = [];
  const activities: ToolActivity[] = [];
  let reviewRunningWhileFixing = false;

  const model = chatModel([
    () => ({
      content: '',
      toolCalls: [
        agentCall('s1', 'start_agent', { agent: 'security-reviewer', task: 'Review src/main/toolPolicy.ts.', title: 'Review toolPolicy.ts' }),
        call('r1', 'read_file', { path: 'README.md' }),
      ],
    }),
    () => {
      reviewRunningWhileFixing = chat.agents.background.running() === 1;
      return { content: '', toolCalls: [call('w1', 'write_file', { path: 'README.md', content: 'fixed' })] };
    },
    () => ({ content: 'Fixed the typo; the review is still going.', toolCalls: [] }),
    (messages) => {
      assert.match(lastMessage(messages).content ?? '', report);
      assert.equal(lastMessage(messages).role, 'user');
      return { content: 'The review found two problems.', toolCalls: [] };
    },
  ]);

  const turn = runToolLoop({
    provider: model.provider,
    toolRuntime: chat.agents.runtime,
    background: chat.agents.background,
    request: turnRequest,
    runId: 'reply-1',
    mode: 'full',
    onContent: () => undefined,
    onActivity: (activity) => activities.push(activity),
    onWaiting: (value) => {
      waiting.push(value);
      // The turn has nothing left to do: now let the review finish.
      if (value) setup.release();
    },
    requestApproval: async () => true,
  });
  const result = await turn;

  assert.equal(result.reason, 'finished');
  assert.ok(reviewRunningWhileFixing, 'the typo was fixed while the review was still running');
  assert.deepEqual(chat.chatCalls, ['read_file {"path":"README.md"}', 'write_file {"path":"README.md","content":"fixed"}']);
  assert.deepEqual(waiting, [true, false]);
  assert.equal(model.requests.length, 4);
  // What it wrote before the report and after it are separate paragraphs.
  assert.equal(result.content, 'Fixed the typo; the review is still going.\n\nThe review found two problems.');

  // The start call returned at once; its row later carried the report.
  const startResult = result.transcript.find((message) => message.role === 'tool' && message.toolCallId === 's1');
  assert.match(startResult?.content ?? '', /^Started Security reviewer on "Review toolPolicy\.ts"/);
  // Where the model heard: a mark in the transcript, and the report in its conversation.
  const mark = activities.find((activity) => activity.toolName === delegation.AGENT_REPORT);
  assert.equal(mark?.runId, 'reply-1');
  assert.equal(mark?.status, 'done');
  assert.match(mark?.result ?? '', /Two findings/);
  assert.equal(result.transcript.filter((message) => report.test(message.content ?? '')).length, 1);
  assert.equal(tasks.list()[0].state, 'done');
});

test('a note from the person is heard while the agents work', async (t) => {
  const setup = world(t, heldUntilReleased('All 234 tests pass.'));
  const chat = conversation(setup, 'full');
  let queued: string | null = null;
  const steer: Steering = {
    take: () => {
      const note = queued;
      queued = null;
      return note;
    },
    pending: () => queued !== null,
    interrupt: new AbortController().signal,
    rearm: () => undefined,
  };
  const waiting: boolean[] = [];
  const heard: string[] = [];
  let agentRunningWhenAnswering = false;

  const model = chatModel([
    () => ({ content: '', toolCalls: [agentCall('s1', 'start_agent', { agent: 'shell-runner', task: 'Run the tests.' })] }),
    () => ({ content: 'The tests are running.', toolCalls: [] }),
    (messages) => {
      assert.deepEqual(lastMessage(messages), { id: 'steer_0', role: 'user', content: 'What is 2 + 2?' });
      agentRunningWhenAnswering = chat.agents.background.running() === 1;
      return { content: '4.', toolCalls: [] };
    },
    (messages) => {
      assert.match(lastMessage(messages).content ?? '', /Shell runner finished "Run the tests"/);
      return { content: 'All the tests pass.', toolCalls: [] };
    },
  ]);

  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: chat.agents.runtime,
    background: chat.agents.background,
    request: turnRequest,
    runId: 'reply-1',
    mode: 'full',
    steer,
    onContent: () => undefined,
    onActivity: () => undefined,
    onSteer: (note) => heard.push(note),
    onWaiting: (value) => {
      waiting.push(value);
      if (!value) return;
      // First wait: the person asks something. Second: the tests finish.
      if (waiting.length === 1) queued = 'What is 2 + 2?';
      else setup.release();
    },
    requestApproval: async () => true,
  });

  assert.ok(agentRunningWhenAnswering, 'the note was answered before the agent finished');
  assert.deepEqual(heard, ['What is 2 + 2?']);
  assert.deepEqual(waiting, [true, false, true, false]);
  assert.equal(result.content, 'The tests are running.\n\n4.\n\nAll the tests pass.');
});

test('"steer now" ends a wait at once rather than at the next look', async (t) => {
  const setup = world(t, heldUntilReleased('Tests pass.'));
  const chat = conversation(setup, 'full');
  let queued: string | null = null;
  let interrupt = new AbortController();
  const steer: Steering = {
    take: () => {
      const note = queued;
      queued = null;
      return note;
    },
    pending: () => queued !== null,
    get interrupt() {
      return interrupt.signal;
    },
    rearm: () => {
      if (interrupt.signal.aborted) interrupt = new AbortController();
    },
  };
  let askedAt = 0;
  let heardAfter = Number.POSITIVE_INFINITY;
  const model = chatModel([
    () => ({ content: '', toolCalls: [agentCall('s1', 'start_agent', { agent: 'shell-runner', task: 'Run the tests.' })] }),
    () => ({ content: 'The tests are running.', toolCalls: [] }),
    () => {
      heardAfter = Date.now() - askedAt;
      setup.release();
      return { content: 'Noted.', toolCalls: [] };
    },
    () => ({ content: 'All the tests pass.', toolCalls: [] }),
  ]);

  await runToolLoop({
    provider: model.provider,
    toolRuntime: chat.agents.runtime,
    background: chat.agents.background,
    request: turnRequest,
    runId: 'reply-1',
    mode: 'full',
    steer,
    onContent: () => undefined,
    onActivity: () => undefined,
    onWaiting: (value) => {
      if (!value || askedAt) return;
      // Wait out the first look, so only the interrupt can explain a prompt answer.
      setTimeout(() => {
        askedAt = Date.now();
        queued = 'Stop after the unit tests.';
        interrupt.abort();
      }, 50);
    },
    requestApproval: async () => true,
  });

  assert.ok(heardAfter < 500, `the note reached the model ${heardAfter} ms after it was sent`);
});

test('stopping the turn while it waits stops its agents at once', async (t) => {
  const setup = world(t, heldUntilReleased('Never.'));
  const chat = conversation(setup, 'full');
  const controller = new AbortController();
  const model = chatModel([
    () => ({ content: '', toolCalls: [agentCall('s1', 'start_agent', { agent: 'shell-runner', task: 'Run the tests.' })] }),
    () => ({ content: 'Waiting for the tests.', toolCalls: [] }),
  ]);
  let stoppedAt = 0;

  const turn = runToolLoop({
    provider: model.provider,
    toolRuntime: chat.agents.runtime,
    background: chat.agents.background,
    request: turnRequest,
    runId: 'reply-1',
    mode: 'full',
    signal: controller.signal,
    onContent: () => undefined,
    onActivity: () => undefined,
    onWaiting: (value) => {
      if (!value) return;
      void until(() => setup.requests.length === 2, 'the agent to be holding').then(() => {
        stoppedAt = Date.now();
        controller.abort();
      });
    },
    requestApproval: async () => true,
  });

  await assert.rejects(turn, /run was cancelled/);
  assert.ok(Date.now() - stoppedAt < 500, 'the wait ended when the turn was stopped, not at the next poll');
  await until(() => chat.agents.background.running() === 0, 'the agent to end');
  assert.equal(tasks.list()[0].state, 'cancelled');
});

test('wait_for_agents inside a turn hands over the report, and it is not given twice', async (t) => {
  const setup = world(t, writesThenReports);
  const chat = conversation(setup, 'full');
  const activities: ToolActivity[] = [];
  const model = chatModel([
    () => ({ content: '', toolCalls: [agentCall('s1', 'start_agent', { agent: 'test-writer', task: 'Write notes.md.', title: 'Notes' })] }),
    () => ({ content: '', toolCalls: [agentCall('w1', 'wait_for_agents', {})] }),
    (messages) => {
      const waited = lastMessage(messages);
      assert.equal(waited.role, 'tool');
      assert.match(waited.content ?? '', /^Test writer finished "Notes"/);
      return { content: 'The notes are written.', toolCalls: [] };
    },
  ]);

  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: chat.agents.runtime,
    background: chat.agents.background,
    request: turnRequest,
    runId: 'reply-1',
    mode: 'full',
    onContent: () => undefined,
    onActivity: (activity) => activities.push(activity),
    requestApproval: async () => true,
  });

  assert.equal(result.reason, 'finished');
  assert.equal(result.content, 'The notes are written.');
  assert.equal(result.transcript.filter((message) => report.test(message.content ?? '')).length, 0);
  assert.equal(activities.filter((activity) => activity.toolName === delegation.AGENT_REPORT).length, 0);
  const waitRow = activities.filter((activity) => activity.toolName === delegation.WAIT_FOR_AGENTS).at(-1);
  assert.equal(waitRow?.status, 'done');
});

test('asking to wait again after a wait runs out is waiting, not going round in circles', async (t) => {
  const setup = world(t, heldUntilReleased('Tests pass.'));
  const chat = conversation(setup, 'full');
  const briefly = { timeout_seconds: 0.02 };
  const outOfTime = (messages: Message[]) => assert.match(lastMessage(messages).content ?? '', /^Stopped waiting after 0\.02 seconds\./);
  const model = chatModel([
    () => ({ content: '', toolCalls: [agentCall('s1', 'start_agent', { agent: 'shell-runner', task: 'Run the tests.' })] }),
    () => ({ content: '', toolCalls: [agentCall('w1', 'wait_for_agents', briefly)] }),
    (messages) => (outOfTime(messages), { content: '', toolCalls: [agentCall('w2', 'wait_for_agents', briefly)] }),
    (messages) => (outOfTime(messages), { content: '', toolCalls: [agentCall('w3', 'wait_for_agents', briefly)] }),
    (messages) => {
      outOfTime(messages);
      setup.release();
      return { content: '', toolCalls: [agentCall('w4', 'wait_for_agents', {})] };
    },
    (messages) => {
      assert.match(lastMessage(messages).content ?? '', /^Shell runner finished "Run the tests"/);
      return { content: 'The tests pass.', toolCalls: [] };
    },
  ]);

  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: chat.agents.runtime,
    background: chat.agents.background,
    request: turnRequest,
    runId: 'reply-1',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(result.reason, 'finished');
  assert.equal(result.content, 'The tests pass.');
});
