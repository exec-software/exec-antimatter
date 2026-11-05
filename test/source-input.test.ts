import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCredentialUpdate, validateNewSource, validateProbeInput } from '../src/main/sourceInput';

const base = {
  id: 'source-1',
  name: 'OpenAI',
  apiKey: 'secret',
  baseUrl: 'https://api.openai.com/v1/',
  models: [{ id: 'gpt-test', name: 'GPT Test', contextWindow: 128_000 }],
  supportsStreaming: false,
  kind: 'openai',
  protocol: 'openai-responses',
  createdAt: 1,
};

test('validates and canonicalizes a new native source without trusting renderer-owned fields', () => {
  const before = Date.now();
  const source = validateNewSource(base, new Set());
  assert.equal(source.baseUrl, 'https://api.openai.com/v1');
  assert.equal(source.supportsStreaming, true);
  assert.ok(source.createdAt >= before);
  assert.equal(source.protocol, 'openai-responses');
  assert.deepEqual(source.models, [{ id: 'gpt-test', name: 'GPT Test', contextWindow: 128_000 }]);
});

test('new source creation preserves discovered execution limits including explicit null', () => {
  for (const maxEvaluatedTokens of [1, 128, Number.MAX_SAFE_INTEGER, null]) {
    const source = validateNewSource({
      ...base, kind: 'beholdd', protocol: 'openai-chat',
      models: [{ id: 'qwen3', name: 'Qwen', contextWindow: 131_072, maxEvaluatedTokens }],
    }, new Set());
    assert.deepEqual(source.models, [{ id: 'qwen3', name: 'Qwen', contextWindow: 131_072, maxEvaluatedTokens }]);
  }
  const unknown = validateNewSource({ ...base, models: [{ id: 'legacy' }] }, new Set());
  assert.deepEqual(unknown.models, [{ id: 'legacy', name: 'legacy' }]);
  assert.equal(Object.hasOwn(unknown.models[0], 'maxEvaluatedTokens'), false);
});

test('new source creation refuses malformed execution limits instead of coercing or losing them', () => {
  for (const maxEvaluatedTokens of [0, -1, 128.5, '128', true, false, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateNewSource({
      ...base, models: [{ id: 'qwen3', contextWindow: 131_072, maxEvaluatedTokens }],
    }, new Set()), /execution limit must be a positive safe integer or null/);
  }
});

test('rejects unknown and connector-incompatible protocols', () => {
  assert.throws(
    () => validateNewSource({ ...base, protocol: 'future-wire' }, new Set()),
    /Unsupported inference wire protocol/
  );
  assert.throws(
    () => validateNewSource({ ...base, kind: 'anthropic' }, new Set()),
    /anthropic cannot use the openai-responses/
  );
});

test('rejects endpoint-embedded secrets, public query values, duplicate ids, and replacement', () => {
  assert.throws(
    () => validateNewSource({ ...base, baseUrl: 'https://user:pass@example.test/v1' }, new Set()),
    /credentials in the API-key field/
  );
  assert.throws(
    () => validateNewSource({ ...base, baseUrl: 'https://example.test/v1?key=secret' }, new Set()),
    /query string or fragment/
  );
  assert.throws(
    () => validateNewSource({ ...base, models: [{ id: 'same' }, { id: 'same' }] }, new Set()),
    /same model id/
  );
  assert.throws(() => validateNewSource(base, new Set(['source-1'])), /already exists/);
});

test('one-shot probes validate protocol, URL, and credential before making a main-process request', () => {
  assert.deepEqual(
    validateProbeInput({
      baseUrl: 'https://api.anthropic.com/v1/',
      apiKey: 'key',
      protocol: 'anthropic-messages',
    }),
    {
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'key',
      protocol: 'anthropic-messages',
    }
  );
  assert.throws(
    () => validateProbeInput({ baseUrl: 'https://example.test/v1#fragment', apiKey: 'key' }),
    /query string or fragment/
  );
  assert.throws(
    () => validateProbeInput({ baseUrl: 'https://example.test/v1', apiKey: 'bad\nkey' }),
    /API key is not valid/
  );
});

test('credential rotation accepts only a bounded one-way source/key pair', () => {
  assert.deepEqual(validateCredentialUpdate({ id: 'source-1', apiKey: 'replacement-secret' }), {
    id: 'source-1',
    apiKey: 'replacement-secret',
  });
  assert.throws(() => validateCredentialUpdate({ id: 'source-1', apiKey: '' }), /API key is required/);
  assert.throws(() => validateCredentialUpdate({ id: 'source-1', apiKey: ' replacement-secret ' }), /not valid/);
  assert.throws(() => validateCredentialUpdate({ id: 'source-1', apiKey: 'replacement\tsecret' }), /not valid/);
  assert.throws(() => validateCredentialUpdate({ id: '../source', apiKey: 'secret' }), /unsupported characters/);
  assert.throws(() => validateCredentialUpdate({ id: 'source-1', apiKey: 'bad\nkey' }), /API key is not valid/);
});
