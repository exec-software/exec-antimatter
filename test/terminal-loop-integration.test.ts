import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatRequest, StreamResult } from '../src/api/types';
import { LiveAccess } from '../src/main/liveAccess';
import type { RunCommandOptions } from '../src/main/terminal';
import { withTerminal } from '../src/main/terminalTools';
import { runToolLoop, type ToolActivity, type ToolRuntime } from '../src/main/toolLoop';

function setup(command: string, workspace: string) {
  const dispatched: RunCommandOptions[] = [];
  const activities: ToolActivity[] = [];
  const requests: ChatRequest[] = [];
  const runtime: ToolRuntime = {
    enabledTools: () => [{ serverId: 'antimatter', serverName: 'Antimatter', tool: {
      name: 'run_command', description: 'Run Bash.', enabled: true,
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    } }],
    callTool: async () => { throw new Error('The bundled command must use its dedicated PTY.'); },
  };
  const results: StreamResult[] = [
    { content: '', toolCalls: [{ id: 'command', type: 'function', function: {
      name: 'antimatter__run_command', arguments: JSON.stringify({ command }),
    } }] },
    { content: 'Finished.', toolCalls: [] },
  ];
  return {
    dispatched, activities, requests,
    options: {
      provider: { stream: async (request: ChatRequest) => { requests.push(structuredClone(request)); return results.shift()!; } },
      toolRuntime: withTerminal(runtime, { workspace, threadId: 'thread', runCommand: async (spec) => {
        dispatched.push(spec);
        return { ok: true, text: '[exit] 0\n[private interaction] Command output withheld.', attempted: true };
      } }),
      request: { model: 'model', providerId: 'source', messages: [] } as ChatRequest,
      runId: 'run', workspace, workspaceConfirmed: true,
      onContent() {}, onActivity: (activity: ToolActivity) => activities.push(activity),
    },
  };
}

test('pending command gets no PTY before approval; live Full releases exactly one dispatch', { timeout: 3000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'terminal-loop-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const f = setup('printf hello', workspace);
  const access = new LiveAccess(); access.begin('run', 'ask');
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { entered = resolve; });
  let stale!: (value: boolean) => void;
  const running = runToolLoop({ ...f.options, mode: 'ask', currentMode: () => access.get('run')!,
    onAccessChange: (listener) => access.subscribe('run', listener),
    requestApproval: () => new Promise<boolean>((resolve) => { stale = resolve; entered(); }),
  });
  await pending;
  assert.equal(f.dispatched.length, 0);
  access.update('run', 'full');
  await running;
  stale(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].threadId, 'thread');
  assert.equal(f.dispatched[0].runId, 'run');
  assert.equal(f.dispatched[0].activityId, '0:0:command');
  assert.deepEqual(f.activities.map((activity) => activity.status), ['pending', 'running', 'done']);
  assert.match(JSON.stringify(f.requests.at(-1)?.messages), /private interaction/);
});

test('Full still requires explicit approval before a sudo command can get a terminal', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'terminal-loop-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const f = setup('sudo -v', workspace);
  let prompts = 0;
  await runToolLoop({ ...f.options, mode: 'full', requestApproval: async (activity) => {
    prompts++;
    assert.ok(activity.caution);
    assert.equal(f.dispatched.length, 0);
    return false;
  } });
  assert.equal(prompts, 1);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.activities.at(-1)?.status, 'denied');
});

test('read-only command refusal never creates an interactive session', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'terminal-loop-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const f = setup('printf hello', workspace);
  await runToolLoop({ ...f.options, mode: 'read', requestApproval: async () => { throw new Error('No prompt expected.'); } });
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.activities.at(-1)?.status, 'denied');
});
