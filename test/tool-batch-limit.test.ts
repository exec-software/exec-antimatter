import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatRequest, Message, StreamResult, ToolCall } from '../src/api/types';
import { fitToBudget, promptBudget } from '../src/main/context';
import { MAX_CALLS_PER_MESSAGE, runToolLoop, type StreamingProvider, type ToolRuntime } from '../src/main/toolLoop';

const request: ChatRequest = { messages: [], model: 'm', providerId: 'p' };

const reads = (count: number): ToolCall[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `call_${index}`,
    type: 'function' as const,
    function: { name: 'antimatter__read_file', arguments: JSON.stringify({ path: `src/file${index}.ts` }) },
  }));

/** One reply asking for `count` reads, then a plain answer. */
function turn(count: number, resultText = 'x'.repeat(2_000)) {
  return replies(
    [
      { content: 'Let me look around.', toolCalls: reads(count) },
      { content: 'Done.', toolCalls: [] },
    ],
    resultText
  );
}

/** A provider that answers with each of `results` in turn, and a runtime that records the reads. */
function replies(results: StreamResult[], resultText = 'x'.repeat(2_000)) {
  const ran: string[] = [];
  const asked: (number | undefined)[] = [];
  const queue = [...results];
  const provider: StreamingProvider = {
    stream: async (chatRequest) => {
      asked.push(chatRequest.maxToolCalls);
      return queue.shift() ?? { content: 'Done.', toolCalls: [] };
    },
  };
  const runtime: ToolRuntime = {
    enabledTools: () => [
      {
        serverId: 'antimatter',
        serverName: 'Antimatter tools',
        tool: { name: 'read_file', description: 'Read.', inputSchema: { type: 'object', properties: {} }, enabled: true },
      },
    ],
    async callTool(_server, _name, args) {
      ran.push(String(args.path));
      return { ok: true, text: resultText };
    },
  };
  return { provider, runtime, ran, asked };
}

const run = (model: ReturnType<typeof turn>, overrides: Partial<ChatRequest> = {}) =>
  runToolLoop({
    provider: model.provider,
    toolRuntime: model.runtime,
    request: { ...request, ...overrides },
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

test('a batch within the cap runs untouched', async () => {
  const model = turn(MAX_CALLS_PER_MESSAGE);
  const result = await run(model);
  assert.equal(model.ran.length, MAX_CALLS_PER_MESSAGE);
  assert.equal(result.transcript.some((m) => m.id.startsWith('deferred_')), false);
});

test('an oversized batch runs only the cap and says it was cut', async () => {
  // The observed failure: 1,363 read_file calls in one reply.
  const model = turn(1_363);
  const result = await run(model);
  assert.equal(model.ran.length, MAX_CALLS_PER_MESSAGE);

  const note = result.transcript.find((m) => m.id.startsWith('deferred_'));
  assert.ok(note, 'the model is told, or it carries on as though the whole batch ran');
  assert.match(note.content, /more than 32 tool calls/);
  assert.match(note.content, /cut off after 32/);
});

test('the cap goes down with the request, so the provider can stop the stream at it', async () => {
  const model = turn(4);
  await run(model, { maxToolCalls: 16 });
  assert.deepEqual(model.asked, [16, 16], 'every round carries the model, not a constant');
});

test('a model with a narrower profile is held to it', async () => {
  const model = turn(40);
  const result = await run(model, { maxToolCalls: 16 });
  assert.equal(model.ran.length, 16);
  const note = result.transcript.find((m) => m.id.startsWith('deferred_'));
  assert.match(note!.content, /more than 16 tool calls/);
});

test('a stream the provider cut is reported even though nothing needed trimming', async () => {
  // The ordinary case once the cap is enforced on the wire: exactly the cap arrives, and the
  // only evidence that more was coming is the provider's flag.
  const model = replies([
    { content: '', toolCalls: reads(MAX_CALLS_PER_MESSAGE), toolCallsCutOff: true },
    { content: 'Done.', toolCalls: [] },
  ]);
  const result = await run(model);
  const note = result.transcript.find((m) => m.id.startsWith('deferred_'));
  assert.ok(note, 'a cut the loop did not have to make still has to be explained');
  assert.match(note.content, /cut off after 32/);
});

test('a model that floods three rounds running is stopped rather than left going', async () => {
  // What made this look like a hang: told its batch was cut, the model emitted another.
  const model = replies(
    Array.from({ length: 8 }, () => ({ content: '', toolCalls: reads(200) })),
    'x'
  );
  const result = await run(model, { maxToolCalls: 4 });
  // Its own reason, not 'stalled': a repeating model is looking in the wrong place, and what
  // the person is told to do about it is not the same thing.
  assert.equal(result.reason, 'flooding');
  assert.equal(result.rounds, 3, 'three overruns in a row, not the whole round allowance');
  assert.equal(model.ran.length, 12);
});

test('an overrun run of rounds resets when the model comes back inside the cap', async () => {
  const model = replies([
    { content: '', toolCalls: reads(200) },
    { content: '', toolCalls: reads(200) },
    { content: '', toolCalls: reads(2) },
    { content: '', toolCalls: reads(200) },
    { content: '', toolCalls: reads(200) },
    { content: 'Done.', toolCalls: [] },
  ], 'x');
  const result = await run(model, { maxToolCalls: 4 });
  assert.equal(result.reason, 'finished', 'two overruns either side of a good round is not a loop');
});

test('the transcript stays protocol-valid: every recorded call has exactly one result', async () => {
  const model = turn(1_363);
  const result = await run(model);
  const assistant = result.transcript.find((m) => m.toolCalls?.length);
  assert.ok(assistant);
  const callIds = assistant.toolCalls!.map((call) => call.id);
  const resultIds = result.transcript.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
  assert.equal(callIds.length, MAX_CALLS_PER_MESSAGE, 'calls that never ran must not be in the transcript');
  assert.deepEqual(resultIds.sort(), callIds.sort());
});

test('the capped group fits a window that the uncapped one could not', async () => {
  // Reproduces why this matters: the newest group is mandatory, so if it alone exceeds the
  // budget the fit has nothing left to drop and the request overflows however much it compacts.
  const group = (count: number): Message[] => [
    { id: 'a', role: 'assistant', content: '', toolCalls: reads(count) },
    ...reads(count).map((call) => ({
      id: call.id,
      role: 'tool' as const,
      toolCallId: call.id,
      name: 'read_file',
      content: 'x'.repeat(2_000),
    })),
  ];
  const profile = {
    modelId: 'm',
    contextTokens: 131_072,
    maxOutputTokens: 32_768,
    contextSource: 'server' as const,
    outputSource: 'server' as const,
    compaction: 'summarize' as const,
  };
  const budget = promptBudget(profile, []);

  const uncapped = fitToBudget(group(1_363), budget);
  assert.ok(uncapped.overflowTokens > 0, 'the uncapped group overflows even after compaction');

  const capped = fitToBudget(group(MAX_CALLS_PER_MESSAGE), budget);
  assert.equal(capped.overflowTokens, 0, 'the capped group fits, so the window can roll');
});
