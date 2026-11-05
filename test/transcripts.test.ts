import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Message } from '../src/api/types';
import { clear, location, remember, remove, removePrefix, resume, useRoot } from '../src/main/transcripts';

const expanded: Message[] = [
  { id: 'grounding', role: 'system', content: 'grounded' },
  { id: 'user-1', role: 'user', content: 'inspect it' },
  {
    id: 'assistant-internal',
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'antimatter__read_file', arguments: '{}' } }],
  },
  { id: 'call-1', role: 'tool', toolCallId: 'call-1', name: 'antimatter__read_file', content: 'contents' },
  { id: 'assistant-final-internal', role: 'assistant', content: 'Found it.' },
];

const originalRoot = location();

test.beforeEach((t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-transcripts-'));
  useRoot(root);
  t.after(() => {
    useRoot(originalRoot);
    rmSync(root, { recursive: true, force: true });
  });
});

test('resumes hidden tool history through the visible assistant alias', () => {
  remember('thread-1', expanded, ['user-1', 'visible-answer-1']);
  const next = resume('thread-1', [
    { id: 'user-1', role: 'user', content: 'inspect it' },
    { id: 'visible-answer-1', role: 'assistant', content: 'Found it.' },
    { id: 'user-2', role: 'user', content: 'continue' },
  ]);

  assert.deepEqual(next, [...expanded, { id: 'user-2', role: 'user', content: 'continue' }]);
  assert.ok(next?.some((message) => message.role === 'tool' && message.content === 'contents'));
});

test('supports a response id that differs from the request/run id', () => {
  remember('avatar', expanded, ['core-system', 'run-1', 'run-1-answer']);
  assert.ok(
    resume('avatar', [
      { id: 'core-system', role: 'system', content: 'persona' },
      { id: 'run-1', role: 'user', content: 'look' },
      { id: 'run-1-answer', role: 'assistant', content: 'done' },
      { id: 'run-2', role: 'user', content: 'again' },
    ])
  );
});

test('restores live assistant text that arrived after the latest durable checkpoint', () => {
  const beforeResponse: Message[] = expanded.slice(0, 2);
  remember('live', beforeResponse, ['user-1', 'response-live'], [['response-live', '']]);
  clear();

  const next = resume('live', [
    { id: 'user-1', role: 'user', content: 'inspect it' },
    { id: 'response-live', role: 'assistant', content: 'A partial answer survived in the renderer.' },
    { id: 'user-2', role: 'user', content: 'continue after restart' },
  ]);

  assert.deepEqual(next, [
    ...beforeResponse,
    { id: 'response-live', role: 'assistant', content: 'A partial answer survived in the renderer.' },
    { id: 'user-2', role: 'user', content: 'continue after restart' },
  ]);
});

test('restores only the live suffix that was not already represented by tool history', () => {
  const checkpointed: Message[] = [
    ...expanded.slice(0, 2),
    { id: 'assistant-round', role: 'assistant', content: 'First part.' },
  ];
  remember('live', checkpointed, ['user-1', 'response-live'], [['response-live', 'First part.\n\n']]);
  clear();

  const next = resume('live', [
    { id: 'user-1', role: 'user', content: 'inspect it' },
    { id: 'response-live', role: 'assistant', content: 'First part.\n\nSecond partial.' },
    { id: 'user-2', role: 'user', content: 'continue after restart' },
  ]);

  assert.deepEqual(next, [
    ...checkpointed,
    { id: 'response-live', role: 'assistant', content: 'Second partial.' },
    { id: 'user-2', role: 'user', content: 'continue after restart' },
  ]);
});

test('rejects unknown visible history and other threads', () => {
  remember('thread-1', expanded, ['user-1', 'visible-answer-1']);
  const incoming: Message[] = [
    { id: 'unknown', role: 'user', content: 'edited history' },
    { id: 'user-2', role: 'user', content: 'continue' },
  ];
  assert.equal(resume('thread-1', incoming), null);
  assert.equal(resume('thread-2', incoming), null);
});

test('restores expanded tool history after the in-memory cache is lost', () => {
  remember('thread-1', expanded, ['user-1', 'visible-answer-1']);
  clear();

  const next = resume('thread-1', [
    { id: 'user-1', role: 'user', content: 'inspect it' },
    { id: 'visible-answer-1', role: 'assistant', content: 'Found it.' },
    { id: 'user-2', role: 'user', content: 'continue after restart' },
  ]);

  assert.deepEqual(next, [
    ...expanded,
    { id: 'user-2', role: 'user', content: 'continue after restart' },
  ]);
});

test('does not restore a transcript under a different thread id', () => {
  remember('thread-1', expanded, ['user-1']);
  clear();
  assert.equal(
    resume('thread-2', [
      { id: 'user-1', role: 'user', content: 'inspect it' },
      { id: 'user-2', role: 'user', content: 'continue' },
    ]),
    null
  );
});

test('removing a conversation also removes its durable hidden transcript', () => {
  remember('thread-1', expanded, ['user-1']);
  clear();
  remove('thread-1');
  clear();

  assert.equal(
    resume('thread-1', [
      { id: 'user-1', role: 'user', content: 'inspect it' },
      { id: 'user-2', role: 'user', content: 'continue' },
    ]),
    null
  );
});

test('removing a Snitch item prefix deletes every stage generation and nothing else', () => {
  remember('snitch:Project/BUG-1#fixing@1', expanded, ['user-1']);
  remember('snitch:Project/BUG-1#qa@1', expanded, ['user-1']);
  remember('snitch:Project/BUG-2#fixing@1', expanded, ['user-1']);
  clear();

  removePrefix('snitch:Project/BUG-1#');
  clear();

  const incoming: Message[] = [
    { id: 'user-1', role: 'user', content: 'inspect it' },
    { id: 'user-2', role: 'user', content: 'continue' },
  ];
  assert.equal(resume('snitch:Project/BUG-1#fixing@1', incoming), null);
  assert.equal(resume('snitch:Project/BUG-1#qa@1', incoming), null);
  assert.ok(resume('snitch:Project/BUG-2#fixing@1', incoming));
});
