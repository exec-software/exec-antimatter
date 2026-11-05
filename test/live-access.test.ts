import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccessMode, ChatRequest, StreamResult } from '../src/api/types';
import { runToolLoop, type StreamingProvider, type ToolActivity, type ToolRuntime } from '../src/main/toolLoop';
import { buildToolset } from '../src/main/toolPolicy';

const request: ChatRequest = { messages: [], model: 'm', providerId: 'p' };

/** A turn that writes a file on each of `rounds` rounds, then answers. */
function writingTurn(rounds: number) {
  const wrote: string[] = [];
  const results: StreamResult[] = [];
  for (let round = 0; round < rounds; round += 1) {
    results.push({
      content: '',
      toolCalls: [
        {
          id: `c${round}`,
          type: 'function',
          function: { name: 'antimatter__write_file', arguments: JSON.stringify({ path: `f${round}.txt`, content: 'x' }) },
        },
      ],
    });
  }
  results.push({ content: 'Done.', toolCalls: [] });

  const provider: StreamingProvider = { stream: async () => results.shift()! };
  const runtime: ToolRuntime = {
    enabledTools: () => [
      {
        serverId: 'antimatter',
        serverName: 'Antimatter tools',
        tool: {
          name: 'write_file',
          description: 'Write a file.',
          inputSchema: { type: 'object', properties: {} },
          enabled: true,
        },
      },
    ],
    async callTool(_server, _name, args) {
      wrote.push(String(args.path));
      return { ok: true, text: 'written' };
    },
  };
  return { provider, runtime, wrote };
}

test('a permission change during a turn applies to the next tool call', async () => {
  const model = writingTurn(3);
  // Full access lets a project write through without asking; read-only refuses it outright.
  let mode: AccessMode = 'full';
  await runToolLoop({
    provider: model.provider,
    toolRuntime: model.runtime,
    request,
    runId: 'run',
    mode: 'full',
    currentMode: () => mode,
    onContent: () => undefined,
    onActivity: (activity) => {
      // Tightened by whoever is watching, part-way through the turn.
      if (activity.status === 'done' && activity.toolName === 'write_file') mode = 'read';
    },
    requestApproval: async () => true,
  });

  // The first write ran under Full; the two after it were refused, without restarting the turn.
  assert.deepEqual(model.wrote, ['f0.txt']);
});

test('a turn with no live resolver keeps the mode it was dispatched with', async () => {
  const model = writingTurn(3);
  await runToolLoop({
    provider: model.provider,
    toolRuntime: model.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });
  assert.deepEqual(model.wrote, ['f0.txt', 'f1.txt', 'f2.txt']);
});

test('loosening mid-turn also takes effect, so a refusal can be reversed without starting again', async () => {
  const model = writingTurn(2);
  let mode: AccessMode = 'read';
  let denied = 0;
  await runToolLoop({
    provider: model.provider,
    toolRuntime: model.runtime,
    request,
    runId: 'run',
    mode: 'read',
    currentMode: () => mode,
    onContent: () => undefined,
    onActivity: (activity) => {
      if (activity.status === 'denied') {
        denied += 1;
        mode = 'full';
      }
    },
    requestApproval: async () => true,
  });
  assert.equal(denied, 1);
  assert.deepEqual(model.wrote, ['f1.txt']);
});

function liveAccess(initial: AccessMode = 'ask') {
  let mode = initial;
  const listeners = new Set<() => void>();
  return {
    currentMode: () => mode,
    onAccessChange: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next: AccessMode) {
      mode = next;
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}

function approvalWait() {
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { entered = resolve; });
  const prompts: Array<{ id?: string; signal: AbortSignal; resolve: (approved: boolean) => void }> = [];
  return {
    pending,
    prompts,
    requestApproval: (activity: ToolActivity, signal?: AbortSignal) => new Promise<boolean>((resolve) => {
      assert.ok(signal, 'each prompt has its own cancellable lifetime');
      prompts.push({ id: activity.approvalId, signal, resolve });
      // Deliberately leave the result unresolved on abort, like a lagging remote adapter. The
      // loop must advance independently and ignore even an eventual true response to this id.
      entered();
    }),
  };
}

test('ask to full releases an already pending project write and cancels its stale approval', { timeout: 2_000 }, async () => {
  const model = writingTurn(1);
  const access = liveAccess();
  const wait = approvalWait();
  const activities: ToolActivity[] = [];
  const running = runToolLoop({
    ...access, ...wait, provider: model.provider, toolRuntime: model.runtime,
    request, runId: 'pending-upgrade', mode: 'ask',
    onContent: () => {}, onActivity: (activity) => activities.push(activity),
  });
  await wait.pending;
  access.set('full');
  await running;
  assert.deepEqual(model.wrote, ['f0.txt']);
  assert.equal(wait.prompts[0].signal.aborted, true);
  assert.equal(access.listeners.size, 0);
  assert.deepEqual(activities.map((activity) => activity.status), ['pending', 'running', 'done']);
  wait.prompts[0].resolve(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(model.wrote.length, 1, 'a stale grant cannot execute the tool again');
});

test('ask to read cancels a pending write without calling it a human refusal', { timeout: 2_000 }, async () => {
  const model = writingTurn(1);
  const access = liveAccess();
  const wait = approvalWait();
  const activities: ToolActivity[] = [];
  const running = runToolLoop({
    ...access, ...wait, provider: model.provider, toolRuntime: model.runtime,
    request, runId: 'pending-downgrade', mode: 'ask',
    onContent: () => {}, onActivity: (activity) => activities.push(activity),
  });
  await wait.pending;
  access.set('read');
  wait.prompts[0].resolve(true);
  await running;
  assert.deepEqual(model.wrote, []);
  assert.equal(wait.prompts[0].signal.aborted, true);
  assert.equal(access.listeners.size, 0);
  assert.equal(activities.at(-1)?.status, 'denied');
  assert.match(activities.at(-1)?.result ?? '', /read.only/i);
  assert.doesNotMatch(activities.at(-1)?.result ?? '', /was declined/);
});

test('a permission downgrade racing an approved promise is enforced at execution', async () => {
  const model = writingTurn(1);
  const access = liveAccess();
  await runToolLoop({
    ...access, provider: model.provider, toolRuntime: model.runtime,
    request, runId: 'approval-race', mode: 'ask',
    onContent: () => {}, onActivity: () => {},
    requestApproval: async () => {
      access.set('read');
      return true;
    },
  });
  assert.deepEqual(model.wrote, []);
  assert.equal(access.listeners.size, 0);
});

test('ask to full and immediately back to ask requires a new, distinct approval', { timeout: 2_000 }, async () => {
  const model = writingTurn(1);
  const access = liveAccess();
  const wait = approvalWait();
  const running = runToolLoop({
    ...access, ...wait, provider: model.provider, toolRuntime: model.runtime,
    request, runId: 'rapid-mode-flip', mode: 'ask', onContent: () => {}, onActivity: () => {},
  });
  await wait.pending;
  access.set('full');
  access.set('ask');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(wait.prompts.length, 2);
  assert.equal(wait.prompts[0].signal.aborted, true);
  assert.notEqual(wait.prompts[0].id, wait.prompts[1].id);
  wait.prompts[0].resolve(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(model.wrote, []);
  assert.equal(access.listeners.size, 1);
  wait.prompts[1].resolve(true);
  await running;
  assert.deepEqual(model.wrote, ['f0.txt']);
  assert.equal(access.listeners.size, 0);
});

test('a synchronous permission subscription notification does not leak or open a stale prompt', async () => {
  const model = writingTurn(1);
  let mode: AccessMode = 'ask';
  let cleaned = 0;
  await runToolLoop({
    provider: model.provider, toolRuntime: model.runtime,
    request, runId: 'sync-mode-listener', mode: 'ask', currentMode: () => mode,
    onAccessChange: (listener) => { mode = 'full'; listener(); return () => { cleaned += 1; }; },
    onContent: () => {}, onActivity: () => {},
    requestApproval: async () => { assert.fail('the superseded approval must never be shown'); },
  });
  assert.equal(cleaned, 1);
  assert.deepEqual(model.wrote, ['f0.txt']);
});

test('the final execution check protects callers with only a live getter', async () => {
  const model = writingTurn(1);
  let mode: AccessMode = 'ask';
  await runToolLoop({
    currentMode: () => mode, provider: model.provider, toolRuntime: model.runtime,
    request, runId: 'getter-only-race', mode: 'ask',
    onContent: () => {}, onActivity: () => {},
    requestApproval: async () => { mode = 'read'; return true; },
  });
  assert.deepEqual(model.wrote, []);
});

test('permission changes made by synchronous activity delivery precede actual execution', async () => {
  const model = writingTurn(1);
  const access = liveAccess('full');
  await runToolLoop({
    ...access, provider: model.provider, toolRuntime: model.runtime,
    request, runId: 'activity-race', mode: 'full',
    onContent: () => {},
    onActivity: (activity) => { if (activity.status === 'running') access.set('read'); },
    requestApproval: async () => true,
  });
  assert.deepEqual(model.wrote, []);
});

for (const guarded of [
  { label: 'machine-wide command', serverId: 'antimatter', name: 'run_command', args: { command: 'sudo apt-get update' } },
  { label: 'always-confirm publication', serverId: 'beholder.discord', name: 'discord_post', args: { message: 'hello' } },
  { label: 'untrusted server capability', serverId: 'third-party', name: 'write_file', args: { path: 'file.txt', content: 'x' } },
]) {
  test(`full access still waits for explicit approval of a ${guarded.label}`, { timeout: 2_000 }, async () => {
    const access = liveAccess();
    const wait = approvalWait();
    let ran = 0;
    const enabled = [{ serverId: guarded.serverId, serverName: 'Test', tool: {
      name: guarded.name, description: 'Test operation.', inputSchema: { type: 'object', properties: {} }, enabled: true,
    } }];
    const name = buildToolset(enabled).definitions[0].function.name;
    const results: StreamResult[] = [
      { content: '', toolCalls: [{ id: 'guarded', type: 'function', function: { name, arguments: JSON.stringify(guarded.args) } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    const running = runToolLoop({
      ...access, ...wait,
      provider: { stream: async () => results.shift()! },
      toolRuntime: { enabledTools: () => enabled, callTool: async () => { ran += 1; return { ok: true, text: 'done' }; } },
      request, runId: `guarded-${guarded.name}`, mode: 'ask', onContent: () => {}, onActivity: () => {},
    });
    await wait.pending;
    access.set('full');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ran, 0);
    assert.equal(wait.prompts[0].signal.aborted, false);
    assert.equal(access.listeners.size, 1);
    wait.prompts[0].resolve(true);
    await running;
    assert.equal(ran, 1);
    assert.equal(access.listeners.size, 0);
  });
}

test('turn cancellation aborts its pending prompt and removes permission listeners', { timeout: 2_000 }, async () => {
  const model = writingTurn(1);
  const access = liveAccess();
  const wait = approvalWait();
  const controller = new AbortController();
  const running = runToolLoop({
    ...access, ...wait, provider: model.provider, toolRuntime: model.runtime,
    request, runId: 'cancel-prompt', mode: 'ask', signal: controller.signal,
    onContent: () => {}, onActivity: () => {},
  });
  await wait.pending;
  controller.abort();
  await assert.rejects(running, /run was cancelled/);
  assert.equal(wait.prompts[0].signal.aborted, true);
  assert.equal(access.listeners.size, 0);
  wait.prompts[0].resolve(true);
  access.set('full');
  assert.deepEqual(model.wrote, []);
});

test('an approval adapter failure also releases its permission listener', async () => {
  const model = writingTurn(1);
  const access = liveAccess();
  await assert.rejects(runToolLoop({
    ...access, provider: model.provider, toolRuntime: model.runtime,
    request, runId: 'broken-prompt', mode: 'ask',
    onContent: () => {}, onActivity: () => {},
    requestApproval: async () => { throw new Error('approval transport unavailable'); },
  }), /approval transport unavailable/);
  assert.equal(access.listeners.size, 0);
  assert.deepEqual(model.wrote, []);
});

test('each inference boundary uses live permissions in grounding and request metadata', async () => {
  const model = writingTurn(2);
  const access = liveAccess('read');
  const requests: ChatRequest[] = [];
  const built: AccessMode[] = [];
  const result = await runToolLoop({
    ...access,
    provider: { stream: async (next, ...args) => {
      requests.push({ ...next, messages: [...next.messages] });
      return model.provider.stream(next, ...args);
    } },
    toolRuntime: model.runtime,
    request: { ...request, accessMode: 'ask', messages: [
      { id: 'custom-system', role: 'system', content: 'stale ask grounding' },
      { id: 'user', role: 'user', content: 'Write files.' },
    ] },
    runId: 'grounding', mode: 'ask',
    systemPromptForMode: (mode) => { built.push(mode); return `Effective permission: ${mode}.`; },
    onContent: () => {},
    onActivity: (activity) => { if (activity.status === 'denied') access.set('full'); },
    requestApproval: async () => true,
  });
  assert.deepEqual(built, ['read', 'full']);
  assert.deepEqual(requests.map((next) => next.accessMode), ['read', 'full', 'full']);
  assert.deepEqual(requests.map((next) => next.messages[0].content), [
    'Effective permission: read.', 'Effective permission: full.', 'Effective permission: full.',
  ]);
  assert.ok(requests.every((next) => next.messages[0].id === 'custom-system'));
  assert.equal(result.transcript.filter((message) => message.role === 'system').length, 1);
  assert.deepEqual(result.transcript.map((message) => message.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(model.wrote, ['f1.txt']);
});

test('mode change before initial generation replaces grounding even without a system message', async () => {
  let captured: ChatRequest | undefined;
  await runToolLoop({
    provider: { stream: async (next) => { captured = { ...next, messages: [...next.messages] }; return { content: 'Done.', toolCalls: [] }; } },
    toolRuntime: writingTurn(0).runtime,
    request: { ...request, messages: [{ id: 'question', role: 'user', content: 'Hello' }] },
    runId: 'initial-grounding', mode: 'read', currentMode: () => 'full',
    systemPromptForMode: (mode) => `Mode: ${mode}`,
    onContent: () => {}, onActivity: () => {}, requestApproval: async () => true,
  });
  assert.equal(captured?.accessMode, 'full');
  assert.deepEqual(captured?.messages.map((message) => message.role), ['system', 'user']);
  assert.equal(captured?.messages[0].content, 'Mode: full');
});
