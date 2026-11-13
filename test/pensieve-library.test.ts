import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PensieveLibrary } from '../src/main/pensieveLibrary';
import { withPensieveLibrary, LIBRARY_SERVER } from '../src/main/pensieveLibraryTools';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-library-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), other = join(root, 'other'); mkdirSync(project); mkdirSync(other);
  const file = join(root, 'private', 'library.json'), curriculumPath = join(root, 'curriculum.json');
  const content = 'Immutable compiler reference.';
  writeFileSync(curriculumPath, JSON.stringify({ schema_version: 1, entries: [{ id: 'compiler', path: 'compiler.md', language: 'shared', content,
    sha256: createHash('sha256').update(content).digest('hex') }] }));
  const library = new PensieveLibrary({ file, curriculumPath });
  return { root, project, other, file, curriculumPath, library };
}
const custom = { kind: 'save' as const, title: 'Cargo test', content: 'Run cargo test for the Rust workspace.', entryKind: 'note' as const, language: 'rust' as const, scope: 'project' as const };

test('private custom entries survive restart and remain scoped across canonical project aliases', (t) => {
  const f = fixture(t);
  const saved = f.library.update({ workspace: f.project, revision: 0, mutation: custom });
  assert.equal(saved.entries.filter((entry) => entry.origin === 'custom').length, 1);
  assert.equal(f.library.get(f.other).entries.filter((entry) => entry.origin === 'custom').length, 0);
  symlinkSync(f.project, join(f.root, 'alias'), 'dir');
  assert.deepEqual(new PensieveLibrary({ file: f.file, curriculumPath: f.curriculumPath }).get(join(f.root, 'alias')), saved);
  if (process.platform !== 'win32') assert.equal(statSync(f.file).mode & 0o777, 0o600);
  const disk = readFileSync(f.file, 'utf8');
  assert.ok(!disk.includes(f.project), 'private paths are hashed, not serialized');
  assert.throws(() => f.library.update({ workspace: f.project, revision: 0, mutation: custom }), /changed/);
});

test('shipped schemas and curricula can be disabled but never edited or removed', (t) => {
  const f = fixture(t), source = readFileSync(f.curriculumPath, 'utf8');
  for (const id of ['shipped:workspace-note', 'curriculum:compiler']) {
    assert.throws(() => f.library.update({ revision: 0, mutation: { ...custom, id, scope: 'global' } }), /read-only/);
    assert.throws(() => f.library.update({ revision: 0, mutation: { kind: 'delete', id } }), /read-only/);
  }
  const state = f.library.update({ revision: 0, mutation: { kind: 'toggle', id: 'curriculum:compiler', enabled: false } });
  assert.equal(state.entries.find((entry) => entry.id === 'curriculum:compiler')?.enabled, false);
  assert.equal(readFileSync(f.curriculumPath, 'utf8'), source);
  const filtered = f.library.filterRuntimeRecall({ text: 'unsafe old text containing disabled content', items: [
    { id: 'compiler', source: 'curriculum', text: 'Immutable compiler reference.' },
    { id: 7, source: 'experience', text: 'Measured result.', verification: 'compile', language: 'rust' },
  ], budget_chars: 1000 }) as { text: string; items: unknown[] };
  assert.equal(filtered.items.length, 1); assert.ok(!filtered.text.includes('Immutable')); assert.match(filtered.text, /Measured result/);
});

test('agent recall obeys live opt-in, toggles, language, edits and deletion', async (t) => {
  const f = fixture(t);
  const wrapped = withPensieveLibrary({ enabledTools: () => [], callTool: async () => ({ ok: true, text: 'other' }) }, f.library, f.project);
  const saved = f.library.update({ workspace: f.project, revision: 0, mutation: custom });
  const id = saved.entries.find((entry) => entry.origin === 'custom')!.id;
  assert.equal(wrapped.enabledTools().length, 0);
  let state = f.library.update({ workspace: f.project, revision: saved.revision, mutation: { kind: 'enable', enabled: true } });
  assert.equal(wrapped.enabledTools().length, 1);
  const result = await wrapped.callTool(LIBRARY_SERVER, 'pensieve_library_recall', { cue: 'cargo workspace', language: 'rust' });
  assert.match(result.text, /Run cargo test/); assert.match(result.text, /not independently verified/);
  assert.equal(f.library.recall(f.other, 'cargo', 'rust').text, '');
  assert.equal(f.library.recall(f.project, 'cargo', 'cpp').text, '');
  state = f.library.update({ workspace: f.project, revision: state.revision, mutation: { kind: 'toggle', id, enabled: false } });
  assert.equal(f.library.recall(f.project, 'cargo', 'rust').text, '');
  state = f.library.update({ workspace: f.project, revision: state.revision, mutation: { ...custom, id, content: 'Run cargo check first.' } });
  assert.equal(state.entries.find((entry) => entry.id === id)?.enabled, false, 'editing does not re-enable');
  state = f.library.update({ workspace: f.project, revision: state.revision, mutation: { kind: 'toggle', id, enabled: true } });
  assert.match(f.library.recall(f.project, 'cargo', 'rust').text, /cargo check/);
  f.library.update({ workspace: f.project, revision: state.revision, mutation: { kind: 'delete', id } });
  assert.equal(f.library.recall(f.project, 'cargo', 'rust').text, '');
});

test('invalid schema, corrupt state, symlinks and failed writes never replace the readable library', (t) => {
  const f = fixture(t);
  assert.throws(() => f.library.update({ revision: 0, mutation: { ...custom, scope: 'global', entryKind: 'schema', content: '[]' } }), /JSON object/);
  f.library.update({ revision: 0, mutation: { kind: 'enable', enabled: true } });
  const before = readFileSync(f.file, 'utf8');
  const failing = new PensieveLibrary({ file: f.file, write: () => { throw new Error('Disk full'); } });
  assert.throws(() => failing.update({ revision: 1, mutation: { kind: 'enable', enabled: false } }), /Disk full/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  const unsafe = join(f.root, 'unsafe.json'); symlinkSync(f.file, unsafe);
  assert.throws(() => new PensieveLibrary({ file: unsafe }).update({ revision: 1, mutation: { kind: 'enable', enabled: false } }));
  writeFileSync(f.file, '{broken');
  assert.throws(() => f.library.update({ revision: 0, mutation: { kind: 'enable', enabled: false } }));
  assert.equal(readFileSync(f.file, 'utf8'), '{broken');
});
