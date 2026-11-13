import { createServer } from 'node:net';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import type { IPty } from 'node-pty';
import { NyDebugSession } from './nyDebug';
import { NativeDebugSession, type NativeDebugSpec } from './nativeDebug';
export type { NativeDebugSpec } from './nativeDebug';

/**
 * A debugger, not a debugger-shaped toolbar.
 *
 * Node ships the V8 inspector, which is the same protocol Chrome DevTools speaks, so a real
 * debugger here is a WebSocket and a dozen commands rather than a new engine: spawn with
 * --inspect-brk, set breakpoints by file URL, and read call frames and scopes back when it
 * stops. Stepping, locals and the call stack are the actual thing.
 *
 * Ny uses its SDK's stdio DAP adapter and source-mapped NIL. Native Rust/C++ projects use
 * LLDB with a verified build artifact. All adapters expose the same editor controls.
 */

const DEBUGGABLE = new Set(['.js', '.mjs', '.cjs']);
const NY_DEBUGGABLE = new Set(['.ny', '.matrix', '.mat', '.nil']);

export const debuggable = (path: string): boolean =>
  DEBUGGABLE.has(extname(path).toLowerCase()) || NY_DEBUGGABLE.has(extname(path).toLowerCase());

export interface Frame {
  id: string;
  name: string;
  /** Workspace-relative when the file is inside the root, absolute when it is not. */
  file: string;
  line: number;
  column: number;
}

export interface Variable {
  name: string;
  value: string;
  type: string;
}

export interface Breakpoint {
  file: string;
  line: number;
}

export type DebugPhase = 'starting' | 'running' | 'paused' | 'stopped';

export interface DebugState {
  phase: DebugPhase;
  reason: string | null;
  frames: Frame[];
  variables: Variable[];
  /** Where breakpoints actually landed: V8 moves them to the next executable line. */
  resolved: Breakpoint[];
  error: string | null;
  selectedFrameId?: string;
}

export interface DebugEvents {
  onState(state: DebugState): void;
  onData(data: string): void;
  onExit(exit: { code: number; signal?: number }): void;
}

interface Session {
  socket: WebSocket;
  pty: IPty;
  root: string;
  nextId: number;
  pending: Map<number, { resolve(value: any): void; reject(error: Error): void }>
  state: DebugState;
  /**
   * scriptId → url, built from Debugger.scriptParsed.
   *
   * A call frame carries a url field, and for a CommonJS module it comes back empty — which is
   * how a stack ends up reading ':9' with no file. The scriptParsed events always have it, so
   * the map is the reliable answer and the frame's own url is only a fallback.
   */
  scripts: Map<string, string>;
  /**
   * --inspect-brk halts on the first statement, which is how breakpoints get set before any code
   * runs. Nobody asked to stop there, so the first halt is resumed straight through and the
   * session starts where the person actually put a breakpoint.
   */
  skipEntry: boolean;
  callFrames: Map<string, any>;
}

let events: DebugEvents | null = null;
let session: Session | null = null;
let adapterSession: NyDebugSession | NativeDebugSession | null = null;
let launchGeneration = 0;
let startingNode: IPty | null = null;

export const connect = (handlers: DebugEvents): void => {
  events = handlers;
};

export const state = (): DebugState =>
  adapterSession?.state ?? session?.state ?? { phase: 'stopped', reason: null, frames: [], variables: [], resolved: [], error: null };

const publish = (patch: Partial<DebugState>) => {
  if (!session) return;
  session.state = { ...session.state, ...patch };
  events?.onState(session.state);
};

/** An ephemeral port, asked for and released, so two debug runs never collide. */
const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });

/** The inspector takes a moment to bind after the process starts. */
async function inspectorUrl(port: number, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(600) });
      const targets = (await response.json()) as { webSocketDebuggerUrl?: string }[];
      const url = targets.find((target) => target.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
      if (url) return url;
      lastError = 'the process is up but exposes no debugger target';
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((wait) => setTimeout(wait, 120));
  }
  throw new Error(`The Node inspector never came up on port ${port} (${lastError}).`);
}

function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  if (!session) return Promise.reject(new Error('nothing is being debugged'));
  const id = session.nextId++;
  return new Promise((done, fail) => {
    session!.pending.set(id, { resolve: done, reject: fail });
    session!.socket.send(JSON.stringify({ id, method, params }));
  });
}

/** A relative path for anything under the root, so the UI can match it to an open tab. */
function displayPath(root: string, url: string): string {
  if (!url.startsWith('file://')) return url;
  try {
    const absolute = fileURLToPath(url);
    const rel = relative(root, absolute);
    return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : absolute;
  } catch {
    return url;
  }
}

/** V8 gives a preview of each value; this is the one-line form a variables pane wants. */
function describe(value: any): string {
  if (!value) return 'undefined';
  if (value.type === 'string') return JSON.stringify(value.value ?? '');
  if (value.unserializableValue) return String(value.unserializableValue);
  if ('value' in value && value.type !== 'object') return String(value.value);
  return value.description ?? value.className ?? value.type;
}

/** The locals of the frame we stopped in — the answer to "what is it, right now". */
async function localsOf(frame: any): Promise<Variable[]> {
  const local = (frame.scopeChain ?? []).find((scope: any) => scope.type === 'local');
  if (!local?.object?.objectId) return [];

  const result = await send('Runtime.getProperties', {
    objectId: local.object.objectId,
    ownProperties: true,
    generatePreview: true,
  });

  return (result.result ?? [])
    .filter((property: any) => property.value)
    .slice(0, 100)
    .map((property: any) => ({
      name: property.name,
      value: describe(property.value),
      type: property.value.type,
    }));
}

async function onPaused(payload: any): Promise<void> {
  if (!session) return;

  // The entry halt: no breakpoint was hit, and we have not run anything yet. Carry on.
  if (session.skipEntry && !(payload.hitBreakpoints ?? []).length) {
    session.skipEntry = false;
    void send('Debugger.resume');
    return;
  }
  session.skipEntry = false;

  const callFrames = payload.callFrames ?? [];
  const current = session;
  current.callFrames = new Map(callFrames.map((frame: any) => [frame.callFrameId, frame]));

  const frames: Frame[] = callFrames.slice(0, 40).map((frame: any, index: number) => ({
    id: frame.callFrameId ?? String(index),
    name: frame.functionName || '(anonymous)',
    file: displayPath(session!.root, session!.scripts.get(frame.location?.scriptId) || frame.url || ''),
    line: (frame.location?.lineNumber ?? 0) + 1,
    column: (frame.location?.columnNumber ?? 0) + 1,
  }));

  let variables: Variable[] = [];
  try {
    variables = callFrames[0] ? await localsOf(callFrames[0]) : [];
  } catch {
    // A frame can go stale if the program is resumed while we are asking; not worth failing over.
  }

  if (session === current) publish({ phase: 'paused', reason: payload.reason ?? 'paused', frames, variables, selectedFrameId: frames[0]?.id });
}

export interface DebugSpec {
  /** Absolute path of the file to run. */
  file: string;
  root: string;
  breakpoints: Breakpoint[];
  /** Arguments after the script, for a program that takes some. */
  args?: string[];
  /** Explicit SDK chosen in Antimatter's Ny settings; discovery is used when omitted. */
  nySdkPath?: string;
  /** Manifest selected within the open workspace; resolved again before compilation. */
  nilProjectPath?: string;
}

/** Called only with a verified artifact from the authorized native project build adapter. */
export async function startNative(spec: NativeDebugSpec): Promise<DebugState> {
  const generation = ++launchGeneration;
  await stopCurrent();
  if (generation !== launchGeneration) throw new Error('Debug launch was cancelled or superseded.');
  const current = new NativeDebugSession(spec, {
    onState: state => events?.onState(state),
    onData: data => events?.onData(data),
    onExit: exit => events?.onExit(exit),
  });
  adapterSession = current;
  return current.start();
}

export async function start(spec: DebugSpec): Promise<DebugState> {
  const generation = ++launchGeneration;
  await stopCurrent();
  const currentLaunch = () => {
    if (generation !== launchGeneration) throw new Error('Debug launch was cancelled or superseded.');
  };
  currentLaunch();

  if (spec.nilProjectPath || NY_DEBUGGABLE.has(extname(spec.file).toLowerCase())) {
    const current = new NyDebugSession(spec, {
      onState: (state) => events?.onState(state),
      onData: (data) => events?.onData(data),
      onExit: (exit) => events?.onExit(exit),
    });
    adapterSession = current;
    return current.start();
  }

  if (!debuggable(spec.file)) {
    throw new Error(
      `Debugging supports Ny and Matrix (.ny, .matrix, .mat, source-mapped .nil) and JavaScript (.js, .mjs, .cjs). ${extname(spec.file) || 'This file'} has no ` +
        `debug adapter here yet. Run it instead; the output still comes back.`
    );
  }

  const pty = await import('node-pty');
  currentLaunch();
  const port = await freePort();
  currentLaunch();

  const child = pty.spawn(
    process.execPath,
    [`--inspect-brk=${port}`, spec.file, ...(spec.args ?? [])],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: spec.root,
      // ELECTRON_RUN_AS_NODE turns Electron's own binary into plain Node, so a machine with no
      // system Node still debugs — the same trick the MCP servers are spawned with.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERM: 'xterm-256color', FORCE_COLOR: '1' } as Record<string, string>,
    }
  );
  startingNode = child;

  child.onData((data) => events?.onData(data));
  child.onExit(({ exitCode, signal }) => {
    events?.onExit({ code: exitCode, signal });
    if (session?.pty === child) {
      publish({ phase: 'stopped', reason: null, frames: [], variables: [] });
      session.socket.close();
      session = null;
    }
  });

  let url: string;
  try {
    url = await inspectorUrl(port);
    currentLaunch();
  } catch (error) {
    if (startingNode === child) startingNode = null;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    throw error;
  }

  const socket = new WebSocket(url);
  if (startingNode === child) startingNode = null;
  session = {
    socket,
    pty: child,
    root: resolve(spec.root),
    nextId: 1,
    pending: new Map(),
    state: { phase: 'starting', reason: null, frames: [], variables: [], resolved: [], error: null },
    scripts: new Map(),
    skipEntry: true,
    callFrames: new Map(),
  };

  socket.on('message', (raw: WebSocket.RawData) => {
    let message: any;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.id && session?.pending.has(message.id)) {
      const waiting = session.pending.get(message.id)!;
      session.pending.delete(message.id);
      message.error ? waiting.reject(new Error(message.error.message ?? 'inspector error')) : waiting.resolve(message.result);
      return;
    }

    if (message.method === 'Debugger.scriptParsed' && session) {
      const { scriptId, url } = message.params ?? {};
      if (scriptId && url) session.scripts.set(scriptId, url);
    }
    if (message.method === 'Debugger.paused') void onPaused(message.params);
    if (message.method === 'Debugger.resumed') {
      session?.callFrames.clear();
      publish({ phase: 'running', reason: null, frames: [], variables: [], selectedFrameId: undefined });
    }

    /**
     * Node does not exit while a debugger is attached — it prints "Waiting for the debugger to
     * disconnect" and sits there. So when it says it has finished, we let go, and the process
     * ends with its real exit code instead of hanging with the Debug button greyed out.
     */
    if (message.method === 'NodeRuntime.waitingForDisconnect' || message.method === 'Runtime.executionContextDestroyed') {
      try {
        session?.socket.close();
      } catch {
        /* already closing */
      }
    }
  });

  socket.on('error', (error: Error) => publish({ error: error.message }));

  await new Promise<void>((done, fail) => {
    socket.once('open', () => done());
    socket.once('error', fail);
  });

  await send('Runtime.enable');
  await send('Debugger.enable');
  // Node-specific, and the whole reason a finished program can exit: it tells us when it is
  // done rather than leaving us to guess from the output.
  await send('NodeRuntime.notifyWhenWaitingForDisconnect', { enabled: true }).catch(() => {
    // An older Node without the domain. Runtime.executionContextDestroyed covers it.
  });
  // A breakpoint in a .py file is not V8's business; passing it along would have it echoed back
  // as "resolved" in a session that can never hit it.
  const resolved = await applyBreakpoints(spec.breakpoints.filter((entry) => DEBUGGABLE.has(extname(entry.file).toLowerCase())));

  publish({ phase: 'running', resolved });
  // --inspect-brk holds at the first line until this; breakpoints are in place by now.
  await send('Runtime.runIfWaitingForDebugger');

  return state();
}

/**
 * Sets every breakpoint from scratch and reports where they landed. V8 moves a breakpoint to the
 * next executable line, which is why the UI draws the resolved position rather than the asked-for
 * one — a marker sitting on a blank line that never fires is a bug report waiting to happen.
 */
export async function applyBreakpoints(breakpoints: Breakpoint[]): Promise<Breakpoint[]> {
  if (adapterSession) return adapterSession.applyBreakpoints(breakpoints);
  if (!session) return [];

  const resolved: Breakpoint[] = [];
  for (const breakpoint of breakpoints.filter((entry) => DEBUGGABLE.has(extname(entry.file).toLowerCase()))) {
    const absolute = resolve(session.root, breakpoint.file);
    try {
      const result = await send('Debugger.setBreakpointByUrl', {
        url: pathToFileURL(absolute).toString(),
        lineNumber: Math.max(0, breakpoint.line - 1),
        columnNumber: 0,
      });
      const location = result.locations?.[0];
      resolved.push({
        file: breakpoint.file,
        line: location ? location.lineNumber + 1 : breakpoint.line,
      });
    } catch {
      // An unresolvable breakpoint is not fatal: the file may not be loaded yet.
      resolved.push(breakpoint);
    }
  }

  publish({ resolved });
  return resolved;
}

const step = async (method: string): Promise<DebugState> => {
  if (session?.state.phase !== 'paused') return state();
  await send(method);
  return state();
};

export const resume = () => adapterSession ? adapterSession.step('continue') : step('Debugger.resume');
export const stepOver = () => adapterSession ? adapterSession.step('next') : step('Debugger.stepOver');
export const stepInto = () => adapterSession ? adapterSession.step('stepIn') : step('Debugger.stepInto');
export const stepOut = () => adapterSession ? adapterSession.step('stepOut') : step('Debugger.stepOut');

export async function pause(): Promise<DebugState> {
  if (adapterSession) return adapterSession.pause();
  if (session?.state.phase === 'running') await send('Debugger.pause');
  return state();
}

export async function selectFrame(frameId: string): Promise<DebugState> {
  if (adapterSession) return adapterSession.selectFrame(frameId);
  const current = session;
  if (!current || current.state.phase !== 'paused') throw new Error('Nothing is paused.');
  const frame = current.callFrames.get(frameId);
  if (!frame) throw new Error('This stack frame is no longer available.');
  const variables = await localsOf(frame);
  if (session === current && current.state.phase === 'paused' && current.callFrames.has(frameId)) {
    publish({ selectedFrameId: frameId, variables });
  }
  return state();
}

/** Evaluates an expression in the frame we are stopped in — the point of stopping there. */
export async function evaluate(expression: string, frameId?: string): Promise<string> {
  if (adapterSession) return adapterSession.evaluate(expression, frameId);
  if (!session || session.state.phase !== 'paused') throw new Error('Nothing is paused.');
  const frame = frameId ?? session.state.selectedFrameId ?? session.state.frames[0]?.id;
  if (!frame) throw new Error('There is no frame to evaluate in.');

  const result = await send('Debugger.evaluateOnCallFrame', {
    callFrameId: frame,
    expression,
    returnByValue: false,
    generatePreview: true,
  });
  if (result.exceptionDetails) return result.exceptionDetails.exception?.description ?? 'threw';
  return describe(result.result);
}

export async function stop(): Promise<void> {
  launchGeneration++;
  await stopCurrent();
}

async function stopCurrent(): Promise<void> {
  const starting = startingNode;
  startingNode = null;
  try { starting?.kill(); } catch { /* already gone */ }
  if (adapterSession) {
    const current = adapterSession;
    adapterSession = null;
    await current.stop();
  }
  if (!session) return;
  const { socket, pty } = session;
  session = null;

  try {
    socket.close();
  } catch {
    /* already closing */
  }
  try {
    pty.kill();
  } catch {
    /* already gone */
  }
  events?.onState({ phase: 'stopped', reason: null, frames: [], variables: [], resolved: [], error: null });
}
