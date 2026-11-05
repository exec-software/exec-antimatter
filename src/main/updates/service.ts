import { copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { writePrivateFileAtomic } from '../privateState';
import { appImageName, installerAssets, replaceAppImage, requireArtifacts, runInstaller, verifyInstalled } from './apply';
import { DEFAULT_FEED, feedCandidates, feedReachable, readLatest, readNotes, resolveFeed, type FeedBuild } from './feed';
import type { InstallKind, Installation } from './installation';
import { copyVerified } from './stage';
import { isNewer } from './version';

/**
 * Keeping an installed Antimatter current from a configured release feed.
 *
 * It checks a little after startup and every few hours, and when the share has something newer it
 * copies it down and installs it in the background. The desktop owner is told when an automatic
 * update is ready so it can relaunch only after interactive and background inference is idle.
 * Keeping that policy outside this service also keeps update installation usable in tests and in
 * future non-desktop hosts.
 */

export type UpdateStatus =
  | 'idle'
  | 'checking'
  /** Nothing newer is published. */
  | 'current'
  /** The releases share is not reachable from here; nothing to do until it is. */
  | 'offline'
  | 'available'
  | 'downloading'
  | 'installing'
  /** Installed; a restart switches to it. */
  | 'ready'
  | 'failed';

export interface UpdateState {
  status: UpdateStatus;
  version: string;
  install: { kind: InstallKind; canApply: boolean; reason: string | null };
  feed: { path: string | null; configured: boolean; defaultPath: string };
  automatic: boolean;
  lastCheckedAt: number | null;
  available: {
    version: string;
    buildId: string;
    publishedAt: string | null;
    commit: string | null;
    bytes: number;
    notes: string | null;
  } | null;
  progress: { bytesDone: number; bytesTotal: number } | null;
  readyVersion: string | null;
  /** Automatic relaunch state. A manual Restart now remains available while it is waiting. */
  restart: { pending: boolean; blockers: string[]; error: string | null };
  error: string | null;
  logPath: string | null;
}

interface SettingsFile {
  version: 1;
  feedPath: string | null;
  automatic: boolean;
  lastCheckedAt: number | null;
  /** The old/new pair for which a detached relaunch helper was already attempted. */
  automaticRestartAttempt: { fromVersion: string; toVersion: string } | null;
}

export interface UpdateServiceDeps {
  userData: string;
  /** Local staging for copied releases, e.g. ~/.cache/antimatter/updates. */
  cacheRoot: string;
  /** Re-detected on each check: a finished install changes the receipt underneath the running app. */
  detect(): Installation;
  env: NodeJS.ProcessEnv;
  uid: number;
  send(state: UpdateState): void;
  /** A verified automatic update is installed and may be relaunched when the host is safely idle. */
  onAutomaticReady?(state: UpdateState): void;
  candidates?(): Promise<string[]> | string[];
  /** Whether the feed's server answers; defaults to probing the network mount behind the path. */
  reachable?(path: string): Promise<boolean>;
  now?(): number;
  initialDelayMs?: number;
  intervalMs?: number;
  installerTimeoutMs?: number;
}

const INITIAL_DELAY_MS = 2_000;
/** A soft CIFS mount fails a read eventually; a check should not wait that long to say so. */
const READ_TIMEOUT_MS = 30_000;
const INTERVAL_MS = 4 * 60 * 60 * 1000;
const PROGRESS_EMIT_MS = 200;
const TRUSTED_FEED_REQUIRED = 'Choose a trusted release folder in Settings → Updates before installing. Discovered shares are informational until you select one.';

const configuredFeedPath = (value: unknown): string | null =>
  typeof value === 'string' && isAbsolute(value) && !value.includes('\0') ? resolve(value) : null;

const withTimeout = <T>(work: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolveWork, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(message), { offline: true })), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolveWork(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

export class UpdateService {
  private settings: SettingsFile;
  private installation: Installation;
  private status: UpdateStatus = 'idle';
  private latest: FeedBuild | null = null;
  /** A selection is authority for that check only, never for a later discovered replacement. */
  private latestFeed: { path: string; revision: number } | null = null;
  private feedRevision = 0;
  private available: UpdateState['available'] = null;
  private progress: UpdateState['progress'] = null;
  private readyVersion: string | null = null;
  private restart: UpdateState['restart'] = { pending: false, blockers: [], error: null };
  private error: string | null = null;
  private logPath: string | null = null;
  private busy: Promise<void> | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private abort: AbortController | null = null;
  private lastProgressEmit = 0;
  private announcedReadyVersion: string | null = null;
  /** Where the last check found (or looked for) the feed. Reported as is: state() never touches the share. */
  private feed: { path: string | null; configured: boolean };

  constructor(private readonly deps: UpdateServiceDeps) {
    this.settings = this.readSettings();
    this.feed = { path: this.settings.feedPath, configured: !!this.settings.feedPath };
    this.installation = deps.detect();
    this.clearCompletedRestartAttempt();
    this.noticeInstalled();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private get settingsPath(): string {
    return join(this.deps.userData, 'updates.json');
  }

  private readSettings(): SettingsFile {
    const fallback: SettingsFile = {
      version: 1,
      feedPath: null,
      automatic: true,
      lastCheckedAt: null,
      automaticRestartAttempt: null,
    };
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<SettingsFile>;
      if (parsed.version !== 1) return fallback;
      return {
        version: 1,
        feedPath: configuredFeedPath(parsed.feedPath),
        automatic: parsed.automatic !== false,
        lastCheckedAt: typeof parsed.lastCheckedAt === 'number' ? parsed.lastCheckedAt : null,
        automaticRestartAttempt:
          typeof parsed.automaticRestartAttempt?.fromVersion === 'string' &&
          typeof parsed.automaticRestartAttempt?.toVersion === 'string'
            ? {
                fromVersion: parsed.automaticRestartAttempt.fromVersion,
                toVersion: parsed.automaticRestartAttempt.toVersion,
              }
            : null,
      };
    } catch {
      return fallback;
    }
  }

  private saveSettings(): boolean {
    try {
      writePrivateFileAtomic(this.settingsPath, `${JSON.stringify(this.settings, null, 2)}\n`);
      return true;
    } catch (error) {
      console.error('[updates] could not save settings:', error);
      return false;
    }
  }

  /** Once the attempted target is the process that is running, the old-process loop latch is stale. */
  private clearCompletedRestartAttempt(): void {
    const attempt = this.settings.automaticRestartAttempt;
    if (!attempt) return;
    try {
      if (isNewer(attempt.toVersion, this.installation.version)) return;
    } catch {
      // An invalid legacy value must never permanently disable automatic relaunches.
    }
    this.settings.automaticRestartAttempt = null;
    this.saveSettings();
  }

  private automaticRestartAlreadyAttempted(version: string): boolean {
    const attempt = this.settings.automaticRestartAttempt;
    return attempt?.fromVersion === this.installation.version && attempt.toVersion === version;
  }

  /** A newer version already installed — by an earlier run of this updater, or by hand — only needs a restart. */
  private noticeInstalled(): void {
    const installed = this.installation.installedVersion;
    if (this.installation.kind === 'installer' && installed && isNewer(installed, this.installation.version)) {
      this.readyVersion = installed;
      if (this.status === 'idle' || this.status === 'current') this.status = 'ready';
      if (this.automaticRestartAlreadyAttempted(installed)) {
        this.restart.error =
          `Automatic restart from ${this.installation.version} to ${installed} was already attempted. ` +
          'Use Restart now when you are ready.';
      }
    }
  }

  state(): UpdateState {
    return {
      status: this.status,
      version: this.installation.version,
      install: {
        kind: this.installation.kind,
        canApply: this.installation.canApply,
        reason: this.installation.reason,
      },
      feed: { path: this.feed.path, configured: this.feed.configured, defaultPath: DEFAULT_FEED },
      automatic: this.settings.automatic,
      lastCheckedAt: this.settings.lastCheckedAt,
      available: this.available,
      progress: this.progress,
      readyVersion: this.readyVersion,
      restart: { ...this.restart, blockers: [...this.restart.blockers] },
      error: this.error,
      logPath: this.logPath,
    };
  }

  private emit(): void {
    const state = this.state();
    this.deps.send(state);
    if (
      state.automatic &&
      state.status === 'ready' &&
      state.readyVersion &&
      !this.automaticRestartAlreadyAttempted(state.readyVersion) &&
      this.announcedReadyVersion !== state.readyVersion
    ) {
      this.announcedReadyVersion = state.readyVersion;
      this.deps.onAutomaticReady?.(state);
    }
  }

  start(): void {
    if (this.timers.length) return;
    const initial = setTimeout(() => void this.check(), this.deps.initialDelayMs ?? INITIAL_DELAY_MS);
    const interval = setInterval(() => void this.check(), this.deps.intervalMs ?? INTERVAL_MS);
    initial.unref?.();
    interval.unref?.();
    this.timers.push(initial, interval);
    this.emit();
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.abort?.abort();
  }

  /**
   * Persist the exact running/installed pair before a host spawns its relaunch helper. Returning
   * false is a hard stop: either this pair was already tried or loop protection could not be
   * written durably.
   */
  claimAutomaticRestart(version: string): boolean {
    if (!this.settings.automatic || this.status !== 'ready' || this.readyVersion !== version) return false;
    if (this.automaticRestartAlreadyAttempted(version)) return false;
    const previous = this.settings.automaticRestartAttempt;
    this.settings.automaticRestartAttempt = { fromVersion: this.installation.version, toVersion: version };
    if (this.saveSettings()) return true;
    this.settings.automaticRestartAttempt = previous;
    return false;
  }

  /** Report why an installed automatic update is waiting without conflating that with install failure. */
  setAutomaticRestartState(next: Partial<UpdateState['restart']>): UpdateState {
    const restart = {
      pending: next.pending ?? this.restart.pending,
      blockers: next.blockers ? [...next.blockers] : this.restart.blockers,
      error: next.error === undefined ? this.restart.error : next.error,
    };
    if (
      restart.pending === this.restart.pending &&
      restart.error === this.restart.error &&
      restart.blockers.length === this.restart.blockers.length &&
      restart.blockers.every((blocker, index) => blocker === this.restart.blockers[index])
    ) {
      return this.state();
    }
    this.restart = restart;
    // This is a host status update, not a new ready transition; emit without re-offering it.
    this.deps.send(this.state());
    return this.state();
  }

  /** One check at a time; a check asked for while another runs waits for it and reports its result. */
  async check(): Promise<UpdateState> {
    if (this.busy) {
      await this.busy;
      return this.state();
    }
    this.busy = this.checkUnlocked().finally(() => {
      this.busy = null;
    });
    await this.busy;
    return this.state();
  }

  private async checkUnlocked(): Promise<void> {
    const revision = this.feedRevision;
    const selectedFeed = this.settings.feedPath;
    this.installation = this.deps.detect();
    this.noticeInstalled();
    this.status = 'checking';
    this.error = null;
    this.latest = null;
    this.latestFeed = null;
    this.available = null;
    this.emit();

    const candidates = this.deps.candidates ? await this.deps.candidates() : await feedCandidates(this.deps.env, this.deps.uid);
    if (revision !== this.feedRevision) return;
    const feed = await resolveFeed(selectedFeed, candidates, this.deps.reachable ?? feedReachable);
    if (revision !== this.feedRevision) return;
    this.feed = { path: feed.path, configured: feed.configured };
    this.settings.lastCheckedAt = this.now();
    this.saveSettings();

    let build: FeedBuild;
    try {
      if (!feed.path) {
        throw Object.assign(new Error(`No Antimatter builds were found at ${DEFAULT_FEED}; choose a trusted release folder in Settings → Updates.`), { offline: true });
      }
      if (!feed.reachable) {
        throw Object.assign(new Error(`The release server is not reachable from this network, so ${feed.path} cannot be read.`), { offline: true });
      }
      build = await withTimeout(readLatest(feed.path), READ_TIMEOUT_MS, `Reading ${feed.path} took longer than ${READ_TIMEOUT_MS / 1000}s.`);
    } catch (error) {
      if (revision !== this.feedRevision) return;
      const code = (error as NodeJS.ErrnoException).code;
      const offline =
        (error as { offline?: boolean }).offline || ['ENOENT', 'EHOSTDOWN', 'EHOSTUNREACH', 'ETIMEDOUT', 'EIO'].includes(code ?? '');
      this.error = offline && code === 'ENOENT' ? `No update feed at ${feed.path}; choose a trusted release folder in Settings → Updates.` : (error as Error).message;
      // An installed update still only needs a restart, whatever the share is doing.
      this.status = this.readyVersion ? 'ready' : offline ? 'offline' : 'failed';
      this.emit();
      return;
    }
    if (revision !== this.feedRevision) return;

    const newest = this.readyVersion && isNewer(this.readyVersion, this.installation.version) ? this.readyVersion : this.installation.version;
    if (!isNewer(build.version, newest)) {
      this.latest = null;
      this.available = null;
      this.status = this.readyVersion ? 'ready' : 'current';
      this.emit();
      return;
    }

    const needed = this.neededArtifacts(build);
    const available = {
      version: build.version,
      buildId: build.buildId,
      publishedAt: build.publishedAt,
      commit: build.commit,
      bytes: needed.reduce((total, name) => total + (build.artifacts.get(name)?.size ?? 0), 0),
      notes: await withTimeout(readNotes(build), READ_TIMEOUT_MS, 'Release notes took too long to read.').catch(() => null),
    };
    if (revision !== this.feedRevision) return;
    this.latest = build;
    this.latestFeed = feed.configured && selectedFeed ? { path: selectedFeed, revision } : null;
    this.available = available;
    this.status = 'available';
    this.emit();

    if (this.settings.automatic && this.installation.canApply && this.hasTrustedLatest()) await this.applyUnlocked();
  }

  private hasTrustedLatest(): boolean {
    return this.latest !== null && this.latestFeed !== null &&
      this.latestFeed.revision === this.feedRevision && this.latestFeed.path === this.settings.feedPath;
  }

  private neededArtifacts(build: FeedBuild): string[] {
    return this.installation.kind === 'appimage' ? [appImageName(build.version)] : installerAssets(build.version);
  }

  /** Installs what the last check found. */
  async apply(): Promise<UpdateState> {
    while (this.busy) await this.busy;
    if (this.status === 'ready' || this.status === 'current') return this.state();
    this.busy = (async () => {
      if (!this.latest) await this.checkUnlocked();
      if (this.latest && this.status !== 'ready') await this.applyUnlocked();
    })().finally(() => {
      this.busy = null;
    });
    await this.busy;
    return this.state();
  }

  private async applyUnlocked(): Promise<void> {
    const build = this.latest;
    if (!build) return;
    if (!this.hasTrustedLatest()) {
      this.status = 'failed';
      this.error = TRUSTED_FEED_REQUIRED;
      this.emit();
      return;
    }
    if (!this.installation.canApply) {
      this.status = 'failed';
      this.error = this.installation.reason ?? 'This copy of Antimatter cannot install updates.';
      this.emit();
      return;
    }

    const revision = this.feedRevision;
    const abort = new AbortController();
    this.abort = abort;
    this.error = null;
    this.logPath = null;
    try {
      const names = this.neededArtifacts(build);
      const artifacts = requireArtifacts(build, names);
      const total = artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
      let finished = 0;
      this.status = 'downloading';
      this.progress = { bytesDone: 0, bytesTotal: total };
      this.emit();
      const report = (bytes: number) => {
        this.progress = { bytesDone: Math.min(total, finished + bytes), bytesTotal: total };
        const at = this.now();
        if (at - this.lastProgressEmit >= PROGRESS_EMIT_MS) {
          this.lastProgressEmit = at;
          this.emit();
        }
      };

      if (this.installation.kind === 'appimage') {
        await replaceAppImage(artifacts[0], this.installation.appImage!, { signal: abort.signal, onBytes: report });
      } else {
        const stageDir = join(this.deps.cacheRoot, `${build.version}__${build.buildId}`);
        await this.clearOtherStages(stageDir);
        await mkdir(stageDir, { recursive: true, mode: 0o700 });
        for (const artifact of artifacts) {
          await copyVerified(artifact, join(stageDir, artifact.name), { signal: abort.signal, onBytes: report });
          finished += artifact.size;
        }
        abort.signal.throwIfAborted();

        this.status = 'installing';
        this.progress = null;
        this.logPath = join(stageDir, 'install.log');
        this.emit();
        await runInstaller({
          stageDir,
          version: build.version,
          logPath: this.logPath,
          env: this.deps.env,
          signal: abort.signal,
          timeoutMs: this.deps.installerTimeoutMs,
        });
        verifyInstalled(this.installation.receiptPath!, this.deps.uid, build.version);

        // The staged copy has done its job; keep only the log, beside the other stages.
        const keptLog = join(this.deps.cacheRoot, 'last-install.log');
        copyFileSync(this.logPath, keptLog);
        this.logPath = keptLog;
        await rm(stageDir, { recursive: true, force: true });
      }

      this.readyVersion = build.version;
      this.latest = null;
      this.available = null;
      this.progress = null;
      this.status = 'ready';
      this.installation = this.deps.detect();
    } catch (error) {
      if (revision !== this.feedRevision) return;
      this.status = 'failed';
      this.progress = null;
      this.error = abort.signal.aborted ? 'The update was stopped.' : (error as Error).message;
      console.error('[updates] update failed:', error);
    } finally {
      if (this.abort === abort) this.abort = null;
      this.emit();
    }
  }

  /** Staged copies of versions other than the one being installed are superseded. */
  private async clearOtherStages(keep: string): Promise<void> {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.deps.cacheRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(this.deps.cacheRoot, entry);
      if (path !== keep && entry.includes('__')) await rm(path, { recursive: true, force: true });
    }
  }

  /**
   * What to run so a restart lands in the installed version, or null when there is nothing to restart into.
   * `args` are the running process's own arguments: they carry over, less the one the launcher adds itself.
   */
  restartTarget(args: string[] = []): { execPath: string; args: string[] } | null {
    if (this.status !== 'ready' || !this.readyVersion) return null;
    const carried = args.filter((arg) => arg !== '--class=Antimatter');
    if (this.installation.kind === 'installer' && this.installation.launcher) return { execPath: this.installation.launcher, args: carried };
    if (this.installation.kind === 'appimage' && this.installation.appImage) return { execPath: this.installation.appImage, args: carried };
    return null;
  }

  setAutomatic(automatic: boolean): UpdateState {
    this.settings.automatic = automatic;
    // Turning automatic updates back on should re-offer an already installed release to the
    // desktop restart coordinator. Turning them off cancels that coordinator through state().
    if (!automatic) {
      this.announcedReadyVersion = null;
      this.restart = { pending: false, blockers: [], error: null };
    }
    this.saveSettings();
    this.emit();
    if (automatic && this.status === 'available' && this.installation.canApply && this.hasTrustedLatest()) void this.apply();
    return this.state();
  }

  setFeed(path: string | null): UpdateState {
    const selected = configuredFeedPath(path);
    if (path !== null && selected === null) throw new Error('Choose an absolute path to a trusted release folder.');
    const previous = this.settings.feedPath;
    this.settings.feedPath = selected;
    if (!this.saveSettings()) {
      this.settings.feedPath = previous;
      throw new Error('The trusted release folder could not be saved; the previous selection is unchanged.');
    }
    this.feedRevision += 1;
    this.abort?.abort();
    this.feed = { path: selected, configured: selected !== null };
    this.latest = null;
    this.latestFeed = null;
    this.available = null;
    this.progress = null;
    this.error = null;
    if (!this.readyVersion) this.status = 'idle';
    this.emit();
    return this.state();
  }
}
