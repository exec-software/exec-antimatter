import { ActiveTurns, type ActiveTurnRecord } from '../activeTurns';
import type { ConversationThread } from '../conversations';
import type { PublicDeviceRecord } from './pairingStore';
import { RemoteProtocolError, type RemoteCommand } from './protocol';

export type RemoteTurnStartCommand = Extract<RemoteCommand, { kind: 'turn.start' }>;

export interface RemoteTurnProject {
  id: string;
  name: string;
  root: string;
}

export interface RemoteTurnSource {
  name: string;
}

export interface RemoteTurnStartDependencies {
  activeTurns: ActiveTurns;
  resolveProject(projectId: string): RemoteTurnProject | null;
  loadThread(projectId: string, threadId: string): ConversationThread;
  resolveModel(providerId: string, modelId: string): RemoteTurnSource | null;
}

export interface RemoteTurnStartInspection {
  project: RemoteTurnProject;
  thread: ConversationThread;
  source: RemoteTurnSource;
}

export interface RemoteTurnStartReservation extends RemoteTurnStartInspection {
  active: ActiveTurnRecord;
}

export function expectedRemoteThreadRevision(command: RemoteCommand, current: number): number {
  const raw = command.expectedThreadRevision;
  if (raw === undefined) {
    throw new RemoteProtocolError('REVISION_REQUIRED', 'A current conversation revision is required.', 409, true);
  }
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new RemoteProtocolError('REVISION_INVALID', 'The conversation revision is invalid.', 409, true);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed !== current) {
    throw new RemoteProtocolError('REVISION_CONFLICT', 'The conversation changed; refresh it and try again.', 409, true);
  }
  return parsed;
}

/**
 * Re-reads every mutable start precondition. The router calls this once before durable acceptance;
 * dispatch calls it again because another command can pass validation while the first callback is
 * suspended at the router's async boundary.
 */
export function inspectRemoteTurnStart(
  command: RemoteTurnStartCommand,
  dependencies: RemoteTurnStartDependencies
): RemoteTurnStartInspection {
  const project = dependencies.resolveProject(command.projectId);
  if (!project) throw new RemoteProtocolError('PROJECT_MISMATCH', 'Project is no longer available.', 403);
  const thread = dependencies.loadThread(command.projectId, command.payload.threadId);
  expectedRemoteThreadRevision(command, thread.revision);
  if (command.payload.attachmentIds.length) {
    throw new RemoteProtocolError('ATTACHMENTS_UNAVAILABLE', 'Remote attachments are not enabled in this alpha.', 422);
  }
  if (dependencies.activeTurns.runFor(thread.id)) {
    throw new RemoteProtocolError('TURN_ACTIVE', 'This conversation already has a running turn.', 409, true);
  }
  if (dependencies.activeTurns.recordForRun(command.payload.requestId)) {
    throw new RemoteProtocolError('TURN_ACTIVE', 'That turn request is already running.', 409, true);
  }
  const source = dependencies.resolveModel(command.payload.model.providerId, command.payload.model.modelId);
  if (!source) {
    throw new RemoteProtocolError('MODEL_UNAVAILABLE', 'The selected model is not available on this host.', 409, true);
  }
  if (command.payload.userMessageId === command.payload.responseMessageId) {
    throw new RemoteProtocolError('MESSAGE_CONFLICT', 'The user and assistant message identities must be different.', 409);
  }
  if (thread.messages.some((message) =>
    message.id === command.payload.userMessageId || message.id === command.payload.responseMessageId
  )) {
    throw new RemoteProtocolError('MESSAGE_CONFLICT', 'A message with that identity already exists.', 409);
  }
  return { project, thread, source };
}

/**
 * Synchronous compare-and-reserve boundary for a remote turn. No transcript mutation may happen
 * before this returns. JavaScript cannot interleave another command between the fresh inspection
 * and ActiveTurns.begin(), so thread and request ownership are acquired as one host operation.
 */
export function reserveRemoteTurnStart(
  device: PublicDeviceRecord,
  command: RemoteTurnStartCommand,
  dependencies: RemoteTurnStartDependencies
): RemoteTurnStartReservation {
  const inspected = inspectRemoteTurnStart(command, dependencies);
  try {
    const active = dependencies.activeTurns.begin(inspected.thread.id, command.payload.requestId, {
      owner: { kind: 'remote', deviceId: device.id },
      projectId: command.projectId,
      responseMessageId: command.payload.responseMessageId,
    });
    return { ...inspected, active };
  } catch {
    // ActiveTurns is the final authority. Convert its deliberately UI-oriented error into a
    // stable protocol failure in case a future caller introduces an asynchronous inspection.
    throw new RemoteProtocolError('TURN_ACTIVE', 'This conversation or request already has a running turn.', 409, true);
  }
}
