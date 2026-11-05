import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import * as conversations from '../src/main/conversations';
import { writePrivateFileAtomic } from '../src/main/privateState';
import { CommandLedger } from '../src/main/remote/commandLedger';
import { EventJournal } from '../src/main/remote/eventJournal';
import { PairingStore, type PublicDeviceRecord, type SecretProtector } from '../src/main/remote/pairingStore';
import {
  canonicalPayloadHash,
  RemoteProtocolError,
  type RemoteCommand,
  type RemoteCommandReceipt,
} from '../src/main/remote/protocol';
import {
  RemoteHostRouter,
  type RemoteExecutedCommandOutcome,
  type RemoteHostRouterOptions,
} from '../src/main/remote/router';

const protector: SecretProtector = {
  seal: (value) => `test:${Buffer.from(value).toString('base64')}`,
  open: (value) => Buffer.from(value.slice(5), 'base64').toString(),
};
const certificatePin = `sha256/${Buffer.alloc(32, 19).toString('base64')}`;

interface Fixture {
  root: string;
  ledgerPath: string;
  pairing: PairingStore;
  ledger: CommandLedger;
  device: PublicDeviceRecord;
  credential: string;
  journal: EventJournal;
}

function fixture(t: TestContext, withConversations = false): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-command-recovery-'));
  const previousStore = conversations.location();
  if (withConversations) conversations.useStorePath(join(root, 'conversations.json'));
  t.after(() => {
    if (withConversations) conversations.useStorePath(previousStore);
    rmSync(root, { recursive: true, force: true });
  });
  const pairing = new PairingStore({
    path: join(root, 'pairing.json'),
    hostName: 'Recovery host',
    protector,
  });
  const offer = pairing.createOffer({ capabilities: ['chat', 'approvals'], maxAccess: 'full' });
  const paired = pairing.exchangeOffer({
    offerId: offer.id,
    secret: offer.secret,
    deviceName: 'Recovery phone',
    clientVersion: 'test',
    protocol: { major: 1, minor: 0 },
    requestedCapabilities: ['chat', 'approvals'],
  });
  const ledgerPath = join(root, 'commands.json');
  return {
    root,
    ledgerPath,
    pairing,
    ledger: new CommandLedger({ path: ledgerPath }),
    device: paired.device,
    credential: paired.credential,
    journal: new EventJournal({ workspaceId: pairing.identity().id, epoch: 'recovery-epoch' }),
  };
}

const rename = (workspaceId: string, commandId: string, revision = '1'): RemoteCommand => ({
  protocolVersion: 1,
  workspaceId,
  projectId: 'project-1',
  commandId,
  expectedThreadRevision: revision,
  kind: 'thread.rename',
  payload: { threadId: 'thread-1', title: `Title ${commandId}` },
});

const receipt = (command: RemoteCommand, result?: RemoteCommandReceipt['result']): RemoteCommandReceipt => ({
  commandId: command.commandId,
  requestId: 'requestId' in command.payload ? command.payload.requestId : null,
  disposition: 'accepted',
  acceptedAt: Date.now(),
  ...(result ? { result } : {}),
});

function router(
  state: Fixture,
  dispatch: RemoteHostRouterOptions['dispatch'],
  bootstrap: RemoteHostRouterOptions['bootstrap'] = () => ({ revision: '1' }),
  executedCommands?: Map<string, RemoteExecutedCommandOutcome>
): RemoteHostRouter {
  return new RemoteHostRouter({
    pairing: state.pairing,
    ledger: state.ledger,
    workspace: { id: state.pairing.identity().id, name: 'Recovery host' },
    certificatePin,
    eventsFor: () => state.journal,
    authorizeProject: (_device, projectId) => projectId === 'project-1',
    bootstrap,
    thread: () => null,
    dispatch,
    ...(executedCommands ? { executedCommands } : {}),
    revokeDevice: (device) => state.pairing.revoke(device.id),
  });
}

test('startup recovery reclaims pending and stale-dispatching commands exactly once and serially', async (t) => {
  const state = fixture(t);
  const workspaceId = state.pairing.identity().id;
  const first = rename(workspaceId, 'first');
  const second = rename(workspaceId, 'second');
  state.ledger.accept(state.device.id, first, receipt(first));
  state.ledger.accept(state.device.id, second, receipt(second));
  state.ledger.claim(state.device.id, second.commandId);

  let concurrent = 0;
  let maximum = 0;
  const dispatched: string[] = [];
  const host = router(state, async (_device, command, _receipt, context) => {
    assert.equal(context.recovery, true);
    concurrent += 1;
    maximum = Math.max(maximum, concurrent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    dispatched.push(command.commandId);
    concurrent -= 1;
    return 'applied';
  });
  t.after(() => host.close());

  await Promise.all([host.recover(), host.recover()]);
  assert.deepEqual(dispatched, ['first', 'second']);
  assert.equal(maximum, 1);
  assert.equal(state.ledger.lookupRecord(state.device.id, first.commandId)?.state, 'applied');
  const recoveredSecond = state.ledger.lookupRecord(state.device.id, second.commandId);
  assert.equal(recoveredSecond?.state, 'applied');
  assert.equal(recoveredSecond?.attempts, 2, 'a pre-crash dispatch claim is reclaimed once');
});

test('revoked authority converts pending recovery to a durable failure without dispatch', async (t) => {
  const state = fixture(t);
  const command = rename(state.pairing.identity().id, 'revoked-command');
  state.ledger.accept(state.device.id, command, receipt(command));
  state.pairing.revoke(state.device.id);
  let dispatches = 0;
  const host = router(state, () => {
    dispatches += 1;
  });
  t.after(() => host.close());

  await host.recover();
  const failed = state.ledger.lookupRecord(state.device.id, command.commandId);
  assert.equal(dispatches, 0);
  assert.equal(failed?.state, 'failed');
  assert.equal(failed?.failure?.code, 'AUTHORITY_REVOKED');
});

test('recovery revision failures remain discoverable after event reset and reject replay', async (t) => {
  const state = fixture(t);
  const command = rename(state.pairing.identity().id, 'stale-revision', '4');
  state.ledger.accept(state.device.id, command, receipt(command));
  const host = router(state, () => {
    throw new RemoteProtocolError('REVISION_CONFLICT', 'The conversation changed; refresh it and try again.', 409, true);
  });
  t.after(() => host.close());
  await host.recover();

  const headers = { authorization: `Bearer ${state.credential}` };
  const status = await host.handle({
    secure: true,
    method: 'GET',
    pathname: `/v1/commands/${command.commandId}`,
    headers,
  });
  assert.equal(status.status, 200);
  assert.equal((status.body as { state: string }).state, 'failed');
  assert.equal((status.body as { failure: { code: string } }).failure.code, 'REVISION_CONFLICT');

  const bootstrap = await host.handle({ secure: true, method: 'GET', pathname: '/v1/bootstrap', headers });
  const outcomes = (bootstrap.body as { commandOutcomes: Array<{ receipt: { commandId: string }; state: string }> }).commandOutcomes;
  assert.deepEqual(outcomes.map((entry) => [entry.receipt.commandId, entry.state]), [['stale-revision', 'failed']]);

  const replay = await host.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: command,
  });
  assert.equal(replay.status, 409);
  assert.equal((replay.body as { error: { code: string } }).error.code, 'REVISION_CONFLICT');
});

test('crash after atomic conversation effect reconciles without applying the mutation twice', async (t) => {
  const state = fixture(t, true);
  const workspaceId = state.pairing.identity().id;
  let thread = conversations.createThread({
    id: 'thread-1',
    projectId: 'inbox',
    title: 'Before',
    createdAt: 1,
  }, 0);
  const command = rename(workspaceId, 'rename-once');
  const accepted = receipt(command);
  state.ledger.accept(state.device.id, command, accepted);
  state.ledger.claim(state.device.id, command.commandId);
  const effect = {
    id: canonicalPayloadHash({ deviceId: state.device.id, commandId: command.commandId }),
    payloadHash: canonicalPayloadHash(command),
    kind: command.kind,
    appliedAt: accepted.acceptedAt,
  };
  thread = conversations.renameThread(thread.id, 'Applied once', thread.revision, effect);
  assert.equal(thread.title, 'Applied once');

  state.ledger = new CommandLedger({ path: state.ledgerPath });
  let duplicateMutations = 0;
  const host = router(state, (_device, recovered, _receipt, context) => {
    if (conversations.hasRemoteEffect(context.effect)) return 'applied';
    duplicateMutations += 1;
    const current = conversations.snapshot().threads[0];
    conversations.renameThread(current.id, (recovered as typeof command).payload.title, current.revision, context.effect);
    return 'applied';
  });
  t.after(() => host.close());
  await host.recover();

  assert.equal(duplicateMutations, 0);
  assert.equal(conversations.snapshot().threads[0].title, 'Applied once');
  assert.equal(state.ledger.lookupRecord(state.device.id, command.commandId)?.state, 'applied');
});

test('a failed terminal ledger write leaves dispatching recovery state and reconciles its landed effect', async (t) => {
  const state = fixture(t, true);
  let writes = 0;
  let failCompletion = true;
  state.ledger = new CommandLedger({
    path: state.ledgerPath,
    writeFile: (path, contents) => {
      writes += 1;
      if (failCompletion && writes === 3) throw new Error('injected completion write failure');
      writePrivateFileAtomic(path, contents);
    },
  });
  let thread = conversations.createThread({
    id: 'thread-1',
    projectId: 'inbox',
    title: 'Before completion fault',
    createdAt: 1,
  }, 0);
  const command = rename(state.pairing.identity().id, 'completion-fault');
  state.ledger.accept(state.device.id, command, receipt(command));
  let mutations = 0;
  const host = router(state, (_device, recovered, _receipt, context) => {
    if (conversations.hasRemoteEffect(context.effect)) return 'applied';
    assert.equal(recovered.kind, 'thread.rename');
    const current = conversations.snapshot().threads[0];
    thread = conversations.renameThread(
      current.id,
      recovered.payload.title,
      current.revision,
      context.effect
    );
    mutations += 1;
    return 'applied';
  });
  t.after(() => host.close());

  await host.recover();
  assert.equal(mutations, 1);
  assert.equal(thread.title, 'Title completion-fault');
  assert.equal(state.ledger.lookupRecord(state.device.id, command.commandId)?.state, 'dispatching');

  failCompletion = false;
  await host.recover();
  assert.equal(mutations, 1, 'the durable transcript marker suppresses the second mutation');
  assert.equal(state.ledger.lookupRecord(state.device.id, command.commandId)?.state, 'applied');
});

test('thread creation and turn start markers prevent duplicate identities and inference after restart', async (t) => {
  const state = fixture(t, true);
  const workspaceId = state.pairing.identity().id;
  const create: RemoteCommand = {
    protocolVersion: 1,
    workspaceId,
    projectId: 'project-1',
    commandId: 'create-once',
    kind: 'thread.create',
    payload: { clientThreadId: 'android-local-1', title: 'Created remotely' },
  };
  const createReceipt = receipt(create, { threadId: 'host-thread-1', clientThreadId: 'android-local-1' });
  state.ledger.accept(state.device.id, create, createReceipt);
  state.ledger.claim(state.device.id, create.commandId);
  const createEffect = {
    id: canonicalPayloadHash({ deviceId: state.device.id, commandId: create.commandId }),
    payloadHash: canonicalPayloadHash(create),
    kind: create.kind,
    appliedAt: createReceipt.acceptedAt,
  };
  let thread = conversations.createThread({
    id: 'host-thread-1',
    projectId: 'inbox',
    title: 'Created remotely',
    createdAt: 1,
  }, 0, createEffect);

  const start: RemoteCommand = {
    protocolVersion: 1,
    workspaceId,
    projectId: 'project-1',
    commandId: 'turn-once',
    expectedThreadRevision: String(thread.revision),
    kind: 'turn.start',
    payload: {
      threadId: thread.id,
      requestId: 'request-once',
      userMessageId: 'user-once',
      responseMessageId: 'assistant-once',
      model: { providerId: 'provider-1', modelId: 'model-1' },
      content: 'Run once.',
      attachmentIds: [],
      accessMode: 'ask',
    },
  };
  const startReceipt = receipt(start);
  state.ledger.accept(state.device.id, start, startReceipt);
  state.ledger.claim(state.device.id, start.commandId);
  const startEffect = {
    id: canonicalPayloadHash({ deviceId: state.device.id, commandId: start.commandId }),
    payloadHash: canonicalPayloadHash(start),
    kind: start.kind,
    appliedAt: startReceipt.acceptedAt,
  };
  conversations.beginTurn(thread.id, {
    user: { id: 'user-once', content: 'Run once.', createdAt: 2 },
    assistant: { id: 'assistant-once', createdAt: 2 },
    providerId: 'provider-1',
    modelId: 'model-1',
  }, thread.revision, startEffect);

  state.ledger = new CommandLedger({ path: state.ledgerPath });
  let inferenceStarts = 0;
  const host = router(state, (_device, command, _receipt, context) => {
    if (conversations.hasRemoteEffect(context.effect)) return 'applied';
    if (command.kind === 'turn.start') inferenceStarts += 1;
    throw new Error('A marked effect must not be replayed.');
  });
  t.after(() => host.close());
  await host.recover();

  const snapshot = conversations.snapshot();
  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.threads[0].id, createReceipt.result?.threadId);
  assert.deepEqual(snapshot.threads[0].messages.map((message) => message.id), ['user-once', 'assistant-once']);
  assert.equal(inferenceStarts, 0);
  assert.equal(state.ledger.lookupRecord(state.device.id, create.commandId)?.state, 'applied');
  assert.equal(state.ledger.lookupRecord(state.device.id, start.commandId)?.state, 'applied');
});

test('recovered ephemeral controls settle already-finished instead of replaying an absent run', async (t) => {
  const state = fixture(t);
  const workspaceId = state.pairing.identity().id;
  const commands: RemoteCommand[] = [
    {
      protocolVersion: 1,
      workspaceId,
      projectId: 'project-1',
      commandId: 'cancel-old',
      kind: 'turn.cancel',
      payload: { requestId: 'request-old' },
    },
    {
      protocolVersion: 1,
      workspaceId,
      projectId: 'project-1',
      commandId: 'steer-old',
      kind: 'turn.steer',
      payload: { requestId: 'request-old', note: 'Do this instead.', now: true },
    },
    {
      protocolVersion: 1,
      workspaceId,
      projectId: 'project-1',
      commandId: 'approval-old',
      kind: 'approval.resolve',
      payload: { requestId: 'request-old', approvalId: 'approval-old', approved: false },
    },
  ];
  for (const command of commands) state.ledger.accept(state.device.id, command, receipt(command));
  const host = router(state, (_device, command, _receipt, context) => {
    assert.equal(context.recovery, true);
    assert.ok(['turn.cancel', 'turn.steer', 'approval.resolve'].includes(command.kind));
    return 'already_finished';
  });
  t.after(() => host.close());
  await host.recover();

  for (const command of commands) {
    const recovered = state.ledger.lookupRecord(state.device.id, command.commandId);
    assert.equal(recovered?.state, 'already_finished');
    assert.equal(recovered?.receipt.disposition, 'already_finished');
  }
});

test('closing a listener leaves accepted work pending for the replacement host', async (t) => {
  const state = fixture(t);
  const command = rename(state.pairing.identity().id, 'listener-restart');
  state.ledger.accept(state.device.id, command, receipt(command));
  let dispatches = 0;
  const stopped = router(state, () => {
    dispatches += 1;
    return 'applied';
  });
  stopped.close();
  await stopped.recover();
  assert.equal(dispatches, 0);
  assert.equal(state.ledger.lookupRecord(state.device.id, command.commandId)?.state, 'pending');

  const replacement = router(state, () => {
    dispatches += 1;
    return 'applied';
  });
  t.after(() => replacement.close());
  await replacement.recover();
  assert.equal(dispatches, 1);
  assert.equal(state.ledger.lookupRecord(state.device.id, command.commandId)?.state, 'applied');
});

test('late thread.create replay reconstructs its stable host identity after terminal ledger expiry', async (t) => {
  const state = fixture(t, true);
  let now = 1;
  state.ledger = new CommandLedger({
    path: state.ledgerPath,
    now: () => now,
    retentionMs: 10,
    maxRecords: 10,
  });
  const command: RemoteCommand = {
    protocolVersion: 1,
    workspaceId: state.pairing.identity().id,
    projectId: 'project-1',
    commandId: 'stable-create',
    kind: 'thread.create',
    payload: { clientThreadId: 'android-stable', title: 'Stable identity' },
  };
  const headers = { authorization: `Bearer ${state.credential}` };
  const dispatch: RemoteHostRouterOptions['dispatch'] = (_device, candidate, accepted, context) => {
    assert.equal(candidate.kind, 'thread.create');
    const existing = conversations.remoteEffect(context.effect);
    if (existing) {
      assert.ok(existing.result);
      return { state: 'applied', result: existing.result };
    }
    assert.ok(accepted.result);
    conversations.createThread({
      id: accepted.result.threadId,
      projectId: 'inbox',
      title: candidate.payload.title,
      createdAt: now,
    }, conversations.snapshot().revision, context.effect);
    return { state: 'applied', result: accepted.result };
  };
  const makeRouter = (newThreadId: () => string) => new RemoteHostRouter({
    pairing: state.pairing,
    ledger: state.ledger,
    workspace: { id: state.pairing.identity().id, name: 'Recovery host' },
    certificatePin,
    eventsFor: () => state.journal,
    authorizeProject: (_device, projectId) => projectId === 'project-1',
    newThreadId,
    bootstrap: () => ({ revision: '1' }),
    thread: () => null,
    dispatch,
    revokeDevice: (device) => state.pairing.revoke(device.id),
  });

  const first = makeRouter(() => 'host-thread-original');
  const accepted = await first.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: command,
  });
  assert.equal(accepted.status, 202);
  assert.equal(
    (accepted.body as { receipt: { result: { threadId: string } } }).receipt.result.threadId,
    'host-thread-original'
  );
  first.close();

  now = 100;
  state.ledger = new CommandLedger({
    path: state.ledgerPath,
    now: () => now,
    retentionMs: 10,
    maxRecords: 10,
  });
  assert.equal(state.ledger.lookupRecord(state.device.id, command.commandId), null);
  const replacement = makeRouter(() => 'host-thread-new-but-unused');
  t.after(() => replacement.close());
  const replay = await replacement.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: command,
  });

  assert.equal(replay.status, 202);
  assert.equal(
    (replay.body as { receipt: { result: { threadId: string } } }).receipt.result.threadId,
    'host-thread-original'
  );
  assert.equal(
    state.ledger.lookupRecord(state.device.id, command.commandId)?.receipt.result?.threadId,
    'host-thread-original'
  );
  assert.deepEqual(conversations.snapshot().threads.map((thread) => thread.id), ['host-thread-original']);
});

test('successful steer is not dispatched twice across host rebind when terminal ledger persistence fails', async (t) => {
  const state = fixture(t);
  let writes = 0;
  let failCompletion = true;
  state.ledger = new CommandLedger({
    path: state.ledgerPath,
    writeFile: (path, contents) => {
      writes += 1;
      if (failCompletion && writes === 3) throw new Error('injected steer completion failure');
      writePrivateFileAtomic(path, contents);
    },
  });
  const command: RemoteCommand = {
    protocolVersion: 1,
    workspaceId: state.pairing.identity().id,
    projectId: 'project-1',
    commandId: 'steer-once',
    kind: 'turn.steer',
    payload: { requestId: 'active-request', note: 'Use the smaller patch.', now: true },
  };
  const delivered: string[] = [];
  let pendingNote = command.payload.note;
  const executedCommands = new Map<string, RemoteExecutedCommandOutcome>();
  const dispatch: RemoteHostRouterOptions['dispatch'] = (_device, candidate) => {
    assert.equal(candidate.kind, 'turn.steer');
    assert.equal(pendingNote, candidate.payload.note, 'the steering queue was already consumed');
    delivered.push(candidate.payload.note);
    pendingNote = '';
    return 'applied';
  };
  const host = router(state, dispatch, undefined, executedCommands);
  const headers = { authorization: `Bearer ${state.credential}` };

  const first = await host.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: command,
  });
  assert.equal(first.status, 202);
  assert.equal(state.ledger.lookupRecord(state.device.id, command.commandId)?.state, 'dispatching');
  assert.deepEqual(delivered, ['Use the smaller patch.']);

  host.close();
  failCompletion = false;
  const replacement = router(state, dispatch, undefined, executedCommands);
  t.after(() => replacement.close());
  await replacement.recover();
  assert.equal(state.ledger.lookupRecord(state.device.id, command.commandId)?.state, 'applied');
  assert.deepEqual(delivered, ['Use the smaller patch.']);

  const replay = await replacement.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: command,
  });
  assert.equal(replay.status, 202);
  assert.equal((replay.body as { outcome: { state: string } }).outcome.state, 'applied');
  assert.deepEqual(delivered, ['Use the smaller patch.']);
});

test('a request paused in validation cannot dispatch after shutdown begins', async (t) => {
  const state = fixture(t);
  const command = rename(state.pairing.identity().id, 'shutdown-race');
  let enteredValidation!: () => void;
  const validating = new Promise<void>((resolve) => {
    enteredValidation = resolve;
  });
  let releaseValidation!: () => void;
  const validationGate = new Promise<void>((resolve) => {
    releaseValidation = resolve;
  });
  let dispatches = 0;
  const host = new RemoteHostRouter({
    pairing: state.pairing,
    ledger: state.ledger,
    workspace: { id: state.pairing.identity().id, name: 'Recovery host' },
    certificatePin,
    eventsFor: () => state.journal,
    authorizeProject: (_device, projectId) => projectId === 'project-1',
    validateCommand: async () => {
      enteredValidation();
      await validationGate;
    },
    bootstrap: () => ({ revision: '1' }),
    thread: () => null,
    dispatch: () => {
      dispatches += 1;
      return 'applied';
    },
    revokeDevice: (device) => state.pairing.revoke(device.id),
  });
  t.after(() => host.close());

  const responsePromise = host.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers: { authorization: `Bearer ${state.credential}` },
    body: command,
  });
  await validating;
  host.close();
  releaseValidation();
  const response = await responsePromise;
  await host.drain();

  assert.equal(response.status, 503);
  assert.equal((response.body as { error: { code: string } }).error.code, 'HOST_STOPPING');
  assert.equal(dispatches, 0);
  assert.equal(state.ledger.lookupRecord(state.device.id, command.commandId), null);
});
