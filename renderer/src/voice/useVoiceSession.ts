import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { browserVoiceAudio } from './browserAudio';
import { VoiceController } from './controller';
import type { VoiceAdapter, VoiceAudioBackend, VoiceSession } from './types';

export interface VoiceSessionOptions {
  sessionKey: string;
  adapter: VoiceAdapter;
  onTranscript(text: string, utteranceId: string): boolean | Promise<boolean>;
  onRetireTranscript?(text: string): void;
  agentWorking: boolean;
  /** Test seam; no fake browser microphone or cloud recognizer is used in production. */
  audio?: VoiceAudioBackend;
}

export function useVoiceSession(options: VoiceSessionOptions): VoiceSession {
  // Each key owns its callback cell. A late result from a retired thread cannot use a new
  // thread's onTranscript closure, even during the render before effect cleanup happens.
  const owned = useMemo(() => {
    const callbacks = { adapter: options.adapter, onTranscript: options.onTranscript, onRetireTranscript: options.onRetireTranscript };
    const adapter: VoiceAdapter = {
      begin: (signal) => callbacks.adapter.begin?.(signal) ?? Promise.resolve(),
      end: () => callbacks.adapter.end?.(),
      transcribe: (audio, signal) => callbacks.adapter.transcribe(audio, signal),
      ...(options.adapter.beginTranscription ? { beginTranscription: (signal, onEvent) =>
        callbacks.adapter.beginTranscription?.(signal, onEvent) ?? Promise.resolve(null) } : {}),
      synthesize: async (text, signal) => {
        if (!callbacks.adapter.synthesize) throw new Error('Speech output is not configured. Configure a local TTS service to hear responses.');
        return callbacks.adapter.synthesize(text, signal);
      },
      ...(options.adapter.synthesizeStream ? { synthesizeStream: (text: string, signal: AbortSignal) => {
        if (!callbacks.adapter.synthesizeStream) throw new Error('Streaming speech output is unavailable.');
        return callbacks.adapter.synthesizeStream(text, signal);
      } } : {}),
    };
    const controller = new VoiceController({ adapter, audio: options.audio ?? browserVoiceAudio(),
      onTranscript: (text, id) => callbacks.onTranscript(text, id),
      onRetireTranscript: (text) => callbacks.onRetireTranscript?.(text),
    });
    return { callbacks, controller };
  }, [options.sessionKey]);
  owned.callbacks.adapter = options.adapter;
  owned.callbacks.onTranscript = options.onTranscript;
  owned.callbacks.onRetireTranscript = options.onRetireTranscript;
  const voice = owned.controller;
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);

  useEffect(() => { voice.setAgentWorking(options.agentWorking); }, [voice, options.agentWorking]);
  useEffect(() => {
    const stop = () => voice.stop();
    window.addEventListener('pagehide', stop);
    window.addEventListener('beforeunload', stop);
    // Visibility alone is not a stop boundary: a visible desktop avatar can control this
    // explicitly-started session while the main window is in the background.
    return () => { window.removeEventListener('pagehide', stop); window.removeEventListener('beforeunload', stop); voice.retire(); };
  }, [voice]);

  return useMemo(() => ({
    state, start: voice.start, stop: voice.stop, setMuted: voice.setMuted, setMode: voice.setMode,
    beginPushToTalk: voice.beginPushToTalk, endPushToTalk: voice.endPushToTalk, speak: voice.speak,
    interruptPlayback: voice.interruptPlayback, retryFailedUtterance: voice.retryFailedUtterance,
    retryTranscript: voice.retryTranscript, discardTranscript: voice.discardTranscript, clearError: voice.clearError,
  }), [state, voice]);
}
