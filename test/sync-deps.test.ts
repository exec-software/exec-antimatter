import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

interface FixtureDependency {
  name: string;
  description: string;
  source: string;
  sourceEnv?: string;
  sourceCommit?: string;
  repository: string;
  versionFrom: string;
  build: { command: string; args: string[]; rustPathRemapping?: boolean; cargoFeatures?: string[] };
  artifacts: { from: string; to: string; fromProject?: boolean; executable?: boolean; releaseForbiddenStrings?: string[] }[];
}

const projectScript = join(process.cwd(), 'scripts', 'sync-deps.mjs');

function scratchProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-sync-deps-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(projectScript, join(root, 'scripts', 'sync-deps.mjs'));
  return root;
}

function dependency(root: string, name: string, { artifact = true } = {}): FixtureDependency {
  const source = join('sources', name);
  const sourcePath = join(root, source);
  mkdirSync(join(sourcePath, 'dist', 'tree'), { recursive: true });
  writeFileSync(join(sourcePath, 'package.json'), `${JSON.stringify({ name, version: '1.2.3' })}\n`);
  writeFileSync(join(sourcePath, '.gitignore'), 'dist/build-environment.txt\n');
  if (artifact) writeFileSync(join(sourcePath, 'dist', `${name}.bin`), `${name}-payload`);
  writeFileSync(join(sourcePath, 'dist', 'tree', 'data.txt'), `${name}-tree`);

  git(sourcePath, ['init', '--quiet']);
  git(sourcePath, ['config', 'user.email', 'release-test@example.invalid']);
  git(sourcePath, ['config', 'user.name', 'Release Test']);
  git(sourcePath, ['add', '.']);
  git(sourcePath, ['commit', '--quiet', '-m', 'fixture']);
  git(sourcePath, ['remote', 'add', 'origin', `git@github.com:example/${name}.git`]);

  return {
    name,
    description: `${name} fixture`,
    source,
    repository: `https://github.com/example/${name}`,
    versionFrom: 'package.json',
    build: { command: process.execPath, args: ['-e', ''] },
    artifacts: [
      { from: `dist/${name}.bin`, to: `bin/${name}`, executable: true },
      { from: 'dist/tree', to: 'share/tree' },
    ],
  };
}

function configure(root: string, dependencies: FixtureDependency[]): void {
  writeFileSync(join(root, 'scripts', 'deps.json'), `${JSON.stringify({ dependencies }, null, 2)}\n`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function run(root: string, args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'sync-deps.mjs'), ...args], {
    // Deliberately run elsewhere: configured relative sources belong to the script's project
    // root, not to whichever directory invoked the command.
    cwd: tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

test('release sync records canonical exact provenance and verification detects tampering', () => {
  const root = scratchProject();
  try {
    const fixture = dependency(root, 'beholdd');
    const secondFixture = dependency(root, 'displacer');
    configure(root, [fixture, secondFixture]);

    const synced = run(root, ['--release', '--skip-build', 'beholdd', 'displacer']);
    assert.equal(synced.status, 0, synced.stderr);

    const manifestPath = join(root, 'vendor', 'beholdd', 'manifest.json');
    const manifestText = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.source, 'https://github.com/example/beholdd');
    assert.equal(manifest.commit, git(join(root, fixture.source), ['rev-parse', 'HEAD']));
    assert.match(manifest.commit, /^[0-9a-f]{40}$/);
    assert.equal(manifest.dirty, false);
    assert.equal(manifest.artifacts[0].type, 'file');
    assert.equal(manifest.artifacts[1].type, 'directory');
    assert.equal(manifestText.includes(join(root, fixture.source)), false);
    assert.equal(
      readFileSync(join(root, 'vendor', 'displacer', 'manifest.json'), 'utf8').includes(
        join(root, secondFixture.source)
      ),
      false
    );

    const verified = run(root, ['--verify', 'beholdd', 'displacer']);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /verified beholdd/);
    assert.match(verified.stdout, /verified displacer/);

    // Preserve the byte count so this exercises the digest check, not only size checking.
    writeFileSync(join(root, 'vendor', 'beholdd', 'bin', 'beholdd'), 'changed-payload');
    const corrupted = run(root, ['--verify', 'beholdd', 'displacer']);
    assert.notEqual(corrupted.status, 0);
    assert.match(corrupted.stderr, /hash mismatch for bin\/beholdd/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release mode refuses dirt without changing vendor while normal sync preserves a dirty marker', () => {
  const root = scratchProject();
  try {
    const fixture = dependency(root, 'alpha');
    configure(root, [fixture]);
    assert.equal(run(root, ['--release', '--skip-build', 'alpha']).status, 0);
    const manifestPath = join(root, 'vendor', 'alpha', 'manifest.json');
    const originalManifest = readFileSync(manifestPath, 'utf8');
    const originalArtifact = readFileSync(join(root, 'vendor', 'alpha', 'bin', 'alpha'), 'utf8');

    appendFileSync(join(root, fixture.source, 'dist', 'alpha.bin'), '-development');
    const release = run(root, ['--release', '--skip-build', 'alpha']);
    assert.notEqual(release.status, 0);
    assert.match(release.stderr, /release sync refuses a dirty dependency tree/);
    assert.equal(readFileSync(manifestPath, 'utf8'), originalManifest);
    assert.equal(readFileSync(join(root, 'vendor', 'alpha', 'bin', 'alpha'), 'utf8'), originalArtifact);

    const development = run(root, ['--skip-build', 'alpha']);
    assert.equal(development.status, 0, development.stderr);
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).dirty, true);

    const verify = run(root, ['--verify', 'alpha']);
    assert.notEqual(verify.status, 0);
    assert.match(verify.stderr, /dirty dependency tree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit source environment variable overrides the portable sibling default', () => {
  const root = scratchProject();
  try {
    const fixture = dependency(root, 'alpha');
    const actualSource = join(root, fixture.source);
    fixture.source = '../source-not-at-the-default-location';
    fixture.sourceEnv = 'ANTIMATTER_TEST_ALPHA_SOURCE';
    configure(root, [fixture]);

    const synced = run(root, ['--release', '--skip-build', 'alpha'], {
      ANTIMATTER_TEST_ALPHA_SOURCE: actualSource,
    });
    assert.equal(synced.status, 0, synced.stderr);
    const manifest = readFileSync(join(root, 'vendor', 'alpha', 'manifest.json'), 'utf8');
    assert.equal(manifest.includes(actualSource), false);
    assert.equal(JSON.parse(manifest).source, 'https://github.com/example/alpha');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing artifact leaves every selected vendor target untouched', () => {
  const root = scratchProject();
  try {
    const alpha = dependency(root, 'alpha');
    const beta = dependency(root, 'beta', { artifact: false });
    configure(root, [alpha, beta]);
    for (const name of ['alpha', 'beta']) {
      mkdirSync(join(root, 'vendor', name), { recursive: true });
      writeFileSync(join(root, 'vendor', name, 'sentinel.txt'), `${name}-old`);
    }

    const result = run(root, ['--skip-build', 'alpha', 'beta']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /beta: artifact missing after build/);
    assert.equal(readFileSync(join(root, 'vendor', 'alpha', 'sentinel.txt'), 'utf8'), 'alpha-old');
    assert.equal(readFileSync(join(root, 'vendor', 'beta', 'sentinel.txt'), 'utf8'), 'beta-old');
    assert.equal(existsSync(join(root, 'vendor', 'alpha', 'manifest.json')), false);
    assert.deepEqual(readdirSync(join(root, 'vendor')).sort(), ['alpha', 'beta']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release builds remap Rust paths and verification rejects a rehashed path leak', () => {
  const root = scratchProject();
  try {
    const fixture = dependency(root, 'alpha');
    fixture.build = {
      command: process.execPath,
      args: [
        '-e',
        "require('node:fs').writeFileSync('dist/build-environment.txt', process.env.CARGO_ENCODED_RUSTFLAGS ?? '')",
      ],
      rustPathRemapping: true,
    };
    fixture.artifacts[0].releaseForbiddenStrings = ['/home/'];
    configure(root, [fixture]);

    const separator = '\x1f';
    const environment = {
      HOME: join(root, 'private-home'),
      CARGO_HOME: join(root, 'private-cargo'),
      RUSTUP_HOME: join(root, 'private-rustup'),
      RUSTFLAGS: '',
      CARGO_ENCODED_RUSTFLAGS: ['-C', 'debuginfo=0'].join(separator),
    };

    const development = run(root, ['alpha'], environment);
    assert.equal(development.status, 0, development.stderr);
    assert.equal(
      readFileSync(join(root, fixture.source, 'dist', 'build-environment.txt'), 'utf8'),
      environment.CARGO_ENCODED_RUSTFLAGS
    );

    const release = run(root, ['--release', 'alpha'], environment);
    assert.equal(release.status, 0, release.stderr);
    const flags = readFileSync(join(root, fixture.source, 'dist', 'build-environment.txt'), 'utf8').split(separator);
    assert.deepEqual(flags.slice(0, 2), ['-C', 'debuginfo=0']);
    assert.ok(flags.includes(`--remap-path-prefix=${environment.HOME}=/usr/src/antimatter/home`));
    assert.ok(flags.includes(`--remap-path-prefix=${environment.CARGO_HOME}=/usr/src/antimatter/cargo`));
    assert.ok(flags.includes(`--remap-path-prefix=${environment.RUSTUP_HOME}=/usr/src/antimatter/rustup`));
    assert.ok(
      flags.includes(
        `--remap-path-prefix=${join(root, fixture.source)}=/usr/src/antimatter/deps/${fixture.name}`
      )
    );

    const manifestPath = join(root, 'vendor', 'alpha', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifest.releasePolicies, [
      'cargo-rust-path-remapping-v1',
      'artifact-forbidden-strings-v1',
    ]);
    assert.equal(run(root, ['--verify', 'alpha']).status, 0);

    // Even a matching attacker-supplied manifest hash cannot bless a release containing a
    // configured machine-local path pattern.
    const artifactPath = join(root, 'vendor', 'alpha', 'bin', 'alpha');
    const leaked = Buffer.from('/home/release-builder/private/path');
    writeFileSync(artifactPath, leaked);
    manifest.artifacts[0].bytes = leaked.length;
    manifest.artifacts[0].sha256 = createHash('sha256').update(leaked).digest('hex');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const rejected = run(root, ['--verify', 'alpha']);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /contains forbidden release string/);
    assert.match(rejected.stderr, /home/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release sync binds configured feature identity, source commit and project-owned model descriptor', () => {
  const root = scratchProject();
  try {
    const fixture = dependency(root, 'beholdd-hag');
    fixture.sourceCommit = git(join(root, fixture.source), ['rev-parse', 'HEAD']);
    fixture.build = { command: 'cargo', args: ['build', '--features', 'hag-native'], cargoFeatures: ['hag-native'] };
    mkdirSync(join(root, 'releases'));
    writeFileSync(join(root, 'releases/model.json'), '{"pinned":"model"}\n');
    fixture.artifacts.push({ from: 'releases/model.json', fromProject: true, to: 'model.json' });
    configure(root, [fixture]);
    const synced = run(root, ['--release', '--skip-build', 'beholdd-hag']);
    assert.equal(synced.status, 0, synced.stderr);
    const manifestPath = join(root, 'vendor/beholdd-hag/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifest.cargoFeatures, ['hag-native']);
    assert.equal(run(root, ['--verify', 'beholdd-hag']).status, 0);
    manifest.cargoFeatures = [];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.match(run(root, ['--verify', 'beholdd-hag']).stderr, /manifest Cargo features differ/);
    manifest.cargoFeatures = ['hag-native'];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(join(root, 'releases/model.json'), '{"pinned":"different"}\n');
    assert.match(run(root, ['--verify', 'beholdd-hag']).stderr, /project artifact differs/);
    fixture.sourceCommit = 'f'.repeat(40);
    configure(root, [fixture]);
    assert.match(run(root, ['--release', '--skip-build', 'beholdd-hag']).stderr, /source differs from the pinned source commit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release sync rejects feature declarations that do not match the configured command', () => {
  const root = scratchProject();
  try {
    const fixture = dependency(root, 'beholdd-hag');
    fixture.build = { command: 'cargo', args: ['build'], cargoFeatures: ['hag-native'] };
    configure(root, [fixture]);
    const result = run(root, ['--release', '--skip-build', 'beholdd-hag']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cargo features differ from its build command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
