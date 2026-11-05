import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function scratchProject(t: { after(fn: () => unknown): void }, script: string): string {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-release-scripts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'project', 'scripts'), { recursive: true });
  copyFileSync(join(process.cwd(), 'scripts', script), join(root, 'project', 'scripts', script));
  copyFileSync(join(process.cwd(), 'scripts', 'bump-version.sh'), join(root, 'project', 'scripts', 'bump-version.sh'));
  mkdirSync(join(root, 'project', 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(process.cwd(), 'scripts', 'lib', 'release-version.mjs'), join(root, 'project', 'scripts', 'lib', 'release-version.mjs'));
  copyFileSync(join(process.cwd(), 'scripts', 'lib', 'android-release.mjs'), join(root, 'project', 'scripts', 'lib', 'android-release.mjs'));
  copyFileSync(join(process.cwd(), 'scripts', 'lib', 'release-dependencies.mjs'), join(root, 'project', 'scripts', 'lib', 'release-dependencies.mjs'));
  return root;
}

function write(file: string, content: string | Buffer, mode?: number): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content, mode === undefined ? undefined : { mode });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(project: string, script: string, args: string[]) {
  // From elsewhere: both scripts work on their own checkout, not on whichever directory invoked them.
  return spawnSync(process.execPath, [join(project, 'scripts', script), ...args], { cwd: tmpdir(), encoding: 'utf8' });
}

test('dirty release rehearsal refuses before installing dependencies or building native modules', (t) => {
  const project = join(scratchProject(t, 'release-linux.mjs'), 'project');
  git(project, ['init', '--quiet']);
  git(project, ['config', 'user.email', 'release-test@example.invalid']);
  git(project, ['config', 'user.name', 'Release Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '--quiet', '-m', 'release']);
  write(join(project, 'uncommitted.txt'), 'not a reviewed release');
  const result = spawnSync(process.execPath, [join(project, 'scripts/release-linux.mjs')], {
    encoding: 'utf8', env: { ...process.env, ANTIMATTER_ALLOW_DIRTY_RELEASE: '1' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /clean worktree and isolated native compatibility build/);
  assert.equal(existsSync(join(project, 'node_modules')), false);
});

test('release:version moves every pin to the next alpha and nothing else', (t) => {
  const project = join(scratchProject(t, 'set-release-version.mjs'), 'project');
  const lock = (version: string, dependency: string) =>
    `{\n  "name": "antimatter",\n  "version": "${version}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "antimatter",\n      "version": "${version}"\n    },\n    "node_modules/tiny": {\n      "version": "${dependency}"\n    }\n  }\n}\n`;
  write(join(project, 'package.json'), '{\n  "name": "antimatter",\n  "version": "0.1.0-alpha.9",\n  "dependencies": { "tiny": "0.1.0-alpha.9" }\n}\n');
  write(join(project, 'package-lock.json'), lock('0.1.0-alpha.9', '0.1.0-alpha.9'));
  write(join(project, 'releases', 'linux-x86_64', 'install.sh'), "#!/usr/bin/env bash\nreadonly VERSION='0.1.0-alpha.9'\n", 0o755);
  write(join(project, 'README.md'), 'gh release download v0.1.0-alpha.9\n');
  write(join(project, 'releases', 'README.md'), 'Antimatter `0.1.0-alpha.9`: Antimatter-0.1.0-alpha.9-linux-x86_64.tar.gz, not 0.1.0-alpha.95\n');
  write(join(project, 'releases', 'RELEASE_NOTES.md'), '# Antimatter 0.1.0-alpha.9\n\nFixes what 0.1.0-alpha.9 broke.\n');
  write(
    join(project, 'android', 'app', 'build.gradle.kts'),
    'android {\n    defaultConfig {\n        versionCode = 10009\n        versionName = "0.1.0-alpha.9"\n    }\n}\n'
  );
  write(join(project, 'android', 'README.md'), 'Android `0.1.0-alpha.9`, not 0.1.0-alpha.95\n');

  const bumped = run(project, 'set-release-version.mjs', ['--no-verify']);
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.match(bumped.stdout, /0\.1\.0-alpha\.9 → 0\.1\.0-alpha\.10/);
  const read = (relative: string) => readFileSync(join(project, relative), 'utf8');
  assert.equal(
    read('package.json'),
    '{\n  "name": "antimatter",\n  "version": "0.1.0-alpha.10",\n  "dependencies": { "tiny": "0.1.0-alpha.9" }\n}\n',
    'a dependency that happens to share the version is not the package version'
  );
  assert.equal(read('package-lock.json'), lock('0.1.0-alpha.10', '0.1.0-alpha.9'));
  assert.equal(read('releases/linux-x86_64/install.sh'), "#!/usr/bin/env bash\nreadonly VERSION='0.1.0-alpha.10'\n");
  assert.equal(statSync(join(project, 'releases', 'linux-x86_64', 'install.sh')).mode & 0o777, 0o755, 'the installer stays executable');
  assert.equal(read('README.md'), 'gh release download v0.1.0-alpha.10\n');
  assert.equal(read('releases/README.md'), 'Antimatter `0.1.0-alpha.10`: Antimatter-0.1.0-alpha.10-linux-x86_64.tar.gz, not 0.1.0-alpha.95\n');
  assert.equal(read('releases/RELEASE_NOTES.md'), '# Antimatter 0.1.0-alpha.10\n\nFixes what 0.1.0-alpha.9 broke.\n', 'only the heading; the notes are prose');
  assert.equal(
    read('android/app/build.gradle.kts'),
    'android {\n    defaultConfig {\n        versionCode = 10010\n        versionName = "0.1.0-alpha.10"\n    }\n}\n'
  );
  assert.equal(read('android/README.md'), 'Android `0.1.0-alpha.10`, not 0.1.0-alpha.95\n');

  const older = run(project, 'set-release-version.mjs', ['0.1.0-alpha.3', '--no-verify']);
  assert.equal(older.status, 1);
  assert.match(older.stderr, /^release:version: 0\.1\.0-alpha\.3 is not newer than the current 0\.1\.0-alpha\.10\n$/);
  assert.equal(run(project, 'set-release-version.mjs', ['1.0.0-beta.1', '--no-verify']).status, 1);

  // Android is part of the same fail-closed version contract.
  write(join(project, 'android', 'README.md'), 'Android `0.1.0-alpha.4`\n');
  const androidDrifted = run(project, 'set-release-version.mjs', ['0.2.0-alpha.1', '--no-verify']);
  assert.equal(androidDrifted.status, 1);
  assert.match(androidDrifted.stderr, /android\/README\.md: expected some occurrence\(s\) of 0\.1\.0-alpha\.10 to update, found 0; nothing was changed/);
  assert.match(read('package.json'), /"version": "0\.1\.0-alpha\.10"/);
  write(join(project, 'android', 'README.md'), 'Android `0.1.0-alpha.10`, not 0.1.0-alpha.95\n');

  // A pin that has drifted refuses the whole bump before anything is written.
  write(join(project, 'releases', 'linux-x86_64', 'install.sh'), "#!/usr/bin/env bash\nreadonly VERSION='0.1.0-alpha.4'\n", 0o755);
  const drifted = run(project, 'set-release-version.mjs', ['0.2.0-alpha.1', '--no-verify']);
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /install\.sh: expected 1 occurrence\(s\) of 0\.1\.0-alpha\.10 to update, found 0; nothing was changed/);
  assert.match(read('package.json'), /"version": "0\.1\.0-alpha\.10"/);
  assert.deepEqual(readdirSync(project).sort(), ['README.md', 'android', 'package-lock.json', 'package.json', 'releases', 'scripts']);

  // Stable promotion is explicit; later default bumps increment patch, never return to alpha.
  write(join(project, 'releases', 'linux-x86_64', 'install.sh'), "#!/usr/bin/env bash\nreadonly VERSION='0.1.0-alpha.10'\n", 0o755);
  const stable = run(project, 'set-release-version.mjs', ['1.0.0', '--no-verify']);
  assert.equal(stable.status, 0, stable.stderr);
  assert.equal(JSON.parse(read('package.json')).version, '1.0.0');
  assert.match(read('android/app/build.gradle.kts'), /versionCode = 10011/);
  assert.equal(run(project, 'set-release-version.mjs', ['1.0.0-alpha.1', '--no-verify']).status, 1);
  assert.equal(run(project, 'set-release-version.mjs', ['01.0.1', '--no-verify']).status, 1);
  assert.equal(run(project, 'set-release-version.mjs', ['--no-verify']).status, 0);
  assert.equal(JSON.parse(read('package.json')).version, '1.0.1');
});

function rollingFixture(t: { after(fn: () => unknown): void }): string {
  const project = join(scratchProject(t, 'set-release-version.mjs'), 'project');
  write(join(project, 'VERSION'), 'v2\n');
  write(join(project, 'package.json'), '{\n  "name": "antimatter",\n  "version": "2.0.0",\n  "releaseVersion": "v2",\n  "dependencies": { "tiny": "2.0.0" }\n}\n');
  write(join(project, 'package-lock.json'), '{\n  "name": "antimatter",\n  "version": "2.0.0",\n  "packages": {\n    "": {\n      "name": "antimatter",\n      "version": "2.0.0"\n    }\n  }\n}\n');
  write(join(project, 'releases/linux-x86_64/install.sh'), "readonly VERSION='2.0.0'\n", 0o755);
  const anchor = 'Current release: **v2** (compatibility package 2.0.0).\n';
  write(join(project, 'README.md'), anchor + 'gh release download v2.0.0\nPlugin example: { "version": "2.0.0" }\nBeholdd v2; history began at v2.\n');
  write(join(project, 'releases/README.md'), anchor + 'Antimatter-2.0.0-linux-x86_64.tar.gz\nbeholdd-2.0.0-linux-x86_64.tar.gz\n~/.local/share/antimatter/releases/2.0.0\n');
  write(join(project, 'releases/RELEASE_NOTES.md'), '# Antimatter v2\n\nHistorical v2 and package 2.0.0.\n');
  write(join(project, 'android/app/build.gradle.kts'), 'versionCode = 10004\nversionName = "2.0.0"\n');
  write(join(project, 'android/README.md'), anchor + 'The current Android package version is `2.0.0`, synchronized.\n');
  return project;
}

test('rolling release:version bumps once and synchronizes only current pins, not examples or history', (t) => {
  const project = rollingFixture(t);
  const result = run(project, 'set-release-version.mjs', ['--no-verify']);
  assert.equal(result.status, 0, result.stderr);
  const read = (relative: string) => readFileSync(join(project, relative), 'utf8');
  assert.equal(read('VERSION'), 'v3\n');
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual([pkg.version, pkg.releaseVersion, pkg.dependencies.tiny], ['3.0.0', 'v3', '2.0.0']);
  const lock = JSON.parse(read('package-lock.json'));
  assert.deepEqual([lock.version, lock.packages[''].version], ['3.0.0', '3.0.0']);
  assert.equal(read('releases/linux-x86_64/install.sh'), "readonly VERSION='3.0.0'\n");
  assert.match(read('README.md'), /Current release: \*\*v3\*\* \(compatibility package 3\.0\.0\)/);
  assert.match(read('README.md'), /gh release download v3\.0\.0/);
  assert.match(read('README.md'), /Plugin example: \{ "version": "2\.0\.0" \}/);
  assert.match(read('README.md'), /Beholdd v2; history began at v2/);
  assert.doesNotMatch(read('releases/README.md'), /2\.0\.0/);
  assert.equal(read('releases/RELEASE_NOTES.md'), '# Antimatter v3\n\nHistorical v2 and package 2.0.0.\n');
  assert.equal(read('android/app/build.gradle.kts'), 'versionCode = 10005\nversionName = "3.0.0"\n');
  assert.match(read('android/README.md'), /current Android package version is `3\.0\.0`/);
  assert.match(result.stdout, /git tag v3 && git tag v3\.0\.0/);
  assert.equal(run(project, 'set-release-version.mjs', ['v4', '--no-verify']).status, 0, 'explicit next counter is allowed');
  assert.equal(read('VERSION'), 'v4\n');
});

test('rolling release:version help is read-only, and skipped counters or malformed pins never increment VERSION', (t) => {
  const project = rollingFixture(t);
  const packageBefore = readFileSync(join(project, 'package.json'), 'utf8');
  for (const args of [['--help'], ['-h']]) {
    const result = run(project, 'set-release-version.mjs', args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: npm run release:version/);
    assert.equal(readFileSync(join(project, 'VERSION'), 'utf8'), 'v2\n');
  }
  for (const target of ['v2', 'v4', '2.0.1', '3.0.0']) {
    const result = run(project, 'set-release-version.mjs', [target, '--no-verify']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /increment exactly once to v3/);
    assert.equal(readFileSync(join(project, 'VERSION'), 'utf8'), 'v2\n');
  }
  const mutations = [
    ['README.md', 'No current release anchor.\n'],
    ['README.md', 'Current release: **v2** (compatibility package 2.0.0).\n'.repeat(2)],
    ['android/app/build.gradle.kts', 'versionCode = 2100000000\nversionName = "2.0.0"\n'],
    ['package.json', packageBefore.replace('"releaseVersion": "v2"', '"releaseVersion": "v9"')],
    ['VERSION', 'v02\n'],
  ];
  for (const [relative, malformed] of mutations) {
    const file = join(project, relative);
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, malformed);
    const result = run(project, 'set-release-version.mjs', ['--no-verify']);
    assert.equal(result.status, 1, `${relative}: ${result.stdout}`);
    assert.equal(readFileSync(join(project, 'VERSION'), 'utf8'), relative === 'VERSION' ? malformed : 'v2\n');
    assert.equal(readFileSync(join(project, 'package.json'), 'utf8'), relative === 'package.json' ? malformed : packageBefore);
    writeFileSync(file, before);
  }
});

test('standalone mechanical counter accepts only a safe regular vN file', (t) => {
  const project = rollingFixture(t);
  const script = join(project, 'scripts/bump-version.sh');
  const file = join(project, 'counter');
  const bump = (target = file) => spawnSync('bash', [script, target], { encoding: 'utf8' });
  writeFileSync(file, 'v9\n');
  assert.equal(bump().status, 0);
  assert.equal(readFileSync(file, 'utf8'), 'v10\n');
  for (const content of ['v0\n', 'v01\n', 'v2 junk\n', 'v2\nv3\n', 'v9007199254740991\n']) {
    writeFileSync(file, content);
    assert.equal(bump().status, 1);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
  writeFileSync(file, 'v9007199254740990\n');
  assert.equal(bump().status, 0);
  assert.equal(readFileSync(file, 'utf8'), 'v9007199254740991\n');
  symlinkSync(file, join(project, 'linked-counter'));
  assert.equal(bump(join(project, 'linked-counter')).status, 1);
  assert.equal(readFileSync(join(project, 'VERSION'), 'utf8'), 'v2\n', 'explicit fixture counter never touches the project counter');
});

interface Release {
  root: string;
  project: string;
  dist: string;
  incoming: string;
  managed: string;
  commit: string;
  anchors: { manifest: string; checksums: string };
}

function release(t: { after(fn: () => unknown): void }, version = '0.1.0-alpha.2', releaseVersion?: string): Release {
  const root = scratchProject(t, 'stage-lich-release.mjs');
  const project = join(root, 'project');
  write(join(project, 'README.md'), 'Antimatter\n');
  if (releaseVersion) {
    write(join(project, 'VERSION'), `${releaseVersion}\n`);
    write(join(project, 'package.json'), JSON.stringify({ version, releaseVersion }));
  }
  git(project, ['init', '--quiet']);
  git(project, ['config', 'user.email', 'release-test@example.invalid']);
  git(project, ['config', 'user.name', 'Release Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '--quiet', '-m', 'release']);
  git(project, ['tag', `v${version}`]);
  if (releaseVersion) git(project, ['tag', releaseVersion]);
  const commit = git(project, ['rev-parse', 'HEAD']);

  const dist = join(root, 'dist');
  const files: Record<string, string | Buffer> = {
    [`Antimatter-${version}-linux-x86_64.AppImage`]: Buffer.from('appimage'),
    [`Antimatter-${version}-linux-x86_64.tar.gz`]: Buffer.from('archive'),
    'README.md': '# Install\n',
    'install.sh': '#!/usr/bin/env bash\n',
    'uninstall.sh': '#!/usr/bin/env bash\n',
    'model-manifest.json': '{}\n',
  };
  const publishedAssets = [...Object.keys(files), 'release-manifest.json', 'SHA256SUMS'].sort();
  files['release-manifest.json'] = `${JSON.stringify({
    schemaVersion: 1,
    name: 'Antimatter',
    version,
    ...(releaseVersion ? { releaseVersion } : {}),
    tag: `v${version}`,
    channel: version.includes('-alpha.') ? 'alpha' : 'stable',
    commit,
    platform: { os: 'linux', architecture: 'x86_64' },
    publishedAssets,
  })}\n`;
  for (const [name, content] of Object.entries(files)) write(join(dist, name), content);
  const sums = Object.entries(files)
    .map(([name, content]) => `${sha(content)}  ${name}`)
    .sort((left, right) => (left.slice(66) < right.slice(66) ? -1 : 1))
    .join('\n');
  write(join(dist, 'SHA256SUMS'), `${sums}\n`);

  return {
    root,
    project,
    dist,
    incoming: join(root, 'share', 'antimatter', '.incoming'),
    managed: join(root, 'share', 'managed', 'antimatter'),
    commit,
    anchors: { manifest: sha(files['release-manifest.json']), checksums: sha(`${sums}\n`) },
  };
}

const stage = (box: Release, extra: string[] = []) =>
  run(box.project, 'stage-lich-release.mjs', ['--dist', box.dist, '--incoming', box.incoming, '--managed', box.managed, ...extra]);

test('release:lich refuses an unsigned combined release before touching the build share', (t) => {
  const box = release(t, '11.0.0', 'v11');
  const result = stage(box);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Android production signature is pending/);
  assert.equal(existsSync(box.incoming), false);
});

test('release:lich stages a stable v1 with the same exact-asset and integrity checks', (t) => {
  const box = release(t, '1.0.0');
  const result = stage(box);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('--version 1.0.0'));
  assert.ok(result.stdout.includes('--git-ref v1.0.0'));
  assert.deepEqual(readdirSync(join(box.incoming, `1.0.0-${box.commit.slice(0, 8)}`)).sort(), readdirSync(box.dist).sort());
});

test('release:lich keeps the SemVer buildd transport for public v2 and requires its public tag', (t) => {
  const box = release(t, '2.0.0', 'v2');
  git(box.project, ['tag', '-d', 'v2']);
  const refused = stage(box);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /tag v2 does not exist/);
  assert.equal(existsSync(box.incoming), false);
  git(box.project, ['tag', 'v2']);
  const result = stage(box);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--version 2\.0\.0/);
  assert.match(result.stdout, /--git-ref v2\.0\.0/);
  assert.deepEqual(readdirSync(join(box.incoming, `2.0.0-${box.commit.slice(0, 8)}`)).sort(), readdirSync(box.dist).sort());
});

test('release:lich rejects a public version that does not map to its transport version', (t) => {
  const box = release(t, '2.0.0', 'v3');
  const result = stage(box);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected matching stable\/alpha/);
  assert.equal(existsSync(box.incoming), false);
});

test('release:lich refuses a stable version mislabeled as alpha before staging', (t) => {
  const box = release(t, '1.0.0');
  const file = join(box.dist, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.channel = 'alpha';
  writeFileSync(file, JSON.stringify(manifest));
  const result = stage(box);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected matching stable\/alpha/);
  assert.equal(existsSync(box.incoming), false);
});

test('release:lich stages a verified copy in .incoming and prints the import with its trust anchors', (t) => {
  const box = release(t);
  const folder = `0.1.0-alpha.2-${box.commit.slice(0, 8)}`;

  const dry = stage(box, ['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(existsSync(box.incoming), false, 'a dry run copies nothing');

  const staged = stage(box);
  assert.equal(staged.status, 0, staged.stderr);
  const target = join(box.incoming, folder);
  assert.deepEqual(readdirSync(box.incoming), [folder], 'no partial copy is left beside it');
  for (const name of readdirSync(box.dist)) assert.deepEqual(readFileSync(join(target, name)), readFileSync(join(box.dist, name)));

  const printed = staged.stdout;
  assert.ok(printed.includes(`release-manifest.json  ${box.anchors.manifest}`));
  assert.ok(printed.includes(`SHA256SUMS             ${box.anchors.checksums}`));
  assert.ok(printed.includes(`  cd /mnt/builds/antimatter/.incoming/${folder}\n`));
  assert.ok(printed.includes('  chmod 0755 Antimatter-0.1.0-alpha.2-linux-x86_64.AppImage install.sh uninstall.sh\n'));
  const command = printed.slice(
    printed.indexOf('buildd --config'),
    printed.indexOf('\n\nThe published project')
  );
  assert.equal(
    command.replace(/\\\n\s+/g, '').trim(),
    [
      'buildd --config "$BUILDD_CONFIG" import',
      '--project antimatter',
      '--version 0.1.0-alpha.2',
      '--git-ref v0.1.0-alpha.2',
      `--commit ${box.commit}`,
      `--manifest-sha256 ${box.anchors.manifest}`,
      `--checksums-sha256 ${box.anchors.checksums}`,
      `--source /mnt/builds/antimatter/.incoming/${folder}`,
    ].join(' ')
  );
  assert.doesNotMatch(printed, /\/usr\/local\/bin\/buildd|\/etc\/buildd\.yaml|sudo systemctl/);
  assert.match(printed, /read-only releases share at releases\/antimatter/);

  // Staging again reuses an identical copy, refuses a different one, and names the release server's own path when asked.
  const again = stage(box, ['--server-incoming', '/srv/builds/antimatter/.incoming']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Already staged, identical/);
  assert.ok(again.stdout.includes(`--source /srv/builds/antimatter/.incoming/${folder}`));
  writeFileSync(join(target, 'install.sh'), '#!/usr/bin/env bash\necho changed\n');
  const tampered = stage(box);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /already holds a different release/);
});

test('release:lich refuses releases buildd would refuse, or that are not what HEAD built', (t) => {
  const box = release(t);
  const refuses = (pattern: RegExp, extra: string[] = []) => {
    const result = stage(box, extra);
    assert.equal(result.status, 1, `expected a refusal matching ${pattern}; got ${result.stdout}`);
    assert.match(result.stderr, pattern);
    assert.equal(existsSync(box.incoming), false);
  };

  // What buildd has already published.
  const index = (builds: object[]) =>
    write(join(box.managed, 'index.json'), JSON.stringify({ schema: 'execute.buildd/index-v2', project: 'antimatter', builds }));
  index([{ version: '0.1.0-alpha.2', commit: 'f'.repeat(40), relative_path: 'builds/x' }]);
  refuses(/0\.1\.0-alpha\.2 is already published from f{40}; run npm run release:version/);
  index([{ version: '0.1.0-alpha.1', commit: box.commit, relative_path: 'builds/x' }]);
  refuses(/is already published as 0\.1\.0-alpha\.1; buildd publishes one version per commit/);
  index([{ version: '0.1.0-alpha.2', commit: box.commit, relative_path: 'builds/published' }]);
  const published = stage(box);
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.stdout, /already published at .*builds\/published; nothing to stage/);
  assert.equal(existsSync(box.incoming), false);
  rmSync(box.managed, { recursive: true });

  // The assembled files.
  const archive = join(box.dist, 'Antimatter-0.1.0-alpha.2-linux-x86_64.tar.gz');
  writeFileSync(archive, 'archive, modified');
  refuses(/Antimatter-0\.1\.0-alpha\.2-linux-x86_64\.tar\.gz does not match SHA256SUMS/);
  writeFileSync(archive, 'archive');
  writeFileSync(join(box.dist, 'notes.txt'), 'stray');
  refuses(/does not hold exactly the published assets/);
  rmSync(join(box.dist, 'notes.txt'));

  // The checkout.
  writeFileSync(join(box.project, 'README.md'), 'Antimatter, edited\n');
  refuses(/refusing to stage from a dirty worktree/);
  git(box.project, ['commit', '--quiet', '-am', 'after the release']);
  refuses(/the release was built from [0-9a-f]{40}, but HEAD is [0-9a-f]{40}/);
  git(box.project, ['reset', '--quiet', '--hard', box.commit]);
  git(box.project, ['tag', '-d', 'v0.1.0-alpha.2']);
  refuses(/tag v0\.1\.0-alpha\.2 does not exist/);
  git(box.project, ['tag', 'v0.1.0-alpha.2']);

  refuses(/unknown option --publish/, ['--publish']);
  assert.equal(stage(box, ['--dry-run']).status, 0, 'and with everything put back, it would stage');
});
