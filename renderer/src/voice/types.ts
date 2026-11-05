import type { VoicePcmChunk, VoiceTranscriptionEvent } from '../../../src/api/voice';
export type { VoicePcmChunk } from '../../../src/api/voice';

export type VoiceMode = 'auto' | 'push-to-talk';
export type VoicePhase = 'off' | 'starting' | 'listening' | 'recording' | 'transcribing' | 'speaking' | 'working' | 'muted' | 'error';

export interface VoiceAudio {
  audioBase64: string;
  mimeType: string;
}

export interface VoiceAdapter {
  /** Optional main-process session/auth setup. Called only after an explicit Start gesture. */
  begin?(signal: AbortSignal): Promise<void>;
  end?(): Promise<void> | void;
  transcribe(audio: { wavBase64: string; sampleRate: 16000 }, signal: AbortSignal): Promise<string>;
  synthesize?(text: string, signal: AbortSignal): Promise<VoiceAudio>;
  synthesizeStream?(text: string, signal: AbortSignal): AsyncIterable<VoicePcmChunk>;
  beginTranscription?(signal: AbortSignal, onEvent: (event: VoiceTranscriptionEvent) => void): Promise<VoiceRealtimeTranscription | null>;
}

export interface VoiceRealtimeTranscription {
  append(pcmBase64: string): Promise<void>;
  commit(): Promise<void>;
  clear(): Promise<void>;
  stop(): Promise<void>;
}

export interface VoiceMicrophone {
  setMuted(muted: boolean): void;
  stop(): void;
}

export interface VoiceAudioBackend {
  /** Unlock playback from a user gesture, without acquiring a microphone. */
  unlock?(): Promise<void>;
  capture(onFrame: (samples: Float32Array, sampleRate: number) => void, onError: (error: unknown) => void): Promise<VoiceMicrophone>;
  play(audio: VoiceAudio, signal: AbortSignal, onLevel: (level: number) => void): Promise<void>;
  playStream?(chunks: AsyncIterable<VoicePcmChunk>, signal: AbortSignal, onLevel: (level: number) => void): Promise<void>;
  stopPlayback(): void;
  close(): Promise<void> | void;
}

export interface VoiceState {
  active: boolean;
  phase: VoicePhase;
  mode: VoiceMode;
  muted: boolean;
  speaking: boolean;
  recording: boolean;
  agentWorking: boolean;
  pendingUtterances: number;
  level: number;
  levels: number[];
  error: string | null;
  failedUtterance: boolean;
  recoveredTranscript: string | null;
  interimTranscript?: string;
}

export interface VoiceSession {
  state: VoiceState;
  start(): Promise<void>;
  stop(): void;
  setMuted(muted: boolean): void;
  setMode(mode: VoiceMode): void;
  beginPushToTalk(): void;
  endPushToTalk(): void;
  speak(text: string, id?: string): void;
  interruptPlayback(): void;
  retryFailedUtterance(): void;
  retryTranscript(): Promise<void>;
  discardTranscript(): void;
  clearError(): void;
}
