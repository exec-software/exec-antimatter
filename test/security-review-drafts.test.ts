import assert from 'node:assert/strict';
import test from 'node:test';
import { createSecurityReviewDraftStore, securityReviewDraftKey, type SecurityReviewDraft } from '../renderer/src/lib/securityReviewDrafts';

const draft: SecurityReviewDraft = { version: 1, base: { status: 'open', note: '' }, value: { status: 'dismissed', note: 'Unfinished investigation' } };
const fixture = () => {
  const values = new Map<string, string>(); let failed = false;
  const storage = { getItem: (key: string) => { if (failed) throw Error('unavailable'); return values.get(key) ?? null; }, setItem: (key: string, value: string) => { if (failed) throw Error('quota'); values.set(key, value); }, removeItem: (key: string) => { if (failed) throw Error('unavailable'); values.delete(key); } };
  return { values, storage: () => storage, fail: (value: boolean) => { failed = value; } };
};

test('drafts recover after restart and remain isolated by workspace, report and finding', () => {
  const data = fixture(), first = createSecurityReviewDraftStore(data.storage);
  const key = securityReviewDraftKey('/workspace/one', 'report', 'finding');
  first.write(key, draft);
  const restarted = createSecurityReviewDraftStore(data.storage);
  assert.deepEqual(restarted.read(key).draft, draft);
  for (const other of [securityReviewDraftKey('/workspace/two', 'report', 'finding'), securityReviewDraftKey('/workspace/one', 'other', 'finding'), securityReviewDraftKey('/workspace/one', 'report', 'other')]) assert.equal(restarted.read(other).draft, null);
  assert.notEqual(securityReviewDraftKey('/a:b', 'c', 'd'), securityReviewDraftKey('/a', 'b:c', 'd'));
  restarted.write(key, null);
  assert.equal(createSecurityReviewDraftStore(data.storage).read(key).draft, null);
});

test('storage failures preserve in-session drafts and deletion tombstones with visible errors and retry', () => {
  const data = fixture(), store = createSecurityReviewDraftStore(data.storage), key = 'review';
  store.write(key, draft); data.fail(true);
  const changed = { ...draft, value: { ...draft.value, note: 'Latest unsaved note' } };
  assert.match(store.write(key, changed).error, /could not be saved/);
  assert.deepEqual(store.read(key).draft, changed);
  assert.match(store.read(key).error, /could not be saved/);
  assert.equal(store.flush().length, 1);
  data.fail(false); assert.deepEqual(store.flush(), []); assert.equal(store.read(key).error, '');
  assert.deepEqual(createSecurityReviewDraftStore(data.storage).read(key).draft, changed);
  data.fail(true); assert.match(store.write(key, null).error, /could not be cleared/);
  assert.equal(store.read(key).draft, null);
  data.fail(false); store.write(key, null);
  assert.equal(createSecurityReviewDraftStore(data.storage).read(key).draft, null);
});

test('a late save only clears the exact captured draft', () => {
  const data = fixture(), store = createSecurityReviewDraftStore(data.storage), key = 'review';
  store.write(key, draft);
  const newer = { ...draft, value: { ...draft.value, note: 'Edited after navigating away' } };
  store.write(key, newer);
  assert.equal(store.clear(key, draft).cleared, false);
  assert.deepEqual(createSecurityReviewDraftStore(data.storage).read(key).draft, newer);
  assert.equal(store.clear(key, newer).cleared, true);
  assert.equal(createSecurityReviewDraftStore(data.storage).read(key).draft, null);
});

test('unreadable or malformed recovery data remains untouched until explicit discard', () => {
  const data = fixture(), store = createSecurityReviewDraftStore(data.storage), key = 'review';
  store.write(key, draft);
  const storedKey = [...data.values.keys()][0]; data.values.set(storedKey, '{broken');
  const restarted = createSecurityReviewDraftStore(data.storage);
  assert.equal(restarted.read(key).unreadable, true); assert.match(restarted.read(key).error, /has not been removed/);
  assert.equal(data.values.get(storedKey), '{broken');
  data.values.set(storedKey, JSON.stringify(draft)); assert.deepEqual(restarted.read(key).draft, draft);
  const inaccessible = createSecurityReviewDraftStore(data.storage); data.fail(true);
  assert.equal(inaccessible.read(key).unreadable, true); data.fail(false);
  assert.deepEqual(inaccessible.read(key).draft, draft);
  restarted.write(key, null); assert.equal(data.values.size, 0);
});
