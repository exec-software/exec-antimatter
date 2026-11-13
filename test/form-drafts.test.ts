import assert from 'node:assert/strict';
import test from 'node:test';
import { clearFormDraft, downloadFormDraft, flushFormDrafts, formDraftStatus, readFormDraft, resetFormDraft, writeFormDraft } from '../renderer/src/lib/formDrafts';

const prefix = 'antimatter.form-draft.';
const disk = new Map<string, string>();
let failRead = false, failWrite = false, failRemove = false;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem(key: string) { if (failRead) throw new Error('Storage unavailable'); return disk.get(key) ?? null; },
  setItem(key: string, value: string) { if (failWrite) throw new Error('Quota'); disk.set(key, value); },
  removeItem(key: string) { if (failRemove) throw new Error('Storage unavailable'); disk.delete(key); },
} });
const valid = (value: unknown): value is { text: string } => !!value && typeof (value as { text: unknown }).text === 'string';

test('quota failures retain current draft, report restart blockers, and flush after storage recovers', () => {
  const key = 'quota', draft = { text: 'Unsaved edits' };
  assert.equal(readFormDraft(key, valid), null);
  failWrite = true;
  assert.equal(writeFormDraft(key, draft), false);
  assert.deepEqual(readFormDraft(key, valid), draft);
  assert.deepEqual(JSON.parse(downloadFormDraft(key)), draft);
  assert.match(formDraftStatus(key).error!, /Could not save/);
  assert.ok(flushFormDrafts().some((message) => message.includes('Could not save')));
  failWrite = false;
  assert.deepEqual(flushFormDrafts(), []);
  assert.deepEqual(JSON.parse(disk.get(prefix + key)!), draft);
  assert.equal(formDraftStatus(key).error, null);
});

test('failed removals do not resurrect stale drafts in memory and prevent restart until retried', () => {
  const key = 'remove'; writeFormDraft(key, { text: 'Saved' });
  failRemove = true;
  assert.equal(clearFormDraft(key), false);
  assert.equal(readFormDraft(key, valid), null);
  assert.ok(disk.has(prefix + key));
  assert.ok(flushFormDrafts().some((message) => message.includes('Could not remove')));
  failRemove = false;
  assert.deepEqual(flushFormDrafts(), []);
  assert.equal(disk.has(prefix + key), false);
});

test('corrupt saved bytes survive mount clears, edits and flush; explicit reset retains current edits', () => {
  const key = 'corrupt', raw = '{ broken original data \n'; disk.set(prefix + key, raw);
  assert.equal(readFormDraft(key, valid), null);
  assert.equal(clearFormDraft(key), false);
  assert.equal(formDraftStatus(key).recovery, true);
  assert.equal(writeFormDraft(key, { text: 'New local draft' }), false);
  assert.deepEqual(readFormDraft(key, valid), { text: 'New local draft' });
  assert.equal(downloadFormDraft(key, true), raw);
  assert.ok(flushFormDrafts().length); assert.equal(disk.get(prefix + key), raw);
  failRemove = true; assert.equal(resetFormDraft(key), false); assert.equal(disk.get(prefix + key), raw);
  failRemove = false; assert.equal(resetFormDraft(key), true);
  assert.deepEqual(JSON.parse(disk.get(prefix + key)!), { text: 'New local draft' });
  assert.deepEqual(flushFormDrafts(), []);
});

test('unavailable reads preserve unknown saved data until explicit recovery', () => {
  const key = 'unreadable', saved = JSON.stringify({ text: 'Preserved' }); disk.set(prefix + key, saved);
  failRead = true; assert.equal(readFormDraft(key, valid), null);
  assert.equal(clearFormDraft(key), false); assert.equal(writeFormDraft(key, { text: 'New' }), false);
  assert.throws(() => downloadFormDraft(key, true), /unavailable/);
  failRead = false; assert.equal(downloadFormDraft(key, true), saved);
  assert.equal(disk.get(prefix + key), saved); assert.equal(resetFormDraft(key), true);
  assert.deepEqual(flushFormDrafts(), []);
});

test('oversized and schema-invalid saved drafts remain downloadable without entering active form state', () => {
  for (const [key, raw] of [['oversized', 'x'.repeat(2 * 1024 * 1024 + 1)], ['schema', JSON.stringify({ wrong: true })]]) {
    disk.set(prefix + key, raw); assert.equal(readFormDraft(key, valid), null);
    clearFormDraft(key); assert.equal(disk.get(prefix + key), raw); assert.equal(downloadFormDraft(key, true), raw);
    assert.equal(resetFormDraft(key), true); assert.equal(disk.has(prefix + key), false);
  }
  assert.deepEqual(flushFormDrafts(), []);
});

test('a completed old save cannot erase newer edits; invalid new drafts keep restart blocked', () => {
  const key = 'concurrent', old = { text: 'Old' }, next = { text: 'New' };
  writeFormDraft(key, old); writeFormDraft(key, next);
  assert.equal(clearFormDraft(key, old), false); assert.deepEqual(readFormDraft(key, valid), next);
  assert.equal(writeFormDraft(key, { text: 'x'.repeat(2 * 1024 * 1024) }), false);
  assert.ok(flushFormDrafts().some((message) => message.includes('too large')));
  assert.deepEqual(JSON.parse(disk.get(prefix + key)!), next);
  assert.equal(writeFormDraft(key, next), true); assert.deepEqual(flushFormDrafts(), []);
  assert.equal(clearFormDraft(key, next), true); assert.equal(disk.has(prefix + key), false);
});
