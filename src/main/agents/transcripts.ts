import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as carbon from '../carbon';
import { writePrivateFileAtomic } from '../privateState';
import type { ToolActivity } from '../toolLoop';

/** A replayable transcript, independent of whether a renderer was watching the run. */
export interface AgentTranscript {
  sessionId: string;
  revision: number;
  content: string;
  tools: ToolActivity[];
}

const live = new Map<string, AgentTranscript>();
const pathFor = (sessionId: string) =>
  join(carbon.location(), `.agent-run-${createHash('sha256').update(sessionId).digest('hex')}.json`);

export function begin(taskId: string, sessionId: string): void {
  live.set(taskId, { sessionId, revision: 0, content: '', tools: [] });
}

export function append(taskId: string, chunk: string): AgentTranscript {
  const transcript = live.get(taskId)!;
  transcript.content += chunk;
  transcript.revision += 1;
  return transcript;
}

export function activity(taskId: string, event: ToolActivity): AgentTranscript {
  const transcript = live.get(taskId)!;
  const key = event.activityId ?? event.callId;
  const index = transcript.tools.findIndex((tool) => (tool.activityId ?? tool.callId) === key);
  if (index < 0) transcript.tools.push(event);
  else transcript.tools[index] = { ...transcript.tools[index], ...event };
  transcript.revision += 1;
  return transcript;
}

export function persist(taskId: string): void {
  const transcript = live.get(taskId);
  if (!transcript) return;
  try {
    writePrivateFileAtomic(pathFor(transcript.sessionId), JSON.stringify(transcript));
  } catch (error) {
    // Transcript storage must not prevent cancellation or tool-runtime cleanup.
    console.error('[agents] could not save the structured transcript:', error);
  }
}

export function read(taskId: string, sessionId: string | null): AgentTranscript | null {
  if (!sessionId) return null;
  const current = live.get(taskId);
  if (current?.sessionId === sessionId) return structuredClone(current);
  const path = pathFor(sessionId);
  if (!existsSync(path)) return null;
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as AgentTranscript;
    if (saved.sessionId !== sessionId || typeof saved.content !== 'string' || !Array.isArray(saved.tools) ||
        !Number.isSafeInteger(saved.revision) || saved.revision < 0) return null;
    return saved;
  } catch {
    return null;
  }
}

/** Finished records remain on disk; keep only the queue's bounded visible history in memory. */
export function retain(taskIds: ReadonlySet<string>): void {
  for (const taskId of live.keys()) if (!taskIds.has(taskId)) live.delete(taskId);
}
