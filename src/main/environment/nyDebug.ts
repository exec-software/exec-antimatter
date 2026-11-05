import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { DapClient, type DapMessage } from './dap';
import { nyCompileArgs, requireNyTool, resolveNyToolchain } from './ny';
import { buildNilProject, describeNilProject, nilProjectCompileArgs } from './nilProjects';
import type { Breakpoint, DebugEvents, DebugSpec, DebugState, Frame, Variable } from './debug';

const execute = promisify(execFile);
const stopped = (): DebugState => ({ phase: 'stopped', reason: null, frames: [], variables: [], resolved: [], error: null });

function displayPath(root: string, file: unknown): string {
  if (typeof file !== 'string' || !file) return '';
  const absolute = resolve(root, file);
  const local = relative(root, absolute);
  return local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
    ? local.split(sep).join('/') : absolute;
}

/** Ny's VM DAP runs source-mapped NIL, never an approximation or native executable attach. */
export class NyDebugSession {
  state: DebugState = { ...stopped(), phase: 'starting' };
  private readonly controller = new AbortController();
  private client: DapClient | null = null;
  private directory: string | null = null;
  private ended = false;
  private exitReported = false;
  private sources = new Set<string>();
  private inspection = 0;
  private pauseWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private breakpointUpdate = Promise.resolve<Breakpoint[]>([]);
  private desiredBreakpoints: Breakpoint[];

  constructor(private readonly spec: DebugSpec, private readonly events: DebugEvents) {
    this.desiredBreakpoints = spec.breakpoints;
  }

  async start(): Promise<DebugState> {
    this.publish({ phase: 'starting' });
    try {
      const options = { sdkPath: this.spec.nySdkPath };
      const sdk = resolveNyToolchain(this.spec.root, options);
      const debuggerTool = requireNyTool(this.spec.root, 'debugger', options);
      const project = this.spec.nilProjectPath
        ? await describeNilProject(this.spec.root, this.spec.nilProjectPath, options, this.controller.signal) : null;
      if (this.spec.nilProjectPath && !project) throw new Error('The NIL project manifest is no longer available.');
      const source = project?.entry ?? this.spec.file;
      let program = resolve(source);
      if (/\.(ny|matrix|mat)$/i.test(program)) {
        if (project) {
          this.events.onData('Checking project before debugging…\r\n');
          const checked = await buildNilProject(this.spec.root, project.projectFile, 'check', options, this.controller.signal);
          if (checked.output) this.events.onData(checked.output + '\r\n');
          if (!checked.success) throw new Error('Project check failed. Resolve the reported problems before debugging.');
        }
        const compiler = requireNyTool(this.spec.root, 'compiler', options);
        this.directory = await mkdtemp(join(tmpdir(), 'antimatter-ny-debug-'));
        this.controller.signal.throwIfAborted();
        program = join(this.directory, 'program.nil');
        this.events.onData('Compiling with source maps…\r\n');
        try {
          const result = await execute(compiler, project ? nilProjectCompileArgs(project, program, sdk, { debugInfo: true }) : nyCompileArgs(source, program, {
            debugInfo: true,
            sdkPath: sdk.sdkPath ?? undefined,
          }), {
            cwd: this.spec.root,
            signal: this.controller.signal,
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
          });
          if (result.stdout) this.events.onData(result.stdout);
          if (result.stderr) this.events.onData(result.stderr);
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          if (!this.ended && failure.stdout) this.events.onData(failure.stdout);
          if (!this.ended && failure.stderr) this.events.onData(failure.stderr);
          throw new Error(`NIL debug compilation failed: ${(failure.stderr || failure.message).slice(0, 4000)}`);
        }
      }
      this.controller.signal.throwIfAborted();
      this.client = new DapClient(debuggerTool, this.spec.root, {
        event: (message) => this.onEvent(message),
        error: (error) => {
          if (!this.ended) this.publish({ error: error.message });
        },
        stderr: (data) => { if (!this.ended) this.events.onData(data); },
        exit: (code) => {
          if (this.ended) return;
          if (code && !this.exitReported) this.publish({ error: `Ny debugger exited with code ${code}.` });
          this.reportExit(code ?? 1);
          void this.finish();
        },
      });
      await this.client.request('initialize', {
        clientID: 'antimatter', adapterID: 'ny', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
      });
      await this.client.request('launch', {
        program, cwd: resolve(this.spec.root), args: this.spec.args ?? [], stopOnEntry: true,
      });
      await this.replaceBreakpoints(this.desiredBreakpoints);
      await this.client.request('configurationDone');
      return this.state;
    } catch (error) {
      const message = this.controller.signal.aborted ? 'NIL debugging stopped.' : (error as Error).message;
      if (!this.ended) this.publish({ error: message });
      await this.finish();
      // Stop may have arrived while mkdtemp was resolving.
      await this.cleanup();
      throw new Error(message);
    }
  }

  async stop(): Promise<void> { await this.finish(); }

  async pause(): Promise<DebugState> {
    if (this.state.phase !== 'running') return this.state;
    const paused = this.waitForPause();
    // A cooperative pause can time out before its request response arrives.
    void paused.catch(() => undefined);
    try {
      await this.request('pause', { threadId: 1 });
      await paused;
    } catch (error) {
      // The wait is rejected on stop as well; observe it if the request failed first.
      void paused.catch(() => undefined);
      throw error;
    }
    return this.state;
  }

  async step(command: 'continue' | 'next' | 'stepIn' | 'stepOut'): Promise<DebugState> {
    if (this.state.phase !== 'paused') return this.state;
    await this.request(command, { threadId: 1 });
    return this.state;
  }

  async selectFrame(frameId: string): Promise<DebugState> {
    const frame = this.frame(frameId);
    const epoch = ++this.inspection;
    const variables = await this.locals(frame);
    if (!this.ended && this.state.phase === 'paused' && epoch === this.inspection) {
      this.publish({ selectedFrameId: frame.id, variables });
    }
    return this.state;
  }

  async evaluate(expression: string, frameId?: string): Promise<string> {
    if (typeof expression !== 'string' || !expression.trim() || expression.length > 8192) {
      throw new Error('Enter a Ny name or member expression of at most 8192 characters.');
    }
    const frame = this.frame(frameId ?? this.state.selectedFrameId ?? this.state.frames[0]?.id);
    const result = await this.request('evaluate', { expression, frameId: Number(frame.id), context: 'watch' });
    return String(result.result ?? '');
  }

  applyBreakpoints(breakpoints: Breakpoint[]): Promise<Breakpoint[]> {
    this.desiredBreakpoints = breakpoints;
    this.breakpointUpdate = this.breakpointUpdate.catch(() => []).then(async () => {
      if (this.ended || this.state.phase === 'starting') return this.state.resolved;
      const wasRunning = this.state.phase === 'running';
      if (wasRunning) await this.pause();
      const resume = wasRunning && this.state.reason === 'pause';
      try { return await this.replaceBreakpoints(breakpoints); }
      finally { if (resume && !this.ended) await this.step('continue'); }
    });
    return this.breakpointUpdate;
  }

  private frame(id?: string): Frame {
    if (this.state.phase !== 'paused') throw new Error('Nothing is paused.');
    const frame = this.state.frames.find((item) => item.id === id);
    if (!frame) throw new Error('This stack frame is no longer available.');
    return frame;
  }

  private request(command: string, args: Record<string, unknown>): Promise<any> {
    if (this.ended || !this.client) return Promise.reject(new Error('Ny debugger is no longer running.'));
    return this.client.request(command, args);
  }

  private async replaceBreakpoints(breakpoints: Breakpoint[]): Promise<Breakpoint[]> {
    if (!Array.isArray(breakpoints) || breakpoints.length > 4096) throw new Error('Too many Ny breakpoints.');
    const groups = new Map<string, number[]>();
    for (const entry of breakpoints) {
      if (!entry || typeof entry.file !== 'string' || !/\.(ny|matrix|mat)$/i.test(entry.file)) continue;
      if (!Number.isSafeInteger(entry.line) || entry.line < 1) throw new Error('Ny breakpoint lines must be positive integers.');
      const file = resolve(this.spec.root, entry.file);
      groups.set(file, [...(groups.get(file) ?? []), entry.line]);
    }
    const resolved: Breakpoint[] = [];
    for (const file of new Set([...this.sources, ...groups.keys()])) {
      const result = await this.request('setBreakpoints', {
        source: { path: file }, breakpoints: (groups.get(file) ?? []).map((line) => ({ line })),
      });
      for (const breakpoint of result.breakpoints ?? []) {
        if (breakpoint.verified && Number.isInteger(breakpoint.line)) {
          resolved.push({ file: displayPath(this.spec.root, file), line: breakpoint.line });
        } else if (breakpoint.message) {
          this.events.onData(`Breakpoint ${displayPath(this.spec.root, file)}:${breakpoint.line ?? '?'}: ${breakpoint.message}\r\n`);
        }
      }
    }
    this.sources = new Set(groups.keys());
    this.publish({ resolved });
    return resolved;
  }

  private onEvent(message: DapMessage): void {
    if (this.ended) return;
    const body = message.body ?? {};
    if (message.event === 'output' && typeof body.output === 'string') this.events.onData(body.output);
    if (message.event === 'continued') {
      this.inspection++;
      this.publish({ phase: 'running', reason: null, frames: [], variables: [], selectedFrameId: undefined, error: null });
    }
    if (message.event === 'stopped') {
      const exception = body.reason === 'exception' && typeof body.text === 'string' ? body.text : null;
      void this.inspect(String(body.reason ?? 'paused'), exception).catch((error) => {
        if (!this.ended) {
          this.publish({ phase: 'paused', error: (error as Error).message });
          this.settlePause(error as Error);
        }
      });
    }
    if (message.event === 'exited') this.reportExit(Number.isInteger(body.exitCode) ? body.exitCode : 1);
    if (message.event === 'terminated') void this.finish();
  }

  private async inspect(reason: string, error: string | null): Promise<void> {
    const epoch = ++this.inspection;
    const result = await this.request('stackTrace', { threadId: 1, startFrame: 0, levels: 40 });
    const frames: Frame[] = (result.stackFrames ?? []).slice(0, 40).map((frame: any) => ({
      id: String(frame.id), name: String(frame.name ?? '(anonymous)'),
      file: displayPath(this.spec.root, frame.source?.path),
      line: Number.isInteger(frame.line) ? frame.line : 0,
      column: Number.isInteger(frame.column) ? frame.column : 0,
    }));
    const variables = frames[0] ? await this.locals(frames[0]) : [];
    if (this.ended || epoch !== this.inspection) return;
    this.publish({ phase: 'paused', reason, frames, variables, selectedFrameId: frames[0]?.id, error });
    this.settlePause();
  }

  private async locals(frame: Frame): Promise<Variable[]> {
    const result = await this.request('scopes', { frameId: Number(frame.id) });
    const scopes = (result.scopes ?? []).filter((scope: any) => scope.variablesReference > 0 && !scope.expensive);
    const variables: Variable[] = [];
    for (const scope of scopes.slice(0, 8)) {
      const result = await this.request('variables', { variablesReference: scope.variablesReference });
      for (const value of (result.variables ?? []).slice(0, 100 - variables.length)) {
        variables.push({ name: String(value.name), value: String(value.value ?? ''), type: String(value.type ?? '') });
      }
      if (variables.length >= 100) break;
    }
    return variables;
  }

  private waitForPause(): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(timer); this.pauseWaiters.delete(waiter); resolve(); },
        reject: (error: Error) => { clearTimeout(timer); this.pauseWaiters.delete(waiter); reject(error); },
      };
      const timer = setTimeout(() => waiter.reject(new Error('Ny has not paused yet; a blocking operation may still be running.')), 15_000);
      this.pauseWaiters.add(waiter);
    });
  }

  private settlePause(error?: Error): void {
    for (const waiter of this.pauseWaiters) error ? waiter.reject(error) : waiter.resolve();
  }

  private publish(patch: Partial<DebugState>): void {
    this.state = { ...this.state, ...patch };
    this.events.onState(this.state);
  }

  private reportExit(code: number): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.events.onExit({ code });
  }

  private async finish(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.controller.abort();
    this.inspection++;
    this.settlePause(new Error('NIL debugging stopped.'));
    this.client?.close();
    this.publish({ phase: 'stopped', reason: null, frames: [], variables: [], selectedFrameId: undefined, resolved: [] });
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    const directory = this.directory;
    this.directory = null;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
