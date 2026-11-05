import type { ChatRequest } from '../../api/types';
import { visibleRequestMessages } from '../../api/requestMessages';
import type { ActiveTurns } from '../activeTurns';
import * as conversations from '../conversations';
import type { RemoteDesktopTurns } from './desktopTurns';
import type { PublicDeviceRecord } from './pairingStore';
import type { RemoteTurnStartCommand, RemoteTurnStartReservation } from './turnStart';

export interface RemoteTurnSink {
  deviceId: string;
  projectId: string;
  threadId: string;
  requestId: string;
  responseMessageId: string;
  revision: number;
  waiting: boolean;
  cancellationRequested: boolean;
  pendingDelta: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  persistenceError: Error | null;
}

export interface RemoteTurnDependencies {
  activeTurns: ActiveTurns;
  desktopTurns: RemoteDesktopTurns;
  sinks: Map<string, RemoteTurnSink>;
  stream(request: ChatRequest, reservation: RemoteTurnStartReservation): Promise<void>;
  flush(sink: RemoteTurnSink): void;
  emit(sink: RemoteTurnSink, kind: string, payload: unknown): void;
  threadChanged(thread: conversations.ConversationThread, projectId: string): void;
}

/** A phone turn retains host ownership through the last durable assistant checkpoint. */
export async function runRemoteTurn(
  device: PublicDeviceRecord,
  command: RemoteTurnStartCommand,
  reservation: RemoteTurnStartReservation,
  effect: conversations.RemoteConversationEffect,
  initialized: { resolve(): void; reject(error: unknown): void },
  dependencies: RemoteTurnDependencies,
): Promise<void> {
  let sink: RemoteTurnSink | null = null;
  let failed = false;
  try {
    const at = Date.now();
    const thread = conversations.beginTurn(reservation.thread.id, {
      user: { id: command.payload.userMessageId, content: command.payload.content, createdAt: at },
      assistant: {
        id: command.payload.responseMessageId,
        createdAt: at,
        modelId: command.payload.model.modelId,
        sourceName: reservation.source.name,
      },
      providerId: command.payload.model.providerId,
      modelId: command.payload.model.modelId,
    }, reservation.thread.revision, effect);
    const messages = visibleRequestMessages(thread.messages.filter((message) => message.id !== command.payload.responseMessageId));
    sink = {
      deviceId: device.id,
      projectId: command.projectId,
      threadId: thread.id,
      requestId: command.payload.requestId,
      responseMessageId: command.payload.responseMessageId,
      revision: thread.revision,
      waiting: false,
      cancellationRequested: false,
      pendingDelta: '',
      flushTimer: null,
      persistenceError: null,
    };
    dependencies.sinks.set(sink.requestId, sink);
    dependencies.desktopTurns.begin({
      threadId: thread.id,
      runId: command.payload.requestId,
      responseMessageId: command.payload.responseMessageId,
      providerId: command.payload.model.providerId,
      modelId: command.payload.model.modelId,
      sourceName: reservation.source.name,
      startedAt: reservation.active.startedAt,
    });
    initialized.resolve();
    dependencies.threadChanged(thread, command.projectId);
    await dependencies.stream({
      messages,
      model: command.payload.model.modelId,
      providerId: command.payload.model.providerId,
      requestId: command.payload.requestId,
      responseMessageId: command.payload.responseMessageId,
      threadId: command.payload.threadId,
      accessMode: command.payload.accessMode,
    }, reservation);
    dependencies.flush(sink);
    if (sink.persistenceError) throw sink.persistenceError;
    const finished = conversations.finishAssistantMessage(sink.threadId, sink.responseMessageId, Date.now(), sink.revision);
    sink.revision = finished.revision;
    dependencies.emit(sink, 'turn.finished', {
      requestId: sink.requestId,
      responseMessageId: sink.responseMessageId,
      finishReason: sink.cancellationRequested ? 'cancelled' : 'finished',
    });
    dependencies.threadChanged(finished, sink.projectId);
  } catch (error) {
    failed = true;
    console.error('[remote] turn failed:', error);
    if (!sink) {
      initialized.reject(error);
      throw error;
    }
    dependencies.flush(sink);
    try {
      const failedThread = conversations.failAssistantMessage(sink.threadId, sink.responseMessageId, {
        finishedAt: Date.now(),
        userMessage: 'The host could not finish this turn. You can retry after reconnecting.',
      }, sink.revision);
      sink.revision = failedThread.revision;
      dependencies.threadChanged(failedThread, sink.projectId);
    } catch (persistError) {
      console.error('[remote] could not record turn failure:', persistError);
    }
    dependencies.emit(sink, 'turn.failed', {
      requestId: sink.requestId,
      responseMessageId: sink.responseMessageId,
      code: 'internal',
      userMessage: 'The host could not finish this turn. You can retry after reconnecting.',
      retryable: true,
    });
  } finally {
    if (sink?.flushTimer) clearTimeout(sink.flushTimer);
    if (sink) dependencies.sinks.delete(sink.requestId);
    dependencies.activeTurns.finish(reservation.thread.id, command.payload.requestId);
    dependencies.desktopTurns.finish(command.payload.requestId, failed, Date.now());
  }
}
