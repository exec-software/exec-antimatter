import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportChatsPage } from '../renderer/src/components/imports/ImportChatsPage';
import { MarkdownContent } from '../renderer/src/components/chat/MarkdownContent';
import { ConversationUiProvider } from '../renderer/src/components/chat/conversationUi';
import { MessageBody } from '../renderer/src/components/chat/MessageBody';
import type { Message } from '../renderer/src/types';

test('import page requires choosing files and reviewing selection, without reading or executing on mount', () => {
  for (const source of ['claude', 'codex', 'opencode'] as const) {
    const html = renderToStaticMarkup(createElement(ImportChatsPage, { source, projects: [{ id: 'inbox', name: 'Inbox', description: '' }], projectId: 'inbox', threadCount: 1, onClose() {}, onOpenThread() {} }));
    assert.match(html, /Choose files/);
    assert.match(html, source === 'opencode' ? /Choose export folder/ : /Choose session folder/);
    if (source === 'opencode') {
      assert.match(html, /Import OpenCode chats/);
      assert.match(html, /opencode export SESSION_ID/);
      assert.match(html, /JSON session export, not the Markdown transcript/);
      assert.match(html, /Raw databases, storage folders, and share URLs are not supported/);
      assert.doesNotMatch(html, /~\/.codex|~\/.claude/);
    }
    assert.match(html, /Originals stay untouched/);
    assert.match(html, /commands never replay/);
    assert.doesNotMatch(html, /Import \d+ selected/);
    assert.doesNotMatch(html, /<iframe|<script|<img/);
  }
});

test('imported markdown images and reference images never produce a resource-loading element', () => {
  const html = renderToStaticMarkup(createElement(ConversationUiProvider, {
    value: { importedHistory: true, activeWorkspace: null, waitingOnAgents: false, reasoning: () => '', openSubagent() {}, openPreview() {} },
  }, createElement(MarkdownContent, { content: '![secret](https://example.invalid/track)\n\n![local][x]\n\n[x]: file:///private/data.png\n\n<script>alert(1)</script>' })));
  assert.match(html, /Imported image: secret/);
  assert.match(html, /Imported image: local/);
  assert.doesNotMatch(html, /<img|<script|src=|example.invalid|file:\/\//);
});

test('imported activity does not invent a work duration, while new turns retain their timing', () => {
  const message: Message = { id: 'history', role: 'assistant', content: 'Done.', meta: {
    sourceName: 'Imported Codex history', createdAt: 1000, finishedAt: 2000,
    tools: [{ callId: 'historical-call', requestId: 'history', serverId: '', serverName: 'Imported', toolName: 'shell_command',
      tier: 'read', status: 'done', args: '{}', result: 'Historical output', contentOffset: 0 }],
  } };
  const render = () => renderToStaticMarkup(createElement(ConversationUiProvider, {
    value: { importedHistory: true, activeWorkspace: null, waitingOnAgents: false, reasoning: () => '', openSubagent() {}, openPreview() {} },
  }, createElement(MessageBody, { message })));
  for (const source of ['Claude', 'Codex', 'OpenCode']) {
    message.meta!.sourceName = `Imported ${source} history`;
    const historical = render();
    assert.match(historical, /Imported activity/);
    assert.doesNotMatch(historical, /Worked for/);
  }
  message.meta!.sourceName = 'My current model';
  assert.match(render(), /Worked for 1s/);
});
