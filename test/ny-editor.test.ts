import assert from 'node:assert/strict';
import test from 'node:test';
import { CompletionContext, type Completion } from '@codemirror/autocomplete';
import { getIndentation, syntaxTree } from '@codemirror/language';
import { EditorState, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { languageFor, languageName } from '../renderer/src/environment/highlight';
import { ny, nyCodeText, nyFold, nyLocalCompletions, nySnippets } from '../renderer/src/environment/nyLanguage';
import { nyCompletions, nyEditorDiagnostics, nyHoverText, nyOffset, nyPosition, nyServerCompletion, type NyEditorApi } from '../renderer/src/environment/nyIntelligence';

function editor(text: string) { return EditorState.create({ doc: text, extensions: [ny()] }); }
function names(state: EditorState) {
  const tokens: { text: string; tag: string }[] = [];
  syntaxTree(state).iterate({ enter(node) {
    if (node.name !== 'Document') tokens.push({ text: state.sliceDoc(node.from, node.to), tag: node.name });
  } });
  return tokens;
}

test('Ny files receive their own grammar and language label', () => {
  assert.equal(languageName('src/main.ny'), 'Ny');
  assert.ok(languageFor('MAIN.NY'));
  const tokens = names(editor('pub fn hello(name: text) -> i32\n    println("hello")\n    return 42\nend fn'));
  assert.ok(tokens.some((token) => token.text === 'hello' && /function/i.test(token.tag)));
  assert.ok(tokens.some((token) => token.text === 'text' && /type/i.test(token.tag)));
  assert.ok(tokens.some((token) => token.text === 'return' && /keyword/i.test(token.tag)));
  assert.ok(tokens.some((token) => token.text === '42' && /number/i.test(token.tag)));
});

test('Ny hash and C comments, escaped strings and annotations do not leak grammar tokens', () => {
  const state = editor('###\nfn hidden()\n###\n/* let hidden = "bad" */\n@doc(summary="a \\"quote\\"")\nlet visible: text = "fn ghost()" # tail\n// fn absent()');
  const code = nyCodeText(state);
  assert.ok(!code.includes('hidden'));
  assert.ok(!code.includes('ghost'));
  assert.ok(!code.includes('absent'));
  assert.ok(code.includes('let visible'));
  assert.equal(code.length, state.doc.length);
  assert.equal(code.split('\n').length, state.doc.lines);
  assert.ok(names(state).some((token) => token.text === '@doc' && /annotation/i.test(token.tag)));
});

test('Ny indentation understands end blocks, else branches, nested calls and trait signatures', () => {
  const state = editor('fn main() -> i32\nif true then\nprintln(\n"hello"\n)\nelse\nreturn 1\nend if\nreturn 0\nend fn\n');
  const expected = [0, 4, 8, 12, 8, 4, 8, 4, 4, 0, 0];
  for (let i = 0; i < expected.length; i++) assert.equal(getIndentation(state, state.doc.line(i + 1).from), expected[i], `line ${i + 1}`);
  const trait = editor('pub trait Printable\nfn print(self) -> void\nend trait\nfn next() -> void\nend fn');
  assert.equal(getIndentation(trait, trait.doc.line(3).from), 0);
  assert.equal(getIndentation(trait, trait.doc.line(4).from), 0);
  const match = editor('match value\nwhen 1 => true\nend match');
  assert.equal(getIndentation(match, match.doc.line(2).from), 4, 'match arms align with the canonical Ny snippet');
  assert.equal(getIndentation(match, match.doc.line(3).from), 0);
});

test('Ny folding tracks nested end blocks and ignores misleading strings and comments', () => {
  const state = editor('fn main() -> i32\n    // end fn\n    if true then\n        println("end if")\n    end if\n    return 0\nend fn');
  assert.deepEqual(nyFold(state, 0, state.doc.line(1).to), { from: state.doc.line(1).to, to: state.doc.line(7).from - 1 });
  assert.deepEqual(nyFold(state, state.doc.line(3).from, state.doc.line(3).to), { from: state.doc.line(3).to, to: state.doc.line(5).from - 1 });
  assert.equal(nyFold(state, state.doc.line(2).from, state.doc.line(2).to), null);
  const trait = editor('trait Printable\n    fn print(self) -> void\nend trait');
  assert.deepEqual(nyFold(trait, 0, trait.doc.line(1).to), { from: trait.doc.line(1).to, to: trait.doc.line(3).from - 1 });
});

test('Ny local completion offers canonical snippets and document declarations outside strings/comments', () => {
  const state = editor('fn greeting() -> void\nend fn\n// fn phantom()\nlet visible: i32 = 1\ngre');
  const result = nyLocalCompletions(new CompletionContext(state, state.doc.length, false));
  assert.ok(result?.options.some((item) => item.label === 'greeting' && item.type === 'function'));
  assert.ok(result?.options.some((item) => item.label === 'visible'));
  assert.ok(result?.options.some((item) => item.label === 'main' && typeof item.apply === 'function'));
  assert.ok(!result?.options.some((item) => item.label === 'phantom'));
  for (const text of ['// pri', '"pri', '###\npri']) {
    const state = editor(text);
    assert.equal(nyLocalCompletions(new CompletionContext(state, state.doc.length, true)), null);
  }
});

function apply(completion: Completion, text: string, from: number, to: number) {
  let state = editor(text);
  const view = { get state() { return state; }, dispatch(transaction: Transaction | Parameters<EditorState['update']>[0]) {
    state = 'state' in transaction ? transaction.state : state.update(transaction).state;
  } };
  assert.equal(typeof completion.apply, 'function');
  (completion.apply as Exclude<Completion['apply'], string | undefined>)(view as EditorView, completion, from, to);
  return state;
}

test('Ny function snippets insert editable fields, valid end delimiters and four-space indentation', () => {
  const state = apply(nySnippets.find((item) => item.label === 'fn')!, 'fn', 0, 2);
  assert.equal(state.doc.toString(), 'fn name() -> void\n    \nend fn');
  assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), 'name');
});

test('UTF-16 positions preserve non-ASCII code and reject invalid server ranges', () => {
  const state = editor('let emoji = "😀"\nprintln(emoji)');
  for (let offset = 0; offset <= state.doc.length; offset++) assert.equal(nyOffset(state, nyPosition(state, offset)), offset);
  assert.equal(nyOffset(state, { line: 20, character: 0 }), null);
  assert.equal(nyOffset(state, { line: 0, character: 200 }), null);
  assert.equal(nyOffset(state, { line: -1, character: 0 }), null);
});

test('LSP completion merges with fallback and respects returned text edits and snippets', async () => {
  const state = editor('pri');
  let received: unknown;
  const api = { completion: async (document: unknown) => { received = document; return [{ label: 'println', kind: 3, detail: '(value: text)', insertText: 'println(${1:value})', insertTextFormat: 2 }]; } } as NyEditorApi;
  const result = await nyCompletions(new CompletionContext(state, 3, true), 'src/main.ny', api);
  assert.deepEqual(received, { path: 'src/main.ny', text: 'pri', line: 0, character: 3 });
  const chosen = result!.options.find((item) => item.label === 'println')!;
  assert.equal(chosen.detail, '(value: text)');
  assert.equal(apply(chosen, 'pri', 0, 3).doc.toString(), 'println(value)');
  assert.ok(result!.options.some((item) => item.label === 'main'));
  const edit = nyServerCompletion({ label: 'renamed', textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'renamed' } }, state);
  assert.equal(apply(edit, 'pri', 1, 3).doc.toString(), 'renamed');
  let failure = '';
  const offline = await nyCompletions(new CompletionContext(state, 3, true), 'main.ny', { completion: async () => { throw new Error('SDK missing'); } } as NyEditorApi,
    (error) => { failure = (error as Error).message; });
  assert.ok(offline!.options.some((item) => item.label === 'main'));
  assert.equal(failure, 'SDK missing', 'a dead language server reports its degraded status while preserving snippets');
});

test('Semantic member completion triggers at a dot and scoped results replace whole-file guesses', async () => {
  const member = editor('let receiver: Point\nreceiver.');
  const result = await nyCompletions(new CompletionContext(member, member.doc.length, false), 'main.ny', {
    completion: async () => [{ label: 'x', kind: 5 }],
  } as NyEditorApi);
  assert.equal(result?.from, member.doc.length);
  assert.deepEqual(result?.options.map((item) => item.label), ['x']);
  const scoped = editor('fn other() -> void\n    let unrelated: i32 = 1\nend fn\nfn main() -> void\n    un');
  const scopedResult = await nyCompletions(new CompletionContext(scoped, scoped.doc.length, false), 'main.ny', { completion: async () => [] } as unknown as NyEditorApi);
  assert.ok(!scopedResult?.options.some((item) => item.label === 'unrelated'));
});

test('Compiler diagnostics display only in the checked file and valid document range', () => {
  const state = editor('return missing');
  const range = { start: { line: 0, character: 7 }, end: { line: 0, character: 14 } };
  const diagnostics = nyEditorDiagnostics(state, [
    { range, path: 'main.ny', message: 'Unknown symbol missing', severity: 1 },
    { range, path: 'other.ny', message: 'Wrong file' },
    { range: { ...range, end: { line: 1, character: 0 } }, message: 'Stale location' },
  ], 'main.ny');
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], { from: 7, to: 14, message: 'Unknown symbol missing', severity: 'error', source: 'Ny compiler' });
  assert.equal(nyHoverText({ contents: [{ language: 'ny', value: 'fn hello() -> void' }, 'Description <script>literal</script>'] }), 'fn hello() -> void\n\nDescription <script>literal</script>');
});
