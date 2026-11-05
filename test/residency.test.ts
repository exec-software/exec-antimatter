import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { readResidency, reportsResidency, unloadModel } from '../src/main/residency';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadedModels } from '../renderer/src/components/hub/LoadedModels';
import { unloadUnavailableReason, type Residency } from '../renderer/src/lib/useResidency';
import type { SourceResidency } from '../renderer/src/types';

interface Seen {
  method: string;
  url: string;
  auth?: string;
  body?: string;
}

/** A stand-in engine, so the client contract is exercised rather than described. */
async function engine(route: (url: string) => { status: number; body: unknown } | null) {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        ...(request.headers.authorization ? { auth: request.headers.authorization } : {}),
        ...(body ? { body } : {}),
      });
      const answer = route(request.url ?? '') ?? { status: 404, body: {} };
      response.writeHead(answer.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    seen,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const BEHOLDD_MODELS = {
  object: 'list',
  data: [
    { id: 'idle-model', residency: 'absent', loaded: false },
    {
      id: 'qwen3-coder-next-80b',
      residency: 'dead',
      residency_detail: 'connection refused — the worker is gone',
      loaded: false,
    },
    { id: 'qwen3-coder-30b', residency: 'live', loaded: true, host_rss_bytes: 399_306_752 },
  ],
  memory: { vram_used_bytes: 121_302_827_008 },
};

const NATIVE_INFO = {
  schema_version: 1,
  service: 'beholdd',
  generation: 2,
  runtime: 'native',
  execution_backends: ['cpu'],
  architectures: ['qwen3', 'qwen3moe'],
  model_formats: ['gguf'],
  operations: { unload: true },
};

test('beholdd residency keeps a dead worker visible and leaves idle models out', async () => {
  const host = await engine((url) => (url === '/v1/models' ? { status: 200, body: BEHOLDD_MODELS } : null));
  try {
    const report = await readResidency({ id: 'gpu', baseUrl: `${host.origin}/v1`, kind: 'beholdd' });

    assert.equal(report.supported, true);
    assert.equal(report.canUnload, true);
    assert.equal(report.unloadRequiresIdle, undefined);
    assert.equal(report.error, undefined);
    assert.equal(report.vramBytes, 121_302_827_008);
    assert.deepEqual(
      report.models.map((model) => [model.id, model.state]),
      [
        ['qwen3-coder-next-80b', 'dead'],
        ['qwen3-coder-30b', 'live'],
      ],
      'a worker that stopped answering still holds its slot, so it must be offered for clearing'
    );
    assert.match(report.models[0].detail ?? '', /connection refused/);
    assert.equal(report.models[1].hostBytes, 399_306_752);
  } finally {
    await host.close();
  }
});

test('an older beholdd that reports only the boolean is still understood', async () => {
  const host = await engine((url) =>
    url === '/v1/models'
      ? { status: 200, body: { data: [{ id: 'a', loaded: true }, { id: 'b', loaded: false }] } }
      : null
  );
  try {
    const report = await readResidency({ id: 'gpu', baseUrl: `${host.origin}/v1`, kind: 'beholdd' });
    assert.deepEqual(report.models.map((model) => [model.id, model.state]), [['a', 'live']]);
    assert.equal(report.vramBytes, undefined);
    assert.equal(report.canUnload, false);
    assert.match(report.unloadUnavailableReason ?? '', /does not advertise model unloading/);
    await assert.rejects(
      () => unloadModel({ id: 'native-old', baseUrl: `${host.origin}/v1`, kind: 'beholdd' }, 'a'),
      /does not advertise model unloading/
    );
    assert.equal(host.seen.some((entry) => entry.method === 'POST'), false);
  } finally {
    await host.close();
  }
});

test('ollama is asked at its own root, beside the OpenAI compatibility layer', async () => {
  const host = await engine((url) =>
    url === '/api/ps'
      ? {
          status: 200,
          body: { models: [{ model: 'llama3:8b', size: 5_000_000_000, size_vram: 4_800_000_000 }] },
        }
      : null
  );
  try {
    const report = await readResidency({ id: 'ollama', baseUrl: `${host.origin}/v1`, kind: 'ollama' });

    assert.deepEqual(host.seen.map((entry) => `${entry.method} ${entry.url}`), ['GET /api/ps']);
    assert.deepEqual(report.models, [{ id: 'llama3:8b', state: 'live', hostBytes: 5_000_000_000 }]);
    assert.equal(report.vramBytes, 4_800_000_000);
    assert.equal(report.canUnload, true);
    assert.equal(report.unloadRequiresIdle, undefined);
  } finally {
    await host.close();
  }
});

test('a source with no resident models to free is not asked at all', async () => {
  assert.equal(reportsResidency('openai'), false);
  assert.equal(reportsResidency('llama-cpp'), false);
  assert.equal(reportsResidency(undefined), false);
  assert.equal(reportsResidency('beholdd'), true);
  assert.equal(reportsResidency('ollama'), true);

  const report = await readResidency({ id: 'openai', baseUrl: 'http://127.0.0.1:1/v1', kind: 'openai' });
  assert.deepEqual(report, { sourceId: 'openai', supported: false, canUnload: false, models: [] });

  await assert.rejects(
    () => unloadModel({ id: 'openai', baseUrl: 'http://127.0.0.1:1/v1', kind: 'openai' }, 'gpt-5'),
    /does not keep models loaded/
  );
});

test('unloading names the model safely on each connector', async () => {
  const host = await engine((url) => ({ status: 200, body: url === '/v1/beholdd/info' ? NATIVE_INFO : { ok: true } }));
  try {
    await unloadModel({ id: 'gpu', baseUrl: `${host.origin}/v1`, apiKey: 'sk-live', kind: 'beholdd' }, 'vendor/model a');
    await unloadModel({ id: 'ollama', baseUrl: `${host.origin}/v1`, kind: 'ollama' }, 'llama3:8b');

    assert.deepEqual(host.seen, [
      {
        method: 'GET',
        url: '/v1/beholdd/info',
        auth: 'Bearer sk-live',
      },
      {
        method: 'POST',
        // A slash in a model id must name one model, not a path below the collection.
        url: '/v1/models/vendor%2Fmodel%20a/unload',
        auth: 'Bearer sk-live',
      },
      {
        method: 'POST',
        // Ollama has no unload verb; a zero-length lease is how it frees one, and no prompt
        // is sent, so nothing is generated in the process.
        url: '/api/generate',
        body: JSON.stringify({ model: 'llama3:8b', keep_alive: 0 }),
      },
    ]);
  } finally {
    await host.close();
  }
});

test('a refusal is reported in the server words, with the credential taken out', async () => {
  const host = await engine((url) => url === '/v1/beholdd/info'
    ? { status: 200, body: NATIVE_INFO }
    : { status: 500, body: { error: 'failed to unload: sk-live is stale' } });
  try {
    await assert.rejects(
      () => unloadModel({ id: 'gpu', baseUrl: `${host.origin}/v1`, apiKey: 'sk-live', kind: 'beholdd' }, 'x'),
      (error: Error) => {
        assert.match(error.message, /500/);
        assert.match(error.message, /failed to unload/);
        assert.equal(error.message.includes('sk-live'), false, 'an error must never carry the key back to the UI');
        return true;
      }
    );
  } finally {
    await host.close();
  }
});

test('a source that cannot be reached says so instead of reporting an empty card', async () => {
  const host = await engine(() => ({ status: 200, body: {} }));
  const origin = host.origin;
  await host.close();

  const report = await readResidency({ id: 'gpu', baseUrl: `${origin}/v1`, kind: 'beholdd' });
  assert.equal(report.supported, true);
  assert.deepEqual(report.models, []);
  assert.ok(report.error, 'silence and "nothing loaded" must not look the same');
});

test('native unload capability is explicit and refreshed at mutation time', async () => {
  let canUnload = true;
  const host = await engine((url) => {
    if (url === '/v1/beholdd/info') {
      return { status: 200, body: { ...NATIVE_INFO, operations: { unload: canUnload } } };
    }
    if (url === '/v1/models') {
      return { status: 200, body: { data: [{ id: 'a', loaded: true }] } };
    }
    return { status: 200, body: { ok: true } };
  });
  try {
    const source = { id: 'native', baseUrl: `${host.origin}/v1`, kind: 'beholdd' as const };
    const report = await readResidency(source);
    assert.equal(report.canUnload, true);
    assert.equal(report.unloadRequiresIdle, true);
    assert.deepEqual(report.models.map((model) => model.id), ['a']);
    canUnload = false;
    await assert.rejects(() => unloadModel(source, 'a'), /does not support model unloading/);
    assert.equal(host.seen.some((entry) => entry.method === 'POST'), false);
  } finally {
    await host.close();
  }
});

test('explicit native refusal wins over legacy-looking model fields', async () => {
  const host = await engine((url) => ({ status: 200, body: url === '/v1/beholdd/info'
    ? { ...NATIVE_INFO, operations: { unload: false } }
    : BEHOLDD_MODELS }));
  try {
    const source = { id: 'native', baseUrl: `${host.origin}/v1`, kind: 'beholdd' as const };
    const report = await readResidency(source);
    assert.equal(report.canUnload, false);
    assert.equal(report.models.length, 2);
    await assert.rejects(() => unloadModel(source, 'qwen3-coder-30b'), /does not support model unloading/);
    assert.equal(host.seen.some((entry) => entry.method === 'POST'), false);
  } finally {
    await host.close();
  }
});

test('an explicitly unknown runtime cannot authorize unloading through legacy-looking model fields', async () => {
  const unknownInfo = {
    ...NATIVE_INFO,
    runtime: 'unknown',
    execution_backends: [],
    architectures: [],
    model_formats: [],
    operations: { unload: false },
  };
  const host = await engine((url) => ({
    status: 200,
    body: url === '/v1/beholdd/info' ? unknownInfo : BEHOLDD_MODELS,
  }));
  try {
    const source = { id: 'unknown', baseUrl: `${host.origin}/v1`, kind: 'beholdd' as const };
    const report = await readResidency(source);
    assert.equal(report.models.length, 2);
    assert.equal(report.canUnload, false);
    assert.match(report.unloadUnavailableReason ?? '', /has not declared a native runtime or model-unload support/);
    await assert.rejects(
      () => unloadModel(source, 'qwen3-coder-30b'),
      /has not declared a native runtime or model-unload support/
    );
    assert.equal(host.seen.some((entry) => entry.method === 'POST'), false);
  } finally {
    await host.close();
  }
});

test('legacy worker residency markers retain the unload contract without a native descriptor', async () => {
  const host = await engine((url) => {
    if (url === '/v1/beholdd/info') return null;
    return { status: 200, body: url === '/v1/models' ? BEHOLDD_MODELS : { ok: true } };
  });
  try {
    await unloadModel({ id: 'legacy', baseUrl: `${host.origin}/v1`, kind: 'beholdd' }, 'qwen3-coder-next-80b');
    assert.deepEqual(host.seen.map((entry) => `${entry.method} ${entry.url}`), [
      'GET /v1/beholdd/info',
      'GET /v1/models',
      'POST /v1/models/qwen3-coder-next-80b/unload',
    ]);
  } finally {
    await host.close();
  }
});

for (const descriptor of [
  { status: 200, body: { ...NATIVE_INFO, schema_version: 999 } },
  { status: 401, body: { error: 'sk-sensitive is invalid' } },
  { status: 500, body: { error: 'sk-sensitive is unavailable' } },
]) {
  test(`unverified descriptor ${descriptor.status} preserves residency but never falls through to legacy unload`, async () => {
    const host = await engine((url) => url === '/v1/beholdd/info'
      ? descriptor
      : { status: 200, body: BEHOLDD_MODELS });
    try {
      const source = { id: 'native', baseUrl: `${host.origin}/v1`, apiKey: 'sk-sensitive', kind: 'beholdd' as const };
      const report = await readResidency(source);
      assert.equal(report.error, undefined);
      assert.equal(report.models.length, 2);
      assert.equal(report.canUnload, false);
      assert.match(report.unloadUnavailableReason ?? '', /Could not verify model unloading/);
      assert.equal(report.unloadUnavailableReason?.includes('sk-sensitive'), false);
      await assert.rejects(() => unloadModel(source, 'qwen3-coder-30b'), (error: Error) => {
        assert.match(error.message, /Could not verify model unloading/);
        assert.equal(error.message.includes('sk-sensitive'), false);
        return true;
      });
      assert.equal(host.seen.some((entry) => entry.method === 'POST'), false);
    } finally {
      await host.close();
    }
  });
}

test('native busy response is surfaced without retrying or deferring the unload', async () => {
  const host = await engine((url) => url === '/v1/beholdd/info'
    ? { status: 200, body: NATIVE_INFO }
    : { status: 409, body: { error: { code: 'model_busy', message: 'Generation is active; retry after it finishes.' } } });
  try {
    await assert.rejects(
      () => unloadModel({ id: 'native', baseUrl: `${host.origin}/v1`, kind: 'beholdd' }, 'a'),
      /409.*model_busy.*Generation is active/
    );
    assert.equal(host.seen.filter((entry) => entry.method === 'POST').length, 1);
  } finally {
    await host.close();
  }
});

test('native busy UI is read-only while legacy and Ollama worker recovery remains available', () => {
  const source: SourceResidency = {
    sourceId: 'native', supported: true, canUnload: true, unloadRequiresIdle: true,
    models: [{ id: 'a', state: 'live', turns: 1 }],
  };
  assert.match(unloadUnavailableReason(source) ?? '', /Wait for active turns/);
  assert.equal(unloadUnavailableReason({ ...source, unloadRequiresIdle: undefined }), undefined);
  assert.equal(unloadUnavailableReason({ ...source, models: [{ id: 'a', state: 'live' }] }), undefined);
  assert.match(unloadUnavailableReason(undefined) ?? '', /not confirmed support/);

  const residency: Residency = {
    sources: [source], loading: false,
    resident: source.models.map((model) => ({ ...model, sourceId: source.sourceId })),
    refresh() {}, find: () => source.models[0],
  };
  const nativeHtml = renderToStaticMarkup(createElement(LoadedModels, {
    providers: [], residency, busy: null, error: '', onUnload() {},
  }));
  assert.match(nativeHtml, /disabled="" title="Wait for active turns/);
  assert.match(nativeHtml, /1 turn on it/);
  assert.match(nativeHtml, /Loaded/);

  const legacyHtml = renderToStaticMarkup(createElement(LoadedModels, {
    providers: [], residency: { ...residency, sources: [{ ...source, unloadRequiresIdle: undefined }] },
    busy: null, error: '', onUnload() {},
  }));
  assert.doesNotMatch(legacyHtml, /disabled=""/);
  assert.match(legacyHtml, /1 turn on it/);

  const unavailable = { ...source, canUnload: false, unloadUnavailableReason: 'Upgrade this native runtime.' };
  const oldHtml = renderToStaticMarkup(createElement(LoadedModels, {
    providers: [], residency: { ...residency, sources: [unavailable] }, busy: null, error: '', onUnload() {},
  }));
  assert.match(oldHtml, /disabled="" title="Upgrade this native runtime\./);
  assert.match(oldHtml, /native: Upgrade this native runtime\./);
  assert.match(oldHtml, /Loaded/);
});

test('a model answering a turn is known while the turn runs, and idle again after it', async () => {
  const modelUse = await import('../src/main/modelUse');
  modelUse.reset();

  const first = modelUse.hold('gpu', 'qwen3-coder-30b');
  const second = modelUse.hold('gpu', 'qwen3-coder-30b');
  modelUse.hold('gpu', 'other');

  // A conversation and the agents it started are separate turns on the same weights.
  assert.equal(modelUse.turnsOn('gpu', 'qwen3-coder-30b'), 2);
  assert.deepEqual(
    modelUse.inUse().map((entry) => [entry.modelId, entry.turns]).sort(),
    [['other', 1], ['qwen3-coder-30b', 2]]
  );

  first();
  first();
  assert.equal(modelUse.turnsOn('gpu', 'qwen3-coder-30b'), 1, 'releasing twice must not free a hold it does not own');
  second();
  assert.equal(modelUse.turnsOn('gpu', 'qwen3-coder-30b'), 0);
  assert.equal(modelUse.inUse().some((entry) => entry.modelId === 'qwen3-coder-30b'), false);
});
