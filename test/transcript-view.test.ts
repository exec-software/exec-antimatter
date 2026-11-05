import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareMarkdownFragment } from '../renderer/src/lib/markdown';
import {
  buildTranscriptParts,
  mergeToolActivity,
  settleRestoredToolActivities,
  toolActivitySummary,
  type TranscriptPart,
} from '../renderer/src/lib/transcript';
import type { ToolActivity } from '../renderer/src/types';

function activity(
  activityId: string | undefined,
  callId: string,
  status: ToolActivity['status'],
  overrides: Partial<ToolActivity> = {}
): ToolActivity {
  return {
    callId,
    ...(activityId ? { activityId } : {}),
    requestId: 'assistant-1',
    serverId: 'antimatter',
    serverName: 'Antimatter tools',
    toolName: 'read_file',
    tier: 'read',
    args: '{"path":"README.md"}',
    status,
    ...overrides,
  };
}

function simplify(parts: TranscriptPart[]) {
  return parts.map((part) =>
    part.kind === 'text'
      ? ['text', part.text]
      : [
          'tools',
          part.legacy === true ? 'legacy' : part.offset,
          part.tools.map((tool) => [tool.activityId ?? tool.callId, tool.status, tool.result]),
        ]
  );
}

test('interleaves accumulated prose with tool occurrences at their first-seen offsets', () => {
  const content = 'Before.After.Done.';
  let tools: ToolActivity[] = [];

  tools = mergeToolActivity(tools, activity('occ-a', 'call-a', 'pending'), 7);
  tools = mergeToolActivity(tools, activity('occ-a', 'call-a', 'done', { result: 'read result' }), content.length);
  tools = mergeToolActivity(tools, activity('occ-b', 'call-b', 'pending', { toolName: 'write_file' }), 13);
  tools = mergeToolActivity(
    tools,
    activity('occ-b', 'call-b', 'done', { toolName: 'write_file', result: 'write result' }),
    content.length
  );

  const parts = buildTranscriptParts(content, tools);
  assert.deepEqual(simplify(parts), [
    ['text', 'Before.'],
    ['tools', 7, [['occ-a', 'done', 'read result']]],
    ['text', 'After.'],
    ['tools', 13, [['occ-b', 'done', 'write result']]],
    ['text', 'Done.'],
  ]);
  assert.equal(
    parts.filter((part) => part.kind === 'text').map((part) => part.text).join(''),
    content
  );
});

test('consecutive streaming chunks remain one text span on each side of a tool', () => {
  let content = '';
  content += 'Be';
  content += 'fore.';
  let tools = mergeToolActivity([], activity('occ-a', 'call-a', 'pending'), content.length);
  tools = mergeToolActivity(tools, activity('occ-a', 'call-a', 'done', { result: 'ok' }), content.length);
  content += 'Af';
  content += 'ter.';

  assert.deepEqual(simplify(buildTranscriptParts(content, tools)), [
    ['text', 'Before.'],
    ['tools', 7, [['occ-a', 'done', 'ok']]],
    ['text', 'After.'],
  ]);
});

test('distinct activity ids keep repeated provider call ids as separate occurrences', () => {
  let tools: ToolActivity[] = [];
  tools = mergeToolActivity(tools, activity('0:0:call_0', 'call_0', 'pending'), 1);
  tools = mergeToolActivity(tools, activity('0:0:call_0', 'call_0', 'done', { result: 'first' }), 3);
  tools = mergeToolActivity(tools, activity('1:0:call_0', 'call_0', 'pending'), 2);
  tools = mergeToolActivity(tools, activity('1:0:call_0', 'call_0', 'done', { result: 'second' }), 3);

  assert.deepEqual(
    tools.map(({ activityId, callId, contentOffset, status, result }) => ({
      activityId,
      callId,
      contentOffset,
      status,
      result,
    })),
    [
      { activityId: '0:0:call_0', callId: 'call_0', contentOffset: 1, status: 'done', result: 'first' },
      { activityId: '1:0:call_0', callId: 'call_0', contentOffset: 2, status: 'done', result: 'second' },
    ]
  );
  assert.deepEqual(simplify(buildTranscriptParts('ABC', tools)), [
    ['text', 'A'],
    ['tools', 1, [['0:0:call_0', 'done', 'first']]],
    ['text', 'B'],
    ['tools', 2, [['1:0:call_0', 'done', 'second']]],
    ['text', 'C'],
  ]);
});

test('completion updates one card in place and retains its first anchor and approval id', () => {
  const pending = activity('occ-a', 'same-call', 'pending', {
    approvalId: 'run:occ-a',
    awaitingApproval: true,
  });
  let tools = mergeToolActivity([], pending, 7);
  tools = mergeToolActivity(
    tools,
    activity('occ-a', 'same-call', 'done', { awaitingApproval: false, result: 'ok' }),
    99
  );

  assert.equal(tools.length, 1);
  assert.equal(tools[0].contentOffset, 7);
  assert.equal(tools[0].approvalId, 'run:occ-a');
  assert.equal(tools[0].awaitingApproval, false);
  assert.equal(tools[0].status, 'done');
  assert.equal(tools[0].result, 'ok');
});

test('uses the main-process anchor when IPC text has already advanced', () => {
  const tools = mergeToolActivity(
    [],
    activity('occ-a', 'call-a', 'pending', { contentOffset: 7 }),
    19
  );

  assert.equal(tools[0].contentOffset, 7);
  assert.deepEqual(simplify(buildTranscriptParts('Before.After.Done.', tools)), [
    ['text', 'Before.'],
    ['tools', 7, [['occ-a', 'pending', undefined]]],
    ['text', 'After.Done.'],
  ]);
});

test('groups tools sharing an offset in first-seen order', () => {
  const tools = [
    { ...activity('occ-a', 'call-a', 'done'), contentOffset: 7 },
    { ...activity('occ-b', 'call-b', 'failed'), contentOffset: 7 },
  ];

  assert.deepEqual(simplify(buildTranscriptParts('Before.After', tools)), [
    ['text', 'Before.'],
    [
      'tools',
      7,
      [
        ['occ-a', 'done', undefined],
        ['occ-b', 'failed', undefined],
      ],
    ],
    ['text', 'After'],
  ]);
});

test('clamps positioned offsets without losing text and collects legacy tools at the end', () => {
  const before = activity('before', 'call-before', 'done', { contentOffset: -20 });
  const after = activity('after', 'call-after', 'done', { contentOffset: 999 });
  const missing = activity(undefined, 'legacy-missing', 'done');
  const nonFinite = activity('legacy-nan', 'legacy-nan', 'failed', { contentOffset: Number.NaN });
  const content = 'abc';
  const parts = buildTranscriptParts(content, [missing, after, nonFinite, before]);

  assert.deepEqual(simplify(parts), [
    ['tools', 0, [['before', 'done', undefined]]],
    ['text', 'abc'],
    ['tools', 3, [['after', 'done', undefined]]],
    [
      'tools',
      'legacy',
      [
        ['legacy-missing', 'done', undefined],
        ['legacy-nan', 'failed', undefined],
      ],
    ],
  ]);
  assert.equal(
    parts.filter((part) => part.kind === 'text').map((part) => part.text).join(''),
    content
  );
});

test('legacy tools survive a JSON round trip without invented chronology', () => {
  const stored = JSON.stringify({
    id: 'assistant-legacy',
    role: 'assistant',
    content: 'Legacy answer.',
    meta: { createdAt: 1, tools: [activity(undefined, 'legacy-call', 'done', { result: 'old result' })] },
  });
  const restored = JSON.parse(stored) as {
    content: string;
    meta: { tools: ToolActivity[] };
  };

  assert.deepEqual(simplify(buildTranscriptParts(restored.content, restored.meta.tools)), [
    ['text', 'Legacy answer.'],
    ['tools', 'legacy', [['legacy-call', 'done', 'old result']]],
  ]);
  assert.equal(Object.hasOwn(restored.meta.tools[0], 'contentOffset'), false);
});

test('restored unfinished tools become non-actionable interrupted history', () => {
  const done = activity('done', 'done', 'done', { result: 'ok' });
  const settled = settleRestoredToolActivities([
    activity('approval', 'approval', 'pending', { awaitingApproval: true }),
    activity('running', 'running', 'running'),
    done,
  ]);

  assert.deepEqual(
    settled.map(({ status, awaitingApproval, result }) => ({ status, awaitingApproval, result })),
    [
      { status: 'failed', awaitingApproval: false, result: 'Interrupted before this action finished.' },
      { status: 'failed', awaitingApproval: false, result: 'Interrupted before this action finished.' },
      { status: 'done', awaitingApproval: undefined, result: 'ok' },
    ]
  );
  assert.equal(settled[2], done);
  assert.equal(settleRestoredToolActivities([done])[0], done);
});

test('summarizes common tools defensively for collapsed activity rows', () => {
  assert.equal(
    toolActivitySummary(activity('shell', 'shell', 'running', {
      toolName: 'antimatter__run_command',
      args: '{"command":"npm   test\\n-- --runInBand"}',
    })),
    'Run npm test -- --runInBand'
  );
  assert.equal(
    toolActivitySummary(activity('search', 'search', 'done', {
      toolName: 'search_text',
      args: '{"query":"contentOffset","path":"renderer/src"}',
    })),
    'Search for contentOffset in renderer/src'
  );
  assert.equal(
    toolActivitySummary(activity('unknown', 'unknown', 'failed', {
      toolName: 'vendor__mystery_tool',
      args: '{not-json}',
    })),
    'Mystery tool'
  );
});

test('keeps both sides of a tool boundary inside their fenced code language', () => {
  const content = ['```ts', 'const before = true;', 'const after = true;', '```', '', 'Done.'].join('\n');
  const boundary = content.indexOf('const after');

  assert.equal(
    prepareMarkdownFragment(content, 0, boundary),
    ['```ts', 'const before = true;', '```'].join('\n')
  );
  assert.equal(
    prepareMarkdownFragment(content, boundary, content.length),
    ['```ts', 'const after = true;', '```', '', 'Done.'].join('\n')
  );
});

test('does not add synthetic fences to ordinary prose slices', () => {
  const content = 'Before.\n\n- one\n- two\n\nAfter.';
  assert.equal(prepareMarkdownFragment(content, 8, content.length), content.slice(8));
});

test('anchors past the end of the text stay a sequence instead of piling up at the end', () => {
  // What a transcript looked like while the renderer was losing streamed text to its own
  // checkpoint conflicts: anchors recorded against prose the stored message no longer has.
  // Clamping them first put every one of these calls in a single block after the last word.
  const tools = [
    activity('occ-a', 'call-a', 'done', { contentOffset: 4 }),
    activity('occ-b', 'call-b', 'done', { contentOffset: 40 }),
    activity('occ-c', 'call-c', 'done', { contentOffset: 90 }),
  ];

  assert.deepEqual(simplify(buildTranscriptParts('Read.', tools)), [
    ['text', 'Read'],
    ['tools', 4, [['occ-a', 'done', undefined]]],
    ['text', '.'],
    ['tools', 5, [['occ-b', 'done', undefined]]],
    ['tools', 5, [['occ-c', 'done', undefined]]],
  ]);
});
