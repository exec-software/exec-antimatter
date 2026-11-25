import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ATOMA_DEFAULT_WIDTH,
  DEFAULT_REGION_SIZES,
  emptyLayout,
  enterStage,
  normalizeLayout,
  normalizeManifest,
  panelsInRegion,
  resolvePanels,
  type UniverseManifest,
} from '../src/api/universes';
import { BUILT_IN_UNIVERSES, DEFAULT_UNIVERSE_ID, GENERATOR_SPECS, generatorSpec } from '../src/api/universeCatalog';
import {
  canonicalGrant,
  compareRelease,
  isOpen,
  normalizeGrant,
  resolveEntitlement,
  type LicenceGrant,
} from '../src/api/universeLicences';
import { bindingProblem, emptyBinding, fitRequest, normalizeRequest } from '../src/api/generators';
import * as universes from '../src/main/universes';

const manifest = (over: Record<string, unknown> = {}): unknown => ({
  version: 1,
  id: 'test-universe',
  name: 'Test',
  tagline: 'A universe for testing.',
  panels: [{ id: 'main-panel', kind: 'viewer', title: 'Viewer', region: 'main', open: true }],
  ...over,
});

function root(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'antimatter-universes-'));
  t.after(() => {
    universes.useRoot(join(directory, 'unused'));
    universes.useSigningKeys({});
    rmSync(directory, { recursive: true, force: true });
  });
  universes.useRoot(directory);
  return directory;
}

// ------------------------------------------------------------------ the catalogue's own honesty

test('every built-in manifest survives the parser an expansion goes through', () => {
  // The whole claim of the universe format is that a built-in is not special. If Code or Movie
  // needed a field the parser rejects, the format would be a fiction and the first third-party
  // universe would find out the hard way.
  for (const built of BUILT_IN_UNIVERSES) {
    const parsed = normalizeManifest(JSON.parse(JSON.stringify(built)));
    assert.deepEqual(parsed, built, `${built.id} did not round-trip through normalizeManifest`);
  }
});

test('the default universe exists and is built in, so it can never be unlicensed', () => {
  const fallback = BUILT_IN_UNIVERSES.find((entry) => entry.id === DEFAULT_UNIVERSE_ID);
  assert.ok(fallback, 'the default universe is not in the catalogue');
  assert.equal(fallback.entitlement, 'built-in');
});

test('every generator a universe names actually exists', () => {
  for (const built of BUILT_IN_UNIVERSES) {
    for (const id of built.generators) {
      assert.ok(generatorSpec(id), `${built.id} names generator ${id}, which is not in the catalogue`);
    }
  }
});

test('every stage names panels its own manifest declares', () => {
  for (const built of BUILT_IN_UNIVERSES) {
    const ids = new Set(built.panels.map((panel) => panel.id));
    for (const stage of built.stages) {
      for (const id of stage.panels) assert.ok(ids.has(id), `${built.id}/${stage.id} names a missing panel ${id}`);
    }
  }
});

test('weights that ship inside the application are redistributable', () => {
  // The licence is the gating property, not the quality: a packaged expansion can only carry
  // weights we are allowed to redistribute. Anything else is endpoint-only by construction.
  for (const spec of GENERATOR_SPECS) {
    if (!spec.weights) continue;
    assert.match(spec.weights.licence, /Apache-2\.0|MIT|BSD/, `${spec.id} ships weights under ${spec.weights.licence}`);
  }
});

// ------------------------------------------------------------------ manifests

test('a manifest with no readable id or panels is not a universe', () => {
  assert.equal(normalizeManifest(null), null);
  assert.equal(normalizeManifest(manifest({ id: '../escape' })), null);
  assert.equal(normalizeManifest(manifest({ id: 'Has-Capitals' })), null);
  assert.equal(normalizeManifest(manifest({ panels: [] })), null);
  // A workbench whose only panel is unreadable is a blank page with a name on it.
  assert.equal(normalizeManifest(manifest({ panels: [{ id: 'x', kind: 'wormhole' }] })), null);
});

test('an unknown panel kind is dropped, and the rest of the workbench opens', () => {
  const parsed = normalizeManifest(
    manifest({
      panels: [
        { id: 'good', kind: 'viewer', title: 'Viewer', region: 'main', open: true },
        { id: 'future', kind: 'holodeck', title: 'Holodeck', region: 'right', open: true },
        { id: 'good', kind: 'notes', title: 'Duplicate', region: 'right', open: true },
      ],
    })
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.panels.map((panel) => panel.id), ['good']);
  assert.equal(parsed.panels[0].kind, 'viewer', 'the first of a duplicated id wins');
});

test('a stage naming a panel that is not in the manifest loses the reference, not the stage', () => {
  const parsed = normalizeManifest(
    manifest({
      stages: [{ id: 'one', name: 'One', intent: 'first', panels: ['main-panel', 'ghost'] }],
    })
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.stages[0].panels, ['main-panel']);
});

test('entitlement defaults to included, never to licensed', () => {
  // Defaulting the other way would mean a manifest with a typo closing a universe that is free.
  assert.equal(normalizeManifest(manifest())?.entitlement, 'included');
  assert.equal(normalizeManifest(manifest({ entitlement: 'nonsense' }))?.entitlement, 'included');
  assert.equal(normalizeManifest(manifest({ entitlement: 'licensed' }))?.entitlement, 'licensed');
  assert.equal(normalizeManifest(manifest({ entitlement: 'built-in' }))?.entitlement, 'built-in');
});

// ------------------------------------------------------------------ layouts

test('a layout nobody has touched defers to the manifest', () => {
  const parsed = normalizeManifest(
    manifest({
      panels: [
        { id: 'a', kind: 'viewer', title: 'A', region: 'main', open: true },
        { id: 'b', kind: 'notes', title: 'B', region: 'right', open: false },
      ],
    })
  ) as UniverseManifest;
  const resolved = resolvePanels(parsed, emptyLayout(parsed.id));
  assert.deepEqual(resolved.map((panel) => [panel.id, panel.region, panel.open]), [
    ['a', 'main', true],
    ['b', 'right', false],
  ]);
  assert.deepEqual(panelsInRegion(resolved, 'right'), [], 'a closed panel does not occupy its region');
});

test("the person's layout outranks the manifest", () => {
  const parsed = normalizeManifest(manifest()) as UniverseManifest;
  const layout = normalizeLayout({ regions: { 'main-panel': 'bottom' }, open: { 'main-panel': false } }, parsed.id);
  const resolved = resolvePanels(parsed, layout);
  assert.equal(resolved[0].region, 'bottom');
  assert.equal(resolved[0].open, false);
});

test('a layout is bounded, and nonsense in it falls back rather than throwing', () => {
  const layout = normalizeLayout(
    {
      regions: { ok: 'left', '../escape': 'left', bad: 'orbit' },
      open: { ok: true, nope: 'yes' },
      sizes: { left: 99_999, right: Number.NaN },
      stageId: 'a/b',
      atoma: { open: true, x: Number.POSITIVE_INFINITY, y: 10, width: 10, height: 10 },
    },
    'u'
  );
  assert.deepEqual(layout.regions, { ok: 'left' });
  assert.deepEqual(layout.open, { ok: true });
  assert.equal(layout.sizes.left, 1200, 'an absurd size is clamped, not kept');
  assert.equal(layout.sizes.right, undefined);
  assert.equal(layout.stageId, null);
  assert.equal(layout.atoma?.x, 0, 'a non-finite position falls back to the origin');
  // Below the minimum the panel would be unusable, so the minimum wins over what was stored.
  assert.ok(layout.atoma && layout.atoma.width >= 280);
});

test('entering a stage brings panels forward and closes nothing', () => {
  const layout = { ...emptyLayout('u'), open: { queue: true, brief: false } };
  const next = enterStage(layout, { id: 'cut', name: 'Cut', intent: '', panels: ['timeline', 'brief'] });
  assert.equal(next.open.timeline, true);
  assert.equal(next.open.brief, true);
  assert.equal(next.open.queue, true, 'a panel the stage does not name is left as the person had it');
  assert.equal(next.stageId, 'cut');
});

// ------------------------------------------------------------------ licences

const KEY_ID = 'test-key-1';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    private: privateKey,
    publicBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function grant(privateKey: ReturnType<typeof keypair>['private'], over: Partial<LicenceGrant> = {}): LicenceGrant {
  const unsigned: LicenceGrant = {
    version: 1,
    universeId: 'movie',
    holder: 'A Studio',
    edition: 'studio',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    seats: 5,
    throughRelease: null,
    keyId: KEY_ID,
    signature: '',
    ...over,
  };
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalGrant(unsigned), 'utf8'), privateKey).toString('base64') };
}

test('the signed payload is field-ordered, not key-ordered', () => {
  // Signing a `JSON.stringify` of the object would make every existing grant stop verifying the
  // day a field was added or reordered. This asserts the shape is fixed on purpose.
  const base = grant(keypair().private);
  const shuffled = Object.fromEntries(Object.entries(base).reverse()) as unknown as LicenceGrant;
  assert.equal(canonicalGrant(shuffled), canonicalGrant(base));
  assert.match(canonicalGrant(base), /^\["antimatter-universe-licence",1,"movie"/);
});

test('a built-in or included universe never consults a grant', () => {
  // The failure that makes people distrust licensing is a corrupt file closing something free.
  const refuse = () => false;
  for (const kind of ['built-in', 'included'] as const) {
    const entitlement = resolveEntitlement('movie', kind, grant(keypair().private, { universeId: 'other' }), refuse);
    assert.equal(entitlement.state, 'granted', `${kind} should not depend on a grant`);
    assert.equal(entitlement.grant, null);
    assert.ok(isOpen(entitlement));
  }
});

test('a licensed universe with no grant is absent, not invalid', () => {
  const entitlement = resolveEntitlement('movie', 'licensed', null, () => true);
  assert.equal(entitlement.state, 'absent');
  assert.match(entitlement.reason, /No licence/);
});

test('a grant for another universe does not open this one', () => {
  const keys = keypair();
  const entitlement = resolveEntitlement('movie', 'licensed', grant(keys.private, { universeId: 'audio' }), () => true);
  assert.equal(entitlement.state, 'invalid');
  assert.match(entitlement.reason, /for audio/);
});

test('a grant whose signature does not verify is invalid', () => {
  const entitlement = resolveEntitlement('movie', 'licensed', grant(keypair().private), () => false);
  assert.equal(entitlement.state, 'invalid');
  assert.match(entitlement.reason, /could not be verified/);
});

test('expiry is a date check, and a live grant reports what is left', () => {
  const keys = keypair();
  const expiring = grant(keys.private, { expiresAt: '2026-06-01T00:00:00.000Z' });
  const after = resolveEntitlement('movie', 'licensed', expiring, () => true, Date.parse('2026-07-01T00:00:00.000Z'));
  assert.equal(after.state, 'expired');
  assert.equal(after.daysRemaining, 0);

  const before = resolveEntitlement('movie', 'licensed', expiring, () => true, Date.parse('2026-05-22T00:00:00.000Z'));
  assert.equal(before.state, 'granted');
  assert.equal(before.daysRemaining, 10);
});

test('a grant can cover releases up to a point and no further', () => {
  const keys = keypair();
  const capped = grant(keys.private, { throughRelease: '2' });
  const covered = resolveEntitlement('movie', 'licensed', capped, () => true, Date.now(), '2');
  assert.equal(covered.state, 'granted');
  const beyond = resolveEntitlement('movie', 'licensed', capped, () => true, Date.now(), '3');
  assert.equal(beyond.state, 'invalid');
  assert.match(beyond.reason, /up to 2/);
});

test('releases compare numerically, and unparseable parts are zero rather than a throw', () => {
  assert.equal(compareRelease('1', '1'), 0);
  assert.equal(compareRelease('1.2', '1.10'), -1);
  assert.equal(compareRelease('2', '1.9.9'), 1);
  assert.equal(compareRelease('', 'x'), 0);
});

test('a grant missing the fields it is identified by is not a grant', () => {
  assert.equal(normalizeGrant(null), null);
  assert.equal(normalizeGrant({ universeId: 'movie' }), null);
  assert.equal(normalizeGrant({ universeId: 'movie', issuedAt: 'not a date', signature: 's', keyId: 'k', edition: 'studio' }), null);
  const parsed = normalizeGrant({ universeId: 'movie', issuedAt: '2026-01-01', signature: 's', keyId: 'k', edition: 'studio', seats: 0 });
  assert.ok(parsed);
  assert.equal(parsed.seats, 1, 'a zero-seat licence is a mistake, not a licence for nobody');
});

// ------------------------------------------------------------------ the main-process registry

test('a universe id reaches a file name, so it is strict about what it accepts', () => {
  assert.equal(universes.assertUniverseId('movie'), 'movie');
  for (const bad of ['../escape', 'a/b', '', 'Movie', 'x'.repeat(100), 'has space']) {
    assert.throws(() => universes.assertUniverseId(bad), /Invalid universe id/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a layout survives a restart, and a patch merges rather than replaces', (t) => {
  root(t);
  universes.saveLayout('movie', { regions: { shots: 'right' }, open: { queue: true }, sizes: { left: 300 } });
  const stored = universes.readLayout('movie');
  assert.equal(stored.regions.shots, 'right');
  assert.equal(stored.sizes.left, 300);

  // The bug this guards: `normalizeLayout` fills in empty objects for every field, so merging
  // unconditionally would wipe regions and sizes on a patch that only moved the stage.
  const patched = universes.patchLayout('movie', { stageId: 'cut' });
  assert.equal(patched.stageId, 'cut');
  assert.equal(patched.regions.shots, 'right', 'a stage patch must not clear the arrangement');
  assert.equal(patched.sizes.left, 300);
  assert.equal(patched.open.queue, true);

  const merged = universes.patchLayout('movie', { open: { brief: false } });
  assert.equal(merged.open.queue, true, 'one panel toggling must not close the others');
  assert.equal(merged.open.brief, false);
});

test('an unreadable layout is the default layout, and the file is left alone', (t) => {
  const directory = root(t);
  mkdirSync(join(directory, 'layouts'), { recursive: true });
  writeFileSync(join(directory, 'layouts', 'movie.json'), '{ this is not json');
  const layout = universes.readLayout('movie');
  assert.deepEqual(layout.regions, {});
  assert.equal(layout.sizes.left, undefined);
  assert.equal(
    readFileSync(join(directory, 'layouts', 'movie.json'), 'utf8'),
    '{ this is not json',
    'the only copy of whatever was salvageable must not be overwritten'
  );
});

test('the built-ins are listed, and an expansion cannot shadow one', (t) => {
  const directory = root(t);
  // An expansion claiming to be Code would otherwise replace the one universe that can never be
  // unlicensed, which is the obvious way to attack this.
  mkdirSync(join(directory, 'expansions', 'code'), { recursive: true });
  writeFileSync(
    join(directory, 'expansions', 'code', 'universe.json'),
    JSON.stringify(manifest({ id: 'code', name: 'Impostor', entitlement: 'licensed' }))
  );
  const listed = universes.manifests();
  const code = listed.filter((entry) => entry.id === 'code');
  assert.equal(code.length, 1);
  assert.equal(code[0].name, 'Code');
  assert.equal(code[0].entitlement, 'built-in');
});

test('an expansion whose manifest claims a different id than its directory is refused', (t) => {
  const directory = root(t);
  mkdirSync(join(directory, 'expansions', 'audio'), { recursive: true });
  writeFileSync(join(directory, 'expansions', 'audio', 'universe.json'), JSON.stringify(manifest({ id: 'photo' })));
  assert.equal(universes.manifests().some((entry) => entry.id === 'photo'), false);
  assert.equal(universes.manifests().some((entry) => entry.id === 'audio'), false);
});

test('one broken expansion does not cost the others, or the built-ins', (t) => {
  const directory = root(t);
  for (const [id, body] of [
    ['broken', 'not json at all'],
    ['good-one', JSON.stringify(manifest({ id: 'good-one', name: 'Good' }))],
  ] as const) {
    mkdirSync(join(directory, 'expansions', id), { recursive: true });
    writeFileSync(join(directory, 'expansions', id, 'universe.json'), body);
  }
  const ids = universes.manifests().map((entry) => entry.id);
  assert.ok(ids.includes('code'));
  assert.ok(ids.includes('good-one'));
  assert.equal(ids.includes('broken'), false);
});

test('an installed licence opens a licensed expansion, and removing it closes it again', (t) => {
  const directory = root(t);
  const keys = keypair();
  universes.useSigningKeys({ [KEY_ID]: keys.publicBase64 });
  mkdirSync(join(directory, 'expansions', 'audio'), { recursive: true });
  writeFileSync(
    join(directory, 'expansions', 'audio', 'universe.json'),
    JSON.stringify(manifest({ id: 'audio', name: 'Audio', entitlement: 'licensed', release: '1' }))
  );

  assert.equal(universes.entitlementFor(universes.manifest('audio')!).state, 'absent');
  assert.throws(() => universes.assertOpen('audio'), /No licence/);

  const installed = universes.installGrant(JSON.stringify(grant(keys.private, { universeId: 'audio' })));
  assert.equal(installed.state, 'granted');
  assert.equal(universes.assertOpen('audio').id, 'audio');

  const removed = universes.removeGrant('audio');
  assert.equal(removed.state, 'absent');
  assert.throws(() => universes.assertOpen('audio'), /No licence/);
});

test('an unsigned or wrongly signed licence is refused rather than stored', (t) => {
  const directory = root(t);
  const keys = keypair();
  const other = keypair();
  universes.useSigningKeys({ [KEY_ID]: keys.publicBase64 });
  mkdirSync(join(directory, 'expansions', 'audio'), { recursive: true });
  writeFileSync(
    join(directory, 'expansions', 'audio', 'universe.json'),
    JSON.stringify(manifest({ id: 'audio', entitlement: 'licensed' }))
  );

  assert.throws(() => universes.installGrant('not json'), /does not look like a licence/);
  assert.throws(() => universes.installGrant(JSON.stringify({ universeId: 'audio' })), /missing fields/);
  assert.throws(() => universes.installGrant(JSON.stringify(grant(other.private, { universeId: 'audio' }))), /could not be verified/);
  // Nothing was written, so the universe is still "no licence" rather than "invalid licence".
  assert.equal(universes.entitlementFor(universes.manifest('audio')!).state, 'absent');
});

test('an unknown signing key fails closed', (t) => {
  root(t);
  universes.useSigningKeys({});
  assert.equal(universes.verifyGrant('payload', 'c2ln', 'never-heard-of-it'), false);
});

test('a grant for an included universe is still checked, not waved through', (t) => {
  root(t);
  const keys = keypair();
  universes.useSigningKeys({ [KEY_ID]: keys.publicBase64 });
  // Movie ships included. Installing a bogus licence for it must fail rather than be accepted
  // on the grounds that the universe was free anyway — and must never close it either.
  assert.throws(() => universes.installGrant(JSON.stringify(grant(keypair().private))), /could not be verified/);
  assert.equal(universes.assertOpen('movie').id, 'movie');
});

test('an unknown universe cannot be opened, licensed or not', (t) => {
  root(t);
  assert.throws(() => universes.assertOpen('nope'), /not installed/);
  assert.throws(() => universes.removeGrant('nope'), /not installed/);
});

// ------------------------------------------------------------------ generators

test('a generator binding persists, and only known generators can be bound', (t) => {
  root(t);
  const listed = universes.generators();
  assert.equal(listed.length, GENERATOR_SPECS.length);
  assert.ok(listed.every((entry) => entry.problem), 'nothing is usable before it is configured');

  const after = universes.bindGenerator('video-endpoint', { enabled: true, endpoint: 'https://example.test/v1' });
  const endpoint = after.find((entry) => entry.spec.id === 'video-endpoint');
  assert.equal(endpoint?.problem, null);
  assert.equal(endpoint?.binding.endpoint, 'https://example.test/v1');
  // Read back through a fresh call, so this is the stored state and not the returned value.
  assert.equal(universes.binding('video-endpoint')?.enabled, true);

  assert.throws(() => universes.bindGenerator('made-up', { enabled: true }), /not one this release knows/);
});

test('a generator says why it cannot be used, in one place', () => {
  const spec = generatorSpec('video-endpoint')!;
  assert.match(bindingProblem(spec, undefined) ?? '', /not switched on/);
  assert.match(bindingProblem(spec, { ...emptyBinding(spec.id), enabled: true }) ?? '', /no endpoint/);
  assert.match(
    bindingProblem(spec, { ...emptyBinding(spec.id), enabled: true, endpoint: 'file:///etc/passwd' }) ?? '',
    /must be http/
  );
  assert.match(bindingProblem(spec, { ...emptyBinding(spec.id), enabled: true, endpoint: 'not a url' }) ?? '', /not a valid address/);
  assert.equal(bindingProblem(spec, { ...emptyBinding(spec.id), enabled: true, endpoint: 'http://127.0.0.1:9000' }), null);

  const unit = generatorSpec('wan-2-2-unit')!;
  assert.match(bindingProblem(unit, { ...emptyBinding(unit.id), enabled: true }) ?? '', /no service/);
  assert.equal(bindingProblem(unit, { ...emptyBinding(unit.id), enabled: true, unit: 'wan.service' }), null);
});

test('a request is bounded, and its dimensions land on the stride every pipeline has', () => {
  assert.equal(normalizeRequest({ generatorId: 'x' }), null, 'a request with no prompt is not a request');
  assert.equal(normalizeRequest({ prompt: 'a' }), null);
  const request = normalizeRequest({ generatorId: 'x', prompt: 'a lighthouse', width: 1023, height: 577, seconds: 999, fps: 0, seed: -7.9 });
  assert.ok(request);
  assert.equal(request.width % 8, 0);
  assert.equal(request.height % 8, 0);
  assert.equal(request.seconds, 120, 'an absurd duration is clamped rather than refused');
  assert.equal(request.fps, 1);
  assert.equal(request.seed, 7, 'a seed is a non-negative integer or it is not reproducible');
});

test('a request is fitted to what the backend can do, and says what it changed', () => {
  const spec = generatorSpec('wan-2-2-comfy')!;
  const asked = normalizeRequest({ generatorId: spec.id, prompt: 'wide shot', width: 2560, height: 1440, seconds: 12, fps: 60, firstFrame: 'ref.png' })!;
  const { request, notes } = fitRequest(asked, spec.capabilities);
  assert.ok(request.width <= spec.capabilities.maxWidth && request.height <= spec.capabilities.maxHeight);
  // Scaled, not cropped: the framing is the person's and the resolution is the model's.
  assert.ok(Math.abs(request.width / request.height - 2560 / 1440) < 0.05);
  assert.equal(request.seconds, spec.capabilities.maxSeconds);
  assert.equal(request.fps, spec.capabilities.fps);
  assert.equal(request.firstFrame, 'ref.png', 'this generator can start from a still');
  assert.equal(notes.length, 3);
  assert.ok(notes.some((note) => /tops out/.test(note)));

  const silent = fitRequest(asked, { ...spec.capabilities, imageToVideo: false });
  assert.equal(silent.request.firstFrame, undefined);
  assert.ok(silent.notes.some((note) => /cannot start from a still/.test(note)));
});

test('a fitted request within the limits is left alone and reports nothing', () => {
  const spec = generatorSpec('wan-2-2-comfy')!;
  const asked = normalizeRequest({ generatorId: spec.id, prompt: 'close on hands', width: 1280, height: 720, seconds: 4, fps: 24 })!;
  const { request, notes } = fitRequest(asked, spec.capabilities);
  assert.deepEqual(request, asked);
  assert.deepEqual(notes, []);
});

test('the default region sizes and the floating chat have usable defaults', () => {
  // Cheap, and it has been wrong before: a zero default means an invisible region.
  for (const region of ['left', 'right', 'bottom'] as const) {
    assert.ok(DEFAULT_REGION_SIZES[region] >= 200, `${region} opens too small to use`);
  }
  assert.ok(ATOMA_DEFAULT_WIDTH >= 280);
});
