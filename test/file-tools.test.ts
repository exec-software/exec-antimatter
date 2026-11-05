import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activeWriteCount, fileTools } from '../mcp/tools/files';
import { CREATE_ONLY_TOOL_ARGUMENT } from '../src/api/toolArguments';

const writeFile = fileTools.find((tool) => tool.name === 'write_file')!;
const editFile = fileTools.find((tool) => tool.name === 'edit_file')!;

test('write_file can build a file in parts, which is how a large one fits under the output limit', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-files-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  // Appending to a file that does not exist yet creates it, so the first part can use append too.
  assert.equal(
    await writeFile.run({ path: 'src/editor.py', content: 'import tkinter\n', append: true }, { workspace }),
    'Wrote 15 characters to src/editor.py.'
  );
  assert.equal(
    await writeFile.run({ path: 'src/editor.py', content: 'root = tkinter.Tk()\n', append: true }, { workspace }),
    'Appended 20 characters to src/editor.py, which now holds 35.'
  );
  assert.equal(readFileSync(join(workspace, 'src/editor.py'), 'utf8'), 'import tkinter\nroot = tkinter.Tk()\n');

  // Without append it is still a replacement, whatever the model meant by a string "true".
  await writeFile.run({ path: 'src/editor.py', content: 'print(1)\n', append: 'true' }, { workspace });
  assert.equal(readFileSync(join(workspace, 'src/editor.py'), 'utf8'), 'print(1)\n');
});

test('append stays inside the workspace like every other write', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-files-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  await assert.rejects(writeFile.run({ path: '../escape.txt', content: 'x', append: true }, { workspace }));
});

test('a write is atomic: no partial or leftover file is ever visible beside the target', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-files-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  await writeFile.run({ path: 'src/app.py', content: 'print(1)\n' }, { workspace });
  await writeFile.run({ path: 'src/app.py', content: 'print(2)\n', append: true }, { workspace });

  // The target directory holds the file and nothing else — a dev watcher never sees a temp file.
  assert.deepEqual(readdirSync(join(workspace, 'src')), ['app.py']);
  assert.equal(readFileSync(join(workspace, 'src/app.py'), 'utf8'), 'print(1)\nprint(2)\n');

  // The staging directory is empty once the write answers: the temp file was renamed, not left.
  assert.deepEqual(readdirSync(join(workspace, '.antimatter-tmp')), []);
  assert.equal(activeWriteCount(), 0);
});

test('concurrent appends are serialized so none of them is dropped', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-files-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  // Fired without awaiting: each one is a read-modify-write, and unsynchronized they would
  // interleave their reads and lose parts. The mutex makes the parts join in call order.
  const parts = ['a\n', 'b\n', 'c\n', 'd\n', 'e\n'];
  await Promise.all(parts.map((part) => writeFile.run({ path: 'log.txt', content: part, append: true }, { workspace })));

  assert.equal(readFileSync(join(workspace, 'log.txt'), 'utf8'), parts.join(''));
  assert.equal(activeWriteCount(), 0);
});

test('create-only writes publish one complete file and never replace an existing path', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-files-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const guarded = { [CREATE_ONLY_TOOL_ARGUMENT]: true };

  await writeFile.run({ path: 'existing.txt', content: 'somebody else\n' }, { workspace });
  await assert.rejects(
    writeFile.run({ path: 'existing.txt', content: 'truncated model output\n', ...guarded }, { workspace }),
    /create-only write.*existing file was left unchanged/i
  );
  assert.equal(readFileSync(join(workspace, 'existing.txt'), 'utf8'), 'somebody else\n');

  const attempts = await Promise.allSettled([
    writeFile.run({ path: 'raced.txt', content: 'first whole value\n', ...guarded }, { workspace }),
    writeFile.run({ path: 'raced.txt', content: 'second whole value\n', ...guarded }, { workspace }),
  ]);
  assert.equal(attempts.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((entry) => entry.status === 'rejected').length, 1);
  assert.ok(['first whole value\n', 'second whole value\n'].includes(readFileSync(join(workspace, 'raced.txt'), 'utf8')));
  assert.equal(activeWriteCount(), 0);
});

test('a destructive source rewrite cannot replace omitted implementation with prose', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-files-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const original = Array.from({ length: 260 }, (_, index) => `export const value${index} = ${index};`).join('\n') + '\n';
  await writeFile.run({ path: 'renderer/src/App.tsx', content: original }, { workspace });

  await assert.rejects(
    writeFile.run(
      {
        path: 'renderer/src/App.tsx',
        content: 'export default function App() { return null; }\n// ... rest of component remains unchanged\n',
      },
      { workspace }
    ),
    /Refused a destructive rewrite/
  );
  assert.equal(readFileSync(join(workspace, 'renderer/src/App.tsx'), 'utf8'), original);

  await assert.rejects(
    editFile.run(
      {
        path: 'renderer/src/App.tsx',
        old_string: original,
        new_string: 'export default function App() { return null; }\n// implementation omitted for brevity\n',
      },
      { workspace }
    ),
    /Refused a destructive rewrite/
  );
  assert.equal(readFileSync(join(workspace, 'renderer/src/App.tsx'), 'utf8'), original);
});

test('the omission guard ignores docs, tests, existing markers, and complete rewrites', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-files-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const large = Array.from({ length: 260 }, (_, index) => `export const value${index} = ${index};`).join('\n') + '\n';
  const marker = '// implementation omitted for brevity\n';

  await writeFile.run({ path: 'notes.md', content: large }, { workspace });
  await writeFile.run({ path: 'notes.md', content: marker }, { workspace });
  assert.equal(readFileSync(join(workspace, 'notes.md'), 'utf8'), marker);

  await writeFile.run({ path: 'src/App.test.tsx', content: large }, { workspace });
  await writeFile.run({ path: 'src/App.test.tsx', content: marker }, { workspace });
  assert.equal(readFileSync(join(workspace, 'src/App.test.tsx'), 'utf8'), marker);

  await writeFile.run({ path: 'src/existing.ts', content: `${marker}${large}` }, { workspace });
  await writeFile.run({ path: 'src/existing.ts', content: `${marker}export const kept = true;\n` }, { workspace });
  assert.equal(readFileSync(join(workspace, 'src/existing.ts'), 'utf8'), `${marker}export const kept = true;\n`);

  await writeFile.run({ path: 'src/complete.ts', content: large }, { workspace });
  await writeFile.run({ path: 'src/complete.ts', content: 'export const replacement = true;\n' }, { workspace });
  assert.equal(readFileSync(join(workspace, 'src/complete.ts'), 'utf8'), 'export const replacement = true;\n');
});
