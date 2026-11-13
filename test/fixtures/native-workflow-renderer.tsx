import { createRoot } from 'react-dom/client';
import { EnvironmentPage } from '../../renderer/src/environment/EnvironmentPage';
import { actions, dirtyFilePaths, environmentSnapshot, useEnvironment } from '../../renderer/src/environment/store';
import { initializeAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import type { NativeBuildRequest, NativeBuildResult, NativeBuildProgress, ProjectBoard } from '../../src/api/nativeProject';

initializeAppearance({ initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, update: async (patch) => ({ ...DEFAULT_APPEARANCE, ...patch }), onChanged: () => () => {} });
let root = '/fixture/rust-app', revision = 1;
const files = new Map([['src/main.rs', 'fn main() { println!("hello"); }\n'], ['Cargo.toml', '[package]\nname="demo"\nversion="0.1.0"\nedition="2021"\n']]);
let board: ProjectBoard = { root, revision: 'empty', cards: [], edges: [] };
let failSave = false, compilerFailure = false, conflict = false;
const calls: Array<{ method: string; input?: unknown }> = [];
const progress = new Set<(event: NativeBuildProgress) => void>();
const file = (path: string) => ({ path, text: files.get(path) ?? '', size: (files.get(path) ?? '').length, modified: revision, revision: String(revision), binary: false });
const build = async (input: NativeBuildRequest): Promise<NativeBuildResult> => {
  calls.push({ method: input.action, input });
  progress.forEach((cb) => cb({ root, action: input.action, output: 'Building native project…\n' }));
  return { root, action: input.action, success: !compilerFailure, cancelled: false, exitCode: compilerFailure ? 1 : 0, output: compilerFailure ? 'error: synthetic Rust error' : 'Build complete',
    buildDirectory: '/fixture/cache', artifacts: [{ name: 'demo', path: '/fixture/cache/demo', executable: true }],
    diagnostics: compilerFailure ? [{ path: 'src/main.rs', message: 'Synthetic Rust error', severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } }] : [] };
};
const noDebug = { phase: 'stopped', reason: null, frames: [], variables: [], resolved: [], error: null };
window.electronAPI = {
  environment: {
    open: async (directory: string | null) => { root = directory ?? root; return { root, entries: [] }; }, list: async () => [], read: async (path: string) => file(path), unchanged: async () => true,
    write: async (path: string, text: string) => { if (failSave) throw new Error('Synthetic save conflict'); calls.push({ method: 'save', input: path }); files.set(path, text); revision++; return file(path); },
    suggestCommand: async () => 'cargo run', debuggable: async () => false, stop: async () => {}, debugStop: async () => noDebug, input: async () => {}, resize: async () => {},
  },
  nativeProject: {
    inspect: async (source?: string) => ({ root, name: 'Rust application', kind: 'cargo', source: source ?? null, buildDirectory: '/fixture/cache',
      tools: { cargo: '/tools/cargo', rustc: '/tools/rustc', cmake: '/tools/cmake', ctest: '/tools/ctest', cpp: '/tools/clang++', rustAnalyzer: '/tools/rust-analyzer', clangd: '/tools/clangd', debugger: '/tools/lldb-dap' } }),
    board: async () => board,
    saveBoard: async (input) => {
      if (conflict) { conflict = false; board = { ...board, revision: String(++revision) }; return { saved: false, board }; }
      if (input.expectedRevision !== board.revision) return { saved: false, board };
      board = { root, revision: String(++revision), cards: input.cards, edges: input.edges }; return { saved: true, board };
    },
    createSource: async (input) => {
      if (files.has(input.path)) throw new Error('Source already exists');
      calls.push({ method: 'createSource', input }); files.set(input.path, `pub fn ${input.name}() {}\n`); return { path: input.path };
    },
    connectCards: async (input) => {
      const card = input.cards.find((card) => card.id === input.edge.from)!;
      calls.push({ method: 'connect', input }); files.set(card.path, files.get(card.path) + '\nmod helper;\n');
      board = { root, revision: String(++revision), cards: input.cards, edges: [...input.edges, input.edge] }; return { saved: true, board };
    },
    build,
    run: async (input) => ({ build: await build(input), run: { id: 'native-run', spec: { command: '/fixture/cache/demo', args: input.args ?? [], cwd: root, label: 'demo' }, startedAt: 1, pid: 1, exit: { code: 0 } } }),
    debug: async (input, breakpoints) => { calls.push({ method: 'debug', input: { ...input, breakpoints } }); return noDebug; },
    cancel: async () => { calls.push({ method: 'cancel' }); }, onProgress: (cb) => { progress.add(cb); return () => progress.delete(cb); },
    language: { restart: async () => {}, completion: async () => [], definition: async () => [], hover: async () => null, diagnostics: async () => [] },
  },
  nilProject: { describe: async () => null },
  ny: { status: async () => ({ available: false, compiler: false, lsp: false, debugger: false }), cancel: async () => {} },
  onEnvironmentOutput: () => () => {}, onEnvironmentExit: () => () => {}, onDebugState: () => () => {},
} as unknown as typeof window.electronAPI;

function Fixture() {
  useEnvironment();
  return <div className="flex h-screen min-w-0"><EnvironmentPage onLeave={() => {}} /></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
Object.assign(window, { nativeSmoke: {
  open: () => actions.openFile('src/main.rs'),
  edit: () => actions.edit('src/main.rs', 'fn main() { println!("edited"); }\n'),
  failSave: (value: boolean) => { failSave = value; },
  compilerFailure: (value: boolean) => { compilerFailure = value; },
  conflict: () => { conflict = true; },
  click: (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
    if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`); button.click();
  },
  change: (label: string, value: string) => {
    const item = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    if (!item) throw new Error(`Field unavailable: ${label}`);
    const prototype = item.tagName === 'SELECT' ? HTMLSelectElement.prototype : item.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(item, value);
    item.dispatchEvent(new Event(item.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  },
  snapshot: () => ({ state: environmentSnapshot(), dirty: dirtyFilePaths(), board, files: Object.fromEntries(files), calls, text: document.body.innerText,
    cards: [...document.querySelectorAll('[aria-label^="Source card "]')].map((item) => item.getAttribute('aria-label')) }),
} });
