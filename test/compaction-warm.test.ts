import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatRequest, Message } from '../src/api/types';
import {
  clearWarmPrefixes, recordWarmPrefix, warmCompactedPrefix, warmPrefixFor,
  type WarmDeps,
} from '../src/main/compactionWarm';
import { IdleCompaction } from '../src/main/idleCompaction';

const message = (id: string, role: Message['role'], content: string): Message =>
  ({ id, role, content }) as Message;

const compacted: Message[] = [
  message('c1', 'user', '[Earlier in this conversation — 40 messages, summarized] …'),
  message('c2', 'assistant', 'Understood.'),
];

function deps(overrides: Partial<WarmDeps> = {}) {
  const sent: ChatRequest[] = [];
  const base: WarmDeps = {
    prefix: warmPrefixFor,
    isLocal: () => true,
    busy: () => false,
    chat: async (request) => { sent.push(request); return ''; },
  };
  return { sent, deps: { ...base, ...overrides } };
}

const input = { threadId: 't1', messages: compacted, providerId: 'beholdd', modelId: 'laguna-s-2.1' };

test('warms the recorded prefix, as one system turn plus the compacted transcript', async () => {
  clearWarmPrefixes();
  recordWarmPrefix('t1', {
    systemPrompt: 'SYSTEM BLOCK',
    tools: [{ name: 'read_file', description: 'Read.', parameters: { type: 'object' } } as never],
    providerId: 'beholdd', modelId: 'laguna-s-2.1',
  });
  const { sent, deps: d } = deps();
  assert.equal(await warmCompactedPrefix(input, d, AbortSignal.timeout(60_000)), 'warmed');
  assert.equal(sent.length, 1);
  const request = sent[0];
  // The prefix the next turn will extend: system first, then the committed transcript.
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[0].content, 'SYSTEM BLOCK');
  assert.deepEqual(request.messages.slice(1).map((entry) => entry.id), ['c1', 'c2']);
  // Tools render ahead of the messages, so omitting them would warm a different prefix.
  assert.equal(request.tools?.length, 1);
  // One token: the reply is waste heat, the KV is the point.
  assert.equal(request.maxTokens, 1);
  // Not a turn in the conversation, so it must not be recorded as one.
  assert.equal(request.threadId, undefined);
});

test('drops system turns inherited from the committed transcript', async () => {
  clearWarmPrefixes();
  recordWarmPrefix('t1', { systemPrompt: 'ONLY', providerId: 'beholdd', modelId: 'laguna-s-2.1' });
  const { sent, deps: d } = deps();
  await warmCompactedPrefix(
    { ...input, messages: [message('old', 'system', 'STALE'), ...compacted] },
    d, AbortSignal.timeout(60_000),
  );
  assert.deepEqual(sent[0].messages.filter((entry) => entry.role === 'system').map((e) => e.content), ['ONLY']);
});

test('declines rather than warming a prefix it cannot trust', async () => {
  const cases: Array<[string, () => void, Partial<WarmDeps>, string]> = [
    ['nothing recorded', () => clearWarmPrefixes(), {}, 'no-prefix'],
    ['model changed since', () => {
      clearWarmPrefixes();
      recordWarmPrefix('t1', { systemPrompt: 'S', providerId: 'beholdd', modelId: 'other-model' });
    }, {}, 'prefix-stale'],
    ['hosted source', () => {
      clearWarmPrefixes();
      recordWarmPrefix('t1', { systemPrompt: 'S', providerId: 'beholdd', modelId: 'laguna-s-2.1' });
    }, { isLocal: () => false }, 'not-local'],
    ['person started typing', () => {
      clearWarmPrefixes();
      recordWarmPrefix('t1', { systemPrompt: 'S', providerId: 'beholdd', modelId: 'laguna-s-2.1' });
    }, { busy: () => true }, 'busy'],
  ];
  for (const [why, setup, overrides, expected] of cases) {
    setup();
    const { sent, deps: d } = deps(overrides);
    assert.equal(await warmCompactedPrefix(input, d, AbortSignal.timeout(60_000)), expected, why);
    assert.equal(sent.length, 0, `${why}: must not spend a prefill`);
  }
});

test('keeps only the most recently active threads', () => {
  clearWarmPrefixes();
  for (let index = 0; index < 40; index += 1) {
    recordWarmPrefix(`thread-${index}`, { systemPrompt: 'S', providerId: 'p', modelId: 'm' });
  }
  assert.equal(warmPrefixFor('thread-0'), undefined);
  assert.ok(warmPrefixFor('thread-39'));
});

test('idle compaction warms after a commit, and a failed warm is not a failed compaction', async (t) => {
  for (const failing of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'antimatter-warm-'));
    let now = 0, warms = 0, fingerprint = 'first';
    const scheduler = new IdleCompaction<Message[], Message[]>({
      file: join(root, 'settings.json'), now: () => now, busy: () => false,
      candidate: (threadId) => ({ threadId, fingerprint, estimatedTokens: 10_000, payload: [] }),
      compact: async () => ({ compactedMessages: 4, payload: [] }),
      commit: () => { fingerprint = 'compacted'; return true; },
      warm: async () => {
        warms += 1;
        if (failing) throw new Error('server went away mid-warm');
      },
    });
    t.after(() => { scheduler.dispose(); rmSync(root, { recursive: true, force: true }); });
    scheduler.activity('t1');
    scheduler.update({ enabled: true, idleMinutes: 1 });
    now += 61_000;
    await scheduler.poll();
    assert.equal(warms, 1, `warm runs after commit (failing=${failing})`);
    // The transcript is already committed and correct; a cold cache is slow, not broken.
    assert.equal(scheduler.state().phase, 'complete', `phase survives a failed warm (failing=${failing})`);
  }
});
