import assert from 'node:assert/strict';
import test from 'node:test';
import type { InferenceSource } from '../src/main/sourceStore';
import type { ProbeResult } from '../src/main/probe';
import { refreshSource } from '../src/main/sourceRefresh';

const configured = (): InferenceSource => ({
  id: 'private-source',
  name: 'Private source',
  apiKey: 'stored-secret',
  baseUrl: 'https://models.example/v1',
  models: [
    {
      id: 'known',
      name: 'Friendly known',
      architecture: 'nemotron_h_moe',
      quantization: 'Q4_K_M',
      contextWindow: 131_072,
      vision: true,
      manuallyDeclared: true,
      contextWindowCurated: true,
      visionCurated: true,
    },
    { id: 'curated', name: 'Curated' },
    { id: 'kept-unknown', name: 'Kept unknown', contextWindowCurated: true, visionCurated: true },
    { id: 'observed', name: 'Observed', contextWindow: 32_768, vision: true },
  ],
  supportsStreaming: true,
  kind: 'openai',
  createdAt: 1,
});

test('testing a configured source uses its stored credential without writing it back', async () => {
  let saved = false;
  let request: { baseUrl: string; apiKey?: string; protocol?: string } | null = null;
  const result = await refreshSource(configured(), false, {
    current: () => configured(),
    probe: async (baseUrl, apiKey, protocol) => {
      request = { baseUrl, apiKey, protocol };
      return { ok: true, latencyMs: 2, models: [{ id: 'known', name: 'known', contextWindow: 32_768 }] };
    },
    save: (source) => {
      saved = true;
      return source;
    },
  });

  assert.deepEqual(request, {
    baseUrl: 'https://models.example/v1',
    apiKey: 'stored-secret',
    protocol: undefined,
  });
  assert.equal(result.probe.ok, true);
  assert.equal(result.saved, null);
  assert.equal(saved, false);
});

test('refresh merges durable metadata and preserves configured models and the private credential', async () => {
  let written: InferenceSource | null = null;
  const result = await refreshSource(configured(), true, {
    current: () => configured(),
    probe: async () => ({
      ok: true,
      latencyMs: 3,
      models: [
        { id: 'known', name: 'server name', contextWindow: 65_536, vision: false },
        { id: 'kept-unknown', name: 'server unknown', contextWindow: 65_536, vision: false },
        { id: 'observed', name: 'server observed', contextWindow: 65_536, vision: false },
        { id: 'new', name: 'New model', vision: true },
      ],
    }),
    save: (source) => {
      written = source;
      return source;
    },
  });

  assert.equal(result.saved, written);
  assert.equal(written?.apiKey, 'stored-secret');
  // `curated` is absent from the probe and carries no declaration or Library edit, so it goes:
  // it was only ever adopted from a listing, and the source has stopped listing it. `kept-unknown`
  // is the same shape plus curated metadata, which is exactly what makes it survive.
  assert.deepEqual(written?.models, [
    {
      id: 'known',
      name: 'Friendly known',
      architecture: 'nemotron_h_moe',
      quantization: 'Q4_K_M',
      contextWindow: 131_072,
      vision: true,
      manuallyDeclared: true,
      contextWindowCurated: true,
      visionCurated: true,
    },
    { id: 'kept-unknown', name: 'Kept unknown', contextWindowCurated: true, visionCurated: true },
    { id: 'observed', name: 'Observed', contextWindow: 65_536, vision: false },
    { id: 'new', name: 'New model', vision: true },
  ]);
});

test('Responses refresh filters discovery-only products but preserves an explicit declaration', async () => {
  const source: InferenceSource = {
    ...configured(),
    protocol: 'openai-responses',
    models: [{ id: 'gpt-image-1', name: 'Explicit image endpoint', manuallyDeclared: true }],
  };
  let written: InferenceSource | null = null;
  await refreshSource(source, true, {
    current: () => source,
    // A custom transport can bypass probeSource, so persistence enforces this boundary too.
    probe: async () => ({
      ok: true,
      latencyMs: 1,
      models: [
        { id: 'gpt-image-1', name: 'Image' },
        { id: 'text-embedding-3-large', name: 'Embedding' },
        { id: 'gpt-5.2', name: 'GPT 5.2' },
      ],
    }),
    save: (next) => (written = next),
  });

  assert.deepEqual(written?.models.map((model) => model.id), ['gpt-image-1', 'gpt-5.2']);
  assert.equal(written?.models[0]?.manuallyDeclared, true, 'explicit declarations are never invalidated by discovery');
});

test('a failed refresh never rewrites the configured catalog', async () => {
  let saved = false;
  const result = await refreshSource(configured(), true, {
    current: () => configured(),
    probe: async () => ({ ok: false, latencyMs: 5, models: [], error: 'offline' }),
    save: (source) => {
      saved = true;
      return source;
    },
  });

  assert.equal(result.probe.error, 'offline');
  assert.equal(result.saved, null);
  assert.equal(saved, false);
});

test('OpenCode Zen refresh never imports its heterogeneous shared model catalog', async () => {
  const zen: InferenceSource = {
    ...configured(),
    id: 'opencode-zen-responses',
    name: 'OpenCode Zen — Responses',
    kind: 'opencode-zen',
    protocol: 'openai-responses',
    models: [],
  };
  let saved = false;
  let observedProtocol = '';
  const result = await refreshSource(zen, true, {
    current: () => zen,
    probe: async (_baseUrl, _apiKey, protocol) => {
      observedProtocol = protocol ?? '';
      return {
        ok: true,
        latencyMs: 4,
        models: [
          { id: 'gpt-5', name: 'GPT 5' },
          { id: 'claude-sonnet', name: 'Claude Sonnet' },
        ],
      };
    },
    save: (source) => {
      saved = true;
      return source;
    },
  });

  assert.equal(observedProtocol, 'openai-responses', 'probing still checks the configured endpoint');
  assert.equal(result.probe.ok, true);
  assert.equal(result.probe.models.length, 2, 'the diagnostic probe result remains truthful');
  assert.equal(result.saved, null);
  assert.equal(saved, false, 'a generic Zen catalog must not cross a protocol boundary');
  assert.deepEqual(zen.models, []);
});

const observation = (capacity: number | null): ProbeResult => ({
  ok: true, latencyMs: 1,
  models: [{ id: 'known', name: 'Server name', maxEvaluatedTokens: capacity }],
});

function deferredProbe() {
  let complete!: (result: ProbeResult) => void;
  const promise = new Promise<ProbeResult>((resolve) => { complete = resolve; });
  return { promise, complete };
}

test('an in-flight observation cannot restore a removed or retargeted source', async () => {
  const replacements: Array<(source: InferenceSource) => InferenceSource | null> = [
    () => null,
    (source) => ({ ...source, baseUrl: 'https://replacement.example/v1' }),
    (source) => ({ ...source, protocol: 'openai-responses' }),
    (source) => ({ ...source, apiKey: 'replacement-secret' }),
    (source) => ({ ...source, kind: 'openai-compatible' }),
    (source) => ({ ...source, createdAt: source.createdAt + 1 }),
  ];
  for (const replace of replacements) {
    const original = configured();
    let current: InferenceSource | null = original;
    const deferred = deferredProbe();
    let writes = 0;
    const pending = refreshSource(original, true, {
      current: () => current,
      probe: () => deferred.promise,
      save: (source) => { writes += 1; current = source; return source; },
    });
    const replacement = replace(original);
    current = replacement;
    deferred.complete(observation(2048));
    const result = await pending;
    assert.equal(result.saved, null);
    assert.equal(result.probe.ok, false);
    assert.deepEqual(result.probe.models, []);
    assert.match(result.probe.error ?? '', /source changed|newer refresh/);
    assert.equal(writes, 0);
    assert.equal(current, replacement);
  }
});

test('a stale source snapshot is refused before contacting its old endpoint', async () => {
  const original = configured();
  const result = await refreshSource(original, true, {
    current: () => ({ ...original, baseUrl: 'https://replacement.example/v1' }),
    probe: async () => { assert.fail('a stale endpoint must not be probed'); },
    save: () => { assert.fail('a stale source must not be saved'); },
  });
  assert.equal(result.probe.ok, false);
  assert.equal(result.saved, null);
});

test('the newest refresh wins even when an older larger cap arrives last', async () => {
  let current = configured();
  const oldProbe = deferredProbe();
  const newProbe = deferredProbe();
  const written: InferenceSource[] = [];
  let probes = 0;
  const deps = {
    current: () => current,
    probe: () => (++probes === 1 ? oldProbe.promise : newProbe.promise),
    save: (source: InferenceSource) => { current = source; written.push(source); return source; },
  };
  const oldPending = refreshSource(current, true, deps);
  const newPending = refreshSource(current, true, deps);
  newProbe.complete(observation(512));
  assert.equal((await newPending).saved?.models[0].maxEvaluatedTokens, 512);
  oldProbe.complete(observation(2048));
  assert.equal((await oldPending).saved, null);
  assert.equal(written.length, 1);
  assert.equal(current.models[0].maxEvaluatedTokens, 512);
});

test('a failed newer refresh still retires an older observation', async () => {
  let current = configured();
  current.models[0].maxEvaluatedTokens = 512;
  const oldProbe = deferredProbe();
  const newProbe = deferredProbe();
  let probes = 0;
  let writes = 0;
  const deps = {
    current: () => current,
    probe: () => (++probes === 1 ? oldProbe.promise : newProbe.promise),
    save: (source: InferenceSource) => { writes += 1; current = source; return source; },
  };
  const oldPending = refreshSource(current, true, deps);
  const newPending = refreshSource(current, true, deps);
  newProbe.complete({ ok: false, latencyMs: 1, models: [], error: 'malformed execution limit' });
  assert.equal((await newPending).saved, null);
  oldProbe.complete(observation(2048));
  assert.equal((await oldPending).saved, null);
  assert.equal(writes, 0);
  assert.equal(current.models[0].maxEvaluatedTokens, 512);
});

test('refresh merges current Library edits while updating observed execution capacity', async () => {
  const original = configured();
  let current = original;
  const deferred = deferredProbe();
  const pending = refreshSource(original, true, {
    current: () => current,
    probe: () => deferred.promise,
    save: (source) => (current = source),
  });
  current = {
    ...original, name: 'Renamed source',
    models: [
      { ...original.models[0], name: 'My renamed model', nameCurated: true, contextWindow: 8192 },
      { id: 'declared-during-refresh', name: 'New declaration', manuallyDeclared: true },
    ],
  };
  deferred.complete(observation(2048));
  const result = await pending;
  assert.equal(result.saved, current);
  assert.equal(current.name, 'Renamed source');
  assert.equal(current.models[0].name, 'My renamed model');
  assert.equal(current.models[0].contextWindow, 8192);
  assert.equal(current.models[0].maxEvaluatedTokens, 2048);
  assert.equal(current.models[1].id, 'declared-during-refresh');
  assert.equal(original.models[0].maxEvaluatedTokens, undefined);
});

test('read-only probes and other sources do not supersede an active refresh', async () => {
  let current = configured();
  const other = { ...configured(), id: 'other-source', baseUrl: 'https://other.example/v1' };
  const deferred = deferredProbe();
  let writes = 0;
  const pending = refreshSource(current, true, {
    current: () => current,
    probe: () => deferred.promise,
    save: (source) => { writes += 1; current = source; return source; },
  });
  await refreshSource(current, false, {
    current: () => current,
    probe: async () => observation(128),
    save: () => { assert.fail('read-only probe cannot persist'); },
  });
  await refreshSource(other, true, {
    current: () => other,
    probe: async () => observation(64),
    save: (source) => source,
  });
  deferred.complete(observation(2048));
  assert.equal((await pending).saved?.models[0].maxEvaluatedTokens, 2048);
  assert.equal(writes, 1);
});

test('implicit and explicit default protocols have the same connection identity', async () => {
  const original = configured();
  const current = { ...original, protocol: 'openai-chat' as const };
  const result = await refreshSource(original, true, {
    current: () => current,
    probe: async () => observation(2048),
    save: (source) => source,
  });
  assert.equal(result.probe.ok, true);
  assert.equal(result.saved?.protocol, 'openai-chat');
  assert.equal(result.saved?.models[0].maxEvaluatedTokens, 2048);
});
