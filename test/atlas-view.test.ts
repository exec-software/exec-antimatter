import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message, ToolActivity } from '../renderer/src/types';
import { atlasExchanges, atlasExcerpt, atlasMessageMatches, atlasSpeaker } from '../renderer/src/components/views/atlas';

const message = (id: string, role: Message['role'], content = id): Message => ({ id, role, content });
const action: ToolActivity = { callId: 'call', requestId: 'assistant', serverId: 'builtin', serverName: 'Workspace', toolName: 'read_file', tier: 'read', args: '{"path":"target.ny"}', result: 'Recorded result', status: 'done' };

test('Atlas preserves every message and its identity across exchanges, including leading and consecutive messages', () => {
  const messages = [message('context', 'system'), message('opening', 'assistant'), message('one', 'user'), message('reply', 'assistant'),
    message('second reply', 'assistant'), message('two', 'user'), message('three', 'user')];
  messages[3].meta = { createdAt: 1, tools: [action] };
  messages[2].attachments = [{ id: 'file', name: 'diagram.txt', content: 'A diagram', size: 20 }];
  const original = JSON.stringify(messages);
  const groups = atlasExchanges(messages);
  assert.deepEqual(groups.map((group) => group.messages.map((entry) => entry.id)), [['context', 'opening'], ['one', 'reply', 'second reply'], ['two'], ['three']]);
  assert.deepEqual(groups.map((group) => group.number), [1, 2, 3, 4]);
  assert.equal(groups[1].actions, 1); assert.equal(groups[1].attachments, 1);
  assert.equal(groups[1].messages[1], messages[3]);
  assert.deepEqual(groups.flatMap((group) => group.messages), messages);
  assert.equal(JSON.stringify(messages), original);
  assert.deepEqual(atlasExchanges([]), []);
});

test('Atlas excerpts and search use recorded text, attachment names, and tool details without generating summaries', () => {
  const plain = message('one', 'user', '  Exact words\n remain here.  ');
  assert.equal(atlasExcerpt(plain), 'Exact words remain here.');
  assert.equal(atlasExcerpt(message('long', 'user', 'x'.repeat(300))).length, 160);
  assert.ok(atlasMessageMatches(plain, '  EXACT WORDS  '));
  const file = { ...message('file', 'user', ''), attachments: [{ id: 'f', name: 'diagram.txt', content: 'A diagram', size: 20 }] };
  assert.equal(atlasExcerpt(file), 'diagram.txt'); assert.ok(atlasMessageMatches(file, 'DIAGRAM'));
  const tool = { ...message('assistant', 'assistant', ''), meta: { createdAt: 1, tools: [action] } };
  assert.equal(atlasExcerpt(tool), 'read_file');
  for (const query of ['read_file', 'target.ny', 'recorded result']) assert.ok(atlasMessageMatches(tool, query));
  assert.equal(atlasMessageMatches(tool, 'invented answer'), false);
  assert.equal(atlasExcerpt(message('empty', 'assistant', '')), 'No text recorded');
  assert.equal(atlasSpeaker(tool, 'Nova'), 'Nova'); assert.equal(atlasSpeaker(plain, 'Nova'), 'You');
  assert.equal(atlasSpeaker(message('context', 'system'), 'Nova'), 'Context');
});
