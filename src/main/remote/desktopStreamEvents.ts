import { chatMetadata, remoteTool, type ConversationThread, type ConversationToolActivity } from '../conversations';
import type { RemoteLiveTranscript } from './liveTranscript';
import { projectInferenceProgress } from './inferenceProgress';

interface ActiveDesktopTurn {
  threadId: string;
  responseMessageId?: string;
}

export interface DesktopStreamEventDependencies {
  live: RemoteLiveTranscript;
  hasConsumers(): boolean;
  activeTurn(runId: string): ActiveDesktopTurn | null | undefined;
  projectForThread(thread: Pick<ConversationThread, 'id' | 'directory'>): { id: string } | null;
  toolActivity(data: Record<string, unknown>, runId: string): ConversationToolActivity;
  toolEvent(activity: ConversationToolActivity): unknown;
  emit(kind: string, body: unknown, scope: { projectId: string; threadId: string }): void;
}

const CHANNELS = new Set(['chat:stream-data', 'chat:alive', 'chat:waiting', 'chat:context', 'chat:metrics', 'tools:activity', 'tools:approval-request']);

/** Desktop deltas precede durable checkpoints, even when no remote listener is enabled. */
export function relayDesktopStreamEvent(
  channel: string, data: Record<string, unknown>, runId: string, deps: DesktopStreamEventDependencies,
): void {
  if (!CHANNELS.has(channel)) return;
  const inference = channel === 'chat:metrics' ? projectInferenceProgress(data) : null;
  if (channel === 'chat:metrics' && !inference) return;
  if (channel === 'chat:stream-data' && typeof data.content === 'string') deps.live.append(runId, data.content);
  const activity = channel === 'tools:activity' || channel === 'tools:approval-request'
    ? deps.toolActivity(data, runId) : null;
  if (activity) deps.live.tool(runId, remoteTool(activity));

  // Keep the overlay above for a later enable/bootstrap, but do no routing for an empty audience.
  if (!deps.hasConsumers()) return;
  const active = deps.activeTurn(runId);
  if (!active) return;
  // Only identity and directory are needed. Never clone transcripts, tool results or drafts here.
  const thread = chatMetadata().find((candidate) => candidate.id === active.threadId);
  if (!thread) return;
  // Revalidate the current directory rather than caching a project across moves/deletion.
  const project = deps.projectForThread(thread);
  if (!project) return;
  const emit = (kind: string, body: unknown) => deps.emit(kind, body, { projectId: project.id, threadId: thread.id });
  if (channel === 'chat:stream-data' && typeof data.content === 'string') {
    emit('text.delta', { requestId: runId, responseMessageId: active.responseMessageId ?? runId, content: data.content });
  } else if (channel === 'chat:alive') {
    emit('turn.liveness', { requestId: runId, waiting: false });
  } else if (channel === 'chat:waiting' && typeof data.waiting === 'boolean') {
    emit('turn.liveness', { requestId: runId, waiting: data.waiting });
  } else if (inference) {
    emit('context.updated', { requestId: runId, inference });
  } else if (channel === 'chat:context') {
    emit('context.updated', {
      requestId: runId,
      ...(typeof data.estimatedTokens === 'number' ? { inputTokens: data.estimatedTokens } : {}),
      ...(typeof data.contextTokens === 'number' ? { contextLimit: data.contextTokens } : {}),
    });
  } else if (activity) {
    emit(channel === 'tools:approval-request' ? 'approval.requested' : 'tool.changed', { activity: deps.toolEvent(activity) });
  }
}
