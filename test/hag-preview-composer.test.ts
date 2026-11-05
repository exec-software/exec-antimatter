import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatComposer } from '../renderer/src/components/chat/ChatComposer';
import { HagPreviewNotice } from '../renderer/src/components/chat/HagPreviewNotice';
import { HAG_SOURCE_ID } from '../src/api/hag';

const props: ComponentProps<typeof ChatComposer> = {
  threadId: 'fixture', onSubmit: () => { throw new Error('Rendering must not send a message.'); },
  providers: [], providerId: HAG_SOURCE_ID, modelId: 'qwen3-0.6b-hag-16k', onOpenModels: () => undefined,
  access: { directory: '/fixture/workspace', mode: 'full' }, onChangeAccess: () => undefined,
  workspace: '/fixture/workspace', workspaceConfirmed: true, onConfirmWorkspace: () => undefined,
  draft: { text: 'A short question', attachments: [] },
};
const render = (patch: Partial<typeof props>) => renderToStaticMarkup(createElement(ChatComposer, { ...props, ...patch }));
const attrs = (html: string, label: string) => {
  const match = [...html.matchAll(/<button([^>]*)>/g)].find((entry) => entry[1].includes(`aria-label="${label}"`));
  assert.ok(match, `Expected ${label} button`);
  return match[1];
};

test('HAG text composer exposes its preview policy and cannot suggest tools or new file attachments', () => {
  const html = render({ textOnly: true, sourceNotice: createElement(HagPreviewNotice, { sourceId: HAG_SOURCE_ID }) });
  assert.match(html, /HAG text preview/);
  assert.match(attrs(html, 'Add files'), / disabled=""/);
  assert.doesNotMatch(html, /Permissions:|Tools work inside:|Full access/);
  assert.doesNotMatch(attrs(html, 'Send message'), / disabled=""/);
});

test('switching to text-only preview preserves attached drafts and requires an explicit resolution', () => {
  const html = render({ textOnly: true, draft: { text: 'Keep this draft', attachments: [{ id: 'a', name: 'notes.txt', content: 'file body', size: 9 }] } });
  assert.match(html, /Keep this draft/);
  assert.match(html, /notes.txt/);
  assert.match(html, /Remove the attached files to use this text-only preview, or choose another model/);
  assert.match(attrs(html, 'Send message'), / disabled=""/);
});

test('ordinary model composers retain permissions, file attachments and submission behavior', () => {
  const html = render({ providerId: 'local-openmythos-27b', textOnly: false });
  assert.match(html, /Permissions: Full access/);
  assert.doesNotMatch(attrs(html, 'Add files'), / disabled=""/);
  assert.doesNotMatch(attrs(html, 'Send message'), / disabled=""/);
  assert.doesNotMatch(html, /HAG text preview|text-only preview/);
});
