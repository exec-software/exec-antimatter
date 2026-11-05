import assert from 'node:assert/strict';
import test from 'node:test';

import { submitComposerDraft } from '../renderer/src/lib/composerSubmission';
import type { Draft } from '../renderer/src/types';

const draft = (): Draft => ({
  text: '  do not lose this  ',
  attachments: [{ id: 'notes', name: 'notes.txt', size: 5, content: 'notes' }],
});

test('a rejected composer submission preserves the exact unsent draft', () => {
  const current = draft();
  let offered: { text: string; attachments: Draft['attachments'] } | null = null;

  const result = submitComposerDraft(current, (text, attachments) => {
    offered = { text, attachments };
    return false;
  });

  assert.deepEqual(offered, { text: 'do not lose this', attachments: current.attachments });
  assert.equal(result.accepted, false);
  assert.equal(result.nextDraft, current, 'rejection must not replace or clear the live draft');
});

test('an accepted composer submission returns an empty draft', () => {
  const result = submitComposerDraft(draft(), () => true);

  assert.equal(result.accepted, true);
  assert.deepEqual(result.nextDraft, { text: '', attachments: [] });
});
