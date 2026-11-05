import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ActiveTurns } from '../src/main/activeTurns';
import * as conversations from '../src/main/conversations';
import { CommandLedger } from '../src/main/remote/commandLedger';
import { EventJournal } from '../src/main/remote/eventJournal';
import { PairingStore, type SecretProtector } from '../src/main/remote/pairingStore';
import { RemoteProtocolError, type RemoteCommand } from '../src/main/remote/protocol';
import { RemoteHostRouter } from '../src/main/remote/router';
import {
  inspectRemoteTurnStart,
  reserveRemoteTurnStart,
  type RemoteTurnStartDependencies,
} from '../src/main/remote/turnStart';

const protector: SecretProtector = {
  seal: (value) => `test:${Buffer.from(value).toString('base64')}`,
  open: (value) => Buffer.from(value.slice(5), 'base64').toString(),
};

const certificatePin = `sha256/${Buffer.alloc(32, 11).toString('base64')}`;

test('concurrent accepted turn starts reserve ownership before either transcript mutation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-turn-start-'));
  const previousStore = conversations.location();
  conversations.useStorePath(join(root, 'conversations.json'));
  t.after(() => {
    conversations.useStorePath(previousStore);
    rmSync(root, { recursive: true, force: true });
  });
  conversations.createThread({
    id: 'thread-1',
    projectId: 'inbox',
    title: 'Concurrent start',
    createdAt: 1,
    directory: '/workspace/project',
  }, 0);

  const activeTurns = new ActiveTurns();
  const dependencies: RemoteTurnStartDependencies = {
    activeTurns,
    resolveProject: (projectId) => projectId === 'project-1'
      ? { id: projectId, name: 'Project', root: '/workspace/project' }
      : null,
    loadThread: (projectId, threadId) => {
      const thread = conversations.snapshot().threads.find((candidate) => candidate.id === threadId);
      if (!thread || projectId !== 'project-1') {
        throw new RemoteProtocolError('NOT_FOUND', 'Conversation not found.', 404);
      }
      return thread;
    },
    resolveModel: (providerId, modelId) =>
      providerId === 'provider-1' && modelId === 'model-1' ? { name: 'Test source' } : null,
  };

  const pairing = new PairingStore({
    path: join(root, 'pairing.json'),
    hostName: 'Test host',
    protector,
  });
  const ledger = new CommandLedger({ path: join(root, 'commands.json') });
  const journals = new Map<string, EventJournal>();
  const journalFor = (deviceId: string): EventJournal => {
    let journal = journals.get(deviceId);
    if (!journal) {
      journal = new EventJournal({ workspaceId: 'workspace-1', epoch: `epoch-${deviceId}` });
      journals.set(deviceId, journal);
    }
    return journal;
  };

  let validations = 0;
  let releaseValidation: (() => void) | null = null;
  const bothValidated = new Promise<void>((resolve) => {
    releaseValidation = resolve;
  });
  const applied: string[] = [];
  const dispatchErrors: unknown[] = [];
  const router = new RemoteHostRouter({
    pairing,
    ledger,
    workspace: { id: 'workspace-1', name: 'Test host' },
    certificatePin,
    eventsFor: journalFor,
    authorizeProject: (_device, projectId) => projectId === 'project-1',
    validateCommand: async (_device, command) => {
      if (command.kind !== 'turn.start') return;
      inspectRemoteTurnStart(command, dependencies);
      validations += 1;
      if (validations === 2) releaseValidation?.();
      await bothValidated;
    },
    bootstrap: () => ({}),
    thread: () => null,
    dispatch: (device, command) => {
      if (command.kind !== 'turn.start') return;
      const reservation = reserveRemoteTurnStart(device, command, dependencies);
      const at = Date.now();
      conversations.beginTurn(reservation.thread.id, {
        user: { id: command.payload.userMessageId, content: command.payload.content, createdAt: at },
        assistant: {
          id: command.payload.responseMessageId,
          createdAt: at,
          modelId: command.payload.model.modelId,
          sourceName: reservation.source.name,
        },
        providerId: command.payload.model.providerId,
        modelId: command.payload.model.modelId,
      }, reservation.thread.revision);
      applied.push(command.payload.requestId);
    },
    onDispatchError: (_device, _command, error) => dispatchErrors.push(error),
    revokeDevice: (device) => pairing.revoke(device.id),
  });
  t.after(() => router.close());

  const offer = pairing.createOffer({ capabilities: ['chat'], maxAccess: 'ask' });
  const paired = await router.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/pair',
    headers: { authorization: `Pair ${offer.secret}` },
    body: {
      offerId: offer.id,
      deviceName: 'Test phone',
      clientVersion: 'test',
      protocol: { major: 1, minor: 0 },
      requestedCapabilities: ['chat'],
    },
  });
  assert.equal(paired.status, 201);
  const token = (paired.body as { credential: { token: string } }).credential.token;
  const headers = { authorization: `Bearer ${token}` };
  const start = (suffix: string): Extract<RemoteCommand, { kind: 'turn.start' }> => ({
    protocolVersion: 1,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    commandId: `command-${suffix}`,
    expectedThreadRevision: '1',
    kind: 'turn.start',
    payload: {
      threadId: 'thread-1',
      requestId: `request-${suffix}`,
      userMessageId: `user-${suffix}`,
      responseMessageId: `assistant-${suffix}`,
      model: { providerId: 'provider-1', modelId: 'model-1' },
      content: `message-${suffix}`,
      attachmentIds: [],
      accessMode: 'ask',
    },
  });

  const stale = { ...start('stale'), expectedThreadRevision: '0' };
  assert.throws(
    () => inspectRemoteTurnStart(stale, dependencies),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'REVISION_CONFLICT'
  );
  const before = conversations.snapshot().threads[0];
  assert.equal(before.messages.length, 0);
  assert.equal(before.providerId, undefined);
  assert.equal(before.modelId, undefined);

  const [first, second] = await Promise.all(['one', 'two'].map((suffix) => router.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: start(suffix),
  })));

  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(validations, 2, 'both commands crossed the original validation boundary');
  assert.equal(applied.length, 1, 'only the owner may mutate the transcript');
  assert.equal(dispatchErrors.length, 1);
  assert.ok(dispatchErrors[0] instanceof RemoteProtocolError);
  assert.equal((dispatchErrors[0] as RemoteProtocolError).code, 'REVISION_CONFLICT');

  const stored = conversations.snapshot().threads[0];
  assert.equal(stored.messages.length, 2);
  assert.equal(stored.messages[0].role, 'user');
  assert.equal(stored.messages[1].role, 'assistant');
  assert.equal(stored.messages[0].id.replace('user-', 'request-'), applied[0]);
  assert.equal(stored.messages[1].id.replace('assistant-', 'request-'), applied[0]);
  assert.equal(stored.providerId, 'provider-1');
  assert.equal(stored.modelId, 'model-1');
  assert.equal(activeTurns.list().length, 1);
});
