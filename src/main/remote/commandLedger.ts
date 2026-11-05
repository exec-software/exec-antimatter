import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  migratePrivateDirectory,
  migratePrivateFile,
  writePrivateFileAtomic,
} from '../privateState';
import {
  canonicalPayloadHash,
  parseRemoteCommand,
  RemoteProtocolError,
  type RemoteCommand,
  type RemoteCommandReceipt,
} from './protocol';

export type CommandLedgerState = 'pending' | 'dispatching' | 'applied' | 'failed' | 'already_finished';

export interface CommandFailure {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
}

export interface CommandRecord {
  deviceId: string;
  commandId: string;
  payloadHash: string;
  kind: RemoteCommand['kind'] | 'legacy';
  projectId: string | null;
  receipt: RemoteCommandReceipt;
  state: CommandLedgerState;
  /** Retained only while recovery may need to dispatch the command. */
  command?: RemoteCommand;
  failure?: CommandFailure;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

interface LegacyCommandRecord {
  deviceId: string;
  commandId: string;
  payloadHash: string;
  receipt: RemoteCommandReceipt;
  createdAt: number;
}

interface LegacyCommandLedgerFile {
  version: 1;
  records: LegacyCommandRecord[];
}

interface CommandLedgerFile {
  version: 2;
  records: CommandRecord[];
}

export interface CommandLedgerOptions {
  path: string;
  now?: () => number;
  retentionMs?: number;
  maxRecords?: number;
  /** Fault-injection seam. The default is the private atomic-file writer. */
  writeFile?: (path: string, contents: string) => void;
}

export interface LedgerAcceptResult {
  fresh: boolean;
  record: CommandRecord;
}

const terminal = (state: CommandLedgerState): boolean =>
  state === 'applied' || state === 'failed' || state === 'already_finished';

const cloneReceipt = (receipt: RemoteCommandReceipt): RemoteCommandReceipt => ({
  ...receipt,
  ...(receipt.result ? { result: { ...receipt.result } } : {}),
});

const cloneRecord = (record: CommandRecord): CommandRecord => ({
  ...record,
  receipt: cloneReceipt(record.receipt),
  ...(record.command ? { command: structuredClone(record.command) } : {}),
  ...(record.failure ? { failure: { ...record.failure } } : {}),
});

function validReceipt(value: unknown): value is RemoteCommandReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<RemoteCommandReceipt>;
  const result = receipt.result;
  const validResult = result === undefined || (
    !!result &&
    typeof result === 'object' &&
    typeof result.threadId === 'string' &&
    typeof result.clientThreadId === 'string'
  );
  return (
    typeof receipt.commandId === 'string' &&
    (receipt.requestId === null || typeof receipt.requestId === 'string') &&
    (receipt.disposition === 'accepted' || receipt.disposition === 'already_finished') &&
    typeof receipt.acceptedAt === 'number' &&
    Number.isSafeInteger(receipt.acceptedAt) &&
    validResult
  );
}

function validFailure(value: unknown): value is CommandFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const failure = value as Partial<CommandFailure>;
  return (
    typeof failure.code === 'string' &&
    typeof failure.message === 'string' &&
    typeof failure.status === 'number' &&
    Number.isSafeInteger(failure.status) &&
    failure.status >= 400 &&
    failure.status <= 599 &&
    typeof failure.retryable === 'boolean'
  );
}

function parsedStoredCommand(value: unknown): RemoteCommand | null {
  try {
    return parseRemoteCommand(value);
  } catch {
    return null;
  }
}

function validLegacyRecord(value: unknown): value is LegacyCommandRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<LegacyCommandRecord>;
  return (
    typeof record.deviceId === 'string' &&
    typeof record.commandId === 'string' &&
    typeof record.payloadHash === 'string' &&
    typeof record.createdAt === 'number' &&
    Number.isSafeInteger(record.createdAt) &&
    validReceipt(record.receipt)
  );
}

function normalizeRecord(value: unknown): CommandRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<CommandRecord>;
  if (
    typeof record.deviceId !== 'string' ||
    typeof record.commandId !== 'string' ||
    typeof record.payloadHash !== 'string' ||
    !['pending', 'dispatching', 'applied', 'failed', 'already_finished'].includes(String(record.state)) ||
    typeof record.kind !== 'string' ||
    (record.projectId !== null && typeof record.projectId !== 'string') ||
    !validReceipt(record.receipt) ||
    typeof record.attempts !== 'number' ||
    !Number.isSafeInteger(record.attempts) ||
    record.attempts < 0 ||
    typeof record.createdAt !== 'number' ||
    !Number.isSafeInteger(record.createdAt) ||
    typeof record.updatedAt !== 'number' ||
    !Number.isSafeInteger(record.updatedAt)
  ) return null;

  const state = record.state as CommandLedgerState;
  const command = record.command === undefined ? null : parsedStoredCommand(record.command);
  if (!terminal(state) && !command) return null;
  if (command && (
    command.commandId !== record.commandId ||
    command.kind !== record.kind ||
    command.projectId !== record.projectId ||
    canonicalPayloadHash(command) !== record.payloadHash
  )) return null;
  if (state === 'failed' ? !validFailure(record.failure) : record.failure !== undefined) return null;

  return {
    deviceId: record.deviceId,
    commandId: record.commandId,
    payloadHash: record.payloadHash,
    kind: record.kind as CommandRecord['kind'],
    projectId: record.projectId,
    receipt: cloneReceipt(record.receipt),
    state,
    ...(command && !terminal(state) ? { command } : {}),
    ...(record.failure ? { failure: { ...record.failure } } : {}),
    attempts: record.attempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Durable command outbox and de-duplication ledger. Every mutation is copy-on-write: the candidate
 * file reaches the atomic writer before it becomes observable in memory. Nonterminal records keep
 * their full normalized command so a new process can recover them; terminal records retain only a
 * payload hash and public outcome metadata.
 */
export class CommandLedger {
  private readonly path: string;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxRecords: number;
  private readonly writeFile: (path: string, contents: string) => void;
  private records: CommandRecord[];
  private byKey = new Map<string, CommandRecord>();

  constructor(options: CommandLedgerOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60_000;
    this.maxRecords = options.maxRecords ?? 50_000;
    this.writeFile = options.writeFile ?? writePrivateFileAtomic;
    if (this.retentionMs <= 0 || this.maxRecords <= 0) throw new Error('Command ledger limits must be positive.');
    const loaded = this.load();
    const pruned = this.pruned(loaded.records);
    this.records = pruned;
    this.byKey = this.index(pruned);
    if (loaded.migrated || pruned.length !== loaded.records.length) this.persist(pruned);
  }

  accept(deviceId: string, command: RemoteCommand, receipt: RemoteCommandReceipt): LedgerAcceptResult {
    if (!deviceId || receipt.commandId !== command.commandId) {
      throw new Error('Command ledger identity does not match its receipt.');
    }
    const payloadHash = canonicalPayloadHash(command);
    const existing = this.byKey.get(this.key(deviceId, command.commandId));
    if (existing) {
      this.assertMatchingPayload(existing, payloadHash);
      return { fresh: false, record: cloneRecord(existing) };
    }
    if (command.kind === 'thread.create') {
      const earlier = this.records.find((record) =>
        record.deviceId === deviceId &&
        record.kind === 'thread.create' &&
        record.state !== 'failed' &&
        record.receipt.result?.clientThreadId === command.payload.clientThreadId
      );
      if (earlier) {
        throw new RemoteProtocolError(
          'CLIENT_THREAD_CONFLICT',
          'This client conversation identity is already bound to another command. Refresh the workspace before retrying.',
          409,
          true
        );
      }
    }

    const at = this.now();
    const record: CommandRecord = {
      deviceId,
      commandId: command.commandId,
      payloadHash,
      kind: command.kind,
      projectId: command.projectId,
      receipt: cloneReceipt(receipt),
      state: 'pending',
      command: structuredClone(command),
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.commit(this.pruned([...this.records, record]));
    return { fresh: true, record: cloneRecord(record) };
  }

  replayRecord(deviceId: string, commandId: string, payload: unknown): CommandRecord | null {
    const record = this.byKey.get(this.key(deviceId, commandId));
    if (!record) return null;
    this.assertMatchingPayload(record, canonicalPayloadHash(payload));
    return cloneRecord(record);
  }

  lookupRecord(deviceId: string, commandId: string): CommandRecord | null {
    const record = this.byKey.get(this.key(deviceId, commandId));
    return record ? cloneRecord(record) : null;
  }

  recoverable(deviceId?: string): CommandRecord[] {
    return this.records
      .filter((record) => !terminal(record.state) && (deviceId === undefined || record.deviceId === deviceId))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(cloneRecord);
  }

  outcomes(deviceId: string, limit = 100): CommandRecord[] {
    return this.records
      .filter((record) => record.deviceId === deviceId && record.state !== 'applied')
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(0, limit))
      .map(cloneRecord);
  }

  claim(deviceId: string, commandId: string): CommandRecord | null {
    const existing = this.byKey.get(this.key(deviceId, commandId));
    if (!existing || terminal(existing.state)) return null;
    const updated: CommandRecord = {
      ...existing,
      state: 'dispatching',
      attempts: existing.attempts + 1,
      updatedAt: this.now(),
    };
    this.replace(existing, updated);
    return cloneRecord(updated);
  }

  complete(
    deviceId: string,
    commandId: string,
    state: 'applied' | 'already_finished',
    result?: RemoteCommandReceipt['result']
  ): CommandRecord {
    const existing = this.required(deviceId, commandId);
    if (terminal(existing.state)) return cloneRecord(existing);
    if (result && (
      existing.kind !== 'thread.create' ||
      existing.command?.kind !== 'thread.create' ||
      existing.command.payload.clientThreadId !== result.clientThreadId
    )) {
      throw new Error('Thread creation outcome does not match its durable command.');
    }
    const updated: CommandRecord = {
      ...existing,
      state,
      receipt: {
        ...existing.receipt,
        disposition: state === 'already_finished' ? 'already_finished' : existing.receipt.disposition,
        ...(result ? { result: { ...result } } : {}),
      },
      command: undefined,
      failure: undefined,
      updatedAt: this.now(),
    };
    this.replace(existing, updated);
    return cloneRecord(updated);
  }

  fail(deviceId: string, commandId: string, failure: CommandFailure): CommandRecord {
    const existing = this.required(deviceId, commandId);
    if (terminal(existing.state)) return cloneRecord(existing);
    const updated: CommandRecord = {
      ...existing,
      state: 'failed',
      command: undefined,
      failure: { ...failure },
      updatedAt: this.now(),
    };
    this.replace(existing, updated);
    return cloneRecord(updated);
  }

  size(): number {
    return this.records.length;
  }

  private key(deviceId: string, commandId: string): string {
    return `${deviceId}\0${commandId}`;
  }

  private required(deviceId: string, commandId: string): CommandRecord {
    const record = this.byKey.get(this.key(deviceId, commandId));
    if (!record) throw new Error('Command ledger record was not found.');
    return record;
  }

  private assertMatchingPayload(record: CommandRecord, payloadHash: string): void {
    if (record.payloadHash === payloadHash) return;
    throw new RemoteProtocolError(
      'IDEMPOTENCY_CONFLICT',
      'This command identifier was already used for different content.',
      409
    );
  }

  private replace(previous: CommandRecord, updated: CommandRecord): void {
    const candidate = this.records.map((record) => record === previous ? updated : record);
    this.commit(this.pruned(candidate, this.key(updated.deviceId, updated.commandId)));
  }

  private commit(candidate: CommandRecord[]): void {
    const next = candidate.map(cloneRecord);
    const index = this.index(next);
    this.persist(next);
    this.records = next;
    this.byKey = index;
  }

  private pruned(records: CommandRecord[], protectedKey?: string): CommandRecord[] {
    const cutoff = this.now() - this.retentionMs;
    let completed = records
      .filter((record) => terminal(record.state) && record.updatedAt >= cutoff)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    if (protectedKey) {
      const protectedRecord = completed.find((record) => this.key(record.deviceId, record.commandId) === protectedKey);
      if (protectedRecord) completed = [protectedRecord, ...completed.filter((record) => record !== protectedRecord)];
    }
    // maxRecords bounds terminal history. Nonterminal outbox entries are never discarded merely
    // because a device queued more work than the history ceiling.
    const keepCompleted = new Set(completed.slice(0, this.maxRecords));
    return records.filter((record) => !terminal(record.state) || keepCompleted.has(record));
  }

  private index(records: CommandRecord[]): Map<string, CommandRecord> {
    const result = new Map<string, CommandRecord>();
    for (const record of records) {
      const key = this.key(record.deviceId, record.commandId);
      if (result.has(key)) throw new Error('Command ledger contains duplicate identities.');
      result.set(key, record);
    }
    return result;
  }

  private load(): { records: CommandRecord[]; migrated: boolean } {
    const directory = dirname(this.path);
    migratePrivateDirectory(directory);
    if (!existsSync(this.path)) return { records: [], migrated: false };
    const stats = lstatSync(this.path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Command ledger is not an owned file.');
    migratePrivateFile(this.path);
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { version?: unknown; records?: unknown };
    if (parsed.version === 1 && Array.isArray(parsed.records) && parsed.records.every(validLegacyRecord)) {
      const legacyRecords = parsed.records as LegacyCommandRecord[];
      return {
        migrated: true,
        records: legacyRecords.map((record) => ({
          deviceId: record.deviceId,
          commandId: record.commandId,
          payloadHash: record.payloadHash,
          kind: 'legacy',
          projectId: null,
          receipt: cloneReceipt(record.receipt),
          state: 'failed',
          failure: {
            code: 'LEGACY_OUTCOME_UNKNOWN',
            message: 'This command was accepted by an older host, but its completion could not be verified. Refresh before retrying.',
            status: 409,
            retryable: true,
          },
          attempts: 1,
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
        })),
      };
    }
    if (parsed.version !== 2 || !Array.isArray(parsed.records)) {
      throw new Error('Command ledger is invalid; refusing to discard idempotency state.');
    }
    const records = parsed.records.map(normalizeRecord);
    if (records.some((record) => !record)) {
      throw new Error('Command ledger is invalid; refusing to discard idempotency state.');
    }
    return { records: records as CommandRecord[], migrated: false };
  }

  private persist(records: CommandRecord[]): void {
    const file: CommandLedgerFile = { version: 2, records };
    this.writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}
