import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NyDiagnostic, NyDocument } from '../../api/ny';
import { requireNyTool, type NyToolchainOptions } from './ny';

export const NY_MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_PACKET_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;
const MAX_DOCUMENTS = 64;
const MAX_QUEUE = 64;
const REQUEST_TIMEOUT_MS = 8000;
export type NyLanguageMethod = 'completion' | 'hover' | 'definition' | 'documentSymbol';
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface OpenDocument { version: number; text: string }

/** A workspace-scoped stdio client for nillsp (Ny and Matrix), with legacy Ny SDK support. */
export class NyLanguageServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private closed = false;
  private failed: Error | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private documents = new Map<string, OpenDocument>();
  private structural = new Map<string, NyDiagnostic[]>();
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private stderr = '';

  constructor(private readonly root: string, private readonly options: NyToolchainOptions = {}) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('NIL language service is closed.'));
    if (this.queued >= MAX_QUEUE) return Promise.reject(new Error('NIL language service is busy; retry shortly.'));
    this.queued++;
    const operation = this.queue.catch(() => undefined).then(async () => {
      if (this.closed) throw new Error('NIL language service is closed.');
      if (this.failed) throw this.failed;
      return work();
    });
    this.queue = operation.finally(() => { this.queued--; });
    // The queue is bookkeeping; each caller owns its operation rejection.
    void this.queue.catch(() => undefined);
    return operation;
  }

  query(method: NyLanguageMethod, document: NyDocument): Promise<unknown> {
    if (!['completion', 'hover', 'definition', 'documentSymbol'].includes(method)) return Promise.reject(new Error('Unsupported NIL language query.'));
    return this.enqueue(async () => {
      const uri = this.validate(document);
      await this.start();
      this.update(uri, document.text);
      const params = method === 'documentSymbol' ? { textDocument: { uri } } : {
        textDocument: { uri }, position: { line: document.line ?? 0, character: document.character ?? 0 },
      };
      return this.request(`textDocument/${method}`, params);
    });
  }

  /** Structural LSP diagnostics are opt-in; compiler-backed Check owns authoritative errors. */
  diagnostics(document: NyDocument, options: { structural?: boolean } = {}): Promise<NyDiagnostic[]> {
    if (!options.structural) {
      try { this.validate(document); return Promise.resolve([]); } catch (error) { return Promise.reject(error); }
    }
    return this.enqueue(async () => {
      const uri = this.validate(document);
      await this.start();
      this.update(uri, document.text);
      // Ny publishes diagnostics synchronously before replying to the next request.
      await this.request('textDocument/documentSymbol', { textDocument: { uri } });
      return this.structural.get(uri) ?? [];
    });
  }

  close(path: string): Promise<void> {
    return this.enqueue(async () => {
      const uri = this.validate({ path, text: '' });
      if (!this.documents.delete(uri)) return;
      this.structural.delete(uri);
      this.notify('textDocument/didClose', { textDocument: { uri } });
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('NIL language service is closed.'));
    this.documents.clear(); this.structural.clear();
  }

  private validate(document: NyDocument): string {
    if (!document || typeof document.path !== 'string' || typeof document.text !== 'string') throw new Error('A Ny or Matrix source path and text are required.');
    const path = resolve(this.root, document.path);
    const local = relative(resolve(this.root), path);
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || resolve(this.root, local) !== path || !/\.(?:ny|matrix|mat)$/i.test(path)) throw new Error('NIL language queries must target a .ny, .matrix, or .mat file in the workspace.');
    if (Buffer.byteLength(document.text, 'utf8') > NY_MAX_DOCUMENT_BYTES) throw new Error('NIL language queries support files up to 1 MiB.');
    for (const position of [document.line, document.character]) if (position !== undefined && (!Number.isSafeInteger(position) || position < 0)) throw new Error('NIL positions must be nonnegative UTF-16 coordinates.');
    return pathToFileURL(path).href;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const executable = requireNyTool(this.root, 'lsp', this.options);
      const child = spawn(executable, [], { cwd: this.root, windowsHide: true, stdio: 'pipe', env: this.options.environment ?? process.env });
      this.child = child;
      child.stdout.on('data', (data: Buffer) => this.read(data));
      child.stderr.on('data', (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-4096); });
      child.on('error', (error) => this.fail(new Error(`Unable to start NIL language server: ${error.message}`)));
      child.on('exit', (code, signal) => {
        if (!this.closed && !this.failed) this.fail(new Error(`NIL language server exited (${signal ?? code ?? 'unknown'}). ${this.stderr}`.trim()));
      });
      child.stdin.on('error', (error) => this.fail(new Error(`NIL language server input failed: ${error.message}`)));
      await this.request('initialize', {
        processId: process.pid, rootUri: pathToFileURL(resolve(this.root)).href,
        capabilities: { textDocument: { completion: { completionItem: { snippetSupport: false } }, documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
      });
      this.notify('initialized', {});
    })();
    return this.ready;
  }

  private update(uri: string, text: string): void {
    const existing = this.documents.get(uri);
    if (existing?.text === text) return;
    if (existing) {
      const version = existing.version + 1;
      this.documents.set(uri, { version, text });
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    } else {
      if (this.documents.size >= MAX_DOCUMENTS) {
        const oldest = this.documents.keys().next().value!;
        this.documents.delete(oldest); this.structural.delete(oldest);
        this.notify('textDocument/didClose', { textDocument: { uri: oldest } });
      }
      this.documents.set(uri, { version: 1, text });
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: /\.(?:matrix|mat)$/i.test(new URL(uri).pathname) ? 'matrix' : 'ny', version: 1, text } });
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`NIL language server timed out during ${method}.`)), REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: done, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) { this.fail(error as Error); }
    });
  }

  private notify(method: string, params: unknown): void { this.write({ jsonrpc: '2.0', method, params }); }

  private write(message: unknown): void {
    if (this.closed || this.failed || !this.child) throw this.failed ?? new Error('NIL language server is unavailable.');
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > MAX_PACKET_BYTES || this.child.stdin.writableLength > MAX_PACKET_BYTES) throw new Error('NIL language server input exceeded its buffer limit.');
    this.child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.child.stdin.write(payload);
  }

  private read(data: Buffer): void {
    if (this.closed || this.failed) return;
    try {
      if (this.buffer.length + data.length > MAX_PACKET_BYTES + MAX_HEADER_BYTES) throw new Error('NIL language server output exceeded its buffer limit.');
      this.buffer = Buffer.concat([this.buffer, data]);
      while (this.buffer.length) {
        const boundary = this.buffer.indexOf('\r\n\r\n');
        if (boundary < 0) { if (this.buffer.length > MAX_HEADER_BYTES) throw new Error('NIL language server sent an invalid header.'); return; }
        if (boundary > MAX_HEADER_BYTES) throw new Error('NIL language server sent an oversized header.');
        const fields = this.buffer.subarray(0, boundary).toString('ascii').split('\r\n');
        const lengths = fields.filter((line) => /^Content-Length:/i.test(line));
        if (lengths.length !== 1 || !/^Content-Length:\s*\d+\s*$/i.test(lengths[0])) throw new Error('NIL language server sent invalid framing.');
        const length = Number(lengths[0].split(':')[1]);
        if (!Number.isSafeInteger(length) || length < 2 || length > MAX_PACKET_BYTES) throw new Error('NIL language server sent an invalid packet size.');
        const end = boundary + 4 + length;
        if (this.buffer.length < end) return;
        const message = JSON.parse(this.buffer.subarray(boundary + 4, end).toString('utf8')) as Record<string, any>;
        this.buffer = this.buffer.subarray(end);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('NIL language server sent an invalid response.');
        if (typeof message.id === 'number' && !message.method) {
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(`NIL language server: ${String(message.error.message ?? 'request failed').slice(0, 2000)}`));
            else pending.resolve(message.result);
          }
        } else if (message.method === 'textDocument/publishDiagnostics') {
          const params = message.params;
          if (params && typeof params.uri === 'string' && this.documents.has(params.uri) && Array.isArray(params.diagnostics)) {
            this.structural.set(params.uri, params.diagnostics.slice(0, 500));
          }
        } else if (message.id !== undefined && message.method) {
          this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } });
        }
      }
    } catch (error) { this.fail(error as Error); }
  }

  private fail(error: Error): void {
    this.failed ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failed); }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.child?.kill();
    this.child = null;
  }
}
