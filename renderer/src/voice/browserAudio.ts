import { rms } from './pcm';
import type { VoiceAudioBackend, VoiceMicrophone } from './types';

/** Browser-only local audio plumbing. Speech services are exclusively the injected main adapter. */
export function browserVoiceAudio(): VoiceAudioBackend {
  let context: AudioContext | null = null;
  let workletReady: Promise<void> | null = null;
  let playback: (() => void) | null = null;
  let microphone: VoiceMicrophone | null = null;

  const audioContext = () => {
    if (!context || context.state === 'closed') { context = new AudioContext(); workletReady = null; }
    return context;
  };

  return {
    async unlock() {
      const audio = audioContext();
      await audio.resume();
    },
    async capture(onFrame, onError) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable. Open the desktop app in a secure context.');
      const audio = audioContext();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      let stopped = false;
      let source: MediaStreamAudioSourceNode | null = null;
      let node: AudioWorkletNode | ScriptProcessorNode | null = null;
      let sink: GainNode | null = null;
      const stop = () => {
        if (stopped) return; stopped = true;
        for (const track of stream.getTracks()) track.stop();
        if (node && 'port' in node) { node.port.onmessage = null; node.port.close(); }
        else if (node) node.onaudioprocess = null;
        try { source?.disconnect(); node?.disconnect(); sink?.disconnect(); } catch { /* Already disconnected. */ }
        if (microphone?.stop === stop) microphone = null;
      };
      try {
        if (audio.state === 'closed') throw new Error('Voice was stopped before the microphone was ready.');
        source = audio.createMediaStreamSource(stream);
        sink = audio.createGain(); sink.gain.value = 0; sink.connect(audio.destination);
        if (audio.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
          try {
            workletReady ??= audio.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
            await workletReady;
            const processor = new AudioWorkletNode(audio, 'antimatter-microphone', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
            processor.port.onmessage = (event: MessageEvent<unknown>) => {
              if (!stopped && event.data instanceof Float32Array && event.data.length <= 8192) onFrame(event.data, audio.sampleRate);
            };
            processor.onprocessorerror = () => { if (!stopped) onError(new Error('The microphone audio processor stopped. Stop voice and start again.')); };
            node = processor;
          } catch {
            // Chromium still supports this local fallback. It is not a cloud recognizer.
            workletReady = null;
          }
        }
        if (!node) {
          const processor = audio.createScriptProcessor(2048, 1, 1);
          processor.onaudioprocess = (event) => {
            if (!stopped) onFrame(event.inputBuffer.getChannelData(0).slice(), audio.sampleRate);
            event.outputBuffer.getChannelData(0).fill(0);
          };
          node = processor;
        }
        source.connect(node); node.connect(sink);
        for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
          if (!stopped) onError(new Error('The microphone disconnected. Reconnect it, then start voice again.'));
        });
        microphone = { stop, setMuted: (muted) => { for (const track of stream.getAudioTracks()) track.enabled = !muted && !stopped; } };
        await audio.resume();
        return microphone;
      } catch (error) { stop(); throw error; }
    },
    async play(payload, signal, onLevel) {
      if (signal.aborted) return;
      if (!/^audio\/(?:wav|x-wav|wave|mpeg|mp3|ogg|webm|flac|aac|mp4)$/i.test(payload.mimeType)) throw new Error('The speech service returned an unsupported audio format.');
      if (!payload.audioBase64 || payload.audioBase64.length > 16 * 1024 * 1024) throw new Error('The speech service returned an empty or oversized audio response.');
      const binary = atob(payload.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const audio = audioContext();
      const closed = () => audio.state === 'closed';
      const buffer = await audio.decodeAudioData(bytes.buffer);
      if (signal.aborted || closed()) return;
      if (buffer.duration <= 0 || buffer.duration > 90) throw new Error('The speech response exceeds the playback limit or contains no audio.');
      await audio.resume();
      if (signal.aborted || closed()) return;
      await new Promise<void>((resolve, reject) => {
        const source = audio.createBufferSource(); source.buffer = buffer;
        const analyser = audio.createAnalyser(); analyser.fftSize = 256;
        source.connect(analyser); analyser.connect(audio.destination);
        const values = new Float32Array(analyser.fftSize);
        let settled = false;
        const timer = window.setInterval(() => { analyser.getFloatTimeDomainData(values); onLevel(rms(values)); }, 50);
        const finish = () => settle();
        const settle = (failure?: unknown) => {
          if (settled) return; settled = true;
          window.clearInterval(timer); signal.removeEventListener('abort', finish);
          try { source.stop(); source.disconnect(); analyser.disconnect(); } catch { /* Already ended. */ }
          if (playback === finish) playback = null;
          onLevel(0);
          if (failure) reject(failure); else resolve();
        };
        playback = finish; source.onended = finish; signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
        else { try { source.start(); } catch (error) { settle(error); } }
      });
    },
    async playStream(chunks, signal, onLevel) {
      if (signal.aborted) return;
      const audio = audioContext();
      await audio.resume();
      const closed = () => audio.state === 'closed';
      if (signal.aborted || closed()) return;
      const analyser = audio.createAnalyser(); analyser.fftSize = 256; analyser.connect(audio.destination);
      const values = new Float32Array(analyser.fftSize);
      const nodes = new Set<AudioBufferSourceNode>();
      let stopped = false;
      let wake: (() => void) | undefined;
      let nextTime = audio.currentTime + 0.025;
      const timer = window.setInterval(() => { analyser.getFloatTimeDomainData(values); onLevel(rms(values)); }, 50);
      const finish = () => {
        if (stopped) return;
        stopped = true; wake?.();
        for (const node of nodes) { node.onended = null; try { node.stop(); node.disconnect(); } catch { /* Already ended. */ } }
        nodes.clear(); window.clearInterval(timer); signal.removeEventListener('abort', finish);
        analyser.disconnect(); if (playback === finish) playback = null; onLevel(0);
      };
      playback?.(); playback = finish; signal.addEventListener('abort', finish, { once: true });
      const wait = () => new Promise<void>((resolve) => {
        const tick = window.setTimeout(() => { if (wake === ready) wake = undefined; resolve(); }, 25);
        const ready = () => { window.clearTimeout(tick); if (wake === ready) wake = undefined; resolve(); };
        wake = ready;
      });
      try {
        for await (const chunk of chunks) {
          if (stopped || signal.aborted || closed()) break;
          if (chunk.format !== 'pcm16le' || chunk.channels !== 1 || !Number.isInteger(chunk.sampleRate) ||
              chunk.sampleRate < 8000 || chunk.sampleRate > 48000 || !chunk.audioBase64 || chunk.audioBase64.length > 21848) {
            throw new Error('The speech service returned an unsupported PCM stream.');
          }
          const bytes = atob(chunk.audioBase64);
          if (!bytes.length || bytes.length % 2 || bytes.length > 16384) throw new Error('The speech service returned invalid PCM samples.');
          const frames = bytes.length / 2;
          const buffer = audio.createBuffer(1, frames, chunk.sampleRate);
          const samples = buffer.getChannelData(0);
          for (let index = 0; index < frames; index++) {
            const sample = bytes.charCodeAt(index * 2) | bytes.charCodeAt(index * 2 + 1) << 8;
            samples[index] = (sample >= 0x8000 ? sample - 0x10000 : sample) / 32768;
          }
          const node = audio.createBufferSource(); node.buffer = buffer; node.connect(analyser); nodes.add(node);
          node.onended = () => { nodes.delete(node); node.disconnect(); wake?.(); };
          const start = Math.max(nextTime, audio.currentTime + (nodes.size === 1 ? 0.025 : 0));
          nextTime = start + buffer.duration; node.start(start);
          // Holding the iterator here also holds the IPC acknowledgement and the HTTP reader.
          // Faster-than-playback synthesis never builds an unbounded audio queue in any process.
          while (!stopped && nextTime - audio.currentTime > 2) await wait();
        }
        while (!stopped && nodes.size) await wait();
      } finally { finish(); }
    },
    stopPlayback() { playback?.(); },
    async close() {
      microphone?.stop(); playback?.();
      const audio = context; context = null; workletReady = null;
      if (audio && audio.state !== 'closed') await audio.close().catch(() => undefined);
    },
  };
}
