import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writePrivateFileAtomic } from '../src/main/privateState';
import { PairingStore, type SecretProtector } from '../src/main/remote/pairingStore';
import type { PairingExchangeInput } from '../src/main/remote/protocol';

const protector: SecretProtector = {
  seal: (value) => `sealed:${Buffer.from(value).toString('base64')}`,
  open: (value) => Buffer.from(value.slice('sealed:'.length), 'base64').toString(),
};

const deterministicRandom = () => {
  let value = 0;
  return (size: number) => Buffer.alloc(size, ++value);
};

const exchange = (offerId: string, secret: string, name: string): PairingExchangeInput & { secret: string } => ({
  offerId,
  secret,
  deviceName: name,
  clientVersion: 'alpha-test',
  protocol: { major: 1, minor: 0 },
  requestedCapabilities: ['chat', 'approvals'],
});

test('pairing offers are short-lived, single-use, and concurrency-safe', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-pairing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 1_000;
  const path = join(root, 'pairing.json');
  const store = new PairingStore({
    path,
    hostName: 'Test host',
    protector,
    now: () => now,
    randomBytes: deterministicRandom(),
    offerTtlMs: 100,
  });

  const expired = store.createOffer({ capabilities: ['chat'], maxAccess: 'read' });
  now = expired.expiresAt;
  assert.throws(() => store.exchangeOffer(exchange(expired.id, expired.secret, 'Late phone')), /invalid or expired/i);

  const once = store.createOffer({ capabilities: ['chat', 'approvals'], maxAccess: 'ask' });
  const paired = store.exchangeOffer(exchange(once.id, once.secret, 'First phone'));
  assert.equal(paired.device.name, 'First phone');
  assert.deepEqual(paired.device.capabilities, ['chat', 'approvals']);
  assert.throws(() => store.exchangeOffer(exchange(once.id, once.secret, 'Second phone')), /invalid or expired/i);

  const racing = store.createOffer({ capabilities: ['chat'], maxAccess: 'ask' });
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => store.exchangeOffer(exchange(racing.id, racing.secret, 'Racer one'))),
    Promise.resolve().then(() => store.exchangeOffer(exchange(racing.id, racing.secret, 'Racer two'))),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);

  const invalidated = store.createOffer({ capabilities: ['chat'], maxAccess: 'read' });
  assert.equal(store.clearOffers(), 1);
  assert.throws(
    () => store.exchangeOffer(exchange(invalidated.id, invalidated.secret, 'Disconnected phone')),
    /invalid or expired/i
  );

  const canceled = store.createOffer({ capabilities: ['chat'], maxAccess: 'ask' });
  assert.equal(store.cancelOffer(canceled.id), true);
  assert.equal(store.cancelOffer(canceled.id), false);
  assert.throws(
    () => store.exchangeOffer(exchange(canceled.id, canceled.secret, 'Canceled phone')),
    /invalid or expired/i
  );
});

test('trusted devices authenticate, redact secrets, persist identity, and revoke immediately', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-device-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 10_000;
  const path = join(root, 'pairing.json');
  const store = new PairingStore({
    path,
    hostName: 'Stable host',
    protector,
    now: () => now,
    randomBytes: deterministicRandom(),
    touchIntervalMs: 0,
  });
  const identity = store.identity();
  const offer = store.createOffer({ capabilities: ['chat', 'approvals'], maxAccess: 'ask' });
  const paired = store.exchangeOffer(exchange(offer.id, offer.secret, 'Pixel'));

  now += 5;
  const authenticated = store.authenticate(paired.credential);
  assert.equal(authenticated?.id, paired.device.id);
  assert.equal(authenticated?.lastSeenAt, now);
  const publicJson = JSON.stringify(store.listDevices());
  const stateJson = readFileSync(path, 'utf8');
  const credentialSecret = paired.credential.slice(paired.credential.indexOf('.') + 1);
  assert.doesNotMatch(publicJson, /tokenHash|credential|secret/i);
  assert.ok(!stateJson.includes(offer.secret));
  assert.ok(!stateJson.includes(credentialSecret));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(root).mode & 0o777, 0o700);

  let revoked = '';
  store.onRevoked((deviceId) => {
    revoked = deviceId;
  });
  assert.equal(store.revoke(paired.device.id), true);
  assert.equal(revoked, paired.device.id);
  assert.equal(store.authenticate(paired.credential), null);

  const reloaded = new PairingStore({
    path,
    hostName: 'Stable host',
    protector,
    now: () => now,
    randomBytes: deterministicRandom(),
  });
  assert.equal(reloaded.identity().id, identity.id);
  assert.equal(reloaded.authenticate(paired.credential), null);
});

test('pairing state publishes durable mutations only after the atomic writer succeeds', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-pairing-cow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'pairing.json');
  let now = 20_000;
  let failWrites = false;
  const store = new PairingStore({
    path,
    hostName: 'Copy-on-write host',
    protector,
    now: () => now,
    randomBytes: deterministicRandom(),
    touchIntervalMs: 1,
    writeFile: (target, contents) => {
      if (failWrites) throw new Error('injected pairing write failure');
      writePrivateFileAtomic(target, contents);
    },
  });
  const offer = store.createOffer({ capabilities: ['chat'], maxAccess: 'ask' });
  const paired = store.exchangeOffer(exchange(offer.id, offer.secret, 'Durable phone'));

  const consumedOffers: string[] = [];
  store.onOfferConsumed((offerId) => consumedOffers.push(offerId));
  const failedOffer = store.createOffer({ capabilities: ['chat'], maxAccess: 'read' });
  failWrites = true;
  assert.throws(
    () => store.exchangeOffer(exchange(failedOffer.id, failedOffer.secret, 'Memory-only phone')),
    /injected pairing write failure/
  );
  assert.deepEqual(consumedOffers, [failedOffer.id]);
  assert.throws(
    () => store.exchangeOffer(exchange(failedOffer.id, failedOffer.secret, 'Replay phone')),
    /invalid or expired/i
  );
  assert.deepEqual(store.listDevices().map((device) => device.id), [paired.device.id]);

  now += 10;
  assert.throws(() => store.authenticate(paired.credential), /injected pairing write failure/);
  assert.equal(store.listDevices()[0].lastSeenAt, paired.device.lastSeenAt);

  let notifications = 0;
  store.onRevoked(() => {
    notifications += 1;
  });
  assert.throws(() => store.revoke(paired.device.id), /injected pairing write failure/);
  assert.equal(store.activeDevice(paired.device.id)?.id, paired.device.id);
  assert.equal(notifications, 0, 'a non-durable revocation must not disconnect process-local work');

  const reloadedAfterFailure = new PairingStore({
    path,
    hostName: 'Copy-on-write host',
    protector,
    now: () => now,
    randomBytes: deterministicRandom(),
  });
  assert.equal(reloadedAfterFailure.authenticate(paired.credential)?.id, paired.device.id);

  failWrites = false;
  assert.equal(store.revoke(paired.device.id), true);
  assert.equal(notifications, 1);
  assert.equal(store.authenticate(paired.credential), null);
  const reloadedAfterSuccess = new PairingStore({
    path,
    hostName: 'Copy-on-write host',
    protector,
    now: () => now,
    randomBytes: deterministicRandom(),
  });
  assert.equal(reloadedAfterSuccess.authenticate(paired.credential), null);
});
