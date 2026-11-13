import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { NativeTools } from '../../api/nativeProject';
import type { NyCompletionItem, NyDiagnostic, NyDocument, NyHover, NyLocation, NyPosition, NyRange } from '../../api/ny';
import { nativeBuildDirectory, nativeSourcePath, nativeTools } from './nativeProjects';

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_PACKET_BYTES = 8 * 1024 * 1024;
const MAX_OPEN_DOCUMENTS = 64;
const MAX_HEADER_BYTES = 8192;
type Language = 'rust' | 'cpp' | 'c';
interface Document { uri: string; path: string; text: string; languageId: string; version: number }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface DiagnosticWaiter { version: number; resolve(value: NyDiagnostic[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export interface NativeLanguageOptions {
  environment?: NodeJS.ProcessEnv;
  tools?: NativeTools;
  requestTimeoutMs?: number;
  diagnosticTimeoutMs?: number;
}

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 16000): string | undefined => typeof value === 'string' ? value.slice(0, max) : undefined;
function position(value: unknown): NyPosition | null {
  const item = record(value);
  if (!item || !Number.isSafeInteger(item.line) || !Number.isSafeInteger(item.character) || (item.line as number) < 0 || (item.character as number) < 0) {
    return null;
  }
  return { line: item.line as number, character: item.character as number };
}
function range(value: unknown): NyRange | null {
  const item = record(value);
  const start = position(item?.start);
  const end = position(item?.end);
  if (!start || !end || end.line < start.line || end.line === start.line && end.character < start.character) {
    return null;
  }
  return { start, end };
}
function documentation(value: unknown): string | { kind: string; value: string } | undefined {
  if (typeof value === 'string') {
    return value.slice(0, 32000);
  }
  const item = record(value);
  return item && typeof item.value === 'string' ? { kind: item.kind === 'markdown' ? 'markdown' : 'plaintext', value: item.value.slice(0, 32000) } : undefined;
}

/** Strict normalization keeps subprocess responses out of renderer command/CSS/HTML surfaces. */
export function nativeCompletionItems(value: unknown): NyCompletionItem[] {
  const list = Array.isArray(value) ? value : record(value)?.items;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.slice(0, 1000).flatMap((value) => {
    const item = record(value);
    if (!item || typeof item.label !== 'string' || !item.label || item.label.length > 512) {
      return [];
    }
    const edit = record(item.textEdit);
    const editRange = range(edit?.range ?? edit?.replace);
    const newText = text(edit?.newText);
    const additionalTextEdits = Array.isArray(item.additionalTextEdits) ? item.additionalTextEdits.slice(0, 32).flatMap((value) => {
      const additional = record(value);
      const additionalRange = range(additional?.range);
      const additionalText = text(additional?.newText);
      return additionalRange && additionalText !== undefined ? [{ range: additionalRange, newText: additionalText }] : [];
    }) : undefined;
    return [{ label: item.label, kind: typeof item.kind === 'number' ? item.kind : undefined, detail: text(item.detail),
      documentation: documentation(item.documentation), insertText: text(item.insertText), insertTextFormat: item.insertTextFormat === 2 ? 2 : 1,
      sortText: text(item.sortText, 512), filterText: text(item.filterText, 512),
      ...(editRange && newText !== undefined ? { textEdit: { range: editRange, newText } } : {}),
      ...(additionalTextEdits?.length ? { additionalTextEdits } : {}),
    }];
  });
}

class NativeLspClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private failure: Error | null = null;
  private buffer = Buffer.alloc(0);
  private sequence = 1;
  private pending = new Map<number, Pending>();
  private documents = new Map<string, Document>();
  private diagnosticsByUri = new Map<string, { version: number; items: NyDiagnostic[] }>();
  private diagnosticWaiters = new Map<string, Set<DiagnosticWaiter>>();
  private stderr = '';
  private pullDiagnostics = false;
  private closed = false;
  private readonly buildDirectory: string;
  private readonly configuration: Record<string, unknown>;

  constructor(private readonly root: string, cache: string, private readonly language: Language, private readonly options: NativeLanguageOptions) {
    this.buildDirectory = nativeBuildDirectory(root, cache);
    this.configuration = {
      cargo: { targetDir: join(this.buildDirectory, 'language'), buildScripts: { enable: false }, autoreload: false },
      checkOnSave: false, procMacro: { enable: false }, completion: { autoimport: { enable: false } },
    };
  }

  private validate(input: NyDocument): Document {
    if (!input || typeof input.path !== 'string' || typeof input.text !== 'string' || Buffer.byteLength(input.text) > MAX_DOCUMENT_BYTES) {
      throw new Error('Language tools require a source buffer of at most 1 MiB.');
    }
    const path = nativeSourcePath(this.root, input.path);
    const supported = this.language === 'rust' ? /\.rs$/i : /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i;
    if (!supported.test(path)) {
      throw new Error('The file is not supported by this language server.');
    }
    if (input.line !== undefined || input.character !== undefined) {
      const line = input.line ?? 0;
      const character = input.character ?? 0;
      const lines = input.text.split('\n');
      if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line < 0 || character < 0 || line >= lines.length || character > lines[line].length) {
        throw new Error('Language positions must refer to UTF-16 coordinates in the current buffer.');
      }
    }
    return { path: relative(this.root, path).split(sep).join('/'), uri: pathToFileURL(path).href, text: input.text,
      languageId: this.language === 'rust' ? 'rust' : /\.c$/i.test(path) ? 'c' : 'cpp', version: 0 };
  }

  private async synchronize(input: NyDocument): Promise<Document> {
    const document = this.validate(input);
    if (input.documents !== undefined && (!Array.isArray(input.documents) || input.documents.length > MAX_OPEN_DOCUMENTS)) {
      throw new Error('Too many open source buffers.');
    }
    const overlays: Document[] = [];
    let bytes = Buffer.byteLength(input.text);
    for (const overlay of input.documents ?? []) {
      if (!overlay || typeof overlay.path !== 'string' || typeof overlay.text !== 'string') {
        throw new Error('Invalid source overlay.');
      }
      if (!(this.language === 'rust' ? /\.rs$/i : /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i).test(overlay.path)) {
        continue;
      }
      const checked = this.validate(overlay);
      bytes += Buffer.byteLength(checked.text);
      if (bytes > 4 * MAX_DOCUMENT_BYTES) {
        throw new Error('Open source buffers exceed the analysis limit.');
      }
      if (checked.uri !== document.uri) {
        overlays.push(checked);
      }
    }
    await this.start(document);
    for (const overlay of overlays) {
      this.update(overlay);
    }
    return this.update(document);
  }

  async query(method: 'completion' | 'hover' | 'definition', input: NyDocument): Promise<unknown> {
    const document = await this.synchronize(input);
    return this.request(`textDocument/${method}`, { textDocument: { uri: document.uri }, position: { line: input.line ?? 0, character: input.character ?? 0 } });
  }

  async diagnostics(input: NyDocument): Promise<NyDiagnostic[]> {
    const document = await this.synchronize(input);
    if (this.pullDiagnostics) {
      const result = record(await this.request('textDocument/diagnostic', { textDocument: { uri: document.uri } }));
      return this.normalizeDiagnostics(result?.items, document.path);
    }
    const cached = this.diagnosticsByUri.get(document.uri);
    if (cached?.version === document.version) {
      return cached.items;
    }
    return new Promise((resolve, reject) => {
      const waiters = this.diagnosticWaiters.get(document.uri) ?? new Set<DiagnosticWaiter>();
      if (waiters.size >= 16) {
        reject(new Error('Language analysis is busy.'));
        return;
      }
      const waiter: DiagnosticWaiter = { version: document.version, resolve, reject, timer: setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error('Language analysis is still running.'));
      }, this.options.diagnosticTimeoutMs ?? 2000) };
      waiters.add(waiter);
      this.diagnosticWaiters.set(document.uri, waiters);
    });
  }

  private update(input: Document): Document {
    const prior = this.documents.get(input.uri);
    if (prior?.text === input.text) {
      return prior;
    }
    const next = { ...input, version: (prior?.version ?? 0) + 1 };
    this.documents.set(input.uri, next);
    this.diagnosticsByUri.delete(input.uri);
    this.notify(prior ? 'textDocument/didChange' : 'textDocument/didOpen', prior
      ? { textDocument: { uri: next.uri, version: next.version }, contentChanges: [{ text: next.text }] }
      : { textDocument: { uri: next.uri, version: next.version, languageId: next.languageId, text: next.text } });
    if (this.documents.size > MAX_OPEN_DOCUMENTS) {
      const oldest = this.documents.keys().next().value!;
      this.documents.delete(oldest);
      this.diagnosticsByUri.delete(oldest);
      this.notify('textDocument/didClose', { textDocument: { uri: oldest } });
    }
    return next;
  }

  private start(document: Document): Promise<void> {
    if (this.closed || this.failure) {
      return Promise.reject(this.failure ?? new Error('Language tools are closed.'));
    }
    if (this.ready) {
      return this.ready;
    }
    this.ready = (async () => {
      const tools = this.options.tools ?? nativeTools(this.options.environment);
      const executable = this.language === 'rust' ? tools.rustAnalyzer : tools.clangd;
      if (!executable) {
        throw new Error(`${this.language === 'rust' ? 'rust-analyzer' : 'clangd'} is not installed or is not on PATH.`);
      }
      const commands = existsSync(join(this.buildDirectory, 'debug', 'compile_commands.json')) ? 'debug' : existsSync(join(this.buildDirectory, 'release', 'compile_commands.json')) ? 'release' : 'debug';
      mkdirSync(join(this.buildDirectory, 'language'), { recursive: true });
      const args = this.language !== 'rust' ? ['--background-index=false', '--clang-tidy=false', '--header-insertion=never', '--enable-config=false', '-j=2', `--compile-commands-dir=${join(this.buildDirectory, commands)}`] : [];
      const child = spawn(executable, args, { cwd: this.root, windowsHide: true, stdio: 'pipe',
        env: { ...(this.options.environment ?? process.env), CARGO_TARGET_DIR: join(this.buildDirectory, 'language') } });
      this.child = child;
      child.stdout.on('data', (data: Buffer) => this.read(data));
      child.stderr.on('data', (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-4096); });
      child.stdin.on('error', (error) => this.fail(new Error(`Language server input failed: ${error.message}`)));
      child.on('error', (error) => this.fail(new Error(`Could not start language server: ${error.message}`)));
      child.on('exit', (code, signal) => { if (!this.closed) { this.fail(new Error(`Language server exited (${signal ?? code ?? 'unknown'}). ${this.stderr}`.trim())); } });
      const initialized = record(await this.request('initialize', { processId: process.pid, clientInfo: { name: 'Antimatter' }, rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: this.root.split(sep).pop() }],
        capabilities: { general: { positionEncodings: ['utf-16'] }, offsetEncoding: ['utf-16'], workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
          textDocument: { completion: { completionItem: { snippetSupport: true, insertReplaceSupport: true, documentationFormat: ['plaintext', 'markdown'] } }, hover: { contentFormat: ['plaintext', 'markdown'] }, publishDiagnostics: { versionSupport: true }, diagnostic: {} } },
        initializationOptions: this.language === 'rust' ? { ...this.configuration, ...(!existsSync(join(this.root, 'Cargo.toml')) ? { detachedFiles: [fileURLToPath(document.uri)] } : {}) } : { fallbackFlags: [this.language === 'c' ? '-std=c17' : '-std=c++20'], clangdFileStatus: false },
      }));
      const capabilities = record(initialized?.capabilities);
      if (capabilities?.positionEncoding && capabilities.positionEncoding !== 'utf-16') {
        throw new Error('The language server selected an unsupported position encoding.');
      }
      this.pullDiagnostics = !!capabilities?.diagnosticProvider;
      this.notify('initialized', {});
      if (this.language === 'rust') {
        this.notify('workspace/didChangeConfiguration', { settings: { 'rust-analyzer': this.configuration } });
      }
    })().catch((error: unknown) => { this.fail(error instanceof Error ? error : new Error(String(error))); throw this.failure; });
    return this.ready;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.pending.size >= 64) {
      return Promise.reject(new Error('Language server request limit reached.'));
    }
    const id = this.sequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.notify('$/cancelRequest', { id }); } catch { /* The process may already have exited. */ }
        reject(new Error(`Language server timed out during ${method}.`));
      }, this.options.requestTimeoutMs ?? 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  private notify(method: string, params: unknown): void { this.write({ jsonrpc: '2.0', method, params }); }
  private write(value: unknown): void {
    if (this.closed || this.failure || !this.child) {
      throw this.failure ?? new Error('Language server is unavailable.');
    }
    const payload = Buffer.from(JSON.stringify(value));
    if (payload.length > MAX_PACKET_BYTES || this.child.stdin.writableLength > MAX_PACKET_BYTES) {
      throw new Error('Language server input exceeds its buffer limit.');
    }
    this.child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.child.stdin.write(payload);
  }

  private normalizeDiagnostics(value: unknown, path: string): NyDiagnostic[] {
    return Array.isArray(value) ? value.slice(0, 500).flatMap((value) => {
      const item = record(value);
      const location = range(item?.range);
      const message = text(item?.message);
      return location && message ? [{ path, range: location, message, severity: typeof item?.severity === 'number' ? item.severity : 1, source: text(item?.source, 80) ?? (this.language === 'rust' ? 'rust-analyzer' : 'clangd') }] : [];
    }) : [];
  }
  private message(input: unknown): void {
    const message = record(input);
    if (!message) {
      throw new Error('Language server sent an invalid message.');
    }
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) { pending.reject(new Error(text(record(message.error)?.message, 2000) ?? 'Language request failed.')); }
        else { pending.resolve(message.result); }
      }
      return;
    }
    const params = record(message.params);
    if (message.method === 'textDocument/publishDiagnostics' && typeof params?.uri === 'string') {
      const document = this.documents.get(params.uri);
      if (!document || typeof params.version === 'number' && params.version !== document.version) {
        return;
      }
      const items = this.normalizeDiagnostics(params.diagnostics, document.path);
      this.diagnosticsByUri.set(params.uri, { version: document.version, items });
      for (const waiter of this.diagnosticWaiters.get(params.uri) ?? []) {
        if (waiter.version === document.version) {
          clearTimeout(waiter.timer); waiter.resolve(items); this.diagnosticWaiters.get(params.uri)?.delete(waiter);
        }
      }
    } else if (message.id !== undefined && typeof message.method === 'string') {
      let result: unknown;
      if (message.method === 'workspace/configuration') {
        result = Array.isArray(params?.items) ? params.items.slice(0, 64).map((value) => {
          const section = text(record(value)?.section) ?? '';
          const keys = section.replace(/^rust-analyzer\.?/, '').split('.').filter(Boolean);
          return keys.reduce<unknown>((value, key) => record(value)?.[key], this.configuration) ?? null;
        }) : [];
      } else if (message.method === 'workspace/workspaceFolders') {
        result = [{ uri: pathToFileURL(this.root).href, name: this.root.split(sep).pop() }];
      } else if (['window/workDoneProgress/create', 'client/registerCapability', 'client/unregisterCapability'].includes(message.method)) {
        result = null;
      } else if (message.method === 'workspace/applyEdit') {
        result = { applied: false, failureReason: 'Use an explicit editor action to change files.' };
      } else {
        this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } });
        return;
      }
      this.write({ jsonrpc: '2.0', id: message.id, result });
    }
  }
  private read(chunk: Buffer): void {
    if (this.closed || this.failure) {
      return;
    }
    try {
      if (this.buffer.length + chunk.length > MAX_PACKET_BYTES + MAX_HEADER_BYTES) {
        throw new Error('Language server output exceeds its buffer limit.');
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length) {
        const boundary = this.buffer.indexOf('\r\n\r\n');
        if (boundary < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) { throw new Error('Language server header is too large.'); }
          return;
        }
        const headers = this.buffer.subarray(0, boundary).toString('ascii').split('\r\n');
        const lengths = headers.filter((header) => /^Content-Length:/i.test(header));
        if (boundary > MAX_HEADER_BYTES || lengths.length !== 1 || !/^Content-Length:\s*\d+\s*$/i.test(lengths[0])) {
          throw new Error('Language server sent invalid framing.');
        }
        const length = Number(lengths[0].split(':')[1]);
        if (!Number.isSafeInteger(length) || length < 2 || length > MAX_PACKET_BYTES) { throw new Error('Invalid language packet size.'); }
        const end = boundary + 4 + length;
        if (this.buffer.length < end) { return; }
        const payload = this.buffer.subarray(boundary + 4, end).toString('utf8');
        this.buffer = this.buffer.subarray(end);
        this.message(JSON.parse(payload));
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    for (const waiters of this.diagnosticWaiters.values()) { for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(this.failure); } }
    this.pending.clear(); this.diagnosticWaiters.clear(); this.buffer = Buffer.alloc(0);
    const child = this.child;
    this.child = null;
    if (child) {
      // Some clangd versions keep waiting on stdin after SIGTERM. Close transport and
      // bound shutdown so restarting language tools cannot leave a subprocess behind.
      child.stdin.destroy();
      child.kill('SIGTERM');
      const forceStop = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 1500);
      child.once('close', () => { clearTimeout(forceStop); });
    }
  }
  dispose(): void { this.closed = true; this.fail(new Error('Language service was stopped.')); }
}

export class NativeLanguageServices {
  private closed = false;
  private clients = new Map<Language, NativeLspClient>();
  constructor(private readonly root: string, private readonly cacheDirectory: string, private readonly options: NativeLanguageOptions = {}) {}
  private client(document: NyDocument): NativeLspClient {
    if (this.closed) { throw new Error('Language services are closed.'); }
    if (!document || typeof document.path !== 'string') { throw new Error('A source path is required.'); }
    const language = /\.rs$/i.test(document.path) ? 'rust' : /\.c$/i.test(document.path) ? 'c' : 'cpp';
    let client = this.clients.get(language);
    if (!client) { client = new NativeLspClient(this.root, this.cacheDirectory, language, this.options); this.clients.set(language, client); }
    return client;
  }
  async completion(document: NyDocument): Promise<NyCompletionItem[]> { return nativeCompletionItems(await this.client(document).query('completion', document)); }
  async hover(document: NyDocument): Promise<NyHover | null> {
    const value = record(await this.client(document).query('hover', document));
    const contents = (Array.isArray(value?.contents) ? value.contents : [value?.contents]).slice(0, 16).map(documentation).filter((item): item is NonNullable<typeof item> => item !== undefined);
    const location = range(value?.range);
    return contents.length ? { contents, ...(location ? { range: location } : {}) } : null;
  }
  async definition(document: NyDocument): Promise<NyLocation[]> {
    const value = await this.client(document).query('definition', document);
    return (Array.isArray(value) ? value : [value]).slice(0, 100).flatMap((value) => {
      const item = record(value);
      const uri = text(item?.uri ?? item?.targetUri, 8192);
      const location = range(item?.range ?? item?.targetSelectionRange ?? item?.targetRange);
      if (!uri || !location) { return []; }
      try {
        const path = nativeSourcePath(this.root, fileURLToPath(uri));
        return [{ uri, range: location, path: relative(this.root, path).split(sep).join('/') }];
      } catch { return []; }
    });
  }
  diagnostics(document: NyDocument): Promise<NyDiagnostic[]> { return this.client(document).diagnostics(document); }
  async restart(): Promise<void> { this.dispose(); this.closed = false; }
  dispose(): void { this.closed = true; for (const client of this.clients.values()) { client.dispose(); } this.clients.clear(); }
}
