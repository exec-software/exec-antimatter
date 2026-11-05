import { randomUUID } from 'node:crypto';
import type { VoicePhase, VoiceSettings, VoiceState } from '../../api/voice';

const IDLE: VoiceState = { active: false, sessionId: null, threadId: null, phase: 'idle', muted: false, speaking: false, error: null };
const PHASES: VoicePhase[] = ['idle', 'starting', 'listening', 'recording', 'transcribing', 'speaking', 'muted', 'error'];

/** One mic owner, one conversation, and bounded cancellable backend requests. Never persisted. */
export class VoiceSession {
  private state: VoiceState = { ...IDLE };
  private settings: VoiceSettings | null = null;
  private requests = new Map<string, { kind: 'input' | 'speech'; controller: AbortController }>();
  constructor(private readonly changed: (state: VoiceState) => void = () => {}) {}
  snapshot(): VoiceState { return { ...this.state }; }
  private emit() { this.changed(this.snapshot()); }
  begin(threadId: string, settings: VoiceSettings): VoiceState {
    if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 200) throw new Error('Choose a conversation before starting voice.');
    this.end();
    this.settings = { ...settings };
    this.state = { ...IDLE, active: true, sessionId: randomUUID(), threadId, phase: 'starting' };
    this.emit();
    return this.snapshot();
  }
  assert(id: unknown): VoiceSettings {
    if (!this.state.active || id !== this.state.sessionId || !this.settings) throw new Error('This voice session has ended. Start voice again.');
    return { ...this.settings };
  }
  end(id?: unknown): void {
    // A late stop from an old recorder must never end a replacement session.
    if (id !== undefined && id !== this.state.sessionId) return;
    for (const { controller } of this.requests.values()) controller.abort();
    this.requests.clear(); this.settings = null; this.state = { ...IDLE }; this.emit();
  }
  update(id: unknown, patch: { phase?: VoicePhase; muted?: boolean; speaking?: boolean; error?: string | null }): void {
    this.assert(id);
    if (!patch || typeof patch !== 'object') throw new Error('Invalid voice status.');
    if (patch.phase && PHASES.includes(patch.phase)) this.state.phase = patch.phase;
    if (typeof patch.muted === 'boolean') this.state.muted = patch.muted;
    if (typeof patch.speaking === 'boolean') this.state.speaking = patch.speaking;
    if (patch.error === null || typeof patch.error === 'string') this.state.error = patch.error?.slice(0, 240) ?? null;
    this.emit();
  }
  cancel(id: unknown, requestId: unknown): void {
    if (id !== this.state.sessionId || typeof requestId !== 'string') return;
    this.requests.get(requestId)?.controller.abort();
  }
  async request<T>(id: unknown, requestId: string, kind: 'input' | 'speech', work: (settings: VoiceSettings, signal: AbortSignal) => Promise<T>): Promise<T> {
    const settings = this.assert(id);
    if (typeof requestId !== 'string' || !requestId || requestId.length > 100 || this.requests.has(requestId)) throw new Error('Invalid or duplicate voice request.');
    if ([...this.requests.values()].some((entry) => entry.kind === kind)) throw new Error(`A voice ${kind} request is already in progress.`);
    const controller = new AbortController();
    const request = { kind, controller };
    this.requests.set(requestId, request);
    try {
      const result = await work(settings, controller.signal);
      if (controller.signal.aborted || id !== this.state.sessionId) throw new Error('Voice request cancelled.');
      return result;
    } finally { if (this.requests.get(requestId) === request) this.requests.delete(requestId); }
  }
}
