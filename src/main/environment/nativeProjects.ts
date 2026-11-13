import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NativeArtifact, NativeBuildRequest, NativeBuildResult, NativeProject, NativeSourceRequest, NativeTemplateRequest, NativeTools } from '../../api/nativeProject';
import type { NyDiagnostic } from '../../api/ny';

const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_JSON = 8 * 1024 * 1024;
export interface NativeCommand { executable: string; args: string[]; cwd: string }
export type NativeCommandRunner = (command: NativeCommand, output: (text: string, stream?: 'stdout' | 'stderr') => void, signal?: AbortSignal) => Promise<number>;

/** Source access never follows a link out of (or within) the selected project. */
export function nativeSourcePath(root: string, path: string): string {
  if (typeof path !== 'string' || path.includes('\0')) throw new Error('Invalid project path.');
  const target = resolve(root, path);
  const local = relative(resolve(root), target);
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('The source must be inside the selected project.');
  let current = resolve(root);
  for (const part of local.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Project source paths cannot contain symbolic links.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

function executable(name: string, environment: NodeJS.ProcessEnv): string | null {
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : [''];
  const paths = isAbsolute(name) ? [''] : (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(isAbsolute);
  for (const directory of paths) {
    for (const suffix of suffixes) {
      const path = directory ? join(directory, name + suffix) : name;
      try {
        if (statSync(path).isFile()) {
          accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
          return path;
        }
      } catch { /* Try the next installed tool. */ }
    }
  }
  return null;
}

export function nativeTools(environment: NodeJS.ProcessEnv = process.env): NativeTools {
  const find = (...names: string[]) => names.map((name) => executable(name, environment)).find(Boolean) ?? null;
  return { cargo: find('cargo'), rustc: find('rustc'), cmake: find('cmake'), ctest: find('ctest'),
    cpp: find(...(environment.CXX && !/\s/.test(environment.CXX) ? [environment.CXX] : []), 'clang++', 'g++'),
    rustAnalyzer: find('rust-analyzer'), clangd: find('clangd'), debugger: find('lldb-dap', 'lldb-vscode') };
}

export function nativeBuildDirectory(root: string, cache: string): string {
  const digest = createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 24);
  const directory = resolve(cache, digest);
  const local = relative(resolve(root), directory);
  if (!local || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`))) {
    throw new Error('Native build storage must be outside the source folder.');
  }
  return directory;
}

export function inspectNativeProject(root: string, cache: string, source?: string, tools = nativeTools()): NativeProject | null {
  if (!root || !statSync(root).isDirectory()) return null;
  const cargo = nativeSourcePath(root, 'Cargo.toml');
  const cmake = nativeSourcePath(root, 'CMakeLists.txt');
  const path = source ? nativeSourcePath(root, source) : null;
  const kind = existsSync(cargo) ? 'cargo' : existsSync(cmake) ? 'cmake' : path && /\.rs$/i.test(path) ? 'rust-file' : path && /\.(?:c|cc|cpp|cxx)$/i.test(path) ? 'cpp-file' : null;
  return kind ? { root, kind, name: basename(root), source: path ? relative(root, path).split(sep).join('/') : null,
    buildDirectory: nativeBuildDirectory(root, cache), tools } : null;
}

export const runNativeCommand: NativeCommandRunner = (command, output, signal) => new Promise((done, fail) => {
  signal?.throwIfAborted();
  const child = spawn(command.executable, command.args, { cwd: command.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32', env: { ...process.env, CLICOLOR: '0', CARGO_TERM_COLOR: 'never' } });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const kill = (force = false) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      else child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch { /* Already stopped. */ }
  };
  const abort = () => { kill(); killTimer = setTimeout(() => kill(true), 1500); killTimer.unref(); };
  const finish = (error?: Error, code = 1) => {
    if (settled) return;
    settled = true; clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
    error ? fail(error) : done(code);
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text: string) => output(text, 'stdout'));
  child.stderr.on('data', (text: string) => output(text, 'stderr'));
  child.on('error', (error) => finish(error));
  child.on('close', (code) => finish(undefined, code ?? 1));
});

function requireTool(path: string | null, name: string): string {
  if (!path) throw new Error(`${name} is not installed or is not on PATH.`);
  return path;
}

export function validateNativeBuild(input: NativeBuildRequest): void {
  if (!input || typeof input.root !== 'string' || !input.root || !['check', 'build', 'test'].includes(input.action) || !['debug', 'release'].includes(input.profile)) {
    throw new Error('Invalid native project action.');
  }
  if (input.target !== undefined && (typeof input.target !== 'string' || !/^[A-Za-z0-9_.+:-]{1,160}$/.test(input.target))) throw new Error('Invalid build target.');
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 128 || input.args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192))) throw new Error('Invalid program arguments.');
}

export function nativeBuildCommands(project: NativeProject, input: NativeBuildRequest): NativeCommand[] {
  validateNativeBuild(input);
  const root = project.root;
  const command = (executable: string, args: string[]): NativeCommand => ({ executable, args, cwd: root });
  const profile = input.profile === 'release' ? 'Release' : 'Debug';
  const build = join(project.buildDirectory, input.profile);
  if (project.kind === 'cargo') {
    return [command(requireTool(project.tools.cargo, 'Cargo'), [input.action, '--manifest-path', join(root, 'Cargo.toml'), '--target-dir', project.buildDirectory,
      '--message-format=json-render-diagnostics', ...(input.profile === 'release' ? ['--release'] : []), ...(input.target ? ['--bin', input.target] : [])])];
  }
  if (project.kind === 'cmake') {
    const cmake = requireTool(project.tools.cmake, 'CMake');
    const commands = [command(cmake, ['-S', root, '-B', build, `-DCMAKE_BUILD_TYPE=${profile}`, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON']),
      command(cmake, ['--build', build, '--config', profile, ...(input.target ? ['--target', input.target] : [])])];
    if (input.action === 'test') commands.push(command(requireTool(project.tools.ctest, 'CTest'), ['--test-dir', build, '-C', profile, '--output-on-failure', '--no-tests=error']));
    return commands;
  }
  if (!project.source) throw new Error('Choose a Rust or C++ source file.');
  const source = nativeSourcePath(root, project.source);
  const output = join(build, `program${process.platform === 'win32' ? '.exe' : ''}`);
  if (project.kind === 'rust-file') {
    const args = [source, '--edition=2021', ...(input.profile === 'release' ? ['-O'] : ['-g']),
      ...(input.action === 'check' ? ['--emit=metadata', '-o', join(build, 'program.rmeta')] : ['-o', output]), ...(input.action === 'test' ? ['--test'] : [])];
    const commands = [command(requireTool(project.tools.rustc, 'Rust compiler'), args)];
    if (input.action === 'test') commands.push(command(output, []));
    return commands;
  }
  const compiler = requireTool(project.tools.cpp, 'C++ compiler');
  const args = ['-std=c++20', '-Wall', '-Wextra', ...(input.profile === 'release' ? ['-O2'] : ['-g', '-O0']),
    ...(input.action === 'check' ? ['-fsyntax-only'] : ['-o', output]), source];
  const commands = [command(compiler, args)];
  if (input.action === 'test') commands.push(command(output, []));
  return commands;
}

function readJson(path: string): any {
  if (!lstatSync(path).isFile() || statSync(path).size > MAX_JSON) throw new Error('Build metadata is invalid or too large.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function artifactPath(directory: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const path = resolve(directory, value);
  const local = relative(directory, path);
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return null;
  try {
    const physical = realpathSync(path), physicalDirectory = realpathSync(directory);
    if (!physical.startsWith(physicalDirectory + sep) || !statSync(physical).isFile()) return null;
    return physical;
  } catch { return null; }
}

export function cmakeArtifacts(directory: string, profile: string): NativeArtifact[] {
  const reply = join(directory, '.cmake', 'api', 'v1', 'reply');
  if (!existsSync(reply)) return [];
  const name = readdirSync(reply).filter((entry) => /^index-.*\.json$/.test(entry)).sort().pop();
  if (!name) return [];
  const index = readJson(join(reply, name));
  const reference = (index.objects ?? []).find((item: any) => item.kind === 'codemodel' && item.version?.major === 2);
  if (!reference || typeof reference.jsonFile !== 'string' || basename(reference.jsonFile) !== reference.jsonFile) return [];
  const model = readJson(join(reply, reference.jsonFile));
  const configuration = (model.configurations ?? []).find((item: any) => item.name.toLowerCase() === profile) ?? model.configurations?.[0];
  const artifacts: NativeArtifact[] = [];
  for (const target of (configuration?.targets ?? []).slice(0, 2000)) {
    if (typeof target.jsonFile !== 'string' || basename(target.jsonFile) !== target.jsonFile) continue;
    const detail = readJson(join(reply, target.jsonFile));
    for (const artifact of detail.artifacts ?? []) {
      const path = artifactPath(directory, artifact.path);
      if (path) artifacts.push({ name: String(detail.name), path, executable: detail.type === 'EXECUTABLE' });
    }
  }
  return artifacts;
}

export async function buildNativeProject(root: string, cache: string, input: NativeBuildRequest, emit: (text: string) => void,
  signal?: AbortSignal, runner: NativeCommandRunner = runNativeCommand, tools = nativeTools()): Promise<NativeBuildResult> {
  validateNativeBuild(input);
  if (resolve(input.root) !== resolve(root)) throw new Error('The Code folder changed. Retry in the current project.');
  const project = inspectNativeProject(root, cache, input.source, tools);
  if (!project) throw new Error('Open a Cargo or CMake project, or a Rust or C++ source file.');
  const commands = nativeBuildCommands(project, input);
  const buildDirectory = join(project.buildDirectory, input.profile);
  mkdirSync(buildDirectory, { recursive: true });
  if (project.kind === 'cmake') {
    const query = join(buildDirectory, '.cmake', 'api', 'v1', 'query', 'client-antimatter');
    mkdirSync(query, { recursive: true }); writeFileSync(join(query, 'codemodel-v2'), '');
  }
  let output = '', exitCode = 0;
  const pending = { stdout: '', stderr: '' };
  const artifacts: NativeArtifact[] = [];
  const diagnostics: NyDiagnostic[] = [];
  const line = (text: string) => {
    if (text.startsWith('{') && project.kind === 'cargo') {
      try {
        const value = JSON.parse(text);
        if (value.reason === 'compiler-artifact' && value.executable && !value.profile?.test) {
          const path = artifactPath(project.buildDirectory, value.executable);
          if (path) artifacts.push({ name: String(value.target?.name ?? basename(path)), path, executable: true });
        }
        if (value.reason === 'compiler-message' && value.message) {
          const message = value.message;
          for (const span of (message.spans ?? []).filter((span: any) => span.is_primary).slice(0, 20)) {
            const path = relative(root, resolve(root, span.file_name)).split(sep).join('/');
            if (!path.startsWith('../') && diagnostics.length < 2000) diagnostics.push({ path, message: String(message.message), source: 'Rust', severity: message.level === 'warning' ? 2 : 1,
              range: { start: { line: Math.max(0, span.line_start - 1), character: Math.max(0, span.column_start - 1) }, end: { line: Math.max(0, span.line_end - 1), character: Math.max(0, span.column_end - 1) } } });
          }
          text = String(message.rendered ?? message.message ?? '') + '\n';
        } else if (typeof value.reason === 'string') return;
      } catch { /* Build scripts can write ordinary text beginning with a brace. */ }
    }
    const match = /^(.*?):(\d+):(\d+):\s*(warning|error|fatal error):\s*(.*)$/.exec(text.trimEnd());
    if (match && diagnostics.length < 2000) {
      const path = relative(root, resolve(root, match[1])).split(sep).join('/');
      if (!path.startsWith('../')) diagnostics.push({ path, message: match[5], source: 'C++', severity: match[4] === 'warning' ? 2 : 1,
        range: { start: { line: Number(match[2]) - 1, character: Number(match[3]) - 1 }, end: { line: Number(match[2]) - 1, character: Number(match[3]) } } });
    }
    output = (output + text).slice(-MAX_OUTPUT); emit(text);
  };
  const receive = (text: string, stream: 'stdout' | 'stderr' = 'stdout') => {
    pending[stream] += text;
    let end: number;
    while ((end = pending[stream].indexOf('\n')) >= 0) { line(pending[stream].slice(0, end + 1)); pending[stream] = pending[stream].slice(end + 1); }
    if (pending[stream].length > MAX_OUTPUT) { line(pending[stream]); pending[stream] = ''; }
  };
  for (const command of commands) {
    if (signal?.aborted) { exitCode = 1; break; }
    line(`$ ${[command.executable, ...command.args].map((part) => JSON.stringify(part)).join(' ')}\n`);
    exitCode = await runner(command, receive, signal);
    for (const stream of ['stdout', 'stderr'] as const) {
      if (pending[stream]) { line(pending[stream]); pending[stream] = ''; }
    }
    if (exitCode !== 0) break;
  }
  if (exitCode === 0 && input.action !== 'check') {
    if (project.kind === 'cmake') artifacts.push(...cmakeArtifacts(buildDirectory, input.profile));
    if (project.kind.endsWith('-file')) {
      const path = artifactPath(buildDirectory, `program${process.platform === 'win32' ? '.exe' : ''}`);
      if (path) artifacts.push({ name: basename(project.source!), path, executable: true });
    }
  }
  return { root, action: input.action, success: exitCode === 0 && !signal?.aborted, cancelled: !!signal?.aborted, exitCode,
    output, diagnostics, artifacts: [...new Map(artifacts.map((artifact) => [artifact.path, artifact])).values()], buildDirectory };
}

function templateName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error('Use a name beginning with a letter, followed by letters, numbers or underscores.');
}

export function createNativeProject(input: NativeTemplateRequest): { root: string; entry: string } {
  templateName(input.name);
  if (input.language !== 'rust' && input.language !== 'cpp') throw new Error('Choose Rust or C++.');
  const root = nativeSourcePath(input.root, input.directory);
  if (root === resolve(input.root) || existsSync(root)) throw new Error('Choose a new project folder. Existing files will not be replaced.');
  mkdirSync(dirname(root), { recursive: true }); mkdirSync(root);
  if (input.language === 'rust') {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'Cargo.toml'), `[package]\nname = "${input.name}"\nversion = "0.1.0"\nedition = "2021"\n`, { flag: 'wx' });
    writeFileSync(join(root, 'src/main.rs'), `fn greeting() -> &'static str {\n    "Hello from ${input.name}"\n}\n\nfn main() {\n    println!("{}", greeting());\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn greeting_is_present() {\n        assert!(!super::greeting().is_empty());\n    }\n}\n`, { flag: 'wx' });
    return { root, entry: 'src/main.rs' };
  }
  writeFileSync(join(root, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.20)\nproject(${input.name} LANGUAGES CXX)\nset(CMAKE_CXX_STANDARD 20)\nset(CMAKE_CXX_STANDARD_REQUIRED ON)\nadd_executable(${input.name} main.cpp)\nenable_testing()\nadd_test(NAME smoke COMMAND ${input.name})\n`, { flag: 'wx' });
  writeFileSync(join(root, 'main.cpp'), `#include <iostream>\n\nint main() {\n    std::cout << "Hello from ${input.name}\\n";\n    return 0;\n}\n`, { flag: 'wx' });
  return { root, entry: 'main.cpp' };
}

export function createNativeSource(input: NativeSourceRequest): { path: string } {
  templateName(input.name);
  if (input.language !== 'rust' && input.language !== 'cpp') throw new Error('Choose Rust or C++.');
  const keywords = input.language === 'rust'
    ? 'as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try gen'
    : 'alignas alignof asm auto bool break case catch char class const consteval constexpr constinit continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while';
  if (keywords.split(' ').includes(input.name)) throw new Error('Choose a module name that is not a language keyword.');
  const path = nativeSourcePath(input.root, input.path);
  if (input.language === 'rust' ? extname(path) !== '.rs' : !['.h', '.hh', '.hpp', '.hxx'].includes(extname(path))) {
    throw new Error('Rust modules use .rs; C++ module cards use .hpp or .h headers.');
  }
  mkdirSync(dirname(path), { recursive: true });
  const source = input.language === 'rust' ? `pub fn ${input.name}() -> &'static str {\n    "${input.name}"\n}\n` :
    `#pragma once\n\ninline const char* ${input.name}() {\n    return "${input.name}";\n}\n`;
  writeFileSync(path, source, { flag: 'wx' });
  return { path: relative(input.root, path).split(sep).join('/') };
}
