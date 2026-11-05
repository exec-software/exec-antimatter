import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteLiveTranscript, flushSnapshotDeltas } from '../src/main/remote/liveTranscript';
import { EventJournal } from '../src/main/remote/eventJournal';
import { remoteTool, type RemoteMessageProjection, type RemoteThreadProjection } from '../src/main/conversations';

const message = (content = ''): RemoteMessageProjection => ({ id: 'reply', role: 'assistant', content,
  createdAt: 10, failed: false, attachments: [], tools: [] });
const thread = (messages: RemoteMessageProjection[] = []): RemoteThreadProjection => ({
  id: 'chat', title: 'Chat', projectId: 'project', createdAt: 1, updatedAt: 10, revision: 2, accessMode: 'ask', messages,
});
const begin = () => {
  const live = new RemoteLiveTranscript();
  live.begin('run', 'chat', { id: 'reply', createdAt: 10 });
  return live;
};

test('bootstrap includes already emitted desktop tokens and replay delivers only subsequent tokens', () => {
  const live = begin();
  const journal = new EventJournal({ workspaceId: 'host' });
  for (const delta of ['ha', 'ha', 'ha']) {
    live.append('run', delta);
    journal.append({ content: delta });
  }
  const cursor = journal.cursor();
  // Renderer has checkpointed only the first token, or not created its assistant row yet.
  const snapshot = live.project(thread([message('ha')]));
  assert.equal(snapshot.messages[0].content, 'hahaha');
  assert.equal(live.project(thread()).messages[0].content, 'hahaha');
  live.append('run', '!');
  journal.append({ content: '!' });
  const replay = journal.replay(cursor);
  assert.equal(replay.kind, 'events');
  if (replay.kind !== 'events') throw new Error('Expected replay');
  const reconstructed = snapshot.messages[0].content + replay.events.map((entry) => (entry.event as { content: string }).content).join('');
  assert.equal(reconstructed, 'hahaha!');
  assert.equal(live.project(thread([message('hahaha!')])).messages[0].content, reconstructed);
  assert.equal(live.project({ ...thread(), id: 'another-chat' }).messages.length, 0);
});

test('completion before final renderer checkpoint retains output; completed checkpoint releases the overlay', () => {
  const live = begin();
  live.append('run', 'Partial answer');
  live.finish('run', true, 20);
  live.append('run', ' late event');
  assert.equal(live.project(thread([message('Partial')])).messages[0].content, 'Partial answer');
  assert.equal(live.project(thread()).messages[0].failed, true);
  const final = { ...message('Partial answer\n\nError: Offline'), finishedAt: 21, failed: true };
  live.checkpoint('chat', [final]);
  assert.equal(live.project(thread([final])).messages[0].content, final.content);
  // A later deliberate edit to history remains authoritative after the final checkpoint.
  assert.equal(live.project(thread([message('Edited')])).messages[0].content, 'Edited');
});

test('tool projection keeps occurrence identity, latest approval state, and remote redaction through a checkpoint gap', () => {
  const live = begin();
  const tool = remoteTool({ callId: 'reused', activityId: 'one', requestId: 'run', serverName: 'Workspace',
    toolName: 'write_file', tier: 'write', status: 'pending', awaitingApproval: true,
    args: '{"secret":"PRIVATE"}', result: 'PRIVATE', caution: '/private/secret', remoteSummary: 'Write file' });
  live.tool('run', tool);
  live.tool('run', { ...tool, activityId: 'two' });
  live.tool('run', { ...tool, status: 'done', awaitingApproval: false });
  const snapshot = live.project(thread());
  assert.deepEqual(snapshot.messages[0].tools.map((entry) => [entry.activityId, entry.status]), [['one', 'done'], ['two', 'pending']]);
  assert.equal(snapshot.messages[0].tools[0].awaitingApproval, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|\/private|"args"|"result"|"caution"/);
  snapshot.messages[0].tools[0].status = 'failed';
  assert.equal(live.project(thread()).messages[0].tools[0].status, 'done');
});

test('deleted threads cannot be resurrected and a new run does not overwrite a prior uncheckpointed reply', () => {
  const live = begin();
  live.append('run', 'First');
  live.finish('run', false, 20);
  live.begin('next', 'chat', { id: 'next-reply', createdAt: 30 });
  live.append('next', 'Second');
  assert.deepEqual(live.project(thread()).messages.map((entry) => entry.content), ['First', 'Second']);
  live.retainThreads(new Set());
  assert.deepEqual(live.project(thread()).messages, []);
});

test('a mobile snapshot flushes batched deltas before the cursor and fails closed if persistence fails', () => {
  const journal = new EventJournal({ workspaceId: 'host' });
  const sinks = [{ threadId: 'chat', pending: 'hello', saved: '', persistenceError: null as Error | null },
    { threadId: 'other', pending: 'other', saved: '', persistenceError: null as Error | null }];
  journal.append({ content: 'hello' });
  const cursor = journal.cursor();
  flushSnapshotDeltas(sinks, (sink) => { sink.saved += sink.pending; sink.pending = ''; }, 'chat');
  assert.equal(sinks[0].saved, 'hello');
  assert.equal(sinks[1].saved, '');
  assert.deepEqual(journal.cursor(), cursor);
  sinks[0].persistenceError = new Error('Disk full');
  assert.throws(() => flushSnapshotDeltas(sinks, () => {}), (error: unknown) =>
    error instanceof Error && 'retryable' in error && error.retryable === true && !error.message.includes('Disk full'));
});
