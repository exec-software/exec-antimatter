import assert from 'node:assert/strict';
import test from 'node:test';

import { AnthropicMessagesProvider } from '../src/api/providers/anthropicMessages';
import type { ChatRequest, ProviderConfig, ToolCall } from '../src/api/types';

const config: ProviderConfig = {
  id: 'anthropic-native-test',
  name: 'Anthropic test source',
  apiKey: 'anthropic-test-key',
  baseUrl: 'https://api.anthropic.com/',
  models: [{ id: 'claude-test', name: 'Claude test' }],
  supportsStreaming: true,
};

const request: ChatRequest = {
  messages: [{ id: 'user-1', role: 'user', content: 'Use the available tool.' }],
  model: 'claude-test',
  providerId: config.id,
  requestId: 'response-row-2',
};

const encoder = new TextEncoder();

function chunkedSse(source: string, cuts: number[] = []): Response {
  const bytes = encoder.encode(source);
  let start = 0;
  const chunks = [...cuts, bytes.length].map((end) => {
    const chunk = bytes.slice(start, end);
    start = end;
    return chunk;
  });
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
  );
}

async function withFetch<T>(implementation: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('writes native Messages history, tool results, tools, headers, and system prompt', async () => {
  let observedUrl = '';
  let observedHeaders = new Headers();
  let observedBody: any;
  let observedRedirect: RequestRedirect | undefined;
  const result = await withFetch(
    (async (input, init) => {
      observedUrl = String(input);
      observedHeaders = new Headers(init?.headers);
      observedBody = JSON.parse(String(init?.body));
      observedRedirect = init?.redirect;
      return Response.json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Finished.' }],
        stop_reason: 'end_turn',
      });
    }) as typeof fetch,
    () =>
      new AnthropicMessagesProvider(config).chat({
        ...request,
        temperature: 0.2,
        maxTokens: 2048,
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read a file.',
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
              },
            },
          },
        ],
        messages: [
          { id: 'system-1', role: 'system', content: 'Be exact.' },
          { id: 'system-2', role: 'system', content: 'Use tools.' },
          { id: 'user-1', role: 'user', content: 'Read both.' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'I will inspect them.',
            toolCalls: [
              {
                id: 'toolu_read_a',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"/tmp/a"}' },
              },
              {
                id: 'toolu_read_b',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"/tmp/b"}' },
              },
            ],
          },
          {
            id: 'tool-1',
            role: 'tool',
            toolCallId: 'toolu_read_a',
            name: 'read_file',
            content: 'A',
          },
          {
            id: 'tool-2',
            role: 'tool',
            toolCallId: 'toolu_read_b',
            name: 'read_file',
            content: 'B',
          },
          { id: 'user-2', role: 'user', content: 'Compare them.' },
        ],
      })
  );

  assert.equal(result, 'Finished.');
  assert.equal(observedUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(observedHeaders.get('x-api-key'), 'anthropic-test-key');
  assert.equal(observedHeaders.get('anthropic-version'), '2023-06-01');
  assert.equal(observedHeaders.get('authorization'), null);
  assert.equal(observedRedirect, 'error');
  // Sent as blocks, not a bare string, so the system prefix can carry a cache breakpoint.
  assert.deepEqual(observedBody.system, [
    { type: 'text', text: 'Be exact.\n\nUse tools.', cache_control: { type: 'ephemeral' } },
  ]);
  assert.equal(observedBody.max_tokens, 2048);
  assert.equal(observedBody.temperature, 0.2);
  assert.equal(observedBody.stream, false);
  assert.deepEqual(observedBody.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Read both.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will inspect them.' },
        { type: 'tool_use', id: 'toolu_read_a', name: 'read_file', input: { path: '/tmp/a' } },
        { type: 'tool_use', id: 'toolu_read_b', name: 'read_file', input: { path: '/tmp/b' },
          cache_control: { type: 'ephemeral' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_read_a', content: 'A' },
        { type: 'tool_result', tool_use_id: 'toolu_read_b', content: 'B' },
        { type: 'text', text: 'Compare them.' },
      ],
    },
  ]);
  assert.deepEqual(observedBody.tools, [
    {
      name: 'read_file',
      description: 'Read a file.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      // The last tool carries a breakpoint, so the schemas cache on their own: they are the
      // most stable part of the request and the slowest to re-read.
      cache_control: { type: 'ephemeral' },
    },
  ]);
});

test('repairs malformed legacy tool arguments before replaying assistant history', async () => {
  let observedBody: any;
  const malformed = '{"path":"/tmp/a"';
  await withFetch(
    (async (_input, init) => {
      observedBody = JSON.parse(String(init?.body));
      return Response.json({ content: [], stop_reason: 'end_turn' });
    }) as typeof fetch,
    () =>
      new AnthropicMessagesProvider(config).chat({
        ...request,
        messages: [
          request.messages[0],
          {
            id: 'assistant-broken',
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'toolu_broken',
                type: 'function',
                function: { name: 'read_file', arguments: malformed },
              },
            ],
          },
        ],
      })
  );
  assert.deepEqual(observedBody.messages[1].content[0].input._antimatter, {
    invalidToolArguments: true,
    reason: 'invalid_json',
    originalCharacters: malformed.length,
  });
});

test('assembles fragmented content blocks, UTF-8 text, thinking, and tool JSON', async () => {
  const frame = (event: string, payload: unknown) =>
    `event: ${event}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
  const wire = [
    frame('message_start', { type: 'message_start', message: { content: [], stop_reason: null } }),
    frame('ping', { type: 'ping' }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Checked. ' },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'hé' },
    }),
    frame('future_event', { type: 'future_event', ignored: true }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_write', name: 'write_file', input: {} },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"path":"' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '/tmp/a"}' },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 2 }),
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
    }),
    frame('message_stop', { type: 'message_stop' }),
  ].join('');
  const unicodeStart = encoder.encode(wire.slice(0, wire.indexOf('é'))).length;
  const frames: { content: string; reasoning?: string }[] = [];
  let alive = 0;
  const result = await withFetch(
    (async () => chunkedSse(wire, [2, 29, unicodeStart + 1, encoder.encode(wire).length - 2])) as typeof fetch,
    () =>
      new AnthropicMessagesProvider(config).stream(
        request,
        (data) => frames.push(data),
        () => {
          alive += 1;
        }
      )
  );

  // Thinking streams on its own frames. A frame carrying both would put a deliberation in the
  // transcript as though the model had said it — see StreamCallback.
  assert.ok(
    frames.every((frame) => !(frame.content && frame.reasoning)),
    'no frame may carry both an answer and the thinking behind it'
  );
  assert.deepEqual(
    frames.filter((frame) => frame.content).map((frame) => frame.content),
    ['hé']
  );
  assert.equal(frames.map((frame) => frame.reasoning ?? '').join(''), 'Checked. ');
  assert.equal(result.content, 'hé');
  assert.equal(result.reasoning, 'Checked. ');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, [
    {
      id: 'toolu_write',
      type: 'function',
      function: { name: 'write_file', arguments: '{"path":"/tmp/a"}' },
    },
  ] satisfies ToolCall[]);
  assert.ok(alive >= 14, `expected every Anthropic event to prove liveness, got ${alive}`);
});

test('accepts non-stream JSON fallback with text, thinking, tool use, and stop reason', async () => {
  const response = Response.json({
    type: 'message',
    content: [
      { type: 'thinking', thinking: 'I checked.' },
      { type: 'text', text: 'Use this.' },
      { type: 'tool_use', id: 'toolu_shell', name: 'run_command', input: { command: 'pwd' } },
    ],
    stop_reason: 'max_tokens',
  });
  const frames: { content: string; reasoning?: string }[] = [];
  const result = await withFetch(
    (async () => response) as typeof fetch,
    () => new AnthropicMessagesProvider(config).stream(request, (data) => frames.push(data))
  );
  assert.deepEqual(
    frames.filter((frame) => frame.content).map((frame) => frame.content),
    ['Use this.']
  );
  // A whole message arrives at once, and its thinking is still delivered apart from its answer.
  assert.equal(frames.map((frame) => frame.reasoning ?? '').join(''), 'I checked.');
  assert.equal(result.reasoning, 'I checked.');
  // Preserve truncation even when a partial tool call exists; the loop uses it to avoid executing
  // the last cut-off call and to salvage/retry safely.
  assert.equal(result.finishReason, 'length');
  assert.deepEqual(result.toolCalls, [
    {
      id: 'toolu_shell',
      type: 'function',
      function: { name: 'run_command', arguments: '{"command":"pwd"}' },
    },
  ] satisfies ToolCall[]);
});

test('replays signed native thinking blocks with tool results on the next round', async () => {
  const provider = new AnthropicMessagesProvider(config);
  let call = 0;
  let continuationBody: any;
  const answer = await withFetch(
    (async (_input, init) => {
      call += 1;
      if (call === 1) {
        return Response.json({
          type: 'message',
          content: [
            {
              type: 'thinking',
              thinking: 'I should inspect the directory.',
              signature: 'opaque-signature',
            },
            {
              type: 'tool_use',
              id: 'toolu_shell',
              name: 'run_command',
              input: { command: 'pwd' },
            },
          ],
          stop_reason: 'tool_use',
        });
      }
      continuationBody = JSON.parse(String(init?.body));
      return Response.json({
        type: 'message',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      });
    }) as typeof fetch,
    async () => {
      const toolRound = await provider.stream(request, () => undefined);
      const final = await provider.stream(
        {
          ...request,
          messages: [
            request.messages[0],
            {
              id: 'assistant-tools',
              role: 'assistant',
              content: '',
              toolCalls: toolRound.toolCalls,
            },
            {
              id: 'tool-result',
              role: 'tool',
              toolCallId: 'toolu_shell',
              name: 'run_command',
              content: '/workspace',
            },
          ],
        },
        () => undefined
      );
      return final.content;
    }
  );

  assert.equal(answer, 'Done.');
  assert.deepEqual(continuationBody.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Use the available tool.' }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'I should inspect the directory.',
          signature: 'opaque-signature',
        },
        {
          type: 'tool_use',
          id: 'toolu_shell',
          name: 'run_command',
          input: { command: 'pwd' },
          // The newest finished assistant turn carries the rolling cache breakpoint.
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_shell', content: '/workspace' }],
    },
  ]);
});

test('maps max_tokens to length when there is no tool call', async () => {
  const result = await withFetch(
    (async () =>
      Response.json({
        type: 'message',
        content: [{ type: 'text', text: 'Cut off' }],
        stop_reason: 'max_tokens',
      })) as typeof fetch,
    () => new AnthropicMessagesProvider(config).stream(request, () => undefined)
  );
  assert.equal(result.finishReason, 'length');
});

test('surfaces streamed API errors and rejects malformed-only streams', async () => {
  const provider = new AnthropicMessagesProvider(config);
  await assert.rejects(
    withFetch(
      (async () =>
        chunkedSse(
          `event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' },
          })}\n\n`
        )) as typeof fetch,
      () => provider.stream(request, () => undefined)
    ),
    /Anthropic test source stream failed: Overloaded \(overloaded_error\)/
  );
  await assert.rejects(
    withFetch(
      (async () => chunkedSse('event: ping\ndata: {bad json}\n\n')) as typeof fetch,
      () => provider.stream(request, () => undefined)
    ),
    /malformed streaming data without usable output/
  );
});

test('rejects premature stream EOF before trusting an incomplete tool call', async () => {
  const response = chunkedSse(
    `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_partial',
        name: 'write_file',
        input: {},
      },
    })}\n\n`
  );

  await assert.rejects(
    withFetch(
      (async () => response) as typeof fetch,
      () => new AnthropicMessagesProvider(config).stream(request, () => undefined)
    ),
    /stream ended before its completion event/
  );
});

test('forwards cancellation, standardizes aborts, and releases lifecycle tracking', async () => {
  const events: string[] = [];
  const controller = new AbortController();
  controller.abort();
  let calledFetch = false;
  const provider = new AnthropicMessagesProvider(
    config,
    () => {
      events.push('busy');
      return () => events.push('idle');
    },
    async () => {
      events.push('prepare');
      return undefined;
    }
  );
  await assert.rejects(
    withFetch(
      (async () => {
        calledFetch = true;
        throw new Error('fetch should not run');
      }) as typeof fetch,
      () => provider.stream(request, () => undefined, undefined, controller.signal)
    ),
    /the turn was stopped/
  );
  assert.equal(calledFetch, false);
  assert.deepEqual(events, ['busy', 'prepare', 'idle']);

  const liveController = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  await withFetch(
    (async (_input, init) => {
      observedSignal = init?.signal;
      return Response.json({ content: [], stop_reason: 'end_turn' });
    }) as typeof fetch,
    () => new AnthropicMessagesProvider(config).chat(request, liveController.signal)
  );
  assert.equal(observedSignal, liveController.signal);
});

test('reports actionable HTTP failures', async () => {
  await assert.rejects(
    withFetch(
      (async () =>
        new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad model' } }), {
          status: 400,
          statusText: 'Bad Request',
        })) as typeof fetch,
      () => new AnthropicMessagesProvider(config).chat(request)
    ),
    /Anthropic test source refused the request: 400 Bad Request.*bad model/
  );

  await assert.rejects(
    withFetch(
      (async () => new Response('{not json', { headers: { 'content-type': 'application/json' } })) as typeof fetch,
      () => new AnthropicMessagesProvider(config).chat(request)
    ),
    /Anthropic test source returned malformed JSON/
  );

  await assert.rejects(
    withFetch(
      (async () =>
        new Response(`credential ${config.apiKey} was rejected`, {
          status: 401,
          statusText: `Unauthorized ${config.apiKey}`,
        })) as typeof fetch,
      () => new AnthropicMessagesProvider(config).chat(request)
    ),
    (error: Error) => {
      assert.match(error.message, /credential \[redacted\] was rejected/);
      assert.doesNotMatch(error.message, new RegExp(config.apiKey));
      return true;
    }
  );
});

test('a native reply over the cap stops the stream and never replays the calls it refused', async () => {
  const provider = new AnthropicMessagesProvider(config);
  const block = (index: number) =>
    `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: `toolu_${index}`, name: 'read_file', input: { path: `f${index}.ts` } },
    })}\n\n`;

  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Deliberately never ends: a runaway batch is only bounded by the output limit, so the
      // only thing that can stop this is the cap closing the connection.
      controller.enqueue(encoder.encode(block(pulled)));
      pulled += 1;
    },
    cancel() {
      cancelled = true;
    },
  });

  let continuationBody: any;
  let call = 0;
  const result = await withFetch(
    (async (_input, init) => {
      call += 1;
      if (call === 1) {
        return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      }
      continuationBody = JSON.parse(String(init?.body));
      return Response.json({ type: 'message', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' });
    }) as typeof fetch,
    async () => {
      const toolRound = await provider.stream({ ...request, maxToolCalls: 3 }, () => undefined);
      await provider.stream(
        {
          ...request,
          messages: [
            request.messages[0],
            { id: 'assistant-tools', role: 'assistant', content: '', toolCalls: toolRound.toolCalls },
            ...toolRound.toolCalls.map((tool) => ({
              id: `result-${tool.id}`,
              role: 'tool' as const,
              toolCallId: tool.id,
              name: 'read_file',
              content: 'contents',
            })),
          ],
        },
        () => undefined
      );
      return toolRound;
    }
  );

  assert.equal(result.toolCalls.length, 3);
  assert.equal(result.toolCallsCutOff, true);
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(cancelled, true, 'an endless batch is only stopped by closing the body');

  // The native replay must carry exactly the calls that were answered. A refused one here would
  // be a tool_use with no tool_result, which the API rejects for the rest of the conversation.
  const assistant = continuationBody.messages.find((message: any) => message.role === 'assistant');
  assert.deepEqual(
    assistant.content.map((entry: any) => entry.id),
    ['toolu_0', 'toolu_1', 'toolu_2']
  );
});
