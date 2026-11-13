import assert from 'node:assert/strict';
import test from 'node:test';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { nativeCompletions, nativeServerCompletion } from '../renderer/src/environment/nativeIntelligence';

test('native completions retire results when another open source buffer changes', async () => {
  const state = EditorState.create({ doc: 'hel' });
  let documents = [{ path: 'main.rs', text: 'hel' }, { path: 'lib.rs', text: 'old' }];
  let done!: (value: unknown) => void;
  const pending = new Promise((resolve) => { done = resolve; });
  const result = nativeCompletions(new CompletionContext(state, 3, true), 'main.rs', {
    api: () => ({ completion: () => pending } as any), documents: () => documents, reveal() {}, onStatus() {},
  });
  documents = [{ path: 'main.rs', text: 'hel' }, { path: 'lib.rs', text: 'new' }];
  done([{ label: 'helper' }]);
  assert.equal(await result, null);
});

test('native completion applies imports and text atomically and undo restores the original source', () => {
  const initial = EditorState.create({ doc: '\nfn main() { vec }', extensions: [history()] });
  let state = initial;
  const view = { get state() { return state; }, dispatch(input: any) { state = input.state ?? state.update(input).state; } };
  const item = { label: 'vector', textEdit: { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } }, newText: 'vector()' },
    additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'use vectors::vector;\n' }] };
  const completion = nativeServerCompletion(item, state);
  assert.equal(typeof completion.apply, 'function');
  (completion.apply as Function)(view, completion, 13, 16);
  assert.equal(state.doc.toString(), 'use vectors::vector;\n\nfn main() { vector() }');
  assert.equal(undo({ state, dispatch: view.dispatch }), true);
  assert.equal(state.doc.toString(), initial.doc.toString());
});

test('native completion never applies stale, overlapping, or out-of-bounds import edits', () => {
  const initial = EditorState.create({ doc: 'abc' });
  let state = initial;
  const view = { get state() { return state; }, dispatch(input: any) { state = state.update(input).state; } };
  const base = { label: 'replacement', textEdit: { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, newText: 'x' }, additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: 'unsafe' }] };
  const overlapping = nativeServerCompletion(base, initial);
  (overlapping.apply as Function)(view, overlapping, 1, 2); assert.equal(state.doc.toString(), 'abc');
  const valid = nativeServerCompletion({ ...base, additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'import' }] }, initial);
  state = state.update({ changes: { from: 0, insert: 'new' } }).state;
  (valid.apply as Function)(view, valid, 4, 5); assert.equal(state.doc.toString(), 'newabc');
});

test('native snippet completion with imports remains one undo step', () => {
  const initial = EditorState.create({ doc: '\ncall', extensions: [history()] });
  let state = initial;
  const view = { get state() { return state; }, dispatch(input: any) { state = input.state ?? state.update(input).state; } };
  const completion = nativeServerCompletion({ label: 'call', insertTextFormat: 2, textEdit: { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: 'call(${1:value})' }, additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'use api::call;\n' }] }, initial);
  (completion.apply as Function)(view, completion, 1, 5);
  assert.equal(state.doc.toString(), 'use api::call;\n\ncall(value)');
  assert.equal(undo({ state, dispatch: view.dispatch }), true);
  assert.equal(state.doc.toString(), initial.doc.toString());
});
