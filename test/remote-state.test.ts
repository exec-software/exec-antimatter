import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CommandLedger } from '../src/main/remote/commandLedger';
import { EventJournal } from '../src/main/remote/eventJournal';
import { writePrivateFileAtomic } from '../src/main/privateState';
import { canonicalJson, type RemoteCommand, type RemoteCommandReceipt } from '../src/main/remote/protocol';

const renameCommand = (commandId = 'command-1', title = 'Private title'): RemoteCommand => ({
  protocolVersion: 1,
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  commandId,
  expectedThreadRevision: '1',
  kind: 'thread.rename',
  payload: { threadId: 'thread-1', title },
});

test('command ledger replays canonical payloads and rejects id reuse with different content', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'commands.json');
  const ledger = new CommandLedger({ path, now: () => 50_000 });
  const receipt: RemoteCommandReceipt = {
    commandId: 'command-1',
    requestId: 'request-1',
    disposition: 'accepted',
    acceptedAt: 50_000,
  };

  const command = renameCommand();
  const first = ledger.accept('device-1', command, receipt);
  assert.equal(first.fresh, true);
  first.record.receipt.disposition = 'already_finished';
  const replay = ledger.accept('device-1', structuredClone(command), receipt);
  assert.equal(replay.fresh, false);
  assert.equal(replay.record.receipt.disposition, 'accepted');
  assert.equal(ledger.replayRecord('device-1', 'command-1', command)?.commandId, 'command-1');
  assert.throws(
    () => ledger.accept('device-1', renameCommand('command-1', 'Different title'), receipt),
    /different content/i
  );

  assert.ok(readFileSync(path, 'utf8').includes('Private title'), 'nonterminal payload must be recoverable');
  ledger.claim('device-1', 'command-1');
  ledger.complete('device-1', 'command-1', 'applied');
  const stored = readFileSync(path, 'utf8');
  assert.ok(!stored.includes('Private title'), 'terminal records must shed private command payloads');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const reloaded = new CommandLedger({ path, now: () => 50_001 });
  assert.equal(reloaded.lookupRecord('device-1', 'command-1')?.state, 'applied');
});

test('command ledger publishes state only after its atomic writer succeeds', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-ledger-cow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'commands.json');
  let failWrites = true;
  const ledger = new CommandLedger({
    path,
    now: () => 60_000,
    writeFile: (target, contents) => {
      if (failWrites) throw new Error('injected write failure');
      writePrivateFileAtomic(target, contents);
    },
  });
  const command = renameCommand();
  const receipt: RemoteCommandReceipt = {
    commandId: command.commandId,
    requestId: null,
    disposition: 'accepted',
    acceptedAt: 60_000,
  };

  assert.throws(() => ledger.accept('device-1', command, receipt), /injected write failure/);
  assert.equal(ledger.lookupRecord('device-1', command.commandId), null, 'failed write must not create a memory-only receipt');
  failWrites = false;
  ledger.accept('device-1', command, receipt);
  failWrites = true;
  assert.throws(() => ledger.claim('device-1', command.commandId), /injected write failure/);
  assert.equal(ledger.lookupRecord('device-1', command.commandId)?.state, 'pending');
});

test('pending and stale-dispatching commands survive restart, expiry, and record ceilings', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-ledger-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'commands.json');
  let now = 1;
  const ledger = new CommandLedger({ path, now: () => now, retentionMs: 10, maxRecords: 1 });
  const receipt = (commandId: string): RemoteCommandReceipt => ({
    commandId,
    requestId: null,
    disposition: 'accepted',
    acceptedAt: now,
  });
  const pending = renameCommand('pending');
  const dispatching = renameCommand('dispatching');
  ledger.accept('device-1', pending, receipt(pending.commandId));
  ledger.accept('device-1', dispatching, receipt(dispatching.commandId));
  ledger.claim('device-1', dispatching.commandId);

  now = 10_000;
  const reloaded = new CommandLedger({ path, now: () => now, retentionMs: 10, maxRecords: 1 });
  assert.deepEqual(
    reloaded.recoverable().map((record) => [record.commandId, record.state]),
    [['pending', 'pending'], ['dispatching', 'dispatching']]
  );
  assert.equal(reloaded.size(), 2, 'nonterminal records may exceed the terminal retention ceiling');
});

test('one device cannot bind the same client thread identity to two create commands', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-ledger-client-thread-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = new CommandLedger({ path: join(root, 'commands.json') });
  const create = (commandId: string): RemoteCommand => ({
    protocolVersion: 1,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    commandId,
    kind: 'thread.create',
    payload: { clientThreadId: 'android-thread-1', title: 'Remote thread' },
  });
  const first = create('create-1');
  ledger.accept('device-1', first, {
    commandId: first.commandId,
    requestId: null,
    disposition: 'accepted',
    acceptedAt: 1,
    result: { threadId: 'host-thread-1', clientThreadId: 'android-thread-1' },
  });
  const second = create('create-2');
  assert.throws(
    () => ledger.accept('device-1', second, {
      commandId: second.commandId,
      requestId: null,
      disposition: 'accepted',
      acceptedAt: 2,
      result: { threadId: 'host-thread-2', clientThreadId: 'android-thread-1' },
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CLIENT_THREAD_CONFLICT'
  );
  assert.equal(ledger.size(), 1);
});

test('event journal has strict cursors, bounded replay, reset, and race-free waiting', async () => {
  let now = 100;
  const journal = new EventJournal({
    workspaceId: 'workspace-1',
    epoch: 'epoch-1',
    now: () => ++now,
    maxEvents: 2,
    maxBytes: 4_096,
  });
  const first = journal.append({ kind: 'one', nested: { value: 1 } });
  const second = journal.append({ kind: 'two' });
  const third = journal.append({ kind: 'three' });
  assert.deepEqual(
    [first.cursor.sequence, second.cursor.sequence, third.cursor.sequence],
    [1, 2, 3]
  );

  const replay = journal.replay({ epoch: 'epoch-1', sequence: 1 });
  assert.equal(replay.kind, 'events');
  if (replay.kind === 'events') {
    assert.deepEqual(replay.events.map((event) => event.cursor.sequence), [2, 3]);
  }
  assert.deepEqual(journal.replay({ epoch: 'epoch-1', sequence: 0 }), {
    kind: 'reset',
    reason: 'cursor_expired',
    cursor: { epoch: 'epoch-1', sequence: 3 },
    minimumSequence: 1,
  });
  assert.equal(journal.replay({ epoch: 'old-epoch', sequence: 3 }).kind, 'reset');
  assert.equal(journal.replay(null).kind, 'reset');

  const waiting = journal.wait({ epoch: 'epoch-1', sequence: 3 }, 1_000);
  journal.append({ kind: 'four' });
  const delivered = await waiting;
  assert.equal(delivered.kind, 'events');
  if (delivered.kind === 'events') {
    assert.equal(delivered.events.length, 1);
    assert.equal((delivered.events[0].event as { kind: string }).kind, 'four');
  }
  journal.close();
});

test('event replay batches advance the cursor without exceeding the client response limit', () => {
  const journal = new EventJournal({
    workspaceId: 'workspace-1',
    epoch: 'epoch-batched',
    now: () => 200,
    maxBytes: 8_192,
    maxReplayBytes: 420,
  });
  for (const kind of ['one', 'two', 'three']) {
    journal.append({ kind, detail: 'x'.repeat(100) });
  }

  const first = journal.replay({ epoch: 'epoch-batched', sequence: 0 });
  assert.equal(first.kind, 'events');
  if (first.kind !== 'events') return;
  assert.ok(first.events.length > 0 && first.events.length < 3);
  assert.equal(first.cursor.sequence, first.events.at(-1)?.cursor.sequence);
  assert.ok(Buffer.byteLength(canonicalJson(first)) <= 420);

  const second = journal.replay(first.cursor);
  assert.equal(second.kind, 'events');
  if (second.kind === 'events') {
    assert.ok(second.events.length > 0);
    assert.ok(second.cursor.sequence > first.cursor.sequence);
    assert.ok(Buffer.byteLength(canonicalJson(second)) <= 420);
  }
});
