import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WhiteboardPage } from '../renderer/src/components/whiteboard/WhiteboardPage';

/**
 * The board needs its preload namespace, so these stub it.
 *
 * An unstubbed `electronAPI` namespace is a known trap here: the page degrades to "restart
 * Antimatter" and the assertions fail far from the cause. The absent case has its own test in
 * stale-preload.test.ts rather than being the accidental default everywhere.
 */
const render = (props: Partial<Parameters<typeof WhiteboardPage>[0]> = {}) => {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    electronAPI: { whiteboard: { get: async () => ({ version: 1, threadId: 't', objects: [], updatedAt: '' }), edit: async () => ({}) } },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  try {
    return renderToStaticMarkup(createElement(WhiteboardPage, {
      threadId: 'thread-1', threadTitle: 'Planning the library', onLeave: () => {}, ...props,
    }));
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
};

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

test('the way out is labelled, because this is a full page reached from a launcher', () => {
  // Reported as "now that's all I see": an unlabelled X icon is not a visible exit to someone
  // who opened the board by accident, and the page fills the content area.
  const markup = render();
  assert.match(markup, /Back to chat/);
});
