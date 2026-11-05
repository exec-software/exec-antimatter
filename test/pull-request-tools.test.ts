import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readPullRequestPatch, type PullRequestCommand } from '../src/main/pullRequests';
import { PULL_REQUEST_SERVER, withPullRequests } from '../src/main/pullRequestTools';
import { tierOf, allowedUnattended } from '../src/main/toolPolicy';

test('PR review reads bounded authenticated diff pages with argv and pinned GitHub host', async () => {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const run: PullRequestCommand = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (args[0] === 'rev-parse') return '/work/repository';
    if (args[0] === 'remote') return 'git@github.com:owner/repository.git';
    return Array.from({ length: 250 }, (_, i) => `+line ${i}`).join('\n');
  };
  const first = await readPullRequestPatch('/work/repository', 12, 0, run);
  assert.equal(first.nextOffset, 200);
  assert.equal(first.totalLines, 250);
  assert.match(first.patch, /^1: \+line 0/);
  assert.deepEqual(calls[2], { command: 'gh', args: ['pr', 'diff', '12', '--repo', 'github.com/owner/repository', '--color', 'never'], cwd: '/work/repository' });
  const next = await readPullRequestPatch('/work/repository', 12, first.nextOffset!, run);
  assert.equal(next.nextOffset, null);
  assert.match(next.patch, /^201: \+line 200/);
  await assert.rejects(readPullRequestPatch('/work/repository', -1, 0, run));
  await assert.rejects(readPullRequestPatch('/work/repository', 1, -1, run));
});

test('PR read capability belongs only to its app-owned server and preserves other tools', async () => {
  assert.equal(tierOf('read_pull_request', PULL_REQUEST_SERVER), 'read');
  assert.equal(tierOf('read_pull_request', 'untrusted'), 'danger');
  assert.equal(allowedUnattended('read_pull_request', 'untrusted'), false);
  const runtime = withPullRequests({ enabledTools: () => [], callTool: async () => ({ ok: true, text: 'forwarded' }) }, '/work/repository');
  assert.equal((await runtime.callTool('other', 'read_pull_request', {})).text, 'forwarded');
  const invalid = await runtime.callTool(PULL_REQUEST_SERVER, 'read_pull_request', { number: '--delete' });
  assert.equal(invalid.attempted, false);
  const stop = new AbortController(); stop.abort();
  const cancelled = await runtime.callTool(PULL_REQUEST_SERVER, 'read_pull_request', { number: 1 }, { signal: stop.signal });
  assert.equal(cancelled.attempted, false);
});
