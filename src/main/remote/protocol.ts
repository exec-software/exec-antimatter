import { createHash } from 'node:crypto';

export const REMOTE_PROTOCOL_MAJOR = 1 as const;

export const REMOTE_LIMITS = {
  jsonBodyBytes: 256 * 1024,
  jsonResponseBytes: 8 * 1024 * 1024,
  eventResponseBytes: 2 * 1024 * 1024,
  idCharacters: 128,
  deviceNameCharacters: 80,
  modelIdCharacters: 512,
  messageCharacters: 256 * 1024,
  steerCharacters: 32 * 1024,
  titleCharacters: 240,
  attachmentCount: 32,
  canonicalDepth: 32,
} as const;

export type RemoteCapability = 'chat' | 'files' | 'previews' | 'terminal' | 'orchestrator' | 'approvals';
export type RemoteAccessMode = 'read' | 'ask' | 'full';

export interface RemoteModelKey {
  providerId: string;
  modelId: string;
}

export interface PairingExchangeInput {
  offerId: string;
  deviceName: string;
  clientVersion: string;
  protocol: { major: typeof REMOTE_PROTOCOL_MAJOR; minor: number };
  requestedCapabilities: RemoteCapability[];
}

interface CommandBase {
  protocolVersion: typeof REMOTE_PROTOCOL_MAJOR;
  workspaceId: string;
  projectId: string;
  commandId: string;
  expectedThreadRevision?: string;
}

export interface StartTurnCommand extends CommandBase {
  kind: 'turn.start';
  expectedThreadRevision: string;
  payload: {
    threadId: string;
    requestId: string;
    userMessageId: string;
    responseMessageId: string;
    model: RemoteModelKey;
    content: string;
    attachmentIds: string[];
    accessMode: RemoteAccessMode;
  };
}

export interface CancelTurnCommand extends CommandBase {
  kind: 'turn.cancel';
  payload: { requestId: string };
}

export interface SteerTurnCommand extends CommandBase {
  kind: 'turn.steer';
  payload: { requestId: string; note: string; now: boolean };
}

export interface ResolveApprovalCommand extends CommandBase {
  kind: 'approval.resolve';
  payload: { requestId: string; approvalId: string; approved: boolean };
}

export interface CreateThreadCommand extends CommandBase {
  kind: 'thread.create';
  payload: { clientThreadId: string; title: string; model?: RemoteModelKey };
}

export interface RenameThreadCommand extends CommandBase {
  kind: 'thread.rename';
  payload: { threadId: string; title: string };
}

export interface PinThreadCommand extends CommandBase {
  kind: 'thread.set_pinned';
  payload: { threadId: string; pinned: boolean };
}

export interface SetThreadModelCommand extends CommandBase {
  kind: 'thread.set_model';
  payload: { threadId: string; model: RemoteModelKey };
}

export interface DeleteThreadCommand extends CommandBase {
  kind: 'thread.delete';
  payload: { threadId: string };
}

export type RemoteCommand =
  | StartTurnCommand
  | CancelTurnCommand
  | SteerTurnCommand
  | ResolveApprovalCommand
  | CreateThreadCommand
  | RenameThreadCommand
  | PinThreadCommand
  | SetThreadModelCommand
  | DeleteThreadCommand;

export interface RemoteCommandReceipt {
  commandId: string;
  requestId: string | null;
  disposition: 'accepted' | 'already_finished';
  acceptedAt: number;
  result?: { threadId: string; clientThreadId: string };
}

export interface EventCursor {
  epoch: string;
  sequence: number;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class RemoteProtocolError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, status = 400, retryable = false) {
    super(message);
    this.name = 'RemoteProtocolError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const CAPABILITIES = new Set<RemoteCapability>([
  'chat',
  'files',
  'previews',
  'terminal',
  'orchestrator',
  'approvals',
]);
const ACCESS_MODES = new Set<RemoteAccessMode>(['read', 'ask', 'full']);
// PairingStore uses base64url entropy for host, offer and device IDs. Both '_' and
// '-' can be the first character; rejecting those made otherwise valid QR codes
// fail at random and made affected host identities unusable for commands.
const ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const fail = (code: string, message: string, status = 400): never => {
  throw new RemoteProtocolError(code, message, status);
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('INVALID_REQUEST', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number, options: { empty?: boolean } = {}): string {
  if (typeof value !== 'string') return fail('INVALID_REQUEST', `${label} must be text.`);
  const normalized = value.trim();
  if (!options.empty && !normalized) return fail('INVALID_REQUEST', `${label} is required.`);
  if (value.length > max) return fail('LIMIT_EXCEEDED', `${label} is too long.`, 413);
  return value;
}

function id(value: unknown, label: string): string {
  const normalized = text(value, label, REMOTE_LIMITS.idCharacters).trim();
  if (!ID_PATTERN.test(normalized)) return fail('INVALID_REQUEST', `${label} is not a valid identifier.`);
  return normalized;
}

// Provider model identifiers are not protocol routing IDs. OpenAI-compatible catalogs commonly
// use names such as `org/model`, and Antimatter's source catalog deliberately permits them.
function modelId(value: unknown): string {
  const normalized = text(value, 'model.modelId', REMOTE_LIMITS.modelIdCharacters).trim();
  if (CONTROL_CHARACTERS.test(normalized)) {
    return fail('INVALID_REQUEST', 'model.modelId contains unsupported control characters.');
  }
  return normalized;
}

export const parseOpaqueId = (value: unknown, label = 'id'): string => id(value, label);

function optionalRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return id(value, 'expectedThreadRevision');
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return fail('INVALID_REQUEST', `${label} must be true or false.`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail('INVALID_REQUEST', `${label} must be an integer of at least ${minimum}.`);
  }
  return value as number;
}

function model(value: unknown): RemoteModelKey {
  const input = record(value, 'model');
  return { providerId: id(input.providerId, 'model.providerId'), modelId: modelId(input.modelId) };
}

function capabilities(value: unknown): RemoteCapability[] {
  if (!Array.isArray(value) || value.length > CAPABILITIES.size) {
    return fail('INVALID_REQUEST', 'requestedCapabilities must be a bounded list.');
  }
  const result: RemoteCapability[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !CAPABILITIES.has(candidate as RemoteCapability)) {
      return fail('INVALID_REQUEST', 'requestedCapabilities contains an unsupported capability.');
    }
    if (!result.includes(candidate as RemoteCapability)) result.push(candidate as RemoteCapability);
  }
  return result;
}

export function parsePairingExchange(value: unknown): PairingExchangeInput {
  const input = record(value, 'pairing request');
  const protocol = record(input.protocol, 'protocol');
  const major = integer(protocol.major, 'protocol.major');
  if (major !== REMOTE_PROTOCOL_MAJOR) {
    return fail('INCOMPATIBLE_PROTOCOL', `Protocol major ${major} is not supported.`, 426);
  }
  return {
    offerId: id(input.offerId, 'offerId'),
    deviceName: text(input.deviceName, 'deviceName', REMOTE_LIMITS.deviceNameCharacters).trim(),
    clientVersion: text(input.clientVersion, 'clientVersion', 80).trim(),
    protocol: { major: REMOTE_PROTOCOL_MAJOR, minor: integer(protocol.minor, 'protocol.minor') },
    requestedCapabilities: capabilities(input.requestedCapabilities),
  };
}

function base(input: Record<string, unknown>): CommandBase {
  const protocolVersion = integer(input.protocolVersion, 'protocolVersion');
  if (protocolVersion !== REMOTE_PROTOCOL_MAJOR) {
    return fail('INCOMPATIBLE_PROTOCOL', `Protocol major ${protocolVersion} is not supported.`, 426);
  }
  const revision = optionalRevision(input.expectedThreadRevision);
  return {
    protocolVersion: REMOTE_PROTOCOL_MAJOR,
    workspaceId: id(input.workspaceId, 'workspaceId'),
    projectId: id(input.projectId, 'projectId'),
    commandId: id(input.commandId, 'commandId'),
    ...(revision ? { expectedThreadRevision: revision } : {}),
  };
}

export const commandRequestId = (command: RemoteCommand): string | null =>
  'requestId' in command.payload ? command.payload.requestId : null;

export function parseRemoteCommand(value: unknown): RemoteCommand {
  const input = record(value, 'command');
  const common = base(input);
  const payload = record(input.payload, 'command.payload');
  switch (input.kind) {
    case 'turn.start': {
      if (!Array.isArray(payload.attachmentIds) || payload.attachmentIds.length > REMOTE_LIMITS.attachmentCount) {
        return fail('LIMIT_EXCEEDED', 'attachmentIds contains too many entries.', 413);
      }
      const accessMode = payload.accessMode;
      if (typeof accessMode !== 'string' || !ACCESS_MODES.has(accessMode as RemoteAccessMode)) {
        return fail('INVALID_REQUEST', 'accessMode is unsupported.');
      }
      if (!common.expectedThreadRevision) {
        return fail('REVISION_REQUIRED', 'A current conversation revision is required.', 409);
      }
      return {
        ...common,
        expectedThreadRevision: common.expectedThreadRevision,
        kind: 'turn.start',
        payload: {
          threadId: id(payload.threadId, 'threadId'),
          requestId: id(payload.requestId, 'requestId'),
          userMessageId: id(payload.userMessageId, 'userMessageId'),
          responseMessageId: id(payload.responseMessageId, 'responseMessageId'),
          model: model(payload.model),
          content: text(payload.content, 'content', REMOTE_LIMITS.messageCharacters),
          attachmentIds: payload.attachmentIds.map((entry, index) => id(entry, `attachmentIds[${index}]`)),
          accessMode: accessMode as RemoteAccessMode,
        },
      };
    }
    case 'turn.cancel':
      return { ...common, kind: 'turn.cancel', payload: { requestId: id(payload.requestId, 'requestId') } };
    case 'turn.steer':
      return {
        ...common,
        kind: 'turn.steer',
        payload: {
          requestId: id(payload.requestId, 'requestId'),
          note: text(payload.note, 'note', REMOTE_LIMITS.steerCharacters),
          now: boolean(payload.now, 'now'),
        },
      };
    case 'approval.resolve':
      return {
        ...common,
        kind: 'approval.resolve',
        payload: {
          requestId: id(payload.requestId, 'requestId'),
          approvalId: id(payload.approvalId, 'approvalId'),
          approved: boolean(payload.approved, 'approved'),
        },
      };
    case 'thread.create':
      return {
        ...common,
        kind: 'thread.create',
        payload: {
          clientThreadId: id(payload.clientThreadId, 'clientThreadId'),
          title: text(payload.title, 'title', REMOTE_LIMITS.titleCharacters),
          ...(payload.model === undefined ? {} : { model: model(payload.model) }),
        },
      };
    case 'thread.rename':
      return {
        ...common,
        kind: 'thread.rename',
        payload: {
          threadId: id(payload.threadId, 'threadId'),
          title: text(payload.title, 'title', REMOTE_LIMITS.titleCharacters),
        },
      };
    case 'thread.set_pinned':
      return {
        ...common,
        kind: 'thread.set_pinned',
        payload: { threadId: id(payload.threadId, 'threadId'), pinned: boolean(payload.pinned, 'pinned') },
      };
    case 'thread.set_model':
      return {
        ...common,
        kind: 'thread.set_model',
        payload: { threadId: id(payload.threadId, 'threadId'), model: model(payload.model) },
      };
    case 'thread.delete':
      return { ...common, kind: 'thread.delete', payload: { threadId: id(payload.threadId, 'threadId') } };
    default:
      return fail('UNKNOWN_COMMAND', 'This command is not supported by this host.');
  }
}

export function parseEventCursor(epoch: unknown, sequence: unknown): EventCursor | null {
  if (epoch === undefined && sequence === undefined) return null;
  return { epoch: id(epoch, 'cursor.epoch'), sequence: integer(sequence, 'cursor.sequence') };
}

function canonical(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > REMOTE_LIMITS.canonicalDepth) return fail('LIMIT_EXCEEDED', 'JSON nesting is too deep.', 413);
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('INVALID_REQUEST', 'JSON numbers must be finite.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') return fail('INVALID_REQUEST', 'Value is not JSON serializable.');
  if (seen.has(value)) return fail('INVALID_REQUEST', 'Cyclic values are not supported.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry, depth + 1, seen)).join(',')}]`;
    const input = value as Record<string, unknown>;
    const entries = Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(input[key], depth + 1, seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonical(value, 0, new Set());
}

export function canonicalPayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('base64url');
}

export function assertBodySize(value: unknown): void {
  const bytes = Buffer.byteLength(canonicalJson(value));
  if (bytes > REMOTE_LIMITS.jsonBodyBytes) {
    fail('LIMIT_EXCEEDED', 'The request body is too large.', 413);
  }
}

export function assertResponseSize(value: unknown): void {
  const bytes = Buffer.byteLength(canonicalJson(value));
  if (bytes > REMOTE_LIMITS.jsonResponseBytes) {
    fail('LIMIT_EXCEEDED', 'The response is too large. Request a smaller snapshot.', 413);
  }
}

export function accessRank(mode: RemoteAccessMode): number {
  return mode === 'read' ? 0 : mode === 'ask' ? 1 : 2;
}
