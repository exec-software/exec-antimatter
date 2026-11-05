import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FlowView } from '../renderer/src/components/views/FlowView';
import { flowGroups, flowTurns } from '../renderer/src/lib/flow';
import type { Message, ToolActivity } from '../renderer/src/types';

const activity = (id: string, status: ToolActivity['status'], extra: Partial<ToolActivity> = {}): ToolActivity => ({
  callId: 'reused', activityId: id, requestId: 'run', serverId: 'workspace', serverName: 'Workspace',
  toolName: 'write_file', tier: 'write', args: '{"path":"main.ny"}', status, ...extra,
});

test('Flow separates live approval, running agent, failure and completion without collapsing repeated call ids', () => {
  const tools = [activity('approve', 'pending', { awaitingApproval: true }), activity('run', 'running'),
    activity('agent', 'done', { toolName: 'start_agent', subagent: { taskId: 't', agentId: 'a', agentName: 'Ada', title: 'Review' } }),
    activity('fail', 'failed'), activity('declined', 'denied'), activity('complete', 'done')];
  const groups = flowGroups(tools, true);
  assert.deepEqual(groups.approval.map((tool) => tool.activityId), ['approve']);
  assert.deepEqual(groups.working.map((tool) => tool.activityId), ['run', 'agent']);
  assert.deepEqual(groups.review.map((tool) => tool.activityId), ['fail', 'declined']);
  assert.deepEqual(groups.done.map((tool) => tool.activityId), ['complete']);
  const historical = flowGroups(tools, false);
  assert.equal(historical.approval.length, 0);
  assert.equal(historical.working.length, 0);
  assert.equal(historical.review.length, 5);
  assert.equal(tools[0].status, 'pending');
});

test('Flow request labels use actual prompts or attachment names and include consecutive assistant replies', () => {
  const messages: Message[] = [{ id: 'user', role: 'user', content: '', attachments: [{ id: 'f', name: 'main.ny', content: '', size: 3 }] },
    { id: 'a', role: 'assistant', content: 'First' }, { id: 'b', role: 'assistant', content: 'Second' }];
  assert.deepEqual(flowTurns(messages).map((turn) => [turn.index, turn.prompt]), [[1, 'main.ny'], [2, 'main.ny']]);
});

test('Flow displays approval controls once in the board and never for a historical reply', () => {
  const messages: Message[] = [{ id: 'q', role: 'user', content: 'Fix the parser' },
    { id: 'reply', role: 'assistant', content: 'I can update it.', meta: { tools: [activity('approve', 'pending', { awaitingApproval: true, contentOffset: 5 })] } }];
  const render = (isStreaming: boolean) => renderToStaticMarkup(createElement(FlowView, { messages, isStreaming, pinnedMessageIds: new Set<string>(), onTogglePin() {} }));
  const active = render(true);
  assert.equal((active.match(/>Allow</g) ?? []).length, 1);
  assert.equal((active.match(/>Decline</g) ?? []).length, 1);
  assert.match(active, /I can update it/);
  const history = render(false);
  assert.doesNotMatch(history, />Allow<|>Decline</);
  assert.match(history, /Interrupted/);
});
