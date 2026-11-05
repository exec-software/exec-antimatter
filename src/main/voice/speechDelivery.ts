import type { VoicePcmChunk, VoiceSpeechEvent } from '../../api/voice';

/** One in-flight chunk per speech request, released only by its owning renderer. */
export class VoiceSpeechDelivery {
  private sequence = 0;
  private pending: { sequence: number; done(error?: Error): void } | null = null;
  constructor(readonly sessionId: string, readonly requestId: string, readonly senderId: number,
    private readonly signal: AbortSignal, private readonly emit: (event: VoiceSpeechEvent) => void,
    private readonly timeoutMs = 30_000) {}
  async send(chunk: VoicePcmChunk): Promise<void> {
    if (this.signal.aborted) throw new Error('Voice request cancelled.');
    if (this.pending) throw new Error('A speech chunk is already in flight.');
    const sequence = this.sequence++;
    await new Promise<void>((resolve, reject) => {
      const abort = () => done(new Error('Voice request cancelled.'));
      const timer = setTimeout(() => done(new Error('Speech playback stopped responding.')), this.timeoutMs);
      const done = (error?: Error) => {
        clearTimeout(timer); this.signal.removeEventListener('abort', abort); this.pending = null;
        if (error) reject(error); else resolve();
      };
      this.pending = { sequence, done };
      this.signal.addEventListener('abort', abort, { once: true });
      try { this.emit({ sessionId: this.sessionId, requestId: this.requestId, sequence, chunk }); }
      catch { done(new Error('Speech playback is unavailable.')); }
    });
  }
  acknowledge(sessionId: unknown, requestId: unknown, senderId: number, sequence: unknown): void {
    if (sessionId !== this.sessionId || requestId !== this.requestId || senderId !== this.senderId || sequence !== this.pending?.sequence) return;
    this.pending?.done();
  }
}
