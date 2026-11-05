import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as routing from '../src/main/agents/routing';

const scratch = (t: { after(fn: () => unknown): void }) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  routing.useRoot(root);
  return root;
};

test('routing is on before anyone has said otherwise', (t) => {
  scratch(t);
  // An agent nobody dispatches is a roster nobody uses, so the default has to be on. It lives in
  // the reader rather than in a file, because a file nobody has written yet cannot hold a default.
  assert.equal(routing.enabled(), true);
});

test('turning it off survives a restart, and turning it back on works', (t) => {
  const root = scratch(t);
  routing.setEnabled(false);
  assert.equal(routing.enabled(), false);
  assert.equal(readFileSync(join(root, '.routing'), 'utf8').trim(), 'off');

  // A fresh reader sees the same answer: this is the setting someone reached for to stop being
  // surprised, and it not sticking would be the worst version of the bug.
  routing.useRoot(root);
  assert.equal(routing.enabled(), false);

  routing.setEnabled(true);
  assert.equal(routing.enabled(), true);
});

test('an unreadable marker is treated as on rather than as broken', (t) => {
  const root = scratch(t);
  writeFileSync(join(root, '.routing'), 'something nobody wrote on purpose\n');
  assert.equal(routing.enabled(), true, 'only an explicit "off" turns it off');
});
