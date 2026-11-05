import type { VoiceAdapter, VoicePcmChunk } from '../voice/types';

type VoiceBridge = Window['electronAPI']['voice'];

/** Main owns credentials and authorization; this adapter owns one explicitly started mic. */
export function createVoiceAdapter(threadId: string, api: VoiceBridge): VoiceAdapter & { sessionId(): string | null } {
  let id: string | null = null;
  let generation = 0;
  const activeTranscriptions = new Set<() => Promise<void>>();
  const request = async <T>(signal: AbortSignal, work: (session: string, request: string) => Promise<T>): Promise<T> => {
    const session = id;
    if (!session || signal.aborted) throw new Error('Voice session ended.');
    const requestId = crypto.randomUUID();
    const cancel = () => { void api.cancel(session, requestId).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await work(session, requestId);
      if (signal.aborted || session !== id) throw new Error('Voice request cancelled.');
      return result;
    } finally { signal.removeEventListener('abort', cancel); }
  };
  return {
    sessionId: () => id,
    async begin(signal) {
      const version = ++generation;
      const state = await api.begin(threadId);
      if (signal.aborted || version !== generation) {
        if (state.sessionId) await api.end(state.sessionId);
        throw new Error('Voice start cancelled.');
      }
      id = state.sessionId;
      if (!id) throw new Error('Voice session could not start.');
    },
    async end() {
      ++generation;
      const previous = id;
      id = null;
      await Promise.all([...activeTranscriptions].map((stop) => stop()));
      if (previous) await api.end(previous);
    },
    transcribe: (audio, signal) => request(signal, (session, requestId) => api.transcribe(session, requestId, audio)),
    synthesize: (text, signal) => request(signal, (session, requestId) => api.synthesize(session, requestId, text)),
    ...(typeof api.beginTranscription === 'function' && typeof api.onTranscription === 'function' ? {
      async beginTranscription(signal, onEvent) {
        const session = id;
        if (!session || signal.aborted) throw new Error('Voice session ended.');
        const requestId = crypto.randomUUID();
        let stopped = false;
        const off = api.onTranscription((event) => {
          if (!stopped && !signal.aborted && id === session && event.sessionId === session && event.requestId === requestId) onEvent(event);
        });
        const stop = async () => {
          if (stopped) return;
          stopped = true; off(); signal.removeEventListener('abort', abort);
          activeTranscriptions.delete(stop);
          await api.cancel(session, requestId).catch(() => {});
        };
        const abort = () => { void stop(); };
        signal.addEventListener('abort', abort, { once: true });
        activeTranscriptions.add(stop);
        try {
          const result = await api.beginTranscription(session, requestId);
          if (signal.aborted || stopped || id !== session) throw new Error('Voice transcription cancelled.');
          if (!result.active) { await stop(); return null; }
          const check = () => { if (stopped || signal.aborted || id !== session) throw new Error('Voice transcription cancelled.'); };
          return {
            append: async (pcmBase64: string) => { check(); await api.appendTranscription(session, requestId, pcmBase64); },
            commit: async () => { check(); await api.commitTranscription(session, requestId); },
            clear: async () => { check(); await api.clearTranscription(session, requestId); },
            stop,
          };
        } catch (error) { await stop(); throw error; }
      },
    } : {}),
    ...(typeof api.synthesizeStream === 'function' && typeof api.onSpeechChunk === 'function' && typeof api.acknowledgeSpeechChunk === 'function' ? {
      async *synthesizeStream(text: string, signal: AbortSignal): AsyncGenerator<VoicePcmChunk> {
        const session = id;
        if (!session || signal.aborted) throw new Error('Voice session ended.');
        const requestId = crypto.randomUUID();
        const queue: Array<{ sequence: number; chunk: VoicePcmChunk }> = [];
        let sequence = 0;
        let done = false;
        let failure: unknown;
        let wake: (() => void) | undefined;
        let cancelled = false;
        const cancel = () => {
          if (!cancelled) { cancelled = true; void api.cancel(session, requestId).catch(() => {}); }
          wake?.();
        };
        signal.addEventListener('abort', cancel, { once: true });
        const off = api.onSpeechChunk((event) => {
          if (event.sessionId !== session || event.requestId !== requestId || cancelled || done) return;
          const chunk = event.chunk;
          if (event.sequence !== sequence || queue.length >= 2 || !chunk || chunk.format !== 'pcm16le' ||
              chunk.channels !== 1 || !Number.isInteger(chunk.sampleRate) || chunk.sampleRate < 8000 || chunk.sampleRate > 48000 ||
              typeof chunk.audioBase64 !== 'string' || !chunk.audioBase64.length || chunk.audioBase64.length > 21848 ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.audioBase64)) {
            failure = new Error('The speech stream returned invalid or out-of-order audio.'); cancel(); return;
          }
          sequence += 1; queue.push({ sequence: event.sequence, chunk }); wake?.();
        });
        // Subscribe first: a fast local service may publish audio before invoke resolves.
        const completion = api.synthesizeStream(session, requestId, text).then(
          () => { done = true; wake?.(); },
          (error: unknown) => { failure = error; done = true; wake?.(); },
        );
        try {
          while (true) {
            if (failure) throw failure;
            if (signal.aborted || cancelled || session !== id) throw new Error('Voice request cancelled.');
            const next = queue.shift();
            if (next) {
              yield next.chunk;
              if (signal.aborted || session !== id) throw new Error('Voice request cancelled.');
              // The browser resumes this generator only after its playback lookahead is bounded.
              await api.acknowledgeSpeechChunk(session, requestId, next.sequence);
            } else if (done) break;
            else await new Promise<void>((resolve) => { wake = resolve; });
          }
          await completion;
        } finally {
          off(); signal.removeEventListener('abort', cancel); wake = undefined;
          if (!done || signal.aborted) cancel();
          queue.length = 0;
        }
      },
    } : {}),
  };
}
