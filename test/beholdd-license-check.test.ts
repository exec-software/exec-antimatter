import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The command is exercised in a private fixture tree with the reviewed sealed license corpus.
// Fake Git/Cargo responses avoid reading, changing, or rebuilding any sibling repository.
const repository = process.cwd();
const pinnedCommit = JSON.parse(fs.readFileSync(path.join(repository, 'vendor/beholdd/manifest.json'), 'utf8')).commit as string;
const differentCommit = 'f'.repeat(40) === pinnedCommit ? 'e'.repeat(40) : 'f'.repeat(40);

function fixture(run: (value: { root: string; source: string; invoke: (args?: string[], environment?: Record<string, string>) => ReturnType<typeof spawnSync> }) => void, component: 'beholdd' | 'beholdd-hag' = 'beholdd'): void {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'antimatter-license-check-'));
  const root = path.join(temporary, 'antimatter');
  const source = path.join(temporary, 'beholdd');
  const executables = path.join(temporary, 'bin');
  try {
    for (const directory of ['scripts', `vendor/${component}`, 'releases/licenses']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.mkdirSync(source);
    fs.mkdirSync(executables);
    fs.copyFileSync(path.join(repository, 'scripts/generate-beholdd-licenses.mjs'), path.join(root, 'scripts/generate-beholdd-licenses.mjs'));
    fs.copyFileSync(path.join(repository, 'vendor', component, 'manifest.json'), path.join(root, 'vendor', component, 'manifest.json'));
    fs.copyFileSync(path.join(repository, 'releases/licenses/Apache-2.0.txt'), path.join(root, 'releases/licenses/Apache-2.0.txt'));
    fs.cpSync(path.join(repository, 'releases/licenses', component), path.join(root, 'releases/licenses', component), { recursive: true });
    const componentCommit = JSON.parse(fs.readFileSync(path.join(root, 'vendor', component, 'manifest.json'), 'utf8')).commit as string;
    fs.writeFileSync(path.join(root, 'scripts/deps.json'), JSON.stringify({ dependencies: [{ name: component, source: '../beholdd', sourceEnv: 'ANTIMATTER_BEHOLDD_SOURCE', sourceCommit: componentCommit, repository: 'https://github.com/exec-software/exec-beholdd', build: { cargoFeatures: component === 'beholdd-hag' ? ['hag-native'] : [] } }] }));
    fs.writeFileSync(path.join(source, 'Cargo.lock'), '# synthetic lock\n');
    fs.writeFileSync(path.join(executables, 'git'), '#!/bin/sh\ncase "$1" in\nrev-parse) printf "%s\\n" "$TEST_LICENSE_HEAD" ;;\nremote) printf "%s\\n" "https://github.com/exec-software/exec-beholdd.git" ;;\nstatus) printf "%s" "$TEST_LICENSE_DIRTY" ;;\n*) exit 88 ;;\nesac\n', { mode: 0o755 });
    fs.writeFileSync(path.join(executables, 'cargo'), '#!/bin/sh\nprintf "%s\\n" "synthetic cargo comparison reached" >&2\nexit 89\n', { mode: 0o755 });
    const invoke = (args: string[] = [], environment: Record<string, string> = {}) => {
      const env = { ...process.env };
      delete env.ANTIMATTER_BEHOLDD_SOURCE;
      return spawnSync(process.execPath, [path.join(root, 'scripts/generate-beholdd-licenses.mjs'), '--check', '--component', component, ...args], {
        cwd: root, encoding: 'utf8', env: { ...env, PATH: `${executables}${path.delimiter}${process.env.PATH ?? ''}`, TEST_LICENSE_HEAD: differentCommit, TEST_LICENSE_DIRTY: '', ...environment },
      });
    };
    run({ root, source, invoke });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

test('license check verifies the sealed pinned bundle when the implicit sibling moved ahead', () => fixture(({ invoke }) => {
  const result = invoke();
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /skipped default sibling source comparison/);
  assert.ok(String(result.stdout).includes(pinnedCommit));
  assert.ok(String(result.stdout).includes(differentCommit));
  assert.match(String(result.stdout), /verified sealed Beholdd license bundle/);
}));

test('license check supports a release worktree without an implicit sibling', () => fixture(({ source, invoke }) => {
  fs.rmSync(source, { recursive: true });
  const result = invoke();
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /verified sealed Beholdd license bundle/);
  assert.doesNotMatch(String(result.stdout), /skipped default/);
}));

test('explicit --source at the wrong revision fails instead of skipping', () => fixture(({ source, invoke }) => {
  const result = invoke(['--source', source]);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /Explicit Beholdd source is at/);
  assert.doesNotMatch(String(result.stdout), /verified sealed/);
}));

test('explicit environment source at the wrong revision fails instead of skipping', () => fixture(({ source, invoke }) => {
  const result = invoke([], { ANTIMATTER_BEHOLDD_SOURCE: source });
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /Explicit Beholdd source is at/);
}));

test('missing explicitly selected source fails instead of skipping', () => fixture(({ source, invoke }) => {
  const result = invoke(['--source', path.join(source, 'missing')]);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /Explicit Beholdd source tree is missing/);
}));

test('a same-pin dirty sibling still fails the full source comparison', () => fixture(({ invoke }) => {
  const result = invoke([], { TEST_LICENSE_HEAD: pinnedCommit, TEST_LICENSE_DIRTY: ' M Cargo.lock\n' });
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /requires a clean source tree/);
  assert.doesNotMatch(String(result.stdout), /verified sealed|skipped default/);
}));

test('a same-pin clean sibling still reaches offline Cargo graph verification', () => fixture(({ invoke }) => {
  const result = invoke([], { TEST_LICENSE_HEAD: pinnedCommit });
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /synthetic cargo comparison reached/);
  assert.doesNotMatch(String(result.stdout), /verified sealed|skipped default/);
}));

test('corrupted license bundle cannot bypass verification through sibling drift', () => fixture(({ root, invoke }) => {
  fs.appendFileSync(path.join(root, 'releases/licenses/beholdd/THIRD_PARTY_LICENSES.txt'), 'tampered');
  const result = invoke();
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /bundle does not match its manifest/);
  assert.doesNotMatch(String(result.stdout), /skipped default/);
}));

test('license/vendor pin mismatch cannot bypass verification through sibling drift', () => fixture(({ root, invoke }) => {
  const file = path.join(root, 'vendor/beholdd/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.commit = differentCommit;
  fs.writeFileSync(file, JSON.stringify(manifest));
  const result = invoke();
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /license inventory is for/);
  assert.doesNotMatch(String(result.stdout), /skipped default/);
}));

for (const component of ['beholdd', 'beholdd-hag'] as const) {
  test(`${component} sealed licenses must match the configured source pin even when vendor and licenses agree`, () => fixture(({ root, source, invoke }) => {
    fs.rmSync(source, { recursive: true });
    const matching = invoke();
    assert.equal(matching.status, 0, String(matching.stderr));
    assert.match(String(matching.stdout), /verified sealed Beholdd license bundle/);

    const configurationPath = path.join(root, 'scripts/deps.json');
    const configuration = JSON.parse(fs.readFileSync(configurationPath, 'utf8'));
    const previousCommit = configuration.dependencies[0].sourceCommit;
    const nextCommit = previousCommit === 'f'.repeat(40) ? 'e'.repeat(40) : 'f'.repeat(40);
    configuration.dependencies[0].sourceCommit = nextCommit;
    fs.writeFileSync(configurationPath, JSON.stringify(configuration));

    const stale = invoke();
    assert.equal(stale.status, 1);
    assert.match(String(stale.stderr), /configured source pin/);
    assert.ok(String(stale.stderr).includes(previousCommit));
    assert.ok(String(stale.stderr).includes(nextCommit));
    assert.doesNotMatch(String(stale.stdout), /verified sealed|skipped default/);
  }, component));
}

test('experimental HAG licenses are separately pinned to the shipped feature-enabled executable', () => fixture(({ invoke }) => {
  const result = invoke();
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /verified sealed Beholdd license bundle/);
}, 'beholdd-hag'));

test('HAG license graph cannot silently omit the compiled feature', () => fixture(({ root, invoke }) => {
  const file = path.join(root, 'releases/licenses/beholdd-hag/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.cargoFeatures = [];
  fs.writeFileSync(file, JSON.stringify(manifest));
  const result = invoke();
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /Cargo features differ/);
}, 'beholdd-hag'));

test('HAG license graph requires the linked MIT native-compute package', () => fixture(({ root, invoke }) => {
  const file = path.join(root, 'releases/licenses/beholdd-hag/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.packages = manifest.packages.filter((pkg: { name: string }) => pkg.name !== 'exec-hag');
  manifest.packageCount = manifest.packages.length;
  fs.writeFileSync(file, JSON.stringify(manifest));
  const result = invoke();
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /linked MIT exec-hag/);
}, 'beholdd-hag'));
