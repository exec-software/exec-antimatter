import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * How this copy of Antimatter got onto the machine, which decides whether it can update itself.
 *
 * - `installer`: installed by releases/linux-x86_64/install.sh. The receipt it writes names every
 *   installed release and the launcher, and the running executable sits inside one of those
 *   release folders. An update runs the new release's own installer, which adds a release folder
 *   beside this one and moves the `current` link; the running copy is never touched.
 * - `appimage`: the AppImage runtime sets APPIMAGE to the file it mounted, and this executable runs
 *   from inside that mount. An update replaces the file in one rename.
 * - `development`: running from a checkout. Checking works; installing is for installed builds.
 * - `unmanaged`: packaged, but neither of the above — an archive unpacked by hand, say. Nothing
 *   here knows how it should be replaced, so it is not.
 */

export type InstallKind = 'installer' | 'appimage' | 'development' | 'unmanaged';

export interface Installation {
  kind: InstallKind;
  /** The version this process is running. */
  version: string;
  canApply: boolean;
  /** Why updates cannot be applied here, when they cannot. */
  reason: string | null;
  receiptPath: string | null;
  /** The installer's launcher: what a restart should run, so it picks up the `current` link. */
  launcher: string | null;
  /** The receipt's current version, which can be ahead of `version` once an update has installed. */
  installedVersion: string | null;
  appImage: string | null;
}

export interface DetectInput {
  isPackaged: boolean;
  execPath: string;
  version: string;
  env: NodeJS.ProcessEnv;
  uid: number;
  home: string;
}

export const APP_ID = 'co.antimatter.app';

export const receiptPathFor = (env: NodeJS.ProcessEnv, home: string): string => {
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local', 'state');
  return join(state, 'antimatter', 'install.json');
};

interface Receipt {
  currentVersion: string;
  launcher: string;
  releases: { version: string; path: string }[];
}

/** The fields the updater relies on, checked the way install.sh checks its own receipt. */
export function readReceipt(path: string, uid: number): Receipt | null {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.uid !== uid || (stats.mode & 0o777) !== 0o600) return null;
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (document.schemaVersion !== 2 || document.appId !== APP_ID || document.uid !== uid) return null;
    if (typeof document.currentVersion !== 'string' || typeof document.launcher !== 'string') return null;
    if (!Array.isArray(document.releases)) return null;
    const releases = document.releases.flatMap((entry) => {
      const release = entry as Record<string, unknown>;
      return typeof release?.version === 'string' && typeof release?.path === 'string'
        ? [{ version: release.version, path: release.path }]
        : [];
    });
    return { currentVersion: document.currentVersion, launcher: document.launcher, releases };
  } catch {
    return null;
  }
}

const real = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const writable = (directory: string): boolean => {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

export function detectInstallation(input: DetectInput): Installation {
  const base: Installation = {
    kind: 'development',
    version: input.version,
    canApply: false,
    reason: null,
    receiptPath: null,
    launcher: null,
    installedVersion: null,
    appImage: null,
  };

  if (!input.isPackaged) {
    return { ...base, reason: 'Running from source. Updates install into copies installed with install.sh or run as an AppImage.' };
  }

  // The AppImage runtime sets APPIMAGE and APPDIR for the program it starts, and everything that
  // program starts inherits them: an installed Antimatter opened from an AppImage editor's terminal
  // sees the editor's APPIMAGE. Only an executable inside APPDIR, the image's own mount, runs from it.
  const appImage = input.env.APPIMAGE;
  const appDir = input.env.APPDIR && isAbsolute(input.env.APPDIR) ? real(input.env.APPDIR) : null;
  const runningFrom = real(dirname(input.execPath));
  const insideAppDir = !!appDir && !!runningFrom && (runningFrom === appDir || runningFrom.startsWith(`${appDir}/`));
  if (appImage && isAbsolute(appImage) && insideAppDir) {
    try {
      if (lstatSync(appImage).isFile()) {
        const canWrite = writable(dirname(appImage));
        return {
          ...base,
          kind: 'appimage',
          appImage: resolve(appImage),
          canApply: canWrite,
          reason: canWrite ? null : `${dirname(appImage)} is not writable, so the AppImage cannot be replaced.`,
        };
      }
    } catch {
      // APPIMAGE pointed at nothing; fall through to the installer check.
    }
  }

  const receiptPath = receiptPathFor(input.env, input.home);
  const receipt = readReceipt(receiptPath, input.uid);
  const owned = receipt && runningFrom && receipt.releases.some((release) => real(release.path) === runningFrom);
  if (receipt && owned) {
    const launcherOk = (() => {
      try {
        return lstatSync(receipt.launcher).isFile();
      } catch {
        return false;
      }
    })();
    return {
      ...base,
      kind: 'installer',
      receiptPath,
      launcher: launcherOk ? receipt.launcher : null,
      installedVersion: receipt.currentVersion,
      canApply: launcherOk,
      reason: launcherOk ? null : `The launcher ${receipt.launcher} is missing; reinstall with install.sh.`,
    };
  }

  return {
    ...base,
    kind: 'unmanaged',
    reason: 'This copy was not installed by install.sh, so it does not update itself. Install it with install.sh to get updates.',
  };
}
