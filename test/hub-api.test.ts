import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRepoId,
  detailUrl,
  errorFromResponse,
  groupVariants,
  HubError,
  modelDetail,
  nextCursor,
  quantOf,
  searchModels,
  searchUrl,
  whoami,
  type HubTransport,
} from '../src/main/hub/api';
import type { HubFile } from '../src/main/hub/types';

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });

test('search URLs ask for GGUF facts, map sorts, and carry the cursor', () => {
  const url = new URL(
    searchUrl({ text: ' qwen3 coder ', sort: 'trending', format: 'gguf', task: 'text-generation', cursor: 'abc', limit: 500 }, 'https://hub.test')
  );
  assert.equal(url.origin + url.pathname, 'https://hub.test/api/models');
  assert.equal(url.searchParams.get('search'), 'qwen3 coder');
  assert.equal(url.searchParams.get('filter'), 'gguf');
  assert.equal(url.searchParams.get('pipeline_tag'), 'text-generation');
  assert.equal(url.searchParams.get('sort'), 'trendingScore');
  assert.equal(url.searchParams.get('direction'), '-1');
  assert.equal(url.searchParams.get('limit'), '100', 'the Hub caps pages; so do we');
  assert.equal(url.searchParams.get('cursor'), 'abc');
  assert.ok(url.searchParams.getAll('expand[]').includes('gguf'));

  const plain = new URL(searchUrl({ text: '', sort: 'downloads', format: 'any', task: null }, 'https://hub.test'));
  assert.equal(plain.searchParams.has('search'), false);
  assert.equal(plain.searchParams.has('filter'), false);
  assert.equal(plain.searchParams.has('pipeline_tag'), false);
});

test('the next cursor is read from the Link header', () => {
  assert.equal(
    nextCursor('<https://huggingface.co/api/models?search=x&cursor=eyJ0b2tlbiI6MX0%3D>; rel="next"'),
    'eyJ0b2tlbiI6MX0='
  );
  assert.equal(nextCursor('<https://huggingface.co/api/models?cursor=a>; rel="prev"'), null);
  assert.equal(nextCursor(null), null);
});

test('search normalizes summaries, drops the chat template, and sends the token', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const transport: HubTransport = async (url, init) => {
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    return json(
      [
        {
          id: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
          downloads: 12834876,
          likes: 1012,
          gated: false,
          pipeline_tag: 'text-generation',
          tags: ['gguf', 7],
          lastModified: '2026-08-01T00:00:00.000Z',
          gguf: { architecture: 'qwen3moe', context_length: 262144, total: 30532122624, chat_template: 'x'.repeat(5000) },
        },
        { id: 'meta-llama/Llama-3.2-1B-Instruct', gated: 'manual' },
      ],
      { headers: { Link: '<https://huggingface.co/api/models?cursor=next-page>; rel="next"' } }
    );
  };

  const page = await searchModels({ text: 'qwen', sort: 'downloads', format: 'gguf', task: null }, { token: 'hf_secret', transport });
  assert.equal(seen[0].auth, 'Bearer hf_secret');
  assert.equal(page.nextCursor, 'next-page');
  assert.deepEqual(page.models[0], {
    id: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
    author: 'unsloth',
    downloads: 12834876,
    likes: 1012,
    updatedAt: '2026-08-01T00:00:00.000Z',
    task: 'text-generation',
    gated: false,
    private: false,
    tags: ['gguf'],
    gguf: { architecture: 'qwen3moe', contextLength: 262144, parameters: 30532122624 },
  });
  assert.equal(page.models[1].gated, 'manual');
  assert.equal(page.models[1].gguf, null);
});

test('quantizations are found in the names people actually publish', () => {
  assert.equal(quantOf('Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf'), 'Q4_K_M');
  assert.equal(quantOf('Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL'), 'UD-Q4_K_XL');
  assert.equal(quantOf('Qwen3-Coder-30B-A3B-Instruct-UD-IQ1_M.gguf'), 'UD-IQ1_M');
  assert.equal(quantOf('gpt-oss-20b-MXFP4.gguf'), 'MXFP4');
  assert.equal(quantOf('Llama-3.2-1B-Instruct-f16.gguf'), 'F16');
  assert.equal(quantOf('qwen2.5-0.5b-instruct-q8_0.gguf'), 'Q8_0');
  assert.equal(quantOf('Qwen3-0.6B.gguf'), null, 'a model named Qwen3 is not a quant');
});

test('split GGUFs become one ordered variant, projectors sort last, and gaps are reported', () => {
  const file = (path: string, size: number): HubFile => ({ path, size, sha256: sha(String(size % 10)) });
  const variants = groupVariants([
    file('README.md', 10),
    file('BF16/Model-BF16-00002-of-00002.gguf', 200),
    file('Model-Q4_K_M.gguf', 50),
    file('BF16/Model-BF16-00001-of-00002.gguf', 300),
    file('mmproj-Model-F16.gguf', 5),
    file('Q8_0/Model-Q8_0-00001-of-00003.gguf', 100),
    file('Q8_0/Model-Q8_0-00003-of-00003.gguf', 100),
    file('imatrix.gguf_file', 1),
  ]);

  assert.deepEqual(
    variants.map((variant) => [variant.label, variant.bytes, variant.shards, variant.complete, variant.role]),
    [
      ['Q4_K_M', 50, 1, true, 'model'],
      ['Q8_0', 200, 3, false, 'model'],
      ['BF16', 500, 2, true, 'model'],
      ['mmproj F16', 5, 1, true, 'projector'],
    ]
  );
  const bf16 = variants.find((variant) => variant.label === 'BF16')!;
  assert.equal(bf16.key, 'BF16/Model-BF16');
  assert.deepEqual(
    bf16.files.map((entry) => entry.path),
    ['BF16/Model-BF16-00001-of-00002.gguf', 'BF16/Model-BF16-00002-of-00002.gguf']
  );
});

test('model detail pins the commit, keeps LFS digests, and refuses paths that climb', async () => {
  let requested = '';
  const transport: HubTransport = async (url) => {
    requested = url;
    return json({
      id: 'Qwen/Qwen3-0.6B-GGUF',
      sha: 'a'.repeat(40),
      gated: false,
      pipeline_tag: 'text-generation',
      cardData: { license: 'apache-2.0' },
      gguf: { architecture: 'qwen3', context_length: 40960, total: 596049920 },
      siblings: [
        { rfilename: 'Qwen3-0.6B-Q8_0.gguf', size: 639446688, lfs: { sha256: 'B'.repeat(64), size: 639446688 } },
        { rfilename: '../escape.gguf', size: 1, lfs: { sha256: 'c'.repeat(64), size: 1 } },
        { rfilename: '/etc/passwd.gguf', size: 1 },
        { rfilename: 'README.md', size: 100 },
      ],
    });
  };

  const detail = await modelDetail('Qwen/Qwen3-0.6B-GGUF', { transport, revision: 'f'.repeat(40) });
  assert.match(requested, /\/api\/models\/Qwen\/Qwen3-0\.6B-GGUF\/revision\/f{40}\?blobs=true/);
  assert.equal(detail.revision, 'a'.repeat(40));
  assert.equal(detail.license, 'apache-2.0');
  assert.equal(detail.otherFiles, 1);
  assert.deepEqual(detail.variants.map((variant) => variant.files), [
    [{ path: 'Qwen3-0.6B-Q8_0.gguf', size: 639446688, sha256: 'b'.repeat(64) }],
  ]);

  await assert.rejects(modelDetail('Qwen/Qwen3', { transport: async () => json({ id: 'Qwen/Qwen3' }) }), /which commit/);
  assert.throws(() => detailUrl('Qwen/Qwen3', 'main'), /not a commit/);
});

test('repository ids are validated before they become URLs or directories', () => {
  assert.equal(assertRepoId(' Qwen/Qwen3-0.6B-GGUF '), 'Qwen/Qwen3-0.6B-GGUF');
  for (const bad of ['Qwen', 'a/b/c', '../x', 'a/..', 'a/b c', '']) {
    assert.throws(() => assertRepoId(bad), HubError, bad);
  }
});

test('refusals become errors a person can act on', async () => {
  const gated = await errorFromResponse(
    new Response('restricted', {
      status: 401,
      headers: { 'x-error-code': 'GatedRepo', 'x-error-message': 'Access to model meta-llama/Llama-3.2-1B is restricted.' },
    }),
    'the download'
  );
  assert.equal(gated.code, 'gated');
  assert.match(gated.message, /restricted\. Accept its terms/);
  assert.equal(gated.retryable, false);

  const unauthorized = await errorFromResponse(new Response(JSON.stringify({ error: 'Invalid username or password.' }), { status: 401 }), 'the token check');
  assert.equal(unauthorized.code, 'unauthorized');
  assert.match(unauthorized.message, /token in Settings/);

  const limited = await errorFromResponse(new Response('', { status: 429, headers: { ratelimit: '"api";r=0;t=42' } }), 'the search');
  assert.equal(limited.code, 'rate_limited');
  assert.equal(limited.retryAfterMs, 42_000);
  assert.equal(limited.retryable, true);

  const server = await errorFromResponse(new Response('', { status: 503 }), 'the search');
  assert.equal(server.retryable, true);
});

test('whoami needs a token and reports the account and token role', async () => {
  await assert.rejects(whoami({ token: null }), /No Hugging Face token/);
  const account = await whoami({
    token: 'hf_x',
    transport: async () => json({ name: 'nathan', fullname: 'Nathan', auth: { accessToken: { role: 'read', displayName: 'antimatter' } } }),
  });
  assert.deepEqual(account, { name: 'nathan', fullname: 'Nathan', tokenRole: 'read', tokenName: 'antimatter' });
});
