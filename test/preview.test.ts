import assert from 'node:assert/strict';
import test from 'node:test';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import type { ProviderConfig } from '../src/api/types';
import { decide, machineWide, machineWideAdvice, tierOf } from '../src/main/toolPolicy';
import { boundedEncodedImageDimensions } from '../src/main/preview/imageDimensions';
import { hideWindowWithPreviewCleanup } from '../src/main/preview/lifecycle';
import { isCurrentNavigationFailure, navigateHistory } from '../src/main/preview/navigation';
import {
  bindPreviewClientCertificateDenial,
  nextPreviewPartition,
  preventPageWindowMutation,
  retirePreviewSession,
} from '../src/main/preview/session';
import {
  boundedPreviewRectangle,
  captureSourceTypes,
  mediaTypeOf,
  namedCaptureMatches,
  previewableUrl,
  uniqueNamedCaptureSource,
} from '../src/main/preview/targets';
import {
  answerOf,
  isLoopbackVisionEndpoint,
  isVisionEndpoint,
  look,
  lookBody,
  MAX_VISION_ERROR_BYTES,
  MAX_VISION_RESPONSE_BYTES,
  publicVisionDestination,
  VISION_BRIEF,
} from '../src/main/preview/vision';
import { boundPreviewImage, writeWorkspaceBinary } from '../src/main/preview/workspace';
import { forget as forgetEyes, resolve as resolveEyes } from '../src/main/preview/eyes';
import { mergeProbedModels, persistedModel, probeSource } from '../src/main/probe';

async function withFetch<T>(implementation: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('a look is a content array with the picture in it, which is the whole integration', () => {
  const body = lookBody({
    baseUrl: 'http://127.0.0.1:18081/v1',
    apiKey: '',
    model: 'qwen3.6-35b-a3b',
    image: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    mediaType: 'image/png',
    question: 'Is the toolbar overlapping the canvas?',
  });

  assert.equal(body.model, 'qwen3.6-35b-a3b');
  assert.equal(body.stream, false);
  const messages = body.messages as { role: string; content: unknown }[];
  assert.equal(messages[0].content, VISION_BRIEF);

  const parts = messages[1].content as { type: string; text?: string; image_url?: { url: string } }[];
  assert.equal(parts[0].text, 'Is the toolbar overlapping the canvas?');
  assert.equal(parts[1].image_url?.url, `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`);
});

test('no question still asks something, because an empty user turn asks nothing', () => {
  const body = lookBody({
    baseUrl: 'http://localhost/v1',
    apiKey: '',
    model: 'sees',
    image: Buffer.alloc(1),
    mediaType: 'image/png',
    question: '   ',
  });
  const parts = (body.messages as { content: { text?: string }[] }[])[1].content;
  assert.equal(parts[0].text, 'Describe this image.');
});

test('an answer is read from either place a compatible server puts it', () => {
  assert.equal(answerOf({ choices: [{ message: { content: '  A toolbar, clipped.  ' } }] }), 'A toolbar, clipped.');
  // A server answering a content-array request with a content array.
  assert.equal(
    answerOf({ choices: [{ message: { content: [{ type: 'text', text: 'Two ' }, { type: 'text', text: 'windows.' }] } }] }),
    'Two windows.'
  );
  assert.equal(answerOf({ choices: [{ text: 'legacy completion' }] }), 'legacy completion');
  // A reasoning model that thinks past its budget leaves `content` empty. It still looked.
  assert.equal(
    answerOf({
      choices: [{ message: { content: '', reasoning_content: '  Top: red. Middle: green.  ' } }],
    }),
    'Top: red. Middle: green.'
  );
  // When it managed a real answer, that is the answer; the thinking is not appended to it.
  assert.equal(
    answerOf({ choices: [{ message: { content: 'Red, green, blue.', reasoning_content: 'Let me look…' } }] }),
    'Red, green, blue.'
  );
  assert.equal(answerOf({ choices: [{ message: { content: '   ', reasoning_content: '' } }] }), '');
  assert.equal(answerOf({ choices: [] }), '');
  assert.equal(answerOf(null), '');
});

test('model-list vision and context evidence survive after transient probe state is removed', async () => {
  const result = await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'eyes', loaded: true, n_ctx: '32768', capabilities: ['completion', 'VISION'] },
            { id: 'text', loaded: false, ctx_size: 8192, capabilities: ['completion'] },
            { id: 'unknown' },
          ],
        }),
        { headers: { 'content-type': 'application/json' } }
      ),
    () => probeSource('http://models.test/v1')
  );

  assert.equal(result.ok, true);
  assert.equal(result.models[0].vision, true);
  assert.equal(result.models[0].contextWindow, 32768);
  assert.equal(result.models[1].vision, false);
  assert.equal(result.models[1].contextWindow, 8192);
  assert.equal(result.models[2].vision, undefined);
  assert.deepEqual(persistedModel(result.models[0]), {
    id: 'eyes',
    name: 'eyes',
    contextWindow: 32768,
    vision: true,
  });
  assert.deepEqual(persistedModel(result.models[1]), {
    id: 'text',
    name: 'text',
    contextWindow: 8192,
    vision: false,
  });
  assert.equal('loaded' in persistedModel(result.models[0]), false);
});

test('startup adoption refreshes known metadata without deleting curated models or transient facts', () => {
  // `curated` carries a Library edit, which is what makes it survive an observation that omits it;
  // an id that was only ever adopted from a listing is dropped instead (see catalog-pruning.test.ts).
  const configured: ProviderConfig['models'] = [
    { id: 'known', name: 'Known', contextWindow: 4096, vision: true },
    { id: 'silent', name: 'Silent', contextWindow: 16384, vision: false },
    { id: 'curated', name: 'Keep me', contextWindow: 2048, contextWindowCurated: true },
  ];
  const merged = mergeProbedModels(configured, [
    { id: 'known', name: 'known', loaded: true, contextWindow: 32768, vision: false },
    { id: 'silent', name: 'silent' },
    { id: 'new', name: 'new', loaded: false, contextWindow: 8192, vision: true },
  ]);

  assert.deepEqual(merged, [
    { id: 'known', name: 'Known', contextWindow: 32768, vision: false },
    { id: 'silent', name: 'Silent', contextWindow: 16384, vision: false },
    { id: 'curated', name: 'Keep me', contextWindow: 2048, contextWindowCurated: true },
    { id: 'new', name: 'new', contextWindow: 8192, vision: true },
  ]);
  assert.equal('loaded' in merged[0], false);
  assert.deepEqual(configured, [
    { id: 'known', name: 'Known', contextWindow: 4096, vision: true },
    { id: 'silent', name: 'Silent', contextWindow: 16384, vision: false },
    { id: 'curated', name: 'Keep me', contextWindow: 2048, contextWindowCurated: true },
  ]);

  // `silent` was adopted from a listing and carries no edit, so a probe that omits it drops it.
  const narrowed = mergeProbedModels(configured, [{ id: 'known', name: 'Known', contextWindow: 4096, vision: true }]);
  assert.deepEqual(
    narrowed.map((model) => model.id),
    ['known', 'curated']
  );

  const unchanged = mergeProbedModels(configured, [
    { id: 'known', name: 'Known', contextWindow: 4096, vision: true },
    { id: 'silent', name: 'Silent', contextWindow: 16384, vision: false },
  ]);
  assert.equal(unchanged, configured, 'an unchanged launch probe does not rewrite the source store');
});

test('per-model capabilities win and llama props remains an unknown-only compatibility fallback', async () => {
  const source = (
    models: ProviderConfig['models'],
    baseUrl = 'http://127.0.0.1:18081/v1',
    apiKey = '',
    protocol?: ProviderConfig['protocol']
  ): ProviderConfig => ({
    id: 'source',
    name: 'source',
    apiKey,
    baseUrl,
    models,
    supportsStreaming: true,
    ...(protocol ? { protocol } : {}),
  });
  const requested: string[] = [];

  await withFetch(
    async (input) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ modalities: { vision: true } }), {
        headers: { 'content-type': 'application/json' },
      });
    },
    async () => {
      forgetEyes();
      assert.deepEqual(
        await resolveEyes([
          source([
            { id: 'text', name: 'text', vision: false },
            { id: 'eyes', name: 'eyes', vision: true },
          ]),
        ]),
        { provider: 'source', baseUrl: 'http://127.0.0.1:18081/v1', apiKey: '', model: 'eyes' }
      );
      assert.deepEqual(requested, [], 'a positive model capability needs no llama-specific probe');

      forgetEyes();
      assert.equal(
        await resolveEyes([
          source(
            [{ id: 'native-eyes', name: 'native-eyes', vision: true }],
            'https://api.openai.com/v1',
            'openai-key',
            'openai-responses'
          ),
          source(
            [{ id: 'claude-eyes', name: 'claude-eyes' }],
            'https://api.anthropic.com/v1',
            'anthropic-key',
            'anthropic-messages'
          ),
        ]),
        null,
        'native protocols are excluded until preview has their image and authentication schemas'
      );
      assert.deepEqual(requested, [], 'native sources must not fall through to the Chat /props probe');

      forgetEyes();
      assert.equal(await resolveEyes([source([{ id: 'text', name: 'text', vision: false }])]), null);
      assert.deepEqual(requested, [], 'an explicit text-only capability must not be overridden by /props');

      forgetEyes();
      assert.deepEqual(await resolveEyes([source([{ id: 'legacy', name: 'legacy' }])]), {
        provider: 'source',
        baseUrl: 'http://127.0.0.1:18081/v1',
        apiKey: '',
        model: 'legacy',
      });
      assert.deepEqual(requested, ['http://127.0.0.1:18081/props']);

      forgetEyes();
      assert.equal(
        await resolveEyes([
          source([
            { id: 'legacy-a', name: 'legacy-a' },
            { id: 'legacy-b', name: 'legacy-b' },
          ]),
        ]),
        null
      );
      assert.deepEqual(
        requested,
        ['http://127.0.0.1:18081/props'],
        'legacy /props cannot identify which entry in a multi-model registry is loaded'
      );

      forgetEyes();
      assert.deepEqual(
        await resolveEyes([
          source([{ id: 'local-text', name: 'local-text', vision: false }], 'http://localhost:18081/v1'),
          source([{ id: 'remote-eyes', name: 'remote-eyes', vision: true }], 'https://vision.example/v1'),
        ]),
        { provider: 'source', baseUrl: 'https://vision.example/v1', apiKey: '', model: 'remote-eyes' },
        'a configured remote source remains the fallback when no local source can see'
      );
      assert.deepEqual(requested, ['http://127.0.0.1:18081/props'], 'an advertised capability needs no probe');

      forgetEyes();
      assert.deepEqual(
        await resolveEyes([
          source([{ id: 'remote-eyes', name: 'remote-eyes', vision: true }], 'https://vision.example/v1'),
          source([{ id: 'local-eyes', name: 'local-eyes', vision: true }], 'http://[::1]:18081/v1', 'local-key'),
        ]),
        { provider: 'source', baseUrl: 'http://[::1]:18081/v1', apiKey: 'local-key', model: 'local-eyes' },
        'loopback is preferred even when the remote source was configured first'
      );

      forgetEyes();
      assert.equal(
        await resolveEyes([
          source([{ id: 'credential-eyes', name: 'credential-eyes', vision: true }], 'http://user:pass@localhost/v1'),
        ]),
        null,
        'URL credentials make an otherwise loopback endpoint ineligible'
      );
    }
  );
});

test('vision endpoints are HTTP only, loopback is identified, and transport never follows a redirect', async () => {
  assert.equal(isVisionEndpoint('http://192.0.2.220:18081/v1'), true);
  assert.equal(isVisionEndpoint('https://vision.example/v1'), true);
  assert.equal(isVisionEndpoint('http://user:pass@localhost/v1'), false);
  assert.equal(isVisionEndpoint('file://localhost/tmp/model'), false);
  assert.equal(isLoopbackVisionEndpoint('http://localhost:18081/v1'), true);
  assert.equal(isLoopbackVisionEndpoint('https://127.255.4.3/v1'), true);
  assert.equal(isLoopbackVisionEndpoint('http://[::1]:18081/v1'), true);
  assert.equal(isLoopbackVisionEndpoint('http://user:pass@localhost/v1'), false);
  assert.equal(isLoopbackVisionEndpoint('http://localhost.example/v1'), false);
  assert.equal(isLoopbackVisionEndpoint('http://192.0.2.220:18081/v1'), false);
  assert.equal(isLoopbackVisionEndpoint('file://localhost/tmp/model'), false);

  let fetched = false;
  await withFetch(
    async () => {
      fetched = true;
      return new Response('{}');
    },
    async () => {
      await assert.rejects(
        look({
          baseUrl: 'https://url-user:url-pass@vision.example/v1',
          apiKey: '',
          model: 'eyes',
          image: Buffer.alloc(1),
          mediaType: 'image/png',
          question: 'What is this?',
        }),
        /URL credentials.*No image was sent/
      );
    }
  );
  assert.equal(fetched, false, 'credential-bearing URLs are rejected before fetch can send pixels');

  const answer = await withFetch(
    async (input, init) => {
      assert.equal(String(input), 'https://vision.example/v1/chat/completions');
      assert.equal(init?.redirect, 'error', 'a vision server cannot redirect workspace pixels');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Approved answer.' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    },
    () =>
      look({
        baseUrl: 'https://vision.example/v1#not-sent',
        apiKey: '',
        model: 'eyes',
        image: Buffer.alloc(1),
        mediaType: 'image/png',
        question: 'What is this?',
      })
  );
  assert.equal(answer, 'Approved answer.');
});

test('vision response streams are capped before text or JSON can exhaust the main process', async () => {
  const request = () =>
    look({
      baseUrl: 'https://vision.example/v1',
      apiKey: '',
      model: 'eyes',
      image: Buffer.alloc(1),
      mediaType: 'image/png',
      question: 'What is this?',
      timeoutMs: 1_000,
    });
  const chunked = (bytes: number, status = 200) => {
    let remaining = bytes;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (remaining <= 0) {
            controller.close();
            return;
          }
          const size = Math.min(32 * 1024, remaining);
          remaining -= size;
          controller.enqueue(new Uint8Array(size));
        },
      }),
      { status }
    );
  };

  await withFetch(
    async () => chunked(MAX_VISION_RESPONSE_BYTES + 1),
    async () => assert.rejects(request(), /answer exceeded the 2048 KiB response limit/)
  );
  await withFetch(
    async () => chunked(MAX_VISION_ERROR_BYTES + 1, 500),
    async () => assert.rejects(request(), /error body exceeded the 64 KiB response limit/)
  );
});

test('vision approval destinations contain identity, never endpoint or provider credentials', () => {
  const destination = publicVisionDestination({
    provider: 'fixture-host-c',
    model: 'qwen-vision',
    baseUrl: 'https://url-user:url-pass@vision.example:8443/v1/?token=query-secret#fragment',
    apiKey: 'provider-api-secret',
  });
  assert.deepEqual(destination, {
    provider: 'fixture-host-c',
    model: 'qwen-vision',
    baseUrl: 'https://vision.example:8443/v1',
  });
  const shown = JSON.stringify(destination);
  assert.doesNotMatch(shown, /url-user|url-pass|query-secret|provider-api-secret/);
});

test('what an image is comes from its bytes, not from what it was named', () => {
  assert.equal(mediaTypeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])), 'image/png');
  assert.equal(mediaTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(mediaTypeOf(Buffer.from('GIF89a')), null);
  assert.equal(mediaTypeOf(Buffer.from('BM' + 'x'.repeat(10))), null);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.equal(mediaTypeOf(webp), null);
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);
  assert.equal(mediaTypeOf(wav), null);

  assert.equal(mediaTypeOf(Buffer.from('import tkinter\n')), null);
});

const pngHeader = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(0, 33);
  bytes.write('IEND', 37, 'latin1');
  return bytes;
};

test('encoded dimensions are bounded before a native decoder sees the image', () => {
  assert.deepEqual(boundedEncodedImageDimensions(pngHeader(3840, 2160), 'image/png'), {
    width: 3840,
    height: 2160,
  });
  assert.throws(
    () => boundedEncodedImageDimensions(pngHeader(10_000, 5_000), 'image/png'),
    /beyond the safe preview limit/
  );
  assert.throws(
    () => boundedEncodedImageDimensions(pngHeader(20_000, 1), 'image/png'),
    /beyond the safe preview limit/
  );

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x04, 0x38, 0x07, 0x80]);
  assert.deepEqual(boundedEncodedImageDimensions(jpeg, 'image/jpeg'), { width: 1920, height: 1080 });
  assert.throws(
    () => boundedEncodedImageDimensions(Buffer.from('GIF89a'), 'image/gif'),
    /supports PNG and JPEG/
  );
});

test('named captures use only windows and require one unambiguous title match', () => {
  assert.deepEqual(captureSourceTypes(), ['screen']);
  assert.deepEqual(captureSourceTypes('   '), ['screen']);
  assert.deepEqual(captureSourceTypes('Screen 1'), ['window']);

  const sources = [{ name: 'Editor' }, { name: 'Editor — notes.md' }, { name: 'Terminal' }];
  assert.deepEqual(namedCaptureMatches(sources, 'terminal'), [sources[2]]);
  assert.deepEqual(namedCaptureMatches(sources, 'editor'), [sources[0], sources[1]]);
  assert.deepEqual(namedCaptureMatches(sources, 'missing'), []);
  assert.equal(uniqueNamedCaptureSource(sources, 'terminal'), sources[2]);
  assert.throws(
    () => uniqueNamedCaptureSource(sources, 'editor'),
    (error: unknown) => (error as Error).message === 'More than one window matches "editor". Use a more specific title and try again.'
  );
  assert.throws(
    () => uniqueNamedCaptureSource(sources, 'missing'),
    (error: unknown) => (error as Error).message === 'No window matching "missing" is open. Check its title and try again.'
  );
});

test('an image preview is bound to its recorded workspace, never a same-named current file', () => {
  const first = mkdtempSync(join(tmpdir(), 'antimatter-preview-first-'));
  const second = mkdtempSync(join(tmpdir(), 'antimatter-preview-second-'));
  try {
    writeFileSync(join(first, 'shot.png'), 'first');
    writeFileSync(join(second, 'shot.png'), 'second');
    assert.deepEqual(boundPreviewImage(first, { path: 'shot.png', workspace: realpathSync(first) }), {
      workspace: realpathSync(first),
      target: join(first, 'shot.png'),
    });
    assert.throws(
      () => boundPreviewImage(second, { path: 'shot.png', workspace: realpathSync(first) }),
      /belongs to another workspace/
    );
    assert.throws(() => boundPreviewImage(first, { path: 'shot.png' }), /Rerun preview_image/);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('binary preview writes are confined, atomic, and do not follow destination symlinks', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-preview-write-'));
  const outside = mkdtempSync(join(tmpdir(), 'antimatter-preview-outside-'));
  try {
    const insideVictim = join(workspace, 'existing.png');
    writeFileSync(insideVictim, 'keep-inside');
    symlinkSync(insideVictim, join(workspace, 'shot.png'));

    const target = writeWorkspaceBinary(workspace, 'shot.png', Buffer.from('new pixels'));
    assert.equal(target, join(realpathSync(workspace), 'shot.png'));
    assert.equal(readFileSync(target, 'utf8'), 'new pixels');
    assert.equal(readFileSync(insideVictim, 'utf8'), 'keep-inside', 'the destination symlink was replaced, not followed');
    assert.equal(lstatSync(target).isSymbolicLink(), false);
    assert.equal(
      readdirSync(workspace).some((name) => name.endsWith('.antimatter.tmp')),
      false,
      'the atomic sibling was removed after rename'
    );

    symlinkSync(outside, join(workspace, 'escape'), 'dir');
    assert.throws(
      () => writeWorkspaceBinary(workspace, 'escape/leak.png', Buffer.from('private pixels')),
      /resolves outside the workspace/
    );
    assert.equal(readdirSync(outside).length, 0, 'a parent symlink cannot redirect screenshot bytes');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('hiding to the tray closes the native page and clears renderer state before the window disappears', () => {
  const order: string[] = [];
  hideWindowWithPreviewCleanup({
    closePage: () => order.push('native'),
    clearRenderer: () => order.push('renderer'),
    hideWindow: () => order.push('window'),
  });
  assert.deepEqual(order, ['native', 'renderer', 'window']);
});

test('only the active main-frame navigation may surface a load failure', () => {
  const current = {
    activeGeneration: 2,
    failureGeneration: 2,
    currentUrl: 'https://current.test/',
    failedUrl: 'https://current.test/',
    isMainFrame: true,
    errorCode: -105,
  };
  assert.equal(isCurrentNavigationFailure(current), true, 'a tracked failed back/forward target is reported');
  assert.equal(isCurrentNavigationFailure({ ...current, failureGeneration: 1 }), false, 'stale A cannot cover B');
  assert.equal(isCurrentNavigationFailure({ ...current, failedUrl: 'https://old.test/' }), false);
  assert.equal(isCurrentNavigationFailure({ ...current, isMainFrame: false }), false);
  assert.equal(isCurrentNavigationFailure({ ...current, errorCode: -3 }), false);
});

test('back and forward destinations are tracked before Chromium traverses history', () => {
  const events: string[] = [];
  const entries = [{ url: 'https://a.test/' }, { url: 'https://b.test/' }, { url: 'https://c.test/' }];
  let active = 1;
  const history = {
    getActiveIndex: () => active,
    getEntryAtIndex: (index: number) => entries[index] ?? null,
    goBack: () => {
      events.push('move:back');
      active -= 1;
    },
    goForward: () => {
      events.push('move:forward');
      active += 1;
    },
  };
  const begin = (url: string) => events.push(`track:${url}`);

  assert.equal(navigateHistory(history, 'back', begin), true);
  assert.deepEqual(events, ['track:https://a.test/', 'move:back']);
  events.length = 0;
  assert.equal(navigateHistory(history, 'forward', begin), true);
  assert.deepEqual(events, ['track:https://b.test/', 'move:forward']);

  active = 0;
  events.length = 0;
  assert.equal(navigateHistory(history, 'back', begin), false);
  assert.deepEqual(events, [], 'an untrackable traversal is not started');
});

test('each web preview gets an isolated partition and retirement runs every cleanup hook', async () => {
  const first = nextPreviewPartition();
  const second = nextPreviewPartition();
  assert.notEqual(first, second);
  assert.match(first, /^antimatter-preview-/);
  assert.equal(first.startsWith('persist:'), false);

  const calls: string[] = [];
  await retirePreviewSession({
    clearData: async (options) => {
      calls.push(`clear:${options.dataTypes.join(',')}`);
    },
    closeAllConnections: async () => {
      calls.push('connections');
    },
  });
  assert.deepEqual(calls.sort(), ['clear:serviceWorkers', 'connections']);

  calls.length = 0;
  await assert.rejects(
    retirePreviewSession({
      clearData: async () => {
        calls.push('clear');
        throw new Error('clear failed');
      },
      closeAllConnections: async () => {
        calls.push('connections');
      },
    }),
    /Could not completely clean up/
  );
  assert.deepEqual(calls.sort(), ['clear', 'connections'], 'one failed cleanup does not skip the other');
});

test('a preview page cannot move the app window or select an ambient client certificate', () => {
  let prevented = 0;
  let completed = 0;
  const event = { preventDefault: () => { prevented += 1; } };

  preventPageWindowMutation(event);
  assert.equal(prevented, 1);

  let certificateListener: ((...args: unknown[]) => void) | undefined;
  const previewContents = {
    on(name: string, listener: (...args: unknown[]) => void) {
      assert.equal(name, 'select-client-certificate');
      certificateListener = listener;
      return this;
    },
  } as unknown as WebContents;
  bindPreviewClientCertificateDenial(previewContents);
  assert.ok(certificateListener, 'the denial is bound only on the untrusted preview WebContents');
  certificateListener(event, 'https://mtls.example/', [{ subjectName: 'ambient identity' }], () => {
    completed += 1;
  });
  assert.deepEqual({ prevented, completed }, { prevented: 2, completed: 1 });
});

test('the preview pane loads web pages and nothing else', () => {
  assert.equal(previewableUrl('http://localhost:5173'), 'http://localhost:5173/');
  assert.equal(previewableUrl('https://example.com/a?b=c'), 'https://example.com/a?b=c');

  // The pane is a real browser engine inside the app; these would read the disk or run a script
  // from outside every boundary the tools enforce.
  assert.throws(() => previewableUrl('file:///etc/passwd'), /only opens http and https/);
  assert.throws(() => previewableUrl('data:text/html,<script>alert(1)</script>'), /only opens http and https/);
  assert.throws(() => previewableUrl('javascript:alert(1)'), /only opens http and https/);
  assert.throws(() => previewableUrl('localhost:5173'), /not a URL|only opens/);
  assert.throws(() => previewableUrl(''), /is not a URL/);
  assert.throws(() => previewableUrl('https://person:secret@example.com'), /usernames or passwords/);
  assert.throws(() => previewableUrl(`https://example.com/${'x'.repeat(4096)}`), /too long/);
});

test('the native preview surface is finite and clipped to the renderer viewport', () => {
  assert.deepEqual(
    boundedPreviewRectangle({ x: 100.4, y: 50.6, width: 400.2, height: 300.2 }, { width: 1200, height: 800 }),
    { x: 100, y: 51, width: 401, height: 300 }
  );
  assert.deepEqual(
    boundedPreviewRectangle({ x: -20, y: 700, width: 100, height: 200 }, { width: 1200, height: 800 }),
    { x: 0, y: 700, width: 80, height: 100 }
  );
  assert.deepEqual(
    boundedPreviewRectangle({ x: 1100, y: 750, width: 500, height: 500 }, { width: 1200, height: 800 }),
    { x: 1100, y: 750, width: 100, height: 50 }
  );
  assert.equal(boundedPreviewRectangle(null, { width: 1200, height: 800 }), null);
  assert.equal(
    boundedPreviewRectangle({ x: Number.NaN, y: 0, width: 100, height: 100 }, { width: 1200, height: 800 }),
    null
  );
  assert.equal(
    boundedPreviewRectangle({ x: 1200, y: 0, width: 100, height: 100 }, { width: 1200, height: 800 }),
    null
  );
});

test('every desktop capture is the user’s call, including a model-supplied window match', () => {
  // Full access is for the project. Both captures read pixels from outside it; a title narrows
  // what is requested, but cannot prove that Antimatter launched or owns the matching window.
  assert.match(machineWide('screenshot', {}) ?? '', /one desktop display/);
  assert.match(machineWide('screenshot', { window: '   ' }) ?? '', /one desktop display/);
  assert.match(machineWide('screenshot', { window: 'GIMP Clone' }) ?? '', /desktop window/);
  assert.match(machineWide('screenshot', { window: 'a' }) ?? '', /desktop window/);
  assert.equal(decide('screenshot', { mode: 'full', workspaceConfirmed: true }, {}), 'ask');
  assert.equal(decide('screenshot', { mode: 'full', workspaceConfirmed: true }, { window: 'GIMP Clone' }), 'ask');
  assert.equal(decide('screenshot', { mode: 'full', workspaceConfirmed: true }, { window: 'a' }), 'ask');

  // And the advice for a declined one must be about windows, not about virtual environments:
  // a model told to make a venv after a refused screenshot will go and make one.
  assert.match(machineWideAdvice('it photographs one desktop display', 'screenshot'), /window argument/);
  assert.match(machineWideAdvice('it photographs a desktop window', 'screenshot'), /still needs the user’s approval/);
  assert.doesNotMatch(machineWideAdvice('it photographs one desktop display', 'screenshot'), /venv/);
  assert.match(machineWideAdvice("pip's --break-system-packages installs outside any virtual environment"), /venv/);
});

test('showing and seeing are reads; taking a picture writes a file', () => {
  assert.equal(tierOf('preview_image'), 'read');
  assert.equal(tierOf('preview_url'), 'read');
  assert.equal(tierOf('look_at_image'), 'read');
  assert.equal(tierOf('screenshot'), 'write');
});
