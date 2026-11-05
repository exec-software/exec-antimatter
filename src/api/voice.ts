/** Voice is an opt-in transport for the existing chat, never an authorization channel. */
export interface VoiceSettings {
  inputSourceId: string;
  inputModel: string;
  inputMode: 'chat-audio' | 'transcriptions' | 'realtime';
  speechSourceId: string;
  speechModel: string;
  speechVoice: string;
  speechEnabled: boolean;
  allowRemote: boolean;
}
export type VoicePhase = 'idle' | 'starting' | 'listening' | 'recording' | 'transcribing' | 'speaking' | 'muted' | 'error';
export interface VoiceState {
  active: boolean;
  sessionId: string | null;
  threadId: string | null;
  phase: VoicePhase;
  muted: boolean;
  speaking: boolean;
  error: string | null;
}
export interface VoiceSource {
  id: string;
  name: string;
  local: boolean;
  models: string[];
}
export interface VoiceConfiguration {
  settings: VoiceSettings;
  sources: VoiceSource[];
  state: VoiceState;
  /** Defaults are shown for repair; the corrupt saved settings are not silently activated. */
  configurationError?: string;
}
export type VoiceCommand = 'open' | 'stop' | 'toggleMute' | 'interrupt';
/** Bounded mono PCM16 little-endian audio; no credentials or model URLs cross IPC. */
export interface VoicePcmChunk {
  audioBase64: string;
  sampleRate: number;
  channels: 1;
  format: 'pcm16le';
}
export interface VoiceSpeechEvent {
  sessionId: string;
  requestId: string;
  sequence: number;
  chunk: VoicePcmChunk;
}
export interface VoiceTranscriptionEvent {
  sessionId: string;
  requestId: string;
  type: 'ready' | 'partial' | 'final' | 'speech-started' | 'speech-stopped' | 'error';
  itemId?: string;
  /** Partial text replaces the previous draft; only final text becomes a chat turn. */
  text?: string;
  message?: string;
}
export interface VoiceGuidance {
  id: string;
  text: string;
  at: number;
  contentOffset: number;
  status: 'queued' | 'delivered' | 'undelivered';
}
