import { bytesToBase64, encodeMonoWav, PcmSegmenter, resampleMono, rms } from './pcm';
import type { VoiceAdapter, VoiceAudioBackend, VoiceMode, VoiceState, VoiceMicrophone, VoiceRealtimeTranscription } from './types';
import type { VoiceTranscriptionEvent } from '../../../src/api/voice';
import { StreamingPcmResampler } from './streamingPcm';

interface Options {
  adapter: VoiceAdapter;
  audio: VoiceAudioBackend;
  onTranscript(text: string, utteranceId: string): boolean | Promise<boolean>;
  onRetireTranscript?(text: string): void;
}
interface Session {
  id: number;
  abort: AbortController;
  microphone: VoiceMicrophone | null;
  began: boolean;
  ended: boolean;
  adapter: VoiceAdapter;
  transcription: VoiceRealtimeTranscription | null;
  inputTail: Promise<void>;
  inputBytes: number;
  finalIds: Set<string>;
  resampler: StreamingPcmResampler;
  inputGeneration: number;
  acceptTranscription: boolean;
  utterance: { id: string; parts: Map<string, string>; partial: string; closed: boolean; committed: boolean; timer?: ReturnType<typeof setTimeout> } | null;
}
interface Utterance { id: string; wavBase64: string; sampleRate: 16000 }
const MAX_QUEUE = 3;
const EMPTY_STATE: VoiceState = {
  active: false, phase: 'off', mode: 'auto', muted: false, speaking: false, recording: false,
  agentWorking: false, pendingUtterances: 0, level: 0, levels: Array(24).fill(0), error: null,
  failedUtterance: false, recoveredTranscript: null,
};

export function voiceError(error: unknown): string {
  const named = error as { name?: string; message?: string };
  if (named?.name === 'NotAllowedError' || named?.name === 'PermissionDeniedError') return 'Microphone access was denied. Allow microphone access for Antimatter in system settings, then try Start again.';
  if (named?.name === 'NotFoundError' || named?.name === 'DevicesNotFoundError') return 'No microphone was found. Connect or select a microphone, then try Start again.';
  if (named?.name === 'NotReadableError' || named?.name === 'TrackStartError') return 'The microphone is busy or unavailable. Close other recording apps or check the device, then try again.';
  if (named?.name === 'AbortError') return 'Voice was interrupted. Try again when you are ready.';
  const message = (named?.message || String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  if (/microphone|audio processor/i.test(message)) return message.slice(0, 500);
  if (/offline|network|failed to fetch|ECONN|ENOTFOUND|connect|timed? ?out/i.test(message)) return 'The speech service is unavailable. Check the local service or connection, then retry the saved utterance.';
  return message.slice(0, 500) || 'Voice could not continue. Stop and start again.';
}

/** Owns one explicit, bounded voice session. It never sends chat messages or grants approvals. */
export class VoiceController {
  private state: VoiceState = { ...EMPTY_STATE, levels: [...EMPTY_STATE.levels] };
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  private serial = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private starting = false;
  private queue: Utterance[] = [];
  private failed: Utterance | null = null;
  private processing: Session | null = null;
  private retrying = false;
  private recoveredId: string | null = null;
  private retiredIds = new Set<string>();
  private speech: Array<{ text: string; id: string }> = [];
  private speechIds = new Set<string>();
  private speechAbort: AbortController | null = null;
  private speakingSession: Session | null = null;
  private lastLevelUpdate = -Infinity;
  private bargeFrames: Float32Array[] = [];
  private bargeRate = 0;
  private bargeSamples = 0;
  private bargeVoicedMs = 0;
  private held = false;
  private realtimeAwaiting = false;
  private realtimeDeliveries = 0;
  private activeNarration: string | null = null;
  private interruptedNarration = new Set<string>();
  private segmenter: PcmSegmenter;

  constructor(private readonly options: Options) {
    this.segmenter = new PcmSegmenter({
      onSpeechStart: () => { if (this.session?.transcription) this.startRealtimeUtterance(this.session); this.update({ recording: true }); },
      onSpeechEnd: () => {
        this.update({ recording: false });
        if (this.session?.transcription) this.finishRealtimeUtterance(this.session);
        queueMicrotask(() => { if (this.session) void this.drainSpeech(this.session); });
      },
      onUtterance: (samples, rate) => {
        if (!this.session || !this.state.active || this.state.muted) return;
        if (this.session.transcription) return;
        try {
          const wavBase64 = bytesToBase64(encodeMonoWav(resampleMono(samples, rate)));
          this.queue.push({ id: crypto.randomUUID(), wavBase64, sampleRate: 16000 });
          const pending = this.queue.length + (this.processing === this.session ? 1 : 0);
          this.update({ pendingUtterances: pending });
          if (pending >= MAX_QUEUE) {
            this.setMuted(true);
            this.update({ error: 'The microphone is paused while transcription catches up. Your queued utterances are retained; unmute when ready.' });
          }
          void this.drain(this.session);
        } catch (error) { this.setMuted(true); this.update({ error: voiceError(error) }); }
      },
    });
  }

  getState = (): VoiceState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private current(session: Session): boolean { return this.session === session && !session.abort.signal.aborted; }

  private update(patch: Partial<VoiceState> = {}): void {
    const next = { ...this.state, ...patch };
    next.phase = !next.active ? (next.error ? 'error' : 'off') : this.starting ? 'starting'
      : next.speaking ? 'speaking' : next.failedUtterance || next.recoveredTranscript ? 'error'
        : next.recording ? 'recording' : this.processing === this.session || this.retrying || this.realtimeAwaiting || this.realtimeDeliveries > 0 ? 'transcribing'
          : next.muted ? 'muted' : next.agentWorking ? 'working' : 'listening';
    this.state = next; for (const listener of this.listeners) listener();
  }

  private level(level: number): void {
    const now = performance.now();
    if (now - this.lastLevelUpdate < 100) return;
    this.lastLevelUpdate = now;
    const normalized = Math.max(0, Math.min(1, level * 6));
    this.update({ level: normalized, levels: [...this.state.levels.slice(1), normalized] });
  }

  setAgentWorking(working: boolean): void { this.update({ agentWorking: working }); }

  private retireWords(text: string, id: string): void {
    if (!this.options.onRetireTranscript || this.retiredIds.has(id)) return;
    this.options.onRetireTranscript(text);
    this.retiredIds.add(id);
    if (this.retiredIds.size > 128) this.retiredIds.delete(this.retiredIds.values().next().value!);
  }

  /** Thread/unmount boundary: keep unsent recognized words in the owning thread's draft. */
  retire = (): void => {
    try {
      // A pending retry owns these words until its receipt resolves. Do not also draft
      // a transcript that may already have been accepted by the original thread.
      if (!this.retrying && this.state.recoveredTranscript && this.recoveredId) this.retireWords(this.state.recoveredTranscript, this.recoveredId);
    } finally { this.stop(); }
  };

  start = (): Promise<void> => {
    if (this.state.active) return this.lifecycle;
    if (this.state.recoveredTranscript) {
      this.update({ error: 'Copy or keep the saved transcript as a draft, then dismiss it before starting a new voice session.' });
      return Promise.resolve();
    }
    const session: Session = { id: ++this.serial, abort: new AbortController(), microphone: null, began: false, ended: false, adapter: this.options.adapter,
      transcription: null, inputTail: Promise.resolve(), inputBytes: 0, finalIds: new Set(), resampler: new StreamingPcmResampler(),
      inputGeneration: 0, acceptTranscription: true, utterance: null };
    this.session = session; this.starting = true;
    this.queue = []; this.failed = null; this.segmenter.reset(); this.segmenter.mode = this.state.mode;
    this.speechIds.clear();
    this.interruptedNarration.clear(); this.held = false; this.realtimeAwaiting = false;
    this.update({ active: true, muted: false, error: null, failedUtterance: false, recoveredTranscript: null, pendingUtterances: 0 });
    // Called in the Start handler, before any network/IPC await. This acquires no microphone.
    let unlock: Promise<void>;
    try { unlock = this.options.audio.unlock?.() ?? Promise.resolve(); }
    catch (error) { unlock = Promise.reject(error); }
    // Keep rejection handled while any older session finishes its teardown.
    const unlocked = unlock.then(() => null, (error: unknown) => error);
    this.lifecycle = this.lifecycle.catch(() => undefined).then(async () => {
      if (!this.current(session)) return;
      try {
        const unlockError = await unlocked;
        if (unlockError) throw unlockError;
        if (!this.current(session)) return;
        session.began = true;
        await session.adapter.begin?.(session.abort.signal);
        if (!this.current(session)) return;
        session.transcription = await session.adapter.beginTranscription?.(session.abort.signal, (event) => this.transcriptionEvent(session, event)) ?? null;
        if (!this.current(session)) return;
        const microphone = await this.options.audio.capture((samples, rate) => {
          if (!this.current(session) || this.state.muted) return;
          if (this.state.speaking) {
            if (this.state.mode === 'auto') this.bargeIn(samples, rate);
            return;
          }
          if (session.transcription && (this.state.mode === 'auto' || this.held)) this.appendRealtime(session, samples, rate);
          this.level(this.segmenter.feed(samples, rate));
        }, (error) => {
          if (!this.current(session)) return;
          this.stop(); this.update({ error: voiceError(error) });
        });
        session.microphone = microphone;
        if (!this.current(session)) { microphone.stop(); return; }
        this.starting = false;
        microphone.setMuted(this.state.muted);
        this.update();
      } catch (error) {
        if (this.current(session)) {
          this.session = null; session.abort.abort(); this.starting = false;
          this.update({ active: false, error: voiceError(error), recording: false, level: 0 });
        }
      } finally {
        if (!this.current(session)) await this.closeSession(session);
      }
    });
    return this.lifecycle;
  };

  private async closeSession(session: Session): Promise<void> {
    session.microphone?.stop(); session.microphone = null;
    if (session.ended) return; session.ended = true;
    await session.transcription?.stop().catch(() => undefined);
    if (session.began) { try { await session.adapter.end?.(); } catch { /* Local capture must still close. */ } }
    await this.options.audio.close();
  }

  stop = (): void => {
    const session = this.session; this.session = null; this.starting = false;
    session?.abort.abort(); session?.microphone?.stop();
    if (session?.utterance?.timer) clearTimeout(session.utterance.timer);
    this.interruptPlayback(); this.segmenter.reset(); this.queue = []; this.failed = null;
    this.held = false; this.realtimeAwaiting = false;
    this.update({ active: false, muted: false, recording: false, pendingUtterances: 0, failedUtterance: false, interimTranscript: '', level: 0, levels: Array(24).fill(0) });
    this.lifecycle = this.lifecycle.catch(() => undefined).then(async () => {
      if (session) await this.closeSession(session);
      else if (!this.session) await this.options.audio.close();
    }).catch(() => undefined);
  };

  setMuted = (muted: boolean): void => {
    if (!this.state.active) return;
    if (!muted && (this.state.failedUtterance || this.state.recoveredTranscript)) {
      this.update({ error: 'Retry or dismiss the saved utterance before unmuting.' }); return;
    }
    if (!muted && this.state.pendingUtterances >= MAX_QUEUE) return;
    if (muted !== this.state.muted && muted && this.session?.transcription) this.clearRealtime(this.session);
    this.segmenter.reset(); this.segmenter.mode = this.state.mode;
    this.clearBargeIn();
    this.session?.microphone?.setMuted(muted || (this.state.speaking && this.state.mode === 'push-to-talk'));
    this.update({ muted, recording: false, level: 0, ...(muted ? {} : { error: null }) });
  };

  setMode = (mode: VoiceMode): void => {
    if (mode !== 'auto' && mode !== 'push-to-talk') return;
    if (mode !== this.state.mode && this.session?.transcription) this.clearRealtime(this.session);
    else this.segmenter.finish();
    this.segmenter.reset(); this.segmenter.mode = mode;
    this.update({ mode, recording: false });
    this.clearBargeIn();
    this.session?.microphone?.setMuted(this.state.muted || (this.state.speaking && mode === 'push-to-talk'));
  };

  beginPushToTalk = (): void => {
    if (!this.state.active || this.starting || this.state.failedUtterance || this.state.recoveredTranscript) return;
    this.interruptPlayback();
    if (this.state.muted) this.setMuted(false);
    if (this.state.muted) return;
    const session = this.session;
    if (session?.transcription && !session.utterance) this.clearRealtime(session);
    this.held = true;
    this.segmenter.beginPushToTalk();
  };
  endPushToTalk = (): void => {
    this.held = false; this.segmenter.endPushToTalk();
  };

  private async drain(session: Session): Promise<void> {
    if (this.processing || !this.current(session) || this.failed || this.state.recoveredTranscript) return;
    this.processing = session; this.update();
    try {
      while (this.current(session) && this.queue.length && !this.failed && !this.state.recoveredTranscript) {
        const utterance = this.queue.shift()!;
        this.update({ pendingUtterances: this.queue.length + 1 });
        try {
          const text = (await session.adapter.transcribe({ wavBase64: utterance.wavBase64, sampleRate: utterance.sampleRate }, session.abort.signal)).trim();
          if (!this.current(session)) return;
          if (text.length > 16_000) throw new Error('The speech service returned an oversized transcript. Retry using a shorter utterance.');
          if (text) {
            let accepted = false;
            try { accepted = await this.options.onTranscript(text, utterance.id); }
            catch { /* Keep the recognized words instead of silently losing them. */ }
            if (!this.current(session)) {
              if (!accepted) this.retireWords(text, utterance.id);
              return;
            }
            if (!accepted) {
              this.setMuted(true);
              this.recoveredId = utterance.id;
              this.update({ recoveredTranscript: text, error: 'Your words were transcribed but could not be sent. Retry, copy them, or keep them as a draft.' });
            }
          }
        } catch (error) {
          if (!this.current(session)) return;
          this.failed = utterance; this.setMuted(true);
          this.update({ failedUtterance: true, error: voiceError(error) });
        }
        if (this.current(session)) this.update({ pendingUtterances: this.queue.length + (this.failed ? 1 : 0) });
      }
    } finally {
      if (this.processing === session) this.processing = null;
      const active = this.session;
      if (active && this.current(active)) {
        this.update();
        if (this.queue.length && !this.failed && !this.state.recoveredTranscript) void this.drain(active);
        else void this.drainSpeech(active);
      }
    }
  }

  retryFailedUtterance = (): void => {
    if (!this.session || !this.failed || this.processing === this.session) return;
    this.queue.unshift(this.failed); this.failed = null;
    this.update({ failedUtterance: false, error: null }); void this.drain(this.session);
  };

  retryTranscript = async (): Promise<void> => {
    const text = this.state.recoveredTranscript;
    const id = this.recoveredId;
    const session = this.session;
    if (!text || !id || !session || this.retrying) return;
    this.retrying = true; this.update({ error: null });
    try {
      if (await this.options.onTranscript(text, id)) {
        if (this.recoveredId === id) { this.recoveredId = null; this.update({ recoveredTranscript: null }); }
      } else if (this.current(session)) this.update({ error: 'The transcript still could not be sent. It is retained below.' });
      else this.retireWords(text, id);
    } catch (error) {
      if (this.current(session)) this.update({ error: voiceError(error) });
      else this.retireWords(text, id);
    }
    finally { this.retrying = false; if (this.current(session)) { this.update(); void this.drain(session); } }
  };

  discardTranscript = (): void => {
    this.recoveredId = null;
    this.update({ recoveredTranscript: null, error: null });
    if (this.session) void this.drain(this.session);
  };
  clearError = (): void => { this.update({ error: null }); };

  speak = (value: string, id?: string): void => {
    const session = this.session;
    const text = value.trim();
    if (!session || !this.current(session) || !text || this.starting) return;
    if (!session.adapter.synthesize && !session.adapter.synthesizeStream) { this.update({ error: 'Speech output is not configured. You can still speak and read the response in chat.' }); return; }
    if (text.length > 2000) { this.update({ error: 'This spoken response is too long. Read the full response in chat.' }); return; }
    const key = id ?? `speech-${++this.serial}`;
    if (key.includes(':voice:') && this.interruptedNarration.has(key.split(':voice:')[0])) return;
    if (this.speechIds.has(key)) return;
    if (this.speech.length >= 32 || this.speech.reduce((count, item) => count + item.text.length, 0) + text.length > 8000) {
      this.update({ error: 'Voice narration is behind. Additional speech was skipped; all responses remain in chat.' }); return;
    }
    this.speechIds.add(key);
    if (this.speechIds.size > 128) this.speechIds.delete(this.speechIds.values().next().value!);
    this.speech.push({ text, id: key }); void this.drainSpeech(session);
  };

  private async drainSpeech(session: Session): Promise<void> {
    if (this.speakingSession || !this.current(session) || this.processing === session || this.realtimeAwaiting || this.realtimeDeliveries > 0 || this.state.recording || this.state.failedUtterance || this.state.recoveredTranscript) return;
    this.speakingSession = session;
    try {
      while (this.current(session) && this.speech.length && !this.state.recording && this.processing !== session) {
        const abort = new AbortController(); this.speechAbort = abort;
        const cancel = () => abort.abort(); session.abort.signal.addEventListener('abort', cancel, { once: true });
        // Auto mode keeps echo-cancelled capture available for confirmed user speech. Hold to
        // talk remains half-duplex and opens capture only through the explicit gesture.
        this.segmenter.reset(); this.segmenter.mode = this.state.mode;
        this.clearBargeIn();
        session.microphone?.setMuted(this.state.muted || this.state.mode === 'push-to-talk');
        this.update({ speaking: true, recording: false });
        try {
          const level = (value: number) => { if (this.current(session) && !abort.signal.aborted) this.level(value); };
          if (session.adapter.synthesizeStream && this.options.audio.playStream) {
            const controller = this;
            const chunks = async function* () {
              while (controller.current(session) && !abort.signal.aborted && controller.speech.length) {
                const item = controller.speech.shift()!;
                controller.activeNarration = item.id.includes(':voice:') ? item.id.split(':voice:')[0] : null;
                // One PCM timeline spans consecutive sentences. The next synthesis starts
                // while the browser plays its bounded lookahead from the previous sentence.
                yield* session.adapter.synthesizeStream!(item.text, abort.signal);
              }
            };
            await this.options.audio.playStream(chunks(), abort.signal, level);
          } else {
            const item = this.speech.shift()!;
            this.activeNarration = item.id.includes(':voice:') ? item.id.split(':voice:')[0] : null;
            const audio = await session.adapter.synthesize!(item.text, abort.signal);
            if (this.current(session) && !abort.signal.aborted) await this.options.audio.play(audio, abort.signal, level);
          }
        } catch (error) {
          if (this.current(session) && !abort.signal.aborted) this.update({ error: `Speech playback failed. ${voiceError(error)} The response is still in chat.` });
        } finally {
          session.abort.signal.removeEventListener('abort', cancel);
          if (this.speechAbort === abort) this.speechAbort = null;
          if (this.current(session)) { session.microphone?.setMuted(this.state.muted); this.update({ speaking: false, level: 0 }); }
        }
      }
    } finally {
      if (this.speakingSession === session) this.speakingSession = null;
      this.activeNarration = null;
      if (this.session && this.session !== session) void this.drainSpeech(this.session);
    }
  }

  interruptPlayback = (): void => {
    if (this.activeNarration) this.interruptedNarration.add(this.activeNarration);
    for (const item of this.speech) if (item.id.includes(':voice:')) this.interruptedNarration.add(item.id.split(':voice:')[0]);
    while (this.interruptedNarration.size > 32) this.interruptedNarration.delete(this.interruptedNarration.values().next().value!);
    this.speech = []; this.speechAbort?.abort(); this.options.audio.stopPlayback();
    this.clearBargeIn();
    this.session?.microphone?.setMuted(this.state.muted);
    this.update({ speaking: false, level: 0 });
  };

  private clearBargeIn(): void {
    this.bargeFrames = []; this.bargeSamples = 0; this.bargeRate = 0; this.bargeVoicedMs = 0;
  }

  private bargeIn(samples: Float32Array, rate: number): void {
    if (!samples.length || samples.length > rate / 2 || !Number.isFinite(rate) || rate < 8000 || rate > 192000) return;
    if (this.bargeRate && this.bargeRate !== rate) this.clearBargeIn();
    this.bargeRate = rate;
    // Browser acoustic echo cancellation runs before these samples. Require a stronger,
    // sustained onset than normal VAD so a click or low residual speaker bleed cannot barge in.
    this.bargeFrames.push(samples.slice()); this.bargeSamples += samples.length;
    while (this.bargeFrames.length > 1 && this.bargeSamples > rate * 0.4) this.bargeSamples -= this.bargeFrames.shift()!.length;
    this.bargeVoicedMs = rms(samples) >= 0.035 ? this.bargeVoicedMs + samples.length * 1000 / rate : 0;
    if (this.bargeVoicedMs < 280) return;
    const onset = this.bargeFrames;
    this.interruptPlayback();
    // Preserve the confirmed onset and its pre-roll. Starting a new recorder here would cut
    // the first word off precisely when the user is trying to interrupt.
    for (const frame of onset) {
      if (this.session?.transcription) this.appendRealtime(this.session, frame, rate);
      this.level(this.segmenter.feed(frame, rate));
    }
  }

  private queueRealtime(session: Session, operation: () => Promise<void>): void {
    session.inputTail = session.inputTail.then(async () => { if (this.current(session)) await operation(); }).catch((error) => {
      if (this.current(session)) {
        const utterance = session.utterance;
        const recognized = utterance ? [...utterance.parts.values(), utterance.partial].filter(Boolean).join(' ').trim() : '';
        this.realtimeAwaiting = false; this.setMuted(true);
        if (recognized && utterance) {
          this.recoveredId = utterance.id;
          this.update({ recoveredTranscript: recognized, error: `${voiceError(error)} Review the saved words before retrying or keeping them as a draft.` });
        } else this.update({ error: voiceError(error) });
      }
    });
  }

  private appendRealtime(session: Session, samples: Float32Array, rate: number): void {
    try {
      const pcm = encodeMonoWav(session.resampler.push(samples, rate)).subarray(44);
      if (!pcm.length) return;
      if (session.inputBytes + pcm.length > 256 * 1024) {
        this.setMuted(true); this.update({ error: 'Live transcription is behind. The microphone is paused; stop and restart voice when the service is ready.' }); return;
      }
      session.inputBytes += pcm.length;
      const generation = session.inputGeneration;
      this.queueRealtime(session, async () => {
        try { if (generation === session.inputGeneration) await session.transcription!.append(bytesToBase64(pcm)); }
        finally { session.inputBytes -= pcm.length; }
      });
    } catch (error) { this.setMuted(true); this.update({ error: voiceError(error) }); }
  }

  private transcriptionEvent(session: Session, event: VoiceTranscriptionEvent): void {
    if (!this.current(session)) return;
    if (event.type === 'error') { this.realtimeAwaiting = false; this.setMuted(true); this.update({ error: event.message || 'Live transcription failed. Stop and restart voice to reconnect.' }); return; }
    const utterance = session.utterance;
    // The local recorder owns utterance boundaries. Native ASR can end several lines during
    // one spoken sentence; those are caption segments, not separate messages to the agent.
    if (!utterance || !session.acceptTranscription || this.state.muted) return;
    if (event.type === 'partial') {
      utterance.partial = (event.text ?? '').slice(0, 16_000);
    } else if (event.type === 'final' && event.itemId) {
      if (session.finalIds.has(event.itemId)) return;
      session.finalIds.add(event.itemId);
      if (session.finalIds.size > 128) session.finalIds.delete(session.finalIds.values().next().value!);
      if (event.text?.trim()) utterance.parts.set(event.itemId, event.text.trim());
      utterance.partial = '';
    } else return;
    const caption = [...utterance.parts.values(), utterance.partial].filter(Boolean).join(' ');
    if (caption.length > 16_000) {
      this.setMuted(true); this.update({ error: 'Live transcription returned too much text. Use a shorter utterance.' }); return;
    }
    this.update({ interimTranscript: caption });
    this.scheduleRealtimeDelivery(session);
  }

  private clearRealtime(session: Session): void {
    if (session.utterance?.timer) clearTimeout(session.utterance.timer);
    session.utterance = null; session.resampler.reset(); this.realtimeAwaiting = false;
    session.acceptTranscription = false;
    const generation = ++session.inputGeneration;
    this.update({ interimTranscript: '', recording: false });
    this.queueRealtime(session, async () => {
      await session.transcription!.clear();
      if (this.current(session) && generation === session.inputGeneration) session.acceptTranscription = true;
    });
  }

  private startRealtimeUtterance(session: Session): void {
    session.utterance ??= { id: crypto.randomUUID(), parts: new Map(), partial: '', closed: false, committed: false };
    if (session.utterance.timer) clearTimeout(session.utterance.timer);
    session.utterance.closed = false; session.utterance.committed = false;
    this.realtimeAwaiting = true;
  }

  private finishRealtimeUtterance(session: Session): void {
    const utterance = session.utterance;
    if (!utterance || utterance.closed) return;
    utterance.closed = true;
    this.queueRealtime(session, async () => {
      if (session.utterance !== utterance || !utterance.closed) return;
      await session.transcription!.commit();
      if (session.utterance !== utterance || !utterance.closed) return;
      utterance.committed = true; this.scheduleRealtimeDelivery(session);
    });
  }

  private scheduleRealtimeDelivery(session: Session): void {
    const utterance = session.utterance;
    if (!utterance?.closed || !utterance.committed) return;
    if (utterance.timer) clearTimeout(utterance.timer);
    // A commit receipt can precede the final caption event. A known partial tail must finish,
    // even on a busy CPU; never silently discard it or submit speculative partial words.
    utterance.timer = setTimeout(() => {
      if (!this.current(session) || session.utterance !== utterance || !utterance.closed) return;
      if (utterance.partial.trim()) {
        const recover = [...utterance.parts.values(), utterance.partial].filter(Boolean).join(' ');
        this.setMuted(true); this.recoveredId = utterance.id;
        this.update({ recoveredTranscript: recover, error: 'Live transcription did not finalize. Review the saved words, then retry or keep them as a draft.' });
        return;
      }
      session.utterance = null; this.realtimeAwaiting = false;
      this.update({ interimTranscript: '', recording: false });
      const text = [...utterance.parts.values()].join(' ').trim();
      if (!text) { void this.drainSpeech(session); return; }
      void this.deliverRealtime(session, text, utterance.id);
    }, utterance.partial.trim() ? 10_000 : 180);
  }

  private async deliverRealtime(session: Session, text: string, utteranceId: string): Promise<void> {
    this.realtimeDeliveries += 1; this.update();
    try {
      let accepted = false;
      try { accepted = await this.options.onTranscript(text, utteranceId); } catch { /* Preserve unsent recognized words. */ }
      if (!this.current(session)) { if (!accepted) this.retireWords(text, utteranceId); return; }
      if (!accepted) {
        this.setMuted(true); this.recoveredId = utteranceId;
        this.update({ recoveredTranscript: text, error: 'Your words were transcribed but could not be sent. Retry, copy them, or keep them as a draft.' });
      }
    } finally {
      this.realtimeDeliveries -= 1;
      if (this.current(session)) { this.update(); void this.drainSpeech(session); }
    }
  }
}
