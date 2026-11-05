import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CodeReview, ReviewAuthor } from '../src/api/codeReview';
import { CodeReviewStore } from '../src/main/codeReview/store';
import { CODE_REVIEW_INSTRUCTIONS, CODE_REVIEW_SERVER, CODE_REVIEW_TOOLS, withCodeReview } from '../src/main/codeReview/tools';
import { allowedUnattended, decide, isTrustedTool, tierOf } from '../src/main/toolPolicy';
import { runToolLoop, type ToolRuntime } from '../src/main/toolLoop';

const base: ToolRuntime = { enabledTools: () => [], callTool: async () => ({ ok: true, text: 'base-runtime' }) };
const identity: ReviewAuthor = { kind: 'agent', label: 'Review agent', threadId: 'chat-a', runId: 'run-a' };
const human: ReviewAuthor = { kind: 'human', label: 'Nathan' };
const payload = (result: { ok: boolean; text: string }) => {
  assert.equal(result.ok, true, result.text);
  return JSON.parse(result.text.slice(result.text.indexOf('\n') + 1));
};

function world(t: { after(fn: () => unknown): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-code-review-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  const otherWorkspace = join(root, 'other');
  mkdirSync(workspace); mkdirSync(otherWorkspace);
  const source = Array.from({ length: 20 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');
  writeFileSync(join(workspace, 'sample.ts'), source);
  writeFileSync(join(otherWorkspace, 'sample.ts'), 'PRIVATE_OTHER_PROJECT');
  const changes: unknown[] = [];
  const store = new CodeReviewStore(join(root, 'reviews'), (event) => changes.push(event));
  const controller = new AbortController();
  const runtime = withCodeReview(base, { store, workspace, author: identity, signal: controller.signal });
  const execute = async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const prepared = await runtime.prepareTool!(CODE_REVIEW_SERVER, name, args, { signal });
    return runtime.callTool(CODE_REVIEW_SERVER, name, prepared.args, { prepared: prepared.prepared, signal });
  };
  const create = async () => payload(await execute('create_code_review', {
    title: 'Review selected code', scope: { kind: 'file', path: 'sample.ts', startLine: 4, endLine: 10 },
  }));
  const add = async (review: { id: string; revision: number }, extra = {}) => payload(await execute('add_review_finding', {
    review_id: review.id, revision: review.revision, title: 'Check the value', body: 'Line six needs validation.', severity: 'medium',
    anchor: { path: 'sample.ts', side: 'after', startLine: 6, endLine: 6 }, ...extra,
  }));
  return { root, workspace, otherWorkspace, source, store, controller, runtime, changes, execute, create, add };
}

test('review annotations are read-mode capabilities only in the exact app-owned namespace', () => {
  for (const name of CODE_REVIEW_TOOLS) {
    assert.equal(isTrustedTool(name, CODE_REVIEW_SERVER), true);
    assert.equal(tierOf(name, CODE_REVIEW_SERVER), 'read');
    assert.equal(allowedUnattended(name, CODE_REVIEW_SERVER), true);
    assert.equal(isTrustedTool(name, 'untrusted-server'), false);
    assert.equal(tierOf(name, 'untrusted-server'), 'danger');
    assert.equal(allowedUnattended(name, 'untrusted-server'), false);
    for (const mode of ['read', 'ask', 'full'] as const) {
      assert.equal(decide(name, { mode, serverId: CODE_REVIEW_SERVER }), 'allow');
      assert.equal(decide(name, { mode, serverId: 'untrusted-server' }), 'deny');
    }
  }
});

test('review catalog teaches immutable snapshots, untrusted data and human final control', (t) => {
  const f = world(t);
  assert.deepEqual(f.runtime.enabledTools().map((entry) => entry.tool.name), [...CODE_REVIEW_TOOLS]);
  assert.match(CODE_REVIEW_INSTRUCTIONS, /immutable/);
  assert.match(CODE_REVIEW_INSTRUCTIONS, /untrusted/);
  assert.match(CODE_REVIEW_INSTRUCTIONS, /Only the human/);
  assert.match(CODE_REVIEW_INSTRUCTIONS, /code you have just written/);
});

test('create uses host attribution and conversation linkage without returning complete source', async (t) => {
  const f = world(t);
  const review = await f.create();
  const stored = f.store.read(f.workspace, review.id);
  assert.deepEqual(stored.author, identity);
  assert.equal(stored.conversationId, identity.threadId);
  assert.equal(review.files.length, 1);
  assert.equal(review.files[0].startLine, 4);
  assert.equal(review.files[0].after, undefined);
  assert.equal(review.files[0].before, undefined);
  assert.equal(review.findingCount, 0);
  assert.equal(readFileSync(join(f.workspace, 'sample.ts'), 'utf8'), f.source);
  assert.equal(f.changes.length, 1);
});

test('tool arguments cannot impersonate a human, select another workspace or link another chat', async (t) => {
  const f = world(t);
  for (const extra of [{ author: human }, { workspace: f.otherWorkspace }, { conversationId: 'other-chat' }]) {
    const result = await f.execute('create_code_review', { title: 'Spoofed', scope: { kind: 'file', path: 'sample.ts' }, ...extra });
    assert.equal(result.ok, false);
    assert.equal(result.attempted, false);
    assert.match(result.text, /host-controlled/);
  }
  assert.deepEqual(f.store.list(f.workspace), []);
});

test('reviews and files remain confined to the host-bound workspace', async (t) => {
  const f = world(t);
  const other = await f.store.create(f.otherWorkspace, { title: 'Other', scope: { kind: 'file', path: 'sample.ts' } }, human);
  assert.equal((await f.execute('read_code_review', { review_id: other.id })).ok, false);
  assert.equal((await f.execute('create_code_review', { title: 'Escape', scope: { kind: 'file', path: '../other/sample.ts' } })).ok, false);
  assert.deepEqual(payload(await f.execute('list_code_reviews')).reviews, []);
});

test('capture and read are paged, retain original line offsets and report changed current code', async (t) => {
  const f = world(t);
  const review = await f.create();
  const captured = f.store.read(f.workspace, review.id).files[0].after!;
  writeFileSync(join(f.workspace, 'sample.ts'), 'Different now\n');
  let offset = 0;
  let reconstructed = '';
  do {
    const page = payload(await f.execute('read_code_review', {
      review_id: review.id, view: 'file', path: 'sample.ts', side: 'after', offset, limit: 12,
    }));
    assert.equal(page.freshness, 'changed');
    assert.equal(page.startLine, 4 + (captured.slice(0, offset).match(/\n/g)?.length ?? 0));
    assert.equal(page.totalChars, captured.length);
    reconstructed += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(reconstructed, captured);
  assert.equal((await f.execute('read_code_review', { review_id: review.id, view: 'file', path: 'sample.ts', side: 'after', offset: captured.length + 1 })).ok, false);
  assert.equal((await f.execute('read_code_review', { review_id: review.id, view: 'file', path: '../other/sample.ts', side: 'after' })).ok, false);
});

test('agent overview and file reads expose executable-only changes', { skip: process.platform === 'win32' }, async (t) => {
  const f = world(t);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.workspace, stdio: 'ignore' });
  git('init', '-q'); git('config', 'core.filemode', 'true');
  chmodSync(join(f.workspace, 'sample.ts'), 0o644);
  git('add', 'sample.ts');
  git('-c', 'user.name=Review Test', '-c', 'user.email=review@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial source');
  chmodSync(join(f.workspace, 'sample.ts'), 0o755);
  const created = payload(await f.execute('create_code_review', { title: 'Executable change', scope: { kind: 'changes' } }));
  const overview = payload(await f.execute('read_code_review', { review_id: created.id }));
  assert.equal(overview.files[0].beforeMode, '100644');
  assert.equal(overview.files[0].afterMode, '100755');
  for (const side of ['before', 'after']) {
    const page = payload(await f.execute('read_code_review', { review_id: created.id, view: 'file', path: 'sample.ts', side }));
    assert.equal(page.beforeMode, '100644');
    assert.equal(page.afterMode, '100755');
    assert.equal(page.text, f.source, 'source content is unchanged; the executable bit is the finding evidence');
  }
});

test('findings, replies and agent status persist using revisions while human decisions remain human-only', async (t) => {
  const f = world(t);
  const review = await f.create();
  const added = await f.add(review);
  assert.equal(added.finding.status, 'open');
  assert.deepEqual(added.finding.author, identity);
  const reply = payload(await f.execute('reply_to_review', {
    review_id: review.id, revision: added.revision, finding_id: added.finding.id, body: 'I checked this and propose a guard.',
  }));
  const updated = payload(await f.execute('update_review_finding', {
    review_id: review.id, revision: reply.revision, finding_id: added.finding.id, status: 'addressed',
  }));
  assert.equal(updated.finding.status, 'addressed');
  for (const status of ['resolved', 'dismissed', 'approved']) {
    assert.equal((await f.execute('update_review_finding', {
      review_id: review.id, revision: updated.revision, finding_id: added.finding.id, status,
    })).ok, false);
  }
  assert.equal((await f.execute('update_review_finding', {
    review_id: review.id, revision: updated.revision, finding_id: added.finding.id, status: 'open', decision: 'approved',
  })).ok, false);
  assert.equal((await f.execute('approve_code_review', { review_id: review.id, revision: updated.revision })).ok, false);
  const stored = f.store.read(f.workspace, review.id);
  assert.equal(stored.revision, updated.revision);
  assert.equal(stored.decision, 'open');
  assert.deepEqual(stored.findings[0].comments.map((comment) => comment.body), [
    'Line six needs validation.', 'I checked this and propose a guard.', 'Changed status from open to addressed.',
  ]);
  assert.equal(readFileSync(join(f.workspace, 'sample.ts'), 'utf8'), f.source);
});

test('stale annotations fail without clobbering human work', async (t) => {
  const f = world(t);
  const review = await f.create();
  const added = await f.add(review);
  const humanEdit = await f.store.mutate(f.workspace, review.id, added.revision, {
    kind: 'reply', findingId: added.finding.id, body: 'Please check another edge case.',
  }, human);
  const result = await f.execute('reply_to_review', { review_id: review.id, revision: added.revision,
    finding_id: added.finding.id, body: 'Stale answer' });
  assert.equal(result.ok, false);
  const saved = f.store.read(f.workspace, review.id);
  assert.equal(saved.revision, humanEdit.revision);
  assert.equal(saved.findings[0].comments.at(-1)!.author.kind, 'human');
});

test('invalid anchors and malformed page arguments are rejected without annotations', async (t) => {
  const f = world(t);
  const review = await f.create();
  for (const anchor of [
    { path: 'sample.ts', side: 'after', startLine: 0, endLine: 1 },
    { path: 'sample.ts', side: 'after', startLine: 11, endLine: 12 },
    { path: 'sample.ts', side: 'after', startLine: 9, endLine: 4 },
    { path: 'outside.ts', side: 'after', startLine: 4, endLine: 4 },
  ]) {
    assert.equal((await f.execute('add_review_finding', { review_id: review.id, revision: review.revision,
      title: 'Invalid range', body: 'Test', severity: 'high', anchor })).ok, false);
  }
  for (const args of [{ offset: -1 }, { limit: 0 }, { limit: 16001 }, { offset: 0.5 }]) {
    assert.equal((await f.execute('read_code_review', { review_id: review.id, ...args })).ok, false);
  }
  assert.equal(f.store.read(f.workspace, review.id).findings.length, 0);
});

test('comment previews remain bounded and full comment bodies can be reconstructed', async (t) => {
  const f = world(t);
  const review = await f.create();
  const body = 'A detailed observation. '.repeat(300);
  const added = await f.add(review, { body });
  const overview = payload(await f.execute('read_code_review', { review_id: review.id }));
  assert.equal(overview.findings[0].comments, undefined);
  const discussion = payload(await f.execute('read_code_review', { review_id: review.id, view: 'finding', finding_id: added.finding.id }));
  assert.equal(discussion.comments[0].preview.length, 400);
  assert.equal(discussion.comments[0].truncated, true);
  assert.equal(discussion.comments[0].bodyChars, body.length);
  let offset = 0;
  let reconstructed = '';
  do {
    const page = payload(await f.execute('read_code_review', { review_id: review.id, view: 'comment', finding_id: added.finding.id,
      comment_id: discussion.comments[0].id, offset, limit: 1000 }));
    reconstructed += page.text; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(reconstructed, body);
});

test('unexpected persisted fields cannot expand model-facing metadata pages', async (t) => {
  const f = world(t);
  const review = await f.create();
  const added = await f.add(review);
  const file = join(f.root, 'reviews', createHash('sha256').update(f.workspace).digest('hex'), `${review.id}.json`);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  const extra = 'UNEXPECTED LARGE BODY '.repeat(5000);
  stored.extra = extra; stored.scope.extra = extra; stored.files[0].extra = extra; stored.findings[0].anchor.extra = extra;
  writeFileSync(file, JSON.stringify(stored));
  for (const [name, args] of [
    ['list_code_reviews', {}], ['read_code_review', { review_id: review.id }],
    ['read_code_review', { review_id: review.id, view: 'finding', finding_id: added.finding.id }],
  ] as const) {
    const result = await f.execute(name, args);
    assert.equal(result.ok, true, result.text);
    assert.doesNotMatch(result.text, /UNEXPECTED LARGE BODY/);
    assert.ok(result.text.length < 8000);
  }
});

test('prepared calls cannot substitute arguments, move between runtimes or execute twice', async (t) => {
  const f = world(t);
  const args = { title: 'Review', scope: { kind: 'file', path: 'sample.ts' } };
  assert.equal((await f.runtime.callTool(CODE_REVIEW_SERVER, 'create_code_review', args)).ok, false);
  const prepared = await f.runtime.prepareTool!(CODE_REVIEW_SERVER, 'create_code_review', args);
  assert.equal((await f.runtime.callTool(CODE_REVIEW_SERVER, 'create_code_review', { ...prepared.args, title: 'Altered' }, { prepared: prepared.prepared })).ok, false);
  const other = withCodeReview(base, { store: f.store, workspace: f.workspace, author: identity });
  assert.equal((await other.callTool(CODE_REVIEW_SERVER, 'create_code_review', prepared.args, { prepared: prepared.prepared })).ok, false);
  assert.equal((await f.runtime.callTool(CODE_REVIEW_SERVER, 'create_code_review', prepared.args, { prepared: prepared.prepared })).ok, true);
  assert.equal((await f.runtime.callTool(CODE_REVIEW_SERVER, 'create_code_review', prepared.args, { prepared: prepared.prepared })).ok, false);
  assert.equal(f.store.list(f.workspace).length, 1);
});

test('turn and per-call cancellation invalidate prepared mutations', async (t) => {
  for (const cancelTurn of [true, false]) {
    const f = world(t);
    const call = new AbortController();
    const prepared = await f.runtime.prepareTool!(CODE_REVIEW_SERVER, 'create_code_review', {
      title: 'Cancelled review', scope: { kind: 'file', path: 'sample.ts' },
    });
    (cancelTurn ? f.controller : call).abort();
    const result = await f.runtime.callTool(CODE_REVIEW_SERVER, 'create_code_review', prepared.args, { prepared: prepared.prepared, signal: call.signal });
    assert.equal(result.ok, false);
    assert.match(result.text, /cancelled/);
    assert.equal(f.store.list(f.workspace).length, 0);
  }
});

test('cancellation during asynchronous creation reaches the store before persistence', async (t) => {
  const f = world(t);
  const create = f.store.create.bind(f.store);
  const call = new AbortController();
  f.store.create = async (...args: Parameters<CodeReviewStore['create']>): Promise<CodeReview> => {
    assert.ok(args[3]);
    call.abort();
    return create(...args);
  };
  const result = await f.execute('create_code_review', { title: 'Cancelled capture', scope: { kind: 'file', path: 'sample.ts' } }, call.signal);
  assert.equal(result.ok, false);
  assert.equal(f.store.list(f.workspace).length, 0);
});

test('a mutation failure after persistence is not misreported as unattempted', async (t) => {
  const f = world(t);
  const create = f.store.create.bind(f.store);
  f.store.create = async (...args: Parameters<CodeReviewStore['create']>): Promise<CodeReview> => {
    await create(...args);
    throw new Error('The update notification failed.');
  };
  const result = await f.execute('create_code_review', { title: 'Captured before notification failure', scope: { kind: 'file', path: 'sample.ts' } });
  assert.equal(result.ok, false);
  assert.equal(result.attempted, true);
  assert.match(result.text, /Read or list reviews before retrying/);
  assert.equal(f.store.list(f.workspace).length, 1);
});

test('changing a workspace symlink does not retarget a running review session', async (t) => {
  const f = world(t);
  const alias = join(f.root, 'workspace-alias');
  symlinkSync(f.workspace, alias, 'dir');
  const runtime = withCodeReview(base, { store: f.store, workspace: alias, author: identity });
  const prepared = await runtime.prepareTool!(CODE_REVIEW_SERVER, 'list_code_reviews', {});
  unlinkSync(alias); symlinkSync(f.otherWorkspace, alias, 'dir');
  assert.equal((await runtime.callTool(CODE_REVIEW_SERVER, 'list_code_reviews', prepared.args, { prepared: prepared.prepared })).ok, false);
  assert.equal(runtime.enabledTools().length, 0);
});

test('other server calls keep their underlying runtime and a real read-only loop can create a review', async (t) => {
  const f = world(t);
  assert.equal((await f.runtime.callTool('other-server', 'list_code_reviews', {})).text, 'base-runtime');
  let round = 0;
  const result = await runToolLoop({ request: { providerId: 'test', model: 'test', messages: [] },
    provider: { stream: async (_request, callback) => {
      if (++round === 1) return { content: '', toolCalls: [{ id: 'create-review', type: 'function',
        function: { name: 'antimatter_code-review__create_code_review', arguments: JSON.stringify({ title: 'Review from agent', scope: { kind: 'file', path: 'sample.ts' } }) } }] };
      callback({ content: 'The captured code is ready for review.' });
      return { content: 'The captured code is ready for review.', toolCalls: [] };
    } },
    toolRuntime: f.runtime, runId: 'run-a', mode: 'read', onContent: () => {}, onActivity: () => {},
  });
  assert.equal(result.content, 'The captured code is ready for review.');
  assert.equal(f.store.list(f.workspace).length, 1);
  assert.equal(readFileSync(join(f.workspace, 'sample.ts'), 'utf8'), f.source);
});
