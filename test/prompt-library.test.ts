import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_PROMPT_LIBRARY,
  MAX_PROMPT_BODY_BYTES,
  MAX_PROMPT_ENTRIES,
  MAX_PROMPT_VARIABLE_VALUE_LENGTH,
  normalizePromptLibrary,
  promptTitleFrom,
  removePromptEntry,
  upsertPromptEntry,
} from '../src/api/promptLibrary';
import * as store from '../src/main/promptLibrary';

let clock = 1000;
const ids: string[] = [];
const options = {
  now: () => (clock += 10),
  newId: () => {
    const id = `${String(ids.length).padStart(8, '0')}-0000-4000-8000-000000000000`;
    ids.push(id);
    return id;
  },
};

test('A prompt is named from its first non-blank line when no title is given', () => {
  assert.equal(promptTitleFrom('  Release   notes  ', 'anything'), 'Release notes');
  assert.equal(promptTitleFrom('', '\n\n  Summarise the week for the team\nin five lines'), 'Summarise the week for the team');
  assert.equal(promptTitleFrom('', '   \n  '), 'Untitled prompt');
  // Markdown furniture is not a name: a prompt opening with a heading is filed under its words.
  assert.equal(promptTitleFrom('', '## Task\n\nReview the parser.'), 'Task');
  assert.equal(promptTitleFrom('', '- first bullet'), 'first bullet');
  assert.equal(promptTitleFrom('', '1. first step'), 'first step');
  assert.equal(promptTitleFrom('', '#notaheading'), '#notaheading');
  assert.equal(promptTitleFrom('x'.repeat(400), 'body').length, 120);
});

test('Saving a new prompt assigns an id, stamps both times and bumps the revision', () => {
  const next = upsertPromptEntry(EMPTY_PROMPT_LIBRARY, { title: 'Review', body: 'Review {{file}}.\r\nCite lines.' }, options);
  assert.equal(next.revision, 1);
  assert.equal(next.entries.length, 1);
  const [entry] = next.entries;
  assert.equal(entry.title, 'Review');
  // CRLF is normalized on the way in, so the stored prompt is what the editor shows.
  assert.equal(entry.body, 'Review {{file}}.\nCite lines.');
  assert.equal(entry.createdAt, entry.updatedAt);
  assert.deepEqual(entry.variables, {});
  assert.notEqual(entry.id, undefined);
});

test('Saving over a prompt keeps its id and creation time, and an unchanged save is not a write', () => {
  const first = upsertPromptEntry(EMPTY_PROMPT_LIBRARY, { title: 'Review', body: 'Review it.' }, options);
  const [original] = first.entries;
  const edited = upsertPromptEntry(first, { id: original.id, title: 'Review carefully', body: 'Review it twice.', variables: { file: 'store.ts' } }, options);
  assert.equal(edited.entries.length, 1);
  assert.equal(edited.entries[0].id, original.id);
  assert.equal(edited.entries[0].createdAt, original.createdAt);
  assert.ok(edited.entries[0].updatedAt > original.updatedAt);
  assert.equal(edited.revision, first.revision + 1);
  assert.deepEqual(edited.entries[0].variables, { file: 'store.ts' });
  // Re-saving identical content returns the same object, so no file is rewritten.
  assert.equal(upsertPromptEntry(edited, { id: original.id, title: 'Review carefully', body: 'Review it twice.', variables: { file: 'store.ts' } }, options), edited);
});

test('An empty prompt, an unknown id, a control character and an oversized body are all refused', () => {
  assert.throws(() => upsertPromptEntry(EMPTY_PROMPT_LIBRARY, { title: 'x', body: '   ' }, options), /needs some text/);
  assert.throws(() => upsertPromptEntry(EMPTY_PROMPT_LIBRARY, { title: 'x', body: 'ok' }, { ...options, newId: () => 'not-a-uuid' }), /Could not name/);
  assert.throws(() => upsertPromptEntry(EMPTY_PROMPT_LIBRARY, { id: '00000000-0000-4000-8000-000000000000', title: 'x', body: 'ok' }, options), /no longer in the library/);
  assert.throws(() => upsertPromptEntry(EMPTY_PROMPT_LIBRARY, { title: 'x', body: 'a\u0000b' }, options), /plain text/);
  assert.throws(() => upsertPromptEntry(EMPTY_PROMPT_LIBRARY, { title: 'x', body: 'a'.repeat(MAX_PROMPT_BODY_BYTES + 1) }, options), /smaller than/);
  assert.throws(() => upsertPromptEntry(EMPTY_PROMPT_LIBRARY, { title: 'x', body: 42 as unknown as string }, options), /must be text/);
  assert.throws(() => upsertPromptEntry(EMPTY_PROMPT_LIBRARY, null, options), /Invalid prompt/);
});

test('Variable values are bounded, and a value that no field could reference is dropped', () => {
  const saved = upsertPromptEntry(EMPTY_PROMPT_LIBRARY, {
    title: 'Fields', body: '{{file}}',
    variables: { file: 'x'.repeat(MAX_PROMPT_VARIABLE_VALUE_LENGTH + 50), '9bad': 'no', good: '', 'also bad': 'no' },
  }, options);
  const { variables } = saved.entries[0];
  assert.deepEqual(Object.keys(variables).sort(), ['also bad', 'file']);
  assert.equal(variables.file.length, MAX_PROMPT_VARIABLE_VALUE_LENGTH);
});

test('The library is capped, and the cap names the way out rather than silently dropping a prompt', () => {
  let full = EMPTY_PROMPT_LIBRARY;
  for (let index = 0; index < MAX_PROMPT_ENTRIES; index += 1) {
    full = upsertPromptEntry(full, { title: `Prompt ${index}`, body: `Body ${index}` }, options);
  }
  assert.equal(full.entries.length, MAX_PROMPT_ENTRIES);
  assert.throws(() => upsertPromptEntry(full, { title: 'One more', body: 'Body' }, options), /Delete one to save another/);
  // Editing an existing prompt still works at the cap.
  assert.equal(upsertPromptEntry(full, { id: full.entries[0].id, title: 'Edited', body: 'New body' }, options).entries.length, MAX_PROMPT_ENTRIES);
});

test('Prompts are listed most recently touched first', () => {
  let shelf = EMPTY_PROMPT_LIBRARY;
  shelf = upsertPromptEntry(shelf, { title: 'First', body: 'one' }, options);
  shelf = upsertPromptEntry(shelf, { title: 'Second', body: 'two' }, options);
  assert.deepEqual(shelf.entries.map((entry) => entry.title), ['Second', 'First']);
  const touched = upsertPromptEntry(shelf, { id: shelf.entries[1].id, title: 'First', body: 'one again' }, options);
  assert.deepEqual(touched.entries.map((entry) => entry.title), ['First', 'Second']);
});

test('Removing a prompt bumps the revision once, and removing a prompt that is gone is not a write', () => {
  const saved = upsertPromptEntry(EMPTY_PROMPT_LIBRARY, { title: 'Review', body: 'Review it.' }, options);
  const removed = removePromptEntry(saved, saved.entries[0].id);
  assert.deepEqual(removed.entries, []);
  assert.equal(removed.revision, saved.revision + 1);
  assert.equal(removePromptEntry(removed, saved.entries[0].id), removed);
  assert.throws(() => removePromptEntry(removed, 'nonsense'), /Invalid prompt/);
});

test('Reading a stored library drops only what cannot be read, and keeps the rest in order', () => {
  const good = { id: '00000001-0000-4000-8000-000000000000', title: 'Keep', body: 'Keep me.', variables: {}, createdAt: 1, updatedAt: 5 };
  const older = { id: '00000002-0000-4000-8000-000000000000', title: '', body: 'Name me from here.', variables: {}, createdAt: 1, updatedAt: 2 };
  const normalized = normalizePromptLibrary({
    revision: 7,
    entries: [
      good,
      { ...good, id: 'not-a-uuid' },
      { id: '00000003-0000-4000-8000-000000000000', title: 'Bad', body: 'a\u0000b' },
      { ...good },
      older,
      'nonsense',
    ],
  });
  assert.equal(normalized.revision, 7);
  assert.deepEqual(normalized.entries.map((entry) => entry.title), ['Keep', 'Name me from here.']);
  assert.deepEqual(normalizePromptLibrary(null), EMPTY_PROMPT_LIBRARY);
  assert.deepEqual(normalizePromptLibrary({ revision: -3, entries: {} }), EMPTY_PROMPT_LIBRARY);
  assert.equal(normalizePromptLibrary({ entries: Array.from({ length: MAX_PROMPT_ENTRIES + 20 }, (_value, index) => ({ ...good, id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000` })) }).entries.length, MAX_PROMPT_ENTRIES);
});

test('The store writes one private file, reads it back, and starts empty on an unreadable one', () => {
  const directory = mkdtempSync(join(tmpdir(), 'antimatter-prompt-library-'));
  const path = join(directory, 'prompt-library.json');
  store.useConfigPath(path);
  assert.deepEqual(store.read(), EMPTY_PROMPT_LIBRARY);

  const saved = store.save({ title: 'Release notes', body: 'Summarise {{range}}.' });
  assert.equal(saved.entries.length, 1);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { version: number; entries: unknown[] };
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.entries.length, 1);

  // A fresh read of the same path reproduces what was saved.
  store.useConfigPath(path);
  assert.deepEqual(store.read(), saved);

  const removed = store.remove(saved.entries[0].id);
  assert.deepEqual(removed.entries, []);
  store.useConfigPath(path);
  assert.deepEqual(store.read().entries, []);

  // An unreadable file is reported and left on disk rather than overwritten blind.
  writeFileSync(path, '{ not json');
  store.useConfigPath(path);
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    assert.deepEqual(store.read(), EMPTY_PROMPT_LIBRARY);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.equal(readFileSync(path, 'utf8'), '{ not json');

  // A file from a future format is not guessed at either.
  writeFileSync(path, JSON.stringify({ version: 2, entries: [] }));
  store.useConfigPath(path);
  console.error = () => {};
  try {
    assert.deepEqual(store.read(), EMPTY_PROMPT_LIBRARY);
  } finally {
    console.error = original;
  }
});

test('An unchanged save against the store leaves the stored revision alone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'antimatter-prompt-library-'));
  store.useConfigPath(join(directory, 'prompt-library.json'));
  const first = store.save({ title: 'Audit', body: 'Audit the loader.' });
  const again = store.save({ id: first.entries[0].id, title: 'Audit', body: 'Audit the loader.' });
  assert.equal(again, first);
  assert.equal(again.revision, first.revision);
});
