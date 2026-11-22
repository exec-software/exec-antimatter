import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { detectTestRun, livesInUserState, writePrivateFileAtomic } from '../src/main/privateState';

/**
 * The guard that exists because a write once outlived the redirect meant to contain it.
 *
 * `npm test` gives every child a home of its own, so the refusal can never fire inside this
 * suite — which is exactly why the decision is a pure function and is tested as one.
 */
const live = (path: string, over: Partial<{ underTest: boolean; sandboxedHome: boolean; home: string }> = {}) =>
  livesInUserState(path, { underTest: true, sandboxedHome: false, home: '/home/person', ...over });

test('a test run with the real home refuses writes to live application state', () => {
  assert.equal(live('/home/person/.antimatter/conversations.json'), true);
  assert.equal(live('/home/person/.antimatter'), true);
  assert.equal(live('/home/person/.antimatter/agents/explorer.yaml'), true);
  // Traversal resolves before the comparison, so a path cannot sneak in sideways.
  assert.equal(live('/tmp/x/../../home/person/.antimatter/tasks.json'), true);
});

test('it allows everywhere a test is supposed to write', () => {
  assert.equal(live('/tmp/antimatter-fixture/conversations.json'), false);
  // A sibling whose name merely starts the same way is not inside it.
  assert.equal(live('/home/person/.antimatter-backup/conversations.json'), false);
  assert.equal(live('/home/person/other/conversations.json'), false);
});

test('it stands aside for the application itself, and for a sandboxed run', () => {
  // Production writes here constantly; the guard must never be in that path.
  assert.equal(live('/home/person/.antimatter/conversations.json', { underTest: false }), false);
  // `npm test` points HOME at a temporary directory, so this IS the sandbox.
  assert.equal(live('/home/person/.antimatter/conversations.json', { sandboxedHome: true }), false);
});

test('this suite really is sandboxed, so a default store path is not the real home', () => {
  // Proves the runner's redirect reached this child rather than only being configured.
  assert.equal(process.env.ANTIMATTER_TEST_HOME, homedir(),
    'npm test should give each child a home of its own; run the suite with npm test');
  assert.notEqual(homedir(), '/home/nathan');
});

test('a sandboxed write still works, so the guard has not broken the stores', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-private-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, '.antimatter', 'conversations.json');
  writePrivateFileAtomic(path, '{"ok":true}\n');
  assert.equal(readFileSync(path, 'utf8'), '{"ok":true}\n');
});

/**
 * The detection, against the process shapes actually observed rather than assumed ones.
 *
 * The first version of this guard tested `process.argv` for `--test`, which is true for
 * `node --test` and false for `tsx --test` — the loader has consumed it before any test runs. It
 * therefore did not fire, and wrote into a real home directory. These are the recorded shapes.
 */
test('a test run is recognised through a loader that has eaten the flag', () => {
  // Observed under `npx tsx --test file.test.ts`: no flag anywhere, NODE_TEST_CONTEXT present.
  const tsx = detectTestRun({ NODE_TEST_CONTEXT: 'child-v8' }, ['/usr/bin/node', 'file.test.ts'], []);
  assert.deepEqual(tsx, { underTest: true, sandboxedHome: false });

  // Plain `node --test`.
  const bare = detectTestRun({}, ['/usr/bin/node', '--test', 'file.test.ts'], []);
  assert.deepEqual(bare, { underTest: true, sandboxedHome: false });
  assert.equal(detectTestRun({}, ['/usr/bin/node'], ['--test']).underTest, true);

  // `npm test`: a plain child with no flag and no NODE_TEST_CONTEXT, given a home of its own.
  const sandboxed = detectTestRun({ ANTIMATTER_TEST_HOME: '/tmp/home-x' }, ['/usr/bin/node', 'f.test.js'], []);
  assert.deepEqual(sandboxed, { underTest: true, sandboxedHome: true });

  // The application itself.
  assert.deepEqual(detectTestRun({}, ['/usr/bin/electron', '.'], []), { underTest: false, sandboxedHome: false });
});
