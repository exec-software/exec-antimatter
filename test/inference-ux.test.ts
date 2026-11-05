import assert from 'node:assert/strict';
import test from 'node:test';
import { isBundledNativeSource, sourcePickerLabel } from '../renderer/src/lib/inferenceUx';

test('recognizes only the bundled loopback beholdd endpoint as the native source', () => {
  assert.equal(isBundledNativeSource({ kind: 'beholdd', baseUrl: 'http://127.0.0.1:6768/v1' }), true);
  assert.equal(isBundledNativeSource({ kind: 'beholdd', baseUrl: 'http://localhost:6768/v1/' }), true);
  assert.equal(isBundledNativeSource({ baseUrl: 'http://[::1]:6768/v1' }), true);

  assert.equal(isBundledNativeSource({ kind: 'beholdd', baseUrl: 'http://127.0.0.1:6767/v1' }), false);
  assert.equal(isBundledNativeSource({ kind: 'beholdd', baseUrl: 'http://inference.local:6768/v1' }), false);
  assert.equal(isBundledNativeSource({ kind: 'openai', baseUrl: 'http://127.0.0.1:6768/v1' }), false);
  assert.equal(
    isBundledNativeSource({ id: 'local-beholdd-external', kind: 'beholdd', baseUrl: 'http://127.0.0.1:6768/v1' }),
    false
  );
  assert.equal(isBundledNativeSource({ kind: 'beholdd', baseUrl: 'not a URL' }), false);
});

test('labels the bundled source without changing other source names', () => {
  assert.equal(
    sourcePickerLabel({ name: 'beholdd', kind: 'beholdd', baseUrl: 'http://127.0.0.1:6768/v1' }),
    'beholdd — native'
  );
  assert.equal(
    sourcePickerLabel({ name: 'beholdd GPU', kind: 'beholdd', baseUrl: 'http://127.0.0.1:6767/v1' }),
    'beholdd GPU'
  );
});
