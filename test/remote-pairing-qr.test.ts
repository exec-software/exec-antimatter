import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePairingQrDataUrl, MAX_PAIRING_QR_DATA_URL_LENGTH } from '../src/main/remote/pairingQr';

test('encodes pairing text as a bounded opaque PNG data URL', async () => {
  const secret = 'ANTIMATTER-PAIRING-V1?secret=must-not-appear-as-renderer-text';
  const dataUrl = await encodePairingQrDataUrl(secret);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  assert.ok(dataUrl.length < MAX_PAIRING_QR_DATA_URL_LENGTH);
  assert.equal(dataUrl.includes(secret), false);
  assert.deepEqual(
    Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64').subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
});

test('rejects oversized pairing payloads before encoding', async () => {
  await assert.rejects(encodePairingQrDataUrl('x'.repeat(2_049)), /too large/i);
});
