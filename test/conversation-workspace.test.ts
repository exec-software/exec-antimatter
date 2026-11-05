import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import * as conversations from '../src/main/conversations';
import {
  assertStreamConversation, conversationWorkspaceProjectRoot, resolveConversationWorkspace, transcriptWorkspace,
} from '../src/main/conversationWorkspace';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'antimatter-workspace-')));
  const original = conversations.location();
  const storePath = join(root, 'conversations.json');
  conversations.useStorePath(storePath);
  t.after(() => { conversations.useStorePath(original); rmSync(root, { recursive: true, force: true }); });
  const a = join(root, 'alpha');
  const b = join(root, 'beta');
  mkdirSync(a); mkdirSync(b);
  return { root, a, b, storePath };
}

const contextFor = (path: string) => ({
  key: JSON.stringify([1, path, dirname(path), true, true, 7, 'write', 24_000]),
});
const create = (directory: string | null = null) => conversations.createThread({
  id: 'chat', projectId: 'inbox', createdAt: 1, directory,
}, conversations.snapshot().revision);

test('legacy null-folder chats recover the exact saved tool workspace, not its broader project root', (t) => {
  const { a, b } = fixture(t);
  const thread = create();
  const resolved = resolveConversationWorkspace(thread, {
    defaultWorkspace: b, defaultConfirmed: true, context: contextFor(a),
  });
  assert.equal(resolved.path, a);
  assert.equal(resolved.confirmed, false, 'old instructions do not prove that anyone granted access');
  assert.equal(resolved.available, true);
  assert.equal(conversationWorkspaceProjectRoot(resolved), null, 'no implicit remote project grant');
  const bound = conversations.bindWorkspace(thread.id, resolved.binding, thread.revision);
  assert.deepEqual(resolveConversationWorkspace(bound, {
    defaultWorkspace: b, defaultConfirmed: true, context: contextFor(b),
  }).binding, resolved.binding);
});

test('binding survives reload and changing the machine default without changing either origin’s project', (t) => {
  const { a, b, storePath } = fixture(t);
  const thread = create();
  const resolved = resolveConversationWorkspace(thread, { defaultWorkspace: a, defaultConfirmed: true });
  conversations.bindWorkspace(thread.id, resolved.binding);
  conversations.useStorePath(storePath);
  const restored = conversations.snapshot().threads[0];
  const desktop = resolveConversationWorkspace(restored, { defaultWorkspace: b, defaultConfirmed: true });
  const phone = resolveConversationWorkspace(restored, { defaultWorkspace: b, defaultConfirmed: false });
  assert.deepEqual(desktop, phone);
  assert.equal(desktop.needsBinding, false);
  assert.equal(conversationWorkspaceProjectRoot(phone), a);
  assert.equal(JSON.parse(readFileSync(storePath, 'utf8')).threads[0].workspaceBinding.path, a);
  assert.equal((conversations.load().threads[0].workspaceBinding as { path: string }).path, a);
  const remote = JSON.stringify(conversations.remoteProjection(thread.id));
  assert.equal(remote.includes(a), false, 'private binding paths never cross the remote projection');
  assert.equal(remote.includes('workspaceBinding'), false);
});

test('matching already-confirmed default preserves permission, but confirmation never follows an unconfirmed default', (t) => {
  const { a } = fixture(t);
  const thread = create();
  assert.equal(resolveConversationWorkspace(thread, { defaultWorkspace: a, defaultConfirmed: true, context: contextFor(a) }).confirmed, true);
  const inherited = resolveConversationWorkspace(thread, { defaultWorkspace: a, defaultConfirmed: false, context: contextFor(a) });
  const bound = conversations.bindWorkspace(thread.id, inherited.binding);
  assert.equal(resolveConversationWorkspace(bound, { defaultWorkspace: a, defaultConfirmed: true }).confirmed, false,
    'a later global confirmation cannot silently upgrade this conversation');
  const confirmed = conversations.confirmWorkspace(thread.id, bound.revision);
  assert.equal(confirmed.workspaceBinding?.confirmed, true);
});

test('explicit folder change resets the binding, and explicit clearing skips older transcript context', (t) => {
  const { a, b } = fixture(t);
  let thread = create(a);
  thread = conversations.bindWorkspace(thread.id, resolveConversationWorkspace(thread, { defaultWorkspace: b, defaultConfirmed: false }).binding);
  let saved = conversations.load();
  saved.threads[0].directory = b;
  conversations.save(saved);
  thread = conversations.snapshot().threads[0];
  assert.equal(thread.workspaceBinding, null);
  let next = resolveConversationWorkspace(thread, { defaultWorkspace: a, defaultConfirmed: false, context: contextFor(a) });
  assert.deepEqual(next.binding, { path: b, confirmed: true });
  conversations.bindWorkspace(thread.id, next.binding);
  saved = conversations.load();
  saved.threads[0].directory = null;
  conversations.save(saved);
  thread = conversations.snapshot().threads[0];
  assert.equal(thread.workspaceBinding, null);
  next = resolveConversationWorkspace(thread, { defaultWorkspace: b, defaultConfirmed: false, context: contextFor(a) });
  assert.deepEqual(next.binding, { path: b, confirmed: false }, 'clearing must not resurrect the old selected folder');
});

test('renderer checkpoints cannot rewrite or grant a host binding, including on a new chat', (t) => {
  const { a, b } = fixture(t);
  conversations.save({ threads: [{ id: 'chat', title: 'Chat', createdAt: 1, directory: null,
    workspaceBinding: { path: b, confirmed: true } }] });
  let thread = conversations.snapshot().threads[0];
  assert.equal(thread.workspaceBinding, undefined);
  thread = conversations.bindWorkspace(thread.id, { path: a, confirmed: false });
  const saved = conversations.load();
  saved.threads[0].workspaceBinding = { path: b, confirmed: true };
  conversations.save(saved);
  assert.deepEqual(conversations.snapshot().threads[0].workspaceBinding, { path: a, confirmed: false });
  assert.deepEqual(conversations.bindWorkspace('chat', { path: b, confirmed: true }).workspaceBinding, { path: a, confirmed: false });
  const metadata = conversations.chatMetadata();
  metadata[0].workspaceBinding!.confirmed = true;
  assert.equal(conversations.chatMetadata()[0].workspaceBinding?.confirmed, false, 'metadata callers cannot mutate the grant');
  assert.throws(() => conversations.confirmWorkspace('chat', thread.revision - 1), conversations.RevisionConflictError);
});

test('deleted bound and saved legacy workspaces remain unavailable instead of falling back to another project', (t) => {
  const { a, b } = fixture(t);
  const thread = conversations.bindWorkspace(create(a).id, { path: a, confirmed: true });
  rmSync(a, { recursive: true });
  const missing = resolveConversationWorkspace(thread, { defaultWorkspace: b, defaultConfirmed: true });
  assert.equal(missing.path, a);
  assert.equal(missing.available, false);
  assert.equal(conversationWorkspaceProjectRoot(missing), null);
  assert.throws(() => conversations.confirmWorkspace(thread.id), /missing or inaccessible/);
  const legacy = resolveConversationWorkspace({ directory: null }, { defaultWorkspace: b, defaultConfirmed: true, context: contextFor(a) });
  assert.equal(legacy.path, a);
  assert.equal(legacy.available, false);
});

test('file paths and symlink replacements cannot become another project under an old grant', (t) => {
  const { a, b, root } = fixture(t);
  const alias = join(root, 'chosen');
  symlinkSync(a, alias);
  const initial = resolveConversationWorkspace({ directory: alias }, { defaultWorkspace: b, defaultConfirmed: false });
  assert.equal(initial.path, a);
  rmSync(a, { recursive: true });
  symlinkSync(b, a);
  const changed = resolveConversationWorkspace({ workspaceBinding: initial.binding }, { defaultWorkspace: b, defaultConfirmed: true });
  assert.equal(changed.path, a);
  assert.equal(changed.available, false);
  assert.match(changed.reason!, /different folder/);
  const file = join(root, 'not-a-folder');
  writeFileSync(file, 'data');
  assert.equal(resolveConversationWorkspace({ directory: file }, { defaultWorkspace: b, defaultConfirmed: true }).available, false);
});

test('an explicit native picker reselects the same symlink spelling and stale UI saves preserve the new grant', (t) => {
  const { a, b, root } = fixture(t);
  const alias = join(root, 'chosen');
  symlinkSync(a, alias);
  let thread = create(alias);
  thread = conversations.setWorkspaceDirectory(thread.id, alias, thread.revision);
  assert.deepEqual(thread.workspaceBinding, { path: a, confirmed: true });
  rmSync(alias);
  symlinkSync(b, alias);
  // The old canonical root is still available, so selection must be explicit even without error.
  assert.equal(resolveConversationWorkspace(thread, { defaultWorkspace: b, defaultConfirmed: true }).path, a);
  const stale = conversations.load();
  thread = conversations.setWorkspaceDirectory(thread.id, alias, thread.revision);
  assert.deepEqual(thread.workspaceBinding, { path: b, confirmed: true });
  conversations.save(stale);
  assert.deepEqual(conversations.snapshot().threads[0].workspaceBinding, { path: b, confirmed: true });
  const followup = conversations.load();
  followup.threads[0].workspaceBinding = null;
  conversations.save(followup);
  assert.deepEqual(conversations.snapshot().threads[0].workspaceBinding, { path: b, confirmed: true },
    'the renderer callback after selection cannot undo the host picker binding');
  assert.throws(() => conversations.setWorkspaceDirectory(thread.id, alias, thread.revision - 1), conversations.RevisionConflictError);
  rmSync(alias);
  assert.throws(() => conversations.setWorkspaceDirectory(thread.id, alias), /missing or inaccessible/);
});

test('unknown or malformed standing-context formats do not infer a workspace from summary or transcript text', (t) => {
  const { a, b } = fixture(t);
  for (const key of ['not json', JSON.stringify([2, a]), JSON.stringify([1, 'relative', a, true, true, 1, 'write', 10])]) {
    assert.equal(transcriptWorkspace({ key }), null);
    const resolved = resolveConversationWorkspace({}, { defaultWorkspace: b, defaultConfirmed: false, context: { key } });
    assert.deepEqual(resolved.binding, { path: b, confirmed: false });
  }
});

test('only the host’s explicit desktop avatar route accepts a non-durable conversation identity', () => {
  assert.throws(() => assertStreamConversation('deleted-chat', null), /no longer available/);
  assert.throws(() => assertStreamConversation('deleted-chat', null, { remote: true }), /no longer available/);
  assert.doesNotThrow(() => assertStreamConversation('avatar-private-session', null, { transientAvatar: true }));
  assert.throws(() => assertStreamConversation('avatar-private-session', null, { transientAvatar: true, remote: true }), /private desktop session/);
  assert.throws(() => assertStreamConversation(undefined, null, { transientAvatar: true }), /private desktop session/);
  const durable = { path: '/chosen', confirmed: true, available: true };
  assert.throws(() => assertStreamConversation('saved-chat', durable, { transientAvatar: true }), /private desktop session/);
  assert.doesNotThrow(() => assertStreamConversation('saved-chat', durable));
  assert.doesNotThrow(() => assertStreamConversation('saved-chat', durable, { remote: true }));
});
