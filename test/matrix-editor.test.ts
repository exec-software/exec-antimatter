import assert from 'node:assert/strict';
import test from 'node:test';
import { CompletionContext } from '@codemirror/autocomplete';
import { getIndentation, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { languageFor, languageName } from '../renderer/src/environment/highlight';
import { matrix, matrixCodeText, matrixFold, matrixLocalCompletions } from '../renderer/src/environment/matrixLanguage';
import { nyCompletions, nyEditorDiagnostics, type NyEditorApi } from '../renderer/src/environment/nyIntelligence';
const editor = (doc: string) => EditorState.create({ doc, extensions: [matrix()] });
const tokens = (state: EditorState) => {
  const result: Array<{ text: string; tag: string }> = [];
  syntaxTree(state).iterate({ enter(node) { if (node.name !== 'Document') result.push({ text: state.sliceDoc(node.from, node.to), tag: node.name }); } });
  return result;
};
test('Matrix and mat receive their own grammar, folded keywords and prose declaration highlighting', () => {
  for (const path of ['main.matrix', 'SRC/MAIN.MAT']) { assert.equal(languageName(path), 'Matrix'); assert.ok(languageFor(path)); }
  const result = tokens(editor('BOOK demo\nread-level RETURNS number BEGIN paragraph\n    GIVE -1.5e+2\nEND paragraph'));
  assert.ok(result.some((token) => token.text === 'BOOK' && /keyword/i.test(token.tag)));
  assert.ok(result.some((token) => token.text === 'read-level' && /function/i.test(token.tag)));
  assert.ok(result.some((token) => token.text === '-1.5e+2' && /number/i.test(token.tag)));
  assert.ok(result.some((token) => token.text === 'number' && /type/i.test(token.tag)));
});
test('Matrix comments, raw quoted text, escaped identifiers and text blocks preserve literal syntax', () => {
  const state = editor('!!! hidden returns number begin paragraph\nvalue path is "C:\\dir\\"\nvalue `end paragraph` is 1\nvalue prose is begin text\nwhen imaginary then\n"quotes" !!! prose\nend text\nsay path');
  const code = matrixCodeText(state);
  assert.ok(!code.includes('hidden'));
  assert.ok(!code.includes('C:'));
  assert.ok(!code.includes('imaginary'));
  assert.ok(!code.includes('prose\n'));
  assert.ok(code.includes('say path'));
  assert.equal(code.length, state.doc.length);
  assert.equal(code.split('\n').length, state.doc.lines);
  assert.ok(tokens(state).some((token) => token.text === '`end paragraph`' && /variable/i.test(token.tag)));
});
test('Matrix indentation balances prose blocks, branches, inline paragraphs and signatures', () => {
  const state = editor('main returns number begin paragraph\nwhen true then\nsay (\n"yes"\n)\notherwise\ngive 1\nend when\ngive 0\nend paragraph\n');
  const expected = [0, 4, 8, 12, 8, 4, 8, 4, 4, 0, 0];
  for (let index = 0; index < expected.length; index++) assert.equal(getIndentation(state, state.doc.line(index + 1).from), expected[index], `line ${index + 1}`);
  const consideration = editor('value result is consider code\nwhen 1 then say "one"\nwhen 2 then say "two"\notherwise say "other"\nend consider\n');
  for (const line of [2, 3, 4]) assert.equal(getIndentation(consideration, consideration.doc.line(line).from), 4);
  assert.equal(getIndentation(consideration, consideration.doc.line(5).from), 0);
  const contract = editor('Reader begin contract\nread-level returns number\nend contract\nanswer returns number begin paragraph give 42 end paragraph\n');
  assert.equal(getIndentation(contract, contract.doc.line(3).from), 0);
  assert.equal(getIndentation(contract, contract.doc.line(5).from), 0);
});
test('Matrix folding follows block kinds and ignores literal terminators', () => {
  const state = editor('main returns number begin paragraph\n    !!! end paragraph\n    when true then\n        say "end when"\n    end when\n    give 0\nend paragraph');
  assert.deepEqual(matrixFold(state, 0, state.doc.line(1).to), { from: state.doc.line(1).to, to: state.doc.line(7).from - 1 });
  assert.deepEqual(matrixFold(state, state.doc.line(3).from, state.doc.line(3).to), { from: state.doc.line(3).to, to: state.doc.line(5).from - 1 });
  assert.equal(matrixFold(state, state.doc.line(2).from, state.doc.line(2).to), null);
  const prose = editor('value text is begin text\nend paragraph\nend text');
  assert.deepEqual(matrixFold(prose, 0, prose.doc.line(1).to), { from: prose.doc.line(1).to, to: prose.doc.line(3).from - 1 });
});
test('Matrix completion retains hyphenated names and language-correct snippets offline', async () => {
  const state = editor('read-le');
  const local = matrixLocalCompletions(new CompletionContext(state, state.doc.length, true));
  assert.equal(local?.from, 0);
  assert.ok(local?.options.some((item) => item.label === 'paragraph' && typeof item.apply === 'function'));
  assert.ok(!local?.options.some((item) => item.label === 'fn'));
  const completed = await nyCompletions(new CompletionContext(state, state.doc.length, true), 'main.matrix', { completion: async () => [{ label: 'read-level', kind: 3 }] } as NyEditorApi);
  assert.ok(completed?.options.some((item) => item.label === 'read-level'));
  assert.ok(completed?.options.some((item) => item.label === 'paragraph'));
  const member = editor('reader.');
  const members = await nyCompletions(new CompletionContext(member, member.doc.length, false), 'main.mat', { completion: async () => [{ label: 'read-level', kind: 2 }] } as NyEditorApi);
  assert.deepEqual(members?.options.map((item) => item.label), ['read-level']);
  for (const doc of ['!!! say', '"say', 'begin text\nsay']) {
    const current = editor(doc);
    assert.equal(matrixLocalCompletions(new CompletionContext(current, current.doc.length, true)), null);
  }
});
test('Matrix diagnostics retain exact UTF-16 spans and language attribution', () => {
  const state = editor('say "😀"\ngive missing');
  const diagnostics = nyEditorDiagnostics(state, [{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 12 } }, message: 'Unknown name', path: 'main.matrix' }], 'main.matrix');
  assert.equal(diagnostics.length, 1);
  assert.equal(state.sliceDoc(diagnostics[0].from, diagnostics[0].to), 'missing');
  assert.equal(diagnostics[0].source, 'Matrix compiler');
});
