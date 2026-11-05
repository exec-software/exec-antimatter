import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_ASSISTANT, renderAssistantIdentity, validateAssistantPatch } from '../src/api/setup';
import { SetupStore } from '../src/main/setup';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file: join(root, 'private', 'setup.json') };
}

test('fresh setup resumes after a restart even when startup created configuration files', (t) => {
  const { file } = fixture(t);
  const first = new SetupStore(file, () => false);
  assert.equal(first.get().showOnStartup, true);
  assert.equal(new SetupStore(file, () => true).get().showOnStartup, true);
  assert.deepEqual(first.get().assistant, DEFAULT_ASSISTANT);
  first.complete(1234);
  assert.deepEqual(new SetupStore(file, () => true).get(), { assistant: DEFAULT_ASSISTANT, completedAt: 1234, showOnStartup: false });
});

test('existing users can revisit setup without an automatic wizard or overwritten choices', (t) => {
  const { file } = fixture(t);
  const store = new SetupStore(file, () => true);
  assert.equal(store.get().showOnStartup, false);
  store.updateAssistant({ name: 'Ada', personality: 'Ask good questions.\nBe direct.' });
  store.updateAssistant({ name: 'Nova' });
  const restarted = new SetupStore(file, () => true);
  assert.equal(restarted.get().showOnStartup, false);
  assert.equal(restarted.get().assistant.personality, 'Ask good questions.\nBe direct.');
  restarted.complete(1234);
  restarted.complete(5678);
  assert.equal(restarted.get().completedAt, 1234);
  assert.equal(restarted.get().assistant.name, 'Nova');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('failed writes cannot publish a changed assistant or completed setup', (t) => {
  const { file } = fixture(t);
  new SetupStore(file, () => false).updateAssistant({ name: 'Ada' });
  const before = readFileSync(file, 'utf8');
  const store = new SetupStore(file, () => true, () => { throw new Error('disk full'); });
  assert.throws(() => store.updateAssistant({ personality: 'changed' }), /disk full/);
  assert.throws(() => store.complete(), /disk full/);
  assert.deepEqual(store.get(), { assistant: { name: 'Ada', personality: '' }, completedAt: null, showOnStartup: true });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.throws(() => store.complete(0), /completion time/);
});

test('invalid, symlinked and oversize settings never interrupt an established installation', (t) => {
  const { root, file } = fixture(t);
  mkdirSync(join(root, 'private'));
  for (const content of ['not json', 'x'.repeat(40000), '[]', '{"version":99}', '{"version":1,"assistant":{"name":""},"completedAt":null}']) {
    writeFileSync(file, content);
    const state = new SetupStore(file, () => false).get();
    assert.equal(state.showOnStartup, false);
    assert.deepEqual(state.assistant, DEFAULT_ASSISTANT);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
  rmSync(file);
  const outside = join(root, 'outside');
  writeFileSync(outside, '{}');
  symlinkSync(outside, file);
  assert.equal(new SetupStore(file, () => false).get().showOnStartup, false);
  assert.equal(readFileSync(outside, 'utf8'), '{}');
});

test('assistant patches reject malformed fields and returned snapshots cannot mutate state', (t) => {
  const { file } = fixture(t);
  for (const value of [null, [], new Date(), { enabled: true }, { name: '' }, { name: 'a\nb' }, { name: 'a'.repeat(61) }, { personality: false }, { personality: 'a'.repeat(4001) }]) {
    assert.throws(() => validateAssistantPatch(value));
  }
  assert.deepEqual(validateAssistantPatch({ name: ' Ada ', personality: ' hi\r\nthere ' }), { name: 'Ada', personality: 'hi\nthere' });
  const store = new SetupStore(file, () => false);
  store.get().assistant.name = 'changed outside';
  assert.equal(store.get().assistant.name, 'Antimatter');
  assert.equal(renderAssistantIdentity({ ...DEFAULT_ASSISTANT }), '', 'the unconfigured assistant keeps its established prompt');
  assert.match(renderAssistantIdentity({ name: 'Ada', personality: 'Be concise.' }), /Ada.*main assistant[\s\S]*Be concise/);
});
