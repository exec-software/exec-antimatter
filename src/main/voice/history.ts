import { createHash } from 'node:crypto';
import type { Message } from '../../api/types';
import type { VoiceGuidance } from '../../api/voice';

export const MAX_VOICE_HISTORY_NOTES = 256;
export const MAX_VOICE_HISTORY_CHARACTERS = 64_000;

function valid(value: unknown, contentLength: number): value is VoiceGuidance {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<VoiceGuidance>;
  return typeof entry.id === 'string' && /^[a-zA-Z\d_-]{1,100}$/.test(entry.id) &&
    typeof entry.text === 'string' && !!entry.text.trim() && entry.text.length <= 4000 && entry.status === 'delivered' &&
    typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at >= 0 &&
    Number.isSafeInteger(entry.contentOffset) && entry.contentOffset! >= 0 && entry.contentOffset! <= contentLength;
}

const noteId = (messageId: string, utteranceId: string) =>
  `voice-history:${createHash('sha256').update(JSON.stringify([messageId, utteranceId])).digest('hex').slice(0, 32)}`;
const partId = (messageId: string, offset: number) =>
  `voice-part:${createHash('sha256').update(JSON.stringify([messageId, offset])).digest('hex').slice(0, 32)}`;

/**
 * Visible-history fallback only: the expanded transcript already contains delivered guidance.
 * Reconstruct human/assistant chronology without enqueueing a new turn or granting permissions.
 * Use request content verbatim (including inlined attachments), not stale persisted answer text.
 */
export function restoreDeliveredVoiceHistory(
  messages: readonly Message[],
  guidanceByMessage: ReadonlyMap<string, readonly unknown[]>,
): Message[] {
  const selected = new Map<number, VoiceGuidance[]>();
  const existingIds = new Set(messages.map((message) => message.id));
  const seen = new Set<string>();
  let count = 0; let characters = 0;
  // Retain the newest bounded guidance when an unusually long conversation exceeds the budget.
  for (let index = messages.length - 1; index >= 0 && count < MAX_VOICE_HISTORY_NOTES; index--) {
    const message = messages[index];
    if (message.role !== 'assistant' || message.toolCalls?.length || typeof message.content !== 'string') continue;
    const raw = guidanceByMessage.get(message.id);
    if (!Array.isArray(raw)) continue;
    const unique = new Map<string, VoiceGuidance>();
    for (const entry of raw.slice(0, 256)) if (valid(entry, message.content.length) && !unique.has(entry.id)) unique.set(entry.id, entry);
    const entries = [...unique.values()].sort((left, right) => left.contentOffset - right.contentOffset);
    const keep: VoiceGuidance[] = [];
    for (let cursor = entries.length - 1; cursor >= 0 && count < MAX_VOICE_HISTORY_NOTES; cursor--) {
      const entry = entries[cursor];
      if (seen.has(entry.id) || existingIds.has(noteId(message.id, entry.id))) continue;
      seen.add(entry.id);
      if (characters + entry.text.length > MAX_VOICE_HISTORY_CHARACTERS) continue;
      characters += entry.text.length; count++; keep.unshift(entry);
    }
    if (keep.length) selected.set(index, keep);
  }
  const result: Message[] = [];
  messages.forEach((message, index) => {
    const guidance = selected.get(index);
    if (!guidance) { result.push(message); return; }
    let offset = 0; let keptOriginalId = false;
    const assistantPart = (end: number) => {
      if (end <= offset) return;
      const content = message.content.slice(offset, end);
      // One segment retains the visible alias so the next expanded checkpoint can resume it.
      result.push({ ...message, id: keptOriginalId ? partId(message.id, offset) : message.id, content });
      keptOriginalId = true; offset = end;
    };
    for (const entry of guidance) {
      assistantPart(entry.contentOffset);
      result.push({ id: noteId(message.id, entry.id), role: 'user', content: entry.text });
    }
    assistantPart(message.content.length);
    // Preserve a genuinely empty visible assistant row, rather than losing its identity.
    if (!keptOriginalId) result.push(message);
  });
  return result;
}
