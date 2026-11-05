import type { RemoteMessageProjection, RemoteThreadProjection, RemoteToolProjection } from '../conversations';
import { RemoteProtocolError } from './protocol';

interface LiveReply {
  threadId: string;
  message: RemoteMessageProjection;
  finished: boolean;
}

/**
 * Desktop IPC events precede the renderer's durable checkpoint. A bootstrap at the current
 * event cursor must include that already-emitted text and activity. Store absolute per-run
 * content, never splice by matching suffixes (repeated tokens are legitimate output).
 * Only remote-safe projections enter this cache; it never stores raw tool args/results.
 */
export class RemoteLiveTranscript {
  private readonly replies = new Map<string, LiveReply>();

  begin(runId: string, threadId: string, message: Pick<RemoteMessageProjection, 'id' | 'createdAt' | 'modelId' | 'sourceName'>): void {
    this.replies.set(runId, {
      threadId,
      message: { ...message, role: 'assistant', content: '', failed: false, attachments: [], tools: [] },
      finished: false,
    });
  }

  append(runId: string, content: string): void {
    const reply = this.replies.get(runId);
    if (reply && !reply.finished) reply.message.content += content;
  }

  tool(runId: string, activity: RemoteToolProjection): void {
    const reply = this.replies.get(runId);
    if (!reply || reply.finished) return;
    const key = (tool: RemoteToolProjection) => tool.activityId ? `activity:${tool.activityId}` : `call:${tool.callId}`;
    const index = reply.message.tools.findIndex((tool) => key(tool) === key(activity));
    if (index < 0) reply.message.tools.push(structuredClone(activity));
    else reply.message.tools[index] = { ...reply.message.tools[index], ...structuredClone(activity) };
  }

  finish(runId: string, failed: boolean, at: number): void {
    const reply = this.replies.get(runId);
    if (!reply) return;
    reply.finished = true;
    reply.message.finishedAt = at;
    reply.message.failed = failed;
  }

  project(thread: RemoteThreadProjection): RemoteThreadProjection {
    const messages = [...thread.messages];
    for (const [runId, reply] of this.replies) {
      if (reply.threadId !== thread.id) continue;
      const index = messages.findIndex((message) => message.id === reply.message.id);
      const stored = messages[index];
      // The renderer appends its error explanation after all emitted text. A final checkpoint
      // containing the complete emitted prefix supersedes the cache, including that explanation.
      if (reply.finished && stored?.finishedAt !== undefined && stored.content.startsWith(reply.message.content)) {
        this.replies.delete(runId);
        continue;
      }
      const tools = [...(stored?.tools ?? [])];
      for (const activity of reply.message.tools) {
        const position = tools.findIndex((tool) => activity.activityId
          ? tool.activityId === activity.activityId : !tool.activityId && tool.callId === activity.callId);
        if (position < 0) tools.push(activity);
        else tools[position] = activity;
      }
      const message = { ...reply.message, ...stored, content: reply.message.content, tools,
        ...(reply.finished ? { finishedAt: reply.message.finishedAt, failed: reply.message.failed } : {}) };
      if (index < 0) messages.push(message);
      else messages[index] = message;
    }
    return { ...thread, messages: structuredClone(messages) };
  }

  retainThreads(ids: ReadonlySet<string>): void {
    for (const [runId, reply] of this.replies) if (!ids.has(reply.threadId)) this.replies.delete(runId);
  }

  checkpoint(threadId: string, messages: readonly Pick<RemoteMessageProjection, 'id' | 'content' | 'finishedAt'>[]): void {
    for (const [runId, reply] of this.replies) {
      if (reply.threadId !== threadId || !reply.finished) continue;
      const stored = messages.find((message) => message.id === reply.message.id);
      if (stored?.finishedAt !== undefined && stored.content.startsWith(reply.message.content)) this.replies.delete(runId);
    }
  }
}

/** Flush batching before claiming a snapshot covers the journal cursor; fail closed on disk errors. */
export function flushSnapshotDeltas<T extends { threadId: string; persistenceError: Error | null }>(
  sinks: Iterable<T>, flush: (sink: T) => void, threadId?: string,
): void {
  for (const sink of sinks) {
    if (threadId !== undefined && sink.threadId !== threadId) continue;
    flush(sink);
    if (sink.persistenceError) throw new RemoteProtocolError(
      'SNAPSHOT_UNAVAILABLE', 'Conversation storage is unavailable. Reconnect to retry synchronization.', 503, true,
    );
  }
}
