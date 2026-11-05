import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeView } from '../renderer/src/components/views/CodeView';
import { ResearchView } from '../renderer/src/components/views/ResearchView';
import { ConversationUiProvider } from '../renderer/src/components/chat/conversationUi';
import { collectCodeSnippets, filterCodeSnippets, selectedCodeSnippet } from '../renderer/src/lib/codeSnippets';
import { filterResearchRows, researchRows, researchTsv, sortResearchRows, summarizeResearchRows } from '../renderer/src/lib/researchData';
import type { Message } from '../renderer/src/types';

const message = (id: string, content: string, meta?: Message['meta'], role: Message['role'] = 'assistant'): Message => ({ id, role, content, ...(meta ? { meta } : {}) });
const context = { assistantName: 'Ada', activeWorkspace: null, waitingOnAgents: false, reasoning: () => '', openSubagent() {}, openPreview() {} };

test('snippet collection preserves indentation, handles both fence types and nested fence text', () => {
  const messages = [message('one', 'An inline ``` is not a fence.\n````markdown example.md\n```ts\n  const x = 1;\n```\n````\n~~~Ny\n    say("hi")\n~~~')];
  const snippets = collectCodeSnippets(messages);
  assert.equal(snippets.length, 2);
  assert.equal(snippets[0].language, 'markdown');
  assert.equal(snippets[0].code, '```ts\n  const x = 1;\n```');
  assert.equal(snippets[1].language, 'ny');
  assert.equal(snippets[1].code, '    say("hi")');
  assert.ok(snippets.every((snippet) => snippet.complete));
  assert.equal(researchRows(messages, false, 1000)[0].turn.codeBlocks, 2);
});

test('a selected streaming snippet keeps its identity as it grows and other snippets arrive', () => {
  const before = collectCodeSnippets([message('one', '```ts\nconst first = 1;\n```\n```ny\nfn main')]);
  const key = before[1].key;
  assert.equal(before[1].complete, false);
  const after = collectCodeSnippets([message('one', '```ts\nconst first = 1;\n```\n```ny\nfn main() {}\n```'), message('two', '```py\nprint(2)\n```')]);
  assert.equal(selectedCodeSnippet(after, key)?.code, 'fn main() {}');
  assert.equal(selectedCodeSnippet(after, key)?.complete, true);
  assert.equal(selectedCodeSnippet(filterCodeSnippets(after, '', 'py', 'Ada'), key)?.language, 'py');
  assert.equal(selectedCodeSnippet(filterCodeSnippets(after, '', 'all', 'Ada'), key)?.key, key);
  assert.equal(selectedCodeSnippet([], key), null);
});

test('snippet search combines language and provenance filters without changing copyable code', () => {
  const snippets = collectCodeSnippets([message('one', '```ny src/main.ny\n    answer(42)\n```', { modelId: 'local-coder', sourceName: 'Workstation' }), message('two', '```ny\nuser_example()\n```', undefined, 'user')]);
  assert.deepEqual(filterCodeSnippets(snippets, 'workstation', 'ny', 'Ada').map((item) => item.key), ['one:0']);
  assert.equal(filterCodeSnippets(snippets, 'ADA', 'all', 'Ada')[0].code, '    answer(42)');
  assert.equal(filterCodeSnippets(snippets, 'answer', 'ts', 'Ada').length, 0);
  assert.deepEqual(filterCodeSnippets(snippets, 'you', 'all', 'Ada').map((item) => item.key), ['two:0']);
});

test('research preserves missing historical timings, zero timestamps, and active elapsed time', () => {
  const messages = [
    message('user', 'Question', { createdAt: 0 }, 'user'),
    message('done', 'A measured reply', { createdAt: 0, firstTokenAt: 0, finishedAt: 2000 }),
    message('history', 'A restored reply', { createdAt: 1000, firstTokenAt: 1100 }),
    message('active', '', { createdAt: 3000 }),
  ];
  const rows = researchRows(messages, true, 6000);
  assert.equal(rows[0].turn.latency, null);
  assert.equal(rows[1].turn.ttft, 0);
  assert.equal(rows[1].turn.latency, 2);
  assert.equal(rows[2].turn.latency, null);
  assert.equal(rows[2].turn.rate, null);
  assert.equal(rows[3].turn.latency, 3);
  assert.equal(rows[3].turn.ttft, null);
  assert.equal(researchRows(messages, false, 7000)[3].turn.latency, null);
});

test('filtered research sorting keeps nulls last in both directions and ties in original order', () => {
  const rows = researchRows([
    message('one', 'Cache first', { createdAt: 1000, firstTokenAt: 2000, finishedAt: 3000, modelId: 'coder' }),
    message('two', 'Cache unknown', { modelId: 'coder' }),
    message('three', 'Other', { createdAt: 1000, firstTokenAt: 2000, finishedAt: 3000 }),
    message('four', 'Cache question', undefined, 'user'),
  ], false, 9000);
  const filtered = filterResearchRows(rows, 'cache', 'assistant', 'Ada');
  assert.deepEqual(filtered.map(({ message }) => message.id), ['one', 'two']);
  for (const descending of [false, true]) {
    assert.deepEqual(sortResearchRows(rows, { key: 'ttft', descending }).map(({ message }) => message.id), ['one', 'three', 'two', 'four']);
  }
  assert.equal(filterResearchRows(rows, 'Ada', 'user', 'Ada').length, 0);
  assert.equal(summarizeResearchRows(filtered).ttft, 1);
  assert.equal(rows[0].message.id, 'one');
});

test('research summaries do not turn unknown measurements into zero or dilute weighted averages', () => {
  const rows = researchRows([message('one', 'four five'), message('two', 'six')], false, 10);
  rows[0].turn = { ...rows[0].turn, tokens: 10, rate: 2, avgWord: 4, functionWordPct: 50, words: 2 };
  rows[1].turn = { ...rows[1].turn, tokens: 20, rate: 10, avgWord: null, functionWordPct: null, words: 100 };
  const summary = summarizeResearchRows(rows);
  assert.equal(summary.rate, 30 / 7);
  assert.equal(summary.avgWord, 4);
  assert.equal(summary.functionWordPct, 50);
  assert.equal(summary.ttft, null);
  const unmeasured = summarizeResearchRows(researchRows([message('one', '', undefined, 'user')], false, 10));
  assert.equal(unmeasured.tokens, null);
  assert.equal(unmeasured.chars, 0);
  assert.equal(summarizeResearchRows([]).latency, null);
});

test('TSV exports every metric in displayed row order, keeping null cells empty and zero intact', () => {
  const rows = researchRows([message('one', 'A\tB\nC', { createdAt: 0, firstTokenAt: 0, finishedAt: 1000, sourceName: 'GPU', modelId: 'model' }), message('two', 'No timing')], false, 5000);
  const lines = researchTsv([...rows].reverse()).split('\n').map((line) => line.split('\t'));
  assert.equal(lines[0].length, 16);
  assert.ok(lines.every((line) => line.length === 16));
  assert.equal(lines[0][7], 'tokens_estimated');
  assert.equal(lines[1][0], '2');
  assert.equal(lines[1][5], '');
  assert.equal(lines[2][2], '1970-01-01T00:00:00.000Z');
  assert.equal(lines[2][5], '0');
  assert.equal(lines[2][15], 'A B C');
  assert.equal(researchTsv(researchRows([message('invalid', 'Old import', { createdAt: 1e30 })], false, 5000)).split('\n')[1].split('\t')[2], '');
});

test('view defaults show a compact accessible table and one copyable snippet with the configured name', () => {
  const messages = [message('one', '```ny\nfn first() {}\n```\n```ts\nconst second = true;\n```', { createdAt: 1000, firstTokenAt: 2000, finishedAt: 3000, modelId: 'local' })];
  const research = renderToStaticMarkup(createElement(ConversationUiProvider, { value: context }, createElement(ResearchView, { messages, isStreaming: false, pinnedMessageIds: new Set() })));
  assert.match(research, /Expand turn 1 from Ada/);
  assert.match(research, /aria-label="Show detailed metrics" aria-pressed="false"/);
  assert.equal((research.match(/scope="col"/g) ?? []).length, 6);
  assert.doesNotMatch(research, /Sort by Function/);
  const code = renderToStaticMarkup(createElement(ConversationUiProvider, { value: context }, createElement(CodeView, { messages })));
  assert.match(code, /aria-label="Code snippets"/);
  assert.match(code, /Ada/);
  assert.equal((code.match(/aria-label="Copy code"/g) ?? []).length, 1);
  assert.equal((code.match(/aria-pressed="true"/g) ?? []).length, 1);
});
