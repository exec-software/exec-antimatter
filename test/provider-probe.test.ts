import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeProbedModels, persistedModel, probeSource } from '../src/main/probe';
import { refreshSource } from '../src/main/sourceRefresh';
import type { Model } from '../src/api/types';

async function withFetch<T>(implementation: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('Anthropic discovery uses native headers and normalizes display names and input limits', async () => {
  let url = '';
  let headers = new Headers();
  let redirect: RequestRedirect | undefined;
  const result = await withFetch(
    (async (input, init) => {
      url = String(input);
      headers = new Headers(init?.headers);
      redirect = init?.redirect;
      return Response.json({
        data: [
          {
            id: 'claude-test',
            display_name: 'Claude Test',
            type: 'model',
            max_input_tokens: 200_000,
          },
        ],
        has_more: false,
      });
    }) as typeof fetch,
    () => probeSource('https://api.anthropic.com/v1/', 'anthropic-secret', 'anthropic-messages')
  );

  assert.equal(url, 'https://api.anthropic.com/v1/models');
  assert.equal(headers.get('x-api-key'), 'anthropic-secret');
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(headers.get('authorization'), null);
  assert.equal(redirect, 'error');
  assert.deepEqual(result.models, [
    {
      id: 'claude-test',
      name: 'Claude Test',
      loaded: undefined,
      contextWindow: 200_000,
      vision: undefined,
    },
  ]);
});

test('legacy and Responses discovery retain Bearer authentication and OpenAI model shape', async () => {
  const seen: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect }> = [];
  const implementation = (async (input, init) => {
    seen.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      redirect: init?.redirect,
    });
    return Response.json({ data: [{ id: 'gpt-test' }] });
  }) as typeof fetch;

  const [legacy, responses] = await withFetch(implementation, async () => [
    await probeSource('https://gateway.example/v1', 'legacy-key'),
    await probeSource('https://api.openai.com/v1', 'responses-key', 'openai-responses'),
  ]);

  assert.deepEqual(seen, [
    { url: 'https://gateway.example/v1/models', authorization: 'Bearer legacy-key', redirect: 'error' },
    { url: 'https://api.openai.com/v1/models', authorization: 'Bearer responses-key', redirect: 'error' },
  ]);
  assert.equal(legacy.models[0]?.name, 'gpt-test');
  assert.equal(responses.models[0]?.id, 'gpt-test');
});

test('Responses discovery excludes obvious non-conversation products without narrowing legacy catalogs', async () => {
  const catalog = [
    'gpt-5.2',
    'o4-mini',
    'computer-use-preview',
    'gateway-custom-model',
    'text-embedding-3-large',
    'omni-moderation-latest',
    'gpt-image-1',
    'chatgpt-image-latest',
    'dall-e-3',
    'whisper-1',
    'gpt-4o-audio-preview',
    'gpt-4o-mini-transcribe',
    'gpt-4o-mini-tts',
    'gpt-4o-realtime-preview',
    'sora-2',
    'babbage-002',
  ];
  const implementation = (async () => Response.json({ data: catalog.map((id) => ({ id })) })) as typeof fetch;

  const [legacy, responses] = await withFetch(implementation, async () => [
    await probeSource('https://legacy.example/v1', 'key', 'openai-chat'),
    await probeSource('https://api.openai.com/v1', 'key', 'openai-responses'),
  ]);

  assert.deepEqual(legacy.models.map((model) => model.id), catalog, 'legacy gateways retain their existing behavior');
  assert.deepEqual(
    responses.models.map((model) => model.id),
    ['gpt-5.2', 'o4-mini', 'computer-use-preview', 'gateway-custom-model']
  );
});

test('Anthropic discovery follows bounded cursor pagination', async () => {
  const urls: string[] = [];
  const result = await withFetch(
    (async (input) => {
      urls.push(String(input));
      return urls.length === 1
        ? Response.json({
            data: [{ id: 'claude-a', display_name: 'Claude A' }],
            has_more: true,
            last_id: 'claude-a',
          })
        : Response.json({
            data: [{ id: 'claude-b', display_name: 'Claude B' }],
            has_more: false,
          });
    }) as typeof fetch,
    () => probeSource('https://api.anthropic.com/v1', 'key', 'anthropic-messages')
  );

  assert.deepEqual(urls, [
    'https://api.anthropic.com/v1/models',
    'https://api.anthropic.com/v1/models?after_id=claude-a',
  ]);
  assert.deepEqual(result.models.map((model) => model.id), ['claude-a', 'claude-b']);
});

test('an unknown stored protocol fails closed before its credential reaches fetch', async () => {
  let fetched = false;
  const result = await withFetch(
    (async () => {
      fetched = true;
      return Response.json({ data: [] });
    }) as typeof fetch,
    () => probeSource('https://models.example/v1', 'secret', 'future-wire' as never)
  );
  assert.equal(fetched, false);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /unsupported inference wire protocol/);
});

test('discovery errors redact a stored credential reflected in the HTTP reason phrase', async () => {
  const secret = 'stored-probe-secret';
  const result = await withFetch(
    (async () => new Response(null, { status: 401, statusText: `Denied ${secret}` })) as typeof fetch,
    () => probeSource('https://models.example/v1', secret, 'openai-responses')
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /401 Denied \[redacted\]/);
  assert.doesNotMatch(result.error ?? '', new RegExp(secret));
});

test('discovery preserves execution caps separately from context metadata and explicit null', async () => {
  const result = await withFetch(
    (async () => Response.json({ data: [
      { id: 'qwen3-hag', context_length: 131_072, execution_limits: { max_evaluated_tokens: 128 } },
      { id: 'one', execution_limits: { max_evaluated_tokens: 1 } },
      { id: 'largest-safe', execution_limits: { max_evaluated_tokens: Number.MAX_SAFE_INTEGER } },
      { id: 'cpu', execution_limits: { max_evaluated_tokens: null } },
      { id: 'legacy' },
      { id: 'incomplete', execution_limits: {} },
    ] })) as typeof fetch,
    () => probeSource('http://127.0.0.1:6768/v1')
  );

  assert.equal(result.ok, true);
  assert.equal(result.models[0].contextWindow, 131_072, 'the runtime cap does not rewrite checkpoint context');
  assert.deepEqual(result.models.map((model) => model.maxEvaluatedTokens),
    [128, 1, Number.MAX_SAFE_INTEGER, null, undefined, undefined]);
  assert.equal(Object.hasOwn(result.models[3], 'maxEvaluatedTokens'), true, 'null is an authoritative observation');
  assert.equal(Object.hasOwn(result.models[4], 'maxEvaluatedTokens'), false, 'legacy catalogs keep their old shape');
  assert.equal(Object.hasOwn(result.models[5], 'maxEvaluatedTokens'), false, 'an omitted key stays unknown');
});

test('malformed advertised execution limits fail the whole probe rather than discard a cap', async () => {
  const limits = [null, [], true, 128, '128',
    ...[0, -1, 1.5, '128', true, {}, [], Number.MAX_SAFE_INTEGER + 1]
      .map((value) => ({ max_evaluated_tokens: value }))];
  for (const execution_limits of limits) {
    const result = await withFetch(
      (async () => Response.json({ data: [
        { id: 'valid', execution_limits: { max_evaluated_tokens: 128 } },
        { id: 'qwen3-invalid', context_length: 131_072, execution_limits },
      ] })) as typeof fetch,
      () => probeSource('http://127.0.0.1:6768/v1')
    );
    assert.equal(result.ok, false, JSON.stringify(execution_limits));
    assert.deepEqual(result.models, [], 'no partially validated catalog may be adopted');
    assert.match(result.error ?? '', /invalid model execution_limits/);
  }
  const nonfinite = await withFetch(
    (async () => new Response('{"data":[{"id":"qwen3","execution_limits":{"max_evaluated_tokens":1e400}}]}')) as typeof fetch,
    () => probeSource('http://127.0.0.1:6768/v1')
  );
  assert.equal(nonfinite.ok, false);
  assert.match(nonfinite.error ?? '', /positive safe integer/);
});

test('execution-cap refresh bypasses curated context and preserves identity only when unchanged', () => {
  const prior: Model = {
    id: 'qwen3', name: 'My model', contextWindow: 131_072, contextWindowCurated: true,
    manuallyDeclared: true, maxEvaluatedTokens: 128,
  };
  const configured = [prior];
  const same = mergeProbedModels(configured, [{ id: 'qwen3', name: 'server', maxEvaluatedTokens: 128 }]);
  assert.equal(same, configured);
  assert.equal(same[0], prior);
  assert.equal(mergeProbedModels(configured, [{ id: 'qwen3', name: 'server' }]), configured,
    'an incomplete observation cannot silently lift the cap');

  const changed = mergeProbedModels(configured,
    [{ id: 'qwen3', name: 'server', contextWindow: 4096, maxEvaluatedTokens: 64 }]);
  assert.notEqual(changed, configured);
  assert.notEqual(changed[0], prior);
  assert.equal(changed[0].maxEvaluatedTokens, 64);
  assert.equal(changed[0].contextWindow, 131_072, 'curated context remains independent');
  assert.equal(changed[0].name, 'My model');
  assert.equal(prior.maxEvaluatedTokens, 128, 'the original source is not mutated');

  const cleared = mergeProbedModels(changed, [{ id: 'qwen3', name: 'server', maxEvaluatedTokens: null }]);
  assert.notEqual(cleared, changed);
  assert.equal(cleared[0].maxEvaluatedTokens, null);
  assert.equal(cleared[0].contextWindow, 131_072);
  assert.equal(mergeProbedModels(cleared, [{ id: 'qwen3', name: 'server' }]), cleared);
  assert.deepEqual(persistedModel({ id: 'new', name: 'New', maxEvaluatedTokens: 128 }),
    { id: 'new', name: 'New', maxEvaluatedTokens: 128 });
});

test('a malformed execution cap cannot overwrite an established source during refresh', async () => {
  const source = {
    id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:6768/v1', apiKey: '',
    supportsStreaming: true, kind: 'beholdd' as const, createdAt: 1,
    models: [{ id: 'qwen3', name: 'Qwen', maxEvaluatedTokens: 128 }],
  };
  let saves = 0;
  const result = await withFetch(
    (async () => Response.json({ data: [{ id: 'qwen3', execution_limits: { max_evaluated_tokens: '128' } }] })) as typeof fetch,
    () => refreshSource(source, true, {
      current: () => source,
      probe: probeSource,
      save: (next) => { saves += 1; return next; },
    })
  );
  assert.equal(result.probe.ok, false);
  assert.equal(result.saved, null);
  assert.equal(saves, 0);
  assert.equal(source.models[0].maxEvaluatedTokens, 128);
});
