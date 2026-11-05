import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { changeLog, WhatsNewPage } from '../renderer/src/components/whatsnew/WhatsNewPage';

test('v3 changelog keeps v2, v1 and alpha history and accurately scopes inherited capabilities', () => {
  assert.equal(changeLog[0].version, 'v3');
  assert.deepEqual(changeLog.map((entry) => entry.version), ['v3', 'v2', 'v1.0.0', 'v0.1.0-alpha.2', 'v0.1.0-alpha.1']);
  for (const entry of changeLog) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.changes.length > 0);
    assert.equal(new Set(entry.changes).size, entry.changes.length);
    assert.ok(entry.changes.every((change) => change.trim().length > 0));
  }
  assert.match(changeLog[0].changes.join('\n'), /spell checking/);
  const changes = changeLog.find((entry) => entry.version === 'v1.0.0')!.changes.join('\n');
  assert.match(changes, /pending and future/);
  assert.match(changes, /privileged actions still require confirmation/);
  assert.match(changes, /utterance-based and half-duplex/);
  assert.match(changes, /mobile distribution remains a separate testing\/signing track/);
  assert.doesNotMatch(changes, /doctor|3D|realtime speech-to-speech/);
});

test('v3 What\'s New uses the public label and describes idle-gated automatic restart', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { about: { info: { version: '3.0.0', releaseVersion: 'v3' } } } },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const html = renderToStaticMarkup(createElement(WhatsNewPage, { onClose: () => {} }));
  assert.match(html, /v1\.0\.0/);
  assert.match(html, /v2/);
  assert.match(html, /v3/);
  assert.equal((html.match(/>Latest</g) ?? []).length, 1);
  assert.match(html, /With automatic updates enabled/);
  assert.match(html, /restarts when active work, voice, and unsaved/);
  assert.match(html, /disable automatic updates in Settings/);
  assert.doesNotMatch(html, /waits for you to choose when to restart/);
});
