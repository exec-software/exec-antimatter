import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeskMenu, deskApps } from '../renderer/src/components/layout/DeskMenu';

const render = (props: Partial<Parameters<typeof DeskMenu>[0]> = {}) =>
  renderToStaticMarkup(createElement(DeskMenu, {
    page: 'chat',
    visibility: { comms: true, email: true, whiteboard: true },
    onChangePage: () => {},
    rowClass: 'row',
    active: false,
    ...props,
  }));

test('the launcher holds the applications, and the navigation no longer lists them', () => {
  const markup = render();
  assert.match(markup, /aria-label="Desk"/);
  assert.match(markup, /aria-haspopup="menu"/);
  // Closed by default: a footer button, not a panel that opens itself.
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /role="menu"/);
});

test('an app switched off leaves no gap, and none at all removes the launcher', () => {
  assert.deepEqual(deskApps({ comms: true, email: true }).map((app) => app.page), ['comms', 'email']);
  assert.deepEqual(deskApps({ comms: false, email: true }).map((app) => app.page), ['email']);
  // Absent means on for a sidebar preference, matching how the other flags read.
  assert.deepEqual(deskApps({}).map((app) => app.page), ['comms', 'email']);
  assert.deepEqual(deskApps({ comms: false, email: false }), []);
  // An empty grid reads as broken rather than off, so there is nothing to open.
  assert.equal(render({ visibility: { comms: false, email: false } }), '');
});

test('the whiteboard is an experiment, so absent unless explicitly on', () => {
  // The opposite default to the others: theirs is a preference that happens to be on, this is a
  // flag that has to be chosen.
  assert.ok(!deskApps({}).some((app) => app.page === 'whiteboard'));
  assert.ok(!deskApps({ whiteboard: false }).some((app) => app.page === 'whiteboard'));
  assert.deepEqual(
    deskApps({ whiteboard: true }).map((app) => app.page),
    ['comms', 'email', 'whiteboard']
  );
  // On its own it is enough to give the launcher a reason to exist.
  assert.notEqual(render({ visibility: { comms: false, email: false, whiteboard: true } }), '');
});

test('the launcher shows itself as current while one of its apps is the page', () => {
  // Otherwise opening Email leaves the whole footer looking unselected, and nothing on screen
  // says where you are.
  assert.match(render({ page: 'email', active: true }), /bg-primary\/10 text-primary/);
  assert.match(render({ page: 'whiteboard', active: true }), /bg-primary\/10 text-primary/);
  assert.doesNotMatch(render({ page: 'chat', active: false }), /bg-primary\/10 text-primary/);
});
