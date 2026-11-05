import type { ActiveTurnRecord } from '../activeTurns';
import type { PublicDeviceRecord } from './pairingStore';
import { RemoteProtocolError, type RemoteCommand } from './protocol';

export type RemoteTurnControlCommand = Extract<RemoteCommand, {
  kind: 'turn.cancel' | 'turn.steer' | 'approval.resolve';
}>;

export interface RemoteTurnControlDependencies {
  activeTurn(requestId: string): ActiveTurnRecord | null;
  projectForThread(threadId: string): string | null;
}

/** Desktop turns have no remote project lease; resolve their current thread scope afresh. */
export function inspectRemoteTurnControl(
  device: Pick<PublicDeviceRecord, 'id'>,
  command: RemoteTurnControlCommand,
  dependencies: RemoteTurnControlDependencies,
): ActiveTurnRecord | null {
  const active = dependencies.activeTurn(command.payload.requestId);
  if (!active || dependencies.projectForThread(active.threadId) !== command.projectId) return null;
  // A phone-owned turn must also retain the scope in which it was accepted, even if moved later.
  if (active.projectId !== undefined && active.projectId !== command.projectId) return null;
  if (active.owner.kind === 'remote' && active.owner.deviceId !== device.id) {
    throw new RemoteProtocolError('TURN_OWNERSHIP', 'This device does not own that turn.', 403);
  }
  return active;
}
