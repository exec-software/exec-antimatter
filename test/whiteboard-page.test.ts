import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WhiteboardPage } from '../renderer/src/components/whiteboard/WhiteboardPage';

const render = (props: Partial<Parameters<typeof WhiteboardPage>[0]> = {}) =>
  renderToStaticMarkup(createElement(WhiteboardPage, {
    threadId: 'thread-1', threadTitle: 'Planning the library', onLeave: () => {}, ...props,
  }));

test('with no conversation there is no board to show, and it says so', () => {
  // A board is per conversation, so this is a real state rather than an error: the page is
  // reachable before a chat exists.
  const markup = render({ threadId: null });
  assert.match(markup, /Open a conversation to use its whiteboard/);
  assert.doesNotMatch(markup, /Whiteboard surface/);
});

test('the surface is announced, and an empty board says how to start', () => {
  // No electronAPI is stubbed, so the initial read fails and this is the pre-load paint: it must
  // still be a usable, labelled surface rather than a blank rectangle.
  const markup = render();
  assert.match(markup, /role="application"/);
  assert.match(markup, /aria-label="Whiteboard surface"/);
  assert.match(markup, /Double-click anywhere to start a note/);
  assert.match(markup, /Planning the library/);
});

test('the conversation it belongs to is named, so two boards are never confused', () => {
  assert.match(render({ threadTitle: 'Auth rework' }), /Auth rework/);
  assert.doesNotMatch(render({ threadTitle: 'Auth rework' }), /Planning the library/);
});
