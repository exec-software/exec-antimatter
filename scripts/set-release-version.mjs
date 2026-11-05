#!/usr/bin/env node

/**
 * Move every pinned copy of the release version in one reviewable change.
 *
 *   npm run release:version                 public v2 → v3, package 2.0.0 → 3.0.0
 *   npm run release:version -- v3            optional assertion of the next rolling version
 *
 * Legacy checkouts without VERSION retain the original SemVer/alpha synchronization behavior.
 *
 * The version is written down in several places on purpose — the installer must not trust the
 * archive it installs to say what it is — and verify-release-inputs.mjs fails a release whose
 * copies disagree. buildd refuses to publish a version twice, so every build that should reach
 * testers through the updater needs its own. This changes the mechanical pins; what the release
 * actually contains still has to be written into releases/RELEASE_NOTES.md by a person.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReleaseVersions, nextReleaseVersion, parseReleaseVersion, parseRollingVersion, rollingPackageVersion } from './lib/release-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fail = (message) => {
  console.error(`release:version: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: npm run release:version [-- v<N+1>] [--no-verify]
Mechanically increment the authoritative VERSION once, then synchronize package,
installer, Android and current-release guide pins to compatibility version N.0.0.
An optional v<N+1> is an assertion, not a request to skip versions.
Legacy checkouts without VERSION retain SemVer/numbered-alpha synchronization.
--no-verify skips the final release-input verification; all edit preflight checks remain.`);
  process.exit(0);
}
const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--no-verify');
if (unknown.length) fail(`unknown option ${unknown[0]}; usage: npm run release:version [-- VERSION] [--no-verify]`);
const verify = !args.includes('--no-verify');
const requested = args.find((arg) => !arg.startsWith('--'));
if (args.filter((arg) => !arg.startsWith('--')).length > 1) fail('only one release version may be supplied');

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const packageMetadata = JSON.parse(read('package.json'));
const current = packageMetadata.version;
if (!parseReleaseVersion(current)) fail(`package.json version ${current} is not a supported release version`);
const rolling = fs.existsSync(path.join(ROOT, 'VERSION'));
const publicCurrent = rolling ? read('VERSION').trim() : undefined;
const currentNumber = rolling ? parseRollingVersion(publicCurrent) : null;
if (rolling && (currentNumber === null || currentNumber >= Number.MAX_SAFE_INTEGER ||
    rollingPackageVersion(publicCurrent) !== current || packageMetadata.releaseVersion !== publicCurrent)) {
  fail('VERSION, package releaseVersion and compatibility version must agree before a mechanical bump');
}
const publicNext = rolling ? `v${currentNumber + 1}` : undefined;
if (rolling && requested !== undefined && requested !== publicNext) fail(`rolling releases must increment exactly once to ${publicNext}; arbitrary version jumps are not supported`);
const next = rolling ? rollingPackageVersion(publicNext) : requested ?? nextReleaseVersion(current);
if (!parseReleaseVersion(next)) fail(`${next} is not a stable or numbered-alpha version like 1.0.0 or 0.1.0-alpha.2`);
if (compareReleaseVersions(next, current) <= 0) fail(`${next} is not newer than the current ${current}`);

/** Each edit must change exactly what it says, or the whole bump is refused before anything is written. */
const edits = [];
const edit = (relative, transform, expected) => {
  const before = read(relative);
  const { text, count } = transform(before);
  if (count !== expected && !(expected === 'some' && count > 0)) {
    fail(`${relative}: expected ${expected} occurrence(s) of ${current} to update, found ${count}; nothing was changed`);
  }
  edits.push({ relative, text });
};

const replaceAll = (pattern, replacement) => (source) => {
  let count = 0;
  const text = source.replace(pattern, (...match) => {
    count += 1;
    return replacement(...match);
  });
  return { text, count };
};

/** The version as a whole word: 0.1.0-alpha.1 is not the start of 0.1.0-alpha.12. */
const mention = `(?<![\\d.])${escape(current)}(?!\\d)`;

edit('package.json', (source) => {
  const updated = replaceAll(new RegExp(`^(  "version": )"${escape(current)}"`, 'm'), (_, key) => `${key}"${next}"`)(source);
  if (!rolling) return updated;
  const publicUpdated = replaceAll(new RegExp(`^(  "releaseVersion": )"${escape(publicCurrent)}"`, 'm'), (_, key) => `${key}"${publicNext}"`)(updated.text);
  return { text: publicUpdated.text, count: updated.count + publicUpdated.count };
}, rolling ? 2 : 1);
// The lockfile repeats the root package's version at the top and under packages[""].
edit(
  'package-lock.json',
  replaceAll(new RegExp(`("name": "antimatter",\\n\\s+"version": )"${escape(current)}"`, 'g'), (_, key) => `${key}"${next}"`),
  2
);
edit('releases/linux-x86_64/install.sh', replaceAll(new RegExp(`^readonly VERSION='${escape(current)}'$`, 'm'), () => `readonly VERSION='${next}'`), 1);
const guide = (source) => {
  if (!rolling) return replaceAll(new RegExp(mention, 'g'), () => next)(source);
  // The explicit current-release anchor avoids rewriting dependency versions or historical prose.
  const anchor = new RegExp(`^Current release: \\*\\*${escape(publicCurrent)}\\*\\* \\(compatibility package ${escape(current)}\\)\\.$`, 'gm');
  const updated = replaceAll(anchor, () => `Current release: **${publicNext}** (compatibility package ${next}).`)(source);
  if (updated.count !== 1) return updated;
  const text = updated.text
    .replace(new RegExp(`(gh release download[ \\t]+)v${escape(current)}(?![\\d.])`, 'g'), (_, prefix) => `${prefix}v${next}`)
    .replace(new RegExp(`((?:Antimatter|beholdd)-)${escape(current)}(?=-linux-x86_64)`, 'g'), (_, prefix) => `${prefix}${next}`)
    .replace(new RegExp(`(/antimatter/releases/)${escape(current)}(?![\\d.])`, 'g'), (_, prefix) => `${prefix}${next}`)
    .replace(new RegExp(`^(## Linux[ \\t]+)${escape(publicCurrent)}$`, 'm'), (_, prefix) => `${prefix}${publicNext}`)
    .replace(new RegExp('(current Android package version is `)' + escape(current) + '`', 'g'), (_, prefix) => `${prefix}${next}\``);
  return { text, count: 1 };
};
edit('README.md', guide, rolling ? 1 : 'some');
edit('releases/README.md', guide, rolling ? 1 : 'some');
edit('releases/RELEASE_NOTES.md', replaceAll(new RegExp(`^# Antimatter ${escape(rolling ? publicCurrent : current)}$`, 'm'), () => `# Antimatter ${rolling ? publicNext : next}`), 1);
edit(
  'android/app/build.gradle.kts',
  (source) => {
    let count = 0;
    let text = source.replace(/^(\s*versionCode = )(\d+)$/m, (_, key, code) => {
      count += 1;
      const number = Number(code);
      if (!Number.isSafeInteger(number) || number < 1 || number >= 2_100_000_000) fail('Android versionCode cannot be incremented safely; nothing was changed');
      return `${key}${number + 1}`;
    });
    text = text.replace(new RegExp(`^(\\s*versionName = )"${escape(current)}"$`, 'm'), (_, key) => {
      count += 1;
      return `${key}"${next}"`;
    });
    return { text, count };
  },
  2
);
edit('android/README.md', guide, rolling ? 1 : 'some');

for (const { relative, text } of edits) {
  if (!relative.endsWith('.json')) continue;
  try {
    JSON.parse(text);
  } catch (error) {
    fail(`${relative} would not be valid JSON afterwards (${error.message}); nothing was changed`);
  }
}
if (rolling) {
  // This is the only operation that increments VERSION. All pin, JSON and guide drift checks
  // complete first, so a rejected preflight leaves the rolling counter unchanged too.
  execFileSync('bash', [path.join(ROOT, 'scripts', 'bump-version.sh')], { cwd: ROOT, stdio: 'inherit' });
  if (read('VERSION').trim() !== publicNext) fail('mechanical version helper returned an unexpected version');
}
for (const { relative, text } of edits) {
  const file = path.join(ROOT, relative);
  const temporary = `${file}.release-version-${process.pid}`;
  fs.writeFileSync(temporary, text, { mode: fs.statSync(file).mode & 0o777 });
  fs.renameSync(temporary, file);
}

console.log(`Antimatter ${rolling ? `${publicCurrent} → ${publicNext} (compatibility ${current} → ${next})` : `${current} → ${next}`}`);
for (const { relative } of edits) console.log(`  updated ${relative}`);

if (verify) execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-release-inputs.mjs')], { cwd: ROOT, stdio: 'inherit' });

console.log(`
Next:
  1. Write what changed into releases/RELEASE_NOTES.md (its heading already says ${rolling ? publicNext : next}).
  2. Commit, then tag the commit: ${rolling ? `git tag ${publicNext} && git tag v${next}` : `git tag v${next}`}
  3. npm run release:linux
  4. npm run release:publish, or release:stage for a configured buildd feed.`);
