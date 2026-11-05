import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorLabel, reviewAgentPrompt, selectionRange, snapshotLines } from '../renderer/src/plugins/codeReview/presentation';
import type { ReviewFile } from '../src/api/codeReview';

const file: ReviewFile = { path: 'src/a.ts', status: 'selected', before: 'old\r\ncode\r\n', after: 'new\ncode\n', beforeStartLine: 3, startLine: 41, fingerprint: 'fixture' };

test('snapshot line anchors preserve captured offsets, CRLF, and terminal newline semantics', () => {
  assert.deepEqual(snapshotLines(file, 'after'), [{ number: 41, text: 'new' }, { number: 42, text: 'code' }]);
  assert.deepEqual(snapshotLines(file, 'before'), [{ number: 3, text: 'old' }, { number: 4, text: 'code' }]);
  assert.deepEqual(snapshotLines({ ...file, before: null }, 'before'), []);
  assert.deepEqual(snapshotLines({ ...file, after: '' }, 'after'), []);
  assert.deepEqual(snapshotLines({ ...file, after: '\n' }, 'after'), [{ number: 41, text: '' }]);
});

test('blank lines at the end of captured ranges remain visible and selectable', () => {
  assert.deepEqual(snapshotLines({ ...file, startLine: 7, after: '\n' }, 'after'), [{ number: 7, text: '' }]);
  assert.deepEqual(snapshotLines({ ...file, startLine: 7, after: '\r\n' }, 'after'), [{ number: 7, text: '' }]);
  assert.deepEqual(snapshotLines({ ...file, startLine: 7, after: 'first\n\n' }, 'after'), [
    { number: 7, text: 'first' }, { number: 8, text: '' },
  ]);
  assert.deepEqual(snapshotLines({ ...file, startLine: 7, after: 'first\r\n\r\n' }, 'after'), [
    { number: 7, text: 'first' }, { number: 8, text: '' },
  ]);
});

test('ranges work in either direction and labels identify the snapshot side', () => {
  assert.deepEqual(selectionRange(8, 3), { startLine: 3, endLine: 8 });
  assert.deepEqual(selectionRange(3, 8), { startLine: 3, endLine: 8 });
  assert.equal(anchorLabel({ path: 'src/a.ts', side: 'before', startLine: 3, endLine: 8 }), 'src/a.ts:3–8 · before');
  assert.equal(anchorLabel({ path: 'src/a.ts', side: 'after', startLine: 41, endLine: 41 }), 'src/a.ts:41 · after');
});

test('agent draft names the persistent review and preserves human decisions and snapshot semantics', () => {
  const prompt = reviewAgentPrompt({ id: 'review-id', title: 'Connection "review"', workspace: '/fixture/project' });
  for (const tool of ['read_code_review', 'add_review_finding', 'reply_to_review', 'update_review_finding']) assert.ok(prompt.includes(tool));
  assert.match(prompt, /review ID: review-id/);
  assert.match(prompt, /proposed fixes remain open/);
  assert.match(prompt, /Final approval and verified resolution are mine/);
  assert.match(prompt, /never silently move an anchor/);
  assert.match(prompt, /do not edit source unless I ask/);
});
