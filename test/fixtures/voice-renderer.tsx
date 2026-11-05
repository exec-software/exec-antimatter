/** Isolated visual/control fixture. All audio and IPC are fake; no device APIs are called. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyDisplacerTokens } from '../../renderer/src/displacer';
import { VoicePanel } from '../../renderer/src/voice/VoicePanel';
import { useVoiceSession } from '../../renderer/src/voice/useVoiceSession';
import { VoiceSettingsPanel } from '../../renderer/src/components/chat/VoiceSettingsPanel';
import type { VoiceAudioBackend, VoiceSession } from '../../renderer/src/voice/types';
import type { VoiceConfiguration } from '../../src/api/voice';

const metrics = { captures: 0, stops: 0, muted: false, plays: 0, transcriptions: 0, ids: [] as string[], saved: 0, accepted: false };
let frame: ((pcm: Float32Array, rate: number) => void) | undefined;
let finishPlayback: (() => void) | undefined;
let current: VoiceSession;
const audio: VoiceAudioBackend = {
  capture: async (onFrame) => { metrics.captures++; frame = onFrame; return { setMuted: (muted) => { metrics.muted = muted; }, stop: () => { metrics.stops++; } }; },
  play: async (_payload, signal, onLevel) => {
    metrics.plays++; onLevel(0.12);
    await new Promise<void>((resolve) => { finishPlayback = resolve; signal.addEventListener('abort', resolve.bind(null), { once: true }); });
  },
  stopPlayback: () => { finishPlayback?.(); },
  close: () => undefined,
};
const initial: VoiceConfiguration = {
  settings: { inputSourceId: 'local', inputModel: 'local-audio', inputMode: 'chat-audio', speechSourceId: 'local', speechModel: 'kokoro', speechVoice: 'af_heart', speechEnabled: true, allowRemote: false },
  sources: [{ id: 'local', name: 'Local speech fixture', local: true, models: ['local-audio', 'kokoro'] }, { id: 'remote', name: 'Remote fixture — no network', local: false, models: ['remote-audio'] }],
  state: { active: false, sessionId: null, threadId: null, phase: 'idle', muted: false, speaking: false, error: null },
};
window.electronAPI = { voice: {
  configure: async (settings: VoiceConfiguration['settings']) => { metrics.saved++; return { ...initial, settings }; },
  probe: async () => ({ modelAvailable: true, input: 'supported', notes: ['Fixture capability response — no endpoint was contacted.'] }),
} } as unknown as typeof window.electronAPI;

function Fixture() {
  const [config, setConfig] = useState(initial);
  current = useVoiceSession({ sessionKey: 'fixture', audio, agentWorking: true,
    adapter: { transcribe: async () => { metrics.transcriptions++; return 'Please run the focused tests before making another edit.'; }, synthesize: async () => ({ mimeType: 'audio/wav', audioBase64: 'fixture' }) },
    onTranscript: (_text, id) => { metrics.ids.push(id); return metrics.accepted; },
  });
  return <main style={{ maxWidth: 820, margin: '0 auto', padding: 28 }}>
    <h1 className="text-lg font-semibold text-ink">Antimatter · Voice controls</h1>
    <p className="mb-4 mt-1 text-xs text-ink-3">Isolated smoke fixture · simulated audio only · device access and network blocked</p>
    <VoicePanel voice={current} onInsertDraft={() => undefined} />
    <div className="mt-3"><VoiceSettingsPanel config={config} onSaved={setConfig} disabled={current.state.active} /></div>
  </main>;
}

Object.assign(window, { voiceSmoke: {
  metrics,
  state: () => current.state,
  utterance: () => { current.beginPushToTalk(); for (let i = 0; i < 5; i++) frame?.(new Float32Array(800).fill(0.12), 16000); current.endPushToTalk(); },
  narrate: () => current.speak('The focused checks passed. I am reviewing the changes now.', 'fixture-response'),
} });
applyDisplacerTokens();
createRoot(document.getElementById('root')!).render(<Fixture />);
