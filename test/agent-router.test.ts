import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatRequest } from '../src/api/types';
import * as registry from '../src/main/agents/registry';
import * as router from '../src/main/agents/router';
import type { StreamingProvider } from '../src/main/toolLoop';

const scratch = (t: { after(fn: () => unknown): void }) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-router-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  registry.useRoot(root);
  registry.ensureSeeded();
  return root;
};

/** A model that answers every routing question with the same reply, and remembers what it was asked. */
function answering(reply: string | Error) {
  const asked: ChatRequest[] = [];
  const provider: StreamingProvider = {
    async stream(request) {
      asked.push(request);
      if (reply instanceof Error) throw reply;
      return { content: reply, toolCalls: [] };
    },
  };
  return { deps: { provider, providerId: 'test', model: 'test' }, asked };
}

test('the catalogue says what each agent can do, not only what it is for', (t) => {
  scratch(t);
  // The Shell runner's description says "builds"; its three tools cannot write a file. A reader
  // choosing between agents needs the second fact as much as the first.
  const lines = router.catalogue(registry.list()).split('\n');
  assert.ok(lines.includes(
    '- shell-runner: Runs commands and reports what they actually printed. Builds, tests, one-off checks. [shell, build] (tools: run_command, read_file, list_directory; 8 rounds)'
  ), lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('- researcher: ') && line.endsWith('; 14 rounds; read-only)')));
});

test('the Agents panel always gets an agent', async (t) => {
  scratch(t);
  // Somebody pressed "route" there because they want an agent, so "none" falls back to the scorer.
  const routed = await router.route('Run the test suite', answering('none').deps);
  assert.ok(routed, 'the panel must get an agent');
  assert.equal(routed.guessed, true);

  const model = answering('```json\n{"agent": "shell-runner", "title": "Run the tests", "why": "Runs things."}\n```');
  const chosen = await router.route('Run the test suite', model.deps);
  assert.deepEqual(chosen, { agentId: 'shell-runner', agentName: 'Shell runner', title: 'Run the tests', why: 'Runs things.', guessed: false });
  assert.match(model.asked[0].messages[0].content ?? '', /\(tools: run_command, read_file, list_directory; 8 rounds\)/);
  assert.equal(model.asked[0].useTools, false);
});

test('a reply one brace short still routes', async (t) => {
  scratch(t);
  const chosen = await router.route('Run npm audit', answering('{"agent": "security-scanner", "why": "Scanning."').deps);
  assert.equal(chosen?.agentId, 'security-scanner');
  assert.equal(chosen?.guessed, false);
});

test('an unreachable model is scored by hand rather than failing the dispatch', async (t) => {
  scratch(t);
  const chosen = await router.route('write tests for the parser', answering(new Error('ECONNREFUSED')).deps);
  assert.equal(chosen?.guessed, true);
  assert.equal(chosen?.agentId, 'test-writer');
});
