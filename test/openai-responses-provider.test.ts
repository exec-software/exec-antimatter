import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenAIResponsesProvider } from '../src/api/providers/openaiResponses';
import type { ChatRequest, ProviderConfig, ToolCall } from '../src/api/types';

const config: ProviderConfig = {
  id: 'openai-native-test',
  name: 'OpenAI test source',
  apiKey: 'openai-test-key',
  baseUrl: 'https://api.openai.com/v1/',
  models: [{ id: 'gpt-test', name: 'GPT test' }],
  supportsStreaming: true,
};

const request: ChatRequest = {
  messages: [{ id: 'user-1', role: 'user', content: 'Use the available tool.' }],
  model: 'gpt-test',
  providerId: config.id,
  requestId: 'response-row-1',
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

async function withFetch<T>(
  implementation: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('writes native Responses input, tool history, tools, authentication, and instructions', async () => {
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
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Finished.' }],
          },
        ],
      });
    }) as typeof fetch,
    () =>
      new OpenAIResponsesProvider(config).chat({
        ...request,
        temperature: 0.25,
        maxTokens: 1200,
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
          { id: 'user-1', role: 'user', content: 'Read it.' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'I will inspect it.',
            toolCalls: [
              {
                id: 'call_read',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"/tmp/a"}' },
              },
            ],
          },
          {
            id: 'tool-1',
            role: 'tool',
            toolCallId: 'call_read',
            name: 'read_file',
            content: 'contents',
          },
          { id: 'user-2', role: 'user', content: 'Summarize.' },
        ],
      })
  );

  assert.equal(result, 'Finished.');
  assert.equal(observedUrl, 'https://api.openai.com/v1/responses');
  assert.equal(observedHeaders.get('authorization'), 'Bearer openai-test-key');
  assert.equal(observedRedirect, 'error');
  assert.equal(observedBody.instructions, 'Be exact.\n\nUse tools.');
  assert.equal(observedBody.max_output_tokens, 1200);
  assert.equal(observedBody.temperature, 0.25);
  assert.equal(observedBody.stream, false);
  assert.equal(observedBody.store, false);
  assert.deepEqual(observedBody.include, ['reasoning.encrypted_content']);
  assert.deepEqual(observedBody.input, [
    { role: 'user', content: 'Read it.' },
    { role: 'assistant', content: 'I will inspect it.' },
    {
      type: 'function_call',
      call_id: 'call_read',
      name: 'read_file',
      arguments: '{"path":"/tmp/a"}',
    },
    { type: 'function_call_output', call_id: 'call_read', output: 'contents' },
    { role: 'user', content: 'Summarize.' },
  ]);
  assert.deepEqual(observedBody.tools, [
    {
      type: 'function',
      name: 'read_file',
      description: 'Read a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ]);
});

test('uses a configured OpenCode Zen Responses base URL without changing protocols', async () => {
  let observedUrl = '';
  await withFetch(
    (async (input) => {
      observedUrl = String(input);
      return Response.json({ status: 'completed', output: [], output_text: 'Zen response.' });
    }) as typeof fetch,
    () =>
      new OpenAIResponsesProvider({
        ...config,
        id: 'opencode-zen-responses',
        name: 'OpenCode Zen (Responses)',
        baseUrl: 'https://opencode.ai/zen/v1',
      }).chat(request)
  );
  assert.equal(observedUrl, 'https://opencode.ai/zen/v1/responses');
});

test('assembles fragmented semantic text, reasoning, and function argument events exactly once', async () => {
  const frames = [
    ': keep-alive\r\n\r\n',
    `event: response.output_item.added\r\ndata: ${JSON.stringify({
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_write', name: 'write_file', arguments: '' },
    })}\r\n\r\n`,
    `event: response.output_text.delta\r\ndata: ${JSON.stringify({
      type: 'response.output_text.delta',
      output_index: 0,
      delta: 'hé',
    })}\r\n\r\n`,
    `data: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'Checked. ' })}\n\n`,
    `data: ${JSON.stringify({
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: 'fc_1',
      delta: '{"path":"',
    })}\n\n`,
    `data: ${JSON.stringify({
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: 'fc_1',
      delta: '/tmp/a"}',
    })}\n\n`,
    `data: ${JSON.stringify({
      type: 'response.function_call_arguments.done',
      output_index: 1,
      item_id: 'fc_1',
      arguments: '{"path":"/tmp/a"}',
    })}\n\n`,
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'hé' }] },
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_write',
            name: 'write_file',
            arguments: '{"path":"/tmp/a"}',
          },
        ],
      },
    })}\n\n`,
  ].join('');
  const unicodeStart = encoder.encode(frames.slice(0, frames.indexOf('é'))).length;
  const delivered: { content: string; reasoning?: string }[] = [];
  let alive = 0;

  const result = await withFetch(
    (async () => chunkedSse(frames, [1, 7, 53, unicodeStart + 1, encoder.encode(frames).length - 3])) as typeof fetch,
    () =>
      new OpenAIResponsesProvider(config).stream(
        request,
        (data) => delivered.push(data),
        () => {
          alive += 1;
        }
      )
  );

  // Reasoning streams on its own frames. A frame carrying both would put a deliberation in the
  // transcript as though the model had said it — see StreamCallback.
  assert.ok(
    delivered.every((frame) => !(frame.content && frame.reasoning)),
    'no frame may carry both an answer and the thinking behind it'
  );
  assert.deepEqual(
    delivered.filter((frame) => frame.content).map((frame) => frame.content),
    ['hé']
  );
  assert.equal(delivered.map((frame) => frame.reasoning ?? '').join(''), 'Checked. ');
  assert.equal(result.content, 'hé');
  assert.equal(result.reasoning, 'Checked. ');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, [
    {
      id: 'call_write',
      type: 'function',
      function: { name: 'write_file', arguments: '{"path":"/tmp/a"}' },
    },
  ] satisfies ToolCall[]);
  assert.ok(alive >= 8, `expected keepalive plus data-frame liveness, got ${alive}`);
});

test('accepts a non-stream JSON Response fallback with text and tool calls', async () => {
  const response = Response.json({
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'Calling.' }],
      },
      {
        type: 'function_call',
        call_id: 'call_shell',
        name: 'run_command',
        arguments: { command: 'pwd' },
      },
    ],
  });
  const streamed: string[] = [];
  const result = await withFetch(
    (async () => response) as typeof fetch,
    () => new OpenAIResponsesProvider(config).stream(request, ({ content }) => streamed.push(content))
  );

  assert.deepEqual(streamed.filter(Boolean), ['Calling.']);
  assert.equal(result.content, 'Calling.');
  assert.deepEqual(result.toolCalls, [
    {
      id: 'call_shell',
      type: 'function',
      function: { name: 'run_command', arguments: '{"command":"pwd"}' },
    },
  ] satisfies ToolCall[]);
});

test('replays opaque native reasoning output with tool results on the next round', async () => {
  const provider = new OpenAIResponsesProvider(config);
  let call = 0;
  let continuationBody: any;
  const first = await withFetch(
    (async (_input, init) => {
      call += 1;
      if (call === 1) {
        return Response.json({
          id: 'resp_reasoning',
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: 'rs_opaque',
              encrypted_content: 'opaque-reasoning-payload',
              summary: [],
            },
            {
              type: 'function_call',
              id: 'fc_shell',
              call_id: 'call_shell',
              name: 'run_command',
              arguments: '{"command":"pwd"}',
            },
          ],
        });
      }
      continuationBody = JSON.parse(String(init?.body));
      return Response.json({
        id: 'resp_final',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }],
      });
    }) as typeof fetch,
    async () => {
      const toolRound = await provider.stream(request, () => undefined);
      assert.deepEqual(toolRound.toolCalls.map((tool) => tool.id), ['call_shell']);
      const answer = await provider.stream(
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
              toolCallId: 'call_shell',
              name: 'run_command',
              content: '/workspace',
            },
          ],
        },
        () => undefined
      );
      return answer.content;
    }
  );

  assert.equal(first, 'Done.');
  assert.deepEqual(continuationBody.input, [
    { role: 'user', content: 'Use the available tool.' },
    {
      type: 'reasoning',
      id: 'rs_opaque',
      encrypted_content: 'opaque-reasoning-payload',
      summary: [],
    },
    {
      type: 'function_call',
      id: 'fc_shell',
      call_id: 'call_shell',
      name: 'run_command',
      arguments: '{"command":"pwd"}',
    },
    { type: 'function_call_output', call_id: 'call_shell', output: '/workspace' },
  ]);
});

test('preserves an incomplete Responses tool call as length for safe loop handling', async () => {
  const result = await withFetch(
    (async () =>
      Response.json({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          {
            type: 'function_call',
            call_id: 'call_cut',
            name: 'write_file',
            arguments: '{"path":"/tmp/a"',
          },
        ],
      })) as typeof fetch,
    () => new OpenAIResponsesProvider(config).stream(request, () => undefined)
  );
  assert.equal(result.finishReason, 'length');
});

test('surfaces streamed API errors and rejects malformed-only streams', async () => {
  const provider = new OpenAIResponsesProvider(config);
  await assert.rejects(
    withFetch(
      (async () =>
        chunkedSse(
          `event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: { message: 'rate limited', code: 'rate_limit_exceeded' },
          })}\n\n`
        )) as typeof fetch,
      () => provider.stream(request, () => undefined)
    ),
    /OpenAI test source stream failed: rate limited \(rate_limit_exceeded\)/
  );

  await assert.rejects(
    withFetch(
      (async () => chunkedSse('data: {bad json}\n\ndata: [DONE]\n\n')) as typeof fetch,
      () => provider.stream(request, () => undefined)
    ),
    /malformed streaming data without usable output/
  );

  await assert.rejects(
    withFetch(
      (async () =>
        chunkedSse(
          `event: error\ndata: ${JSON.stringify({
            type: 'error',
            message: 'top-level error',
            code: 'server_error',
          })}\n\n`
        )) as typeof fetch,
      () => provider.stream(request, () => undefined)
    ),
    /OpenAI test source stream failed: top-level error \(server_error\)/
  );
});

test('keeps usable output around a malformed frame and accepts multi-line SSE data', async () => {
  const response = chunkedSse(
    'data: {bad json}\n\n' +
      'event: response.output_text.delta\n' +
      'data: {"type":"response.output_text.delta",\n' +
      'data: "delta":"survived"}\n\n' +
      'data: [DONE]'
  );
  const result = await withFetch(
    (async () => response) as typeof fetch,
    () => new OpenAIResponsesProvider(config).stream(request, () => undefined)
  );
  assert.equal(result.content, 'survived');
});

test('rejects premature stream EOF before trusting an incomplete tool call', async () => {
  const response = chunkedSse(
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_partial',
        call_id: 'call_partial',
        name: 'write_file',
        arguments: '',
      },
    })}\n\n`
  );

  await assert.rejects(
    withFetch(
      (async () => response) as typeof fetch,
      () => new OpenAIResponsesProvider(config).stream(request, () => undefined)
    ),
    /stream ended before its completion event/
  );
});

test('forwards cancellation, standardizes aborts, and releases lifecycle tracking', async () => {
  const events: string[] = [];
  const controller = new AbortController();
  controller.abort();
  let calledFetch = false;
  const provider = new OpenAIResponsesProvider(
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
      return Response.json({ status: 'completed', output: [] });
    }) as typeof fetch,
    () => new OpenAIResponsesProvider(config).chat(request, liveController.signal)
  );
  assert.equal(observedSignal, liveController.signal);
});

test('reports actionable HTTP failures', async () => {
  await assert.rejects(
    withFetch(
      (async () =>
        new Response(JSON.stringify({ error: { message: 'bad model' } }), {
          status: 400,
          statusText: 'Bad Request',
        })) as typeof fetch,
      () => new OpenAIResponsesProvider(config).chat(request)
    ),
    /OpenAI test source refused the request: 400 Bad Request.*bad model/
  );

  await assert.rejects(
    withFetch(
      (async () => new Response('{not json', { headers: { 'content-type': 'application/json' } })) as typeof fetch,
      () => new OpenAIResponsesProvider(config).chat(request)
    ),
    /OpenAI test source returned malformed JSON/
  );

  await assert.rejects(
    withFetch(
      (async () =>
        new Response(`credential ${config.apiKey} was rejected`, {
          status: 401,
          statusText: `Unauthorized ${config.apiKey}`,
        })) as typeof fetch,
      () => new OpenAIResponsesProvider(config).chat(request)
    ),
    (error: Error) => {
      assert.match(error.message, /credential \[redacted\] was rejected/);
      assert.doesNotMatch(error.message, new RegExp(config.apiKey));
      return true;
    }
  );
});
