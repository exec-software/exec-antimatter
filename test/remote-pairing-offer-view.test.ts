import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRemotePairingOffer } from '../renderer/src/components/settings/remotePairingOffer';

const offer = () => ({
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  endpoint: 'https://192.0.2.57:43128',
  expiresAt: 1_789_870_000_000,
  capabilities: ['chat', 'approvals'],
  maxAccess: 'full',
  qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
});

test('accepts and clones a complete pairing response at the renderer IPC boundary', () => {
  const input = offer();
  const parsed = parseRemotePairingOffer(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed.capabilities, input.capabilities);
});

test('rejects legacy pairing responses before they enter React state', () => {
  const { qrDataUrl: _qrDataUrl, ...legacy } = offer();
  assert.throws(
    () => parseRemotePairingOffer(legacy),
    /incompatible pairing response.*restart Antimatter/i
  );
});

test('rejects malformed fields that the pairing view renders as structured values', () => {
  for (const patch of [
    { capabilities: undefined },
    { capabilities: ['chat', 42] },
    { maxAccess: 'unrestricted' },
    { qrDataUrl: 'data:text/html;base64,PGgxPm5vdCBhIFFSPC9oMT4=' },
  ]) {
    assert.throws(
      () => parseRemotePairingOffer({ ...offer(), ...patch }),
      /incompatible pairing response.*restart Antimatter/i
    );
  }
});
