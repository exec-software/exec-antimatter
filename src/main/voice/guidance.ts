import type { VoiceGuidance } from '../../api/voice';

/** Spoken utterances append; they must never replace the editable typed-steer slot. */
export class VoiceGuidanceQueue {
  private entries = new Map<string, VoiceGuidance>();
  private pendingIds: string[] = [];
  private taken: string[] = [];
  enqueue(id: unknown, text: unknown, contentOffset: number): VoiceGuidance {
    if (typeof id !== 'string' || !/^[a-zA-Z\d_-]{1,100}$/.test(id) || typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Spoken guidance must contain 1–4,000 characters.');
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.text !== text.trim()) throw new Error('This utterance id already belongs to different speech.');
      return { ...existing };
    }
    if (!Number.isSafeInteger(contentOffset) || contentOffset < 0) throw new Error('Spoken guidance requires a valid transcript position.');
    const outstanding = [...this.taken, ...this.pendingIds];
    if (this.entries.size >= 256 || outstanding.length >= 16 || outstanding.reduce((sum, key) => sum + this.entries.get(key)!.text.length, 0) + text.trim().length > 12_000) throw new Error('The spoken-guidance queue is full. Wait for the agent to take up your last comments.');
    const entry: VoiceGuidance = { id, text: text.trim(), at: Date.now(), contentOffset, status: 'queued' };
    this.entries.set(id, entry); this.pendingIds.push(id);
    return { ...entry };
  }
  pending(): boolean { return this.pendingIds.length > 0; }
  take(): string | null {
    if (!this.pendingIds.length) return null;
    const batch = this.pendingIds;
    this.taken.push(...batch); this.pendingIds = [];
    return batch.map((id) => this.entries.get(id)!.text).join('\n\n');
  }
  delivered(): VoiceGuidance[] {
    const result = this.taken.map((id) => ({ ...this.entries.get(id)!, status: 'delivered' as const }));
    for (const entry of result) this.entries.set(entry.id, { ...entry });
    this.taken = [];
    return result;
  }
  finish(): VoiceGuidance[] {
    const result = [...this.taken, ...this.pendingIds].map((id) => ({ ...this.entries.get(id)!, status: 'undelivered' as const }));
    this.pendingIds = []; this.taken = [];
    for (const entry of result) this.entries.set(entry.id, { ...entry });
    return result;
  }
}
