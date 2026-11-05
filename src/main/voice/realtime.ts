import WebSocket from 'ws';
import type { ProviderConfig } from '../../api/types';
import { boundedResponseJson } from '../../api/providers/httpBody';

export interface RealtimeTranscriptionEvent {
  sessionId: string;
  type: 'ready' | 'partial' | 'final' | 'speech-started' | 'speech-stopped' | 'error';
  itemId?: string;
  text?: string;
  message?: string;
}
export interface RealtimeTranscriptionOptions {
  allowRemote?: boolean;
  signal?: AbortSignal;
  /** Connection/model readiness deadline; capture must begin only after start resolves. */
  timeoutMs?: number;
  onEvent: (event: RealtimeTranscriptionEvent) => void;
}
export const MAX_REALTIME_PCM_BYTES = 32_000;
const MAX_QUEUED_BYTES = 256 * 1024;
const MAX_TEXT = 16_000;
const MAX_MESSAGE_BYTES = 64 * 1024;

/** Credentials and destination validation stay in main, never in renderer WebSockets. */
export function realtimeVoiceUrl(source: ProviderConfig, model: string, allowRemote = false): URL {
  let url: URL;
  try { url = new URL(source.baseUrl); } catch { throw new Error('Choose a valid live transcription source.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error('Live transcription requires HTTP(S) without embedded credentials, query parameters, or fragments.');
  }
  if (source.protocol && source.protocol !== 'openai-chat') throw new Error('Choose a compatible live transcription source.');
  const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!local && (!allowRemote || url.protocol !== 'https:')) {
    throw new Error('Remote live transcription requires explicit permission and HTTPS.');
  }
  if (typeof model !== 'string' || !model.trim() || model.length > 300 || /[\x00-\x1f\x7f]/.test(model)) {
    throw new Error('Choose a valid live transcription model.');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/realtime`;
  url.searchParams.set('model', model.trim());
  // Lemonade's WebSocket upgrade authenticates via this query parameter. The URL is
  // main-only, and raw socket/server errors (which can contain it) are never exposed.
  if (source.apiKey) url.searchParams.set('api_key', source.apiKey);
  return url;
}

type Connection = {
  id: string;
  socket: WebSocket;
  options: RealtimeTranscriptionOptions;
  ready: boolean;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
  serial: number;
  itemId: string | null;
  finalized: Set<string>;
  discarded: Set<string>;
  clearing: boolean;
  hasAudio: boolean;
  speaking: boolean;
  speechBytes: number;
  closed: Promise<void>;
  closedResolve: () => void;
  clearPending: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null;
  commitPending: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; acknowledged: boolean } | null;
};

/** One cancellable, bounded PCM16/16kHz stream owned by the current voice session. */
export class RealtimeTranscription {
  private connection: Connection | null = null;

  async start(sessionId: string, source: ProviderConfig, model: string, options: RealtimeTranscriptionOptions): Promise<void> {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || /[\x00-\x1f\x7f]/.test(sessionId)) {
      throw new Error('Invalid live transcription session.');
    }
    const url = realtimeVoiceUrl(source, model, options.allowRemote);
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120_000) throw new Error('Invalid live transcription timeout.');
    if (options.signal?.aborted) throw new Error('Live transcription cancelled.');
    this.stop();
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        followRedirects: false, maxPayload: MAX_MESSAGE_BYTES, handshakeTimeout: timeout,
        headers: source.apiKey ? { Authorization: `Bearer ${source.apiKey}` } : undefined,
      });
      let closedResolve!: () => void;
      const closed = new Promise<void>((done) => { closedResolve = done; });
      const connection: Connection = {
        id: sessionId, socket, options, ready: false, settled: false, resolve, reject,
        timer: setTimeout(() => this.fail(connection, 'The live transcription service did not become ready in time.'), timeout),
        abort: () => this.stop(sessionId), serial: 0, itemId: null,
        finalized: new Set(), discarded: new Set(), clearing: false, hasAudio: false, speaking: false, speechBytes: 0,
        closed, closedResolve, clearPending: null, commitPending: null,
      };
      this.connection = connection;
      options.signal?.addEventListener('abort', connection.abort, { once: true });
      socket.on('message', (raw) => this.receive(connection, raw));
      socket.on('error', () => this.fail(connection, 'The live transcription service is unavailable. Check the service and selected model.'));
      socket.on('close', () => {
        if (this.connection === connection) this.fail(connection, 'The live transcription connection closed. Start voice again.');
      });
      socket.on('open', () => {
        if (this.connection !== connection) return;
        this.send(connection, { type: 'session.update', session: {
          model: model.trim(), input_audio_format: 'pcm16', input_audio_transcription: { model: model.trim() },
          turn_detection: { type: 'server_vad', threshold: 0.01, silence_duration_ms: 500, prefix_padding_ms: 250 },
        } });
      });
    });
  }

  append(sessionId: string, pcmBase64: string): void {
    const connection = this.assert(sessionId);
    if (typeof pcmBase64 !== 'string' || !pcmBase64 || pcmBase64.length > Math.ceil(MAX_REALTIME_PCM_BYTES / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pcmBase64)) {
      throw new Error('Live audio must be bounded base64 PCM16 chunks.');
    }
    const bytes = Buffer.from(pcmBase64, 'base64');
    if (!bytes.length || bytes.length > MAX_REALTIME_PCM_BYTES || bytes.length % 2 || bytes.toString('base64') !== pcmBase64) {
      throw new Error('Live audio must be mono PCM16 at 16 kHz, no larger than one second per chunk.');
    }
    if (connection.clearing) return; // The caller resumes after clearing acknowledgement.
    if (connection.speaking && (connection.speechBytes += bytes.length) > 120 * 32_000) {
      this.fail(connection, 'This live utterance exceeded two minutes. Start voice again and use shorter utterances.');
      throw new Error('Live utterance exceeded its duration limit.');
    }
    connection.hasAudio = true;
    this.send(connection, { type: 'input_audio_buffer.append', audio: pcmBase64 });
  }

  /** Resolves after commit acknowledgement AND the active line's final callback. */
  commit(sessionId: string): Promise<void> {
    const connection = this.assert(sessionId);
    if (connection.commitPending) return connection.commitPending.promise;
    if (connection.hasAudio && !connection.clearing) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      const timer = setTimeout(() => this.fail(connection, 'The live transcription service did not finish its audio buffer in time.'), 10_000);
      connection.commitPending = { promise, resolve, reject, timer, acknowledged: false };
      this.send(connection, { type: 'input_audio_buffer.commit' });
      return promise;
    }
    return Promise.resolve();
  }

  clear(sessionId: string): Promise<void> {
    const connection = this.assert(sessionId);
    if (connection.clearPending) return connection.clearPending.promise;
    if (connection.itemId) this.remember(connection.discarded, connection.itemId);
    connection.clearing = true; connection.hasAudio = false; connection.speaking = false; connection.speechBytes = 0;
    connection.itemId = null;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const timer = setTimeout(() => this.fail(connection, 'The live transcription service did not clear its audio buffer in time.'), 5000);
    connection.clearPending = { promise, resolve, reject, timer };
    this.send(connection, { type: 'input_audio_buffer.clear' });
    return promise;
  }

  waitUntilClosed(): Promise<void> { return this.connection?.closed ?? Promise.resolve(); }

  stop(sessionId?: string): void {
    const connection = this.connection;
    if (!connection || (sessionId !== undefined && sessionId !== connection.id)) return;
    this.connection = null;
    clearTimeout(connection.timer);
    connection.options.signal?.removeEventListener('abort', connection.abort);
    if (connection.clearPending) {
      clearTimeout(connection.clearPending.timer);
      connection.clearPending.reject(new Error('Live transcription cancelled.')); connection.clearPending = null;
    }
    if (connection.commitPending) {
      clearTimeout(connection.commitPending.timer);
      connection.commitPending.reject(new Error('Live transcription cancelled.')); connection.commitPending = null;
    }
    connection.closedResolve();
    if (!connection.settled) { connection.settled = true; connection.reject(new Error('Live transcription cancelled.')); }
    // terminate also stops handshakes immediately, so old microphone streams cannot
    // keep sending after a thread change, renderer crash, or explicit stop.
    connection.socket.terminate();
  }

  private assert(sessionId: string): Connection {
    const connection = this.connection;
    if (!connection || sessionId !== connection.id || !connection.ready) throw new Error('This live transcription session is not active. Start voice again.');
    return connection;
  }

  private send(connection: Connection, value: unknown): void {
    if (this.connection !== connection || connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.socket.bufferedAmount > MAX_QUEUED_BYTES) {
      this.fail(connection, 'Live transcription cannot keep up with the audio connection. Start voice again.');
      return;
    }
    connection.socket.send(JSON.stringify(value), (error) => {
      if (error) this.fail(connection, 'The live transcription service could not receive audio. Start voice again.');
    });
  }

  private emit(connection: Connection, event: Omit<RealtimeTranscriptionEvent, 'sessionId'>): void {
    if (this.connection === connection) connection.options.onEvent({ ...event, sessionId: connection.id });
  }
  private fail(connection: Connection, message: string): void {
    if (this.connection !== connection) return;
    if (!connection.settled) { connection.settled = true; connection.reject(new Error(message)); }
    this.emit(connection, { type: 'error', message });
    this.stop(connection.id);
  }
  private remember(set: Set<string>, id: string) {
    set.add(id);
    if (set.size > 256) set.delete(set.values().next().value!);
  }
  private finishCommit(connection: Connection): void {
    const pending = connection.commitPending;
    if (!pending?.acknowledged || connection.itemId !== null) return;
    clearTimeout(pending.timer); connection.commitPending = null; pending.resolve();
  }

  private receive(connection: Connection, raw: WebSocket.RawData): void {
    if (this.connection !== connection) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch { this.fail(connection, 'The live transcription service sent an invalid response.'); return; }
    const type = message.type;
    if (type === 'session.updated') {
      if (!connection.ready) {
        connection.ready = true; connection.settled = true; clearTimeout(connection.timer);
        connection.resolve(); this.emit(connection, { type: 'ready' });
      }
      return;
    }
    if (type === 'error') { this.fail(connection, 'The live transcription service reported an error. Check the selected streaming model.'); return; }
    if (type === 'input_audio_buffer.cleared') {
      connection.clearing = false;
      if (connection.clearPending) {
        clearTimeout(connection.clearPending.timer); connection.clearPending.resolve(); connection.clearPending = null;
      }
      return;
    }
    if (type === 'input_audio_buffer.committed') {
      if (connection.commitPending) {
        connection.commitPending.acknowledged = true;
        this.finishCommit(connection);
      }
      return;
    }
    if (!connection.ready || connection.clearing || !connection.hasAudio) return;
    const rawId = message.item_id;
    if (rawId !== undefined && (typeof rawId !== 'string' || !rawId || rawId.length > 200)) {
      this.fail(connection, 'The live transcription service returned an invalid utterance identifier.'); return;
    }
    // Moonshine omits upstream item ids. After a commit fallback, a delayed native
    // final for that same line must not create a second user turn.
    if (rawId === undefined && !connection.itemId
      && (type === 'conversation.item.input_audio_transcription.completed' || type === 'input_audio_buffer.speech_stopped')) return;
    const itemId = typeof rawId === 'string' ? rawId
      : type === 'input_audio_buffer.speech_started' ? `${connection.id}:${++connection.serial}`
        : (connection.itemId ?? `${connection.id}:${++connection.serial}`);
    if (connection.discarded.has(itemId) || connection.finalized.has(itemId)) return;
    if (type === 'input_audio_buffer.speech_started') {
      connection.itemId = itemId; connection.speaking = true; connection.speechBytes = 0;
      this.emit(connection, { type: 'speech-started', itemId });
    } else if (type === 'input_audio_buffer.speech_stopped') {
      connection.speaking = false; connection.speechBytes = 0;
      this.emit(connection, { type: 'speech-stopped', itemId });
    } else if (type === 'conversation.item.input_audio_transcription.delta' || type === 'conversation.item.input_audio_transcription.completed') {
      const final = type.endsWith('.completed');
      const text = final ? message.transcript : (message.delta ?? message.transcript);
      if (typeof text !== 'string' || text.length > MAX_TEXT || /<\/?think(?:ing)?>/i.test(text)) {
        this.fail(connection, 'The live transcription service returned an invalid transcript.'); return;
      }
      connection.itemId = itemId;
      if (final) {
        this.remember(connection.finalized, itemId); connection.itemId = null;
        connection.speaking = false; connection.speechBytes = 0;
      }
      // Moonshine delta contains the whole current hypothesis, not an append-only token.
      this.emit(connection, { type: final ? 'final' : 'partial', itemId, text: final ? text.trim() : text });
      if (final) this.finishCommit(connection);
    }
  }
}

/** Discover only downloaded streaming ASR models; never loads a model or opens the mic. */
export async function discoverLocalTranscriptionSource(): Promise<ProviderConfig | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch('http://127.0.0.1:13305/api/v1/models', { signal: controller.signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null; }
    const payload = await boundedResponseJson(response, 512 * 1024) as { data?: unknown };
    if (!payload || !Array.isArray(payload.data)) return null;
    const models = payload.data.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const model = entry as Record<string, unknown>;
      if (typeof model.id !== 'string' || model.id.length > 300 || !/^Moonshine-(?:Small|Medium|Tiny)-Streaming$/i.test(model.id)
        || model.downloaded !== true || !Array.isArray(model.labels) || !model.labels.includes('realtime-transcription')) return [];
      return [{ id: model.id, name: `${model.id.replace(/-/g, ' ')} · English` }];
    });
    if (!models.length) return null;
    return { id: 'antimatter.local-transcription', name: 'Local live transcription (Moonshine)', kind: 'openai-compatible',
      protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:13305/api/v1', apiKey: '', supportsStreaming: true, models };
  } catch { return null; }
  finally { clearTimeout(timer); }
}
