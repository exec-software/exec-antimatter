import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderManager } from '../src/api/providers';
import { AnthropicMessagesProvider } from '../src/api/providers/anthropicMessages';
import { OpenAICompatibleProvider } from '../src/api/providers/openai';
import { OpenAIResponsesProvider } from '../src/api/providers/openaiResponses';
import { DEFAULT_MAX_TOOL_CALLS } from '../src/api/toolArguments';
import type { ChatRequest, ProviderConfig, ToolCall } from '../src/api/types';

const config: ProviderConfig = {
  id: 'openai-compatible-test',
  name: 'Test source',
  apiKey: 'test-key',
  baseUrl: 'http://inference.test/v1/',
  models: [{ id: 'test-model', name: 'Test model' }],
  supportsStreaming: true,
};

const request: ChatRequest = {
  messages: [{ id: 'user-1', role: 'user', content: 'Use the available tool.' }],
  model: 'test-model',
  providerId: config.id,
  requestId: 'request-1',
};

test('compatible requests refuse credential-bearing redirects', async () => {
  const original = globalThis.fetch;
  let redirect: RequestRedirect | undefined;
  globalThis.fetch = (async (_input, init) => {
    redirect = init?.redirect;
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  }) as typeof fetch;
  try {
    assert.equal(await new OpenAICompatibleProvider(config).chat(request), 'ok');
    assert.equal(redirect, 'error');
  } finally {
    globalThis.fetch = original;
  }
});

const encoder = new TextEncoder();

function chunkedSseResponse(source: string, cuts: number[]): Response {
  const bytes = encoder.encode(source);
  const chunks: Uint8Array[] = [];
  let start = 0;

  for (const end of [...cuts, bytes.length]) {
    chunks.push(bytes.slice(start, end));
    start = end;
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
  );
}

async function withFetch<T>(response: Response, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('assembles fragmented SSE tool calls and flushes an unterminated final frame', async () => {
  const first = JSON.stringify({
    choices: [
      {
        delta: {
          content: 'h\u00e9',
          tool_calls: [
            {
              index: 0,
              id: 'call_shell',
              function: { name: 'run_command', arguments: '{"command":"' },
            },
          ],
        },
      },
    ],
  });
  const second = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: 'pwd"}' } }],
        },
      },
    ],
  });
  // The first frame deliberately omits the optional space after `data:`. The second frame has
  // neither a trailing newline nor [DONE], as seen with servers that close immediately at EOF.
  const wire = `data:${first}\n\ndata: ${second}`;
  const splitInsideUtf8Character = encoder.encode(wire.slice(0, wire.indexOf('\u00e9'))).length + 1;
  const response = chunkedSseResponse(wire, [4, 23, splitInsideUtf8Character, wire.length - 5]);
  const streamed: string[] = [];
  let liveness = 0;

  const result = await withFetch(response, () =>
    new OpenAICompatibleProvider(config).stream(
      request,
      ({ content }) => streamed.push(content),
      () => {
        liveness += 1;
      }
    )
  );

  assert.deepEqual(streamed.filter(Boolean), ['h\u00e9']);
  assert.equal(result.content, 'h\u00e9');
  assert.deepEqual(result.toolCalls, [
    {
      id: 'call_shell',
      type: 'function',
      function: { name: 'run_command', arguments: '{"command":"pwd"}' },
    },
  ] satisfies ToolCall[]);
  assert.equal(liveness, 2);
});

test('propagates an error envelope delivered over a successful SSE response', async () => {
  const response = chunkedSseResponse(
    'event: error\ndata: {"error":{"message":"inference failed","code":"inference_error"}}\n\n',
    []
  );

  await assert.rejects(
    withFetch(response, () => new OpenAICompatibleProvider(config).stream(request, () => undefined)),
    /Test source stream failed: inference failed \(inference_error\)/
  );
});

test('does not accept an entirely malformed SSE response as an empty success', async () => {
  const response = chunkedSseResponse('data: {not-json}\n\ndata: [DONE]\n\n', []);

  await assert.rejects(
    withFetch(response, () => new OpenAICompatibleProvider(config).stream(request, () => undefined)),
    /returned malformed streaming data without usable output/
  );
});

test('does not let a role-only delta mask a malformed SSE completion', async () => {
  const role = JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] });
  const response = chunkedSseResponse(`data: ${role}\n\ndata: {not-json}\n\ndata: [DONE]\n\n`, []);

  await assert.rejects(
    withFetch(response, () => new OpenAICompatibleProvider(config).stream(request, () => undefined)),
    /returned malformed streaming data without usable output/
  );
});

test('keeps usable output when one SSE frame is malformed', async () => {
  const content = JSON.stringify({ choices: [{ delta: { content: 'Survived.' } }] });
  const response = chunkedSseResponse(`data: ${content}\n\ndata: {not-json}\n\ndata: [DONE]\n\n`, []);
  const streamed: string[] = [];

  const result = await withFetch(response, () =>
    new OpenAICompatibleProvider(config).stream(request, ({ content: part }) => streamed.push(part))
  );

  assert.deepEqual(streamed.filter(Boolean), ['Survived.']);
  assert.equal(result.content, 'Survived.');
});

test('propagates an error envelope delivered by the non-streaming endpoint', async () => {
  const response = Response.json({ error: { message: 'model unavailable', code: 'model_error' } });

  await assert.rejects(
    withFetch(response, () => new OpenAICompatibleProvider(config).chat(request)),
    /Test source request failed: model unavailable \(model_error\)/
  );
});

test('provider error text cannot echo its stored credential into renderer-visible failures', async () => {
  await assert.rejects(
    withFetch(
      Response.json({ error: { message: `credential ${config.apiKey} was rejected` } }),
      () => new OpenAICompatibleProvider(config).chat(request)
    ),
    (error: Error) => {
      assert.match(error.message, /credential \[redacted\] was rejected/);
      assert.doesNotMatch(error.message, new RegExp(config.apiKey));
      return true;
    }
  );
});

test('forwards cancellation to the non-streaming inference request', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_input, init) => {
    observedSignal = init?.signal;
    return Response.json({ choices: [{ message: { content: 'Done.' } }] });
  }) as typeof fetch;

  try {
    const result = await new OpenAICompatibleProvider(config).chat(request, controller.signal);
    assert.equal(result, 'Done.');
    assert.equal(observedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('prepares an app-managed source and uses its request-time endpoint and credential', async () => {
  const originalFetch = globalThis.fetch;
  const observed: Array<{ url: string; authorization: string | null }> = [];
  let prepared = 0;
  globalThis.fetch = (async (input, init) => {
    observed.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return Response.json({ choices: [{ message: { content: 'Ready.' } }] });
  }) as typeof fetch;

  try {
    const provider = new OpenAICompatibleProvider(
      config,
      undefined,
      async () => {
        prepared += 1;
        return { baseUrl: 'http://127.0.0.1:6769/v1', apiKey: 'per-start-key' };
      }
    );
    assert.equal(await provider.chat(request), 'Ready.');
    assert.equal(prepared, 1);
    assert.deepEqual(observed, [
      {
        url: 'http://127.0.0.1:6769/v1/chat/completions',
        authorization: 'Bearer per-start-key',
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('marks a source busy before managed-service preparation and releases it after failure', async () => {
  const events: string[] = [];
  const provider = new OpenAICompatibleProvider(
    config,
    () => {
      events.push('busy');
      return () => events.push('idle');
    },
    async () => {
      events.push('prepare');
      throw new Error('conflicting source is active');
    }
  );

  await assert.rejects(provider.chat(request), /conflicting source is active/);
  assert.deepEqual(events, ['busy', 'prepare', 'idle']);
});

test('explicit source preparation reserves the destination for the lifecycle transition', async () => {
  const manager = ProviderManager.fromConfigs([config]);
  let observedBusy = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  manager.usePrepareProvider(async (providerId) => {
    observedBusy = manager.busy(providerId);
    await held;
  });

  const preparing = manager.prepare(config.id);
  await Promise.resolve();
  assert.equal(observedBusy, true);
  assert.equal(manager.busy(config.id), true);
  assert.equal(manager.anyBusy(), true);

  release();
  await preparing;
  assert.equal(manager.busy(config.id), false);
  assert.equal(manager.anyBusy(), false);
});

test('provider manager dispatches explicit native protocols and preserves legacy chat sources', () => {
  const manager = ProviderManager.fromConfigs([
    config,
    { ...config, id: 'responses', protocol: 'openai-responses' },
    { ...config, id: 'anthropic', protocol: 'anthropic-messages' },
  ]);

  assert.ok(manager.getProvider(config.id) instanceof OpenAICompatibleProvider);
  assert.ok(manager.getProvider('responses') instanceof OpenAIResponsesProvider);
  assert.ok(manager.getProvider('anthropic') instanceof AnthropicMessagesProvider);
});

test('provider manager rejects an unknown explicit protocol instead of downgrading to chat', () => {
  assert.throws(
    () =>
      ProviderManager.fromConfigs([
        { ...config, protocol: 'future-provider-wire' as ProviderConfig['protocol'] },
      ]),
    /Unsupported inference wire protocol: future-provider-wire/
  );
});

test('accepts a complete JSON message when a server ignores streaming', async () => {
  const response = Response.json({
    choices: [
      {
        message: {
          content: 'Done.',
          tool_calls: [
            {
              id: 'call_write',
              type: 'function',
              function: { name: 'write_file', arguments: { path: '/tmp/result', content: 'ok' } },
            },
            {
              id: 'call_shell',
              type: 'function',
              function: { name: 'run_command', arguments: '{"command":"pwd"}' },
            },
          ],
        },
      },
    ],
  });
  const streamed: string[] = [];

  const result = await withFetch(response, () =>
    new OpenAICompatibleProvider(config).stream(request, ({ content }) => streamed.push(content))
  );

  assert.deepEqual(streamed.filter(Boolean), ['Done.']);
  assert.equal(result.content, 'Done.');
  assert.deepEqual(result.toolCalls, [
    {
      id: 'call_write',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: '{"path":"/tmp/result","content":"ok"}',
      },
    },
    {
      id: 'call_shell',
      type: 'function',
      function: { name: 'run_command', arguments: '{"command":"pwd"}' },
    },
  ] satisfies ToolCall[]);
});

test('advertises tools without sending tool_choice', async () => {
  const originalFetch = globalThis.fetch;
  let postedBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    postedBody = JSON.parse(String(init?.body));
    return chunkedSseResponse('data: [DONE]\n\n', []);
  }) as typeof fetch;

  try {
    await new OpenAICompatibleProvider(config).stream(
      {
        ...request,
        tools: [
          {
            type: 'function',
            function: {
              name: 'run_command',
              description: 'Run a shell command.',
              parameters: {
                type: 'object',
                properties: { command: { type: 'string' } },
                required: ['command'],
              },
            },
          },
        ],
      },
      () => undefined
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(postedBody?.tools, [
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a shell command.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    },
  ]);
  assert.equal(Object.hasOwn(postedBody ?? {}, 'tool_choice'), false);
  assert.equal(postedBody?.stream, true);
});

test('repairs malformed tool arguments in legacy history before sending them', async () => {
  const originalFetch = globalThis.fetch;
  let postedBody: any;
  const malformed = '{"command":"cat > app.py <<EOF\nclass App';
  globalThis.fetch = (async (_input, init) => {
    postedBody = JSON.parse(String(init?.body));
    return chunkedSseResponse('data: [DONE]\n\n', []);
  }) as typeof fetch;

  try {
    await new OpenAICompatibleProvider(config).stream(
      {
        ...request,
        messages: [
          request.messages[0],
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'broken',
                type: 'function',
                function: { name: 'run_command', arguments: malformed },
              },
            ],
          },
          {
            id: 'broken',
            role: 'tool',
            toolCallId: 'broken',
            name: 'run_command',
            content: 'The call was cut off and did not run.',
          },
        ],
      },
      () => undefined
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const args = postedBody.messages[1].tool_calls[0].function.arguments;
  assert.doesNotMatch(args, /class App/);
  assert.deepEqual(JSON.parse(args)._antimatter, {
    invalidToolArguments: true,
    reason: 'invalid_json',
    originalCharacters: malformed.length,
  });
});

// ---------------------------------------------------------------------------
// Cold-model loads. A local runtime reading 156 GiB of weights is not a failure,
// and used to be reported as one ("did not answer … Is the server running?").
// ---------------------------------------------------------------------------

const localConfig: ProviderConfig = { ...config, kind: 'beholdd', name: 'beholdd GPU (Vulkan)' };

/** The provider with its between-attempt pause shortened, so these tests run in milliseconds. */
class ImpatientProvider extends OpenAICompatibleProvider {
  protected override loadRetryPauseMs(): number {
    return 1;
  }
}

function loadingResponse(retryAfter?: string): Response {
  return new Response(
    JSON.stringify({ error: { type: 'model_loading', model: 'mimo-v26-flash', message: 'loading' } }),
    {
      status: 503,
      statusText: 'Service Unavailable',
      headers: retryAfter
        ? { 'content-type': 'application/json', 'retry-after': retryAfter }
        : { 'content-type': 'application/json' },
    }
  );
}

/** What undici raises when a connection is accepted but no response headers ever arrive. */
function headersTimeout(): Error {
  const error = new TypeError('fetch failed');
  (error as Error & { cause?: Error }).cause = Object.assign(new Error('Headers Timeout Error'), {
    code: 'UND_ERR_HEADERS_TIMEOUT',
    name: 'HeadersTimeoutError',
  });
  return error;
}

function refused(): Error {
  const error = new TypeError('fetch failed');
  (error as Error & { cause?: Error }).cause = Object.assign(
    new Error('connect ECONNREFUSED 127.0.0.1:6767'),
    { code: 'ECONNREFUSED' }
  );
  return error;
}

test('a model_loading 503 is waited out rather than reported as a failure', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input) => {
    seen.push(String(input));
    return seen.length < 3
      ? loadingResponse('1')
      : Response.json({ choices: [{ message: { content: 'MiMo online.' } }] });
  }) as typeof fetch;
  try {
    assert.equal(await new ImpatientProvider(localConfig).chat(request), 'MiMo online.');
    assert.equal(seen.length, 3, 'both 503s should be retried');
  } finally {
    globalThis.fetch = original;
  }
});

test('a hosted source never re-sends a request after a 503', async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    return loadingResponse('1');
  }) as typeof fetch;
  try {
    await assert.rejects(
      new ImpatientProvider({ ...config, kind: 'openai' }).chat(request),
      /refused the request: 503/
    );
    assert.equal(attempts, 1, 'a remote endpoint must not be re-sent');
  } finally {
    globalThis.fetch = original;
  }
});

test('the request that triggers the load stalls, and is retried while the port answers', async () => {
  const original = globalThis.fetch;
  const posts: string[] = [];
  let probes = 0;
  globalThis.fetch = (async (input, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      probes += 1;
      return Response.json({ data: [] });
    }
    posts.push(String(input));
    if (posts.length === 1) throw headersTimeout();
    return Response.json({ choices: [{ message: { content: 'loaded at last' } }] });
  }) as typeof fetch;
  try {
    assert.equal(await new ImpatientProvider(localConfig).chat(request), 'loaded at last');
    assert.equal(posts.length, 2);
    assert.equal(probes, 1, 'the stall should be checked against the socket once');
  } finally {
    globalThis.fetch = original;
  }
});

test('a stall whose probe is also unanswered counts as loading, not as death', async () => {
  const original = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      // beholdd holds its registry lock for the whole load: the probe stalls too.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ data: [] });
    }
    posts += 1;
    if (posts === 1) throw headersTimeout();
    return Response.json({ choices: [{ message: { content: 'up' } }] });
  }) as typeof fetch;
  try {
    assert.equal(await new ImpatientProvider(localConfig).chat(request), 'up');
    assert.equal(posts, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('a runtime that is actually gone is reported at once', async () => {
  const original = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? 'GET') === 'GET') throw refused();
    posts += 1;
    throw headersTimeout();
  }) as typeof fetch;
  try {
    await assert.rejects(new ImpatientProvider(localConfig).chat(request), (error: Error) => {
      assert.match(error.message, /did not answer/);
      assert.match(error.message, /a cold model may still be loading/);
      return true;
    });
    assert.equal(posts, 1, 'a refused socket must not be retried');
  } finally {
    globalThis.fetch = original;
  }
});

test('stopping the turn interrupts the wait between attempts', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ data: [] });
    controller.abort();
    return loadingResponse('120');
  }) as typeof fetch;
  try {
    await assert.rejects(
      new ImpatientProvider(localConfig).chat(request, controller.signal),
      /the turn was stopped/
    );
  } finally {
    globalThis.fetch = original;
  }
});

/**
 * A stream of `count` tool-call deltas that reports how far it was actually pulled, and whether
 * it was cancelled. Standing in for an engine: every frame here is a frame somebody paid to
 * decode, so the count is the cost of noticing a runaway batch late.
 */
function toolCallStream(count: number) {
  const state = { sent: 0, cancelled: false };
  const frame = (index: number) =>
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: `call_${index}`,
                function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${index}.ts` }) },
              },
            ],
          },
        },
      ],
    })}\n\n`;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.sent >= count) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(frame(state.sent)));
      state.sent += 1;
    },
    cancel() {
      state.cancelled = true;
    },
  });

  const response = new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  return { response, state };
}

test('a reply over the cap is cut off mid-stream instead of read to the end', async () => {
  // The whole point of the cap: a reply asking for 500 calls costs 500 calls of decoding unless
  // the connection is closed, and only the first few could ever have run.
  const { response, state } = toolCallStream(500);
  const result = await withFetch(response, () =>
    new OpenAICompatibleProvider(config).stream({ ...request, maxToolCalls: 8 }, () => undefined)
  );

  assert.equal(result.toolCalls.length, 8);
  assert.equal(result.toolCallsCutOff, true, 'the loop has to know the batch was truncated');
  assert.equal(result.finishReason, 'tool_calls');
  // The cap, the call past it that reveals the overrun, and whatever the stream had already
  // read ahead. The number that matters is the one it is not: 500.
  assert.ok(state.sent <= 12, `stopped near the cap, but ${state.sent} calls were generated`);
  assert.equal(state.cancelled, true, 'cancelling the body is what stops the engine generating');
});

test('a reply inside the cap is read to the end and not marked as cut', async () => {
  const { response, state } = toolCallStream(4);
  const result = await withFetch(response, () =>
    new OpenAICompatibleProvider(config).stream({ ...request, maxToolCalls: 8 }, () => undefined)
  );

  assert.equal(result.toolCalls.length, 4);
  assert.equal(result.toolCallsCutOff, false);
  assert.equal(state.cancelled, false, 'a stream that reached [DONE] needs no cancelling');
});

test('the cap defaults to the shared limit when the request does not narrow it', async () => {
  const { response } = toolCallStream(500);
  const result = await withFetch(response, () =>
    new OpenAICompatibleProvider(config).stream(request, () => undefined)
  );
  assert.equal(result.toolCalls.length, DEFAULT_MAX_TOOL_CALLS);
  assert.equal(result.toolCallsCutOff, true);
});

test('streams a reasoning model\'s thinking apart from its answer', async () => {
  // The shape beholdd serves MiMo in: llama.cpp parses <think> out of the content and sends it
  // as `reasoning_content`, so a turn that deliberates for twelve minutes and then writes one
  // sentence arrives as hundreds of these frames and a couple of the other kind.
  const wire = [
    { choices: [{ delta: { reasoning_content: 'The console ' } }] },
    { choices: [{ delta: { reasoning_content: 'already has tabs.' } }] },
    { choices: [{ delta: { content: 'Here is the plan.' } }] },
  ]
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join('');

  const delivered: { content: string; reasoning?: string }[] = [];
  const result = await withFetch(chunkedSseResponse(wire, [17, 64]), () =>
    new OpenAICompatibleProvider(config).stream(request, (data) => delivered.push(data))
  );

  // The answer is the answer. Thinking that reached `content` would be indistinguishable from
  // something the model said, in the transcript and in the carbon.
  assert.equal(result.content, 'Here is the plan.');
  assert.equal(result.reasoning, 'The console already has tabs.');
  assert.ok(
    delivered.every((frame) => !(frame.content && frame.reasoning)),
    'no frame may carry both an answer and the thinking behind it'
  );
  assert.deepEqual(
    delivered.filter((frame) => frame.content).map((frame) => frame.content),
    ['Here is the plan.']
  );
  // Delivered as it arrives rather than in one lump at the end: the point of forwarding it is
  // that a silent turn is indistinguishable from a hung one while it is still running.
  assert.deepEqual(
    delivered.filter((frame) => frame.reasoning).map((frame) => frame.reasoning),
    ['The console ', 'already has tabs.']
  );
});

/**
 * A faithful transcription of the checks in Mistral Small 4's own GGUF chat template, read out of
 * `tokenizer.chat_template` in the checkpoint this repository's catalog pins. Keeping the rules
 * here rather than a golden string means a wire change is judged against the engine's real
 * contract instead of against today's output.
 */
function templateViolations(messages: { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }[]): string[] {
  const problems: string[] = [];
  const body = messages[0]?.role === 'system' ? messages.slice(1) : messages;
  // Only messages[0] may be a system turn; anywhere else the render loop rejects the role.
  for (const [index, message] of body.entries()) {
    if (!['user', 'assistant', 'tool'].includes(message.role)) {
      problems.push(`only user, assistant and tool roles are supported, got ${message.role} at ${index}`);
    }
    // An assistant turn must carry content or tool calls; empty-and-callless is rejected.
    if (message.role === 'assistant' && !message.content && !message.tool_calls?.length) {
      problems.push(`assistant turn at ${index} has neither content nor tool calls`);
    }
    // A non-string content skips the template's `is string` branch and reaches `content | length`,
    // which throws on null. Antimatter only ever has string content, so '' is the empty case.
    if (message.role === 'assistant' && typeof message.content !== 'string') {
      problems.push(`assistant turn at ${index} has ${message.content === null ? 'null' : 'non-string'} content`);
    }
  }
  // The parity counter skips tool results and tool-calling assistant turns entirely.
  let index = 0;
  for (const message of body) {
    const counted = message.role === 'user' || (message.role === 'assistant' && !message.tool_calls?.length);
    if (!counted) continue;
    if ((message.role === 'user') !== (index % 2 === 0)) {
      problems.push(`roles must alternate: ${message.role} at counted position ${index}`);
    }
    index += 1;
  }
  return problems;
}

/** Drives a real request and hands back the messages that went over the wire. */
async function postedMessages(messages: ChatRequest['messages']) {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  }) as typeof fetch;
  try {
    await new OpenAICompatibleProvider(config).chat({ ...request, messages });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return (body?.messages ?? []) as Parameters<typeof templateViolations>[0];
}

test('the template rejects the loop transcript that a strict engine 500s on', () => {
  // What the loop legitimately produces today, and what Mistral's template refuses to render.
  assert.deepEqual(templateViolations([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Check the build.' },
    { role: 'user', content: 'A chat message arrived.' },
  ]), ['roles must alternate: user at counted position 1']);
  assert.deepEqual(templateViolations([
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Round one.' },
    { role: 'assistant', content: 'Round two.' },
  ]), ['roles must alternate: assistant at counted position 2']);
  // This one alternates correctly; it is the empty assistant turn alone that is refused.
  assert.deepEqual(templateViolations([{ role: 'user', content: 'Hi' }, { role: 'assistant', content: '' }]),
    ['assistant turn at 1 has neither content nor tool calls']);
  assert.deepEqual(templateViolations([{ role: 'user', content: 'Hi' }, { role: 'system', content: 'Late.' }]),
    ['only user, assistant and tool roles are supported, got system at 1']);
  // Null content on a tool-calling turn reaches `content | length` and throws, so it is refused
  // even though the OpenAI schema permits it.
  assert.deepEqual(templateViolations([
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
  ]), ['assistant turn at 1 has null content']);
  // A clean alternating transcript, with tool traffic, is accepted.
  assert.deepEqual(templateViolations([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Check it.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'done' },
    { role: 'assistant', content: 'Checked.' },
    { role: 'user', content: 'Thanks.' },
  ]), []);
});

test('the wire canonicalizes a loop transcript into one a strict template renders', async () => {
  const messages = await postedMessages([
    { id: 'u1', role: 'user', content: 'Check the build.' },
    { id: 'b1', role: 'user', content: 'A chat message arrived.' },
    { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{}' } }] },
    { id: 't1', role: 'tool', toolCallId: 'c1', name: 'run', content: 'exit 0' },
    { id: 'a2', role: 'assistant', content: 'The build is green.' },
    { id: 'a3', role: 'assistant', content: 'Nothing else to report.' },
    { id: 'sys', role: 'system', content: 'Stay terse.' },
    { id: 'empty', role: 'assistant', content: '' },
    { id: 'n1', role: 'user', content: 'Now run the tests.' },
    { id: 'n2', role: 'user', content: 'Then stop.' },
  ]);

  assert.deepEqual(templateViolations(messages), [], 'the canonical form must satisfy the template');
  assert.deepEqual(messages, [
    { role: 'system', content: 'Stay terse.' },
    { role: 'user', content: 'Check the build.\n\nA chat message arrived.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'exit 0' },
    { role: 'assistant', content: 'The build is green.\n\nNothing else to report.' },
    { role: 'user', content: 'Now run the tests.\n\nThen stop.' },
  ]);
});

test('canonicalizing keeps every word, the tool pairing, and the system block', async () => {
  // A note separated from the previous user turn by only tool traffic still merges.
  const acrossTools = await postedMessages([
    { id: 'u1', role: 'user', content: 'First.' },
    { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{}' } }] },
    { id: 't1', role: 'tool', toolCallId: 'c1', name: 'run', content: 'out' },
    { id: 'b1', role: 'user', content: 'Background note.' },
  ]);
  assert.deepEqual(templateViolations(acrossTools), []);
  assert.equal(acrossTools[0].content, 'First.\n\nBackground note.');
  assert.equal(acrossTools[1].role, 'assistant');
  assert.equal(acrossTools[2].role, 'tool', 'a result still follows the call it answers');

  // Several system turns collapse into the single leading block the template can read.
  const manySystems = await postedMessages([
    { id: 's1', role: 'system', content: 'One.' },
    { id: 'u1', role: 'user', content: 'Hi.' },
    { id: 's2', role: 'system', content: 'Two.' },
  ]);
  assert.deepEqual(templateViolations(manySystems), []);
  assert.deepEqual(manySystems, [{ role: 'system', content: 'One.\n\nTwo.' }, { role: 'user', content: 'Hi.' }]);

  // The format has no way to say "assistant spoke before the user did".
  const leadingAssistant = await postedMessages([
    { id: 'a0', role: 'assistant', content: 'Greetings.' },
    { id: 'u1', role: 'user', content: 'Hi.' },
    { id: 'a1', role: 'assistant', content: 'Hello.' },
  ]);
  assert.deepEqual(templateViolations(leadingAssistant), []);
  assert.deepEqual(leadingAssistant, [{ role: 'user', content: 'Hi.' }, { role: 'assistant', content: 'Hello.' }]);

  // An ordinary alternating transcript is passed through untouched.
  const plain = await postedMessages([
    { id: 'u1', role: 'user', content: 'Hi.' },
    { id: 'a1', role: 'assistant', content: 'Hello.' },
    { id: 'u2', role: 'user', content: 'Bye.' },
  ]);
  assert.deepEqual(plain, [
    { role: 'user', content: 'Hi.' },
    { role: 'assistant', content: 'Hello.' },
    { role: 'user', content: 'Bye.' },
  ]);
});

test('a tool-calling turn carries an empty string, never null', async () => {
  const messages = await postedMessages([
    { id: 'u1', role: 'user', content: 'Run it.' },
    { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{}' } }] },
    { id: 't1', role: 'tool', toolCallId: 'c1', name: 'run', content: 'ok' },
  ]);
  assert.deepEqual(templateViolations(messages), []);
  assert.equal(messages[1].content, '', 'null here throws inside the template, before the model is reached');
  assert.notEqual(messages[1].content, null);
});

test('chat and stream pass their selected model and cancellation signal to managed admission before HTTP', async () => {
  const manager = ProviderManager.fromConfigs([config]);
  const controller = new AbortController();
  const calls: Array<[string, string | undefined, AbortSignal | undefined]> = [];
  manager.usePrepareProvider(async (id, model, signal) => {
    assert.equal(manager.busy(id), true);
    calls.push([id, model, signal]);
    throw new Error('admission refused');
  });
  const provider = manager.getProvider(config.id)!;
  await assert.rejects(provider.chat(request, controller.signal), /admission refused/);
  await assert.rejects(provider.stream(request, () => {}, undefined, controller.signal), /admission refused/);
  assert.deepEqual(calls, [[config.id, request.model, controller.signal], [config.id, request.model, controller.signal]]);
  assert.equal(manager.busy(config.id), false);
});
