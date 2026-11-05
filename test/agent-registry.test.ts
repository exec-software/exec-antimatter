import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as registry from '../src/main/agents/registry';

const scratch = (t: { after(fn: () => unknown): void }) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-agents-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  registry.useRoot(root);
  return root;
};

test('a fresh install gets every starter, including the security reviewer', (t) => {
  scratch(t);
  const ids = registry.ensureSeeded().map((agent) => agent.id);
  assert.ok(ids.includes('security-reviewer'), `security-reviewer missing from ${ids.join(', ')}`);

  const reviewer = registry.find('security-reviewer')!;
  // A reviewer that can write is not a reviewer: a run is unattended by definition.
  assert.equal(reviewer.access, 'read');
  assert.ok(!reviewer.tools.some((tool) => /write|edit|run_command/.test(tool)), reviewer.tools.join(','));
});

test('the scanner may run commands; the reviewer may not', (t) => {
  scratch(t);
  registry.ensureSeeded();
  const scanner = registry.find('security-scanner')!;
  const reviewer = registry.find('security-reviewer')!;

  // Scanning means running tools, so this one is granted what that needs -- deliberately, and
  // visibly, in its own file rather than by widening the reviewer.
  assert.equal(scanner.access, 'full');
  assert.ok(scanner.tools.includes('run_command'));

  // The reviewer stays read-only: the two jobs have different blast radii.
  assert.equal(reviewer.access, 'read');
  assert.ok(!reviewer.tools.includes('run_command'));
});

test('the media agents ask for the tools their MCP servers actually expose', (t) => {
  scratch(t);
  registry.ensureSeeded();

  const audio = registry.find('audio-producer')!;
  const image = registry.find('image-maker')!;

  // Names must match what beholder.audio and beholder.image register, because the allowlist is
  // matched against the tool name verbatim -- a typo here reads as "tool not offered", silently.
  for (const tool of ['audio_tts', 'audio_list_voices', 'audio_play']) {
    assert.ok(audio.tools.includes(tool), `${tool} missing from ${audio.tools.join(',')}`);
  }
  for (const tool of ['image_generate', 'image_edit', 'image_list_models']) {
    assert.ok(image.tools.includes(tool), `${tool} missing from ${image.tools.join(',')}`);
  }

  // Generating a file is a write, and a run is unattended: 'read' would refuse every call.
  assert.equal(audio.access, 'full');
  assert.equal(image.access, 'full');
});

test('a starter added in a later version reaches an install that already exists', (t) => {
  const root = scratch(t);
  // The marker as older versions wrote it: one timestamp, meaning only "seeding has happened".
  writeFileSync(join(root, '.seeded'), `${new Date().toISOString()}\n`);

  const ids = registry.ensureSeeded().map((agent) => agent.id);
  assert.ok(ids.includes('security-reviewer'), 'a newly added starter must still arrive');
  // ...and the ones that install already had, and may have deleted, are not resurrected.
  assert.ok(!ids.includes('code-reviewer'), `original starters must stay deleted: ${ids.join(', ')}`);
});

test('a starter the user deleted stays deleted across restarts', (t) => {
  scratch(t);
  registry.ensureSeeded();
  registry.remove('security-reviewer');
  assert.equal(registry.find('security-reviewer'), null);

  registry.ensureSeeded();
  assert.equal(registry.find('security-reviewer'), null, 'seeding must not undo a deliberate delete');
});

test('the marker records which starters were offered, not merely that seeding ran', (t) => {
  const root = scratch(t);
  registry.ensureSeeded();
  const marker = readFileSync(join(root, '.seeded'), 'utf8').trim().split('\n');
  assert.ok(marker.includes('security-reviewer'));
  assert.ok(marker.includes('code-reviewer'));
  assert.ok(existsSync(join(root, '.seeded')));
});

test('the explorer covers ground, and stays a different job from the researcher', (t) => {
  scratch(t);
  registry.ensureSeeded();
  const explorer = registry.find('explorer')!;
  const researcher = registry.find('researcher')!;

  // Reading only: getting oriented is not a reason to be able to change anything.
  assert.equal(explorer.access, 'read');
  assert.ok(!explorer.tools.some((tool) => /write|edit|run_command/.test(tool)), explorer.tools.join(','));

  // The whole point of the second agent: a sweep needs more rounds than an answer does. Equal
  // ceilings would make this the researcher with a longer brief.
  assert.ok(
    explorer.maxRounds > researcher.maxRounds,
    `explorer has ${explorer.maxRounds} rounds, researcher has ${researcher.maxRounds}`
  );

  // The router chooses from descriptions alone, so two read-only code agents must not read alike.
  assert.notEqual(explorer.description, researcher.description);
  assert.match(explorer.description, /explor/i);
  assert.match(researcher.description, /answers questions/i);
});

test('the review partner can annotate captured code while retaining read-only source access', (t) => {
  scratch(t);
  registry.ensureSeeded();
  const partner = registry.find('review-partner')!;
  assert.equal(partner.access, 'read');
  assert.deepEqual(partner.tags, ['code', 'review']);
  for (const tool of ['list_code_reviews', 'read_code_review', 'create_code_review', 'add_review_finding', 'reply_to_review', 'update_review_finding']) {
    assert.ok(partner.tools.includes(tool), `missing ${tool}`);
  }
  assert.ok(!partner.tools.some((tool) => /write_file|edit_file|run_command/.test(tool)));
  assert.match(partner.prompt, /immutable/);
  assert.match(partner.prompt, /Only the human can resolve/);
});

test('offering the review partner on upgrade preserves customized and deleted agents', (t) => {
  const root = scratch(t);
  registry.ensureSeeded();
  registry.remove('review-partner');
  // Simulate the last release's offered list: this starter has never been offered there.
  const marker = join(root, '.seeded');
  writeFileSync(marker, readFileSync(marker, 'utf8').replace('review-partner\n', ''));
  const customized = registry.find('code-reviewer')!;
  registry.save({ ...customized, name: 'My reviewer', prompt: 'My carefully customized instructions.' });
  registry.remove('security-reviewer');
  const originalBytes = readFileSync(customized.path, 'utf8');
  registry.ensureSeeded();
  assert.ok(registry.find('review-partner'));
  assert.equal(readFileSync(customized.path, 'utf8'), originalBytes);
  assert.equal(registry.find('security-reviewer'), null);
  registry.remove('review-partner');
  registry.ensureSeeded();
  assert.equal(registry.find('review-partner'), null, 'deleting the new starter is respected on later launches');
});

test('a user-created review-partner id is not overwritten when the starter is first offered', (t) => {
  const root = scratch(t);
  registry.save({ id: 'review-partner', name: 'My existing partner', description: '', tags: [], tools: ['read_file'],
    provider: null, model: null, maxRounds: 2, access: 'read', prompt: 'Keep this user definition.' });
  const path = join(root, 'review-partner.yaml');
  const bytes = readFileSync(path, 'utf8');
  registry.ensureSeeded();
  assert.equal(readFileSync(path, 'utf8'), bytes);
  assert.ok(readFileSync(join(root, '.seeded'), 'utf8').includes('review-partner'));
});
