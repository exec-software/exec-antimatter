import { randomUUID } from 'node:crypto';
import {
  CommandLedger,
  type CommandFailure,
  type CommandRecord,
} from './commandLedger';
import { EventJournal, type JournalReplay } from './eventJournal';
import { PairingStore, type PublicDeviceRecord } from './pairingStore';
import {
  accessRank,
  assertBodySize,
  assertResponseSize,
  canonicalPayloadHash,
  commandRequestId,
  parseEventCursor,
  parseOpaqueId,
  parsePairingExchange,
  parseRemoteCommand,
  RemoteProtocolError,
  type EventCursor,
  type JsonValue,
  type RemoteCommand,
  type RemoteCommandReceipt,
} from './protocol';

export interface SecureListenerConfiguration {
  /** Must name one explicit interface address; wildcard listeners are refused. */
  bindAddress: string;
  port: number;
  tls: true;
  /** SHA-256 of the exact leaf certificate DER, carried in the scan-or-paste pairing code. */
  certificatePin: string;
}

export function validateSecureListenerConfiguration(configuration: SecureListenerConfiguration): void {
  const address = configuration.bindAddress.trim().toLowerCase();
  if (!configuration.tls) throw new Error('Remote workspaces require TLS.');
  if (!address || ['0.0.0.0', '::', '[::]', '*'].includes(address)) {
    throw new Error('Remote workspaces must bind one explicit interface, not a wildcard address.');
  }
  if (!Number.isSafeInteger(configuration.port) || configuration.port < 1 || configuration.port > 65_535) {
    throw new Error('Remote workspace port is invalid.');
  }
  if (!/^sha256\/[A-Za-z0-9+/]{43}=$/.test(configuration.certificatePin)) {
    throw new Error('certificatePin must be a base64 SHA-256 digest of the leaf certificate DER.');
  }
}

export interface RemoteHttpRequest {
  /** Set only by the adapter after a real TLS socket has been established. */
  secure: boolean;
  method: string;
  pathname: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface RemoteHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: JsonValue;
}

export interface RemoteHostRouterOptions {
  pairing: PairingStore;
  ledger: CommandLedger;
  workspace: { id: string; name: string };
  certificatePin: string;
  eventsFor(deviceId: string): EventJournal;
  authorizeProject?(device: PublicDeviceRecord, projectId: string): boolean;
  /** Runs before an idempotency receipt is committed, so rejected commands can be corrected. */
  validateCommand?(device: PublicDeviceRecord, command: RemoteCommand): void | Promise<void>;
  newThreadId?: () => string;
  bootstrap(device: PublicDeviceRecord, selectedThreadId: string | null): JsonValue | Promise<JsonValue>;
  thread(device: PublicDeviceRecord, threadId: string): JsonValue | null | Promise<JsonValue | null>;
  /** Applies one claimed durable command. Conversation effects must use context.effect atomically. */
  dispatch(
    device: PublicDeviceRecord,
    command: RemoteCommand,
    receipt: RemoteCommandReceipt,
    context: RemoteDispatchContext
  ): RemoteDispatchResult | void | Promise<RemoteDispatchResult | void>;
  onDispatchError?(device: PublicDeviceRecord, command: RemoteCommand, error: unknown): void;
  /** Must revoke through the owning host so turns, waits, journals, and UI state end together. */
  revokeDevice(device: PublicDeviceRecord): void;
  onPaired?(device: PublicDeviceRecord, offerId: string): void;
  /** Host-lifetime reconciliation memory shared across listener rebinds. */
  executedCommands?: Map<string, RemoteExecutedCommandOutcome>;
}

export interface RemoteExecutedCommandOutcome {
  payloadHash: string;
  state: 'applied' | 'already_finished';
  result?: RemoteCommandReceipt['result'];
}

export type RemoteDispatchResult =
  | 'applied'
  | 'already_finished'
  | {
      state: 'applied' | 'already_finished';
      /** Canonical host identity recovered from the same atomic effect as thread creation. */
      result?: RemoteCommandReceipt['result'];
    };

export interface RemoteDispatchContext {
  recovery: boolean;
  effect: {
    id: string;
    payloadHash: string;
    kind: RemoteCommand['kind'];
    appliedAt: number;
    result?: RemoteCommandReceipt['result'];
  };
}

interface AuthorizedRequest {
  device: PublicDeviceRecord;
  credential: string;
}

const COMMON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

const errorBody = (error: RemoteProtocolError): JsonValue => ({
  error: { code: error.code, message: error.message, retryable: error.retryable },
});

const response = (status: number, body: JsonValue): RemoteHttpResponse => ({
  status,
  headers: { ...COMMON_HEADERS },
  body,
});

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

function header(request: RemoteHttpRequest, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length === 1) return value[0];
    return null;
  }
  return null;
}

function authorization(request: RemoteHttpRequest, scheme: 'Pair' | 'Bearer'): string {
  const value = header(request, 'authorization');
  const prefix = `${scheme} `;
  if (!value || !value.startsWith(prefix)) {
    throw new RemoteProtocolError('UNAUTHORIZED', 'Authentication is required.', 401);
  }
  const credential = value.slice(prefix.length);
  if (credential.length < 20 || credential.length > 512 || /\s/.test(credential)) {
    throw new RemoteProtocolError('UNAUTHORIZED', 'Authentication is invalid.', 401);
  }
  return credential;
}

function parseQueryInteger(value: string | undefined, label: string, minimum: number, maximum: number): number {
  if (value === undefined || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new RemoteProtocolError('INVALID_REQUEST', `${label} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RemoteProtocolError('INVALID_REQUEST', `${label} is outside the supported range.`);
  }
  return parsed;
}

function requiredCapability(command: Pick<RemoteCommand, 'kind'> | { kind: 'legacy' }): 'chat' | 'approvals' {
  return command.kind === 'approval.resolve' ? 'approvals' : 'chat';
}

const commandFailure = (error: unknown): CommandFailure => error instanceof RemoteProtocolError
  ? { code: error.code, message: error.message, status: error.status, retryable: error.retryable }
  : {
      code: 'DISPATCH_FAILED',
      message: 'The host could not apply that command. Refresh the workspace and try again.',
      status: 500,
      retryable: true,
    };

const outcome = (record: CommandRecord): JsonValue => ({
  receipt: record.receipt as unknown as JsonValue,
  state: record.state,
  attempts: record.attempts,
  updatedAt: record.updatedAt,
  ...(record.failure ? { failure: record.failure as unknown as JsonValue } : {}),
});

/**
 * Framework-neutral secure router. It deliberately cannot create a socket: a desktop integration
 * must provide a TLS adapter and mark `secure` only from that adapter, which prevents an accidental
 * cleartext or wildcard listener from becoming the remote protocol.
 */
export class RemoteHostRouter {
  private readonly options: RemoteHostRouterOptions;
  private readonly activeWaits = new Map<string, Set<AbortController>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /**
   * Dispatch may succeed while its terminal ledger write fails. Keep that outcome in-process so an
   * exact retry only re-attempts persistence and never repeats a non-durable control side effect.
   */
  private readonly executed: Map<string, RemoteExecutedCommandOutcome>;
  private dispatchTail: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly stopRevocationListener: () => void;

  constructor(options: RemoteHostRouterOptions) {
    if (!options.workspace.id || !options.workspace.name) throw new Error('Remote workspace identity is required.');
    if (!/^sha256\/[A-Za-z0-9+/]{43}=$/.test(options.certificatePin)) {
      throw new Error('certificatePin must be a base64 SHA-256 digest of the leaf certificate DER.');
    }
    this.options = options;
    this.executed = options.executedCommands ?? new Map<string, RemoteExecutedCommandOutcome>();
    this.stopRevocationListener = options.pairing.onRevoked((deviceId) => {
      for (const controller of this.activeWaits.get(deviceId) ?? []) controller.abort();
      this.activeWaits.delete(deviceId);
      void this.recover(deviceId);
    });
  }

  /** Replays every nonterminal outbox entry in acceptance order before the listener is published. */
  async recover(deviceId?: string): Promise<void> {
    if (this.closed) return;
    const pending = this.options.ledger.recoverable(deviceId);
    await Promise.all(pending.map((record) => this.schedule(record, true)));
  }

  async handle(request: RemoteHttpRequest): Promise<RemoteHttpResponse> {
    try {
      this.assertOpen();
      if (!request.secure) {
        throw new RemoteProtocolError('TLS_REQUIRED', 'Remote workspaces require HTTPS.', 426);
      }
      const method = request.method.toUpperCase();
      if (method === 'POST' && request.pathname === '/v1/pair') return this.pair(request);

      const authorized = this.authorize(request);
      if (method === 'GET' && request.pathname === '/v1/bootstrap') {
        this.requireCapability(authorized.device, 'chat');
        const rawThreadId = request.query?.threadId;
        const threadId = rawThreadId === undefined ? null : parseOpaqueId(rawThreadId, 'threadId');
        const snapshot = await this.options.bootstrap(authorized.device, threadId);
        const outcomes = this.options.ledger.outcomes(authorized.device.id).map(outcome);
        const body = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
          ? { ...snapshot, commandOutcomes: outcomes }
          : snapshot;
        assertResponseSize(body);
        return response(200, body);
      }

      if (method === 'POST' && request.pathname === '/v1/commands') {
        // Await inside the router's error boundary so async validation/ledger failures remain
        // typed HTTP responses instead of escaping the adapter as generic 500s.
        return await this.command(request, authorized.device);
      }

      if (method === 'GET' && request.pathname === '/v1/events') {
        return await this.events(request, authorized);
      }

      if (method === 'GET') {
        const commandMatch = /^\/v1\/commands\/([A-Za-z0-9_-][A-Za-z0-9._:-]{0,127})$/.exec(request.pathname);
        if (commandMatch) {
          const record = this.options.ledger.lookupRecord(authorized.device.id, commandMatch[1]);
          if (!record) throw new RemoteProtocolError('NOT_FOUND', 'Command outcome not found.', 404);
          this.requireCapability(authorized.device, requiredCapability(record));
          return response(200, outcome(record));
        }
        const match = /^\/v1\/threads\/([A-Za-z0-9_-][A-Za-z0-9._:-]{0,127})$/.exec(request.pathname);
        if (match) {
          this.requireCapability(authorized.device, 'chat');
          const thread = await this.options.thread(authorized.device, match[1]);
          if (thread === null) throw new RemoteProtocolError('NOT_FOUND', 'Conversation not found.', 404);
          assertResponseSize(thread);
          return response(200, thread);
        }
      }

      if (method === 'DELETE' && request.pathname === '/v1/session') {
        this.options.revokeDevice(authorized.device);
        return response(200, { revoked: true });
      }

      throw new RemoteProtocolError('NOT_FOUND', 'Remote endpoint not found.', 404);
    } catch (error) {
      if (error instanceof RemoteProtocolError) return response(error.status, errorBody(error));
      return response(500, {
        error: { code: 'INTERNAL', message: 'The remote host could not complete this request.', retryable: true },
      });
    }
  }

  /** WSS adapters can use the exact same authorization and cursor validation as long polling. */
  authorizeEventUpgrade(request: RemoteHttpRequest): {
    device: PublicDeviceRecord;
    cursor: EventCursor;
    journal: EventJournal;
  } {
    this.assertOpen();
    if (!request.secure || request.method.toUpperCase() !== 'GET' || request.pathname !== '/v1/events') {
      throw new RemoteProtocolError('UPGRADE_REJECTED', 'The event upgrade is invalid.', 400);
    }
    const authorized = this.authorize(request);
    this.requireCapability(authorized.device, 'chat');
    const cursor = this.cursorFrom(request);
    return { device: authorized.device, cursor, journal: this.options.eventsFor(authorized.device.id) };
  }

  close(): void {
    this.closed = true;
    this.stopRevocationListener();
    for (const controllers of this.activeWaits.values()) {
      for (const controller of controllers) controller.abort();
    }
    this.activeWaits.clear();
  }

  async drain(): Promise<void> {
    await this.dispatchTail;
  }

  private pair(request: RemoteHttpRequest): RemoteHttpResponse {
    const secret = authorization(request, 'Pair');
    assertBodySize(request.body);
    const input = parsePairingExchange(request.body);
    const paired = this.options.pairing.exchangeOffer({ ...input, secret });
    // Pairing has already committed and the one-time secret is consumed. A presentation callback
    // must never turn that success into an unrecoverable 500 that withholds the new credential.
    try {
      this.options.onPaired?.(paired.device, input.offerId);
    } catch {
      // State observers are best-effort; authentication state remains authoritative on disk.
    }
    return response(201, json({
      protocol: { major: 1, minor: 0 },
      host: { ...paired.host, certificatePin: this.options.certificatePin },
      workspace: { ...this.options.workspace },
      device: paired.device,
      credential: { scheme: 'Bearer', token: paired.credential },
    }));
  }

  private authorize(request: RemoteHttpRequest): AuthorizedRequest {
    const credential = authorization(request, 'Bearer');
    const device = this.options.pairing.authenticate(credential);
    if (!device) throw new RemoteProtocolError('UNAUTHORIZED', 'Device authorization is invalid or revoked.', 401);
    return { device, credential };
  }

  private async command(request: RemoteHttpRequest, device: PublicDeviceRecord): Promise<RemoteHttpResponse> {
    assertBodySize(request.body);
    const command = parseRemoteCommand(request.body);
    if (command.workspaceId !== this.options.workspace.id) {
      throw new RemoteProtocolError('WORKSPACE_MISMATCH', 'This command belongs to another workspace.', 409);
    }
    this.requireCapability(device, requiredCapability(command));
    if (command.kind === 'turn.start' && accessRank(command.payload.accessMode) > accessRank(device.maxAccess)) {
      throw new RemoteProtocolError('ACCESS_CEILING', 'This device cannot request that access level.', 403);
    }
    const replay = this.options.ledger.replayRecord(device.id, command.commandId, command);
    if (replay) {
      if (replay.failure) {
        throw new RemoteProtocolError(
          replay.failure.code,
          replay.failure.message,
          replay.failure.status,
          replay.failure.retryable
        );
      }
      if (replay.state === 'pending' || replay.state === 'dispatching') {
        await this.schedule(replay, false);
      }
      const current = this.options.ledger.lookupRecord(device.id, command.commandId) ?? replay;
      if (current.failure) {
        throw new RemoteProtocolError(
          current.failure.code,
          current.failure.message,
          current.failure.status,
          current.failure.retryable
        );
      }
      return response(202, json({ receipt: current.receipt, replayed: true, outcome: outcome(current) }));
    }

    if (this.options.authorizeProject && !this.options.authorizeProject(device, command.projectId)) {
      throw new RemoteProtocolError('PROJECT_MISMATCH', 'This command belongs to an unavailable project.', 403);
    }
    await this.options.validateCommand?.(device, command);
    // Validation may be asynchronous. Do not durably accept new work after shutdown has gated
    // the router, even if the request entered while the listener was still open.
    this.assertOpen();

    const receipt: RemoteCommandReceipt = {
      commandId: command.commandId,
      requestId: commandRequestId(command),
      disposition: 'accepted',
      acceptedAt: Date.now(),
      ...(command.kind === 'thread.create'
        ? {
            result: {
              clientThreadId: command.payload.clientThreadId,
              threadId: (this.options.newThreadId ?? randomUUID)(),
            },
          }
        : {}),
    };
    const accepted = this.options.ledger.accept(device.id, command, receipt);
    await this.schedule(accepted.record, false);
    const current = this.options.ledger.lookupRecord(device.id, command.commandId) ?? accepted.record;
    return response(202, json({
      receipt: current.receipt,
      replayed: !accepted.fresh,
      outcome: outcome(current),
    }));
  }

  private schedule(record: CommandRecord, recovery: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    const key = `${record.deviceId}\0${record.commandId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const task = this.dispatchTail
      .then(() => this.execute(record.deviceId, record.commandId, recovery))
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    this.dispatchTail = task.catch(() => undefined);
    return task;
  }

  private async execute(deviceId: string, commandId: string, recovery: boolean): Promise<void> {
    const current = this.options.ledger.lookupRecord(deviceId, commandId);
    const key = `${deviceId}\0${commandId}`;
    if (!current || current.state === 'applied' || current.state === 'failed' || current.state === 'already_finished') {
      this.executed.delete(key);
      return;
    }
    const command = current.command;
    if (!command) return;
    const executed = this.executed.get(key);
    if (executed) {
      if (executed.payloadHash !== current.payloadHash) {
        throw new Error('Executed command identity does not match its durable payload.');
      }
      try {
        this.options.ledger.complete(deviceId, commandId, executed.state, executed.result);
        this.executed.delete(key);
      } catch (error) {
        console.error(`[remote] could not finalize durable command ${commandId}:`, error);
      }
      return;
    }
    const device = this.options.pairing.activeDevice(deviceId);
    if (!device) {
      this.recordFailure(current, new RemoteProtocolError(
        'AUTHORITY_REVOKED',
        'The device authorization ended before this command could be applied.',
        403
      ));
      return;
    }

    try {
      this.requireCapability(device, requiredCapability(command));
      if (command.workspaceId !== this.options.workspace.id) {
        throw new RemoteProtocolError('WORKSPACE_MISMATCH', 'This command belongs to another workspace.', 409);
      }
      if (command.kind === 'turn.start' && accessRank(command.payload.accessMode) > accessRank(device.maxAccess)) {
        throw new RemoteProtocolError('ACCESS_CEILING', 'This device cannot request that access level.', 403);
      }
      if (this.options.authorizeProject && !this.options.authorizeProject(device, command.projectId)) {
        throw new RemoteProtocolError('PROJECT_MISMATCH', 'This command belongs to an unavailable project.', 403);
      }
    } catch (error) {
      this.recordFailure(current, error, device);
      return;
    }

    let claimed: CommandRecord;
    try {
      claimed = this.options.ledger.claim(deviceId, commandId) ?? current;
    } catch (error) {
      // Acceptance remains pending on disk. A later duplicate or process restart retries the claim.
      console.error(`[remote] could not claim durable command ${commandId}:`, error);
      return;
    }

    let result: RemoteDispatchResult | void;
    try {
      result = await this.options.dispatch(device, command, claimed.receipt, {
        recovery,
        effect: {
          id: canonicalPayloadHash({ deviceId, commandId }),
          payloadHash: claimed.payloadHash,
          kind: command.kind,
          appliedAt: claimed.receipt.acceptedAt,
          ...(claimed.receipt.result ? { result: { ...claimed.receipt.result } } : {}),
        },
      });
    } catch (error) {
      this.recordFailure(claimed, error, device);
      return;
    }

    try {
      const completionState = typeof result === 'object' && result !== null
        ? result.state
        : result === 'already_finished' ? 'already_finished' : 'applied';
      const completionResult = typeof result === 'object' && result !== null
        ? result.result
        : undefined;
      this.executed.set(key, {
        payloadHash: claimed.payloadHash,
        state: completionState,
        ...(completionResult ? { result: { ...completionResult } } : {}),
      });
      this.options.ledger.complete(
        deviceId,
        commandId,
        completionState,
        completionResult
      );
      this.executed.delete(key);
    } catch (error) {
      // The effect may already be durable. Leave the command dispatching so recovery can reconcile
      // its atomic marker; never downgrade a successful effect to a terminal failure.
      console.error(`[remote] could not finalize durable command ${commandId}:`, error);
    }
  }

  private recordFailure(record: CommandRecord, error: unknown, device?: PublicDeviceRecord): void {
    const command = record.command;
    if (!command) return;
    try {
      this.options.ledger.fail(record.deviceId, record.commandId, commandFailure(error));
    } catch (persistenceError) {
      console.error(`[remote] could not persist failure for durable command ${record.commandId}:`, persistenceError);
      return;
    }
    if (device) this.options.onDispatchError?.(device, command, error);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new RemoteProtocolError('HOST_STOPPING', 'Remote connections are stopping.', 503, true);
    }
  }

  private async events(request: RemoteHttpRequest, authorized: AuthorizedRequest): Promise<RemoteHttpResponse> {
    this.requireCapability(authorized.device, 'chat');
    const cursor = this.cursorFrom(request);
    const waitMs = request.query?.waitMs === undefined
      ? 0
      : parseQueryInteger(request.query.waitMs, 'waitMs', 0, 30_000);
    const journal = this.options.eventsFor(authorized.device.id);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (request.signal?.aborted) controller.abort();
    else request.signal?.addEventListener('abort', abort, { once: true });
    let set = this.activeWaits.get(authorized.device.id);
    if (!set) {
      set = new Set();
      this.activeWaits.set(authorized.device.id, set);
    }
    set.add(controller);
    try {
      const replay: JournalReplay = await journal.wait(cursor, waitMs, controller.signal);
      return response(200, replay as unknown as JsonValue);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RemoteProtocolError('UNAUTHORIZED', 'Device authorization ended.', 401);
      }
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', abort);
      set.delete(controller);
      if (!set.size) this.activeWaits.delete(authorized.device.id);
    }
  }

  private cursorFrom(request: RemoteHttpRequest): EventCursor {
    const epoch = request.query?.epoch;
    const rawAfter = request.query?.after;
    if (epoch === undefined || rawAfter === undefined) {
      throw new RemoteProtocolError('CURSOR_REQUIRED', 'An event cursor is required.', 409, true);
    }
    const after = parseQueryInteger(rawAfter, 'after', 0, Number.MAX_SAFE_INTEGER);
    const cursor = parseEventCursor(epoch, after);
    if (!cursor) throw new RemoteProtocolError('CURSOR_REQUIRED', 'An event cursor is required.', 409, true);
    return cursor;
  }

  private requireCapability(device: PublicDeviceRecord, capability: 'chat' | 'approvals'): void {
    if (!device.capabilities.includes(capability)) {
      throw new RemoteProtocolError('CAPABILITY_REQUIRED', `This device does not have ${capability} access.`, 403);
    }
  }
}
