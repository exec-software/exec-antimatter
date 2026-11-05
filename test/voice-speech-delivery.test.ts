import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceSpeechDelivery } from '../src/main/voice/speechDelivery';
import type { VoiceSpeechEvent } from '../src/api/voice';

const chunk = { audioBase64: 'AAA=', sampleRate: 24000, channels: 1 as const, format: 'pcm16le' as const };
test('speech delivery bounds in-flight audio and requires matching owner, session, request, and sequence', async () => {
  const events: VoiceSpeechEvent[] = [];
  const delivery = new VoiceSpeechDelivery('session', 'request', 7, new AbortController().signal, (event) => events.push(event));
  let settled = false;
  const first = delivery.send(chunk).then(() => { settled = true; });
  await assert.rejects(delivery.send(chunk), /in flight/);
  for (const args of [['stale', 'request', 7, 0], ['session', 'other', 7, 0], ['session', 'request', 8, 0], ['session', 'request', 7, 1]] as const) {
    delivery.acknowledge(...args);
  }
  await Promise.resolve(); assert.equal(settled, false);
  delivery.acknowledge('session', 'request', 7, 0); await first;
  const second = delivery.send(chunk);
  delivery.acknowledge('session', 'request', 7, 0);
  assert.deepEqual(events.map((event) => event.sequence), [0, 1]);
  delivery.acknowledge('session', 'request', 7, 1); await second;
});
test('cancel, stalled renderer, and destroyed renderer release pending speech promptly', async () => {
  const controller = new AbortController();
  const delivery = new VoiceSpeechDelivery('s', 'r', 1, controller.signal, () => {});
  const waiting = delivery.send(chunk);
  controller.abort(); await assert.rejects(waiting, /cancelled/);
  await assert.rejects(delivery.send(chunk), /cancelled/);
  const stalled = new VoiceSpeechDelivery('s', 'r', 1, new AbortController().signal, () => {}, 5);
  await assert.rejects(stalled.send(chunk), /stopped responding/);
  const destroyed = new VoiceSpeechDelivery('s', 'r', 1, new AbortController().signal, () => { throw new Error('destroyed'); });
  await assert.rejects(destroyed.send(chunk), /unavailable/);
});
