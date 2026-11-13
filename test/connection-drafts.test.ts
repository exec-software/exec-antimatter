import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionDraftStore, CONNECTION_DRAFT_STORAGE_KEY, type DraftState } from '../renderer/src/components/connections/connectionDrafts';

const draft = (account = 'one'): DraftState => ({ uncertain: false, draft: { account, requestId: '12345678-1234-1234-1234-123456789abc', destination: 'person@example.com', subject: 'Test', text: 'Exact reviewed text' } });
function fixture(raw: string | null = null) {
  let value = raw; let broken = false;
  const storage = { getItem: () => value, setItem: (_key: string, next: string) => { if (broken) { throw new Error('quota'); } value = next; }, removeItem: () => { value = null; } };
  return { storage, raw: () => value, fail: (next: boolean) => { broken = next; } };
}
test('drafts preserve submitted state and exact request identity across reloads', () => {
  const box = fixture(); const first = new ConnectionDraftStore(box.storage);
  first.set('one', { ...draft(), submitted: true });
  const reloaded = new ConnectionDraftStore(box.storage);
  assert.equal(reloaded.get('one')?.submitted, true);
  assert.deepEqual(reloaded.get('one')?.draft, draft().draft);
  const copy = reloaded.get('one')!; copy.draft.text = 'changed externally';
  assert.equal(reloaded.get('one')?.draft.text, 'Exact reviewed text');
});
test('corrupt drafts are loaded atomically and never overwritten by new edits or deletes', () => {
  const original = JSON.stringify([draft(), { draft: null }]); const box = fixture(original);
  const store = new ConnectionDraftStore(box.storage);
  assert.equal(store.corrupt, true); assert.equal(store.has('one'), false);
  assert.throws(() => store.set('two', draft('two')), /could not be read/);
  assert.throws(() => store.delete('one'), /could not be read/);
  assert.equal(store.download(), original); assert.equal(box.raw(), original);
  store.reset(); assert.equal(store.error, ''); assert.equal(box.raw(), null);
  assert.equal(store.set('one', draft()), true);
});
test('storage failure preserves the latest text in memory and clears only after a durable retry', () => {
  const box = fixture(); const store = new ConnectionDraftStore(box.storage); store.set('one', draft());
  box.fail(true); assert.equal(store.set('one', { ...draft(), draft: { ...draft().draft, text: 'Latest unsaved draft' } }), false);
  assert.match(store.error, /could not be saved/); assert.equal(store.get('one')?.draft.text, 'Latest unsaved draft');
  box.fail(false); assert.equal(store.set('one', store.get('one')!), true); assert.equal(store.error, '');
  assert.match(box.raw()!, /Latest unsaved draft/);
});
test('draft limits and duplicate identities are rejected before replacing stored data', () => {
  assert.equal(new ConnectionDraftStore(fixture(JSON.stringify([draft(), draft()])).storage).corrupt, true);
  const box = fixture(); const store = new ConnectionDraftStore(box.storage);
  for (let index = 0; index < 50; index++) { store.set(`account${index}`, draft(`account${index}`)); }
  const original = box.raw(); assert.throws(() => store.set('extra', draft('extra')), /at most 50/); assert.equal(box.raw(), original);
  assert.throws(() => store.set('wrong', draft()), /another account/);
  assert.equal(CONNECTION_DRAFT_STORAGE_KEY, 'antimatter.connections.drafts.v1');
});
