import assert from 'node:assert/strict';
import test from 'node:test';
import { githubRepository, listPullRequests, pullRequestChecks, readPullRequest, type PullRequestCommand } from '../src/main/pullRequests';
import { pullRequestReviewPrompt } from '../renderer/src/components/pullRequests/PullRequestsPage';

const workspace = '/workspace/project';
const sample = {
  number: 42, title: 'Make remote connections reliable', author: { login: 'contributor' }, isDraft: false,
  baseRefName: 'main', headRefName: 'fix/remote', updatedAt: '2026-09-20T10:00:00Z', reviewDecision: 'APPROVED',
  statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }],
  url: 'javascript:alert(1)',
};

function fake(options: { origin?: string; response?: unknown; error?: unknown } = {}) {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const run: PullRequestCommand = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'git' && args[0] === 'rev-parse') return workspace;
    if (command === 'git' && args[0] === 'remote') return options.origin ?? 'git@github.com:exec-software/exec-antimatter.git';
    if (options.error) throw options.error;
    return JSON.stringify(options.response ?? [sample]);
  };
  return { run, calls };
}

test('GitHub origin parsing accepts SSH/HTTPS and builds credential-free canonical links', () => {
  for (const origin of ['git@github.com:exec-software/exec-antimatter.git', 'ssh://git@github.com/exec-software/exec-antimatter.git', 'https://github.com/exec-software/exec-antimatter.git']) {
    assert.deepEqual(githubRepository(origin, workspace), {
      workspace, owner: 'exec-software', name: 'exec-antimatter', slug: 'exec-software/exec-antimatter', url: 'https://github.com/exec-software/exec-antimatter',
    });
  }
  for (const origin of ['https://token:secret@github.com/owner/repo', 'https://github.com.evil.test/owner/repo', 'https://gitlab.com/owner/repo', 'git://github.com/owner/repo', 'https://github.com/owner/repo?token=secret', 'git@github.com:../repo', 'file:///tmp/repo', 'https://github.com/owner/repo/extra', 'https://github.com:123/owner/repo']) {
    assert.equal(githubRepository(origin, workspace), null, origin);
  }
});

test('listing only invokes bounded read-only argv commands and ignores untrusted returned links', async () => {
  const { run, calls } = fake();
  const result = await listPullRequests(workspace, run);
  assert.equal(result.issue, null);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, 'https://github.com/exec-software/exec-antimatter/pull/42');
  assert.equal(result.items[0].checks, 'passing');
  assert.equal(result.items[0].review, 'approved');
  assert.deepEqual(calls.slice(0, 2).map((call) => [call.command, call.args]), [
    ['git', ['rev-parse', '--show-toplevel']], ['git', ['remote', 'get-url', 'origin']],
  ]);
  assert.deepEqual(calls[2].args.slice(0, 8), ['pr', 'list', '--repo', 'github.com/exec-software/exec-antimatter', '--state', 'open', '--limit', '100']);
  assert.equal(calls[2].cwd, workspace);
});

test('setup failures give actionable guidance without exposing command output or credentials', async () => {
  assert.equal((await listPullRequests(null, fake().run)).issue?.kind, 'no-workspace');
  assert.equal((await listPullRequests(workspace, async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); })).issue?.kind, 'git-missing');
  assert.equal((await listPullRequests(workspace, async () => { throw new Error('not a git repository'); })).issue?.kind, 'not-repository');
  assert.equal((await listPullRequests(workspace, fake({ origin: 'https://gitlab.com/owner/repo' }).run)).issue?.kind, 'unsupported-origin');
  const cases = [
    [Object.assign(new Error('gh not installed'), { code: 'ENOENT' }), 'gh-missing'],
    [{ stderr: 'HTTP 401: bad credentials secret-token' }, 'authentication'],
    [{ stderr: 'error connecting to api.github.com secret-token' }, 'unreachable'],
    [{ killed: true, stderr: 'secret-token' }, 'unreachable'],
    [{ stderr: 'unknown secret-token' }, 'failed'],
  ] as const;
  for (const [error, kind] of cases) {
    const result = await listPullRequests(workspace, fake({ error }).run);
    assert.equal(result.issue?.kind, kind);
    assert.doesNotMatch(JSON.stringify(result), /secret-token/);
    assert.match(result.issue!.action, /terminal|refresh|restart/);
  }
});

test('checks combine workflow and legacy status contexts without treating running checks as passing', () => {
  assert.equal(pullRequestChecks([]), 'none');
  assert.equal(pullRequestChecks([{ status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(pullRequestChecks([{ state: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), 'passing');
  assert.equal(pullRequestChecks([{ state: 'SUCCESS' }, { state: 'PENDING' }]), 'pending');
  assert.equal(pullRequestChecks([{ conclusion: 'CANCELLED' }, { state: 'PENDING' }]), 'failing');
});

test('details expose bounded changed-file metadata and a read-only review draft', async () => {
  const { run, calls } = fake({ response: {
    ...sample, body: 'A description with <script>untrusted()</script>',
    files: [{ path: 'src/main.ts', additions: 4, deletions: 2 }], changedFiles: 3, additions: 10, deletions: 6,
  } });
  const result = await readPullRequest(workspace, 42, run);
  assert.equal(result.filesTruncated, true);
  assert.equal(result.changedFiles, 3);
  assert.deepEqual(result.files, [{ path: 'src/main.ts', additions: 4, deletions: 2 }]);
  assert.deepEqual(calls[2].args.slice(0, 5), ['pr', 'view', '42', '--repo', 'github.com/exec-software/exec-antimatter']);
  const prompt = pullRequestReviewPrompt(result);
  assert.match(prompt, /https:\/\/github.com\/exec-software\/exec-antimatter\/pull\/42/);
  assert.match(prompt, /do not checkout branches, change files, post comments, or merge/);
  assert.doesNotMatch(prompt, /untrusted\(\)/, 'the PR body is data, never promoted to the user instruction');
});

test('malformed data, invalid numbers, and mismatched detail responses do not leak through', async () => {
  assert.equal((await listPullRequests(workspace, fake({ response: { items: [sample] } }).run)).issue?.kind, 'failed');
  assert.equal((await listPullRequests(workspace, fake({ response: [{ ...sample, number: -1 }] }).run)).issue?.kind, 'failed');
  const source = fake({ response: { ...sample, number: 43 } });
  await assert.rejects(readPullRequest(workspace, 42, source.run), /could not read/);
  for (const number of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(readPullRequest(workspace, number, source.run), /valid pull request number/);
  }
});
