import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as profiles from '../src/main/agents/profiles';

const scratch = (t: { after(fn: () => unknown): void }) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-profiles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  profiles.useRoot(root);
  return root;
};

const agent = (tags: string[]) => ({ tags });

test('a role is matched from the agent tags it already has, in the order they are written', (t) => {
  scratch(t);
  const saved = profiles.save({
    id: 'studio',
    name: 'Studio',
    description: 'test',
    roles: {
      default: { provider: null, model: 'big' },
      code: { provider: null, model: 'coder' },
      audio: { provider: null, model: 'voice' },
    },
  });

  assert.equal(profiles.bindingFor(agent(['code', 'review']), saved).model, 'coder');
  assert.equal(profiles.bindingFor(agent(['audio', 'media']), saved).model, 'voice');
  // First tag that names a role wins: 'code' is written first and is what was meant.
  assert.equal(profiles.bindingFor(agent(['code', 'audio']), saved).model, 'coder');
  // Nothing matches, so the fallback.
  assert.equal(profiles.bindingFor(agent(['docs']), saved).model, 'big');
  assert.equal(profiles.bindingFor(agent([]), saved).model, 'big');
});

test('a profile with no default role is refused rather than failing at dispatch', (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'holey.yaml'), 'id: holey\nname: Holey\nroles:\n  code: coder\n');
  assert.equal(profiles.find('holey'), null, 'a role table with a hole in it must not load');
});

test('the short form binds a model and the long form pins its source and workload', (t) => {
  const root = scratch(t);
  writeFileSync(
    join(root, 'mixed.yaml'),
    'id: mixed\nname: Mixed\nroles:\n' +
      '  default: plain-model\n' +
      '  code:\n    provider: gpu\n    model: pinned-model\n' +
      '  image:\n    provider: gpu\n    model: omni\n    workload: coding-32k\n' +
      '  audio:\n    model: omni\n    workload: Not An Id\n'
  );
  const loaded = profiles.find('mixed')!;
  // The short form still means "whichever source serves this, on its default workload".
  assert.deepEqual(loaded.roles.default, { provider: null, model: 'plain-model', workload: null });
  assert.deepEqual(loaded.roles.code, { provider: 'gpu', model: 'pinned-model', workload: null });
  // ADR 0001 stage 3: a slot may name which of the model's workloads it runs under.
  assert.deepEqual(loaded.roles.image, { provider: 'gpu', model: 'omni', workload: 'coding-32k' });
  // A malformed workload resolves to the model's default rather than failing the profile: the
  // files are hand-edited, and a typo should not take a whole workflow out.
  assert.deepEqual(loaded.roles.audio, { provider: null, model: 'omni', workload: null });
});

test('the selection survives a restart, and a deleted profile reads as a straight run', (t) => {
  scratch(t);
  profiles.ensureSeeded();
  const first = profiles.list()[0]!;

  profiles.select(first.id);
  assert.equal(profiles.selected()?.id, first.id, 'the choice is on disk, not in a component');

  profiles.remove(first.id);
  assert.equal(profiles.selected(), null, 'a profile deleted while selected must not break dispatch');

  profiles.select(null);
  assert.equal(profiles.selected(), null);
});

const nemotronSuperQ8 = 'nvidia-nemotron-3-super-120b-a12b-q8_0';
const qwen3Omni = 'qwen3-omni-30b';

test('a fresh Two boxes profile uses the pinned Nemotron Super Q8 checkpoint', (t) => {
  scratch(t);
  profiles.ensureSeeded();

  const twoBox = profiles.find('two-box')!;
  assert.equal(twoBox.roles.default.model, nemotronSuperQ8);
  assert.equal(twoBox.roles.security.model, nemotronSuperQ8);
  assert.equal(twoBox.roles.code.model, 'qwen3-coder-30b');
});

test('the Single box profile keeps every role local and gives the generalist the code role', (t) => {
  scratch(t);
  profiles.ensureSeeded();

  const oneBox = profiles.find('one-box')!;
  const deepseek = 'deepseek-v4-flash-0731-ud-q2_k_xl';
  // There is no second machine, so a pinned provider could only ever be wrong.
  for (const role of Object.keys(oneBox.roles)) {
    assert.equal(oneBox.roles[role]!.provider, null, `${role} must resolve to whatever serves it locally`);
  }
  assert.equal(oneBox.roles.default.model, deepseek);
  assert.equal(oneBox.roles.security.model, deepseek);
  // Unlike two-box, the generalist takes code: a coder would have to evict it to load.
  assert.equal(oneBox.roles.code.model, deepseek);
  // Media still needs the model that can actually perceive media.
  assert.equal(oneBox.roles.audio.model, 'qwen3-omni-30b');
  assert.equal(oneBox.roles.image.model, 'qwen3-omni-30b');
});

test('seeding writes every starter and disturbs none of the others', (t) => {
  scratch(t);
  profiles.ensureSeeded();
  const ids = profiles.list().map((profile) => profile.id).sort();
  assert.deepEqual(ids, ['coder-next-pool', 'coder-next-straight', 'one-box', 'two-box']);
});

test('the Coder Next starters are one model used two ways, differing only in workload', (t) => {
  scratch(t);
  profiles.ensureSeeded();

  const straight = profiles.find('coder-next-straight')!;
  const pool = profiles.find('coder-next-pool')!;
  const coder = 'qwen3-coder-next-80b';
  const source = 'local-qwen3-coder-next-80b';

  // The whole point of the pair: same model, same source, same roles — the workload is the
  // only axis of difference. If these ever diverge elsewhere, the pair has stopped being a
  // pair and become two unrelated profiles, which is the confusion ADR 0001 exists to fix.
  assert.deepEqual(Object.keys(straight.roles).sort(), Object.keys(pool.roles).sort());
  for (const role of ['default', 'security', 'code']) {
    assert.equal(straight.roles[role]!.model, coder, role);
    assert.equal(pool.roles[role]!.model, coder, role);
    assert.equal(straight.roles[role]!.provider, source, role);
    assert.equal(pool.roles[role]!.provider, source, role);
    assert.equal(straight.roles[role]!.workload, 'full-window', role);
    assert.equal(pool.roles[role]!.workload, 'fan-out', role);
  }

  // Perception stays with the model that can perceive, local, on its own default workload —
  // the coder's window and slot count say nothing about how Omni should be served.
  for (const profile of [straight, pool]) {
    for (const role of ['audio', 'image']) {
      assert.equal(profile.roles[role]!.model, 'qwen3-omni-30b', `${profile.id}/${role}`);
      assert.equal(profile.roles[role]!.provider, null, `${profile.id}/${role}`);
      assert.equal(profile.roles[role]!.workload, null, `${profile.id}/${role}`);
    }
  }
  assert.equal(straight.mode, 'local');
  assert.equal(pool.mode, 'local');
});

test('a hand-written Coder Next profile is not overwritten by its starter', (t) => {
  const root = scratch(t);
  // The live profiles on a machine carry hand-written budget tables and measurements that
  // `save()` would re-serialise away. Seeding must adopt the id, never rewrite the file.
  const mine = 'id: coder-next-pool\nname: Mine\n# measured on this box\nroles:\n  default: some-other-model\n';
  writeFileSync(join(root, 'coder-next-pool.yaml'), mine);
  profiles.ensureSeeded();
  assert.equal(readFileSync(join(root, 'coder-next-pool.yaml'), 'utf8'), mine);
  assert.equal(profiles.find('coder-next-pool')!.name, 'Mine');
  // The other starter is still written, because only the one that already existed was skipped.
  assert.equal(profiles.find('coder-next-straight')!.name, 'Coder Next - full window');
});

test('a fresh Two boxes profile gives the media roles a model that can perceive media', (t) => {
  scratch(t);
  profiles.ensureSeeded();

  const twoBox = profiles.find('two-box')!;
  for (const role of ['audio', 'image'] as const) {
    // These used to name the coder, which is text-only: an agent tagged `image` was bound to
    // a model that cannot look at one.
    assert.equal(twoBox.roles[role].model, qwen3Omni);
    // Local on purpose — a screenshot of this desktop is never sent to the other box to be read.
    assert.equal(twoBox.roles[role].provider, null);
  }
  // Omni is not the better coder, it is the one with senses, so the code role does not move.
  assert.equal(twoBox.roles.code.model, 'qwen3-coder-30b');
  // No longer pinned to a source id that existed on one developer's machine: null resolves
  // to whichever connected source serves the coder, which on two boxes is still the second.
  assert.equal(twoBox.roles.code.provider, null);
});

const handWrittenTwoBox = `id: two-box
name: My two boxes
roles:
  default: my-generalist
  code: my-coder
`;

test('an existing two-box profile on disk is never rewritten by seeding', (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'two-box.yaml'), handWrittenTwoBox);
  writeFileSync(join(root, '.seeded'), 'two-box\n');

  profiles.ensureSeeded();

  // Seeding writes starters that have not been offered before and never replaces a file that
  // is already there. The one-time builtin upgrade that used to overwrite an untouched starter
  // was removed with the pre-public fingerprints it compared against, so this now holds by
  // construction rather than by a byte comparison -- which is exactly why it stays tested.
  assert.equal(profiles.find('two-box')!.roles.default.model, 'my-generalist');
  assert.equal(readFileSync(join(root, 'two-box.yaml'), 'utf8'), handWrittenTwoBox);
});

test('profile categories migrate single to local and retain unclassified profiles for explicit assignment', (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'solo.yaml'), 'id: solo\nname: Solo\nmode: single\nroles:\n  default: m\n');
  writeFileSync(join(root, 'spread.yaml'), 'id: spread\nname: Spread\nmode: DISTRIBUTED\nroles:\n  default: m\n');
  writeFileSync(join(root, 'plain.yaml'), 'id: plain\nname: Plain\nroles:\n  default: m\n');
  writeFileSync(join(root, 'bogus.yaml'), 'id: bogus\nname: Bogus\nmode: sideways\nroles:\n  default: m\n');

  assert.equal(profiles.find('solo')!.mode, 'local');
  // Case is not a distinction anyone means to make.
  assert.equal(profiles.find('spread')!.mode, 'distributed');
  assert.equal(profiles.find('plain')!.mode, undefined);
  // Unknown categories remain unclassified and can be assigned in the library.
  assert.equal(profiles.find('bogus')!.mode, undefined);
});

test('renaming edits one field and leaves the rest of a hand-written file untouched', (t) => {
  const root = scratch(t);
  const path = join(root, 'kept.yaml');
  const original = '# why this profile exists\nid: kept\nname: Old Name\nmode: single\nroles:\n  # the generalist\n  default: m\n';
  writeFileSync(path, original);

  const renamed = profiles.rename('kept', 'New Name')!;
  assert.equal(renamed.name, 'New Name');
  assert.equal(renamed.id, 'kept', 'the id is the file name and the selection marker, so it must not move');

  const after = readFileSync(path, 'utf8');
  assert.match(after, /# why this profile exists/, 'comments must survive a rename');
  assert.match(after, /# the generalist/);
  assert.match(after, /^mode: single$/m, 'unrelated fields must survive');
  assert.doesNotMatch(after, /Old Name/);
});

test('tagging a stack adds the field when absent and clears it when set to null', (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'p.yaml'), 'id: p\nname: P\nroles:\n  default: m\n');
  assert.equal(profiles.setMode('p', 'distributed')!.mode, 'distributed');
  assert.equal(profiles.find('p')!.mode, 'distributed');
  assert.equal(profiles.setMode('p', 'provider')!.mode, 'provider');
  assert.equal(profiles.setMode('p', 'local')!.mode, 'local');
  assert.equal(profiles.setMode('p', null)!.mode, undefined, 'clearing returns it to inference from its bindings');
  assert.throws(() => profiles.rename('p', '   '), /1-200 characters/, 'a blank rename is refused, not silently applied');
});

test('a saved profile round-trips its slots, including the workload each names', (t) => {
  scratch(t);
  const saved = profiles.save({
    id: 'single-box',
    name: 'Single box',
    description: 'Coder thinks, Omni sees.',
    mode: 'local',
    roles: {
      default: { provider: 'local-coder', model: 'qwen3-coder-30b', workload: 'orchestrated' },
      code: { provider: 'local-coder', model: 'qwen3-coder-30b', workload: 'orchestrated' },
      // A slot may leave the workload out and mean the model's default.
      image: { provider: 'local-omni', model: 'qwen3-omni-30b' },
    },
  });

  assert.equal(saved.name, 'Single box');
  assert.equal(saved.description, 'Coder thinks, Omni sees.');
  assert.equal(saved.mode, 'local');
  assert.deepEqual(saved.roles.default, { provider: 'local-coder', model: 'qwen3-coder-30b', workload: 'orchestrated' });
  assert.deepEqual(saved.roles.image, { provider: 'local-omni', model: 'qwen3-omni-30b', workload: null });

  // Re-reading from disk must give the same thing: the YAML is the format of record.
  const reread = profiles.find('single-box')!;
  assert.deepEqual(reread.roles, saved.roles);
  assert.equal(reread.builtin, false, 'a saved profile is the person’s, not a built-in');

  // The same model in two roles under one workload is the point of the level.
  assert.equal(reread.roles.code.model, reread.roles.default.model);
  assert.equal(reread.roles.code.workload, 'orchestrated');
});

test('a binding carries its workload to the agent that matched the role', (t) => {
  scratch(t);
  const profile = profiles.save({
    id: 'mixed',
    name: 'Mixed',
    description: '',
    roles: {
      default: { provider: 'local-coder', model: 'coder', workload: 'wide' },
      image: { provider: 'local-omni', model: 'omni', workload: 'image' },
    },
  });

  // bindingFor matches the agent's own tags, first tag naming a role wins.
  assert.equal(profiles.bindingFor({ tags: ['image'] }, profile).workload, 'image');
  assert.equal(profiles.bindingFor({ tags: ['image'] }, profile).model, 'omni');
  // An agent matching nothing gets `default`, workload included.
  assert.equal(profiles.bindingFor({ tags: ['research'] }, profile).workload, 'wide');
  assert.equal(profiles.bindingFor({ tags: [] }, profile).workload, 'wide');
});
