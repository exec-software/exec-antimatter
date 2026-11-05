import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { ProviderConfig } from '../src/api/types';
import type { VoiceSettings, VoiceState } from '../src/api/voice';
import { VoiceGuidanceQueue } from '../src/main/voice/guidance';
import { isVoiceAppUrl, mayCaptureVoice } from '../src/main/voice/permissions';
import { VoiceSession } from '../src/main/voice/session';
import { defaultVoiceSettings, validateVoiceSettings, voiceSources, VoiceSettingsStore } from '../src/main/voice/settings';

const settings = (): VoiceSettings => ({ inputSourceId: 'local', inputModel: 'qwen3-omni-30b', inputMode: 'chat-audio',
  speechSourceId: 'speech', speechModel: 'kokoro-v1', speechVoice: 'coral', speechEnabled: true, allowRemote: false });
const source = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: 'local', name: 'Local models', baseUrl: 'http://127.0.0.1:6767/v1',
  apiKey: 'private-credential', models: [{ id: 'qwen3-omni-30b', name: 'Omni' }], supportsStreaming: true, ...extra });
test('voice defaults prefer an installed local streaming recognizer and preserve saved endpoint selection', () => {
  const streaming = source({ id: 'asr', models: [{ id: 'Moonshine-Small-Streaming', name: 'Moonshine' }] });
  assert.equal(defaultVoiceSettings([source()]).inputMode, 'chat-audio');
  const defaults = defaultVoiceSettings([source(), streaming]);
  assert.equal(defaults.inputSourceId, 'asr'); assert.equal(defaults.inputMode, 'realtime');
  assert.equal(validateVoiceSettings({ ...settings(), inputMode: 'realtime' }).inputMode, 'realtime');
  assert.equal(validateVoiceSettings(settings()).inputMode, 'chat-audio');
  assert.equal(defaultVoiceSettings([source(), { ...streaming, baseUrl: 'https://remote.example/v1' }]).inputMode, 'chat-audio');
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test('voice sessions own immutable thread/settings snapshots and reject stale updates', () => {
  const changes: VoiceState[] = [];
  const session = new VoiceSession((state) => { changes.push(state); });
  assert.equal(session.snapshot().active, false);
  assert.throws(() => session.begin('', settings()), /conversation/);
  const config = settings();
  const first = session.begin('thread-a', config);
  assert.equal(first.phase, 'starting'); assert.equal(first.threadId, 'thread-a'); assert.ok(first.sessionId);
  config.inputModel = 'changed outside';
  const snapshot = session.assert(first.sessionId); snapshot.inputModel = 'changed return'; first.active = false;
  assert.equal(session.assert(first.sessionId).inputModel, 'qwen3-omni-30b'); assert.equal(session.snapshot().active, true);
  session.update(first.sessionId, { phase: 'listening', error: 'x'.repeat(999), muted: true, speaking: true });
  assert.equal(session.snapshot().error?.length, 240); assert.equal(session.snapshot().phase, 'listening');
  const second = session.begin('thread-b', settings());
  assert.notEqual(second.sessionId, first.sessionId);
  session.end(first.sessionId);
  assert.equal(session.snapshot().sessionId, second.sessionId, 'late old recorder stop must not end replacement');
  assert.throws(() => session.update(first.sessionId, { phase: 'error' }), /ended/);
  assert.throws(() => session.assert(first.sessionId), /ended/);
  changes[changes.length - 1].threadId = 'mutated callback';
  assert.equal(session.snapshot().threadId, 'thread-b');
  session.end(second.sessionId); assert.equal(session.snapshot().sessionId, null); assert.equal(session.snapshot().active, false);
});

test('one input and one speech request may coexist, but duplicate IDs and same-kind requests cannot', async () => {
  const session = new VoiceSession(); const id = session.begin('thread', settings()).sessionId;
  const input = deferred<string>(); const speech = deferred<string>();
  const inputRequest = session.request(id, 'input-1', 'input', async () => input.promise);
  const speechRequest = session.request(id, 'speech-1', 'speech', async () => speech.promise);
  await assert.rejects(session.request(id, 'input-2', 'input', async () => 'bad'), /already in progress/);
  await assert.rejects(session.request(id, 'input-1', 'speech', async () => 'bad'), /duplicate/);
  await assert.rejects(session.request(id, '', 'speech', async () => 'bad'), /Invalid/);
  input.resolve('heard'); speech.resolve('spoken');
  assert.deepEqual(await Promise.all([inputRequest, speechRequest]), ['heard', 'spoken']);
  assert.equal(await session.request(id, 'input-1', 'input', async () => 'next'), 'next', 'settled IDs can be reused');
});

test('request cancellation is scoped and rejects late backend success while clearing the slot', async () => {
  const session = new VoiceSession(); const id = session.begin('thread', settings()).sessionId;
  const gate = deferred<string>(); let signal!: AbortSignal;
  const request = session.request(id, 'one', 'input', async (_config, active) => { signal = active; return gate.promise; });
  const rejected = assert.rejects(request, /cancelled/);
  session.cancel('stale-session', 'one'); session.cancel(id, 'other');
  assert.equal(signal.aborted, false);
  session.cancel(id, 'one'); assert.equal(signal.aborted, true);
  await assert.rejects(session.request(id, 'two', 'input', async () => 'overlap'), /already in progress/);
  gate.resolve('late transcript'); await rejected;
  assert.equal(await session.request(id, 'two', 'input', async () => 'new transcript'), 'new transcript');
});

test('ending aborts both backends, and old finalizers cannot delete a replacement session request', async () => {
  const session = new VoiceSession(); const id = session.begin('old-thread', settings()).sessionId;
  const old = deferred<string>(); const oldSpeech = deferred<string>(); const replacement = deferred<string>();
  const signals: AbortSignal[] = [];
  const request = session.request(id, 'reused-id', 'input', async (_config, signal) => { signals.push(signal); return old.promise; });
  const speech = session.request(id, 'speech-id', 'speech', async (_config, signal) => { signals.push(signal); return oldSpeech.promise; });
  const oldRejected = assert.rejects(request, /cancelled/); const speechRejected = assert.rejects(speech, /cancelled/);
  const nextId = session.begin('new-thread', settings()).sessionId;
  assert.ok(signals.every((signal) => signal.aborted));
  const next = session.request(nextId, 'reused-id', 'input', async () => replacement.promise);
  old.resolve('stale'); oldSpeech.resolve('stale speech'); await oldRejected; await speechRejected;
  await assert.rejects(session.request(nextId, 'overlap', 'input', async () => 'bad'), /already in progress/);
  replacement.resolve('fresh'); assert.equal(await next, 'fresh');
  await assert.rejects(session.request(id, 'old', 'input', async () => 'bad'), /ended/);
});

test('failed backend work releases concurrency slots and cannot mutate durable session configuration', async () => {
  const session = new VoiceSession(); const id = session.begin('thread', settings()).sessionId;
  await assert.rejects(session.request(id, 'fail', 'speech', async (config) => { config.allowRemote = true; throw new Error('backend failed'); }), /backend failed/);
  assert.equal(session.assert(id).allowRemote, false);
  assert.equal(await session.request(id, 'retry', 'speech', async () => 'ok'), 'ok');
});

test('spoken guidance is ordered, copied, and deduplicated throughout queued and delivered states', () => {
  const queue = new VoiceGuidanceQueue();
  const first = queue.enqueue('utterance-a', '  First.  ', 3); first.text = 'mutated';
  queue.enqueue('utterance-b', 'Second.', 8);
  const duplicate = queue.enqueue('utterance-a', 'First.', 999);
  assert.equal(duplicate.contentOffset, 3); assert.equal(duplicate.status, 'queued');
  assert.throws(() => queue.enqueue('utterance-a', 'Different.', 3), /different speech/);
  assert.equal(queue.pending(), true); assert.equal(queue.take(), 'First.\n\nSecond.'); assert.equal(queue.pending(), false);
  assert.equal(queue.take(), null);
  const delivered = queue.delivered();
  assert.deepEqual(delivered.map((entry) => [entry.id, entry.status]), [['utterance-a', 'delivered'], ['utterance-b', 'delivered']]);
  delivered[0].text = 'changed after delivery';
  assert.equal(queue.enqueue('utterance-a', 'First.', 0).text, 'First.');
  assert.equal(queue.enqueue('utterance-a', 'First.', 0).status, 'delivered');
  assert.equal(queue.pending(), false); assert.deepEqual(queue.delivered(), []); assert.deepEqual(queue.finish(), []);
});

test('taking later guidance never repeats earlier taken speech, and interruption reports original chronology', () => {
  const queue = new VoiceGuidanceQueue();
  queue.enqueue('first', 'First.', 0); assert.equal(queue.take(), 'First.');
  queue.enqueue('second', 'Second.', 1); assert.equal(queue.take(), 'Second.');
  queue.enqueue('third', 'Third.', 2);
  const undelivered = queue.finish();
  assert.deepEqual(undelivered.map((entry) => [entry.id, entry.status]), [['first', 'undelivered'], ['second', 'undelivered'], ['third', 'undelivered']]);
  undelivered[0].text = 'caller mutation';
  assert.equal(queue.pending(), false); assert.equal(queue.take(), null); assert.deepEqual(queue.finish(), []); assert.deepEqual(queue.delivered(), []);
  assert.equal(queue.enqueue('first', 'First.', 0).status, 'undelivered', 'an IPC retry must not replay unsettled old speech');
});

test('pending plus taken-unacknowledged guidance share count/text limits until confirmed delivered', () => {
  const count = new VoiceGuidanceQueue();
  for (let i = 0; i < 16; i++) { count.enqueue(`u${i}`, `item ${i}`, i); if (i === 7) count.take(); }
  assert.throws(() => count.enqueue('overflow', 'one more', 16), /full/);
  count.delivered(); assert.doesNotThrow(() => count.enqueue('released', 'slot available', 16));
  const text = new VoiceGuidanceQueue();
  text.enqueue('a', 'a'.repeat(4000), 0); text.take();
  text.enqueue('b', 'b'.repeat(4000), 1); text.enqueue('c', 'c'.repeat(4000), 2);
  assert.throws(() => text.enqueue('overflow', 'x', 3), /full/);
  text.delivered(); assert.doesNotThrow(() => text.enqueue('released', 'x', 3));
});

test('guidance lifetime dedupe history is bounded and malformed anchors/text/ids never enter it', () => {
  const queue = new VoiceGuidanceQueue();
  for (const offset of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => queue.enqueue('bad', 'text', offset), /position/);
  for (const [id, text] of [['', 'text'], ['bad id', 'text'], ['x'.repeat(101), 'text'], ['valid', ''], ['valid', 'x'.repeat(4001)]]) {
    assert.throws(() => queue.enqueue(id, text, 0), /guidance/);
  }
  for (let i = 0; i < 256; i++) { queue.enqueue(`u${i}`, 'text', i); queue.take(); queue.delivered(); }
  assert.throws(() => queue.enqueue('overflow', 'text', 256), /full/);
  assert.equal(queue.enqueue('u0', 'text', 0).status, 'delivered', 'existing acknowledgements still resolve at capacity');
});

test('voice source projection contains no credentials/URLs and defaults only to compatible local audio presets', () => {
  const sources = [source({ id: 'remote', baseUrl: 'https://voice.example/v1?secret=token' }),
    source({ id: 'native', baseUrl: 'http://127.0.0.1:6768/v1', models: [{ id: 'qwen3-coder-30b', name: 'Coder' }] }),
    source(), source({ id: 'speech', baseUrl: 'http://127.0.0.1:13305/api/v1', models: [{ id: 'kokoro-v1', name: 'Kokoro' }] }),
    source({ id: 'anthropic', protocol: 'anthropic-messages' }), source({ id: 'responses', protocol: 'openai-responses' })];
  const publicSources = voiceSources(sources);
  assert.deepEqual(publicSources.map((entry) => entry.id), ['remote', 'native', 'local', 'speech']);
  assert.doesNotMatch(JSON.stringify(publicSources), /private-credential|https:|http:|token|apiKey|baseUrl/);
  assert.deepEqual(defaultVoiceSettings(sources), settings());
  publicSources[2].models.push('mutated'); assert.equal(sources[2].models.length, 1);
  const noLocal = defaultVoiceSettings([sources[0]]);
  assert.equal(noLocal.inputSourceId, ''); assert.equal(noLocal.speechEnabled, false); assert.equal(noLocal.allowRemote, false);
});

test('local settings classification matches transport guard, including loopback aliases and malformed URLs', () => {
  for (const baseUrl of ['file://localhost/x', 'http://secret@127.0.0.1/v1', 'invalid', 'http://localhost.evil/v1']) {
    assert.equal(voiceSources([source({ baseUrl })])[0].local, false);
    assert.equal(defaultVoiceSettings([source({ baseUrl })]).inputSourceId, '');
  }
  for (const baseUrl of ['http://127.0.0.2/v1', 'https://localhost/v1', 'http://[::1]/v1']) assert.equal(voiceSources([source({ baseUrl })])[0].local, true);
});

test('voice settings validate explicit remote consent and discard unknown fields without preserving secrets', () => {
  assert.equal(validateVoiceSettings({ ...settings(), allowRemote: undefined }).allowRemote, false, 'legacy settings default to local');
  assert.equal(validateVoiceSettings({ ...settings(), allowRemote: 'true' }).allowRemote, false, 'truthy text is not consent');
  assert.equal(validateVoiceSettings({ ...settings(), allowRemote: true }).allowRemote, true);
  assert.deepEqual(validateVoiceSettings({ ...settings(), apiKey: 'private', extra: 'ignored' }), settings());
  for (const input of [null, [], {}, { ...settings(), inputMode: 'invalid' }, { ...settings(), speechEnabled: 'true' },
    { ...settings(), inputModel: 'x'.repeat(301) }, { ...settings(), speechVoice: 'evil\nvoice' }, { ...settings(), inputSourceId: 'bad\x7f' }]) {
    assert.throws(() => validateVoiceSettings(input), /Invalid/);
  }
});

test('settings persist privately, retain remote fields, validate sources, and surface corruption without silent reset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'antimatter-voice-settings-'));
  const path = join(directory, 'private', 'voice.json');
  try {
    const sources = [source(), source({ id: 'speech', baseUrl: 'http://127.0.0.1:13305/api/v1', models: [{ id: 'kokoro-v1', name: 'Kokoro' }] }),
      source({ id: 'cloud', baseUrl: 'https://voice.example/v1' })];
    const store = new VoiceSettingsStore(path, () => sources);
    assert.deepEqual(store.read(), settings());
    const remote = { ...settings(), inputSourceId: 'cloud', inputMode: 'transcriptions' as const, allowRemote: true };
    assert.deepEqual(store.save({ ...remote, apiKey: 'do-not-persist' }), remote);
    assert.deepEqual(new VoiceSettingsStore(path, () => sources).read(), remote);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /credential|apiKey|do-not-persist|http/);
    if (process.platform !== 'win32') { assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(join(directory, 'private')).mode & 0o777, 0o700); }
    assert.throws(() => store.save({ ...remote, inputSourceId: 'missing' }), /existing/);
    assert.throws(() => store.save({ ...remote, speechSourceId: 'missing' }), /speech source/);
    assert.deepEqual(store.read(), remote, 'invalid edits do not overwrite valid configuration');
    writeFileSync(path, '{broken'); assert.throws(() => store.read(), /could not be read/);
    assert.equal(readFileSync(path, 'utf8'), '{broken');
    store.save(settings()); assert.deepEqual(store.read(), settings());
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('microphone permissions require trusted main frame plus active voice, with audio only', () => {
  const allowed = { trustedMain: true, active: true, mainFrame: true, mediaTypes: ['audio'] };
  assert.equal(mayCaptureVoice(allowed), true);
  for (const field of ['trustedMain', 'active', 'mainFrame']) assert.equal(mayCaptureVoice({ ...allowed, [field]: false }), false);
  for (const mediaTypes of [[], ['video'], ['audio', 'video'], ['audio', 'audio'], ['unknown'], ['Audio']]) assert.equal(mayCaptureVoice({ ...allowed, mediaTypes }), false);
});

test('app URL identity accepts exact packaged entry or same-origin dev entry, never preview/remote/userinfo URLs', () => {
  const entry = '/app/renderer/index.html'; const app = pathToFileURL(entry).href;
  assert.equal(isVoiceAppUrl(app, entry), true); assert.equal(isVoiceAppUrl(`${app}?surface=chat#thread`, entry), true);
  for (const value of ['file:///app/renderer/other.html', 'file:///evil/index.html', 'https://example.com/index.html', 'about:blank', 'not a url']) assert.equal(isVoiceAppUrl(value, entry), false);
  const dev = 'http://127.0.0.1:4175';
  for (const value of [`${dev}/`, `${dev}/index.html?surface=chat#thread`]) assert.equal(isVoiceAppUrl(value, entry, dev), true);
  for (const value of [`${dev}/preview`, 'http://127.0.0.1:4176/', 'http://localhost:4175/', 'http://user:password@127.0.0.1:4175/']) assert.equal(isVoiceAppUrl(value, entry, dev), false);
  assert.equal(isVoiceAppUrl('file:///', entry, 'file:///anything'), false, 'opaque origins cannot grant dev permissions');
});
