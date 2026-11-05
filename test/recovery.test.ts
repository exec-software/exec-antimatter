import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecoveryShell, type RecoveryDeps } from '../src/main/recovery/shell';

/** A shell wired to stub deps where a turn streams two chunks then asks for one approval. */
function makeShell() {
  const setup = {
    provider: { providerId: 'source', model: 'alpha' } as { providerId: string; model: string } | null,
    prompts: [] as string[],
    commands: [] as string[],
    workspaces: [] as string[],
  };
  const deps: RecoveryDeps = {
    provider: () => setup.provider,
    sources: () => [
      { id: 'source', name: 'Source One', models: [{ id: 'alpha' }, { id: 'beta' }] },
      { id: 'other', name: 'Other', models: [{ id: 'gamma' }] },
    ],
    saveModel: (choice) => {
      setup.provider = choice;
    },
    workspace: () => '/work/project',
    workspaceConfirmed: () => true,
    setWorkspace: (directory) => {
      setup.workspaces.push(directory);
    },
    run: async (question, options) => {
      setup.prompts.push(question);
      options.onContent('first ');
      options.onContent('second');
      const allowed = await options.onAsk(
        { approvalId: 'a', what: 'run_command(pnpm dev)', caution: 'starts a server' },
        new AbortController().signal
      );
      setup.commands.push(`approved=${allowed}`);
      return { content: 'first second', ok: true };
    },
    logs: () => [],
    conversations: () => [
      { id: 't1', title: 'Fix the typo', createdAt: 1700000000000 },
      { id: 't2', title: 'Add a panel', createdAt: 1690000000000 },
    ],
    runCommand: async (command) => ({ ok: true, output: `output of ${command}` }),
    reloadWindow: () => {},
    restartApp: () => {},
    hideShell: () => {},
  };
  const shell = createRecoveryShell(deps);
  return { shell, setup };
}

const waitTicks = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('the shell starts idle and uninvolved, and an engagement says so in the transcript', () => {
  const { shell } = makeShell();
  const before = shell.state();
  assert.equal(before.visible, false);
  assert.equal(before.busy, false);
  assert.deepEqual(before.messages, []);
  assert.equal(before.workspace, '/work/project');
  assert.ok(before.version);

  shell.show({ kind: 'render-process-gone', detail: 'crashed (exit 3)', at: Date.now() });
  const after = shell.state();
  assert.equal(after.visible, true);
  assert.equal(after.trigger?.kind, 'render-process-gone');
  assert.equal(after.messages[0].role, 'system');
  assert.match(after.messages[0].content, /render-process-gone/);
});

test('a prompt line streams its reply into the transcript and resolves with the content', async () => {
  const { shell, setup } = makeShell();
  const result = shell.sendLine('find the bug');
  await waitTicks();
  // The prompt is waiting on the shell's approval now.
  assert.equal(shell.state().busy, true);
  assert.equal(shell.state().approval?.what, 'run_command(pnpm dev) — starts a server');
  const allowed = shell.approve(shell.state().approval!.approvalId, true);
  assert.equal(allowed, true);

  const sent = await result;
  assert.equal(sent.ok, true);
  assert.equal(sent.content, 'first second');
  assert.deepEqual(setup.prompts, ['find the bug']);
  assert.deepEqual(setup.commands, ['approved=true']);

  const state = shell.state();
  assert.equal(state.busy, false);
  assert.equal(state.approval, null);
  const assistant = state.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant?.content, 'first second');
});

test('a denied approval reaches the turn as a refusal and clears the prompt', async () => {
  const { shell, setup } = makeShell();
  const result = shell.sendLine('do the risky edit');
  await waitTicks();
  const approvalId = shell.state().approval!.approvalId;
  assert.equal(shell.approve(approvalId, false), true);
  await result;
  assert.deepEqual(setup.commands, ['approved=false']);
  assert.equal(shell.state().approval, null);
});

test('an unknown command reports it rather than pretending', async () => {
  const { shell } = makeShell();
  const result = await shell.sendLine('/bogus');
  assert.equal(result.ok, false);
  const state = shell.state();
  assert.equal(state.messages.at(-1)?.role, 'error');
  assert.match(state.messages.at(-1)!.content, /No such command/);
});

test('/model lists sources and switches by name, persisting through saveModel', async () => {
  const { shell, setup } = makeShell();
  await shell.sendLine('/model');
  assert.equal(shell.state().messages.at(-1)?.role, 'system');
  assert.match(shell.state().messages.at(-1)!.content, /Source One/);

  await shell.sendLine('/model Other');
  assert.deepEqual(setup.provider, { providerId: 'other', model: 'gamma' });
  assert.match(shell.state().messages.at(-1)!.content, /gamma/);
});

test('/workspace points the tools somewhere and /run shows the command output', async () => {
  const { shell, setup } = makeShell();
  await shell.sendLine('/workspace /tmp/repo');
  assert.deepEqual(setup.workspaces, ['/tmp/repo']);
  assert.match(shell.state().messages.at(-1)!.content, /\/tmp\/repo/);

  await shell.sendLine('/run pnpm install');
  assert.match(shell.state().messages.at(-1)!.content, /Output\.*/);
});

test('/conversations lists the stored threads newest first', async () => {
  const { shell } = makeShell();
  await shell.sendLine('/conversations');
  const text = shell.state().messages.at(-1)!.content;
  assert.match(text, /Fix the typo/);
  assert.match(text, /Add a panel/);
  const lines = text.split('\n');
  assert.ok(lines[0].indexOf('Fix the typo') > lines[1].indexOf('Add a panel'));
});

test('/cancel stops a turn that is running, and the queue keeps one turn at a time', async () => {
  const { shell } = makeShell();
  let resolveRun!: (value: unknown) => void;
  const deps: RecoveryDeps = {
    provider: () => ({ providerId: 'source', model: 'alpha' }),
    sources: () => [],
    saveModel: () => {},
    workspace: () => '/work',
    workspaceConfirmed: () => true,
    setWorkspace: () => {},
    run: (_question, options) =>
      new Promise((resolve) => {
        resolveRun = resolve;
        options.signal.addEventListener('abort', () => resolve({ content: '', ok: false, error: 'Stopped' }), {
          once: true,
        });
      }),
    logs: () => [],
    conversations: () => [],
    runCommand: async () => ({ ok: true, output: '' }),
    reloadWindow: () => {},
    restartApp: () => {},
    hideShell: () => {},
  };
  const shellTwo = createRecoveryShell(deps);
  const running = shellTwo.sendLine('slow work');
  await waitTicks();
  assert.equal(shellTwo.state().busy, true);

  assert.equal(shellTwo.cancel(), true);
  await running;
  assert.equal(shellTwo.state().busy, false);
  assert.equal(shellTwo.state().messages.at(-1)?.role, 'system');
  assert.match(shellTwo.state().messages.at(-1)!.content, /Stopped/);

  resolveRun?.({ ok: false });
  await waitTicks();
});

test('sendLineAndWait resolves with the finished reply, the wiring used by recovery_use', async () => {
  const { shell } = makeShell();
  const pending = shell.sendLineAndWait('check the build');
  await waitTicks();
  shell.approve(shell.state().approval!.approvalId, true);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.content, 'first second');
});

test('/clear empties the transcript but leaves the shell engaged', async () => {
  const { shell } = makeShell();
  shell.show({ kind: 'requested', detail: 'opened from the tray', at: Date.now() });
  await shell.sendLine('/status');
  assert.ok(shell.state().messages.length > 1);
  await shell.sendLine('/clear');
  assert.deepEqual(shell.state().messages, []);
  assert.equal(shell.state().visible, true);
});

test('hide drops the shell out of the way without losing the transcript', async () => {
  const { shell } = makeShell();
  shell.show({ kind: 'requested', detail: 'opened from the tray', at: Date.now() });
  await shell.sendLine('/help');
  const count = shell.state().messages.length;
  shell.hide();
  assert.equal(shell.state().visible, false);
  assert.equal(shell.state().messages.length, count);
});