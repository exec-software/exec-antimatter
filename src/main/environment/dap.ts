import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_HEADER = 8 * 1024;
const MAX_BODY = 4 * 1024 * 1024;

export interface DapMessage {
  type: string;
  seq?: number;
  request_seq?: number;
  command?: string;
  success?: boolean;
  message?: string;
  event?: string;
  body?: any;
}

/** Byte framing matters: a UTF-8 source path is not its JavaScript string length. */
export class DapReader {
  private buffer = Buffer.alloc(0);
  private length: number | null = null;

  push(chunk: Buffer): DapMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: DapMessage[] = [];
    for (;;) {
      if (this.length === null) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (this.buffer.length > MAX_HEADER) throw new Error('Ny debugger sent an oversized DAP header.');
          break;
        }
        if (end > MAX_HEADER) throw new Error('Ny debugger sent an oversized DAP header.');
        const headers = this.buffer.subarray(0, end).toString('ascii').split('\r\n');
        const lengths = headers.filter((line) => /^Content-Length:/i.test(line));
        if (lengths.length !== 1 || !/^Content-Length:\s*[1-9][0-9]*\s*$/i.test(lengths[0])) {
          throw new Error('Ny debugger sent an invalid Content-Length.');
        }
        this.length = Number(lengths[0].slice(lengths[0].indexOf(':') + 1).trim());
        if (!Number.isSafeInteger(this.length) || this.length > MAX_BODY) {
          throw new Error('Ny debugger sent an oversized DAP message.');
        }
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.length) break;
      const body = this.buffer.subarray(0, this.length);
      this.buffer = this.buffer.subarray(this.length);
      this.length = null;
      const value = JSON.parse(body.toString('utf8')) as DapMessage;
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          (value.type !== 'response' && value.type !== 'event' && value.type !== 'request')) {
        throw new Error('Ny debugger sent an invalid DAP message.');
      }
      messages.push(value);
    }
    return messages;
  }
}

export interface DapHandlers {
  event(message: DapMessage): void;
  error(error: Error): void;
  stderr(data: string): void;
  exit(code: number | null, signal: NodeJS.Signals | null): void;
}

/** One owned adapter process. Every outstanding request settles on timeout or process exit. */
export class DapClient {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private closed = false;
  private pending = new Map<number, {
    resolve(body: any): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();

  constructor(executable: string, cwd: string, private handlers: DapHandlers) {
    this.child = spawn(executable, ['--dap'], { cwd, stdio: 'pipe', windowsHide: true });
    const reader = new DapReader();
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      try {
        for (const message of reader.push(chunk)) {
          if (message.type === 'response' && Number.isSafeInteger(message.request_seq)) {
            const pending = this.pending.get(message.request_seq!);
            if (!pending) continue;
            this.pending.delete(message.request_seq!);
            clearTimeout(pending.timer);
            message.success === true ? pending.resolve(message.body ?? {})
              : pending.reject(new Error(message.message || `Ny debugger rejected ${message.command ?? 'request'}.`));
          } else if (message.type === 'event') this.handlers.event(message);
          else if (message.type === 'request') throw new Error('Ny debugger requested an unsupported reverse operation.');
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stderr.on('data', (data: Buffer) => this.handlers.stderr(data.toString('utf8')));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.rejectPending(new Error(`Ny debugger exited${code === null ? '' : ` (${code})`}.`));
      this.handlers.exit(code, signal);
    });
  }

  request(command: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Ny debugger is no longer running.'));
    const seq = this.nextId++;
    const body = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }), 'utf8');
    if (body.length > 1024 * 1024) return Promise.reject(new Error('Ny debugger request is too large.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Ny debugger timed out while handling ${command}.`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]), (error) => {
        if (error) this.fail(error);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error('Ny debugging stopped.'));
    this.child.stdin.end();
    this.child.kill();
    // A foreign call can block the VM's cooperative disconnect. Stop must still finish.
    const kill = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    }, 1_000);
    kill.unref();
    this.child.once('exit', () => clearTimeout(kill));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.handlers.error(error);
    this.close();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
