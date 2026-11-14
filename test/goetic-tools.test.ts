import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GoeticError, goeticCall, goeticConfigView, idempotencyKey, tokenAgentId } from '../mcp/goetic';
import { goeticTools } from '../mcp/tools/goetic';

/**
 * These exercise the boundary Antimatter owns: that the credential cannot leak, that a malformed
 * identity is refused before a request goes out, that a retry presents a key Goetic can replay,
 * and that Goetic's own refusal reaches the model unaltered. Goetic's rules themselves are
 * Goetic's tests; duplicating them here would only let the two drift.
 */

/**
 * Pointed at a closed port before anything else runs. The client's default is
 * http://127.0.0.1:3000, which on a developer's machine is a real Goetic; a test that forgot to
 * set its own URL would otherwise talk to it.
 */
process.env.GOETIC_URL = 'http://127.0.0.1:1';
process.env.GOETIC_TOKEN = '';

const TOKEN = `gta_${'a'.repeat(32)}.${'b'.repeat(64)}`;
const ID = 'c'.repeat(32);
const tool = (name: string) => {
  const found = goeticTools.find((entry) => entry.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
};

interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  body: string;
}

/** A stand-in for Goetic: records what arrived and answers what the test asks it to. */
async function withServer(
  reply: (recorded: Recorded) => { status: number; body: unknown; headers?: Record<string, string> },
  work: (origin: string, calls: Recorded[]) => Promise<void>
): Promise<void> {
  const calls: Recorded[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const recorded: Recorded = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        idempotencyKey: request.headers['idempotency-key'] as string | undefined,
        body,
      };
      calls.push(recorded);
      const answer = reply(recorded);
      response.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await work(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const env = (origin: string, token = TOKEN) => ({
  GOETIC_URL: origin,
  GOETIC_TOKEN: token,
  HOME: mkdtempSync(join(tmpdir(), 'goetic-home-')),
});

/**
 * A tool's `run` reads the ambient environment, because that is how it runs for real inside the
 * MCP server process. Tests therefore borrow the environment and always put it back.
 */
async function asConnected(origin: string, work: () => Promise<void>, token = TOKEN): Promise<void> {
  const previous = { url: process.env.GOETIC_URL, token: process.env.GOETIC_TOKEN, home: process.env.HOME };
  process.env.GOETIC_URL = origin;
  process.env.GOETIC_TOKEN = token;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'goetic-home-'));
  try {
    await work();
  } finally {
    process.env.GOETIC_URL = previous.url;
    process.env.GOETIC_TOKEN = previous.token;
    process.env.HOME = previous.home;
  }
}

test('a plain-HTTP Goetic URL outside loopback is refused rather than leaking the token', async () => {
  for (const url of ['http://goetic.example.com', 'http://192.168.1.10:3000', 'http://10.0.0.5']) {
    await assert.rejects(
      () => goeticCall('GET', '/api/v1/meta', undefined, { env: { GOETIC_URL: url, GOETIC_TOKEN: TOKEN } as any }),
      /plain HTTP/,
      url
    );
  }
  // Loopback is the normal case, and https is allowed for a TLS deployment.
  for (const url of ['http://127.0.0.1:3000', 'http://localhost:3000', 'https://goetic.example.com']) {
    await assert.doesNotReject(async () => {
      await goeticCall('GET', '/api/v1/meta', undefined, {
        env: { GOETIC_URL: url, GOETIC_TOKEN: TOKEN } as any,
        timeoutMs: 1,
      }).catch((cause) => {
        // Unreachable is fine here: the point is that it was not refused outright.
        if (cause instanceof GoeticError && cause.code === 'unreachable') return;
        throw cause;
      });
    }, url);
  }
  for (const url of ['file:///etc/passwd', 'ftp://host/x', 'not a url']) {
    await assert.rejects(() => goeticCall('GET', '/api/v1/meta', undefined, { env: { GOETIC_URL: url, GOETIC_TOKEN: TOKEN } as any }));
  }
});

test('a missing credential says who can issue one, and never invents a request', async () => {
  await withServer(
    () => ({ status: 200, body: {} }),
    async (origin, calls) => {
      await assert.rejects(
        () => goeticCall('GET', '/api/v1/meta', undefined, { env: { GOETIC_URL: origin, GOETIC_TOKEN: '', HOME: mkdtempSync(join(tmpdir(), 'goetic-empty-')) } as any }),
        (cause: unknown) => {
          assert.ok(cause instanceof GoeticError);
          assert.equal(cause.code, 'unconfigured');
          assert.match(cause.message, /browser-only/);
          return true;
        }
      );
      assert.equal(calls.length, 0);
    }
  );
});

test('the config view names the agent identity and never the token', () => {
  const view = goeticConfigView({ GOETIC_URL: 'http://127.0.0.1:3000', GOETIC_TOKEN: TOKEN } as any);
  assert.equal(view.configured, true);
  assert.equal(view.agentId, 'a'.repeat(32));
  assert.equal(view.source, 'environment');
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('b'.repeat(64)), 'the secret segment must not be serializable');
  assert.ok(!serialized.includes(TOKEN));
  // A token of the wrong shape names no agent rather than being half-trusted.
  assert.equal(tokenAgentId('gta_short.aaa'), null);
  assert.equal(tokenAgentId(`gta_${'A'.repeat(32)}.${'b'.repeat(64)}`), null);
  assert.equal(tokenAgentId(TOKEN), 'a'.repeat(32));
});

test('the bearer token goes out as a header and the body is JSON', async () => {
  await withServer(
    () => ({ status: 200, body: { ok: true } }),
    async (origin, calls) => {
      await goeticCall('POST', '/api/v1/universes/x/boards/y/work', { title: 'A card' }, { env: env(origin) as any });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
      assert.equal(JSON.parse(calls[0].body).title, 'A card');
    }
  );
});

test("Goetic's own refusal reaches the model, with a hint about what to do next", async () => {
  await withServer(
    () => ({
      status: 409,
      body: { error: { code: 'conflict', message: 'Work item changed; reload before saving.', status: 409 } },
    }),
    async (origin) => {
      await asConnected(origin, async () => {
        const run = tool('goetic_move_card').run;
        await assert.rejects(
          () =>
            run(
              { universe_id: ID, board_id: ID, card_id: ID, stage: 1, handoff: 'onward', revision: 3 },
              { workspace: process.cwd() }
            ),
          (cause: unknown) => {
            const message = (cause as Error).message;
            assert.match(message, /Goetic 409 \(conflict\)/);
            assert.match(message, /Work item changed/);
            assert.match(message, /retry against its current revision/);
            return true;
          }
        );
      });
    }
  );
  // A 403 is explained as a scope, because that is what it almost always is.
  await withServer(
    () => ({ status: 403, body: { error: { code: 'forbidden', message: 'No live grant authorizes this work operation.', status: 403 } } }),
    async (origin) => {
      await asConnected(origin, async () => {
        await assert.rejects(
          () => tool('goetic_cards').run({ universe_id: ID, board_id: ID }, { workspace: process.cwd() }),
          /no live grant for that action|No live grant/
        );
      });
    }
  );
});

test('a 404 is read as "this Goetic may predate the machine API" rather than a bad id', async () => {
  await withServer(
    () => ({ status: 404, body: {} }),
    async (origin) => {
      await assert.rejects(
        () => goeticCall('GET', '/api/v1/meta', undefined, { env: env(origin) as any }),
        /predate its machine API/
      );
    }
  );
});

test('a non-JSON reply is reported as "is that really Goetic" instead of crashing', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html>a proxy login page</html>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await assert.rejects(
      () => goeticCall('GET', '/api/v1/meta', undefined, { env: env(`http://127.0.0.1:${port}`) as any }),
      /really Goetic/
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('a malformed identity is refused before any request is made', async () => {
  await withServer(
    () => ({ status: 200, body: {} }),
    async (origin, calls) => {
      await asConnected(origin, async () => {
        // Uppercase is rejected rather than folded: Goetic's identities are lowercase, and
        // quietly accepting another spelling would hide a copy from the wrong place.
        for (const bad of ['', 'nope', 'C'.repeat(32), 'c'.repeat(31), `${'c'.repeat(33)}`, 'c'.repeat(32) + 'g']) {
          await assert.rejects(
            () => tool('goetic_card').run({ universe_id: bad, board_id: ID, card_id: ID }, { workspace: process.cwd() }),
            /32 lowercase hexadecimal/,
            JSON.stringify(bad)
          );
        }
        assert.equal(calls.length, 0, 'no request should leave for a malformed identity');
        // Surrounding whitespace is trimmed deliberately, because an id is usually pasted.
        await tool('goetic_card').run(
          { universe_id: ` ${ID} `, board_id: ID, card_id: ID },
          { workspace: process.cwd() }
        );
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.includes(ID));
      });
    }
  );
});

test('a retried create presents the same idempotency key, and a different card does not', async () => {
  const first = idempotencyKey('create', { board: ID, patch: { title: 'One' } });
  assert.equal(first, idempotencyKey('create', { board: ID, patch: { title: 'One' } }));
  assert.notEqual(first, idempotencyKey('create', { board: ID, patch: { title: 'Two' } }));
  assert.notEqual(first, idempotencyKey('move', { board: ID, patch: { title: 'One' } }));
  assert.match(first, /^antimatter-create-[0-9a-f]{32}$/);

  await withServer(
    (recorded) => ({
      status: 201,
      body: { id: ID, revision: 1, stage_name: 'Idea', current: { title: 'One' } },
      headers: recorded.idempotencyKey ? { 'idempotency-replayed': 'true' } : {},
    }),
    async (origin, calls) => {
      await asConnected(origin, async () => {
        const run = tool('goetic_create_card').run;
        await run({ universe_id: ID, board_id: ID, title: 'One' }, { workspace: process.cwd() });
        await run({ universe_id: ID, board_id: ID, title: 'One' }, { workspace: process.cwd() });
        assert.equal(calls.length, 2);
        assert.ok(calls[0].idempotencyKey, 'a create must carry a key so a retry cannot duplicate the card');
        assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
        await run({ universe_id: ID, board_id: ID, title: 'Another' }, { workspace: process.cwd() });
        assert.notEqual(calls[2].idempotencyKey, calls[0].idempotencyKey);
      });
    }
  );
});

test('an omitted planning field is not sent, so it keeps the value already stored', async () => {
  await withServer(
    () => ({ status: 200, body: { id: ID, revision: 4, stage_name: 'Build', current: {} } }),
    async (origin, calls) => {
      await asConnected(origin, async () => {
        await tool('goetic_update_card').run(
          { universe_id: ID, board_id: ID, card_id: ID, revision: 3, acceptance: 'Only this' },
          { workspace: process.cwd() }
        );
        const sent = JSON.parse(calls[0].body);
        assert.deepEqual(Object.keys(sent).sort(), ['acceptance', 'revision']);
        assert.equal(sent.revision, 3);
      });
    }
  );
});

test('a move sends the handoff and omits evidence unless given', async () => {
  await withServer(
    () => ({ status: 200, body: { id: ID, revision: 5, stage_name: 'Verify', current: {} } }),
    async (origin, calls) => {
      await asConnected(origin, async () => {
        const run = tool('goetic_move_card').run;
        await run(
          { universe_id: ID, board_id: ID, card_id: ID, stage: 4, handoff: 'to the verifier', revision: 4 },
          { workspace: process.cwd() }
        );
        assert.deepEqual(Object.keys(JSON.parse(calls[0].body)).sort(), ['handoff', 'revision', 'stage']);
        await run(
          { universe_id: ID, board_id: ID, card_id: ID, stage: 4, handoff: 'again', evidence: 'test output', revision: 4 },
          { workspace: process.cwd() }
        );
        assert.equal(JSON.parse(calls[1].body).evidence, 'test output');
      });
    }
  );
});

test('every tool declares a schema, and only the five write tools mutate', () => {
  const names = goeticTools.map((entry) => entry.name);
  assert.deepEqual(names, [
    'goetic_status',
    'goetic_universes',
    'goetic_board',
    'goetic_cards',
    'goetic_card',
    'goetic_card_history',
    'goetic_create_card',
    'goetic_update_card',
    'goetic_move_card',
    'goetic_archive_card',
    'goetic_restore_card',
  ]);
  for (const entry of goeticTools) {
    assert.equal(entry.inputSchema.type, 'object', entry.name);
    assert.ok(entry.description.length > 40, entry.name);
    for (const required of entry.inputSchema.required ?? []) {
      assert.ok(required in entry.inputSchema.properties, `${entry.name}.${required}`);
    }
  }
  // A move must demand a handoff and a revision: those are the two things that
  // keep the record honest and keep a stale write from landing.
  const move = tool('goetic_move_card').inputSchema.required ?? [];
  assert.ok(move.includes('handoff') && move.includes('revision') && move.includes('stage'));
  // Nothing here can administer a credential.
  assert.ok(!names.some((name) => /mint|rotate|revoke|admit|scope|token/i.test(name)));
});

test('goetic_status explains the unconfigured case without contacting anything', async () => {
  const home = mkdtempSync(join(tmpdir(), 'goetic-unset-'));
  const previousHome = process.env.HOME;
  const previousToken = process.env.GOETIC_TOKEN;
  process.env.HOME = home;
  delete process.env.GOETIC_TOKEN;
  try {
    const text = await tool('goetic_status').run({}, { workspace: process.cwd() });
    assert.match(text, /not connected/i);
    assert.match(text, /cannot mint one/);
    assert.ok(!text.includes(TOKEN));
  } finally {
    process.env.HOME = previousHome;
    if (previousToken !== undefined) process.env.GOETIC_TOKEN = previousToken;
  }
});

test('a saved credential is written private to the user, and readable back as a view only', async () => {
  const home = mkdtempSync(join(tmpdir(), 'goetic-save-'));
  const previousHome = process.env.HOME;
  const previousToken = process.env.GOETIC_TOKEN;
  const previousUrl = process.env.GOETIC_URL;
  process.env.HOME = home;
  delete process.env.GOETIC_TOKEN;
  delete process.env.GOETIC_URL;
  try {
    const { saveGoeticConfig } = await import('../mcp/goetic');
    // The environment is injected, so this never touches the real ~/.antimatter.
    const view = saveGoeticConfig({ url: 'http://127.0.0.1:3000', token: TOKEN }, { HOME: home } as any);
    assert.equal(view.configured, true);
    assert.equal(view.agentId, 'a'.repeat(32));
    const path = join(home, '.antimatter', 'goetic.json');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(readFileSync(path, 'utf8').includes(TOKEN), 'the token is stored for the next launch');
    // A token of the wrong shape is refused rather than stored and later failing.
    assert.throws(() => saveGoeticConfig({ token: 'nonsense' }, { HOME: home } as any), /not a Goetic agent token/);
    // Clearing is explicit and distinguishable from leaving it alone.
    assert.equal(saveGoeticConfig({ token: '' }, { HOME: home } as any).configured, false);
    assert.equal(saveGoeticConfig({ url: 'http://127.0.0.1:4000' }, { HOME: home } as any).url, 'http://127.0.0.1:4000');
    assert.throws(() => saveGoeticConfig({ url: 'http://example.com' }, { HOME: home } as any), /plain HTTP/);
  } finally {
    process.env.HOME = previousHome;
    if (previousToken !== undefined) process.env.GOETIC_TOKEN = previousToken;
    if (previousUrl !== undefined) process.env.GOETIC_URL = previousUrl;
  }
});
