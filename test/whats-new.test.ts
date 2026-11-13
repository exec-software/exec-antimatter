import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { changeLog, WhatsNewPage } from '../renderer/src/components/whatsnew/WhatsNewPage';

test('public release changelog preserves earlier history and accurately scopes inherited capabilities', () => {
  assert.equal(changeLog[0].version, 'v23');
  assert.deepEqual(changeLog.map((entry) => entry.version), ['v23', 'v22', 'v21', 'v3', 'v2', 'v1.0.0', 'v0.1.0-alpha.2', 'v0.1.0-alpha.1']);
  for (const entry of changeLog) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.changes.length > 0);
    assert.equal(new Set(entry.changes).size, entry.changes.length);
    assert.ok(entry.changes.every((change) => change.trim().length > 0));
  }
  assert.match(changeLog.find((entry) => entry.version === 'v3')!.changes.join('\n'), /spell checking/);
  assert.match(changeLog.find((entry) => entry.version === 'v21')!.changes.join('\n'),
    /explicitly selected trusted release folder/);
  const changes = changeLog.find((entry) => entry.version === 'v1.0.0')!.changes.join('\n');
  assert.match(changes, /pending and future/);
  assert.match(changes, /privileged actions still require confirmation/);
  assert.match(changes, /utterance-based and half-duplex/);
  assert.match(changes, /mobile distribution remains a separate testing\/signing track/);
  assert.doesNotMatch(changes, /doctor|3D|realtime speech-to-speech/);
});

test('What\'s New uses the public label and describes idle-gated automatic restart', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { about: { info: { version: '21.0.0', releaseVersion: 'v21' } } } },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const html = renderToStaticMarkup(createElement(WhatsNewPage, { onClose: () => {} }));
  assert.match(html, /v1\.0\.0/);
  assert.match(html, /v2/);
  assert.match(html, /v3/);
  assert.match(html, /v21/);
  assert.equal((html.match(/>Latest</g) ?? []).length, 1);
  assert.match(html, /With automatic updates enabled/);
  assert.match(html, /restarts when active work, voice, and unsaved/);
  assert.match(html, /disable automatic updates in Settings/);
  assert.doesNotMatch(html, /waits for you to choose when to restart/);
});
