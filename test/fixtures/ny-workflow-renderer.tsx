/** Actual Code workspace with a synthetic host. No processes, network or workspace writes. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { diagnosticCount } from '@codemirror/lint';
import { EnvironmentPage } from '../../renderer/src/environment/EnvironmentPage';
import { FileTree } from '../../renderer/src/environment/FileTree';
import { actions, useEnvironment, type CodeWorkspaceContext, type EnvironmentState } from '../../renderer/src/environment/store';
import { initializeAppearance, saveAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE, type AppearanceAPI } from '../../src/api/appearance';
import type { NyBuildResult } from '../../src/api/ny';
import type { NilProjectDescription, NilProjectLanguage } from '../../src/api/nilProject';

let appearance = { ...DEFAULT_APPEARANCE };
const appearanceApi: AppearanceAPI = { initial: appearance, get: async () => appearance, update: async patch => (appearance = { ...appearance, ...patch }), onChanged: () => () => {} };
initializeAppearance(appearanceApi);
const files: Record<string, string> = {
  'src/main.ny': 'module demo\nfn main() -> i32\n    return 0\nend fn',
  'src/main.matrix': 'book application\n\nmain returns override integer begin paragraph\n    say "Hello from Matrix"\n    give 0\nend paragraph\n',
  'src/helper.ny': 'pub fn helper() -> i32\n    return 42\nend fn',
  'src/alternate.mat': 'main returns override integer begin paragraph\n    give 1\nend paragraph\n',
  'nil.project.json': JSON.stringify({ schema: 'nil.project.v1', name: 'matrix-demo', entry: 'src/main.matrix', includePaths: ['src'], outputDirectory: 'build' }, null, 2),
};
let root = '/synthetic/empty', serial = 1;
let state: EnvironmentState;
let saveFailure = false, compilerFailure = false, held = false, sdk = true, invalidProject = false;
let resolveBuild: ((value: NyBuildResult) => void) | null = null;
let holdWrite = false; let resolveWrite: (() => void) | null = null;
let project: NilProjectDescription | null = null;
let setChat: (context: CodeWorkspaceContext) => void = () => {};
const calls = { create: [] as unknown[], write: [] as string[], writeRoots: [] as string[], open: [] as unknown[], bind: [] as unknown[], picker: [] as string[], stop: 0, check: [] as string[], build: [] as unknown[], inspect: [] as string[], run: [] as unknown[], custom: [] as string[], cancel: 0, debug: [] as string[] };
const status = () => ({ available: sdk, lsp: sdk, compiler: sdk, debugger: sdk, interpreter: sdk, builder: sdk, family: 'nil' as const, sdkPath: sdk ? '/synthetic/nil-sdk' : null, configuredPath: '', message: sdk ? 'NIL Framework SDK ready' : 'Choose a NIL Framework SDK to enable language tools' });
const result = (): NyBuildResult => compilerFailure ? { success: false, output: 'NIL0001: Synthetic compiler error', artifact: null,
  diagnostics: [{ path: state.activePath?.endsWith('.mat') ? 'src/alternate.mat' : 'src/main.matrix', range: { start: { line: 3, character: 4 }, end: { line: 3, character: 10 } }, message: 'Synthetic compiler error', severity: 1 }] } : { success: true, output: 'Checked the entrypoint and source imports.', artifact: null, diagnostics: [] };
const run = (command: string) => ({ id: `fixture-${serial++}`, spec: { command, args: [], cwd: root, label: command }, startedAt: 1, pid: 42, exit: { code: 0 } });
const check = async (path = '') => { calls.check.push(path); return held ? await new Promise<NyBuildResult>(resolve => { resolveBuild = resolve; }) : result(); };
const build = async (path = '', target = 'vm') => { calls.build.push({ path, target }); const next = result(); return next.success ? { ...next, artifact: target === 'native' ? 'build/matrix-demo' : 'build/matrix-demo.nil' } : next; };
const entries = () => project && root === project.projectDirectory ? [{ name: 'nil.project.json', path: 'nil.project.json', kind: 'file' }, { name: 'src', path: 'src', kind: 'directory' }] : [];
const noDebug = { phase: 'stopped', reason: null, frames: [], variables: [], resolved: [], error: null };
window.electronAPI = {
  nativeProject: { inspect: async () => null, board: async () => ({ root, revision: 'empty', cards: [], edges: [] }), onProgress: () => () => {}, cancel: async () => {} },
  workspace: { chooseDirectory: async () => '/synthetic/existing' },
  environment: {
    open: async (directory: string | null, threadId?: string) => { calls.open.push({ directory, threadId }); root = directory ?? root; return { root, entries: entries() }; },
    list: async (path: string) => path === 'src' ? Object.keys(files).filter(name => name.startsWith('src/')).map(name => ({ name: name.slice(4), path: name, kind: 'file' })) : entries(),
    read: async (path: string) => ({ path, text: path.endsWith('.nil') ? '' : files[path] ?? '', modified: serial, binary: path.endsWith('.nil') }),
    unchanged: async () => true,
    write: async (path: string, text: string) => { if (saveFailure) throw new Error('Synthetic save failure'); calls.write.push(path); calls.writeRoots.push(root); if (holdWrite) { holdWrite = false; await new Promise<void>(resolve => { resolveWrite = resolve; }); } files[path] = text; return { path, text, modified: ++serial, binary: false }; },
    suggestCommand: async (path: string) => `ny run ${JSON.stringify(path)}`,
    debuggable: async () => true,
    run: async (command: string) => { calls.custom.push(command); return run(command); },
    stop: async () => { calls.stop++; }, debugStop: async () => noDebug, resize: async () => {}, input: async () => {},
  },
  nilProject: {
    describe: async () => { if (invalidProject) throw new Error('Invalid nil.project.json: entry is required'); return root === project?.projectDirectory ? project : null; },
    create: async (name: string, language: NilProjectLanguage) => {
      calls.create.push({ name, language }); const entry = language === 'ny' ? 'src/main.ny' : 'src/main.matrix';
      const directory = `/synthetic/generated/${name}`;
      project = { schema: 'nil.project.description.v1', projectFile: `${directory}/nil.project.json`, projectDirectory: directory, name, entry: `${directory}/${entry}`, language: language === 'ny' ? 'ny' : 'matrix', includePaths: [`${directory}/src`], outputDirectory: `${directory}/build`, vmOutput: `${directory}/build/${name}.nil`, nativeOutput: `${directory}/build/${name}`, sdkPath: '/synthetic/nil-sdk', analysis: { disabledRules: [], warningsAsErrors: false } };
      return { root: directory, entry };
    },
    check, build,
    run: async (path: string, target: string) => { calls.run.push({ path, target }); if (compilerFailure) throw new Error('Synthetic compile failure'); return run('nilbuild'); },
    debug: async (path: string) => { calls.debug.push(path); return noDebug; },
  },
  ny: {
    status: async () => status(), restart: async () => status(), chooseSdk: async () => { sdk = !sdk; return status(); },
    check, build,
    run: async (path: string) => { calls.run.push({ path }); if (compilerFailure) throw new Error('Synthetic compile failure'); return run('nilinterpreter'); },
    cancel: async () => { calls.cancel++; resolveBuild?.({ success: false, output: 'Cancelled', artifact: null, diagnostics: [] }); resolveBuild = null; },
    completion: async () => [], hover: async () => null, definition: async () => [], symbols: async () => [],
    inspectNil: async (path: string) => {
      calls.inspect.push(path);
      return { path, modified: serial, format: 'binary', version: 5, flags: 0, byteLength: 200, moduleName: 'demo', library: false, debugInfo: true,
        functions: [{ name: 'main', parameters: [], generics: [], returnType: 'i32', inline: false, test: false, declarationLine: 3, annotations: [], instructions: [{ offset: 0, opcode: 'RET', operands: ['0'], debugLine: 4, source: { path: `${root}/src/main.matrix`, workspacePath: 'src/main.matrix', line: 4 } }] }], constants: [], types: [], tests: [], embeddedSources: [], dependencies: [], warnings: [] };
    },
  },
  onEnvironmentExit: () => () => {}, onEnvironmentOutput: () => () => {}, onDebugState: () => () => {},
} as unknown as typeof window.electronAPI;

function Fixture() {
  state = useEnvironment();
  const [chat, updateChat] = useState<CodeWorkspaceContext>(); setChat = updateChat;
  return <div style={{ height: '100vh', display: 'flex', minWidth: 0 }}><aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface-2"><div className="border-b border-line px-3 py-3 text-sm font-semibold text-ink">Antimatter <span className="text-primary">Code</span></div><FileTree /></aside><EnvironmentPage onLeave={() => {}} workspaceContext={chat}
    onChooseWorkspace={async () => { calls.picker.push(chat?.threadId ?? ''); if (chat) updateChat({ ...chat, path: '/synthetic/picked', available: true, reason: undefined }); return '/synthetic/picked'; }}
    onBindWorkspace={async path => { calls.bind.push({ threadId: chat?.threadId, path }); if (chat) updateChat({ ...chat, path, available: true, reason: undefined }); return path; }} /></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
const view = () => { const editor = document.querySelector('.cm-editor'); return editor ? EditorView.findFromDOM(editor as HTMLElement) : null; };
Object.assign(window, { nyWorkflowSmoke: {
  click: (label: string) => {
    const button = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label);
    if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`);
    button.click();
  },
  change: (label: string, text: string) => {
    const input = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  },
  compilerFailure: (value: boolean) => { compilerFailure = value; }, saveFailure: (value: boolean) => { saveFailure = value; }, invalidProject: (value: boolean) => { invalidProject = value; },
  hold: (value: boolean) => { held = value; }, release: () => { resolveBuild?.(result()); resolveBuild = null; },
  holdSave: () => { holdWrite = true; }, releaseSave: () => { resolveWrite?.(); resolveWrite = null; }, saveAll: actions.saveAll,
  edit: (path: string) => { actions.edit(path, (state.files.find(file => file.path === path)?.text ?? '') + (/\.(matrix|mat)$/i.test(path) ? '\n!!! unsaved' : '\n// unsaved')); },
  openFile: actions.openFile, open: actions.open, setCommand: actions.setCommand, refresh: actions.refreshProject,
  chat: (context: CodeWorkspaceContext) => setChat(context), setBuilding: actions.setNyBuilding,
  theme: (light: boolean) => saveAppearance({ theme: light ? 'light' : 'dark', secondaryAccent: '#7954c9' }),
  snapshot: () => ({ state, calls, writePending: !!resolveWrite, diagnostics: view() ? diagnosticCount(view()!.state) : 0, text: document.body.textContent, commandInput: (document.querySelector('input[placeholder="command to run"]') as HTMLInputElement | null)?.value,
    buttons: [...document.querySelectorAll('button')].map(button => ({ text: button.textContent?.trim(), label: button.getAttribute('aria-label'), disabled: button.disabled })) }),
} });
