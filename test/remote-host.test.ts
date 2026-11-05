import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import test from 'node:test';
import { RemoteWorkspaceHost } from '../src/main/remote/host';

const protector = {
  available: () => true,
  seal: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
  open: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
};

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function httpsJson(options: {
  port: number;
  path: string;
  method?: string;
  authorization?: string;
  body?: unknown;
  origin?: string;
}): Promise<{ status: number; body: Record<string, unknown>; peerPin: string }> {
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    let peerPin = '';
    const request = httpsRequest({
      hostname: '127.0.0.1',
      port: options.port,
      path: options.path,
      method: options.method ?? 'GET',
      rejectUnauthorized: false,
      // Every assertion below is about this request's peer certificate. Node's global HTTPS
      // agent may reuse an already-secure socket, in which case `secureConnect` has already fired
      // before this helper can inspect it.
      agent: false,
      headers: {
        ...(options.authorization ? { authorization: options.authorization } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          peerPin,
        });
      });
    });
    request.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        const raw = (socket as TLSSocket).getPeerCertificate().raw;
        peerPin = `sha256/${createHash('sha256').update(raw).digest('base64')}`;
      });
    });
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

test('desktop remote host binds pinned HTTPS, pairs once, authenticates, and rejects browser origins', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-host-'));
  const project = join(root, 'project');
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const port = await freePort();
  const disconnected: string[] = [];
  const consumedCodes: string[] = [];
  const invalidatedOfferIds: string[] = [];
  const host = new RemoteWorkspaceHost({
    userData: join(root, 'user-data'),
    appVersion: 'test-version',
    hostName: 'Test workstation',
    protector,
    callbacks: {
      currentProject: () => ({ root: project, name: 'Project' }),
      bootstrap: ({ workspace, projects, cursor, device }) => ({
        protocolVersion: 1,
        host: workspace,
        workspace,
        capabilities: device.capabilities,
        projects,
        models: [],
        conversations: [],
        activeTurns: [],
        revision: '0',
        cursor,
      }),
      thread: () => null,
      dispatch: () => undefined,
      onDeviceDisconnected: (deviceId, reason) => disconnected.push(`${deviceId}:${reason}`),
      onPairingInvalidated: (pairingCode, offerId) => {
        consumedCodes.push(pairingCode);
        invalidatedOfferIds.push(offerId);
      },
    },
  });
  t.after(() => host.stop());

  assert.equal(host.hasEventConsumers(), false);
  const state = await host.configure({ enabled: true, address: '127.0.0.1', port });
  assert.equal(state.running, true);
  assert.equal(host.hasEventConsumers(), false);
  assert.match(state.certificatePin ?? '', /^sha256\//);

  const browser = await httpsJson({ port, path: '/v1/bootstrap', origin: 'https://attacker.invalid' });
  assert.equal(browser.status, 403);

  const offer = await host.createPairingOffer();
  assert.deepEqual(Object.keys(offer).sort(), ['capabilities', 'endpoint', 'expiresAt', 'id', 'maxAccess']);
  assert.deepEqual(offer.capabilities, ['chat', 'approvals']);
  assert.equal(offer.maxAccess, 'full');
  const code = host.pairingCode(offer.id);
  assert.ok(code);
  assert.match(code, /^ANTIMATTER-PAIRING-V1\?/);
  assert.doesNotMatch(code, /^(?:https?|antimatter):\/\//i);
  const parameters = new URLSearchParams(code.split('?', 2)[1]);
  const pairing = await httpsJson({
    port,
    path: '/v1/pair',
    method: 'POST',
    authorization: `Pair ${parameters.get('secret')}`,
    body: {
      offerId: parameters.get('offer'),
      deviceName: 'Test phone',
      clientVersion: 'test-client',
      protocol: { major: 1, minor: 0 },
      requestedCapabilities: ['chat', 'approvals'],
    },
  });
  assert.equal(pairing.status, 201);
  assert.equal(host.hasEventConsumers(), true);
  assert.equal(pairing.peerPin, state.certificatePin);
  const credential = pairing.body.credential as { token: string };
  const pairedDevice = pairing.body.device as { id: string };
  assert.ok(credential.token);
  assert.equal(host.pairingCode(offer.id), null);
  assert.deepEqual(consumedCodes, [code]);
  assert.deepEqual(invalidatedOfferIds, [offer.id]);

  const bootstrap = await httpsJson({
    port,
    path: '/v1/bootstrap',
    authorization: `Bearer ${credential.token}`,
  });
  assert.equal(bootstrap.status, 200);
  assert.equal((bootstrap.body.workspace as { id: string }).id, host.workspace().id);

  const replay = await httpsJson({
    port,
    path: '/v1/pair',
    method: 'POST',
    authorization: `Pair ${parameters.get('secret')}`,
    body: {
      offerId: parameters.get('offer'),
      deviceName: 'Second phone',
      clientVersion: 'test-client',
      protocol: { major: 1, minor: 0 },
      requestedCapabilities: ['chat'],
    },
  });
  assert.equal(replay.status, 401);

  const replacedOffer = await host.createPairingOffer();
  const replacedCode = host.pairingCode(replacedOffer.id);
  assert.ok(replacedCode);
  const replacementOffer = await host.createPairingOffer();
  const replacementCode = host.pairingCode(replacementOffer.id);
  assert.equal(host.pairingCode(replacedOffer.id), null);
  assert.ok(replacementCode);
  assert.ok(consumedCodes.includes(replacedCode));
  assert.ok(invalidatedOfferIds.includes(replacedOffer.id));
  assert.ok(replacementOffer.expiresAt - Date.now() <= 2 * 60_000);
  assert.ok(replacementOffer.expiresAt - Date.now() > 60_000);
  assert.equal(host.cancelPairingOffer(replacementOffer.id), true);
  assert.equal(host.cancelPairingOffer(replacementOffer.id), false);
  assert.equal(host.pairingCode(replacementOffer.id), null);
  assert.ok(consumedCodes.includes(replacementCode));
  assert.ok(invalidatedOfferIds.includes(replacementOffer.id));

  const replacedParameters = new URLSearchParams(replacedCode.split('?', 2)[1]);
  const replacedAttempt = await httpsJson({
    port,
    path: '/v1/pair',
    method: 'POST',
    authorization: `Pair ${replacedParameters.get('secret')}`,
    body: {
      offerId: replacedParameters.get('offer'),
      deviceName: 'Stale QR phone',
      clientVersion: 'test-client',
      protocol: { major: 1, minor: 0 },
      requestedCapabilities: ['chat'],
    },
  });
  assert.equal(replacedAttempt.status, 401);

  const revoked = await httpsJson({
    port,
    path: '/v1/session',
    method: 'DELETE',
    authorization: `Bearer ${credential.token}`,
  });
  assert.equal(revoked.status, 200);
  assert.ok(disconnected.includes(`${pairedDevice.id}:revoked`));
  assert.ok(host.state().devices.find((device) => device.id === pairedDevice.id)?.revokedAt);
  assert.equal(host.hasEventConsumers(), false);

  const secondOffer = await host.createPairingOffer();
  const secondParameters = new URLSearchParams(host.pairingCode(secondOffer.id)?.split('?', 2)[1] ?? '');
  const secondPairing = await httpsJson({
    port,
    path: '/v1/pair',
    method: 'POST',
    authorization: `Pair ${secondParameters.get('secret')}`,
    body: {
      offerId: secondParameters.get('offer'),
      deviceName: 'Second phone',
      clientVersion: 'test-client',
      protocol: { major: 1, minor: 0 },
      requestedCapabilities: ['chat'],
    },
  });
  assert.equal(secondPairing.status, 201);
  assert.equal(host.hasEventConsumers(), true);
  const secondDevice = secondPairing.body.device as { id: string };
  const dangling = await host.createPairingOffer();
  assert.ok(host.pairingCode(dangling.id));
  await host.configure({ enabled: false });
  assert.equal(host.hasEventConsumers(), false);
  assert.equal(host.pairingCode(dangling.id), null);
  assert.ok(disconnected.includes(`${secondDevice.id}:disabled`));
});

test('desktop pairing expiry is owned by main and clears presentation secrets', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-host-expiry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const port = await freePort();
  const invalidated: Array<{ code: string; offerId: string }> = [];
  const host = new RemoteWorkspaceHost({
    userData: join(root, 'user-data'),
    appVersion: 'test-version',
    hostName: 'Expiry host',
    protector,
    pairingOfferTtlMs: 20,
    callbacks: {
      currentProject: () => null,
      bootstrap: () => ({}),
      thread: () => null,
      dispatch: () => undefined,
      onPairingInvalidated: (code, offerId) => invalidated.push({ code, offerId }),
    },
  });
  t.after(() => host.stop());
  await host.configure({ enabled: true, address: '127.0.0.1', port });
  const offer = await host.createPairingOffer();
  const code = host.pairingCode(offer.id);
  assert.ok(code);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(host.pairingCode(offer.id), null);
  assert.deepEqual(invalidated, [{ code, offerId: offer.id }]);
});
