import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildNativeProject, createNativeProject, createNativeSource, inspectNativeProject, nativeBuildCommands, nativeSourcePath, type NativeCommand } from '../src/main/environment/nativeProjects';
import { connectProjectCards, readProjectBoard, saveProjectBoard } from '../src/main/environment/projectBoard';
import * as files from '../src/main/environment/files';
import { registerNativeProjectIpc } from '../src/main/environment/nativeProjectIpc';
import { NATIVE_PROJECT_IPC } from '../src/api/nativeProject';
import type { NativeBuildRequest, NativeTools } from '../src/api/nativeProject';

const tools: NativeTools = { cargo: '/tools/cargo', rustc: '/tools/rustc', cmake: '/tools/cmake', ctest: '/tools/ctest', cpp: '/tools/clang++', rustAnalyzer: null, clangd: null, debugger: null };
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'antimatter-native-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'); mkdirSync(root); files.useRoot(root);
  return { directory, root, cache: join(directory, 'build-cache') };
}
const request = (root: string, patch: Partial<NativeBuildRequest> = {}): NativeBuildRequest => ({ root, action: 'build', profile: 'debug', ...patch });

test('Cargo and CMake plans use literal argv and keep build products out of source', (t) => {
  const { root, cache } = fixture(t);
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="demo"\n');
  let project = inspectNativeProject(root, cache, undefined, tools)!;
  assert.equal(project.kind, 'cargo');
  const cargo = nativeBuildCommands(project, request(root, { action: 'test', profile: 'release', target: 'demo' }));
  assert.deepEqual(cargo[0].args.slice(0, 3), ['test', '--manifest-path', join(root, 'Cargo.toml')]);
  assert.ok(cargo[0].args.includes('--target-dir'));
  assert.ok(cargo[0].args.includes('--release'));
  assert.throws(() => nativeBuildCommands(project, request(root, { target: '--help;whoami' })), /target/);
  rmSync(join(root, 'Cargo.toml')); writeFileSync(join(root, 'CMakeLists.txt'), 'project(Demo)');
  project = inspectNativeProject(root, cache, undefined, tools)!;
  const cmake = nativeBuildCommands(project, request(root, { action: 'test' }));
  assert.deepEqual(cmake.map((command) => command.executable), ['/tools/cmake', '/tools/cmake', '/tools/ctest']);
  assert.ok(cmake[0].args.includes('-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'));
  assert.ok(cmake[2].args.includes('--no-tests=error'));
  assert.ok(cmake.every((command) => command.cwd === root));
  assert.throws(() => inspectNativeProject(root, join(root, 'cache'), undefined, tools), /outside/);
});

test('Cargo build stream handles interleaved stderr, diagnostics and executable artifacts', async (t) => {
  const { root, cache } = fixture(t);
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="demo"\n');
  const project = inspectNativeProject(root, cache, undefined, tools)!;
  const binary = join(project.buildDirectory, 'debug', 'demo');
  let streamed = '';
  const result = await buildNativeProject(root, cache, request(root), (text) => { streamed += text; }, undefined, async (_command, output) => {
    writeFileSync(binary, 'fixture executable');
    const artifact = JSON.stringify({ reason: 'compiler-artifact', executable: binary, target: { name: 'demo' }, profile: { test: false } });
    output(artifact.slice(0, 30), 'stdout'); output('Compiling demo\n', 'stderr'); output(artifact.slice(30) + '\n', 'stdout');
    output(JSON.stringify({ reason: 'compiler-message', message: { message: 'unused item', rendered: 'warning: unused item\n', level: 'warning', spans: [{ is_primary: true, file_name: 'src/main.rs', line_start: 2, line_end: 2, column_start: 1, column_end: 3 }] } }) + '\n');
    return 0;
  }, tools);
  assert.equal(result.success, true);
  assert.equal(result.artifacts[0].path, binary);
  assert.equal(result.diagnostics[0].path, 'src/main.rs');
  assert.equal(result.diagnostics[0].severity, 2);
  assert.match(streamed, /Compiling demo/); assert.match(streamed, /warning: unused/);
  assert.doesNotMatch(streamed, /compiler-artifact/);
});

test('failed build stops later actions; cancellation prevents spawning; source arguments stay literal', async (t) => {
  const { root, cache } = fixture(t);
  const source = 'weird $(touch injected).cpp'; writeFileSync(join(root, source), 'int main() {}');
  const calls: NativeCommand[] = [];
  const runner = async (command: NativeCommand, output: (text: string) => void) => { calls.push(command); output(`${join(root, source)}:1:1: error: missing token\n`); return 1; };
  const result = await buildNativeProject(root, cache, request(root, { source, action: 'test' }), () => {}, undefined, runner, tools);
  assert.equal(result.success, false); assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes(join(root, source)));
  assert.equal(existsSync(join(root, 'injected')), false);
  assert.equal(result.diagnostics[0].path, source);
  const controller = new AbortController(); controller.abort(); calls.length = 0;
  const cancelled = await buildNativeProject(root, cache, request(root, { source }), () => {}, controller.signal, runner, tools);
  assert.equal(cancelled.cancelled, true); assert.equal(calls.length, 0);
});

test('project/source templates create usable source without replacing hand edits', (t) => {
  const { root } = fixture(t);
  const rust = createNativeProject({ root, directory: 'rust_app', name: 'rust_app', language: 'rust' });
  assert.match(readFileSync(join(rust.root, 'Cargo.toml'), 'utf8'), /edition = "2021"/);
  assert.match(readFileSync(join(rust.root, rust.entry), 'utf8'), /#\[test\]/);
  const cpp = createNativeProject({ root, directory: 'cpp_app', name: 'cpp_app', language: 'cpp' });
  assert.match(readFileSync(join(cpp.root, 'CMakeLists.txt'), 'utf8'), /add_test/);
  createNativeSource({ root: rust.root, path: 'src/helper.rs', name: 'helper', language: 'rust' });
  writeFileSync(join(rust.root, 'src/helper.rs'), 'handwritten');
  assert.throws(() => createNativeSource({ root: rust.root, path: 'src/helper.rs', name: 'helper', language: 'rust' }), /EEXIST/);
  assert.equal(readFileSync(join(rust.root, 'src/helper.rs'), 'utf8'), 'handwritten');
  assert.throws(() => createNativeProject({ root, directory: 'rust_app', name: 'rust_app', language: 'rust' }), /Existing/);
  assert.throws(() => createNativeProject({ root, directory: '../escape', name: 'test', language: 'rust' }), /inside/);
  symlinkSync(rust.root, join(root, 'linked'));
  assert.throws(() => nativeSourcePath(root, 'linked/new.rs'), /symbolic/);
});

test('board revisions preserve hand edits and connecting Rust cards creates a real declaration', (t) => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/main.rs'), 'fn main() {}\n');
  createNativeSource({ root, path: 'src/helper.rs', language: 'rust', name: 'helper' });
  const empty = readProjectBoard(root);
  const cards = [{ id: 'main', path: 'src/main.rs', label: 'Main', x: 30, y: 30 }, { id: 'helper', path: 'src/helper.rs', label: 'Helper', x: 300, y: 30 }];
  const saved = saveProjectBoard(root, { root, expectedRevision: empty.revision, cards, edges: [] });
  assert.equal(saved.saved, true);
  assert.equal(saveProjectBoard(root, { root, expectedRevision: empty.revision, cards: [], edges: [] }).saved, false);
  const source = files.read('src/main.rs');
  const connected = connectProjectCards(root, { root, expectedRevision: saved.board.revision, cards, edges: [], edge: { from: 'main', to: 'helper' }, sourceRevision: source.revision! });
  assert.equal(connected.saved, true);
  assert.match(readFileSync(join(root, 'src/main.rs'), 'utf8'), /mod helper;/);
  assert.equal(readProjectBoard(root).edges.length, 1);
  assert.throws(() => connectProjectCards(root, { root, expectedRevision: connected.board.revision, cards, edges: [], edge: { from: 'main', to: 'helper' }, sourceRevision: source.revision! }), /source changed/);
  assert.throws(() => saveProjectBoard(root, { root, expectedRevision: connected.board.revision, cards, edges: [{ from: 'main', to: 'helper' }, { from: 'helper', to: 'main' }] }), /cycle/);
});

test('C++ connections only include headers and preserve source content', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'main.cpp'), '// hand written\nint main() { return 0; }\n');
  createNativeSource({ root, path: 'helper.hpp', name: 'helper', language: 'cpp' });
  const board = readProjectBoard(root);
  const cards = [{ id: 'main', path: 'main.cpp', label: 'Main', x: 0, y: 0 }, { id: 'helper', path: 'helper.hpp', label: 'Header', x: 300, y: 0 }];
  const result = connectProjectCards(root, { root, expectedRevision: board.revision, cards, edges: [], edge: { from: 'main', to: 'helper' }, sourceRevision: files.read('main.cpp').revision! });
  assert.equal(result.saved, true);
  assert.equal(readFileSync(join(root, 'main.cpp'), 'utf8'), '#include "helper.hpp"\n// hand written\nint main() { return 0; }\n');
});

test('native IPC rejects untrusted callers and rotates language services with the workspace', async (t) => {
  const { directory, root, cache } = fixture(t);
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
  let current = root, disposed = 0;
  const launched: string[] = [];
  const host = registerNativeProjectIpc({ ipc: { handle: (name, callback) => { handlers.set(name, callback); } },
    assertTrusted: (event) => { if (event !== 'trusted') throw new Error('Untrusted'); }, root: () => current, cacheDirectory: () => cache,
    send: () => {}, run: async () => { throw new Error('No runtime should start'); }, debug: async () => { throw new Error('No debugger should start'); },
    createLanguageService: (workspace) => { launched.push(workspace); return { completion: async () => [], hover: async () => null,
      definition: async () => [], diagnostics: async () => [], restart: async () => {}, dispose: () => { disposed++; } }; },
  });
  for (const callback of handlers.values()) assert.throws(() => callback('other'), /Untrusted/);
  assert.throws(() => handlers.get(NATIVE_PROJECT_IPC.createSource)!('trusted', { root: '/wrong', path: 'x.rs', name: 'x', language: 'rust' }), /folder changed/);
  await handlers.get(NATIVE_PROJECT_IPC.completion)!('trusted', { path: 'src/main.rs', text: '' });
  current = join(directory, 'other'); mkdirSync(current);
  await handlers.get(NATIVE_PROJECT_IPC.hover)!('trusted', { path: 'src/main.rs', text: '' });
  assert.deepEqual(launched, [root, current]); assert.equal(disposed, 1);
  host.dispose(); assert.equal(disposed, 2); assert.equal(host.busy(), false);
});
