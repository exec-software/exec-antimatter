import { resolve } from 'node:path';
import { NATIVE_PROJECT_IPC, type NativeBuildRequest, type NativeBuildResult, type NativeProjectAPI, type NativeSourceRequest, type NativeTemplateRequest, type SaveProjectBoard, type BoardEdge } from '../../api/nativeProject';
import type { NyDocument } from '../../api/ny';
import type { Breakpoint, DebugState } from './debug';
import type { RunSpec, RunState } from './exec';
import { buildNativeProject, createNativeProject, createNativeSource, inspectNativeProject, nativeBuildDirectory, nativeTools } from './nativeProjects';
import { connectProjectCards, readProjectBoard, saveProjectBoard } from './projectBoard';

export interface NativeDebugLaunch { root: string; buildDirectory: string; program: string; args: string[]; breakpoints: Breakpoint[]; debuggerPath: string }
export type NativeLanguageService = NativeProjectAPI['language'] & { dispose(): void };
interface Options {
  ipc: { handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void };
  assertTrusted(event: unknown): void;
  root(): string;
  cacheDirectory(): string;
  send(channel: string, payload: unknown): void;
  run(spec: RunSpec): Promise<RunState>;
  debug(spec: NativeDebugLaunch): Promise<DebugState>;
  createLanguageService(root: string, cache: string): NativeLanguageService;
}

/** The host owns processes and files; renderers can only request actions in the active Code folder. */
export function registerNativeProjectIpc(options: Options): { dispose(): void; cancel(): void; busy(): boolean } {
  let controller: AbortController | null = null;
  let language: { root: string; service: NativeLanguageService } | null = null;
  const root = () => {
    const value = options.root();
    if (!value) throw new Error('Open a Code folder first.');
    return value;
  };
  const checkRoot = (expected: string) => {
    const current = root();
    if (typeof expected !== 'string' || resolve(expected) !== resolve(current)) throw new Error('The Code folder changed. Retry in the current project.');
    return current;
  };
  const handle = (name: string, callback: (...args: any[]) => unknown) => options.ipc.handle(name, (event, ...args) => {
    options.assertTrusted(event);
    return callback(...args);
  });
  const languageService = () => {
    const current = root();
    if (!language || language.root !== current) {
      language?.service.dispose();
      language = { root: current, service: options.createLanguageService(current, options.cacheDirectory()) };
    }
    return language.service;
  };
  const build = async (input: NativeBuildRequest): Promise<NativeBuildResult> => {
    if (!input || typeof input !== 'object') throw new Error('Invalid native build request.');
    const current = checkRoot(input.root);
    if (controller) throw new Error('A native project action is already running. Stop it before starting another.');
    const owned = new AbortController(); controller = owned;
    try {
      const result = await buildNativeProject(current, options.cacheDirectory(), input,
        (output) => options.send(NATIVE_PROJECT_IPC.progress, { root: current, action: input.action, output }), owned.signal);
      checkRoot(current);
      return result;
    } finally {
      if (controller === owned) controller = null;
    }
  };
  const program = (result: NativeBuildResult, target?: string) => {
    if (!result.success) throw new Error(result.cancelled ? 'Build cancelled.' : 'Build failed. Review the project output.');
    const choices = result.artifacts.filter((artifact) => artifact.executable && (!target || artifact.name === target));
    if (!choices.length) throw new Error('This build produced no runnable program. Choose an executable target.');
    if (choices.length > 1) throw new Error(`Choose a program target: ${choices.map((artifact) => artifact.name).join(', ')}.`);
    return choices[0];
  };
  const cancel = () => controller?.abort();
  handle(NATIVE_PROJECT_IPC.inspect, (source?: string) => inspectNativeProject(root(), options.cacheDirectory(), source));
  handle(NATIVE_PROJECT_IPC.create, (input: NativeTemplateRequest) => {
    if (!input) throw new Error('Invalid project template.');
    checkRoot(input.root); return createNativeProject(input);
  });
  handle(NATIVE_PROJECT_IPC.createSource, (input: NativeSourceRequest) => {
    if (!input) throw new Error('Invalid source template.');
    checkRoot(input.root); return createNativeSource(input);
  });
  handle(NATIVE_PROJECT_IPC.build, build);
  handle(NATIVE_PROJECT_IPC.run, async (input: NativeBuildRequest) => {
    const built = await build({ ...input, action: 'build' });
    const artifact = program(built, input.target);
    checkRoot(input.root);
    const run = await options.run({ command: artifact.path, args: input.args ?? [], cwd: built.root, label: artifact.name });
    return { build: built, run };
  });
  handle(NATIVE_PROJECT_IPC.debug, async (input: NativeBuildRequest, breakpoints: Breakpoint[]) => {
    const debuggerPath = nativeTools().debugger;
    if (!debuggerPath) throw new Error('Install lldb-dap and add it to PATH to debug Rust or C++.');
    const built = await build({ ...input, action: 'build', profile: 'debug' });
    const artifact = program(built, input.target);
    checkRoot(input.root);
    return options.debug({ root: built.root, buildDirectory: nativeBuildDirectory(built.root, options.cacheDirectory()), program: artifact.path, args: input.args ?? [], breakpoints, debuggerPath });
  });
  handle(NATIVE_PROJECT_IPC.cancel, cancel);
  handle(NATIVE_PROJECT_IPC.board, () => readProjectBoard(root()));
  handle(NATIVE_PROJECT_IPC.saveBoard, (input: SaveProjectBoard) => {
    if (!input) throw new Error('Invalid project board.');
    return saveProjectBoard(checkRoot(input.root), input);
  });
  handle(NATIVE_PROJECT_IPC.connectCards, (input: SaveProjectBoard & { edge: BoardEdge; sourceRevision: string }) => {
    if (!input) throw new Error('Invalid project connection.');
    return connectProjectCards(checkRoot(input.root), input);
  });
  handle(NATIVE_PROJECT_IPC.completion, (document: NyDocument) => languageService().completion(document));
  handle(NATIVE_PROJECT_IPC.hover, (document: NyDocument) => languageService().hover(document));
  handle(NATIVE_PROJECT_IPC.definition, (document: NyDocument) => languageService().definition(document));
  handle(NATIVE_PROJECT_IPC.diagnostics, (document: NyDocument) => languageService().diagnostics(document));
  handle(NATIVE_PROJECT_IPC.restart, () => languageService().restart());
  return { cancel, busy: () => !!controller, dispose: () => { cancel(); language?.service.dispose(); language = null; } };
}
