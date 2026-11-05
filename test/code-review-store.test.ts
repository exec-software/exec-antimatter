import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CodeReview, ReviewAuthor, ReviewMutation } from '../src/api/codeReview';
import { CodeReviewStore } from '../src/main/codeReview/store';
import { SNAPSHOT_LIMITS } from '../src/main/codeReview/snapshot';

const human: ReviewAuthor = { kind: 'human', label: 'You' };
const agent: ReviewAuthor = { kind: 'agent', label: 'Reviewer', threadId: 'thread-1', runId: 'run-1' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-review-'));
  const workspace = join(root, 'workspace'); const storage = join(root, 'state');
  mkdirSync(workspace);
  const events: { workspace: string; reviewId: string }[] = [];
  const store = new CodeReviewStore(storage, (event) => events.push(event));
  const write = (path: string, contents: string | Buffer) => writeFileSync(join(workspace, path), contents);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { root, workspace, storage, events, store, write, git, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
const addFinding = (anchor?: { path: string; side: 'before' | 'after'; startLine: number; endLine: number }): ReviewMutation => ({
  kind: 'finding', finding: { title: 'Check boundary', body: 'The empty case needs handling.', severity: 'medium', ...(anchor ? { anchor } : {}) },
});

test('selected non-Git snapshots persist immutable line ranges and whole-file freshness privately', async () => {
  const f = fixture();
  try {
    f.write('code.ts', 'first\nsecond\nthird\nfourth');
    const input = { title: 'Review parser', scope: { kind: 'file' as const, path: 'code.ts', startLine: 2, endLine: 3 }, conversationId: 'chat-1' };
    const review = await f.store.create(f.workspace, input, agent);
    assert.equal(review.files[0].after, 'second\nthird\n'); assert.equal(review.files[0].startLine, 2);
    assert.equal(review.files[0].freshness, 'unchanged'); assert.deepEqual(review.author, agent);
    assert.equal(f.events.length, 1);
    const reloaded = new CodeReviewStore(f.storage).read(f.workspace, review.id);
    assert.deepEqual(reloaded, review);
    assert.equal(new CodeReviewStore(f.storage).list(f.workspace)[0].fileCount, 1);
    const directory = join(f.storage, readdirSync(f.storage)[0]);
    assert.equal(statSync(f.storage).mode & 0o777, 0o700);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, `${review.id}.json`)).mode & 0o777, 0o600);
    f.write('code.ts', 'different outside selection\nsecond\nthird\nfourth');
    const changed = f.store.read(f.workspace, review.id);
    assert.equal(changed.files[0].freshness, 'changed'); assert.equal(changed.files[0].after, 'second\nthird\n');
    await assert.rejects(f.store.mutate(f.workspace, review.id, 1, { kind: 'decision', decision: 'approved' }, human), /changed/i);
    rmSync(join(f.workspace, 'code.ts'));
    assert.equal(f.store.read(f.workspace, review.id).files[0].freshness, 'missing');
  } finally { f.dispose(); }
});

test('findings retain snapshot anchors and host authors; only humans resolve and decide', async () => {
  const f = fixture();
  try {
    f.write('code.ts', 'one\ntwo\nthree');
    let review = await f.store.create(f.workspace, { title: 'Review', scope: { kind: 'file', path: 'code.ts', startLine: 2, endLine: 3 } }, human);
    await assert.rejects(f.store.mutate(f.workspace, review.id, review.revision, addFinding({ path: 'code.ts', side: 'after', startLine: 1, endLine: 1 }), agent), /outside/);
    await assert.rejects(f.store.mutate(f.workspace, review.id, review.revision, addFinding({ path: 'other.ts', side: 'after', startLine: 1, endLine: 1 }), agent), /snapshot/);
    review = await f.store.mutate(f.workspace, review.id, review.revision, { ...addFinding({ path: 'code.ts', side: 'after', startLine: 2, endLine: 2 }), author: human } as ReviewMutation, agent);
    assert.equal(review.findings[0].author.kind, 'agent'); assert.equal(review.findings[0].comments[0].author.kind, 'agent');
    const findingId = review.findings[0].id;
    for (const status of ['resolved', 'dismissed'] as const) await assert.rejects(f.store.mutate(f.workspace, review.id, review.revision, { kind: 'status', findingId, status }, agent), /Only a person/);
    await assert.rejects(f.store.mutate(f.workspace, review.id, review.revision, { kind: 'decision', decision: 'approved' }, agent), /Only a person/);
    review = await f.store.mutate(f.workspace, review.id, review.revision, { kind: 'status', findingId, status: 'addressed' }, agent);
    assert.equal(review.findings[0].comments.at(-1)?.body, 'Changed status from open to addressed.');
    assert.deepEqual(review.findings[0].comments.at(-1)?.author, agent);
    await assert.rejects(f.store.mutate(f.workspace, review.id, review.revision, { kind: 'decision', decision: 'approved' }, human), /Resolve or dismiss/);
    review = await f.store.mutate(f.workspace, review.id, review.revision, { kind: 'reply', findingId, body: 'Confirmed in the snapshot.' }, human);
    review = await f.store.mutate(f.workspace, review.id, review.revision, { kind: 'status', findingId, status: 'resolved' }, human);
    assert.deepEqual(review.findings[0].comments.at(-1)?.author, human);
    review = await f.store.mutate(f.workspace, review.id, review.revision, { kind: 'decision', decision: 'approved' }, human);
    assert.equal(review.decision, 'approved'); assert.deepEqual(review.decisionBy, human);
    review = await f.store.mutate(f.workspace, review.id, review.revision, { kind: 'status', findingId, status: 'open' }, agent);
    assert.equal(review.decision, 'open'); assert.equal(review.decisionBy, undefined);
    review = await f.store.mutate(f.workspace, review.id, review.revision, { kind: 'status', findingId, status: 'dismissed' }, human);
    review = await f.store.mutate(f.workspace, review.id, review.revision, { kind: 'decision', decision: 'approved' }, human);
    review = await f.store.mutate(f.workspace, review.id, review.revision, addFinding(), agent);
    assert.equal(review.decision, 'open');
    f.write('code.ts', 'inserted\none\ntwo\nthree');
    assert.deepEqual(f.store.read(f.workspace, review.id).findings[0].anchor, { path: 'code.ts', side: 'after', startLine: 2, endLine: 2 });
  } finally { f.dispose(); }
});

test('selected blank lines retain their terminators and valid snapshot anchors', async () => {
  const f = fixture();
  try {
    for (const ending of ['\n', '\r\n']) {
      const full = `first${ending}${ending}last`;
      f.write('blank.ts', full);
      const blank = await f.store.create(f.workspace, { title: 'Blank line', scope: { kind: 'file', path: 'blank.ts', startLine: 2, endLine: 2 } }, human);
      assert.equal(blank.files[0].after, ending);
      const annotated = await f.store.mutate(f.workspace, blank.id, 1, addFinding({ path: 'blank.ts', side: 'after', startLine: 2, endLine: 2 }), agent);
      await assert.rejects(f.store.mutate(f.workspace, blank.id, annotated.revision,
        addFinding({ path: 'blank.ts', side: 'after', startLine: 3, endLine: 3 }), agent), /outside/);
      const range = await f.store.create(f.workspace, { title: 'Ending blank', scope: { kind: 'file', path: 'blank.ts', startLine: 1, endLine: 2 } }, human);
      assert.equal(range.files[0].after, `first${ending}${ending}`);
      await f.store.mutate(f.workspace, range.id, 1, addFinding({ path: 'blank.ts', side: 'after', startLine: 1, endLine: 2 }), agent);
      const whole = await f.store.create(f.workspace, { title: 'Whole file', scope: { kind: 'file', path: 'blank.ts' } }, human);
      assert.equal(whole.files[0].after, full);
    }
  } finally { f.dispose(); }
});

test('terminal newline sentinels and empty files never create phantom anchors', async () => {
  const f = fixture();
  try {
    f.git('init', '-q'); f.write('code.ts', 'before\r\n'); f.git('add', '.'); f.git('commit', '-qm', 'base'); f.write('code.ts', 'after\r\n');
    const changes = await f.store.create(f.workspace, { title: 'Terminated lines', scope: { kind: 'changes' } }, human);
    assert.equal(changes.files[0].before, 'before\r\n'); assert.equal(changes.files[0].after, 'after\r\n');
    for (const side of ['before', 'after'] as const) {
      await assert.rejects(f.store.mutate(f.workspace, changes.id, 1, addFinding({ path: 'code.ts', side, startLine: 2, endLine: 2 }), agent), /outside/);
    }
    await assert.rejects(f.store.create(f.workspace, { title: 'Phantom range', scope: { kind: 'file', path: 'code.ts', startLine: 2, endLine: 2 } }, human), /outside/);
    f.write('empty.ts', '');
    const empty = await f.store.create(f.workspace, { title: 'Empty file', scope: { kind: 'file', path: 'empty.ts' } }, human);
    assert.equal(empty.files[0].after, '');
    await assert.rejects(f.store.mutate(f.workspace, empty.id, 1, addFinding({ path: 'empty.ts', side: 'after', startLine: 1, endLine: 1 }), agent), /outside/);
    await assert.rejects(f.store.create(f.workspace, { title: 'Empty range', scope: { kind: 'file', path: 'empty.ts', startLine: 1, endLine: 1 } }, human), /outside/);
  } finally { f.dispose(); }
});

test('optimistic revisions reject competing changes and concurrent creation loses no records', async () => {
  const f = fixture();
  try {
    f.write('a.ts', 'const a = 1;');
    const reviews = await Promise.all(Array.from({ length: 5 }, (_, index) => f.store.create(f.workspace,
      { title: `Review ${index}`, scope: { kind: 'file', path: 'a.ts' } }, human)));
    assert.equal(f.store.list(f.workspace).length, 5);
    const first = reviews[0];
    const otherStore = new CodeReviewStore(f.storage);
    await f.store.mutate(f.workspace, first.id, first.revision, addFinding(), agent);
    await assert.rejects(otherStore.mutate(f.workspace, first.id, first.revision, { kind: 'rename', title: 'Lost update' }, human), /changed/);
    assert.equal(f.store.read(f.workspace, first.id).findings.length, 1);
  } finally { f.dispose(); }
});

test('Git captures HEAD to working state including staged, unstaged, untracked and deleted files', async () => {
  const f = fixture();
  try {
    f.git('init', '-q'); f.write('edit.ts', 'original\n'); f.write('delete.ts', 'old\n'); f.git('add', '.'); f.git('commit', '-qm', 'base');
    f.write('edit.ts', 'staged\n'); f.git('add', 'edit.ts'); f.write('edit.ts', 'working\n');
    f.write('new.ts', 'new\n'); rmSync(join(f.workspace, 'delete.ts'));
    const indexBefore = f.git('diff', '--cached');
    let review = await f.store.create(f.workspace, { title: 'Changes', scope: { kind: 'changes' } }, agent);
    assert.deepEqual(review.files.map((file) => [file.path, file.status, file.before, file.after]), [
      ['delete.ts', 'deleted', 'old\n', null], ['edit.ts', 'modified', 'original\n', 'working\n'], ['new.ts', 'added', null, 'new\n'],
    ]);
    assert.equal(review.files[0].freshness, 'unchanged');
    review = await f.store.mutate(f.workspace, review.id, review.revision, addFinding({ path: 'delete.ts', side: 'before', startLine: 1, endLine: 1 }), agent);
    await assert.rejects(f.store.mutate(f.workspace, review.id, review.revision, addFinding({ path: 'delete.ts', side: 'after', startLine: 1, endLine: 1 }), agent), /outside/);
    assert.equal(f.git('diff', '--cached'), indexBefore); assert.equal(readFileSync(join(f.workspace, 'edit.ts'), 'utf8'), 'working\n');
  } finally { f.dispose(); }
});

test('unborn repositories and nested workspaces capture only their own files', async () => {
  const f = fixture();
  try {
    f.git('init', '-q'); f.write('root.ts', 'root'); mkdirSync(join(f.workspace, 'sub')); f.write('sub/staged.ts', 'staged'); f.git('add', '.'); f.write('sub/new.ts', 'new');
    const nested = join(f.workspace, 'sub');
    const review = await f.store.create(nested, { title: 'Initial', scope: { kind: 'changes' } }, human);
    assert.deepEqual(review.files.map((file) => file.path), ['new.ts', 'staged.ts']);
    assert(review.files.every((file) => file.status === 'added' && file.before === null));
    f.git('add', '.'); f.git('commit', '-qm', 'base'); f.write('sub/staged.ts', 'changed'); f.write('root.ts', 'other change');
    const next = await f.store.create(nested, { title: 'Nested', scope: { kind: 'changes' } }, human);
    assert.deepEqual(next.files.map((file) => [file.path, file.before]), [['staged.ts', 'staged']]);
  } finally { f.dispose(); }
});

test('approval detects newly untracked changes and concurrent edits made during capture', async () => {
  const f = fixture();
  try {
    f.git('init', '-q'); f.write('a.ts', 'original'); f.git('add', '.'); f.git('commit', '-qm', 'base'); f.write('a.ts', 'changed');
    const review = await f.store.create(f.workspace, { title: 'Changes', scope: { kind: 'changes' } }, human);
    f.write('new.ts', 'not reviewed');
    await assert.rejects(f.store.mutate(f.workspace, review.id, 1, { kind: 'decision', decision: 'approved' }, human), /differ/);
    rmSync(join(f.workspace, 'new.ts'));
    const approval = f.store.mutate(f.workspace, review.id, 1, { kind: 'decision', decision: 'approved' }, human);
    await f.store.mutate(f.workspace, review.id, 1, addFinding(), agent);
    await assert.rejects(approval, /changed/);
    assert.equal(f.store.read(f.workspace, review.id).decision, 'open');
  } finally { f.dispose(); }
});

test('approval succeeds on unchanged Git snapshots, including unchanged deletions', async () => {
  const f = fixture();
  try {
    f.git('init', '-q'); f.write('a.ts', 'old'); f.git('add', '.'); f.git('commit', '-qm', 'base'); rmSync(join(f.workspace, 'a.ts'));
    const review = await f.store.create(f.workspace, { title: 'Deletion', scope: { kind: 'changes' } }, human);
    assert.equal(review.files[0].beforeMode, '100644'); assert.equal(review.files[0].afterMode, undefined);
    const approved = await f.store.mutate(f.workspace, review.id, 1, { kind: 'decision', decision: 'approved' }, human);
    assert.equal(approved.decision, 'approved');
  } finally { f.dispose(); }
});

test('executable-only Git changes are captured and later mode changes block approval', async () => {
  const f = fixture();
  try {
    f.git('init', '-q'); f.git('config', 'core.filemode', 'true'); f.write('run.sh', '#!/bin/sh\nexit 0\n');
    chmodSync(join(f.workspace, 'run.sh'), 0o644); f.git('add', '.'); f.git('commit', '-qm', 'base');
    chmodSync(join(f.workspace, 'run.sh'), 0o755);
    const review = await f.store.create(f.workspace, { title: 'Executable', scope: { kind: 'changes' } }, human);
    assert.equal(review.files[0].before, review.files[0].after);
    assert.equal(review.files[0].beforeMode, '100644'); assert.equal(review.files[0].afterMode, '100755');
    assert.equal(review.files[0].freshness, 'unchanged');
    const approved = await f.store.mutate(f.workspace, review.id, 1, { kind: 'decision', decision: 'approved' }, human);
    assert.equal(approved.decision, 'approved');
    const selected = await f.store.create(f.workspace, { title: 'Selected executable', scope: { kind: 'file', path: 'run.sh' } }, human);
    assert.equal(selected.files[0].beforeMode, undefined); assert.equal(selected.files[0].afterMode, '100755');
    chmodSync(join(f.workspace, 'run.sh'), 0o644);
    assert.equal(f.store.read(f.workspace, review.id).files[0].freshness, 'changed');
    assert.equal(f.store.read(f.workspace, selected.id).files[0].freshness, 'changed');
    await assert.rejects(f.store.mutate(f.workspace, selected.id, 1, { kind: 'decision', decision: 'approved' }, human), /changed/);
    await assert.rejects(f.store.mutate(f.workspace, review.id, approved.revision, { kind: 'decision', decision: 'approved' }, human), /changed/);
  } finally { f.dispose(); }
});

test('workspace identity, traversal, symlink escapes, and unsafe snapshot types fail closed', async () => {
  const f = fixture();
  try {
    f.write('a.ts', 'safe'); mkdirSync(join(f.root, 'other')); writeFileSync(join(f.root, 'outside.ts'), 'private');
    const review = await f.store.create(f.workspace, { title: 'Safe', scope: { kind: 'file', path: 'a.ts' } }, human);
    assert.throws(() => f.store.read(join(f.root, 'other'), review.id), /not found/);
    assert.throws(() => f.store.read(f.workspace, '../outside'), /identity/);
    for (const path of ['../outside.ts', '/etc/passwd', 'a/../../outside.ts', '.git/config', 'a\\b', 'a\0b']) {
      await assert.rejects(f.store.create(f.workspace, { title: 'Unsafe', scope: { kind: 'file', path } }, human), /relative files/);
    }
    symlinkSync(join(f.root, 'outside.ts'), join(f.workspace, 'linked.ts'));
    await assert.rejects(f.store.create(f.workspace, { title: 'Unsafe', scope: { kind: 'file', path: 'linked.ts' } }, human), /symlinks/);
    symlinkSync(f.root, join(f.workspace, 'escaped'));
    await assert.rejects(f.store.create(f.workspace, { title: 'Unsafe', scope: { kind: 'file', path: 'escaped/outside.ts' } }, human), /escapes/);
    rmSync(join(f.workspace, 'a.ts')); symlinkSync(join(f.root, 'outside.ts'), join(f.workspace, 'a.ts'));
    assert.equal(f.store.read(f.workspace, review.id).files[0].freshness, 'unavailable');
    await assert.rejects(f.store.mutate(f.workspace, review.id, 1, { kind: 'decision', decision: 'approved' }, human), /changed/);
  } finally { f.dispose(); }
});

test('binary, non-UTF8, oversized and excessive file captures reject rather than silently omit', async () => {
  const f = fixture();
  try {
    f.git('init', '-q'); f.write('valid.ts', 'valid'); f.write('binary.bin', Buffer.from([0, 1, 2]));
    await assert.rejects(f.store.create(f.workspace, { title: 'Binary', scope: { kind: 'changes' } }, human), /binary files/);
    rmSync(join(f.workspace, 'binary.bin')); f.write('invalid.txt', Buffer.from([0xff, 0xfe]));
    await assert.rejects(f.store.create(f.workspace, { title: 'Encoding', scope: { kind: 'changes' } }, human), /UTF-8/);
    rmSync(join(f.workspace, 'invalid.txt')); f.write('large.ts', Buffer.alloc(SNAPSHOT_LIMITS.fileBytes + 1, 97));
    await assert.rejects(f.store.create(f.workspace, { title: 'Large', scope: { kind: 'file', path: 'large.ts', startLine: 1, endLine: 1 } }, human), /512 KiB/);
    rmSync(join(f.workspace, 'large.ts'));
    for (let index = 0; index < SNAPSHOT_LIMITS.files; index += 1) f.write(`f${index}.ts`, 'x');
    await assert.rejects(f.store.create(f.workspace, { title: 'Many', scope: { kind: 'changes' } }, human), /limit is 80/);
    assert.deepEqual(f.store.list(f.workspace), []);
  } finally { f.dispose(); }
});

test('Git external diff/textconv/fsmonitor commands are never run during snapshot capture', async () => {
  const f = fixture();
  try {
    const marker = join(f.root, 'executed'); const script = join(f.root, 'external.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(script, 0o700);
    f.git('init', '-q'); f.write('a.ts', 'before'); f.write('.gitattributes', '*.ts diff=custom'); f.git('add', '.'); f.git('commit', '-qm', 'base');
    f.git('config', 'diff.external', script); f.git('config', 'diff.custom.textconv', script); f.git('config', 'core.fsmonitor', script);
    f.write('a.ts', 'after');
    const review = await f.store.create(f.workspace, { title: 'Changes', scope: { kind: 'changes' } }, human);
    assert.equal(review.files[0].after, 'after'); assert.throws(() => statSync(marker), /ENOENT/);
  } finally { f.dispose(); }
});

test('invalid ranges, missing Git and aborted mutations report actionable errors without writes', async () => {
  const f = fixture();
  try {
    f.write('a.ts', 'one\ntwo');
    await assert.rejects(f.store.create(f.workspace, { title: 'No Git', scope: { kind: 'changes' } }, human), /Git repository/);
    for (const scope of [{ kind: 'file', path: 'a.ts', startLine: 0 }, { kind: 'file', path: 'a.ts', startLine: 2, endLine: 1 }, { kind: 'file', path: 'a.ts', endLine: 3 }] as const) {
      await assert.rejects(f.store.create(f.workspace, { title: 'Bad range', scope }, human), /range|line numbers/);
    }
    const controller = new AbortController();
    const pending = f.store.create(f.workspace, { title: 'Cancelled', scope: { kind: 'file', path: 'a.ts' } }, human, controller.signal);
    controller.abort(); await assert.rejects(pending, /abort/i); assert.equal(f.store.list(f.workspace).length, 0);
    const review = await f.store.create(f.workspace, { title: 'Review', scope: { kind: 'file', path: 'a.ts' } }, human);
    await assert.rejects(f.store.mutate(f.workspace, review.id, 1, addFinding(), agent, controller.signal), /abort/i);
    assert.equal(f.store.read(f.workspace, review.id).revision, 1);
  } finally { f.dispose(); }
});

test('corrupt, oversized, symlinked and cross-workspace persisted records are rejected', async () => {
  const f = fixture();
  try {
    f.write('a.ts', 'safe');
    const review = await f.store.create(f.workspace, { title: 'Review', scope: { kind: 'file', path: 'a.ts' } }, human);
    const directory = join(f.storage, createHash('sha256').update(f.workspace).digest('hex'));
    const path = join(directory, `${review.id}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as CodeReview;
    writeFileSync(path, JSON.stringify({ ...raw, workspace: '/different' })); assert.throws(() => f.store.read(f.workspace, review.id), /metadata/);
    writeFileSync(path, JSON.stringify({ ...raw, files: [{ ...raw.files[0], path: '../outside' }] })); assert.throws(() => f.store.read(f.workspace, review.id), /relative files/);
    writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1, 32)); assert.throws(() => f.store.read(f.workspace, review.id), /too large/);
    rmSync(path); writeFileSync(join(f.root, 'record.json'), JSON.stringify(raw)); symlinkSync(join(f.root, 'record.json'), path);
    assert.throws(() => f.store.read(f.workspace, review.id), /invalid/);
  } finally { f.dispose(); }
});
