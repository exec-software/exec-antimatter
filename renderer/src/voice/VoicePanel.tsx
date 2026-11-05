import { useState } from 'react';
import { Copy, Mic, MicOff, Pause, Play, Square, VolumeX, X } from 'lucide-react';
import type { VoicePhase, VoiceSession } from './types';

const phaseLabel: Record<VoicePhase, string> = {
  off: 'Voice off', starting: 'Starting microphone…', listening: 'Listening', recording: 'Hearing you',
  transcribing: 'Transcribing', speaking: 'Voice response', working: 'Agent working · listening for guidance',
  muted: 'Microphone muted', error: 'Voice needs attention',
};
const button = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:bg-surface-3 hover:text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70';

export interface VoicePanelProps {
  voice: VoiceSession;
  onClose?(): void;
  onInsertDraft?(text: string): void;
  onOpenSettings?(): void;
}

export function VoicePanel({ voice, onClose, onInsertDraft, onOpenSettings }: VoicePanelProps) {
  const { state } = voice;
  const [copyStatus, setCopyStatus] = useState('');
  const ready = state.active && state.phase !== 'starting';

  return <section aria-label="Live voice" className="rounded-xl border border-line bg-surface-2 p-3 shadow-lg shadow-black/15">
    <header className="flex items-center gap-2">
      {state.muted ? <MicOff size={15} className="text-ink-3" /> : <Mic size={15} className={state.active ? 'text-accent' : 'text-ink-3'} />}
      <h2 className="text-xs font-semibold text-ink">Live voice</h2>
      <span role="status" className="min-w-0 flex-1 truncate text-[11px] text-ink-3">{state.phase === 'speaking' ? state.mode === 'auto' && !state.muted ? 'Voice response · speak to interrupt' : 'Voice response · mic paused' : phaseLabel[state.phase]}</span>
      {onClose && <button type="button" onClick={() => { voice.stop(); onClose(); }} aria-label="Stop and close voice" className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink"><X size={14} /></button>}
    </header>
    <div className="my-2 flex h-7 items-center justify-center gap-1" aria-hidden="true">
      {state.levels.map((level, index) => <span key={index} className={`w-1 rounded-full transition-[height] duration-75 ${state.speaking ? 'bg-primary/70' : state.active && !state.muted ? 'bg-accent/70' : 'bg-ink-3/30'}`} style={{ height: Math.max(3, Math.round(level * 27)) }} />)}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {!state.active ? <button type="button" onClick={() => void voice.start()} className={button}><Play size={12} />Start microphone</button> : <>
        <button type="button" onClick={voice.stop} className={button}><Square size={11} />Stop</button>
        <button type="button" onClick={() => voice.setMuted(!state.muted)} disabled={!ready || state.failedUtterance || !!state.recoveredTranscript} className={button}>{state.muted ? <Mic size={12} /> : <Pause size={12} />}{state.muted ? 'Unmute' : 'Mute mic'}</button>
      </>}
      <label className="flex items-center gap-1.5 text-[11px] text-ink-3">Mode<select aria-label="Voice input mode" value={state.mode} onChange={(event) => voice.setMode(event.target.value === 'push-to-talk' ? 'push-to-talk' : 'auto')} className="rounded-md border border-line bg-surface-0 px-2 py-1.5 text-xs text-ink-2"><option value="auto">Auto detect</option><option value="push-to-talk">Hold to talk</option></select></label>
      {state.speaking && <button type="button" onClick={voice.interruptPlayback} className={button}><VolumeX size={12} />Interrupt & listen</button>}
      {onOpenSettings && <button type="button" onClick={onOpenSettings} className={`${button} ml-auto`}>{state.active ? 'Stop & configure' : 'Voice settings'}</button>}
    </div>
    {state.mode === 'push-to-talk' && <button
      type="button"
      disabled={!ready || state.failedUtterance || !!state.recoveredTranscript}
      onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); voice.beginPushToTalk(); }}
      onPointerUp={() => voice.endPushToTalk()}
      onPointerCancel={() => voice.endPushToTalk()}
      onLostPointerCapture={() => voice.endPushToTalk()}
      onKeyDown={(event) => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); voice.beginPushToTalk(); } }}
      onKeyUp={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); voice.endPushToTalk(); } }}
      onBlur={() => voice.endPushToTalk()}
      aria-label="Hold to talk; release to transcribe"
      className={`${button} mt-2 w-full touch-none select-none ${state.recording ? 'border-accent bg-accent/10 text-accent' : ''}`}
    ><Mic size={14} />{state.recording ? 'Release to transcribe' : 'Hold to talk'}</button>}
    <p className="mt-2 text-[10px] leading-4 text-ink-3">{state.active ? `Speech uses your configured service. While the agent works, your words provide guidance—not approval. ${state.mode === 'auto' ? 'Speak to interrupt a voice response. Use Hold to talk if speaker echo triggers interruptions.' : 'Listening pauses during playback; hold to talk or interrupt to speak.'}` : 'Start explicitly enables the microphone. Audio goes only to your configured speech service. No browser cloud speech recognition is used.'}</p>
    {state.interimTranscript && <p role="status" aria-label="Live transcript" className="mt-2 rounded-md border border-line bg-surface-0 p-2 text-xs leading-5 text-ink-2">{state.interimTranscript}</p>}
    {state.pendingUtterances > 0 && <p className="mt-1 text-[10px] text-ink-3">{state.pendingUtterances} utterance{state.pendingUtterances === 1 ? '' : 's'} queued · one transcription at a time</p>}
    {state.error && <p role="alert" className="mt-2 rounded-md border border-danger/30 bg-danger/5 p-2 text-xs leading-5 text-danger">{state.error}</p>}
    {state.failedUtterance && <button type="button" onClick={voice.retryFailedUtterance} disabled={!state.active} className={`${button} mt-2`}>Retry saved audio</button>}
    {state.recoveredTranscript && <div className="mt-2 rounded-md border border-line bg-surface-0 p-2">
      <label className="block text-[11px] text-ink-3">Unsent transcript<textarea readOnly aria-label="Unsent voice transcript" value={state.recoveredTranscript} className="mt-1 max-h-36 min-h-16 w-full resize-y bg-transparent text-xs leading-5 text-ink outline-none" /></label>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={!state.active || state.phase === 'transcribing'} onClick={() => void voice.retryTranscript()} className={button}>Retry sending</button>
        <button type="button" onClick={() => { void navigator.clipboard.writeText(state.recoveredTranscript!).then(() => setCopyStatus('Copied'), () => setCopyStatus('Copy failed—select and copy the text above.')); }} className={button}><Copy size={12} />Copy</button>
        {onInsertDraft && <button type="button" onClick={() => { onInsertDraft(state.recoveredTranscript!); voice.discardTranscript(); }} className={button}>Keep as draft</button>}
        <button type="button" onClick={voice.discardTranscript} className={button}>Dismiss transcript</button>
      </div>
      {copyStatus && <p role="status" className="mt-1 text-[10px] text-ink-3">{copyStatus}</p>}
    </div>}
  </section>;
}
