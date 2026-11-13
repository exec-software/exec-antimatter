import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatNotesStore } from '../src/main/chatNotes';
import { registerChatNotesIpc } from '../src/main/chatNotesIpc';
import { CHAT_NOTES_IPC, MAX_CHAT_NOTE_BYTES, type ChatNote, type ChatNotesAPI } from '../src/api/chatNotes';
import { ChatNoteDraft } from '../renderer/src/lib/chatNotes';
import { notesMarkdownHtml } from '../renderer/src/components/chat/notesMarkdown';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'chat-notes-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const chats = new Set(['chat-a', 'chat-b', '../../outside']);
  const options = { directory: () => join(directory, 'notes'), conversationExists: (id: string) => chats.has(id), now: () => 1234 };
  return { directory, chats, options, store: new ChatNotesStore(options) };
}

test('notes survive restart, remain separate from transcripts, and use private revisions', (t) => {
  const { store, directory, options } = fixture(t);
  writeFileSync(join(directory, 'conversations.json'), 'unchanged transcript');
  assert.deepEqual(store.get('chat-a'), { threadId: 'chat-a', markdown: '', revision: 0, updatedAt: null });
  const saved = store.save({ threadId: 'chat-a', markdown: '# Plan\n\n**Ship** [docs](https://example.com)', expectedRevision: 0 });
  assert.equal(saved.saved, true);
  assert.equal(saved.note.revision, 1);
  assert.deepEqual(new ChatNotesStore(options).get('chat-a'), saved.note);
  assert.equal(store.get('chat-b').markdown, '');
  assert.equal(readFileSync(join(directory, 'conversations.json'), 'utf8'), 'unchanged transcript');
  assert.equal(statSync(options.directory()).mode & 0o777, 0o700);
  const file = join(options.directory(), readdirSync(options.directory())[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const stale = store.save({ threadId: 'chat-a', markdown: 'lost update', expectedRevision: 0 });
  assert.equal(stale.saved, false);
  assert.deepEqual(stale.note, saved.note);
  assert.equal(store.save({ threadId: 'chat-a', markdown: saved.note.markdown, expectedRevision: 1 }).note.revision, 1);
  assert.equal(store.save({ threadId: 'chat-a', markdown: '', expectedRevision: 1 }).note.revision, 2);
});

test('chat deletion prevents orphan creation and removes owned notes', (t) => {
  const { store, chats, options } = fixture(t);
  assert.throws(() => store.save({ threadId: 'missing', markdown: 'orphan', expectedRevision: 0 }), /no longer exists/);
  store.save({ threadId: 'chat-a', markdown: 'old', expectedRevision: 0 });
  store.save({ threadId: 'chat-b', markdown: 'keep', expectedRevision: 0 });
  chats.delete('chat-a');
  assert.throws(() => store.get('chat-a'), /no longer exists/);
  assert.throws(() => store.save({ threadId: 'chat-a', markdown: 'revive', expectedRevision: 1 }), /no longer exists/);
  assert.deepEqual(store.pruneDeleted(), ['chat-a']);
  assert.equal(readdirSync(options.directory()).length, 1);
  assert.equal(store.get('chat-b').markdown, 'keep');
});

test('note IDs cannot escape storage; invalid input, files and symlinks are rejected', (t) => {
  const { store, directory, options } = fixture(t);
  store.save({ threadId: '../../outside', markdown: 'safe', expectedRevision: 0 });
  const file = join(options.directory(), readdirSync(options.directory())[0]);
  assert.match(file, /notes\/[a-f0-9]{64}\.json$/);
  assert.throws(() => store.get('bad\0id'), /Invalid chat ID/);
  assert.throws(() => store.save({ threadId: 'chat-a', markdown: 'x', expectedRevision: -1 }), /revision/);
  assert.throws(() => store.save({ threadId: 'chat-a', markdown: '\0', expectedRevision: 0 }), /Markdown/);
  assert.throws(() => store.save({ threadId: 'chat-a', markdown: 'ü'.repeat(MAX_CHAT_NOTE_BYTES), expectedRevision: 0 }), /Markdown/);
  // Escaped JSON can be substantially larger than the Markdown byte limit.
  const escaped = '\u0001'.repeat(MAX_CHAT_NOTE_BYTES);
  store.save({ threadId: 'chat-a', markdown: escaped, expectedRevision: 0 });
  assert.equal(store.get('chat-a').markdown, escaped);
  rmSync(file);
  const outside = join(directory, 'outside.json');
  writeFileSync(outside, '{}');
  symlinkSync(outside, file);
  assert.throws(() => store.get('../../outside'), /safely/);
  rmSync(options.directory(), { recursive: true });
  symlinkSync(directory, options.directory());
  assert.throws(() => store.get('chat-a'), /not safe/);
  assert.throws(() => store.remove('chat-a'), /not safe/);
});

test('notes IPC checks the sender before reading or writing and broadcasts accepted revisions', (t) => {
  const { store } = fixture(t);
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
  const changes: unknown[] = [];
  registerChatNotesIpc({ ipc: { handle: (channel, handler) => { handlers.set(channel, handler); } }, store,
    assertTrusted: (event) => { if (event !== 'trusted') { throw new Error('Untrusted'); } }, broadcast: (change) => { changes.push(change); } });
  assert.throws(() => handlers.get(CHAT_NOTES_IPC.get)!('other', 'chat-a'), /Untrusted/);
  assert.throws(() => handlers.get(CHAT_NOTES_IPC.save)!('other', { threadId: 'chat-a', markdown: 'bad', expectedRevision: 0 }), /Untrusted/);
  handlers.get(CHAT_NOTES_IPC.save)!('trusted', { threadId: 'chat-a', markdown: 'good', expectedRevision: 0 });
  handlers.get(CHAT_NOTES_IPC.save)!('trusted', { threadId: 'chat-a', markdown: 'stale', expectedRevision: 0 });
  assert.deepEqual(changes, [{ threadId: 'chat-a', kind: 'saved', revision: 1 }]);
});

class Storage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const empty = (threadId = 'chat-a'): ChatNote => ({ threadId, markdown: '', revision: 0, updatedAt: null });

test('autosave serializes overlapping changes and close flushes the latest text', async (t) => {
  const storage = new Storage();
  let current = empty();
  const gate = deferred<void>();
  const calls: string[] = [];
  const api: ChatNotesAPI = { get: async () => current, onChanged: () => () => {}, save: async (input) => {
    calls.push(input.markdown);
    if (calls.length === 1) { await gate.promise; }
    assert.equal(input.expectedRevision, current.revision);
    current = { ...current, markdown: input.markdown, revision: current.revision + 1, updatedAt: 42 };
    return { saved: true, note: current };
  } };
  const draft = new ChatNoteDraft('chat-a', api, storage, 60000);
  t.after(() => draft.dispose());
  await draft.flush();
  draft.change('first');
  const first = draft.flush();
  await Promise.resolve();
  draft.change('latest');
  const second = draft.flush();
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.deepEqual(calls, ['first', 'latest']);
  assert.equal(current.markdown, 'latest');
  assert.equal(draft.getSnapshot().dirty, false);
  assert.equal(storage.values.size, 0);
});

test('draft recovery, revision conflicts and explicit overwrite preserve local edits', async (t) => {
  const storage = new Storage();
  let current = empty();
  let failing = true;
  const api: ChatNotesAPI = { get: async () => current, onChanged: () => () => {}, save: async (input) => {
    if (failing) { throw new Error('Disk full'); }
    if (input.expectedRevision !== current.revision) { return { saved: false, reason: 'conflict', note: current }; }
    current = { ...current, markdown: input.markdown, revision: current.revision + 1, updatedAt: 42 };
    return { saved: true, note: current };
  } };
  const first = new ChatNoteDraft('chat-a', api, storage, 60000);
  await first.flush();
  first.change('my recovered draft');
  assert.equal(await first.flush(), 'Disk full');
  first.dispose();
  current = { ...current, markdown: 'another window', revision: 1, updatedAt: 2 };
  const recovered = new ChatNoteDraft('chat-a', api, storage, 60000);
  t.after(() => recovered.dispose());
  assert.match((await recovered.flush())!, /conflicting/);
  assert.equal(recovered.getSnapshot().markdown, 'my recovered draft');
  assert.equal(recovered.getSnapshot().conflict?.markdown, 'another window');
  failing = false;
  recovered.keepDraft();
  assert.equal(await recovered.flush(), null);
  assert.equal(current.markdown, 'my recovered draft');
  assert.equal(current.revision, 2);
  recovered.change('later draft');
  current = { ...current, markdown: 'keep server', revision: 3 };
  assert.match((await recovered.flush())!, /conflicting/);
  recovered.useSaved();
  assert.equal(recovered.getSnapshot().markdown, 'keep server');
  assert.equal(storage.values.size, 0);
});

test('deletion during an in-flight save cannot restore an orphan draft', async (t) => {
  const storage = new Storage();
  const gate = deferred<void>();
  let change!: Parameters<ChatNotesAPI['onChanged']>[0];
  const draft = new ChatNoteDraft('chat-a', { get: async () => empty(), onChanged: (cb) => { change = cb; return () => {}; }, save: async () => {
    await gate.promise;
    return { saved: true, note: { ...empty(), markdown: 'stale', revision: 1 } };
  } }, storage, 60000);
  t.after(() => draft.dispose());
  await draft.flush();
  draft.change('stale');
  const saving = draft.flush();
  await Promise.resolve();
  change({ kind: 'deleted', threadId: 'chat-a' });
  gate.resolve();
  await saving;
  draft.change('resurrect');
  assert.equal(draft.getSnapshot().deleted, true);
  assert.equal(storage.values.size, 0);
});

test('composition blocks close and cannot absorb another window’s revision', async (t) => {
  const storage = new Storage();
  let current = empty();
  let change!: Parameters<ChatNotesAPI['onChanged']>[0];
  const draft = new ChatNoteDraft('chat-a', { get: async () => current,
    onChanged: (cb) => { change = cb; return () => {}; }, save: async () => ({ saved: false, reason: 'conflict', note: current }),
  }, storage, 60000);
  t.after(() => draft.dispose());
  await draft.flush();
  draft.setComposing(true);
  current = { ...current, markdown: 'Other window', revision: 1 };
  change({ threadId: 'chat-a', kind: 'saved', revision: 1 });
  assert.match((await draft.flush())!, /Finish entering/);
  assert.equal(draft.getSnapshot().revision, 0);
  draft.change('日本語');
  draft.setComposing(false);
  assert.match((await draft.flush())!, /conflicting/);
  assert.equal(draft.getSnapshot().markdown, '日本語');
});

test('Markdown editor treats HTML and destinations as inert data', () => {
  const html = notesMarkdownHtml('## Safe\n\n**Bold** and [link](javascript:alert%281%29 "title")\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n![picture](https://tracking.example/pixel.png)\n\n- [x] Complete');
  assert.match(html, /<h2>Safe<\/h2>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /data-note-link="javascript:alert%281%29"/);
  assert.match(html, /data-note-link-title="title"/);
  assert.match(html, /data-note-image="https:\/\/tracking.example\/pixel.png"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<(?:script|img|iframe|a)(?:\s|>)/);
  assert.doesNotMatch(html, /<[^>]*\s(?:href|src|onerror)=/);
});
