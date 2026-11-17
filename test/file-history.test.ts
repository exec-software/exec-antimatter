import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ANTIMATTER_DIR,
  MAX_CAPTURE_BYTES,
  antimatterDir,
  blobsDir,
  captureBeforeWrite,
  ensureWorkspaceHistory,
  forgetHistoryState,
  historyEnabled,
  pruneHistory,
  readTimeline,
  readVersion,
  scratchDir,
  versionsOf,
  versionsOfTurn,
} from '../src/api/fileHistory';
import { DEFAULT_FILE_HISTORY, normalizeFileHistory } from '../src/main/developerSettings';
import { TURN_CONTEXT_TOOL_ARGUMENT, CREATE_ONLY_TOOL_ARGUMENT } from '../src/api/toolArguments';
import { toolArgumentsForTransport } from '../src/main/mcp';
import { BUILTIN_ID } from '../src/main/mcpStore';

function workspace(t: test.TestContext, enable = true) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-history-'));
  t.after(() => {
    forgetHistoryState(root);
    rmSync(root, { recursive: true, force: true });
  });
  if (enable) ensureWorkspaceHistory(root);
  forgetHistoryState(root);
  return root;
}

test('off by default, and off means nothing is created or captured', (t) => {
  assert.deepEqual(DEFAULT_FILE_HISTORY, { enabled: false });
  assert.deepEqual(normalizeFileHistory(undefined), { enabled: false });
  assert.deepEqual(normalizeFileHistory({ enabled: 'yes' }), { enabled: false });

  const root = workspace(t, false);
  const file = join(root, 'app.ts');
  writeFileSync(file, 'original');
  assert.equal(historyEnabled(root), false);
  assert.equal(captureBeforeWrite(root, file, { tool: 'write_file' }), null);
  assert.equal(existsSync(antimatterDir(root)), false, 'a disabled install must not touch the project');
});

test('enabling creates a scratch area and a store that ignores itself in git', (t) => {
  const root = workspace(t);
  assert.ok(existsSync(scratchDir(root)), 'the shared scratch area is part of the same directory');
  assert.ok(existsSync(blobsDir(root)));
  // A store of every version of every file is exactly what must not reach a remote, and `*`
  // ignores the directory including the ignore file itself.
  assert.match(readFileSync(join(antimatterDir(root), '.gitignore'), 'utf8'), /^\*$/m);
  assert.equal(historyEnabled(root), true);
});

test('capture keeps what the file held before the write, restorable byte for byte', (t) => {
  const root = workspace(t);
  const file = join(root, 'src', 'app.ts');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(file, 'const before = 1;\n');

  const entry = captureBeforeWrite(root, file, { tool: 'edit_file', thread: 'chat-1', turn: 'turn-7' });
  assert.ok(entry?.blob, 'a file that existed must produce a blob');
  // Workspace-relative and POSIX, so a timeline is readable and not tied to one machine.
  assert.equal(entry.path, 'src/app.ts');
  assert.equal(entry.tool, 'edit_file');
  assert.equal(entry.turn, 'turn-7');
  assert.equal(readVersion(root, entry.blob!).toString('utf8'), 'const before = 1;\n');
});

test('an unchanged file costs no second copy, because blobs are content addressed', (t) => {
  const root = workspace(t);
  const file = join(root, 'same.txt');
  writeFileSync(file, 'identical');
  const first = captureBeforeWrite(root, file, { tool: 'write_file' });
  const second = captureBeforeWrite(root, file, { tool: 'write_file' });
  assert.equal(first?.blob, second?.blob);
  assert.equal(readTimeline(root).length, 2, 'both writes are still recorded');
});

test('a file the turn created is recorded as having had nothing, so the turn can be undone', (t) => {
  const root = workspace(t);
  // Restoring "to before this turn" has to be able to delete a file the turn introduced, and
  // only this entry distinguishes "was empty" from "did not exist".
  const entry = captureBeforeWrite(root, join(root, 'new.txt'), { tool: 'write_file', turn: 'turn-9' });
  assert.equal(entry?.skipped, 'created');
  assert.equal(entry?.blob, undefined);
});

test('a file past the capture ceiling records the gap rather than hiding it', (t) => {
  const root = workspace(t);
  const file = join(root, 'big.bin');
  writeFileSync(file, Buffer.alloc(MAX_CAPTURE_BYTES + 1, 0x41));
  const entry = captureBeforeWrite(root, file, { tool: 'write_file' });
  assert.equal(entry?.skipped, 'too-large');
  assert.equal(entry?.blob, undefined);
  assert.equal(entry?.bytes, MAX_CAPTURE_BYTES + 1);
});

test('the store never records itself', (t) => {
  const root = workspace(t);
  const inside = join(antimatterDir(root), 'scratch', 'notes.md');
  writeFileSync(inside, 'scratch');
  assert.equal(captureBeforeWrite(root, inside, { tool: 'write_file' }), null);
  assert.equal(readTimeline(root).length, 0);
});

test('versions read newest first per file, and a whole turn can be listed', (t) => {
  const root = workspace(t);
  const one = join(root, 'one.txt');
  const two = join(root, 'two.txt');
  writeFileSync(one, 'v1');
  captureBeforeWrite(root, one, { tool: 'write_file', turn: 'turn-1' });
  writeFileSync(one, 'v2');
  captureBeforeWrite(root, one, { tool: 'write_file', turn: 'turn-2' });
  writeFileSync(two, 'other');
  captureBeforeWrite(root, two, { tool: 'write_file', turn: 'turn-2' });

  const versions = versionsOf(root, 'one.txt');
  assert.equal(versions.length, 2);
  assert.equal(readVersion(root, versions[0].blob!).toString('utf8'), 'v2', 'newest first');
  assert.equal(readVersion(root, versions[1].blob!).toString('utf8'), 'v1');
  // The case that actually saves an afternoon: everything one step was about to change.
  assert.deepEqual(versionsOfTurn(root, 'turn-2').map((entry) => entry.path).sort(), ['one.txt', 'two.txt']);
});

test('eviction drops the oldest versions and keeps a blob another entry still needs', (t) => {
  const root = workspace(t);
  const file = join(root, 'grow.txt');
  // Distinct, incompressible-ish contents so each version is its own blob.
  for (let i = 0; i < 6; i += 1) {
    writeFileSync(file, `version ${i} ${'x'.repeat(4096)}${i}`);
    captureBeforeWrite(root, file, { tool: 'write_file' });
  }
  const before = readTimeline(root).length;
  const result = pruneHistory(root, 1);
  assert.ok(result.removed > 0, 'a budget of one byte must evict');
  assert.ok(readTimeline(root).length < before, 'the timeline is rewritten, not just the blobs');
  // Whatever survived must still be readable: a timeline pointing at a deleted blob is worse
  // than a shorter timeline.
  for (const entry of readTimeline(root)) {
    if (entry.blob) assert.doesNotThrow(() => readVersion(root, entry.blob!));
  }
});

test('provenance reaches only the bundled tools that change files', () => {
  const history = { thread: 'chat-1', turn: 'turn-7' };
  const sent = toolArgumentsForTransport(BUILTIN_ID, 'write_file', { path: 'a' }, false, history);
  assert.deepEqual(sent[TURN_CONTEXT_TOOL_ARGUMENT], history);
  assert.deepEqual(
    toolArgumentsForTransport(BUILTIN_ID, 'edit_file', { path: 'a' }, false, history)[TURN_CONTEXT_TOOL_ARGUMENT],
    history
  );
  // A reading tool gains nothing from it, and these arguments are replayed as JSON on every
  // later request, so an unused key is a cost paid on every turn.
  assert.ok(!Object.hasOwn(toolArgumentsForTransport(BUILTIN_ID, 'read_file', { path: 'a' }, false, history), TURN_CONTEXT_TOOL_ARGUMENT));
  // Another server's tool never receives Antimatter's private arguments.
  assert.ok(!Object.hasOwn(toolArgumentsForTransport('other', 'write_file', { path: 'a' }, false, history), TURN_CONTEXT_TOOL_ARGUMENT));
  // Empty provenance adds no key at all.
  assert.ok(!Object.hasOwn(toolArgumentsForTransport(BUILTIN_ID, 'write_file', { path: 'a' }, false, {}), TURN_CONTEXT_TOOL_ARGUMENT));
  // The pre-existing create-only flag still works beside it.
  assert.equal(toolArgumentsForTransport(BUILTIN_ID, 'write_file', { path: 'a' }, true, history)[CREATE_ONLY_TOOL_ARGUMENT], true);
});

test('the directory name is one constant, so nothing hunts for a second spelling', () => {
  assert.equal(ANTIMATTER_DIR, '.antimatter');
});
