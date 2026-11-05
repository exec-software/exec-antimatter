import assert from 'node:assert/strict';
import { join } from 'node:path';
import { OpenAICompatibleProvider } from '../../src/api/providers/openai';
import type { ChatRequest, Message, ProviderConfig } from '../../src/api/types';
import { fitToBudget, promptBudget } from '../../src/main/context';
import { prepareInteractiveRequest } from '../../src/main/interactiveRequest';
import { renderInstructions } from '../../src/main/memory/context';
import * as profiles from '../../src/main/modelProfiles';
import { withSituation } from '../../src/main/prompt';
import { runToolLoop } from '../../src/main/toolLoop';
import * as transcripts from '../../src/main/transcripts';
import type captured from './hag-generated-history.json';

const reasoning = 'SEPARATE REASONING MUST NOT BECOME HISTORY';
interface TurnRecord {
  turn: number;
  requestId: string;
  resumed: boolean;
  maxTokens: number;
  wire: Record<string, unknown> | null;
  transportFragments: number;
  contentChunks: string[];
  reasoning: string;
  completionReleased: boolean;
  completed: boolean;
  settled: boolean;
  outcome: 'finished' | 'cancelled' | 'error' | null;
  error: string | null;
  checkpointed: number;
  cancelRequests: number;
  abortObserved: boolean;
  bodyCancelled: boolean;
  transportClosed: boolean;
  abortListenerRemoved: boolean;
  failureInjected: boolean;
  result: { reason: string; rounds: number; toolCalls: number; content: string } | null;
}

/** Production request/provider path with an in-process transport fixture and no connected tools. */
export function createProviderHost(
  directory: string,
  source: ProviderConfig,
  fixture: typeof captured,
  send: (channel: string, payload: unknown) => void,
  interruptFirst: 'cancel' | 'error' | null = null,
) {
  profiles.useConfigPath(join(directory, 'profiles.json'));
  transcripts.useRoot(join(directory, 'transcripts'));
  profiles.setOverride(source.id, source.models[0].id, {
    contextTokens: 2048, maxOutputTokens: 128, compaction: 'drop',
  });
  const profile = profiles.withEngineContext(profiles.resolve({
    providerId: source.id, modelId: source.models[0].id, serverContextTokens: 2048,
  }), 2048);
  assert.equal(profile.contextTokens, 2048); assert.equal(profile.maxOutputTokens, 128);
  const provider = new OpenAICompatibleProvider({ ...source, apiKey: '' });
  const records: TurnRecord[] = [];
  const controllers = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
  const emitted = new Set<number>();
  const aborters = new Map<string, AbortController>();
  const cleanups = new Map<number, () => void>();
  let active: TurnRecord | null = null;
  const originalFetch = globalThis.fetch;
  // Never delegate to real fetch: an unexpected request fails this isolated host.
  globalThis.fetch = async (input, init) => {
    assert.ok(active, 'fetch must belong to an active fixture turn');
    assert.equal(String(input), `${source.baseUrl}/chat/completions`);
    assert.equal(init?.method, 'POST');
    assert.equal(active.wire, null, 'exactly one provider request per turn');
    const { temperature: _temperature, ...expected } = structuredClone(fixture.turns[active.turn].request);
    if (interruptFirst && active.turn === 1) {
      const partial = fixture.turns[0].response.choices[0].message.content.slice(0, -1);
      const suffix = interruptFirst === 'cancel' ? '\n\n_Stopped._'
        : `\n\nError: ${source.name} stream failed: fixture stream failure (fixture_error)`;
      // resume() recovers the visible suffix as another assistant row; wireMessages
      // coalesces adjacent assistant rows with its own separator.
      expected.messages.find((message) => message.role === 'assistant')!.content = partial + '\n\n' + suffix;
    }
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { ...expected, stream: true });
    active.wire = body;
    const record = active, turn = active.turn;
    assert.ok(init?.signal && !init.signal.aborted, 'the loop must pass a live abort signal to fetch');
    const signal = init.signal;
    const cleanup = () => { signal.removeEventListener('abort', abort); record.abortListenerRemoved = true; };
    const abort = () => {
      record.abortObserved = true; record.transportClosed = true;
      cleanup(); controllers.get(turn)!.error(new DOMException('fixture request aborted', 'AbortError'));
    };
    cleanups.set(turn, cleanup);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controllers.set(turn, controller); signal.addEventListener('abort', abort, { once: true }); },
      cancel() { record.bodyCancelled = true; record.transportClosed = true; cleanup(); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };

  const write = (turn: number, text: string) => {
    const record = records.find((entry) => entry.turn === turn)!;
    const controller = controllers.get(turn);
    assert.ok(controller, 'provider transport must be ready');
    const bytes = new TextEncoder().encode(text);
    // Split both the SSE prefix and JSON payload across transport reads.
    for (const chunk of [bytes.slice(0, 2), bytes.slice(2, 17), bytes.slice(17)]) {
      if (chunk.length) { controller.enqueue(chunk); record.transportFragments++; }
    }
  };
  const frame = (turn: number, delta: Record<string, unknown>, finishReason: string | null = null) =>
    write(turn, `data: ${JSON.stringify({ model: source.models[0].id,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(finishReason ? { usage: fixture.turns[turn].response.usage } : {}) })}\n\n`);

  return {
    records,
    idle: () => active === null && aborters.size === 0,
    ready: (turn: number) => controllers.has(turn),
    emitContent(turn: number) {
      assert.ok(!emitted.has(turn), 'content may only be released once'); emitted.add(turn);
      frame(turn, { role: 'assistant' });
      frame(turn, { reasoning_content: reasoning });
      const full = fixture.turns[turn].response.choices[0].message.content;
      const raw = interruptFirst && turn === 0 ? full.slice(0, -1) : full;
      for (const content of [raw.slice(0, 3), raw.slice(3, 14), raw.slice(14)]) frame(turn, { content });
    },
    complete(turn: number) {
      const record = records.find((entry) => entry.turn === turn)!;
      assert.ok(emitted.has(turn) && !record.completionReleased && !record.completed);
      assert.equal(record.contentChunks.join(''), fixture.turns[turn].response.choices[0].message.content);
      record.completionReleased = true;
      frame(turn, {}, 'stop');
      write(turn, 'data: [DONE]\n\n');
      controllers.get(turn)!.close();
      record.transportClosed = true; cleanups.get(turn)!();
    },
    cancel(runId: string) {
      const controller = aborters.get(runId);
      if (!controller || active?.requestId !== runId) return false;
      active.cancelRequests++; controller.abort(); return true;
    },
    fail(turn: number) {
      const record = records.find((entry) => entry.turn === turn)!;
      assert.ok(interruptFirst === 'error' && turn === 0 && emitted.has(turn) && !record.failureInjected);
      record.failureInjected = true;
      // Leave the body open: the real provider must reject this SSE envelope and cancel it.
      write(turn, 'event: error\ndata: {"error":{"message":"fixture stream failure","code":"fixture_error"}}\n\n');
    },
    async stream(request: ChatRequest, turn: number) {
      assert.equal(active, null, 'fixture turns must run sequentially');
      assert.ok(request.requestId && request.threadId);
      const resumed = transcripts.resume(request.threadId, request.messages);
      assert.equal(resumed !== null, turn === 1, 'turn two must resume the production transcript');
      if (interruptFirst && turn === 1) {
        const partial = fixture.turns[0].response.choices[0].message.content.slice(0, -1);
        const assistants = resumed!.filter((message) => message.role === 'assistant');
        assert.deepEqual(assistants.map((message) => message.content), [partial, request.messages[1].content.slice(partial.length)]);
      }
      const instructions = 'Use the existing project conventions.\n'.repeat(60).slice(0, 2048);
      const mode = request.accessMode ?? 'ask';
      const system = withSituation(renderInstructions([{
        path: '/fixture/AGENTS.md', label: 'AGENTS.md', content: instructions, length: instructions.length,
      }]), { workspace: '/fixture', workspaceConfirmed: true, mode, tools: [], maxOutputTokens: profile.maxOutputTokens });
      assert.equal(system, fixture.turns[turn].request.messages[0].content);
      const prepared = prepareInteractiveRequest(request, resumed ?? request.messages, system, profile, promptBudget(profile, []));
      assert.equal(prepared.fit.compacted, 0); assert.equal(prepared.fit.overflowTokens, 0);
      const record: TurnRecord = { turn, requestId: request.requestId, resumed: resumed !== null,
        maxTokens: prepared.request.maxTokens, wire: null, transportFragments: 0,
        contentChunks: [], reasoning: '', completionReleased: false, completed: false, result: null,
        settled: false, outcome: null, error: null, checkpointed: 0, cancelRequests: 0,
        abortObserved: false, bodyCancelled: false, transportClosed: false, abortListenerRemoved: false, failureInjected: false };
      records.push(record); active = record;
      const controller = new AbortController(); aborters.set(request.requestId, controller);
      const remember = (messages: Message[]) => {
        transcripts.remember(request.threadId!, messages,
          [...request.messages.map((message) => message.id), request.responseMessageId!],
          [[request.responseMessageId!, record.contentChunks.join('')]]);
        record.checkpointed++;
      };
      try {
        const result = await runToolLoop({
          provider, request: prepared.request, runId: request.requestId, mode, signal: controller.signal,
          toolRuntime: { enabledTools: () => [], callTool: async () => assert.fail('no tool dispatch expected') },
          fit: (messages, tools) => fitToBudget(messages, promptBudget(profile, tools)),
          onContent: (content) => { record.contentChunks.push(content); send('chat:stream-data', { id: request.requestId, content }); },
          onReasoning: (content) => { record.reasoning += content; send('chat:reasoning', { id: request.requestId, content }); },
          onTranscript: remember,
          onActivity: () => assert.fail('no tools are connected'),
          requestApproval: async () => assert.fail('no approval expected'),
        });
        assert.equal(record.completionReleased, true, 'the loop must wait for terminal SSE');
        assert.equal(result.reason, 'finished'); assert.equal(result.rounds, 1); assert.equal(result.toolCalls, 0);
        assert.equal(result.content, fixture.turns[turn].response.choices[0].message.content);
        assert.equal(record.contentChunks.length, 3); assert.equal(record.contentChunks.join(''), result.content);
        assert.equal(record.reasoning, reasoning);
        assert.equal(result.transcript.at(-1)?.content, result.content);
        // Match the visible aliases used by streamChat; internal loop IDs differ from UI IDs.
        remember(result.transcript);
        record.result = { reason: result.reason, rounds: result.rounds, toolCalls: result.toolCalls, content: result.content };
        record.completed = true; record.outcome = 'finished';
      } catch (error) {
        const detail = (error as Error).message;
        record.error = detail;
        // Mirror streamChat's thin boundary: Stop resolves with a marker; provider failures
        // reject so App appends its error. Partial transcript persistence comes from the loop.
        if (interruptFirst && turn === 0 && record.checkpointed > 0) {
          assert.equal(record.contentChunks.join(''), fixture.turns[0].response.choices[0].message.content.slice(0, -1));
          assert.equal(record.completionReleased, false);
          if (interruptFirst === 'cancel' && controller.signal.aborted) {
            assert.equal((error as Error).name, 'AbortError');
            assert.equal(record.abortObserved, true);
            record.outcome = 'cancelled';
            send('chat:stream-data', { id: request.requestId, content: '\n\n_Stopped._' });
            return;
          }
          if (interruptFirst === 'error' && record.failureInjected
              && detail === `${source.name} stream failed: fixture stream failure (fixture_error)`) {
            assert.equal(record.bodyCancelled, true);
            record.outcome = 'error';
          }
        }
        throw error;
      } finally {
        cleanups.get(turn)?.(); aborters.delete(request.requestId); active = null; record.settled = true;
      }
    },
    dispose() { globalThis.fetch = originalFetch; },
  };
}
