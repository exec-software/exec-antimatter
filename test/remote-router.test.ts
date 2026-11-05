import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CommandLedger } from '../src/main/remote/commandLedger';
import { EventJournal } from '../src/main/remote/eventJournal';
import { PairingStore, type SecretProtector } from '../src/main/remote/pairingStore';
import { RemoteProtocolError } from '../src/main/remote/protocol';
import {
  RemoteHostRouter,
  validateSecureListenerConfiguration,
  type RemoteHttpRequest,
} from '../src/main/remote/router';

const protector: SecretProtector = {
  seal: (value) => `test:${Buffer.from(value).toString('base64')}`,
  open: (value) => Buffer.from(value.slice(5), 'base64').toString(),
};

const randomSource = () => {
  let byte = 10;
  return (size: number) => Buffer.alloc(size, byte++);
};

const certificatePin = `sha256/${Buffer.alloc(32, 7).toString('base64')}`;

test('listener validation refuses cleartext and wildcard binding', () => {
  assert.throws(
    () => validateSecureListenerConfiguration({ bindAddress: '0.0.0.0', port: 43128, tls: true, certificatePin }),
    /explicit interface/i
  );
  assert.doesNotThrow(() =>
    validateSecureListenerConfiguration({ bindAddress: '100.64.0.10', port: 43128, tls: true, certificatePin })
  );
});

test('base64url IDs beginning with dash or underscore pair and address remote commands', async (t) => {
  for (const byte of [0xfb, 0xff]) {
    const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-base64url-id-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const pairing = new PairingStore({
      path: join(root, 'pairing.json'),
      hostName: 'Base64url host',
      protector,
      randomBytes: (size) => Buffer.alloc(size, byte),
    });
    const workspace = pairing.identity();
    const journal = new EventJournal({
      workspaceId: workspace.id,
      randomBytes: (size) => Buffer.alloc(size, byte),
    });
    let dispatched = false;
    const router = new RemoteHostRouter({
      pairing,
      ledger: new CommandLedger({ path: join(root, 'commands.json') }),
      workspace,
      certificatePin,
      eventsFor: () => journal,
      authorizeProject: (_device, projectId) => projectId === '_project',
      newThreadId: () => '_thread',
      bootstrap: () => ({ workspace }),
      thread: (_device, id) => id === '_thread' ? { id } : null,
      dispatch: () => { dispatched = true; },
      revokeDevice: (device) => { pairing.revoke(device.id); },
    });
    t.after(() => router.close());
    const offer = pairing.createOffer({ capabilities: ['chat'], maxAccess: 'ask' });
    assert.match(workspace.id, /^[-_]/);
    assert.match(offer.id, /^[-_]/);
    const paired = await router.handle({
      secure: true,
      method: 'POST',
      pathname: '/v1/pair',
      headers: { authorization: `Pair ${offer.secret}` },
      body: {
        offerId: offer.id,
        deviceName: 'Phone',
        clientVersion: 'test',
        protocol: { major: 1, minor: 0 },
        requestedCapabilities: ['chat'],
      },
    });
    assert.equal(paired.status, 201);
    const token = (paired.body as { credential: { token: string } }).credential.token;
    const headers = { authorization: `Bearer ${token}` };
    journal.append({ kind: 'connected' });
    const events = await router.handle({
      secure: true,
      method: 'GET',
      pathname: '/v1/events',
      headers,
      query: { epoch: journal.cursor().epoch, after: '0', waitMs: '0' },
    });
    assert.equal(events.status, 200);
    assert.equal((events.body as { events: unknown[] }).events.length, 1);
    const created = await router.handle({
      secure: true,
      method: 'POST',
      pathname: '/v1/commands',
      headers,
      body: {
        protocolVersion: 1,
        workspaceId: workspace.id,
        projectId: '_project',
        commandId: '-command',
        kind: 'thread.create',
        payload: { clientThreadId: '-client', title: 'A real task' },
      },
    });
    assert.equal(created.status, 202);
    await router.drain();
    assert.equal(dispatched, true);
    assert.equal((await router.handle({
      secure: true, method: 'GET', pathname: '/v1/commands/-command', headers,
    })).status, 200);
    assert.equal((await router.handle({
      secure: true, method: 'GET', pathname: '/v1/threads/_thread', headers,
    })).status, 200);
  }
});

test('router pairs, authenticates, replays commands/events, and enforces revocation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-router-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pairing = new PairingStore({
    path: join(root, 'pairing.json'),
    hostName: 'Router host',
    protector,
    randomBytes: randomSource(),
  });
  const ledger = new CommandLedger({ path: join(root, 'commands.json') });
  const journals = new Map<string, EventJournal>();
  const journalFor = (deviceId: string) => {
    let journal = journals.get(deviceId);
    if (!journal) {
      journal = new EventJournal({ workspaceId: 'workspace-1', epoch: `epoch-${deviceId}` });
      journals.set(deviceId, journal);
    }
    return journal;
  };
  let dispatches = 0;
  let rejectValidation = false;
  let validations = 0;
  let revocations = 0;
  const router = new RemoteHostRouter({
    pairing,
    ledger,
    workspace: { id: 'workspace-1', name: 'Router host' },
    certificatePin,
    eventsFor: journalFor,
    authorizeProject: (_device, projectId) => projectId === 'project-1',
    validateCommand: () => {
      validations += 1;
      if (rejectValidation) throw new RemoteProtocolError('STATE_CHANGED', 'Mutable state changed.', 409, true);
    },
    newThreadId: () => 'host-thread-1',
    bootstrap: (device) => ({
      workspace: { id: 'workspace-1', name: 'Router host' },
      deviceId: device.id,
      cursor: journalFor(device.id).cursor(),
    }),
    thread: (_device, threadId) => threadId === 'thread-1' ? { id: threadId, projectId: 'project-1' } : null,
    dispatch: () => {
      dispatches += 1;
    },
    revokeDevice: (device) => {
      revocations += 1;
      pairing.revoke(device.id);
    },
  });
  t.after(() => router.close());

  const insecure = await router.handle({ secure: false, method: 'POST', pathname: '/v1/pair' });
  assert.equal(insecure.status, 426);

  const offer = pairing.createOffer({ capabilities: ['chat', 'approvals'], maxAccess: 'ask' });
  const paired = await router.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/pair',
    headers: { authorization: `Pair ${offer.secret}` },
    body: {
      offerId: offer.id,
      deviceName: 'Test phone',
      clientVersion: 'alpha-test',
      protocol: { major: 1, minor: 0 },
      requestedCapabilities: ['chat', 'approvals'],
    },
  });
  assert.equal(paired.status, 201);
  const credential = (paired.body as { credential: { token: string } }).credential.token;
  const headers = { authorization: `Bearer ${credential}` };

  const bootstrap = await router.handle({ secure: true, method: 'GET', pathname: '/v1/bootstrap', headers });
  assert.equal(bootstrap.status, 200);
  const thread = await router.handle({ secure: true, method: 'GET', pathname: '/v1/threads/thread-1', headers });
  assert.equal(thread.status, 200);

  const approvalOffer = pairing.createOffer({ capabilities: ['chat', 'approvals'], maxAccess: 'ask' });
  const approvalPair = await router.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/pair',
    headers: { authorization: `Pair ${approvalOffer.secret}` },
    body: {
      offerId: approvalOffer.id,
      deviceName: 'Approval-only phone',
      clientVersion: 'alpha-test',
      protocol: { major: 1, minor: 0 },
      requestedCapabilities: ['approvals'],
    },
  });
  assert.equal(approvalPair.status, 201);
  const approvalCredential = (approvalPair.body as { credential: { token: string } }).credential.token;
  const forbiddenBootstrap = await router.handle({
    secure: true,
    method: 'GET',
    pathname: '/v1/bootstrap',
    headers: { authorization: `Bearer ${approvalCredential}` },
  });
  assert.equal(forbiddenBootstrap.status, 403);
  assert.equal((forbiddenBootstrap.body as { error: { code: string } }).error.code, 'CAPABILITY_REQUIRED');

  const startCommand = {
    protocolVersion: 1,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    commandId: 'command-1',
    expectedThreadRevision: '1',
    kind: 'turn.start',
    payload: {
      threadId: 'thread-1',
      requestId: 'request-1',
      userMessageId: 'user-message-1',
      responseMessageId: 'assistant-message-1',
      model: { providerId: 'provider-1', modelId: 'org/nemotron-super' },
      content: 'Work on this.',
      attachmentIds: [],
      accessMode: 'ask',
    },
  };
  const { expectedThreadRevision: _omittedRevision, ...missingRevisionCommand } = startCommand;
  const missingRevision = await router.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: { ...missingRevisionCommand, commandId: 'command-without-revision' },
  });
  assert.equal(missingRevision.status, 409);
  assert.equal((missingRevision.body as { error: { code: string } }).error.code, 'REVISION_REQUIRED');
  assert.equal(dispatches, 0);
  assert.equal(validations, 0);

  const first = await router.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: startCommand,
  });
  rejectValidation = true;
  const replay = await router.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: {
      ...startCommand,
      payload: { ...startCommand.payload, model: { modelId: 'org/nemotron-super', providerId: 'provider-1' } },
    },
  });
  assert.equal(first.status, 202);
  assert.equal(replay.status, 202);
  assert.equal((replay.body as { replayed: boolean }).replayed, true);
  assert.equal(dispatches, 1);
  assert.equal(validations, 1);

  const conflict = await router.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: { ...startCommand, payload: { ...startCommand.payload, content: 'Different work.' } },
  });
  assert.equal(conflict.status, 409);
  assert.equal((conflict.body as { error: { code: string } }).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(validations, 1);

  rejectValidation = false;

  const tooMuchAccess = await router.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: {
      ...startCommand,
      commandId: 'command-full',
      payload: { ...startCommand.payload, requestId: 'request-full', accessMode: 'full' },
    },
  });
  assert.equal(tooMuchAccess.status, 403);

  const created = await router.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: {
      protocolVersion: 1,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      commandId: 'create-command',
      kind: 'thread.create',
      payload: { clientThreadId: 'local-thread-1', title: 'New remote chat' },
    },
  });
  assert.equal(
    (created.body as { receipt: { result: { threadId: string } } }).receipt.result.threadId,
    'host-thread-1'
  );

  const selectedModel = await router.handle({
    secure: true,
    method: 'POST',
    pathname: '/v1/commands',
    headers,
    body: {
      protocolVersion: 1,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      commandId: 'set-model-command',
      expectedThreadRevision: '7',
      kind: 'thread.set_model',
      payload: {
        threadId: 'thread-1',
        model: { providerId: 'provider-1', modelId: 'org/nemotron-super' },
      },
    },
  });
  assert.equal(selectedModel.status, 202);
  assert.equal((selectedModel.body as { receipt: { commandId: string } }).receipt.commandId, 'set-model-command');

  const deviceId = credential.slice(0, credential.indexOf('.'));
  const journal = journalFor(deviceId);
  journal.append({ kind: 'turn.text_delta', content: 'hello' });
  const events = await router.handle({
    secure: true,
    method: 'GET',
    pathname: '/v1/events',
    headers,
    query: { epoch: journal.cursor().epoch, after: '0', waitMs: '0' },
  });
  assert.equal(events.status, 200);
  assert.equal((events.body as { kind: string }).kind, 'events');

  const revoked = await router.handle({ secure: true, method: 'DELETE', pathname: '/v1/session', headers });
  assert.equal(revoked.status, 200);
  assert.equal(revocations, 1);
  const afterRevocation = await router.handle({ secure: true, method: 'GET', pathname: '/v1/bootstrap', headers });
  assert.equal(afterRevocation.status, 401);
});
