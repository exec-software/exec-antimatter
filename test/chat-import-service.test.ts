import assert from 'node:assert/strict';
import { constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { ChatImportService } from '../src/main/chatImports/service';
import * as conversations from '../src/main/conversations';
import type { ImportedChatOrigin } from '../src/api/chatImports';

const exportText = (ids = ['session-one']) => JSON.stringify(ids.map((id) => ({ uuid: id, name: `Chat ${id}`,
  created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:01:00Z', chat_messages: [
    { uuid: `${id}-user`, sender: 'human', text: 'A synthetic import question.', created_at: '2026-09-01T10:00:00Z' },
    { uuid: `${id}-assistant`, sender: 'assistant', text: 'A synthetic answer.', created_at: '2026-09-01T10:01:00Z' },
  ] })));
const rolloutText = (id = 'codex-session') => [
  { type: 'session_meta', timestamp: '2026-09-01T10:00:00Z', payload: { id, cwd: '/never/open/this/path' } },
  { type: 'response_item', timestamp: '2026-09-01T10:01:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic Codex question' }] } },
].map((item) => JSON.stringify(item)).join('\n');
const opencodeText = (id = 'ses_opencode') => JSON.stringify({
  info: { id, title: 'Synthetic OpenCode session', version: '1.2.0', projectID: 'external-project',
    directory: '/never/open/opencode-workspace', time: { created: 1788256800000, updated: 1788256860000 } },
  messages: [
    { info: { id: `msg_${id}_user`, sessionID: id, role: 'user', time: { created: 1788256800000 } },
      parts: [{ id: `prt_${id}_user`, sessionID: id, messageID: `msg_${id}_user`, type: 'text', text: 'Synthetic OpenCode question' }] },
    { info: { id: `msg_${id}_assistant`, sessionID: id, parentID: `msg_${id}_user`, role: 'assistant',
      providerID: 'external-provider', modelID: 'external-model', time: { created: 1788256830000, completed: 1788256860000 } },
      parts: [{ id: `prt_${id}_assistant`, sessionID: id, messageID: `msg_${id}_assistant`, type: 'text', text: 'Synthetic OpenCode answer' }] },
  ],
});

function fixture(t: TestContext, origins: ImportedChatOrigin[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'antimatter-chat-import-service-'));
  const writes: Array<Parameters<conversations.importThreads>[0]> = [];
  const service = new ChatImportService({ origins: () => origins,
    import: (input) => { writes.push(structuredClone(input)); return { imported: input.conversations.map((_, index) => ({ id: `new-${index}` })), skipped: 0 }; } });
  const file = (name: string, text = exportText()) => { const path = join(directory, name); writeFileSync(path, text); return path; };
  t.after(() => { for (let owner = 1; owner <= 8; owner++) service.discard(owner); rmSync(directory, { recursive: true, force: true }); });
  return { directory, service, writes, file };
}

test('selected regular-file previews are read-only and expose summaries instead of transcript bytes or source paths', async (t) => {
  const { service, writes, file } = fixture(t);
  const path = file('conversations.json');
  const before = statSync(path);
  const preview = await service.prepare(1, [path], 'claude', 'files');
  assert.equal(writes.length, 0);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].messageCount, 2);
  assert.equal(preview.candidates[0].source, 'claude');
  assert.equal(preview.candidates[0].alreadyImported, false);
  assert.notEqual(preview.candidates[0].id, 'session-one');
  assert.doesNotMatch(JSON.stringify(preview), /synthetic import question|chat_messages|\/never\/open|conversations\.json/);
  const result = service.commit(1, { batchId: preview.batchId, ids: [preview.candidates[0].id], projectId: 'selected-project' });
  assert.deepEqual(result, { importedThreadIds: ['new-0'], skipped: 0 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].projectId, 'selected-project');
  assert.equal(writes[0].conversations[0].messages[0].content, 'A synthetic import question.');
  assert.equal(readFileSync(path, 'utf8'), exportText());
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  assert.throws(() => service.commit(1, { batchId: preview.batchId, ids: [preview.candidates[0].id], projectId: 'project' }), /expired/);
});

test('folder import visits regular JSONL sessions but never follows linked files or directories', async (t) => {
  const { service, writes, directory, file } = fixture(t);
  const selected = join(directory, 'selected');
  const nested = join(selected, 'nested');
  const outside = join(directory, 'outside');
  mkdirSync(nested, { recursive: true }); mkdirSync(outside);
  writeFileSync(join(nested, 'session.JSONL'), rolloutText('inside'));
  writeFileSync(join(selected, 'not-a-session.json'), exportText(['not-for-folder']));
  writeFileSync(join(outside, 'private.jsonl'), rolloutText('outside'));
  symlinkSync(outside, join(selected, 'linked-folder'), 'dir');
  symlinkSync(join(outside, 'private.jsonl'), join(selected, 'linked-file.jsonl'));
  const preview = await service.prepare(1, [selected], 'codex', 'folder');
  assert.equal(preview.fileCount, 1);
  assert.equal(preview.candidates.length, 1);
  assert.match(preview.warnings.join(' '), /Symbolic links.*not followed/);
  assert.equal(writes.length, 0);
  const rootLink = join(directory, 'root-link'); symlinkSync(selected, rootLink, 'dir');
  await assert.rejects(service.prepare(2, [rootLink], 'codex', 'folder'), /not a symbolic link/);
  const ordinaryFile = file('plain.json');
  await assert.rejects(service.prepare(2, [ordinaryFile], 'claude', 'folder'), /regular session folder/);
});

test('symbolic links directories and FIFOs selected as files are rejected without blocking', async (t) => {
  const { service, directory, file, writes } = fixture(t);
  const original = file('original.json');
  const linked = join(directory, 'linked.json'); symlinkSync(original, linked);
  const fakeFile = join(directory, 'directory.json'); mkdirSync(fakeFile);
  const fifo = join(directory, 'pipe.jsonl');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const preview = await service.prepare(1, [linked, fakeFile, fifo], 'claude', 'files');
  assert.equal(preview.candidates.length, 0);
  assert.equal(preview.warnings.length, 3);
  assert.match(preview.warnings.join(' '), /regular|symbolic|special/);
  assert.doesNotMatch(preview.warnings.join(' '), new RegExp(directory));
  assert.equal(writes.length, 0);
  assert.equal(readFileSync(original, 'utf8'), exportText());
});

test('malformed unsupported and mismatched-source files produce bounded inert diagnostics without source text', async (t) => {
  const { service, file, writes } = fixture(t);
  const paths = [file('broken.json', '{"secret":"do-not-echo-this"'), file('unrecognized.json', '{"token":"private-token"}'),
    file('notes.txt', 'not an export'), file('codex.jsonl', rolloutText())];
  const preview = await service.prepare(1, paths, 'claude', 'files');
  assert.equal(preview.candidates.length, 0);
  assert.equal(preview.warnings.length, 4);
  assert.match(preview.warnings.join(' '), /Invalid JSON|not a supported|different source|extracted JSON/);
  assert.doesNotMatch(JSON.stringify(preview), /do-not-echo-this|private-token|\/never\/open/);
  assert.equal(writes.length, 0);
});

test('invalid UTF-8 is rejected instead of silently changing otherwise parseable transcript text', async (t) => {
  const { service, file, writes } = fixture(t);
  const path = file('bad-encoding.json');
  const text = Buffer.from(exportText());
  text[text.indexOf('synthetic')] = 0xff;
  writeFileSync(path, text);
  const preview = await service.prepare(1, [path], 'claude', 'files');
  assert.equal(preview.candidates.length, 0);
  assert.match(preview.warnings[0], /invalid UTF-8/);
  assert.deepEqual(readFileSync(path), text);
  assert.equal(writes.length, 0);
});

test('prepare validates owners selected paths modes and per-selection file limits', async (t) => {
  const { service, file, writes } = fixture(t);
  const path = file('selected.json');
  for (const owner of [0, -1, NaN, 1.5]) await assert.rejects(service.prepare(owner, [path], 'claude', 'files'), /owner/);
  await assert.rejects(service.prepare(1, [], 'claude', 'files'), /between 1 and 200/);
  await assert.rejects(service.prepare(1, Array(201).fill(path), 'claude', 'files'), /between 1 and 200/);
  await assert.rejects(service.prepare(1, [path], 'unknown' as never, 'files'), /Invalid import choice/);
  await assert.rejects(service.prepare(1, [path], 'claude', 'unknown' as never), /Invalid import choice/);
  for (const invalid of ['relative.json', '/invalid\0.json', 7]) await assert.rejects(service.prepare(1, [invalid as string], 'claude', 'files'), /valid local/);
  await assert.rejects(service.prepare(1, [path, path], 'claude', 'folder'), /one session folder/);
  assert.equal(writes.length, 0);
});

test('preview and candidate identities are owner-scoped and malformed selections cannot mutate anything', async (t) => {
  const { service, file, writes } = fixture(t);
  const path = file('selected.json');
  const first = await service.prepare(1, [path], 'claude', 'files');
  const second = await service.prepare(2, [path], 'claude', 'files');
  const valid = { batchId: first.batchId, ids: [first.candidates[0].id], projectId: 'project' };
  assert.throws(() => service.commit(2, valid), /expired/);
  assert.throws(() => service.commit(0, valid), /owner/);
  for (const input of [null, [], { ...valid, ids: [] }, { ...valid, ids: [first.candidates[0].id, first.candidates[0].id] },
    { ...valid, ids: [second.candidates[0].id] }, { ...valid, ids: [7] }, { ...valid, projectId: '' }, { ...valid, projectId: 'bad\0project' }]) {
    assert.throws(() => service.commit(1, input));
  }
  service.discard(2, first.batchId);
  assert.equal(service.commit(2, { batchId: second.batchId, ids: [second.candidates[0].id], projectId: 'project' }).importedThreadIds.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(service.commit(1, valid).importedThreadIds.length, 1);
});

test('discard replacement and exact expiry release owner previews without allowing stale reuse', async (t) => {
  const { service, file, writes } = fixture(t);
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const path = file('selected.json');
  const old = await service.prepare(1, [path], 'claude', 'files');
  const current = await service.prepare(1, [path], 'claude', 'files');
  const selection = { batchId: current.batchId, ids: [current.candidates[0].id], projectId: 'project' };
  assert.throws(() => service.commit(1, { ...selection, batchId: old.batchId }), /expired/);
  service.discard(1, old.batchId);
  now = current.expiresAt;
  assert.throws(() => service.commit(1, selection), /expired/);
  const discarded = await service.prepare(1, [path], 'claude', 'files');
  service.discard(1, discarded.batchId);
  assert.throws(() => service.commit(1, { ...selection, batchId: discarded.batchId, ids: [discarded.candidates[0].id] }), /expired/);
  assert.equal(writes.length, 0);
});

test('duplicate paths and session identities are skipped while existing provenance is marked globally', async (t) => {
  const { service, file, writes } = fixture(t, [{ source: 'claude', format: 'claude-export', externalId: 'session-one', importedAt: 1 }]);
  const path = file('first.json');
  const duplicate = file('second.json');
  const preview = await service.prepare(1, [path, path, duplicate], 'claude', 'files');
  assert.equal(preview.fileCount, 2);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].alreadyImported, true);
  assert.match(preview.warnings.join(' '), /duplicate session/);
  assert.equal(writes.length, 0);
});

test('capacity failures preserve the preview for a retry and never modify the source export', async (t) => {
  const { directory, file } = fixture(t);
  const path = file('two-chats.json', exportText(['one', 'two']));
  const previous = conversations.location();
  conversations.useStorePath(join(directory, 'store.json'));
  t.after(() => conversations.useStorePath(previous));
  conversations.save({ threads: Array.from({ length: 199 }, (_, index) => ({ id: `old-${index}`, title: 'Keep old chat', createdAt: index })) });
  const service = new ChatImportService({ origins: () => [], import: conversations.importThreads });
  t.after(() => service.discard(1));
  const preview = await service.prepare(1, [path], 'claude', 'files');
  const selection = { batchId: preview.batchId, ids: preview.candidates.map((item) => item.id), projectId: 'selected-project' };
  const before = conversations.snapshot();
  assert.throws(() => service.commit(1, selection), /capacity/);
  assert.deepEqual(conversations.snapshot(), before);
  const old = before.threads.find((item) => item.id === 'old-0')!;
  conversations.deleteThread(old.id, old.revision);
  const result = service.commit(1, selection);
  assert.equal(result.importedThreadIds.length, 2);
  assert.equal(conversations.snapshot().threads.length, 200);
  assert.equal(readFileSync(path, 'utf8'), exportText(['one', 'two']));
});

test('a discarded in-flight inspection closes its handle and cannot recreate a retained preview', async (t) => {
  const { service, file, writes } = fixture(t);
  const path = file('selected.json');
  let release!: (handle: unknown) => void;
  let closed = 0;
  const opening = t.mock.method(fsPromises, 'open', () => new Promise((resolve) => { release = resolve; }) as never);
  const pending = service.prepare(1, [path], 'claude', 'files');
  await assert.rejects(service.prepare(1, [path], 'claude', 'files'), /Another import/);
  service.discard(1);
  release({ close: async () => { closed++; } });
  await assert.rejects(pending, /cancelled/);
  assert.equal(closed, 1);
  assert.equal(writes.length, 0);
  opening.mock.restore();
  const retry = await service.prepare(1, [path], 'claude', 'files');
  assert.equal(retry.candidates.length, 1);
});

test('file inspection refuses oversized and unstable files and reserves cumulative read budget before parsing', async (t) => {
  const { service, file, writes } = fixture(t);
  const oversized = file('oversized.json', ''); truncateSync(oversized, 32 * 1024 * 1024 + 1);
  const preview = await service.prepare(1, [oversized], 'claude', 'files');
  assert.equal(preview.candidates.length, 0);
  assert.match(preview.warnings[0], /32 MiB/);
  const paths = [file('unstable-one.json'), file('unstable-two.json'), file('too-much.json')];
  let closed = 0;
  let readCalls = 0;
  t.mock.method(fsPromises, 'open', async (path, flags) => {
    assert.ok((Number(flags) & constants.O_NOFOLLOW) !== 0);
    assert.ok((Number(flags) & constants.O_NONBLOCK) !== 0);
    const size = path === paths[2] ? 1 : 32 * 1024 * 1024;
    return { stat: async () => ({ isFile: () => true, size, mtimeMs: 1 }),
      read: async () => { readCalls++; return { bytesRead: 0 }; }, close: async () => { closed++; } } as never;
  });
  await assert.rejects(service.prepare(1, paths, 'claude', 'files'), /exceed 64 MiB/);
  assert.equal(closed, 3);
  assert.equal(readCalls, 2, 'rejected third file consumes neither read I/O nor its own allocation');
  assert.equal(writes.length, 0);
});

test('warnings are capped with an explicit diagnostic count instead of unbounded preview data', async (t) => {
  const { service, file } = fixture(t);
  const files = Array.from({ length: 120 }, (_, index) => file(`bad-${index}.json`, '{invalid'));
  const preview = await service.prepare(1, files, 'claude', 'files');
  assert.equal(preview.candidates.length, 0);
  assert.equal(preview.warnings.length, 101);
  assert.match(preview.warnings.at(-1)!, /20 additional warnings were omitted/);
  assert.ok(preview.warnings.every((warning) => warning.length <= 1000));
});

test('folder entry iteration is bounded even when every entry is an irrelevant regular file', async (t) => {
  const { service, directory, writes } = fixture(t);
  let visited = 0;
  let iteratorClosed = false;
  t.mock.method(fsPromises, 'opendir', async () => ({ async *[Symbol.asyncIterator]() {
    try { for (let index = 0; index < 20_000; index++) { visited++; yield {
      name: `irrelevant-${index}.txt`, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true,
    }; } } finally { iteratorClosed = true; }
  } }) as never);
  await assert.rejects(service.prepare(1, [directory], 'codex', 'folder'), /too many entries/);
  assert.ok(visited <= 10_000);
  assert.equal(iteratorClosed, true);
  assert.equal(writes.length, 0);
});

test('folder file count and nesting limits refuse the selection without retained partial data', async (t) => {
  const { service, directory, writes } = fixture(t);
  const broad = join(directory, 'broad'); mkdirSync(broad);
  for (let index = 0; index < 201; index++) writeFileSync(join(broad, `${index}.jsonl`), rolloutText(`session-${index}`));
  await assert.rejects(service.prepare(1, [broad], 'codex', 'folder'), /More than 200/);
  const deep = join(directory, 'deep'); mkdirSync(join(deep, ...Array(14).fill('nested')), { recursive: true });
  await assert.rejects(service.prepare(1, [deep], 'codex', 'folder'), /deeply nested/);
  assert.equal(writes.length, 0);
});

test('preview candidates and simultaneous owner batches have explicit memory ceilings', async (t) => {
  const { service, file, writes } = fixture(t);
  const large = [file('first.json', exportText(Array.from({ length: 600 }, (_, index) => `one-${index}`))),
    file('second.json', exportText(Array.from({ length: 600 }, (_, index) => `two-${index}`)))];
  await assert.rejects(service.prepare(1, large, 'claude', 'files'), /More than 1000/);
  const path = file('normal.json');
  for (const owner of [1, 2, 3, 4]) await service.prepare(owner, [path], 'claude', 'files');
  await assert.rejects(service.prepare(5, [path], 'claude', 'files'), /Too many import previews/);
  service.discard(1);
  assert.equal((await service.prepare(5, [path], 'claude', 'files')).candidates.length, 1);
  assert.equal(writes.length, 0);
});

test('OpenCode JSON exports preview read-only and commit using provider-distinct provenance', async (t) => {
  const { service, file, writes } = fixture(t, [
    { source: 'claude', format: 'claude-export', externalId: 'ses_shared', importedAt: 1 },
    { source: 'codex', format: 'codex-rollout', externalId: 'ses_shared', importedAt: 1 },
  ]);
  const path = file('opencode.json', opencodeText('ses_shared'));
  const duplicate = file('opencode-copy.json', opencodeText('ses_shared'));
  const before = statSync(path);
  const preview = await service.prepare(1, [path, duplicate], 'opencode', 'files');
  assert.equal(writes.length, 0);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].source, 'opencode');
  assert.equal(preview.candidates[0].format, 'opencode-export');
  assert.equal(preview.candidates[0].messageCount, 2);
  assert.equal(preview.candidates[0].alreadyImported, false, 'other providers with the same external id do not suppress OpenCode history');
  assert.match(preview.warnings.join(' '), /duplicate session/);
  assert.doesNotMatch(JSON.stringify(preview), /Synthetic OpenCode question|\/never\/open|external-provider/);
  service.commit(1, { batchId: preview.batchId, ids: [preview.candidates[0].id], projectId: 'chosen-project' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].projectId, 'chosen-project');
  assert.equal(writes[0].conversations[0].externalId, 'ses_shared');
  assert.equal(writes[0].conversations[0].source, 'opencode');
  assert.equal(readFileSync(path, 'utf8'), opencodeText('ses_shared'));
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
});

test('OpenCode file selection accepts JSON exports only and rejects provider mismatches without raw database reads', async (t) => {
  const { service, file, writes } = fixture(t, [{ source: 'opencode', format: 'opencode-export', externalId: 'ses_opencode', importedAt: 1 }]);
  const exported = file('session.JSON', opencodeText());
  const jsonl = file('session.jsonl', opencodeText());
  const database = file('opencode.db', opencodeText());
  const claude = file('claude.json');
  const codex = file('codex.json', rolloutText());
  const opened: string[] = [];
  const originalOpen = fsPromises.open;
  t.mock.method(fsPromises, 'open', async (path, flags) => { opened.push(String(path)); return originalOpen(path, flags); });
  const preview = await service.prepare(1, [exported, jsonl, database, claude, codex], 'opencode', 'files');
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].alreadyImported, true);
  assert.equal(opened.includes(jsonl), false);
  assert.equal(opened.includes(database), false);
  assert.match(preview.warnings.join(' '), /OpenCode JSON export|different source/);
  const mismatch = await service.prepare(2, [exported], 'claude', 'files');
  assert.equal(mismatch.candidates.length, 0);
  assert.match(mismatch.warnings.join(' '), /different source/);
  assert.equal(writes.length, 0);
});

test('OpenCode folder import scans exported JSON without following links or accepting raw storage fragments', async (t) => {
  const { service, directory, writes } = fixture(t);
  const selected = join(directory, 'exports');
  const nested = join(selected, 'nested'); mkdirSync(nested, { recursive: true });
  const exported = join(nested, 'session.JSON'); writeFileSync(exported, opencodeText('ses_inside'));
  const outside = join(directory, 'outside.json'); writeFileSync(outside, opencodeText('ses_outside'));
  const jsonl = join(selected, 'wrong-extension.jsonl'); writeFileSync(jsonl, opencodeText('ses_jsonl'));
  const database = join(selected, 'opencode.db'); writeFileSync(database, opencodeText('ses_database'));
  writeFileSync(join(selected, 'raw-message.json'), JSON.stringify({ id: 'raw-message', sessionID: 'raw-session', role: 'user', time: { created: 1 } }));
  symlinkSync(outside, join(selected, 'linked.json'));
  const opened: string[] = [];
  const originalOpen = fsPromises.open;
  t.mock.method(fsPromises, 'open', async (path, flags) => { opened.push(String(path)); return originalOpen(path, flags); });
  const preview = await service.prepare(1, [selected], 'opencode', 'folder');
  assert.equal(preview.fileCount, 2, 'only regular JSON files are candidates for parsing');
  assert.equal(preview.candidates.length, 1, 'raw internal storage records are not standalone exports');
  assert.equal(opened.includes(jsonl), false);
  assert.equal(opened.includes(database), false);
  assert.equal(opened.includes(outside), false);
  assert.match(preview.warnings.join(' '), /Symbolic links/);
  assert.equal(writes.length, 0);
  const empty = join(directory, 'only-database'); mkdirSync(empty); writeFileSync(join(empty, 'opencode.db'), 'not an export');
  await assert.rejects(service.prepare(2, [empty], 'opencode', 'folder'), /No OpenCode JSON export files/);
});

test('OpenCode export tools survive the real preview commit reload and dedupe pipeline as inert history', async (t) => {
  const { directory, file } = fixture(t);
  const raw = JSON.parse(opencodeText('ses_pipeline'));
  const assistant = raw.messages[1];
  for (const status of ['completed', 'running']) {
    assistant.parts.push({ id: `prt_${status}`, sessionID: raw.info.id, messageID: assistant.info.id,
      type: 'tool', callID: `call_${status}`, tool: 'bash',
      state: status === 'completed'
        ? { status, input: { command: 'echo historical-only' }, output: 'Historical output', title: 'Historical command', metadata: {},
          time: { start: 1788256840000, end: 1788256850000 } }
        : { status, input: { command: 'never-run-this' }, title: 'Interrupted command', metadata: {}, time: { start: 1788256850000 } },
    });
  }
  const original = JSON.stringify(raw);
  const path = file('opencode-pipeline.json', original);
  const beforeMtime = statSync(path).mtimeMs;
  const previous = conversations.location();
  const storePath = join(directory, 'private-conversations.json');
  conversations.useStorePath(storePath);
  t.after(() => conversations.useStorePath(previous));
  conversations.createThread({ id: 'existing-chat', title: 'Existing workspace', projectId: 'existing-project', createdAt: 1,
    directory: '/my/existing/workspace', accessMode: 'full', providerId: 'my-provider', modelId: 'my-model' }, 0);
  conversations.save({ ...conversations.load(), activeThreadId: 'existing-chat',
    drafts: { 'existing-chat': { text: 'Keep this unsent draft', attachments: [] } } });
  const before = conversations.snapshot();
  const service = new ChatImportService({
    origins: () => conversations.snapshot().threads.flatMap((thread) => thread.importedFrom ? [thread.importedFrom] : []),
    import: conversations.importThreads,
  });
  t.after(() => service.discard(1));
  const preview = await service.prepare(1, [path], 'opencode', 'files');
  assert.deepEqual(conversations.snapshot(), before, 'preview has no persistence effects');
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].toolCount, 2);
  const first = service.commit(1, { batchId: preview.batchId, ids: [preview.candidates[0].id], projectId: 'destination-project' });
  assert.equal(first.importedThreadIds.length, 1);
  conversations.useStorePath(storePath);
  const after = conversations.snapshot();
  assert.deepEqual(after.threads.find((thread) => thread.id === 'existing-chat'), before.threads[0]);
  assert.deepEqual(after.drafts, before.drafts);
  assert.equal(after.activeThreadId, before.activeThreadId);
  const imported = after.threads.find((thread) => thread.id === first.importedThreadIds[0])!;
  assert.equal(imported.importedFrom?.source, 'opencode');
  assert.equal(imported.importedFrom?.format, 'opencode-export');
  assert.equal(imported.importedFrom?.externalId, 'ses_pipeline');
  assert.equal(imported.projectId, 'destination-project');
  assert.equal(imported.accessMode, 'ask');
  assert.equal(imported.directory, null);
  assert.equal(imported.providerId, undefined);
  assert.equal(imported.modelId, undefined);
  const tools = imported.messages.flatMap((message) => message.meta.tools ?? []);
  assert.deepEqual(tools.map((tool) => tool.status), ['done', 'failed']);
  assert.equal(tools[0].result, 'Historical output');
  for (const tool of tools) {
    assert.equal(tool.awaitingApproval, false);
    assert.equal(tool.approvalId, undefined);
    assert.equal(tool.subagent, undefined);
    assert.equal(tool.preview, undefined);
    assert.equal(tool.serverId, undefined);
    assert.match(tool.caution!, /not executed or independently verified/);
  }
  const repeated = await service.prepare(1, [path], 'opencode', 'files');
  assert.equal(repeated.candidates[0].alreadyImported, true);
  const duplicate = service.commit(1, { batchId: repeated.batchId, ids: [repeated.candidates[0].id], projectId: 'another-project' });
  assert.deepEqual(duplicate, { importedThreadIds: [], skipped: 1 });
  assert.deepEqual(conversations.snapshot(), after);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(statSync(path).mtimeMs, beforeMtime);
});
