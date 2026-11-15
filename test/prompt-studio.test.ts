import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROMPT_BLOCKS,
  composePrompt,
  inspectPrompt,
  insertBlock,
  newChatTitle,
  promptFindingCounts,
  promptReady,
  promptStats,
  promptVariables,
} from '../renderer/src/components/promptStudio/promptStudio';

const kinds = (text: string, options?: Parameters<typeof inspectPrompt>[1]) =>
  inspectPrompt(text, options).map((finding) => finding.kind);

test('Prompt statistics count the text as written, and an empty prompt has no tokens', () => {
  const stats = promptStats('Write a changelog.\nKeep it to five lines.');
  assert.equal(stats.lines, 2);
  assert.equal(stats.words, 8);
  assert.equal(stats.characters, 'Write a changelog.\nKeep it to five lines.'.length);
  assert.ok(stats.estimatedTokens > 0);
  assert.deepEqual(promptStats(''), { characters: 0, words: 0, lines: 0, estimatedTokens: 0 });
  assert.equal(promptStats('   ').estimatedTokens, 0);
});

test('Variables are found once per name, in order, carrying their filled values and first position', () => {
  const text = 'Review {{ file }} for {{reviewer}}, then re-read {{file}}.';
  const variables = promptVariables(text, { file: 'parser.ny' });
  assert.deepEqual(variables.map((variable) => variable.name), ['file', 'reviewer']);
  assert.deepEqual(variables.map((variable) => variable.occurrences), [2, 1]);
  assert.equal(variables[0].value, 'parser.ny');
  assert.equal(variables[1].value, '');
  assert.equal(text.slice(variables[1].index), '{{reviewer}}, then re-read {{file}}.');
  // A malformed field is not a variable, so no value can be hidden behind one.
  assert.deepEqual(promptVariables('{{}} {{ 9lives }} {{a b}}').map((variable) => variable.name), ['a b']);
});

test('Composing substitutes every occurrence, keeps unfilled fields visible, and reports them once', () => {
  const composed = composePrompt('Audit {{file}} for {{owner}}; cite {{file}} by line.', { file: 'store.ts' });
  assert.equal(composed.text, 'Audit store.ts for {{owner}}; cite store.ts by line.');
  assert.deepEqual(composed.missing, ['owner']);
  // A value of only whitespace is not a value.
  assert.deepEqual(composePrompt('{{a}}', { a: '   ' }).missing, ['a']);
  assert.equal(composePrompt('Ship it.   \n\n\n\nNow.  ').text, 'Ship it.\n\nNow.');
  assert.equal(promptReady('Audit {{file}}.', { file: 'store.ts' }), true);
  assert.equal(promptReady('Audit {{file}}.'), false);
  assert.equal(promptReady('   '), false);
});

test('Unfilled placeholders and variables are reported as problems with the line they sit on', () => {
  const text = 'Summarise the release.\nMention TODO and <module name> here.\nThen thank {{reviewer}}.';
  const findings = inspectPrompt(text);
  const placeholders = findings.filter((finding) => finding.kind === 'placeholder');
  assert.deepEqual(placeholders.map((finding) => finding.excerpt), ['TODO', '<module name>']);
  assert.deepEqual(placeholders.map((finding) => finding.line), [2, 2]);
  const variable = findings.find((finding) => finding.kind === 'variable');
  assert.equal(variable?.line, 3);
  assert.equal(variable?.excerpt, '{{reviewer}}');
  assert.equal(variable?.severity, 'problem');
  // Filling it in retires the finding without touching the rest.
  assert.ok(!kinds(text, { values: { reviewer: 'Sam' } }).includes('variable'));
  assert.ok(kinds(text, { values: { reviewer: 'Sam' } }).includes('placeholder'));
});

test('Vague wording, repeated words and shouting are cautions, never refusals', () => {
  const findings = inspectPrompt('Rewrite the the parser and clean it up, etc. DO NOT EVER TOUCH THE LEXER.');
  const byKind = new Map(findings.map((finding) => [finding.kind, finding]));
  assert.equal(byKind.get('repeated-word')?.excerpt, 'the the');
  assert.equal(byKind.get('vague')?.severity, 'caution');
  assert.equal(byKind.get('shouting')?.severity, 'note');
  assert.ok(findings.every((finding) => finding.severity !== 'problem'));
  assert.deepEqual(promptFindingCounts([]), { problem: 0, caution: 0, note: 0 });
});

test('A prompt that asks for nothing is a problem, and any imperative or question clears it', () => {
  assert.ok(kinds('The parser. Three files. Tuesday.').includes('no-ask'));
  assert.ok(!kinds('Rewrite the parser.').includes('no-ask'));
  assert.ok(!kinds('Which of these three files is loaded first').includes('no-ask'));
  assert.deepEqual(inspectPrompt(''), []);
  assert.deepEqual(inspectPrompt('   \n  '), []);
});

test('Output shape and wall-of-text advice apply only once a prompt is long enough to need them', () => {
  const short = 'Explain this function.';
  assert.ok(!kinds(short).includes('no-output-shape'));
  const long = `Explain ${'the loader and its callers '.repeat(12)}.`;
  assert.ok(kinds(long).includes('no-output-shape'));
  assert.ok(!kinds(`${long} Reply as a bulleted list.`).includes('no-output-shape'));
  const wall = `Explain ${'the loader and its callers '.repeat(40)}.`;
  const block = inspectPrompt(wall).find((finding) => finding.kind === 'wall-of-text');
  assert.equal(block?.line, 1);
  assert.match(block?.message ?? '', /words in one block/);
  // A paragraph break is enough to retire it.
  assert.ok(!kinds(`Explain ${'the loader and its callers '.repeat(20)}.\n\nThen ${'list each caller '.repeat(20)}.`).includes('wall-of-text'));
});

test('The token budget is reported as a share of the window and escalates once the prompt cannot fit', () => {
  const text = 'Review this. '.repeat(200);
  const tokens = promptStats(text).estimatedTokens;
  assert.ok(!kinds(text, { tokenBudget: tokens * 4 }).includes('over-budget'));
  const caution = inspectPrompt(text, { tokenBudget: Math.round(tokens * 1.5) }).find((finding) => finding.kind === 'over-budget');
  assert.equal(caution?.severity, 'caution');
  assert.match(caution?.message ?? '', /% of the window/);
  const problem = inspectPrompt(text, { tokenBudget: Math.round(tokens / 2) }).find((finding) => finding.kind === 'over-budget');
  assert.equal(problem?.severity, 'problem');
  assert.match(problem?.message ?? '', /will not fit/);
  // No window declared, no budget advice.
  assert.ok(!kinds(text).includes('over-budget'));
});

test('Findings are ordered worst first and no single habit can crowd out the rest', () => {
  const findings = inspectPrompt(`${'TODO '.repeat(30)}\nRewrite it, etc. etc. etc. etc. etc. etc.`);
  const rank = { problem: 0, caution: 1, note: 2 } as const;
  for (let index = 1; index < findings.length; index += 1) {
    assert.ok(rank[findings[index - 1].severity] <= rank[findings[index].severity]);
  }
  assert.equal(findings.filter((finding) => finding.kind === 'placeholder').length, 6);
  assert.equal(findings.filter((finding) => finding.kind === 'vague').length, 5);
});

test('A new chat is named by the supplied label, or by the prompt when none is given', () => {
  assert.equal(newChatTitle('  Parser  cleanup  ', 'Ignore this body'), 'Parser cleanup');
  assert.equal(newChatTitle('', '## Task\n\nRewrite the parser.'), 'Task');
  assert.equal(newChatTitle('', '- first bullet'), 'first bullet');
  assert.equal(newChatTitle('', '   '), 'New Conversation');
  assert.equal(newChatTitle('x'.repeat(400), 'body').length, 240);
});

test('Blocks are inserted at the cursor with sane spacing and report where the caret lands', () => {
  const empty = insertBlock('', 0, '## Task\n\n\n');
  assert.equal(empty.text, '## Task\n\n\n');
  assert.equal(empty.caret, empty.text.length);
  const appended = insertBlock('Rewrite the parser.', 19, '## Output\n\n\n');
  assert.equal(appended.text, 'Rewrite the parser.\n\n## Output\n\n\n');
  assert.equal(appended.text.slice(appended.caret), '');
  // One existing newline is topped up rather than doubled, and a blank tail is left alone.
  assert.equal(insertBlock('Rewrite.\n', 9, 'x').text, 'Rewrite.\n\nx');
  assert.equal(insertBlock('Rewrite.\n\n', 10, 'x').text, 'Rewrite.\n\nx');
  const middle = insertBlock('before|after', 6, '{{field}}');
  assert.equal(middle.text, 'before\n\n{{field}}|after');
  assert.ok(PROMPT_BLOCKS.every((block) => block.body.trim().length > 0 && block.label && block.description));
  assert.equal(new Set(PROMPT_BLOCKS.map((block) => block.id)).size, PROMPT_BLOCKS.length);
});
