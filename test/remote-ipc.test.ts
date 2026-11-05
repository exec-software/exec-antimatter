import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { REMOTE_IPC, REMOTE_IPC_CHANNELS } from '../src/api/remoteIpc';
import type { RemoteWorkspaceHost } from '../src/main/remote/host';
import { registerRemoteIpcHandlers } from '../src/main/remote/ipc';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

test('registers and forwards the complete Remote IPC contract', async () => {
  const offerId = 'AAAAAAAAAAAAAAAAAAAAAA';
  const handlers = new Map<string, Handler>();
  const calls: Array<[string, unknown]> = [];
  const allowedSender = {};
  const state = { enabled: false };
  const configured = { enabled: true };
  const revoked = { enabled: true, devices: [] };
  const qrDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const host = {
    state: () => state,
    configure: async (patch: unknown) => {
      calls.push(['configure', patch]);
      return configured;
    },
    createPairingOffer: async () => ({
      id: offerId,
      endpoint: 'https://host.test:43128',
      expiresAt: 42,
      capabilities: ['chat', 'approvals'],
      maxAccess: 'full',
    }),
    pairingCode: (candidate: string) => candidate === offerId ? 'private-code' : null,
    cancelPairingOffer: (candidate: string) => {
      calls.push(['cancel', candidate]);
      return candidate === offerId;
    },
    revokeDevice: (deviceId: string) => {
      calls.push(['revoke', deviceId]);
      return revoked;
    },
  } as unknown as RemoteWorkspaceHost;
  const clipboard: string[] = [];
  const ipc = {
    handle(channel: string, handler: Handler) {
      assert.equal(handlers.has(channel), false, `duplicate handler for ${channel}`);
      handlers.set(channel, handler);
    },
  } as unknown as Pick<IpcMain, 'handle'>;

  registerRemoteIpcHandlers(ipc, {
    host: () => host,
    isAllowedSender: (event) => event.sender === allowedSender,
    writeClipboard: (value) => clipboard.push(value),
    encodePairingQr: async (value) => {
      assert.equal(value, 'private-code');
      return qrDataUrl;
    },
  });

  assert.deepEqual([...handlers.keys()].sort(), [...REMOTE_IPC_CHANNELS].sort());
  const event = { sender: allowedSender } as IpcMainInvokeEvent;
  assert.equal(handlers.get(REMOTE_IPC.state)?.(event), state);
  assert.equal(await handlers.get(REMOTE_IPC.configure)?.(event, { enabled: true }), configured);
  assert.deepEqual(await handlers.get(REMOTE_IPC.createPairingOffer)?.(event), {
    id: offerId,
    endpoint: 'https://host.test:43128',
    expiresAt: 42,
    capabilities: ['chat', 'approvals'],
    maxAccess: 'full',
    qrDataUrl,
  });
  assert.equal(handlers.get(REMOTE_IPC.copyPairingCode)?.(event, offerId), true);
  assert.equal(handlers.get(REMOTE_IPC.copyPairingCode)?.(event, 'BBBBBBBBBBBBBBBBBBBBBB'), false);
  assert.equal(handlers.get(REMOTE_IPC.cancelPairingOffer)?.(event, offerId), true);
  assert.throws(() => handlers.get(REMOTE_IPC.copyPairingCode)?.(event, 'bad id'), /invalid pairing offer/i);
  assert.throws(() => handlers.get(REMOTE_IPC.cancelPairingOffer)?.(event, ''), /invalid pairing offer/i);
  assert.equal(handlers.get(REMOTE_IPC.revokeDevice)?.(event, 'phone'), revoked);
  assert.deepEqual(calls, [['configure', { enabled: true }], ['cancel', offerId], ['revoke', 'phone']]);
  assert.deepEqual(clipboard, ['private-code']);
});

test('invalidates an offer when QR encoding fails', async () => {
  const offerId = 'AAAAAAAAAAAAAAAAAAAAAA';
  const handlers = new Map<string, Handler>();
  const canceled: string[] = [];
  const sender = {};
  const host = {
    createPairingOffer: async () => ({
      id: offerId,
      endpoint: 'https://host.test:43128',
      expiresAt: 42,
      capabilities: ['chat'],
      maxAccess: 'ask',
    }),
    pairingCode: () => 'private-code',
    cancelPairingOffer: (offerId: string) => {
      canceled.push(offerId);
      return true;
    },
  } as unknown as RemoteWorkspaceHost;
  const ipc = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
  } as unknown as Pick<IpcMain, 'handle'>;
  registerRemoteIpcHandlers(ipc, {
    host: () => host,
    isAllowedSender: (event) => event.sender === sender,
    writeClipboard: () => undefined,
    encodePairingQr: async () => { throw new Error('encoder failed'); },
  });

  await assert.rejects(
    handlers.get(REMOTE_IPC.createPairingOffer)?.({ sender } as IpcMainInvokeEvent) as Promise<unknown>,
    /could not create a pairing QR code/i
  );
  assert.deepEqual(canceled, [offerId]);
});

test('rejects Remote IPC from any window except the main Antimatter renderer', async () => {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
  } as unknown as Pick<IpcMain, 'handle'>;
  registerRemoteIpcHandlers(ipc, {
    host: () => ({ state: () => ({}) }) as unknown as RemoteWorkspaceHost,
    isAllowedSender: () => false,
    writeClipboard: () => assert.fail('foreign renderers must not reach the clipboard'),
    encodePairingQr: async () => assert.fail('foreign renderers must not reach the QR encoder'),
  });

  assert.throws(
    () => handlers.get(REMOTE_IPC.state)?.({ sender: {} } as IpcMainInvokeEvent),
    /only available from the main Antimatter window/
  );
  await assert.rejects(
    handlers.get(REMOTE_IPC.createPairingOffer)?.({ sender: {} } as IpcMainInvokeEvent) as Promise<unknown>,
    /only available from the main Antimatter window/
  );
  assert.throws(
    () => handlers.get(REMOTE_IPC.cancelPairingOffer)?.({ sender: {} } as IpcMainInvokeEvent, 'AAAAAAAAAAAAAAAAAAAAAA'),
    /only available from the main Antimatter window/
  );
});
