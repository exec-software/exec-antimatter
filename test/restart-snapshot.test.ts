import assert from 'node:assert/strict';
import test from 'node:test';
import { restartSnapshotFingerprint, withLiveDraft } from '../renderer/src/lib/restartSnapshot';
import type { RestartConversationSnapshot } from '../renderer/src/lib/restartSnapshot';

const snapshot = (): RestartConversationSnapshot => ({
  threads: [
    {
      id: 'thread-1',
      title: 'Draft race',
      messages: [],
      projectId: 'inbox',
      createdAt: 1,
    },
  ],
  activeThreadId: 'thread-1',
  pinned: [],
  drafts: { 'thread-1': { text: 'debounced value', attachments: [] } },
});

test('restart snapshot uses the composer value even when App still has the debounced draft', () => {
  const stale = snapshot();
  const live = withLiveDraft(stale, 'thread-1', { text: 'typed this instant', attachments: [] });

  assert.equal(live.drafts['thread-1'].text, 'typed this instant');
  assert.equal(stale.drafts['thread-1'].text, 'debounced value', 'the React snapshot is not mutated');
  assert.notEqual(restartSnapshotFingerprint(live), restartSnapshotFingerprint(stale));
});

test('flushing an empty live composer removes a stale draft', () => {
  const live = withLiveDraft(snapshot(), 'thread-1', { text: '', attachments: [] });
  assert.equal(live.drafts['thread-1'], undefined);
});
