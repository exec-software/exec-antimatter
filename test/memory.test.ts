import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpTool, ToolCallResult } from '../src/main/mcp';
import type { ToolRuntime } from '../src/main/toolLoop';
import { decide, denialReason, isTrustedTool, tierOf } from '../src/main/toolPolicy';
import { mergeInstructions, withSituation } from '../src/main/prompt';
import {
  projectInstructions,
  renderInstructions,
  renderMemory,
  renderPerson,
  standingContext,
} from '../src/main/memory/context';
import { instructionAllowance, instructionFiles, MAX_INSTRUCTION_CHARS } from '../src/main/memory/instructions';
import { openableInstruction, pageState } from '../src/main/memory/page';
import * as person from '../src/main/memory/person';
import * as store from '../src/main/memory/store';
import { definitions, MEMORY_TOOLS, SERVER_ID, withMemory } from '../src/main/memory/tools';
import * as transcripts from '../src/main/transcripts';

const originalRoot = store.location();
let scratch = '';
let home = '';

/** A directory that is the top of a repository, the way git leaves one. */
function repository(path: string): string {
  mkdirSync(join(path, '.git'), { recursive: true });
  return path;
}

test.beforeEach((t) => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'antimatter-memory-')));
  home = join(scratch, 'home');
  store.useRoot(home);
  store.useConfigPath(join(scratch, 'config', 'memory.json'));
  person.forget();
  t.after(() => {
    store.useRoot(originalRoot);
    store.useConfigPath(join(originalRoot, 'memory.json'));
    person.forget();
    rmSync(scratch, { recursive: true, force: true });
  });
});

// ─── Notes on disk ───────────────────────────────────────────────────────────

test('a note is one Markdown file with its name and summary in frontmatter, and reads back whole', () => {
  const project = repository(join(scratch, 'repo'));
  const { note, created } = store.rememberNote('project', project, {
    name: 'Push straight to master',
    description: 'commit and push to master often, with a vN VERSION bump',
    content: 'No feature branches.\n\n**Why:** the remote is the backup.',
  });
  assert.equal(created, true);
  assert.equal(note.id, 'push-straight-to-master');

  const file = join(store.projectDirectoryFor(project), 'push-straight-to-master.md');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^---\nname: Push straight to master\ndescription: commit and push to master often, with a vN VERSION bump\n---\n\nNo feature branches\./);

  const [read] = store.notesFor('project', project);
  assert.equal(read.name, 'Push straight to master');
  assert.equal(read.description, 'commit and push to master often, with a vN VERSION bump');
  assert.equal(read.content, 'No feature branches.\n\n**Why:** the remote is the backup.');
  assert.equal(read.scope, 'project');
});

test('awkward names and summaries survive the frontmatter round trip', () => {
  const { note } = store.rememberNote('user', null, {
    name: 'Quotes: "yes" # not a comment',
    description: "- starts like a list: and has a colon, 'quotes' too",
    content: 'body',
  });
  const [read] = store.notesFor('user', null);
  assert.equal(read.name, 'Quotes: "yes" # not a comment');
  assert.equal(read.description, "- starts like a list: and has a colon, 'quotes' too");
  assert.equal(read.id, note.id);
});

test('remembering a name that exists replaces that note instead of adding a second', () => {
  store.rememberNote('user', null, { name: 'Prefers short answers', content: 'Keep replies short.' });
  const { note, created } = store.rememberNote('user', null, {
    name: 'prefers SHORT answers',
    content: 'Keep replies short, and skip the recap.',
  });
  assert.equal(created, false);
  assert.equal(note.id, 'prefers-short-answers');
  const notes = store.notesFor('user', null);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].content, 'Keep replies short, and skip the recap.');
});

test('the page adds a note beside one with the same name, and edits one in place through a rename', () => {
  store.saveNote('user', null, { name: 'Editor', content: 'Uses vim.' });
  const second = store.saveNote('user', null, { name: 'Editor', content: 'Also uses Zed.' });
  assert.equal(second.created, true);
  assert.equal(second.note.id, 'editor-2');

  const renamed = store.saveNote('user', null, { id: 'editor', name: 'Terminal editor', content: 'Uses vim.' });
  assert.equal(renamed.created, false);
  assert.equal(renamed.note.id, 'editor');
  assert.deepEqual(
    store.notesFor('user', null).map((note) => [note.id, note.name]).sort(),
    [
      ['editor', 'Terminal editor'],
      ['editor-2', 'Editor'],
    ]
  );
});

test('a note is found by its id, its name, or the id its name would have', () => {
  const notes = [
    store.parseNote('hand-made', 'user', '---\nname: Release process\n---\nbody', 1),
    store.parseNote('gpu-source', 'project', 'body', 2),
  ];
  assert.equal(store.findNote(notes, 'hand-made')?.id, 'hand-made');
  assert.equal(store.findNote(notes, 'release PROCESS')?.id, 'hand-made');
  assert.equal(store.findNote(notes, 'GPU source')?.id, 'gpu-source');
  assert.equal(store.findNote(notes, 'gpu-source.md')?.id, 'gpu-source');
  assert.equal(store.findNote(notes, 'nothing like it'), null);
  assert.equal(store.findNote(notes, '   '), null);
});

test("Claude Code's note format reads as it is, and a file without frontmatter still makes a note", () => {
  const claude = store.parseNote(
    'drive-antimatter-via-cdp',
    'project',
    [
      '---',
      'name: drive-antimatter-via-cdp',
      'description: "How to launch and screenshot the Electron app"',
      'metadata:',
      '  type: reference',
      '  modified: 2026-09-17T01:14:46.632Z',
      '---',
      '',
      'The body.',
    ].join('\n'),
    0
  );
  assert.equal(claude.name, 'drive-antimatter-via-cdp');
  assert.equal(claude.description, 'How to launch and screenshot the Electron app');
  assert.equal(claude.content, 'The body.');

  const bare = store.parseNote('gpu_source', 'user', '# Heading\n\nUse the GPU source. It is 50x faster.', 0);
  assert.equal(bare.name, 'Gpu source');
  assert.equal(bare.description, 'Heading');
  const sentence = store.parseNote('x', 'user', 'Use the GPU source. It is 50x faster.', 0);
  assert.equal(sentence.description, 'Use the GPU source.');
});

test("the notes directory skips Claude Code's index, links, and anything that is not a note", () => {
  const directory = store.userDirectory();
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'MEMORY.md'), '# Memory Index\n- [a](a.md) — hook\n');
  writeFileSync(join(directory, 'real.md'), '---\nname: Real\ndescription: a real note\n---\nbody\n');
  writeFileSync(join(directory, 'notes.txt'), 'not markdown');
  writeFileSync(join(scratch, 'outside.md'), 'secret file elsewhere');
  symlinkSync(join(scratch, 'outside.md'), join(directory, 'linked.md'));
  writeFileSync(join(directory, 'huge.md'), 'x'.repeat(70 * 1024));

  assert.deepEqual(
    store.notesFor('user', null).map((note) => note.id),
    ['real']
  );
});

test('a note needs a name and a body, holds no credentials, and a long one is refused with a reason', () => {
  assert.match(String(store.normalizeInput({ name: '  ', content: 'x' })), /needs a name/);
  assert.match(String(store.normalizeInput({ name: 'Empty', content: ' \n ' })), /has nothing in it/);
  assert.match(String(store.normalizeInput({ name: 'Long', content: 'x'.repeat(store.MAX_CONTENT + 1) })), /at most 16000/);
  assert.match(
    String(store.normalizeInput({ name: 'Token', content: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the API.' })),
    /credential \(github token\)/
  );
  assert.match(
    String(store.normalizeInput({ name: 'Key', content: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc' })),
    /credential/
  );
  assert.throws(
    () => store.rememberNote('user', null, { name: 'Key', content: 'sk-abcdefghijklmnopqrstuvwxyz0123' }),
    /never hold secrets/
  );
  assert.equal(existsSync(store.userDirectory()), false, 'nothing was written for a refused note');

  const kept = store.normalizeInput({ name: '  Spaced   name ', content: 'First line here. Second sentence.' });
  assert.deepEqual(kept, { name: 'Spaced name', description: 'First line here.', content: 'First line here. Second sentence.' });
});

test('a note id cannot name a file outside its directory', () => {
  assert.throws(() => store.removeNote('user', null, '../escape'), /is not a note/);
  assert.throws(() => store.removeNote('user', null, 'a/b'), /is not a note/);
  assert.equal(store.removeNote('user', null, 'never-saved'), false);
  // A slug never carries a separator, whatever the name.
  assert.equal(store.slugFor('../../etc/passwd'), 'etc-passwd');
  assert.match(store.slugFor('日本語のメモ'), /^note-[0-9a-f]{8}$/);
});

// ─── Who Antimatter is talking to ────────────────────────────────────────────

test('the identity card keeps a name, pronouns and the words the person wrote, and each field alone', () => {
  assert.deepEqual(person.read(), person.EMPTY);

  const named = person.save({ name: '  Nathan  ' }, 1_000);
  assert.equal(named.name, 'Nathan');
  assert.equal(named.updatedAt, 1_000);

  // The model filling in pronouns must not wipe what the person wrote about themselves.
  person.save({ about: 'Builds local inference tooling.\nWorks on Ubuntu.' }, 2_000);
  const both = person.save({ pronouns: 'they/them' }, 3_000);
  assert.equal(both.name, 'Nathan');
  assert.equal(both.about, 'Builds local inference tooling.\nWorks on Ubuntu.');
  assert.equal(both.pronouns, 'they/them');

  person.forget();
  assert.deepEqual(person.read(), both, 'read back from disk');
  assert.equal(JSON.parse(readFileSync(join(home, 'user.json'), 'utf8')).version, 1);

  // Saving what is already there is not a change; an empty string is a deliberate clearing.
  assert.equal(person.save({ name: 'Nathan' }, 9_000).updatedAt, 3_000);
  assert.equal(person.save({ name: '' }, 9_000).name, '');
  assert.equal(person.unknown(person.read()), false, 'the rest of the card is still there');
});

test('a name is one tidy line, and a card is only as long as it is worth reading', () => {
  const saved = person.save({
    name: `  Nat\nhan   the\tLong ${'x'.repeat(120)}`,
    pronouns: 'they/them\u0000',
    about: 'y'.repeat(3000),
  });
  assert.equal(saved.name.length, person.MAX_NAME);
  assert.match(saved.name, /^Nat han the Long/);
  assert.equal(saved.pronouns, 'they/them');
  assert.equal(saved.about.length, person.MAX_ABOUT);
});

test('the prompt says who it is talking to, and asks for they/them rather than a guess', () => {
  const withName = renderPerson({ name: 'Nathan', pronouns: '', about: '', updatedAt: 1 }, true) ?? '';
  assert.match(withName, /^You are talking to Nathan\. Use their name where it is natural/);
  assert.match(withName, /pronouns are not recorded, so use they\/them when you write about them rather than guessing/);

  const told = renderPerson({ name: 'Nathan', pronouns: 'he/him', about: 'Runs Execute.', updatedAt: 1 }, true) ?? '';
  assert.match(told, /You are talking to Nathan \(he\/him\)\./);
  assert.doesNotMatch(told, /they\/them/);
  assert.match(told, /In their own words:\n\n<about-the-user>\nRuns Execute\.\n<\/about-the-user>/);

  // Nothing known: the model is told how to record a name, and not to go asking for one.
  assert.match(renderPerson(person.EMPTY, true) ?? '', /record it with about_user[\s\S]*Do not interrupt the work to ask for it/);
  assert.equal(renderPerson(person.EMPTY, false), null, 'a conversation that cannot record one is told nothing');
});

test('who you are is told whether or not notes are switched on', () => {
  const top = repository(join(scratch, 'repo'));
  person.save({ name: 'Nathan', pronouns: 'they/them' });
  store.rememberNote('user', null, { name: 'Prefers tabs', content: 'tabs' });

  assert.match(standingContext(top, 'write').snapshot.text ?? '', /You are talking to Nathan \(they\/them\)/);
  store.saveSettings({ enabled: false });
  const withoutNotes = standingContext(top, 'write').snapshot.text ?? '';
  assert.match(withoutNotes, /You are talking to Nathan/);
  assert.doesNotMatch(withoutNotes, /Prefers tabs/);
});

test('a name a person changes in Settings reaches a conversation already open', () => {
  const top = repository(join(scratch, 'repo'));
  const opening = standingContext(top, 'write').snapshot;
  person.save({ name: 'Nathan' });
  assert.equal(standingContext(top, 'write', opening).fresh, false, 'the model recording one does not');
  store.bumpRevision();
  const reread = standingContext(top, 'write', opening);
  assert.equal(reread.fresh, true);
  assert.match(reread.snapshot.text ?? '', /You are talking to Nathan/);
});

// ─── Projects ────────────────────────────────────────────────────────────────

test('a project is the top of its repository, so a subdirectory shares the notes', () => {
  const top = repository(join(scratch, 'repo'));
  mkdirSync(join(top, 'renderer', 'src'), { recursive: true });
  assert.equal(store.projectRoot(join(top, 'renderer', 'src')), top);
  assert.equal(store.repositoryTop(join(top, 'renderer')), top);

  const loose = join(scratch, 'loose', 'dir');
  mkdirSync(loose, { recursive: true });
  assert.equal(store.projectRoot(loose), loose, 'outside a repository the workspace is the project');
  assert.equal(store.repositoryTop(loose), null);
});

test("a worktree shares its main checkout's notes, and a submodule keeps its own", () => {
  const main = repository(join(scratch, 'main'));
  mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true });
  const worktree = join(scratch, 'feature');
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`);
  assert.equal(store.projectRoot(join(worktree)), main);
  // Its own instructions are its own checkout's, though, since those are files on its branch.
  assert.equal(store.repositoryTop(worktree), worktree);

  const submodule = join(main, 'vendor', 'lib');
  mkdirSync(submodule, { recursive: true });
  mkdirSync(join(main, '.git', 'modules', 'lib'), { recursive: true });
  writeFileSync(join(submodule, '.git'), 'gitdir: ../../.git/modules/lib\n');
  assert.equal(store.projectRoot(submodule), submodule);
});

test('a declared NIL application does not inherit another application’s repository notes', () => {
  const top = repository(join(scratch, 'validation'));
  const app = join(top, 'matrix-trial');
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'nil.project.json'), JSON.stringify({ schema: 'nil.project.v1', entry: 'src/main.matrix' }));
  store.rememberNote('project', top, { name: 'Older Ny work', content: 'Continue the old renderer.' });
  const first = standingContext(app, 'write').snapshot;
  assert.equal(first.summary.projectRoot, app);
  assert.equal(first.summary.notes.project, 0);
  assert.doesNotMatch(first.text ?? '', /Continue the old renderer|Older Ny work/);
  assert.equal(store.projectRoot(join(app, 'src')), app);
  assert.equal(store.notesFor('project', top).length, 1, 'parent notes remain stored');
  store.rememberNote('project', app, { name: 'Matrix contract', content: 'Use this application’s contract.' });
  assert.equal(standingContext(join(app, 'src'), 'write').snapshot.summary.notes.project, 1);
});

test('a malformed NIL manifest preserves application identity during repair', () => {
  const top = repository(join(scratch, 'validation'));
  const app = join(top, 'broken');
  mkdirSync(app);
  store.rememberNote('project', top, { name: 'Parent notes', content: 'Unrelated parent application.' });
  for (const content of ['{', '{}', '{"schema":"other","entry":"main.matrix"}', '{"schema":"nil.project.v1","entry":""}']) {
    writeFileSync(join(app, 'nil.project.json'), content);
    assert.equal(store.projectRoot(app), app);
    assert.equal(standingContext(app, 'write').snapshot.summary.notes.project, 0);
  }
});

test('NIL application notes keep the same relative identity across worktrees', () => {
  const main = repository(join(scratch, 'main'));
  mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true });
  const branch = join(scratch, 'feature');
  const app = join(branch, 'apps', 'matrix');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(branch, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`);
  writeFileSync(join(app, 'nil.project.json'), '{"schema":"nil.project.v1","entry":"main.matrix"}');
  assert.equal(store.projectRoot(app), join(main, 'apps', 'matrix'));
  writeFileSync(join(branch, 'nil.project.json'), '{"schema":"nil.project.v1","entry":"main.matrix"}');
  assert.equal(store.projectRoot(branch), main);
});

test('each project records its root, and a second root that reads the same gets its own directory', () => {
  const first = repository(join(scratch, 'a', 'b-c'));
  const second = repository(join(scratch, 'a-b', 'c'));
  store.rememberNote('project', first, { name: 'First', content: 'one' });
  store.rememberNote('project', second, { name: 'Second', content: 'two' });

  const firstDirectory = store.projectDirectoryFor(first);
  const secondDirectory = store.projectDirectoryFor(second);
  assert.notEqual(firstDirectory, secondDirectory);
  assert.ok(firstDirectory.includes(first.replace(/[^A-Za-z0-9]/g, '-')), 'the first keeps the readable name');
  assert.match(secondDirectory, /-[0-9a-f]{8}[\\/]memory$/, 'the second is told apart by a hash');
  assert.deepEqual(store.notesFor('project', first).map((note) => note.name), ['First']);
  assert.deepEqual(store.notesFor('project', second).map((note) => note.name), ['Second']);

  assert.deepEqual(
    store.knownProjects().map((project) => project.root).sort(),
    [first, second].sort()
  );
});

test('notes copied into a project directory by hand are adopted rather than hidden', () => {
  const project = repository(join(scratch, 'copied'));
  const directory = join(home, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'imported.md'), '---\nname: Imported\ndescription: came from elsewhere\n---\nbody\n');
  assert.deepEqual(store.notesFor('project', project).map((note) => note.name), ['Imported']);

  store.rememberNote('project', project, { name: 'Added', content: 'later' });
  assert.equal(JSON.parse(readFileSync(join(directory, '..', 'project.json'), 'utf8')).root, project);
  assert.equal(store.notesFor('project', project).length, 2);
});

test('settings default on, persist, and a person editing notes moves the revision', () => {
  assert.deepEqual(store.settings(), { enabled: true, instructions: true });
  assert.deepEqual(store.saveSettings({ enabled: false, instructions: 'yes' }), { enabled: false, instructions: true });
  store.useConfigPath(join(scratch, 'config', 'memory.json'));
  assert.deepEqual(store.settings(), { enabled: false, instructions: true }, 'read back from disk');

  const before = store.revision();
  assert.equal(store.bumpRevision(), before + 1);
  store.useConfigPath(join(scratch, 'config', 'memory.json'));
  assert.equal(store.revision(), before + 1, 'the revision survives a restart');
  assert.deepEqual(store.settings(), { enabled: false, instructions: true }, 'bumping keeps the settings');
});

// ─── Project instructions ────────────────────────────────────────────────────

test('AGENTS.md is read from the top of the repository down to the workspace, outermost first', () => {
  const top = repository(join(scratch, 'repo'));
  const workspace = join(top, 'packages', 'app');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(top, 'AGENTS.md'), '# Repo rules\nRun the typecheck.\n');
  writeFileSync(join(top, 'CLAUDE.md'), 'See AGENTS.md.\n');
  writeFileSync(join(top, 'packages', 'CLAUDE.md'), 'Packages use pnpm.\n');
  writeFileSync(join(workspace, 'AGENTS.md'), '   \n');
  writeFileSync(join(workspace, 'CLAUDE.md'), 'The app is Electron.\n');
  // Above the repository is not something anyone chose to work in.
  writeFileSync(join(scratch, 'AGENTS.md'), 'Never read this.\n');

  const files = instructionFiles(workspace);
  assert.deepEqual(
    files.map((file) => [file.label, file.content]),
    [
      ['AGENTS.md', '# Repo rules\nRun the typecheck.'],
      ['packages/CLAUDE.md', 'Packages use pnpm.'],
      ['packages/app/CLAUDE.md', 'The app is Electron.'],
    ]
  );
});

test('outside a repository only the workspace itself is read', () => {
  const workspace = join(scratch, 'plain', 'dir');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(scratch, 'plain', 'AGENTS.md'), 'parent\n');
  writeFileSync(join(workspace, 'AGENTS.md'), 'here\n');
  assert.deepEqual(instructionFiles(workspace).map((file) => [file.label, file.content]), [['AGENTS.md', 'here']]);
});

test('instructions past the allowance are cut, and a file after the cut is still named', () => {
  const top = repository(join(scratch, 'repo'));
  const inner = join(top, 'inner');
  mkdirSync(inner);
  writeFileSync(join(top, 'AGENTS.md'), 'a'.repeat(120));
  writeFileSync(join(inner, 'AGENTS.md'), 'b'.repeat(50));

  const files = instructionFiles(inner, 100);
  assert.equal(files[0].content, 'a'.repeat(100));
  assert.equal(files[0].length, 120);
  assert.equal(files[1].content, '');

  const text = renderInstructions(files) ?? '';
  assert.match(text, /<file path="AGENTS\.md">\na{100}\n<\/file>/);
  assert.match(text, /The rest of .*AGENTS\.md, 20 more characters, was left out/);
  assert.match(text, /inner[\\/]AGENTS\.md also applies, and was not read to save room/);
  assert.equal(renderInstructions([]), null);
});

test('the instructions get a quarter of the prompt, in whole KiB, between 2 KiB and 32 KiB', () => {
  assert.equal(instructionAllowance(262_144), MAX_INSTRUCTION_CHARS, 'a big window gets the whole 32 KiB');
  // A 32k window with an 8k reply limit leaves about 20k tokens of prompt: a quarter is 16 KB.
  assert.equal(instructionAllowance(20_000), 15 * 1024);
  assert.equal(instructionAllowance(20_100), instructionAllowance(20_000), 'a small budget shift changes nothing');
  assert.equal(instructionAllowance(512), 2 * 1024, 'a tiny window still gets the top of the file');

  const top = repository(join(scratch, 'repo'));
  writeFileSync(join(top, 'AGENTS.md'), 'x'.repeat(20 * 1024));
  const small = standingContext(top, 'write', null, instructionAllowance(20_000)).snapshot;
  assert.deepEqual(small.summary.instructions.map((file) => file.truncated), [true]);
  assert.equal(standingContext(top, 'write', small, instructionAllowance(20_000)).fresh, false);
  assert.equal(standingContext(top, 'write', small, instructionAllowance(262_144)).fresh, true, 'another model, another window');
  assert.deepEqual(standingContext(top, 'write', small).snapshot.summary.instructions.map((file) => file.truncated), [false]);
});

test('agents and orchestrated runs get the instructions, unless they are switched off', () => {
  const top = repository(join(scratch, 'repo'));
  writeFileSync(join(top, 'AGENTS.md'), 'Commit with a vN subject.\n');
  assert.match(projectInstructions(top) ?? '', /Commit with a vN subject\./);
  writeFileSync(join(top, 'AGENTS.md'), `${'y'.repeat(3000)}\n`);
  assert.match(projectInstructions(top, 2048) ?? '', /The rest of .*AGENTS\.md, 952 more characters, was left out/);
  store.saveSettings({ instructions: false });
  assert.equal(projectInstructions(top), null);
});

// ─── What a conversation is told ─────────────────────────────────────────────

const note = (name: string, description: string, scope: store.MemoryScope = 'user'): store.MemoryNote => ({
  id: store.slugFor(name),
  scope,
  name,
  description,
  content: description,
  updatedAt: 0,
});

test('the notes are listed by summary under whom they are about, framed as what was known before', () => {
  const text =
    renderMemory(
      { user: [note('Prefers short answers', 'keep replies short')], project: [] },
      '/work/repo',
      'write'
    ) ?? '';
  assert.match(text, /not instructions from the user now: if one disagrees with what the user says, the user is right/);
  assert.match(text, /About the user, in every project:\n- Prefers short answers: keep replies short/);
  assert.match(text, /About this project \(\/work\/repo\):\n\(none yet\)/);
  assert.match(text, /recall shows a note in full/);
  assert.match(text, /Save what will be worth knowing next time with remember/);
  assert.match(text, /or any password, key or token/);
});

test('a read-only conversation is told it can read notes but not keep them, and a toolless one is only shown them', () => {
  const notes = { user: [note('A', 'a')], project: [note('B', 'b', 'project')] };
  const readOnly = renderMemory(notes, '/p', 'read') ?? '';
  assert.match(readOnly, /recall shows a note in full/);
  assert.match(readOnly, /This conversation is read-only, so notes cannot be saved/);
  assert.doesNotMatch(readOnly, /with remember/);

  const listed = renderMemory(notes, '/p', 'list') ?? '';
  assert.match(listed, /- B: b/);
  assert.doesNotMatch(listed, /recall|remember/);

  // Nothing to show and nothing to do with it: say nothing at all.
  assert.equal(renderMemory({ user: [], project: [] }, '/p', 'read'), null);
  assert.notEqual(renderMemory({ user: [], project: [] }, '/p', 'write'), null, 'a model that can save is told how');
});

test('a very long list stops, and says how many older notes it left out', () => {
  const many = Array.from({ length: 200 }, (_, index) => note(`Note ${index}`, 'x'.repeat(80)));
  const text = renderMemory({ user: many, project: [] }, '/p', 'write') ?? '';
  const listed = text.split('\n').filter((line) => line.startsWith('- Note ')).length;
  assert.ok(listed > 50 && listed < 200, `listed ${listed}`);
  assert.match(text, new RegExp(`…and ${200 - listed} older notes not listed here\\.`));
});

test('a conversation keeps the context it started with while nothing it was built from changes', () => {
  const top = repository(join(scratch, 'repo'));
  writeFileSync(join(top, 'AGENTS.md'), 'Rule one.\n');
  store.rememberNote('project', top, { name: 'First note', content: 'first' });

  const opening = standingContext(top, 'write');
  assert.equal(opening.fresh, true);
  assert.match(opening.snapshot.text ?? '', /Rule one\.[\s\S]*- First note: first/);
  assert.deepEqual(opening.snapshot.summary.notes, { user: 0, project: 1 });
  assert.deepEqual(opening.snapshot.summary.instructions.map((file) => file.label), ['AGENTS.md']);

  // The model saving a note, or the file changing, does not rewrite the top of the prompt.
  store.rememberNote('project', top, { name: 'Second note', content: 'second' });
  writeFileSync(join(top, 'AGENTS.md'), 'Rule two.\n');
  const carried = standingContext(top, 'write', opening.snapshot);
  assert.equal(carried.fresh, false);
  assert.equal(carried.snapshot, opening.snapshot);

  // A person changing notes on the page does.
  store.bumpRevision();
  const reread = standingContext(top, 'write', opening.snapshot);
  assert.equal(reread.fresh, true);
  assert.match(reread.snapshot.text ?? '', /Rule two\.[\s\S]*- Second note: second/);
});

test('another workspace, a Memory setting or read-only permissions build the context again', () => {
  const top = repository(join(scratch, 'repo'));
  mkdirSync(join(top, 'sub'));
  const opening = standingContext(top, 'write').snapshot;
  assert.equal(standingContext(join(top, 'sub'), 'write', opening).fresh, true, 'workspace');
  assert.equal(standingContext(top, 'read', opening).fresh, true, 'access');
  store.saveSettings({ instructions: false });
  assert.equal(standingContext(top, 'write', opening).fresh, true, 'setting');
});

test('with memory off the conversation is told nothing about notes, and with both off nothing at all', () => {
  const top = repository(join(scratch, 'repo'));
  writeFileSync(join(top, 'AGENTS.md'), 'Rule.\n');
  store.rememberNote('user', null, { name: 'Private', content: 'private' });
  store.saveSettings({ enabled: false });
  const instructionsOnly = standingContext(top, 'write').snapshot;
  assert.match(instructionsOnly.text ?? '', /Rule\./);
  assert.doesNotMatch(instructionsOnly.text ?? '', /memory|Private/i);
  assert.deepEqual(instructionsOnly.summary.notes, { user: 0, project: 0 });

  store.saveSettings({ instructions: false });
  assert.equal(standingContext(top, 'write').snapshot.text, null);
});

test('the standing context sits after the model brief and before the live grounding', () => {
  const standing = 'The project\'s own instructions follow.\n\nYou have a memory: notes.';
  const prompt = withSituation(mergeInstructions('Model brief.', null, standing), {
    workspace: '/work',
    workspaceConfirmed: true,
    mode: 'full',
    tools: ['read_file', 'remember'],
  });
  const brief = prompt.indexOf('Model brief.');
  const memory = prompt.indexOf('You have a memory');
  const grounding = prompt.indexOf('You are the assistant inside Antimatter');
  assert.ok(brief >= 0 && brief < memory && memory < grounding);
});

test('a transcript keeps the context its conversation started with, across a restart', (t) => {
  const originalTranscripts = transcripts.location();
  transcripts.useRoot(join(scratch, 'transcripts'));
  t.after(() => transcripts.useRoot(originalTranscripts));

  const snapshot = standingContext(repository(join(scratch, 'repo')), 'write').snapshot;
  transcripts.remember('thread-1', [{ id: 'u', role: 'user', content: 'hi' }], ['u'], [], snapshot);
  transcripts.clear();
  assert.deepEqual(transcripts.context('thread-1'), snapshot);
  assert.equal(transcripts.context('thread-2'), null);
  assert.equal(transcripts.context(undefined), null);

  // A checkpoint that did not carry one leaves the next turn to build it.
  transcripts.remember('thread-3', [{ id: 'u', role: 'user', content: 'hi' }], ['u']);
  transcripts.clear();
  assert.equal(transcripts.context('thread-3'), null);
});

// ─── The tools ───────────────────────────────────────────────────────────────

function baseRuntime(): ToolRuntime & { calls: string[] } {
  const calls: string[] = [];
  const tool: McpTool = { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} }, enabled: true };
  return {
    calls,
    enabledTools: () => [{ serverId: 'antimatter', serverName: 'Antimatter tools', tool }],
    callTool: async (serverId, toolName): Promise<ToolCallResult> => {
      calls.push(`${serverId}:${toolName}`);
      return { ok: true, text: 'passed through', attempted: true };
    },
  };
}

const call = (runtime: ToolRuntime, name: string, args: Record<string, unknown>) =>
  runtime.callTool(SERVER_ID, name, args);

test('the conversation is offered every memory tool, and a read-only one only recall', () => {
  const workspace = repository(join(scratch, 'repo'));
  const writing = withMemory(baseRuntime(), { workspace, access: 'write' });
  assert.deepEqual(
    writing.enabledTools().map((entry) => `${entry.serverId}:${entry.tool.name}`),
    [
      'antimatter:read_file',
      'antimatter.memory:remember',
      'antimatter.memory:recall',
      'antimatter.memory:about_user',
      'antimatter.memory:forget',
    ]
  );
  const reading = withMemory(baseRuntime(), { workspace, access: 'read' });
  assert.deepEqual(
    reading.enabledTools().map((entry) => entry.tool.name),
    ['read_file', 'recall']
  );
  assert.deepEqual(MEMORY_TOOLS, ['remember', 'recall', 'forget', 'about_user']);
});

test('live memory access upgrades offer and execute writes without rebuilding the runtime', async () => {
  const workspace = repository(join(scratch, 'repo'));
  let access: 'read' | 'write' = 'read';
  let changes = 0;
  const runtime = withMemory(baseRuntime(), {
    workspace,
    access,
    currentAccess: () => access,
    changed: () => (changes += 1),
  });
  const names = () => runtime.enabledTools().filter((entry) => entry.serverId === SERVER_ID).map((entry) => entry.tool.name);
  assert.deepEqual(names(), ['recall']);
  assert.equal((await call(runtime, 'remember', { name: 'Before upgrade', content: 'Blocked.' })).attempted, false);

  access = 'write';
  assert.deepEqual(names(), ['remember', 'recall', 'about_user', 'forget']);
  assert.equal((await call(runtime, 'remember', { name: 'After upgrade', content: 'Allowed.' })).ok, true);
  assert.equal((await call(runtime, 'about_user', { name: 'Alex' })).ok, true);
  assert.equal((await call(runtime, 'forget', { name: 'After upgrade' })).ok, true);
  assert.equal(person.read().name, 'Alex');
  assert.equal(store.notesFor('project', workspace).length, 0);
  assert.equal(changes, 3);
});

test('live memory access downgrades reject previously offered writes before touching state', async () => {
  const workspace = repository(join(scratch, 'repo'));
  let access: 'read' | 'write' = 'write';
  let changes = 0;
  const runtime = withMemory(baseRuntime(), {
    workspace,
    access,
    currentAccess: () => access,
    changed: () => (changes += 1),
  });
  assert.ok(runtime.enabledTools().some((entry) => entry.tool.name === 'remember'));
  await call(runtime, 'remember', { name: 'Keep me', content: 'Original.' });
  await call(runtime, 'about_user', { name: 'Alex' });

  access = 'read';
  // No intervening enabledTools() refresh: execution must check the live mode independently.
  for (const [name, args] of [
    ['remember', { name: 'Keep me', content: 'Overwritten.' }],
    ['forget', { name: 'Keep me' }],
    ['about_user', { name: 'Someone else' }],
  ] as const) {
    const result = await call(runtime, name, args);
    assert.equal(result.ok, false, name);
    assert.equal(result.attempted, false, name);
    assert.match(result.text, /not available/, name);
  }
  assert.deepEqual(runtime.enabledTools().map((entry) => entry.tool.name), ['read_file', 'recall']);
  assert.match((await call(runtime, 'recall', { name: 'Keep me' })).text, /Original\.$/);
  assert.equal(person.read().name, 'Alex');
  assert.equal(store.notesFor('project', workspace).length, 1);
  assert.equal(changes, 2, 'denied writes and allowed recall do not announce changes');
});

test('memory access remains a construction-time snapshot without a live resolver', async () => {
  const workspace = repository(join(scratch, 'repo'));
  const context: { workspace: string; access: 'read' | 'write' } = { workspace, access: 'read' };
  const reading = withMemory(baseRuntime(), context);
  context.access = 'write';
  assert.deepEqual(reading.enabledTools().map((entry) => entry.tool.name), ['read_file', 'recall']);
  assert.equal((await call(reading, 'remember', { name: 'Still blocked', content: 'No.' })).attempted, false);

  const writing = withMemory(baseRuntime(), context);
  context.access = 'read';
  assert.ok(writing.enabledTools().some((entry) => entry.tool.name === 'remember'));
  assert.equal((await call(writing, 'remember', { name: 'Snapshot write', content: 'Yes.' })).ok, true);
});

test("remember's schema asks for which note before what it says", () => {
  const remember = definitions('write').find((tool) => tool.name === 'remember')!;
  const properties = Object.keys((remember.inputSchema as { properties: Record<string, unknown> }).properties);
  assert.deepEqual(properties, ['name', 'scope', 'description', 'content']);
  assert.deepEqual((remember.inputSchema as { required: string[] }).required, ['name', 'content']);
});

test('remember saves to the project by default, recall reads it back, forget deletes it', async () => {
  const workspace = repository(join(scratch, 'repo'));
  let changes = 0;
  const runtime = withMemory(baseRuntime(), { workspace, access: 'write', changed: () => (changes += 1) });

  const saved = await call(runtime, 'remember', {
    name: 'GPU source',
    description: 'use the beholdd GPU source for unattended runs',
    content: 'The bundled beholdd is CPU-only: 0.85 tok/s against 50.',
  });
  assert.equal(saved.ok, true);
  assert.match(saved.text, /^Saved "GPU source" in this project's notes\. Later conversations in this project will see it as: use the beholdd GPU source/);
  assert.equal(store.notesFor('project', workspace).length, 1);

  const replaced = await call(runtime, 'remember', { name: 'gpu source', content: 'Updated.' });
  assert.match(replaced.text, /^Replaced "gpu source"/);

  const recalled = await call(runtime, 'recall', { name: 'GPU source' });
  assert.equal(recalled.ok, true);
  assert.match(recalled.text, /^gpu source \(this project's notes, saved \d{4}-\d{2}-\d{2}\)\nUpdated\.\n\nUpdated\.$/);

  const forgotten = await call(runtime, 'forget', { name: 'GPU source' });
  assert.equal(forgotten.ok, true);
  assert.equal(store.notesFor('project', workspace).length, 0);
  assert.equal(changes, 3, 'every change is announced, and a read is not a change');
});

test('about_user records what the user said their name is, and nothing else about them', async () => {
  const workspace = repository(join(scratch, 'repo'));
  let changes = 0;
  const runtime = withMemory(baseRuntime(), { workspace, access: 'write', changed: () => (changes += 1) });

  const named = await call(runtime, 'about_user', { name: 'Nathan' });
  assert.equal(named.ok, true);
  assert.match(named.text, /^Noted: the user is called Nathan\. Later conversations start knowing it\.$/);
  assert.equal(person.read().name, 'Nathan');

  person.save({ about: 'Their own words.' });
  const pronouns = await call(runtime, 'about_user', { pronouns: 'they/them' });
  assert.match(pronouns.text, /called Nathan \(they\/them\)/);
  assert.equal(person.read().about, 'Their own words.', 'the tool cannot touch what they wrote');

  const empty = await call(runtime, 'about_user', {});
  assert.equal(empty.ok, false);
  assert.equal(empty.attempted, false);
  assert.equal(changes, 2);

  // Read-only conversations are not offered it, and naming it anyway changes nothing.
  const reading = withMemory(baseRuntime(), { workspace, access: 'read' });
  assert.equal((await call(reading, 'about_user', { name: 'Someone else' })).ok, false);
  assert.equal(person.read().name, 'Nathan');
});

test("a note about the user goes to the user's notes, and recall looks in the project first", async () => {
  const workspace = repository(join(scratch, 'repo'));
  const runtime = withMemory(baseRuntime(), { workspace, access: 'write' });
  await call(runtime, 'remember', { name: 'Shared name', content: 'about the user', scope: 'user' });
  await call(runtime, 'remember', { name: 'Shared name', content: 'about the project' });
  assert.equal(store.notesFor('user', null).length, 1);

  assert.match((await call(runtime, 'recall', { name: 'Shared name' })).text, /about the project$/);
  assert.match((await call(runtime, 'recall', { name: 'Shared name', scope: 'user' })).text, /about the user$/);
  assert.match(
    (await call(runtime, 'remember', { name: 'Everywhere', content: 'x', scope: 'user' })).text,
    /in the user's notes\. Later conversations will see it/
  );
});

test('a missing note says so once and for all, and a refused note says why', async () => {
  const workspace = repository(join(scratch, 'repo'));
  const runtime = withMemory(baseRuntime(), { workspace, access: 'write' });
  const missing = await call(runtime, 'recall', { name: 'Never saved' });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /There is no note called "Never saved"\..*do not ask for this one again/);
  assert.equal((await call(runtime, 'forget', { name: 'Never saved' })).ok, false);

  const secret = await call(runtime, 'remember', { name: 'API', content: 'token: "abcdefgh12345678"' });
  assert.equal(secret.ok, false);
  assert.equal(secret.attempted, true);
  assert.match(secret.text, /looks like it contains a credential/);
});

test('a read-only conversation cannot save a note by naming the tool it was not offered', async () => {
  const workspace = repository(join(scratch, 'repo'));
  const runtime = withMemory(baseRuntime(), { workspace, access: 'read' });
  const result = await call(runtime, 'remember', { name: 'Sneaky', content: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.attempted, false);
  assert.equal(store.notesFor('project', workspace).length, 0);
});

test('calls for any other server pass straight through', async () => {
  const base = baseRuntime();
  const runtime = withMemory(base, { workspace: repository(join(scratch, 'repo')), access: 'write' });
  const result = await runtime.callTool('antimatter', 'read_file', {});
  assert.equal(result.text, 'passed through');
  assert.deepEqual(base.calls, ['antimatter:read_file']);
});

// ─── Permissions ─────────────────────────────────────────────────────────────

test('recall is a read, and remember and forget follow the permissions but not the workspace', () => {
  const memory = { serverId: 'antimatter.memory' };
  assert.equal(decide('recall', { mode: 'read', ...memory }), 'allow');
  assert.equal(tierOf('recall', 'antimatter.memory'), 'read');
  for (const tool of ['remember', 'forget', 'about_user']) {
    assert.equal(tierOf(tool, 'antimatter.memory'), 'write');
    assert.equal(decide(tool, { mode: 'full', workspaceConfirmed: false, ...memory }), 'allow', tool);
    assert.equal(decide(tool, { mode: 'ask', workspaceConfirmed: false, ...memory }), 'ask', tool);
    assert.equal(decide(tool, { mode: 'read', ...memory }), 'deny', tool);
    assert.match(denialReason(tool), /changes the notes later conversations are given.*Memory page/);
  }
});

test("another server's remember is not Antimatter's, and gets none of its standing", () => {
  assert.equal(isTrustedTool('remember', 'antimatter.memory'), true);
  assert.equal(isTrustedTool('remember', 'some.server'), false);
  assert.equal(tierOf('recall', 'some.server'), 'danger');
  assert.equal(decide('recall', { mode: 'read', serverId: 'some.server' }), 'deny');
  assert.equal(decide('remember', { mode: 'full', serverId: 'some.server' }), 'ask');
});

// ─── The page ────────────────────────────────────────────────────────────────

test('the page shows the workspace project, and only switches to a project that has notes', () => {
  const current = repository(join(scratch, 'current'));
  const other = repository(join(scratch, 'other'));
  writeFileSync(join(other, 'AGENTS.md'), 'Other rules.\n');
  store.rememberNote('project', other, { name: 'Other note', content: 'x' });

  const own = pageState({}, current);
  assert.equal(own.current, current);
  assert.equal(own.project.root, current);
  assert.deepEqual(own.projects.map((project) => project.root), [other]);

  const switched = pageState({ project: other }, current);
  assert.equal(switched.project.root, other);
  assert.deepEqual(switched.project.notes.map((entry) => entry.name), ['Other note']);
  assert.deepEqual(switched.project.instructions.map((file) => file.label), ['AGENTS.md']);

  // A directory with no notes is not a project the page can be pointed at.
  const stranger = repository(join(scratch, 'stranger'));
  writeFileSync(join(stranger, 'AGENTS.md'), 'Not yours.\n');
  assert.equal(pageState({ project: stranger }, current).project.root, current);
  assert.equal(openableInstruction({ project: stranger }, current, join(stranger, 'AGENTS.md')), null);
  assert.equal(openableInstruction({ project: other }, current, join(other, 'AGENTS.md')), join(other, 'AGENTS.md'));
});
