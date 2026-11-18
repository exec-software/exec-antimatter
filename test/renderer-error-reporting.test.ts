import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describeThrown, reportRendererError } from '../renderer/src/lib/reportRendererError';
import { PageErrorBoundary, PageErrorFallback } from '../renderer/src/components/PageErrorBoundary';

/**
 * A renderer failure has to name itself.
 *
 * There was no window.onerror, no unhandled-rejection handler and no error boundary, so a
 * component that threw unmounted its subtree and left a hole carrying no information. That turned
 * one bug into three wrong hypotheses, because the shape of the hole was the only evidence.
 */

test('whatever was thrown becomes something a log can carry', () => {
  const error = new Error('orderGet is not a function');
  const described = describeThrown(error);
  assert.equal(described.message, 'orderGet is not a function');
  assert.ok(described.stack?.includes('Error'));
  // A string, an object and a null are all things React will hand a boundary.
  assert.equal(describeThrown('plain string').message, 'plain string');
  assert.equal(describeThrown({ code: 'EBADF' }).message, '{"code":"EBADF"}');
  assert.equal(describeThrown(null).message, 'null');
  // An unnamed Error still reports something.
  assert.equal(describeThrown(new Error()).message, 'Error');
});

test('reporting never throws, even when the report cannot be delivered', (t) => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  t.after(() => { console.error = previousError; (globalThis as { window?: unknown }).window = previousWindow; });

  // An older preload has no reportError at all, which is the case this was written for.
  (globalThis as { window?: unknown }).window = { electronAPI: {} };
  assert.doesNotThrow(() => reportRendererError({ source: 'boundary', message: 'boom' }));
  // A preload whose reportError itself throws must not replace a diagnosable crash with a worse one.
  (globalThis as { window?: unknown }).window = { electronAPI: { reportError: () => { throw new Error('ipc gone'); } } };
  assert.doesNotThrow(() => reportRendererError({ source: 'window', message: 'boom' }));
  // Either way the console still has it: that is the last place left to look.
  assert.equal(logged.length, 2);
  assert.match(String(logged[0][0]), /renderer:boundary/);
});

test('a broken view is replaced by the error, not by a blank hole', () => {
  // The fallback is rendered directly: React only runs error boundaries on the client, so the
  // static renderer cannot exercise the catch. getDerivedStateFromError is checked separately.
  const markup = renderToStaticMarkup(createElement(PageErrorFallback, {
    message: 'orderGet is not a function',
    componentStack: '\n    in ModelLibrary (at App.tsx:1920)',
    onLeave: () => {},
  }));
  assert.match(markup, /This view stopped working/);
  // The message itself, because "something went wrong" is what sent me guessing three times.
  assert.match(markup, /orderGet is not a function/);
  // And a way out, since the window is otherwise stuck on whatever broke.
  assert.match(markup, /Back to chat/);
  assert.match(markup, /Reload the window/);
  // The component stack is what actually locates the failure.
  assert.match(markup, /in ModelLibrary/);
});

test('the boundary turns a throw into that message', () => {
  // The one piece of the catch path that is testable without a DOM.
  assert.deepEqual(
    PageErrorBoundary.getDerivedStateFromError(new Error('orderGet is not a function')),
    { message: 'orderGet is not a function' }
  );
});

test('a view that works is passed through untouched', () => {
  const Fine = () => createElement('p', null, 'the real page');
  const markup = renderToStaticMarkup(createElement(PageErrorBoundary, {}, createElement(Fine)));
  assert.equal(markup, '<p>the real page</p>');
});
