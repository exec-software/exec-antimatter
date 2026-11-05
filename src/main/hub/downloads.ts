import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeRepoPath, HubError, quantOf, type HubTransport } from './api';
import * as cache from './cache';
import { readGgufMetadata } from './gguf';
import { transferFile } from './transfer';
import type { DownloadRecord, HubVariant, Registration } from './types';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from '../privateState';

/**
 * The download queue behind the Model Hub.
 *
 * One transfer at a time: these are files of tens of gigabytes, and two of them fighting over one
 * connection finish no sooner than one after the other while both look slower. Everything a
 * download needs to pick up again — which files, at which commit, into which cache — is written
 * to disk as it changes, so quitting in the middle is a pause rather than a loss: the next launch
 * resumes whatever was running, from the bytes already there.
 */

export interface DownloadDeps {
  storePath: string;
  /** The cache new downloads go into. */
  root(): string;
  token(): string | null;
  endpoint(): string;
  userAgent: string;
  transport?: HubTransport;
  /** Bytes available under a path, or null when the filesystem will not say. */
  freeBytes?(path: string): number | null;
  /** Called with every record, throttled while bytes are moving. */
  emit(records: DownloadRecord[]): void;
  /**
   * The files are in place and verified. Registration runs after this returns; it can take a
   * while (an engine may need to finish a turn before it restarts), and must never hold the queue.
   */
  onReady(record: DownloadRecord): void;
  /** A finished download is being removed; take it back out of every engine it was registered with. */
  onRemove?(record: DownloadRecord): void;
  inspect?(path: string): Promise<{ architecture: string | null; contextLength: number | null; fileType: number | null }>;
  now?(): number;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

interface StoreFile {
  version: 1;
  downloads: DownloadRecord[];
}

/** Room left over after a download, so finishing one never fills the disk to the last byte. */
const SPACE_MARGIN = 512 * 1024 * 1024;
const EMIT_EVERY_MS = 250;
const PERSIST_EVERY_MS = 3000;
const RATE_WINDOW_MS = 5000;
/** Waits between attempts after a dropped connection or a server error, in order. */
const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000];

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });

/** Free space under a path, measured on the nearest directory that already exists. */
export function freeBytesAt(path: string): number | null {
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  try {
    const stats = statfsSync(cursor);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** A registry-friendly id: `Qwen3-Coder-30B-A3B-Instruct-GGUF` at `Q4_K_M` → `qwen3-coder-30b-a3b-instruct-q4_k_m`. */
export function modelIdFor(repoId: string, variant: Pick<HubVariant, 'quant' | 'label'>): string {
  const name = repoId.split('/').pop() ?? repoId;
  const base = name.replace(/[-_.]?gguf$/i, '');
  const suffix = variant.quant ?? (variant.label !== base ? variant.label : '');
  const raw = suffix && !base.toLowerCase().endsWith(suffix.toLowerCase()) ? `${base}-${suffix}` : base;
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
}

const formatBytes = (value: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const step = Math.min(units.length - 1, Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)));
  return `${(value / 1024 ** step).toFixed(step === 0 ? 0 : 1)} ${units[step]}`;
};

export class DownloadManager {
  private records: DownloadRecord[] = [];
  private active: { id: string; controller: AbortController } | null = null;
  /** Why the active transfer was stopped, so its catch block knows it was not a failure. */
  private stopping = new Map<string, 'pause' | 'cancel' | 'remove' | 'shutdown'>();
  private samples = new Map<string, { at: number; bytes: number }[]>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersist = 0;
  private closed = false;

  constructor(private readonly deps: DownloadDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Reads the store and resumes whatever was transferring when the app last stopped. */
  load(): void {
    const path = this.deps.storePath;
    const ownsDirectory = migratePrivateDirectory(dirname(path));
    if (existsSync(path)) {
      if (ownsDirectory) migratePrivateFile(path);
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
        this.records = parsed?.version === 1 && Array.isArray(parsed.downloads) ? parsed.downloads : [];
      } catch (error) {
        console.error('[hub] unreadable download store, starting empty:', error);
        this.records = [];
      }
    }
    for (const record of this.records) {
      // Older records kept the human label but not the parsed quantization separately.
      if (record.quantization === undefined) record.quantization = quantOf(record.label);
      // Nobody paused these; the app stopped underneath them. Carry on.
      if (record.state === 'downloading') record.state = 'queued';
      // Registration is redone for every finished download at startup, so no phase survives a restart.
      record.phase = null;
      delete record.bytesPerSecond;
    }
    this.persist(true);
    this.pump();
  }

  /**
   * Reads back the header facts of finished downloads that predate them being kept.
   *
   * A record written before the quantization was recorded carries no `fileType`, and an engine
   * that cannot decode it would otherwise not find that out until a request failed. This is a few
   * kilobytes off the front of each file, so it is settled once at startup rather than guessed. A
   * file that has since been deleted or turned unreadable is recorded as read rather than retried
   * on every launch.
   */
  async fillMissingFacts(): Promise<void> {
    const vanished = this.dropVanished();

    const pending = this.records.filter(
      (record) => record.role === 'model' && record.state === 'ready' && record.fileType === undefined
    );
    if (!pending.length) {
      if (vanished) {
        this.persist(true);
        this.emitSoon();
      }
      return;
    }

    for (const record of pending) {
      try {
        if (!record.path || !existsSync(record.path)) throw new Error('the file is no longer in the cache');
        const facts = await (this.deps.inspect ?? readGgufMetadata)(record.path);
        record.fileType = facts.fileType;
        record.architecture ??= facts.architecture;
        record.contextLength ??= facts.contextLength;
      } catch (error) {
        record.fileType = null;
        console.error(`[hub] could not re-read the GGUF header of ${record.path}:`, error);
      }
    }
    this.persist(true);
    this.emitSoon();
  }

  /**
   * Marks `ready` downloads whose files are no longer on disk.
   *
   * `ready` was recorded the moment the bytes landed and never checked again, so a file removed
   * afterwards — by hand, or by clearing the cache — left a record that still named a model to
   * every engine. Worse, the source list is rebuilt through `withRegisteredModels`, so each
   * refresh put the dead entry back: the picker offered a model that could only fail at load,
   * and no amount of refreshing removed it.
   *
   * Failed rather than deleted: the record is how the download is resumed, and the repository and
   * revision in it are what re-fetching needs. `onRemove` takes it out of the engines, which is
   * the part that has to stop being true.
   */
  private dropVanished(): boolean {
    let changed = false;
    for (const record of this.records) {
      if (record.role !== 'model' || record.state !== 'ready') continue;
      if (record.path && existsSync(record.path)) continue;
      record.state = 'failed';
      record.phase = null;
      record.error = 'The downloaded file is no longer in the cache. Download it again to use this model.';
      for (const file of record.files) file.done = false;
      this.deps.onRemove?.(record);
      console.error(`[hub] ${record.repoId} ${record.label}: file is gone, marking it not ready`);
      changed = true;
    }
    return changed;
  }

  list(): DownloadRecord[] {
    return this.records.map((record) => ({ ...record, files: record.files.map((file) => ({ ...file })) }));
  }

  find(id: string): DownloadRecord | null {
    return this.records.find((record) => record.id === id) ?? null;
  }

  enqueue(input: { repoId: string; revision: string; variant: HubVariant }): DownloadRecord {
    const { repoId, revision, variant } = input;
    if (!variant.complete) {
      throw new HubError('invalid', `${variant.label} is missing shards on Hugging Face (${variant.files.length} of ${variant.shards}).`);
    }
    if (variant.files.some((file) => !file.sha256)) {
      throw new HubError('invalid', `${variant.label} has a file without a published checksum, so it cannot be verified.`);
    }

    const existing = this.records.find(
      (record) => record.repoId === repoId && record.revision === revision && record.variantKey === variant.key
    );
    if (existing) {
      if (existing.state === 'failed' || existing.state === 'paused') this.resume(existing.id);
      return existing;
    }

    const root = this.deps.root();
    this.assertSpace(root, repoId, variant.files);

    const taken = new Set(this.records.map((record) => record.modelId));
    const base = modelIdFor(repoId, variant);
    let modelId = base;
    for (let suffix = 2; taken.has(modelId); suffix += 1) modelId = `${base}-${suffix}`;

    const record: DownloadRecord = {
      id: randomUUID(),
      repoId,
      revision,
      variantKey: variant.key,
      label: variant.label,
      role: variant.role,
      files: variant.files.map((file) => ({ ...file, done: false })),
      bytesTotal: variant.bytes,
      bytesDone: 0,
      state: 'queued',
      phase: null,
      error: null,
      root,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      path: null,
      architecture: null,
      quantization: variant.quant,
      contextLength: null,
      fileType: null,
      modelId,
      registrations: [],
    };
    record.bytesDone = this.bytesAlready(record);
    this.records.push(record);
    this.persist(true);
    this.pump();
    return record;
  }

  pause(id: string): void {
    const record = this.find(id);
    if (!record || (record.state !== 'queued' && record.state !== 'downloading')) return;
    record.state = 'paused';
    record.phase = null;
    this.stopActive(id, 'pause');
    this.persist(true);
  }

  resume(id: string): void {
    const record = this.find(id);
    if (!record || (record.state !== 'paused' && record.state !== 'failed')) return;
    record.state = 'queued';
    record.error = null;
    this.persist(true);
    this.pump();
  }

  /** Gives up on an unfinished download and deletes what it wrote. */
  cancel(id: string): void {
    const record = this.find(id);
    if (!record || record.state === 'ready') return;
    this.stopActive(id, 'cancel');
    this.discard(record, true);
  }

  /** Forgets a download. A finished one is unregistered first; its files go only when asked. */
  remove(id: string, deleteFiles: boolean): void {
    const record = this.find(id);
    if (!record) return;
    this.stopActive(id, 'remove');
    if (record.state === 'ready') this.deps.onRemove?.(record);
    this.discard(record, deleteFiles || record.state !== 'ready');
  }

  setRegistrations(id: string, registrations: Registration[]): void {
    const record = this.find(id);
    if (!record) return;
    record.registrations = registrations;
    if (record.phase === 'registering') record.phase = null;
    this.persist(true);
  }

  /** Stops the transfer in flight without marking anything failed; `load` resumes it next launch. */
  shutdown(): void {
    this.closed = true;
    if (this.active) this.stopActive(this.active.id, 'shutdown');
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.persist(true);
  }

  private discard(record: DownloadRecord, deleteFiles: boolean): void {
    if (deleteFiles) {
      try {
        cache.removeFiles(record.root, record.repoId, record.revision, record.files);
      } catch (error) {
        console.error(`[hub] could not delete files for ${record.repoId}:`, error);
      }
    }
    this.records = this.records.filter((entry) => entry.id !== record.id);
    this.samples.delete(record.id);
    this.persist(true);
    this.pump();
  }

  private stopActive(id: string, reason: 'pause' | 'cancel' | 'remove' | 'shutdown'): void {
    if (this.active?.id !== id) return;
    this.stopping.set(id, reason);
    this.active.controller.abort();
  }

  private bytesAlready(record: DownloadRecord): number {
    return record.files.reduce((total, file) => total + (file.sha256 ? Math.min(cache.bytesOnDisk(record.root, record.repoId, file.sha256), file.size) : 0), 0);
  }

  private assertSpace(root: string, repoId: string, files: { size: number; sha256: string | null }[]): void {
    const free = (this.deps.freeBytes ?? freeBytesAt)(root);
    if (free === null) return;
    const needed = files.reduce(
      (total, file) => total + Math.max(0, file.size - (file.sha256 ? cache.bytesOnDisk(root, repoId, file.sha256) : 0)),
      0
    );
    if (needed + SPACE_MARGIN > free) {
      throw new HubError('invalid', `This needs ${formatBytes(needed)} and ${root} has ${formatBytes(free)} free.`);
    }
  }

  private pump(): void {
    if (this.closed || this.active) return;
    const next = this.records.find((record) => record.state === 'queued');
    if (next) void this.run(next);
  }

  private async run(record: DownloadRecord): Promise<void> {
    const controller = new AbortController();
    this.active = { id: record.id, controller };
    record.state = 'downloading';
    record.error = null;
    record.startedAt ??= this.now();
    this.persist(true);

    try {
      this.assertSpace(record.root, record.repoId, record.files.filter((file) => !file.done));
      const doneBytes = () => record.files.reduce((total, file) => total + (file.done ? file.size : 0), 0);

      for (const file of record.files) {
        // A file marked done must still be there: someone may have cleared the cache since.
        if (file.done && cache.hasFile(record.root, record.repoId, record.revision, file.path, file.size)) continue;
        file.done = false;
        const before = doneBytes();
        await this.transferWithRetry(record, file, controller.signal, (bytes) => this.progress(record, before + bytes));
        cache.linkSnapshot(record.root, record.repoId, record.revision, file.path, file.sha256!);
        file.done = true;
        this.persist(true);
      }

      record.phase = 'finishing';
      this.emitSoon();
      cache.writeRef(record.root, record.repoId, 'main', record.revision);
      record.path = cache.snapshotPath(record.root, record.repoId, record.revision, record.files[0].path);
      record.bytesDone = record.bytesTotal;

      if (record.role === 'model') {
        try {
          const facts = await (this.deps.inspect ?? readGgufMetadata)(record.path);
          record.architecture = facts.architecture;
          record.contextLength = facts.contextLength;
          record.fileType = facts.fileType;
        } catch (error) {
          // Unreadable metadata does not un-verify the bytes; it only means no engine can be chosen for them.
          console.error(`[hub] could not read the GGUF header of ${record.path}:`, error);
        }
      }

      record.state = 'ready';
      record.phase = record.role === 'model' ? 'registering' : null;
      record.finishedAt = this.now();
      delete record.bytesPerSecond;
      this.persist(true);
      if (record.role === 'model') this.deps.onReady(record);
    } catch (error) {
      const reason = this.stopping.get(record.id);
      if (reason) {
        // Paused, cancelled, removed or quitting: the method that stopped it owns the state.
        if (reason === 'shutdown') record.state = 'queued';
      } else {
        record.state = 'failed';
        record.phase = null;
        record.error = (error as Error).message;
        console.error(`[hub] ${record.repoId} ${record.label} failed:`, error);
      }
    } finally {
      this.stopping.delete(record.id);
      this.samples.delete(record.id);
      delete record.bytesPerSecond;
      if (this.active?.id === record.id) this.active = null;
      this.persist(true);
      this.pump();
    }
  }

  private async transferWithRetry(
    record: DownloadRecord,
    file: DownloadRecord['files'][number],
    signal: AbortSignal,
    onBytes: (bytes: number) => void
  ): Promise<void> {
    const endpoint = this.deps.endpoint();
    let corruptRetries = 0;

    for (let attempt = 0; ; attempt += 1) {
      try {
        await transferFile({
          url: `${endpoint}/${record.repoId}/resolve/${record.revision}/${encodeRepoPath(file.path)}`,
          destination: cache.blobPath(record.root, record.repoId, file.sha256!),
          size: file.size,
          sha256: file.sha256,
          token: this.deps.token(),
          trustedOrigin: new URL(endpoint).origin,
          transport: this.deps.transport,
          signal,
          userAgent: this.deps.userAgent,
          onBytes,
          onPhase: (phase) => {
            record.phase = phase;
            this.emitSoon();
          },
        });
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        const hubError = error instanceof HubError ? error : null;
        // A checksum failure has already deleted its partial; one clean second try is worth it.
        const again =
          (hubError?.retryable && attempt < BACKOFF_MS.length) || (hubError?.code === 'corrupt' && corruptRetries++ < 1);
        if (!again) throw error;

        const wait = Math.max(hubError?.retryAfterMs ?? 0, hubError?.code === 'corrupt' ? 0 : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
        record.error = `${(error as Error).message} Retrying in ${Math.round(wait / 1000)}s.`;
        this.emitSoon();
        await (this.deps.sleep ?? defaultSleep)(wait, signal);
        record.error = null;
      }
    }
  }

  private progress(record: DownloadRecord, bytes: number): void {
    record.bytesDone = Math.min(bytes, record.bytesTotal);
    const at = this.now();
    const samples = this.samples.get(record.id) ?? [];
    samples.push({ at, bytes: record.bytesDone });
    while (samples.length > 2 && at - samples[0].at > RATE_WINDOW_MS) samples.shift();
    this.samples.set(record.id, samples);
    const first = samples[0];
    const span = at - first.at;
    // Hashing a resumed partial also reports bytes; only a transfer has a rate worth showing.
    record.bytesPerSecond = record.phase === 'transferring' && span >= 1000 ? ((record.bytesDone - first.bytes) * 1000) / span : undefined;

    this.emitSoon();
    if (at - this.lastPersist > PERSIST_EVERY_MS) this.persist(false);
  }

  private emitSoon(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.deps.emit(this.list());
    }, EMIT_EVERY_MS);
  }

  private persist(emitNow: boolean): void {
    this.lastPersist = this.now();
    const stored: StoreFile = {
      version: 1,
      downloads: this.records.map(({ bytesPerSecond: _rate, ...record }) => record),
    };
    try {
      writePrivateFileAtomic(this.deps.storePath, `${JSON.stringify(stored, null, 2)}\n`);
    } catch (error) {
      console.error('[hub] could not save the download store:', error);
    }
    if (emitNow) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.deps.emit(this.list());
    }
  }
}
