import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DapClient, type DapMessage } from './dap';
import type { Breakpoint, DebugEvents, DebugState, Frame, Variable } from './debug';

export interface NativeDebugSpec {
  root: string;
  /** Verified Cargo/CMake artifact and its application-owned build directory. */
  program: string;
  buildDirectory: string;
  debuggerPath: string;
  args?: string[];
  breakpoints: Breakpoint[];
}
const stopped = (): DebugState => ({ phase: 'stopped', reason: null, frames: [], variables: [], resolved: [], error: null });
const within = (root: string, path: string) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.slice(0, 4096).map(record) : [];
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const string = (value: unknown) => typeof value === 'string' ? value.slice(0, 16_384) : '';

/** LLDB's stdio adapter, with DAP launch/configuration ordering and per-stop thread identity. */
export class NativeDebugSession {
  state: DebugState = { ...stopped(), phase: 'starting' };
  private client: DapClient | null = null;
  private ended = false;
  private exitReported = false;
  private inspection = 0;
  private threadId: number | null = null;
  private root = '';
  private sources = new Set<string>();
  private desiredBreakpoints: Breakpoint[];
  private breakpointUpdate = Promise.resolve<Breakpoint[]>([]);
  private configured = false;
  private initialized = false;
  private initializeWaiter: { resolve(): void; reject(error: Error): void } | null = null;
  private pauseWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private breakpointIds = new Map<number, Breakpoint>();

  constructor(private readonly spec: NativeDebugSpec, private readonly events: DebugEvents) {
    this.desiredBreakpoints = structuredClone(spec.breakpoints);
  }

  async start(): Promise<DebugState> {
    this.publish({ phase: 'starting' });
    try {
      for (const path of [this.spec.root, this.spec.buildDirectory, this.spec.program, this.spec.debuggerPath]) {
        if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f]/.test(path)) throw new Error('Native debugging requires absolute project, build, program, and adapter paths.');
      }
      this.root = await realpath(this.spec.root);
      const buildDirectory = await realpath(this.spec.buildDirectory);
      const program = await realpath(this.spec.program);
      const adapter = await realpath(this.spec.debuggerPath);
      if (!(await stat(this.root)).isDirectory() || !(await stat(buildDirectory)).isDirectory() || !(await stat(program)).isFile() || !(await stat(adapter)).isFile() || !within(buildDirectory, program)) {
        throw new Error('The debug program must be a verified artifact in this project’s build directory.');
      }
      await access(adapter, constants.X_OK); await access(program, constants.X_OK);
      if (this.spec.args && (!Array.isArray(this.spec.args) || this.spec.args.length > 256 || this.spec.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')))) throw new Error('Invalid debug program arguments.');
      if (this.ended) throw new Error('Native debugging stopped.');
      this.client = new DapClient(adapter, this.root, {
        event: message => this.onEvent(message),
        error: error => { if (!this.ended) { this.publish({ error: error.message }); this.initializeWaiter?.reject(error); } },
        stderr: data => { if (!this.ended) this.events.onData(data); },
        exit: code => {
          if (this.ended) return;
          if (code && !this.exitReported) this.publish({ error: `Native debug adapter exited with code ${code}.` });
          this.reportExit(code ?? 1); void this.finish(false);
        },
      }, []);
      const capabilities = record(await this.client.request('initialize', {
        clientID: 'antimatter', clientName: 'Antimatter', adapterID: 'lldb', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
        supportsRunInTerminalRequest: false, supportsVariableType: true, supportsVariablePaging: true,
      }));
      const initialized = this.waitInitialized();
      void initialized.catch(() => undefined);
      const launch = this.request('launch', { program, cwd: this.root, args: this.spec.args ?? [], stopOnEntry: false, console: 'internalConsole',
        // Do not execute project-local .lldbinit files as an implicit part of opening a workspace.
        initCommands: ['settings set target.load-cwd-lldbinit false'],
      });
      void launch.catch(error => this.initializeWaiter?.reject(error));
      // Adapters may defer the launch response until after configurationDone.
      await initialized;
      const initialBreakpoints = this.desiredBreakpoints;
      await this.replaceBreakpoints(initialBreakpoints);
      if (capabilities.supportsConfigurationDoneRequest === true) await this.request('configurationDone', {});
      await launch;
      if (this.ended) return this.state;
      this.configured = true;
      if (this.desiredBreakpoints !== initialBreakpoints) await this.replaceBreakpoints(this.desiredBreakpoints);
      if (this.state.phase === 'starting') this.publish({ phase: 'running' });
      return this.state;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (!this.ended) this.publish({ error: error.message });
      await this.finish(true);
      throw error;
    }
  }

  async stop(): Promise<void> { await this.finish(true); }
  async pause(): Promise<DebugState> {
    if (this.state.phase !== 'running') return this.state;
    const threadId = await this.activeThread();
    const waiting = this.waitForPause(); void waiting.catch(() => undefined);
    await this.request('pause', { threadId }); await waiting;
    return this.state;
  }
  async step(command: 'continue' | 'next' | 'stepIn' | 'stepOut'): Promise<DebugState> {
    if (this.state.phase !== 'paused') return this.state;
    const epoch = this.inspection;
    await this.request(command, { threadId: await this.activeThread() });
    // Not every adapter sends continued. Do not erase an immediate later stopped event.
    if (!this.ended && epoch === this.inspection) this.running();
    return this.state;
  }
  async selectFrame(frameId: string): Promise<DebugState> {
    const frame = this.frame(frameId); const epoch = ++this.inspection;
    const variables = await this.locals(frame);
    if (!this.ended && epoch === this.inspection && this.state.phase === 'paused') this.publish({ selectedFrameId: frame.id, variables });
    return this.state;
  }
  async evaluate(expression: string, frameId?: string): Promise<string> {
    if (typeof expression !== 'string' || !expression.trim() || expression.length > 8192 || expression.includes('\0')) throw new Error('Enter an expression of at most 8192 characters.');
    const frame = this.frame(frameId ?? this.state.selectedFrameId ?? this.state.frames[0]?.id);
    const response = await this.request('evaluate', { expression, frameId: Number(frame.id), context: 'watch' });
    return string(response.result);
  }
  applyBreakpoints(breakpoints: Breakpoint[]): Promise<Breakpoint[]> {
    this.desiredBreakpoints = structuredClone(breakpoints);
    this.breakpointUpdate = this.breakpointUpdate.catch(() => []).then(() => this.ended || !this.configured ? this.state.resolved : this.replaceBreakpoints(breakpoints));
    return this.breakpointUpdate;
  }
  private request(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.ended || !this.client) return Promise.reject(new Error('Native debugger is no longer running.'));
    return this.client.request(command, args).then(record);
  }
  private frame(id?: string): Frame {
    if (this.state.phase !== 'paused') throw new Error('Nothing is paused.');
    const frame = this.state.frames.find(frame => frame.id === id);
    if (!frame) throw new Error('This stack frame is no longer available.');
    return frame;
  }
  private display(file: unknown): string {
    if (typeof file !== 'string' || !file) return '';
    const path = resolve(this.root, file); return within(this.root, path) ? relative(this.root, path).split(sep).join('/') : path;
  }
  private async activeThread(preferred?: unknown): Promise<number> {
    if (integer(preferred)) { this.threadId = preferred; return preferred; }
    const threads = list((await this.request('threads', {})).threads);
    const id = threads.find(thread => thread.id === this.threadId)?.id ?? threads[0]?.id;
    if (!integer(id)) throw new Error('The adapter has no active thread.');
    this.threadId = id; return id;
  }
  private async replaceBreakpoints(breakpoints: Breakpoint[]): Promise<Breakpoint[]> {
    if (!Array.isArray(breakpoints) || breakpoints.length > 4096) throw new Error('Too many native breakpoints.');
    const groups = new Map<string, Set<number>>();
    for (const entry of breakpoints) {
      if (!entry || typeof entry.file !== 'string' || entry.file.length > 4096 || /[\u0000-\u001f]/.test(entry.file) || !integer(entry.line) || entry.line < 1) throw new Error('Invalid native breakpoint.');
      // Breakpoints for another installed language are kept by the editor, not sent to LLDB.
      if (!/\.(c|cc|cpp|cxx|h|hh|hpp|hxx|rs)$/i.test(entry.file)) continue;
      const path = resolve(this.root, entry.file);
      if (!within(this.root, path) || !within(this.root, await realpath(path))) throw new Error('Native breakpoint is outside the project.');
      const lines = groups.get(path) ?? new Set<number>(); lines.add(entry.line); groups.set(path, lines);
    }
    const resolved: Breakpoint[] = []; this.breakpointIds.clear();
    for (const file of new Set([...this.sources, ...groups.keys()])) {
      const response = await this.request('setBreakpoints', { source: { path: file }, breakpoints: [...(groups.get(file) ?? [])].map(line => ({ line })), sourceModified: false });
      for (const breakpoint of list(response.breakpoints)) {
        if (!integer(breakpoint.line) || breakpoint.line < 1) continue;
        const location = { file: this.display(file), line: breakpoint.line };
        if (integer(breakpoint.id)) this.breakpointIds.set(breakpoint.id, location);
        if (breakpoint.verified === true) resolved.push(location);
        else if (breakpoint.message) this.events.onData(`Breakpoint ${location.file}:${location.line}: ${string(breakpoint.message)}\r\n`);
      }
    }
    this.sources = new Set(groups.keys()); this.publish({ resolved }); return resolved;
  }
  private onEvent(message: DapMessage): void {
    if (this.ended) return;
    const body = record(message.body);
    if (message.event === 'initialized') { this.initialized = true; this.initializeWaiter?.resolve(); }
    if (message.event === 'output' && typeof body.output === 'string') this.events.onData(body.output);
    if (message.event === 'continued') this.running();
    if (message.event === 'stopped') {
      this.publish({ phase: 'paused', frames: [], variables: [], selectedFrameId: undefined });
      const inspected = this.inspect(body);
      const epoch = this.inspection;
      void inspected.catch(cause => {
        if (!this.ended && this.inspection === epoch) { const error = cause instanceof Error ? cause : new Error(String(cause)); this.publish({ error: error.message }); this.settlePause(error); }
      });
    }
    if (message.event === 'breakpoint') {
      const breakpoint = record(body.breakpoint); const id = breakpoint.id;
      if (integer(id) && this.breakpointIds.has(id)) {
        const before = this.breakpointIds.get(id)!; const location = { ...before, line: integer(breakpoint.line) && breakpoint.line > 0 ? breakpoint.line : before.line };
        const resolved = this.state.resolved.filter(entry => entry.file !== before.file || entry.line !== before.line);
        if (body.reason !== 'removed' && breakpoint.verified === true) resolved.push(location);
        this.breakpointIds.set(id, location); this.publish({ resolved });
      }
    }
    if (message.event === 'exited') this.reportExit(integer(body.exitCode) ? body.exitCode : 1);
    if (message.event === 'terminated') void this.finish(false);
  }
  private running(): void {
    this.inspection++; this.publish({ phase: 'running', reason: null, frames: [], variables: [], selectedFrameId: undefined, error: null });
  }
  private async inspect(body: Record<string, unknown>): Promise<void> {
    const epoch = ++this.inspection; const threadId = await this.activeThread(body.threadId);
    const trace = await this.request('stackTrace', { threadId, startFrame: 0, levels: 40 });
    const frames: Frame[] = list(trace.stackFrames).filter(frame => integer(frame.id)).slice(0, 40).map(frame => ({
      id: String(frame.id), name: string(frame.name) || '(anonymous)', file: this.display(record(frame.source).path),
      line: integer(frame.line) ? frame.line : 0, column: integer(frame.column) ? frame.column : 0,
    }));
    const variables = frames[0] ? await this.locals(frames[0]) : [];
    if (this.ended || epoch !== this.inspection) return;
    this.publish({ phase: 'paused', reason: string(body.reason) || 'paused', frames, variables, selectedFrameId: frames[0]?.id, error: body.reason === 'exception' ? string(body.text) || string(body.description) || null : null });
    this.settlePause();
  }
  private async locals(frame: Frame): Promise<Variable[]> {
    const scopes = list((await this.request('scopes', { frameId: Number(frame.id) })).scopes).filter(scope => integer(scope.variablesReference) && scope.variablesReference > 0 && !scope.expensive).slice(0, 8);
    const variables: Variable[] = [];
    for (const scope of scopes) {
      const values = list((await this.request('variables', { variablesReference: scope.variablesReference, start: 0, count: 100 - variables.length })).variables);
      variables.push(...values.slice(0, 100 - variables.length).map(value => ({ name: string(value.name), value: string(value.value), type: string(value.type) })));
      if (variables.length >= 100) break;
    }
    return variables;
  }
  private waitInitialized(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => waiter.reject(new Error('Native adapter did not become ready for breakpoints.')), 15_000);
      const waiter = { resolve: () => { clearTimeout(timer); this.initializeWaiter = null; resolve(); }, reject: (error: Error) => { clearTimeout(timer); this.initializeWaiter = null; reject(error); } };
      this.initializeWaiter = waiter;
    });
  }
  private waitForPause(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => waiter.reject(new Error('The native program has not paused yet.')), 15_000);
      const waiter = { resolve: () => { clearTimeout(timer); this.pauseWaiters.delete(waiter); resolve(); }, reject: (error: Error) => { clearTimeout(timer); this.pauseWaiters.delete(waiter); reject(error); } };
      this.pauseWaiters.add(waiter);
    });
  }
  private settlePause(error?: Error): void { for (const waiter of this.pauseWaiters) error ? waiter.reject(error) : waiter.resolve(); }
  private publish(patch: Partial<DebugState>): void { this.state = { ...this.state, ...patch }; this.events.onState(this.state); }
  private reportExit(code: number): void { if (!this.exitReported) { this.exitReported = true; this.events.onExit({ code }); } }
  private async finish(disconnect: boolean): Promise<void> {
    if (this.ended) return;
    this.ended = true; this.inspection++;
    this.initializeWaiter?.reject(new Error('Native debugging stopped.')); this.settlePause(new Error('Native debugging stopped.'));
    const client = this.client; this.client = null;
    if (disconnect && client) await client.request('disconnect', { terminateDebuggee: true }, 1000).catch(() => undefined);
    client?.close(); this.publish({ phase: 'stopped', reason: null, frames: [], variables: [], resolved: [], selectedFrameId: undefined });
  }
}
