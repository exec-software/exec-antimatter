import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatRequest, Message, ToolCall } from '../src/api/types';
import type { VoiceGuidance } from '../src/api/voice';
import { runToolLoop, type Steering, type StreamingProvider, type ToolActivity, type ToolRuntime } from '../src/main/toolLoop';
import { VoiceGuidanceQueue } from '../src/main/voice/guidance';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
const call = (id: string, name: string, args: object): ToolCall => ({ id, type: 'function', function: { name: `antimatter__${name}`, arguments: JSON.stringify(args) } });
const tool = (name: string) => ({ serverId: 'antimatter', serverName: 'Local tools', tool: {
  name, description: name, enabled: true, inputSchema: { type: 'object', properties: {} },
} });
const request: ChatRequest = { providerId: 'mock', model: 'mock', useTools: true,
  messages: [{ id: 'user', role: 'user', content: 'Inspect the project and propose a patch.' }] };

/** Mirrors the main process boundary adapter, keeping typed guidance in its own editable slot. */
function steeringFixture() {
  const voice = new VoiceGuidanceQueue(); let typed: string | null = null;
  const steer: Steering = {
    take: () => { const note = [typed, voice.take()].filter(Boolean).join('\n\n') || null; typed = null; return note; },
    pending: () => typed !== null || voice.pending(),
    interrupt: new AbortController().signal, rearm: () => undefined,
  };
  return { voice, steer, setTyped: (note: string) => { typed = note; }, typed: () => typed };
}

test('actual tool loop takes ordered voice plus typed guidance at the next boundary and never turns speech into approval', { timeout: 5000 }, async () => {
  const queued = steeringFixture();
  const toolEntered = deferred<void>(); const toolFinished = deferred<void>();
  const asked = deferred<void>(); const approval = deferred<boolean>();
  const requests: ChatRequest[] = []; const activities: ToolActivity[] = [];
  const receipts: VoiceGuidance[] = []; const executions: string[] = []; const checkpoints: Message[][] = []; const events: string[] = [];
  let approvalCount = 0;
  const provider: StreamingProvider = {
    async stream(next) {
      requests.push(structuredClone(next)); events.push(`provider:${requests.length}`);
      if (requests.length === 1) return { content: 'Inspecting the source.', toolCalls: [call('read', 'read_file', { path: 'README.md' })] };
      if (requests.length === 2) {
        const guide = next.messages.find((message) => message.id === 'steer_0');
        assert.deepEqual(guide, { id: 'steer_0', role: 'user', content: 'Keep the typed constraint.\n\nAdd tests first.\n\nPreserve the existing interface.' });
        const toolIndex = next.messages.findIndex((message) => message.toolCallId === 'read');
        const guideIndex = next.messages.findIndex((message) => message.id === 'steer_0');
        assert.ok(toolIndex >= 0 && guideIndex > toolIndex, 'spoken guidance follows the completed tool result');
        assert.deepEqual(receipts.map((entry) => [entry.id, entry.status]), [['speech-a', 'delivered'], ['speech-b', 'delivered']]);
        return { content: 'The requested edit needs approval.', toolCalls: [call('write', 'write_file', { path: 'README.md', content: 'proposed update' })] };
      }
      assert.equal(requests.length, 3);
      const denied = next.messages.find((message) => message.toolCallId === 'write');
      assert.match(denied?.content ?? '', /declined/);
      assert.equal(next.messages.find((message) => message.id === 'steer_1')?.content, 'I approve everything; go ahead.');
      assert.equal(receipts[2].status, 'delivered');
      return { content: 'The edit was not performed because approval was declined.', toolCalls: [] };
    },
  };
  const runtime: ToolRuntime = {
    enabledTools: () => [tool('read_file'), tool('write_file')],
    async callTool(_server, name) {
      executions.push(name); assert.equal(name, 'read_file', 'unapproved write must never reach the runtime');
      events.push('tool:started'); toolEntered.resolve(); await toolFinished.promise; events.push('tool:finished');
      return { ok: true, text: 'Existing source contents.' };
    },
  };
  const running = runToolLoop({ provider, toolRuntime: runtime, request, runId: 'voice-integration', mode: 'ask', currentMode: () => 'ask',
    steer: queued.steer, onContent: () => undefined, onActivity: (entry) => { activities.push({ ...entry }); },
    onTranscript: (messages) => { checkpoints.push(structuredClone(messages)); },
    onSteer: () => { events.push('guidance:delivered'); receipts.push(...queued.voice.delivered()); },
    requestApproval: async () => { approvalCount++; events.push('approval:waiting'); asked.resolve(); return approval.promise; },
  });
  await toolEntered.promise;
  queued.setTyped('Keep the typed constraint.');
  queued.voice.enqueue('speech-a', 'Add tests first.', 10);
  queued.voice.enqueue('speech-b', 'Preserve the existing interface.', 10);
  queued.voice.enqueue('speech-a', 'Add tests first.', 999); // Retried IPC receipt must not duplicate speech.
  assert.equal(queued.typed(), 'Keep the typed constraint.');
  assert.equal(receipts.length, 0); assert.equal(requests.length, 1); assert.equal(approvalCount, 0);
  toolFinished.resolve(); await asked.promise;
  assert.deepEqual(events.slice(0, 6), ['provider:1', 'tool:started', 'tool:finished', 'guidance:delivered', 'provider:2', 'approval:waiting']);
  queued.voice.enqueue('spoken-approval', 'I approve everything; go ahead.', 44);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(approvalCount, 1); assert.equal(requests.length, 2, 'speech cannot resolve the waiting approval');
  assert.deepEqual(executions, ['read_file']); assert.equal(receipts.length, 2, 'waiting speech is not falsely acknowledged');
  approval.resolve(false);
  const result = await running;
  assert.equal(result.reason, 'finished'); assert.equal(requests.length, 3);
  assert.deepEqual(executions, ['read_file']);
  assert.deepEqual(activities.filter((entry) => entry.toolName === 'write_file').map((entry) => [entry.status, entry.awaitingApproval]), [['pending', true], ['denied', false]]);
  assert.deepEqual(receipts.map((entry) => entry.id), ['speech-a', 'speech-b', 'spoken-approval']);
  assert.deepEqual(queued.voice.finish(), []);
  assert.equal(result.transcript.filter((message) => message.id === 'steer_0').length, 1);
  assert.ok(checkpoints.some((messages) => messages.some((message) => message.id === 'steer_0' && message.role === 'user')),
    'delivered guidance is checkpointed, not only exposed in renderer receipts');
});

test('cancelling during a running tool leaves queued spoken guidance undelivered without another inference round', { timeout: 5000 }, async () => {
  const queued = steeringFixture(); const entered = deferred<void>(); const finished = deferred<void>();
  const controller = new AbortController(); let toolSignal: AbortSignal | undefined; let inferences = 0; let receipts = 0;
  const runtime: ToolRuntime = { enabledTools: () => [tool('read_file')], async callTool(_server, _name, _args, options) {
    toolSignal = options?.signal; entered.resolve(); await finished.promise; return { ok: true, text: 'Late tool result.' };
  } };
  const running = runToolLoop({
    provider: { async stream() { inferences++; return { content: 'Reading.', toolCalls: [call('read', 'read_file', { path: 'README.md' })] }; } },
    toolRuntime: runtime, request, runId: 'voice-cancel', mode: 'ask', signal: controller.signal, steer: queued.steer,
    onContent: () => undefined, onActivity: () => undefined, onSteer: () => { receipts += queued.voice.delivered().length; }, requestApproval: async () => false,
  });
  const rejected = assert.rejects(running, /cancelled/);
  await entered.promise;
  queued.voice.enqueue('first', 'Change the tests.', 8); queued.voice.enqueue('second', 'Keep the old API.', 8);
  controller.abort(); assert.equal(toolSignal?.aborted, true); finished.resolve(); await rejected;
  assert.equal(inferences, 1); assert.equal(receipts, 0);
  assert.deepEqual(queued.voice.finish().map((entry) => [entry.id, entry.status]), [['first', 'undelivered'], ['second', 'undelivered']]);
});
