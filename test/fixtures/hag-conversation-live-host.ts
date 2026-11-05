import assert from 'node:assert/strict';
import { join } from 'node:path';
import { OpenAICompatibleProvider } from '../../src/api/providers/openai';
import type { ChatRequest, Message, ProviderConfig, StreamResult } from '../../src/api/types';
import { fitToBudget, promptBudget } from '../../src/main/context';
import { prepareInteractiveRequest } from '../../src/main/interactiveRequest';
import { renderInstructions } from '../../src/main/memory/context';
import * as profiles from '../../src/main/modelProfiles';
import { withSituation } from '../../src/main/prompt';
import { runToolLoop, type InferenceRoundMetrics } from '../../src/main/toolLoop';
import * as transcripts from '../../src/main/transcripts';
import type captured from './hag-generated-history.json';

const REQUEST_DEADLINE_MS = 240_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
export type LiveFixture = { turns: Array<{
  request: Omit<typeof captured.turns[number]['request'], 'temperature'> & { temperature?: number };
  response: typeof captured.turns[number]['response'] | null;
}> };
export type LiveMode = 'history' | 'stop-reuse';

/** Hidden thinking markup alone is not visible content eligible for Stop. */
export function hasVisibleCount(content: string): boolean {
  return /\d/.test(content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, ''));
}

/** Require an explicitly forwarded local listener; never resolve a hostname or follow redirects. */
export function validateLiveBaseUrl(baseUrl: string): string {
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/v1$/, 'live endpoint must be http://127.0.0.1:PORT/v1');
  const port = Number(new URL(baseUrl).port);
  // URL normalizes the default HTTP port away, so reject that ambiguous spelling too.
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'live endpoint requires an explicit non-default port');
  return baseUrl;
}

export interface LiveTurnRecord {
  turn: number;
  requestId: string;
  request: ChatRequest;
  resumed: boolean;
  maxTokens: number;
  wire: Record<string, unknown> | null;
  attemptCount: number;
  providerCalls: number;
  transportFragments: number;
  transportBytes: number;
  responseStatus: number | null;
  contentType: string | null;
  transport: 'json' | 'sse' | null;
  rawResponse: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  finishReason: string | null;
  servedModel: string | null;
  providerResult: StreamResult | null;
  metrics: InferenceRoundMetrics[];
  contentChunks: string[];
  reasoning: string;
  completed: boolean;
  settled: boolean;
  outcome: 'finished' | 'cancelled' | 'error' | null;
  error: string | null;
  checkpointed: number;
  cancelRequests: number;
  firstContentAt: number | null;
  cancelRequestedAt: number | null;
  abortObserved: boolean;
  abortObservedAt: number | null;
  abortListenerRemoved: boolean;
  transportClosedAt: number | null;
  timedOut: boolean;
  bodyCancelled: boolean;
  transportClosed: boolean;
  responseEof: boolean;
  startedAt: number;
  settledAt: number | null;
  deadlineMs: number;
  result: { reason: string; rounds: number; toolCalls: number; content: string } | null;
}

/**
 * Real HTTP through the production preparation/provider/tool-loop path. The caller supplies
 * a running, independently supervised server. This host cannot start one or connect tools.
 */
export function createLiveProviderHost(
  directory: string,
  source: ProviderConfig,
  fixture: LiveFixture,
  send: (channel: string, payload: unknown) => void,
  mode: LiveMode = 'history',
) {
  const baseUrl = validateLiveBaseUrl(source.baseUrl);
  const endpoint = `${baseUrl}/chat/completions`;
  assert.equal(source.kind, 'beholdd');
  assert.equal(source.protocol, 'openai-chat');
  assert.equal(source.models.length, 1);
  assert.equal(fixture.turns.length, 2);
  assert.equal(source.models[0].id, fixture.turns[0].request.model);
  const model = source.models[0].id;
  assert.ok(mode === 'history' || mode === 'stop-reuse');
  const stopReuse = mode === 'stop-reuse';
  assert.deepEqual(fixture.turns.map((turn) => turn.request.max_tokens), stopReuse ? [64, 16] : [128, 128]);
  assert.ok(fixture.turns[1].response, 'the successful reuse reply needs an oracle');
  if (stopReuse) assert.equal(fixture.turns[0].response, null, 'the cancelled request has no response oracle');
  else assert.ok(fixture.turns[0].response);
  profiles.useConfigPath(join(directory, 'profiles.json'));
  transcripts.useRoot(join(directory, 'transcripts'));
  const turnProfile = (turn: number) => {
    const maxOutputTokens = fixture.turns[turn].request.max_tokens;
    profiles.setOverride(source.id, model, { contextTokens: 2048, maxOutputTokens, compaction: 'drop' });
    const profile = profiles.withEngineContext(profiles.resolve({
      providerId: source.id, modelId: model, serverContextTokens: 2048,
    }), 2048);
    assert.equal(profile.contextTokens, 2048);
    assert.equal(profile.maxOutputTokens, maxOutputTokens);
    return profile;
  };
  // No prepare callback: source lifecycle/automatic model launch is outside this fixture.
  const provider = new OpenAICompatibleProvider({ ...source, apiKey: '' });
  const records: LiveTurnRecord[] = [];
  const aborters = new Map<string, AbortController>();
  const originalFetch = globalThis.fetch;
  let active: LiveTurnRecord | null = null;
  let attempts = 0, failed = false, disposed = false;

  const fetchLive: typeof fetch = async (input, init) => {
    assert.ok(!disposed && !failed && active, 'fetch must belong to an active live turn');
    const record = active;
    attempts++;
    record.attemptCount++;
    // Guard before the socket opens, including loading retries and /models probes.
    assert.ok(attempts <= 2 && record.attemptCount === 1, 'exactly one HTTP attempt is allowed per turn');
    assert.equal(String(input), endpoint, 'unexpected live HTTP destination');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal && !init.signal.aborted, 'live fetch needs the turn abort signal');
    assert.equal(record.wire, null);
    const { temperature: _temperature, ...expected } = structuredClone(fixture.turns[record.turn].request);
    if (record.turn === 1 && !stopReuse) {
      assert.ok(records[0].completed && records[0].result, 'turn two requires an observed successful first reply');
      expected.messages.find((message) => message.role === 'assistant')!.content = records[0].result.content;
    }
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body, { ...expected, stream: true }, 'live provider wire contract changed');
    record.wire = body;
    const signal = init.signal;
    const onAbort = () => { record.abortObserved = true; record.abortObservedAt = Date.now(); };
    signal.addEventListener('abort', onAbort, { once: true });
    const removeAbortListener = () => {
      signal.removeEventListener('abort', onAbort);
      record.abortListenerRemoved = true;
    };
    let response: Response;
    try { response = await originalFetch(input, init); }
    catch (error) { removeAbortListener(); throw error; }
    record.responseStatus = response.status;
    record.contentType = response.headers.get('content-type');
    record.transport = record.contentType?.toLowerCase().includes('text/event-stream') ? 'sse' : 'json';
    assert.ok(response.body, 'live response must have a body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      record.rawResponse += decoder.decode();
      record.transportClosed = true;
      record.transportClosedAt = Date.now();
      removeAbortListener();
      reader.releaseLock();
    };
    // Capture the same bounded bytes the provider consumes, without an unconsumed tee branch.
    const observed = new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            record.responseEof = true;
            close();
            controller.close();
            return;
          }
          record.transportFragments++;
          record.transportBytes += next.value.byteLength;
          if (record.transportBytes > MAX_RESPONSE_BYTES) {
            await reader.cancel('live response exceeded 1 MiB byte limit');
            record.bodyCancelled = true;
            throw new Error('live response exceeded 1 MiB byte limit');
          }
          record.rawResponse += decoder.decode(next.value, { stream: true });
          controller.enqueue(next.value);
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      async cancel(reason) {
        record.bodyCancelled = true;
        try { await reader.cancel(reason); } finally { close(); }
      },
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
    if (!response.ok) {
      // Reject here so beholdd's normal cold-load retry policy cannot issue another request.
      await observed.text();
      throw new Error(`live endpoint returned HTTP ${response.status}`);
    }
    assert.ok(record.contentType && /^(application\/json|text\/event-stream)(?:\s*;|$)/i.test(record.contentType),
      'unsupported live response content type');
    return observed;
  };
  globalThis.fetch = fetchLive;

  const verifyTransport = (record: LiveTurnRecord) => {
    const payloads: any[] = [];
    if (record.transport === 'json') payloads.push(JSON.parse(record.rawResponse));
    else {
      let sentDone = 0;
      for (const line of record.rawResponse.split('\n')) {
        if (!line.trim().startsWith('data:')) continue;
        const value = line.trim().slice(5).trimStart();
        if (value === '[DONE]') { sentDone++; continue; }
        if (value) payloads.push(JSON.parse(value));
      }
      assert.equal(sentDone, 1, 'live SSE must contain exactly one completion sentinel');
    }
    assert.ok(payloads.length > 0);
    let content = '';
    for (const payload of payloads) {
      assert.ok(!payload.error, 'live response contains an error');
      if (payload.model !== undefined) {
        assert.equal(payload.model, model);
        record.servedModel = payload.model;
      }
      if (payload.usage) record.usage = structuredClone(payload.usage);
      const choice = payload.choices?.[0];
      if (choice?.finish_reason) record.finishReason = choice.finish_reason;
      const packet = choice?.delta ?? choice?.message;
      if (typeof packet?.content === 'string') content += packet.content;
      assert.ok(!packet?.tool_calls?.length, 'live reply must not request tools');
    }
    assert.equal(record.responseStatus, 200);
    assert.ok(record.transportClosed && record.transportBytes > 0);
    assert.equal(record.finishReason, 'stop');
    assert.equal(record.servedModel, model);
    const oracle = fixture.turns[record.turn].response;
    assert.ok(oracle, 'a successful response needs an oracle');
    assert.deepEqual(record.usage, oracle.usage);
    assert.equal(content, oracle.choices[0].message.content);
    assert.equal(content, record.contentChunks.join(''), 'provider callbacks must preserve actual response content');
    assert.equal(record.providerResult?.content, content);
    assert.equal(record.providerResult?.finishReason, record.finishReason);
    assert.equal(record.providerResult?.servedModel, record.servedModel);
    const metrics = [...record.metrics].reverse().find((event) => event.metrics.phase === 'complete')?.metrics;
    assert.ok(metrics, 'production provider must report completed metrics');
    assert.equal(metrics.promptTokens, record.usage!.prompt_tokens);
    assert.equal(metrics.completionTokens, record.usage!.completion_tokens);
  };

  const verifyCancellation = (record: LiveTurnRecord) => {
    assert.ok(stopReuse && record.turn === 0, 'only this profile admits a cancelled first request');
    assert.equal(record.cancelRequests, 1);
    assert.equal(record.timedOut, false);
    assert.equal(record.completed, false);
    assert.equal(record.providerResult, null);
    assert.equal(record.responseStatus, 200);
    assert.equal(record.transport, 'sse');
    assert.equal(record.responseEof, false, 'Stop must precede normal EOF');
    assert.ok(record.abortObserved && record.abortListenerRemoved && record.transportClosed);
    assert.ok(record.firstContentAt !== null && record.cancelRequestedAt !== null
      && record.abortObservedAt !== null && record.transportClosedAt !== null);
    assert.ok(record.firstContentAt <= record.cancelRequestedAt
      && record.cancelRequestedAt <= record.abortObservedAt
      && record.abortObservedAt <= record.transportClosedAt);
    assert.ok(hasVisibleCount(record.contentChunks.join('')), 'Stop requires actual visible numeric content');
    assert.ok(record.checkpointed > 0, 'the interrupted tool loop must preserve its partial transcript');
    // Cancellation may cut an in-flight frame in half. Inspect every complete data line;
    // the broker independently binds the retained upstream prefix and socket shutdown.
    const lines = record.rawResponse.split('\n');
    lines.pop();
    for (const line of lines) {
      if (!line.trim().startsWith('data:')) continue;
      const raw = line.trim().slice(5).trimStart();
      assert.notEqual(raw, '[DONE]', 'Stop cannot qualify after a completion sentinel');
      if (!raw) continue;
      const payload = JSON.parse(raw);
      assert.ok(!payload.error && !payload.usage, 'a stopped prefix cannot contain completion/error metadata');
      assert.equal(payload.model, model);
      for (const choice of payload.choices ?? []) {
        assert.ok(!choice.finish_reason, 'Stop cannot qualify after a terminal frame');
        assert.ok(!choice.delta?.tool_calls?.length, 'the stopped reply cannot request tools');
      }
    }
  };

  return {
    records,
    idle: () => active === null && aborters.size === 0,
    cancel(runId: string) {
      const controller = aborters.get(runId);
      if (!controller || active?.requestId !== runId) return false;
      if (stopReuse) {
        if (active.turn !== 0 || active.cancelRequests || active.settled || active.transportClosed
            || !hasVisibleCount(active.contentChunks.join(''))) return false;
      }
      active.cancelRequests++;
      active.cancelRequestedAt = Date.now();
      controller.abort();
      return true;
    },
    async stream(request: ChatRequest, turn: number) {
      assert.ok(!disposed && !failed, 'live host cannot continue after disposal or failure');
      assert.equal(active, null, 'live turns must run sequentially');
      let record: LiveTurnRecord | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let controller: AbortController | undefined;
      try {
        assert.ok(turn === records.length && (turn === 0 || turn === 1), 'live host allows exactly two ordered turns');
        assert.ok(request.requestId && request.threadId);
        assert.equal(request.responseMessageId, request.requestId);
        assert.equal(request.providerId, source.id);
        assert.equal(request.model, model);
        assert.equal(request.maxTokens, undefined);
        assert.equal(request.temperature, undefined);
        const expected = structuredClone(fixture.turns[turn].request.messages.filter((message) => message.role !== 'system'));
        if (turn === 1 && stopReuse) {
          const first = records[0];
          assert.ok(first.settled && first.outcome === 'cancelled' && first.transportClosed,
            'the cancelled request must settle and close before reuse');
          verifyCancellation(first);
          assert.notEqual(request.threadId, first.request.threadId, 'reuse requires an actual fresh conversation');
          assert.notEqual(request.requestId, first.requestId);
          assert.equal(request.messages.length, 1, 'cancelled history must not enter the fresh request');
          assert.notEqual(request.messages[0].id, first.request.messages[0].id);
        } else if (turn === 1) {
          const first = records[0];
          assert.ok(first.completed && first.result, 'first reply must pass before another request');
          expected.find((message) => message.role === 'assistant')!.content = first.result.content;
          assert.equal(request.threadId, first.request.threadId);
          assert.notEqual(request.requestId, first.requestId);
          assert.equal(request.messages[0].id, first.request.messages[0].id);
          assert.equal(request.messages[1].id, first.requestId);
        }
        assert.deepEqual(request.messages.map(({ role, content }) => ({ role, content })), expected);
        const resumed = transcripts.resume(request.threadId, request.messages);
        assert.equal(resumed !== null, turn === 1 && !stopReuse,
          stopReuse ? 'fresh reuse must not resume the cancelled transcript' : 'turn two must resume the production transcript');
        const profile = turnProfile(turn);
        const instructions = 'Use the existing project conventions.\n'.repeat(60).slice(0, 2048);
        const mode = request.accessMode ?? 'ask';
        const system = withSituation(renderInstructions([{
          path: '/fixture/AGENTS.md', label: 'AGENTS.md', content: instructions, length: instructions.length,
        }]), { workspace: '/fixture', workspaceConfirmed: true, mode, tools: [], maxOutputTokens: profile.maxOutputTokens });
        assert.equal(system, fixture.turns[turn].request.messages[0].content);
        const prepared = prepareInteractiveRequest(request, resumed ?? request.messages, system, profile, promptBudget(profile, []));
        assert.equal(prepared.fit.compacted, 0);
        assert.equal(prepared.fit.overflowTokens, 0);
        record = { turn, requestId: request.requestId, request: structuredClone(request), resumed: resumed !== null,
          maxTokens: prepared.request.maxTokens, wire: null, attemptCount: 0, providerCalls: 0,
          transportFragments: 0, transportBytes: 0, responseStatus: null, contentType: null, transport: null,
          rawResponse: '', usage: null, finishReason: null, servedModel: null, providerResult: null, metrics: [],
          contentChunks: [], reasoning: '', completed: false, settled: false, outcome: null, error: null,
          checkpointed: 0, cancelRequests: 0, firstContentAt: null, cancelRequestedAt: null,
          abortObserved: false, abortObservedAt: null, abortListenerRemoved: false, transportClosedAt: null,
          timedOut: false, bodyCancelled: false, transportClosed: false,
          responseEof: false, startedAt: Date.now(), settledAt: null, deadlineMs: REQUEST_DEADLINE_MS, result: null };
        records.push(record);
        active = record;
        const current = record;
        controller = new AbortController();
        aborters.set(request.requestId, controller);
        const aborter = controller;
        timer = setTimeout(() => { current.timedOut = true; aborter.abort(); }, REQUEST_DEADLINE_MS);
        const remember = (messages: Message[]) => {
          transcripts.remember(request.threadId!, messages,
            [...request.messages.map((message) => message.id), request.responseMessageId!],
            [[request.responseMessageId!, current.contentChunks.join('')]]);
          current.checkpointed++;
        };
        const result = await runToolLoop({
          provider: { async stream(...args: Parameters<OpenAICompatibleProvider['stream']>) {
            current.providerCalls++;
            assert.equal(current.providerCalls, 1, 'a live turn must have only one provider round');
            const result = await provider.stream(...args);
            current.providerResult = structuredClone(result);
            return result;
          } },
          request: prepared.request, runId: request.requestId, mode, signal: controller.signal,
          toolRuntime: { enabledTools: () => [], callTool: async () => assert.fail('no tool dispatch expected') },
          fit: (messages, tools) => fitToBudget(messages, promptBudget(profile, tools)),
          onContent: (content) => {
            if (content && current.firstContentAt === null) current.firstContentAt = Date.now();
            current.contentChunks.push(content); send('chat:stream-data', { id: request.requestId, content });
          },
          onReasoning: (content) => { current.reasoning += content; send('chat:reasoning', { id: request.requestId, content }); },
          onMetrics: (event) => current.metrics.push(structuredClone(event)),
          onTranscript: remember,
          onActivity: () => assert.fail('no tools are connected'),
          requestApproval: async () => assert.fail('no approval expected'),
        });
        assert.equal(current.timedOut, false, 'live turn exceeded 240 seconds');
        assert.ok(!stopReuse || turn !== 0, 'the first Stop/reuse request must not finish normally');
        assert.equal(result.reason, 'finished');
        assert.equal(result.rounds, 1);
        assert.equal(result.toolCalls, 0);
        verifyTransport(current);
        assert.equal(result.content, current.contentChunks.join(''));
        assert.equal(result.transcript.at(-1)?.content, result.content);
        remember(result.transcript);
        current.result = { reason: result.reason, rounds: result.rounds, toolCalls: result.toolCalls, content: result.content };
        current.completed = true;
        current.outcome = 'finished';
      } catch (error) {
        if (stopReuse && turn === 0 && record && controller?.signal.aborted && record.cancelRequests === 1 && !record.timedOut) {
          try {
            verifyCancellation(record);
            record.error = String(error);
            record.outcome = 'cancelled';
            // Match streamChat's thin cancellation boundary. The production tool loop,
            // provider and fetch supplied all preceding bytes and the partial checkpoint.
            send('chat:stream-data', { id: request.requestId, content: '\n\n_Stopped._' });
            return;
          } catch (invalidCancellation) { error = invalidCancellation; }
        }
        failed = true;
        if (record) {
          record.error = String(error);
          record.outcome = controller?.signal.aborted && !record.timedOut ? 'cancelled' : 'error';
        }
        controller?.abort();
        throw error;
      } finally {
        clearTimeout(timer);
        aborters.delete(request.requestId ?? '');
        active = null;
        if (record) { record.settled = true; record.settledAt = Date.now(); }
      }
    },
    dispose() {
      disposed = true;
      for (const controller of aborters.values()) controller.abort();
      if (globalThis.fetch === fetchLive) globalThis.fetch = originalFetch;
    },
  };
}
