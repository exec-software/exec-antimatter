import type { ToolActivity, VoiceGuidance } from '../types';
import { buildTranscriptParts, type TranscriptPart } from './transcript';

export interface TranscriptVoicePart {
  kind: 'voice';
  key: string;
  guidance: VoiceGuidance;
  /** Clamped UTF-16 display boundary; guidance retains the authoritative original anchor. */
  offset: number;
}

export type VoiceTranscriptPart = TranscriptPart | TranscriptVoicePart;

const validGuidance = (entry: VoiceGuidance): boolean => Boolean(entry &&
  typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 128 &&
  typeof entry.text === 'string' && entry.text.trim().length > 0 && entry.text.length <= 12_000 &&
  typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at >= 0 &&
  Number.isSafeInteger(entry.contentOffset) && entry.contentOffset >= 0 &&
  (entry.status === 'queued' || entry.status === 'delivered' || entry.status === 'undelivered'));

function normalizeGuidance(source: readonly VoiceGuidance[]): VoiceGuidance[] {
  const entries = new Map<string, VoiceGuidance>();
  for (const entry of source) {
    if (!validGuidance(entry)) continue;
    const previous = entries.get(entry.id);
    if (!previous) {
      if (entries.size < 256) entries.set(entry.id, { ...entry });
      continue;
    }
    // Delivery is authoritative even if a delayed terminal/receipt event arrives afterwards.
    // Preserve the first accepted utterance and anchor rather than trusting a later echo.
    const status = previous.status === 'delivered' || entry.status === 'delivered' ? 'delivered'
      : previous.status === 'undelivered' || entry.status === 'undelivered' ? 'undelivered' : 'queued';
    entries.set(entry.id, { ...previous, status });
  }
  return [...entries.values()];
}

/** An acknowledgement may be repeated or race completion; it must never move or duplicate a row. */
export function mergeVoiceGuidance(existing: readonly VoiceGuidance[], incoming: VoiceGuidance): VoiceGuidance[] {
  return normalizeGuidance([...existing, incoming]);
}

/** After process death we cannot claim a queued utterance reached the model. */
export function settleRestoredVoiceGuidance(existing: readonly VoiceGuidance[]): VoiceGuidance[] {
  return normalizeGuidance(existing).map((entry) => entry.status === 'queued' ? { ...entry, status: 'undelivered' } : entry);
}

/** Pure display copy: playback and task execution have independent lifecycles. */
export function voiceGuidanceStatusLabel(status: VoiceGuidance['status'], isActive: boolean): string {
  if (status === 'delivered') return 'Delivered to agent';
  return status === 'queued' && isActive ? 'Queued for next step' : 'Delivery not confirmed';
}

/**
 * Adds user-spoken guidance inside the owning assistant turn without creating a new message row
 * (streaming still owns the same assistant row). Guidance is plain user text, never Markdown or
 * a tool/approval control. At one boundary the action already under way precedes new guidance.
 */
export function buildVoiceTranscriptParts(
  content: string,
  tools: readonly ToolActivity[] = [],
  guidance: readonly VoiceGuidance[] = [],
): VoiceTranscriptPart[] {
  const base = buildTranscriptParts(content, tools);
  if (!guidance.length) return base;
  const unique = normalizeGuidance(guidance);
  if (!unique.length) return base;
  const events: Array<{ anchor: number; order: number; part: Exclude<VoiceTranscriptPart, { kind: 'text' }> }> = [];
  const legacy: TranscriptPart[] = [];
  for (const part of base) {
    if (part.kind !== 'tools') continue;
    if (part.legacy) { legacy.push(part); continue; }
    const anchor = Math.trunc(part.tools[0].contentOffset!);
    events.push({ anchor, order: -1, part });
  }
  unique.forEach((entry, index) => events.push({
    anchor: entry.contentOffset,
    order: index,
    part: { kind: 'voice', key: `voice:${entry.id}`, guidance: entry, offset: Math.min(content.length, entry.contentOffset) },
  }));
  events.sort((left, right) => left.anchor - right.anchor || left.order - right.order);
  const parts: VoiceTranscriptPart[] = [];
  let cursor = 0;
  for (const event of events) {
    const offset = Math.min(content.length, Math.max(0, event.anchor));
    if (offset > cursor) parts.push({ kind: 'text', key: `text:${cursor}`, text: content.slice(cursor, offset), start: cursor, end: offset });
    parts.push(event.part);
    cursor = offset;
  }
  if (cursor < content.length) parts.push({ kind: 'text', key: `text:${cursor}`, text: content.slice(cursor), start: cursor, end: content.length });
  return [...parts, ...legacy];
}
