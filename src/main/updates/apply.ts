import { spawn } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { FeedArtifact, FeedBuild } from './feed';
import { readReceipt } from './installation';
import { copyVerified, type CopyOptions } from './stage';

/**
 * Turning a staged release into the installed one.
 *
 * For an installed copy, the new release's own install.sh does the work, exactly as a person would
 * run it: it re-verifies the archive against SHA256SUMS, unpacks it into a new release folder,
 * rewrites the launcher and desktop entry, and moves the `current` link in one rename. Doing
 * anything cleverer here would be a second installer to keep in step with the first. The model is
 * skipped: an update should not start a 30 GiB download or re-hash one that is already there.
 */

export const archiveName = (version: string) => `Antimatter-${version}-linux-x86_64.tar.gz`;
export const appImageName = (version: string) => `Antimatter-${version}-linux-x86_64.AppImage`;

/** What install.sh expects beside itself (see the support-file checks at its top). */
export const installerAssets = (version: string): string[] => [
  'install.sh',
  'uninstall.sh',
  'beholdd.streaming.yaml',
  'co.antimatter.app.svg',
  'SHA256SUMS',
  archiveName(version),
];

export function requireArtifacts(build: FeedBuild, names: string[]): FeedArtifact[] {
  return names.map((name) => {
    const artifact = build.artifacts.get(name);
    if (!artifact) throw new Error(`Build ${build.version} on the share has no ${name}.`);
    return artifact;
  });
}

/** install.sh pins its version as `readonly VERSION='…'`; it has to be the version being installed. */
export function installerVersion(script: string): string | null {
  return /^readonly VERSION='([^'\n]+)'$/m.exec(script)?.[1] ?? null;
}

export interface InstallerRun {
  stageDir: string;
  version: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Variables that describe how this process was launched, not the environment a user's installer should see. */
const LAUNCH_VARIABLES = new Set(['VITE_DEV_SERVER_URL', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']);
export const cleanEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('ELECTRON_') && !LAUNCH_VARIABLES.has(key)));

export async function runInstaller(run: InstallerRun): Promise<void> {
  run.signal?.throwIfAborted();
  const script = join(run.stageDir, 'install.sh');
  const pinned = installerVersion(readFileSync(script, 'utf8'));
  if (pinned !== run.version) {
    throw new Error(`The staged install.sh installs ${pinned ?? 'an unknown version'}, not ${run.version}.`);
  }

  const log = openSync(run.logPath, 'w', 0o600);
  try {
    await new Promise<void>((resolveRun, reject) => {
      const child = spawn(
        'bash',
        [script, '--skip-model', '--package', join(run.stageDir, archiveName(run.version)), '--checksums', join(run.stageDir, 'SHA256SUMS')],
        { cwd: run.stageDir, env: cleanEnvironment(run.env), stdio: ['ignore', log, log], detached: true }
      );
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      };
      const timer = setTimeout(() => {
        kill();
        reject(new Error(`install.sh did not finish within ${Math.round((run.timeoutMs ?? 900_000) / 60_000)} minutes.`));
      }, run.timeoutMs ?? 900_000);
      const onAbort = () => {
        clearTimeout(timer);
        kill();
        reject(new Error('The update was cancelled.'));
      };
      run.signal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        run.signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolveRun();
        else reject(new Error(`install.sh ${signal ? `was stopped by ${signal}` : `exited with ${code}`}.`));
      });
    });
  } catch (error) {
    const tail = (() => {
      try {
        return readFileSync(run.logPath, 'utf8').trim().split('\n').slice(-6).join('\n');
      } catch {
        return '';
      }
    })();
    throw new Error(`${(error as Error).message}${tail ? `\n${tail}` : ''}`);
  } finally {
    closeSync(log);
  }
}

/** Confirms install.sh did what it says: the receipt names the new version and `current` points at it. */
export function verifyInstalled(receiptPath: string, uid: number, version: string): void {
  const receipt = readReceipt(receiptPath, uid);
  if (!receipt) throw new Error('install.sh finished, but its receipt could not be read back.');
  if (receipt.currentVersion !== version) {
    throw new Error(`install.sh finished, but the receipt still says ${receipt.currentVersion}.`);
  }
  const release = receipt.releases.find((entry) => entry.version === version);
  if (!release) throw new Error(`install.sh finished, but the receipt lists no ${version} release.`);
  // <data>/antimatter/releases/<version> → <data>/antimatter/current
  const current = join(dirname(dirname(release.path)), 'current');
  let pointsAtRelease = false;
  try {
    pointsAtRelease = lstatSync(current).isSymbolicLink() && realpathSync(current) === realpathSync(release.path);
  } catch {
    pointsAtRelease = false;
  }
  if (!pointsAtRelease) {
    throw new Error(`install.sh finished, but ${current} does not point at ${version} (${readLinkQuietly(current)}).`);
  }
}

const readLinkQuietly = (path: string) => {
  try {
    return readlinkSync(path);
  } catch {
    return 'missing';
  }
};

/** Swaps the AppImage for the new one. The running copy keeps its mounted image until it exits. */
export async function replaceAppImage(artifact: FeedArtifact, target: string, options: CopyOptions = {}): Promise<void> {
  // Staged beside the target so the final rename stays on one filesystem and is atomic. An
  // interrupted copy leaves `<staged>.part` for the next attempt to resume.
  const staged = `${resolve(target)}.update`;
  await copyVerified({ ...artifact, executable: true }, staged, options);
  try {
    options.signal?.throwIfAborted();
    await rename(staged, target);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}
