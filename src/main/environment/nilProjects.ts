import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { NyBuildResult, NyProjectResult } from '../../api/ny';
import type { NilProjectDescription, NilProjectLanguage, NilProjectTarget } from '../../api/nilProject';
import { nyCompileArgs, resolveNyToolchain, type NyToolchain, type NyToolchainOptions } from './ny';
import { parseNyDiagnostics } from './nyProjects';

export type { NilProjectDescription, NilProjectLanguage, NilProjectTarget } from '../../api/nilProject';
export interface NilProjectInvocation { command: string; args: string[]; cwd: string; label: string }
/**
 * Manifest names in the driver's own precedence order.
 *
 * NILData is the current (v2) project format and what `nilbuild init` and `nilbuild convert`
 * write; JSON and YAML stay readable for projects created before that move. `nilbuild --help`
 * states the search as "nearest nil.project.nildata, .json, .yaml or .yml", and the driver owns
 * parsing — Antimatter only has to find the file and hand it over with --project.
 *
 * Looking for the JSON name alone made every current-format project invisible to the app: no
 * project actions, no Pensieve compiler feedback (`probe` returns null and the automatic check
 * goes quiet without reporting anything), and no application boundary for project notes in
 * `projectRoot`. Discovery accepts all four; only the starter below still writes JSON.
 */
export const NIL_MANIFEST_NAMES = ['nil.project.nildata', 'nil.project.json', 'nil.project.yaml', 'nil.project.yml'] as const;
/** What `createNilProject` writes. Discovery is format-agnostic; the starter is not. */
const starterManifestName = 'nil.project.json';
const sourceExtension = /\.(ny|matrix|mat)$/i;

function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Resolve existing parents as well, so a not-yet-created output cannot escape through a symlink. */
function canonicalFuture(file: string): string {
  let current = resolve(file); const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Project path could not be resolved.');
    tail.unshift(basename(current)); current = parent;
  }
  return join(realpathSync(current), ...tail);
}

function workspacePath(root: string, value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new Error(`${label} must be a valid path.`);
  const path = resolve(root, value);
  if (!inside(root, path) || !inside(root, canonicalFuture(path))) throw new Error(`${label} must stay inside the open workspace.`);
  return path;
}

/** The nearest manifest wins; never inherit configuration from outside the open workspace. */
export function findNilProject(root: string, sourcePath?: string): string | null {
  root = realpathSync(root);
  const source = sourcePath ? workspacePath(root, sourcePath, 'Project source') : root;
  let directory = existsSync(source) && statSync(source).isDirectory() ? source : dirname(source);
  while (inside(root, directory)) {
    // The nearest directory wins; within one directory the driver's format order decides.
    for (const name of NIL_MANIFEST_NAMES) {
      const candidate = join(directory, name);
      if (!existsSync(candidate)) continue;
      workspacePath(root, candidate, 'Project manifest');
      const stat = statSync(candidate);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`${name} must be a regular UTF-8 file no larger than 1 MiB.`);
      return candidate;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  return null;
}

function toolsForProject(root: string, options: NyToolchainOptions): NyToolchain {
  const tools = resolveNyToolchain(root, options);
  if (tools.family !== 'nil' || !tools.builder || !tools.compiler) throw new Error('NIL projects require a current NIL Framework SDK containing nilbuild and nilcompiler. Select the SDK in Code tools.');
  return tools;
}

/** Bounded compile-only child. Cancellation also retires the driver's compiler descendants. */
async function executeTool(command: string, args: string[], cwd: string, signal?: AbortSignal, limit = 16 * 1024 * 1024, timeout = 300_000): Promise<{ code: number; output: string; stdout: string; stderr: string }> {
  if (signal?.aborted) throw new Error('NIL project operation cancelled.');
  return new Promise((resolveResult, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: grouped });
    let output = ''; let stdout = ''; let stderr = ''; let bytes = 0;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let failure: Error | null = null; let forceKill: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => {
      try { if (grouped && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch { /* already retired */ }
    };
    const terminate = (error: Error) => {
      failure ??= error; kill('SIGTERM');
      // nilbuild gives its separately grouped compiler two seconds to retire.
      // Keep the driver alive long enough to complete that descendant cleanup.
      forceKill ??= setTimeout(() => kill('SIGKILL'), 5000);
    };
    const abort = () => terminate(new Error('NIL project operation cancelled.'));
    const timer = setTimeout(() => terminate(new Error('NIL project operation exceeded its deadline.')), timeout);
    const collect = (data: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += data.length;
      if (bytes > limit) { terminate(new Error('NIL project output exceeded its limit.')); return; }
      const text = decoders[stream].write(data); output += text;
      if (stream === 'stdout') stdout += text; else stderr += text;
    };
    child.stdout.on('data', data => collect(data, 'stdout')); child.stderr.on('data', data => collect(data, 'stderr'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      if (failure) kill('SIGKILL');
      clearTimeout(timer); clearTimeout(forceKill); signal?.removeEventListener('abort', abort);
      const outTail = decoders.stdout.end(); const errTail = decoders.stderr.end();
      stdout += outTail; stderr += errTail; output += outTail + errTail;
      if (failure) reject(failure); else resolveResult({ code: code ?? 1, output, stdout, stderr });
    });
  });
}

function parseDescription(text: string, root: string, projectFile: string): NilProjectDescription {
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch { throw new Error('nilbuild returned an invalid project description.'); }
  if (!data || data.schema !== 'nil.project.description.v1' || typeof data.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.name)) throw new Error('nilbuild returned an invalid project description.');
  const file = workspacePath(root, data.projectFile, 'Project manifest');
  if (realpathSync(file) !== realpathSync(projectFile)) throw new Error('nilbuild described a different project manifest.');
  const directory = workspacePath(root, data.projectDirectory, 'Project directory');
  if (resolve(directory) !== dirname(file)) throw new Error('nilbuild returned an inconsistent project directory.');
  const entry = workspacePath(root, data.entry, 'Project entry');
  if (!sourceExtension.test(entry)) throw new Error('Project entry must be a Ny or Matrix source file.');
  const imports = data.includePaths;
  if (!Array.isArray(imports) || imports.length > 1024 || imports.some(item => typeof item !== 'string' || !isAbsolute(item) || item.includes('\0') || item.length > 4096)) throw new Error('nilbuild returned invalid project import roots.');
  if (data.sdkPath !== null && (typeof data.sdkPath !== 'string' || !isAbsolute(data.sdkPath) || data.sdkPath.includes('\0') || data.sdkPath.length > 4096)) throw new Error('nilbuild returned an invalid SDK path.');
  const analysis = data.analysis as { disabledRules?: unknown; warningsAsErrors?: unknown } | undefined;
  if (!analysis || !Array.isArray(analysis.disabledRules) || analysis.disabledRules.some(code => typeof code !== 'string' || !/^NIL[0-9]{4}$/.test(code)) || new Set(analysis.disabledRules).size !== analysis.disabledRules.length || typeof analysis.warningsAsErrors !== 'boolean') throw new Error('nilbuild returned invalid analyzer settings.');
  const outputDirectory = workspacePath(root, data.outputDirectory, 'Project output');
  const vmOutput = workspacePath(root, data.vmOutput, 'VM artifact');
  const nativeOutput = workspacePath(root, data.nativeOutput, 'Native artifact');
  if (vmOutput !== join(outputDirectory, `${data.name}.nil`) || nativeOutput !== join(outputDirectory, data.name + (process.platform === 'win32' ? '.exe' : ''))) throw new Error('nilbuild returned inconsistent artifact paths.');
  return { schema: 'nil.project.description.v1', projectFile: file, projectDirectory: directory, name: data.name,
    entry, language: extname(entry).toLowerCase() === '.ny' ? 'ny' : 'matrix', includePaths: imports as string[], sdkPath: data.sdkPath as string | null,
    outputDirectory, vmOutput, nativeOutput, analysis: { disabledRules: analysis.disabledRules as string[], warningsAsErrors: analysis.warningsAsErrors } };
}

/** nilbuild owns manifest parsing and policy, including duplicate keys and unknown fields. */
export async function describeNilProject(root: string, sourcePath?: string, options: NyToolchainOptions = {}, signal?: AbortSignal): Promise<NilProjectDescription | null> {
  root = realpathSync(root);
  const projectFile = findNilProject(root, sourcePath);
  if (!projectFile) return null;
  const tools = toolsForProject(root, options);
  const args = ['describe', '--project', projectFile, '--format', 'json'];
  if (options.sdkPath) args.push('--sdk', tools.sdkPath!);
  const result = await executeTool(tools.builder!, args, root, signal, 2 * 1024 * 1024, 15_000);
  if (result.code !== 0) throw new Error(result.output.trim() || `nilbuild describe exited ${result.code}.`);
  return parseDescription(result.stdout, root, projectFile);
}

/** Use only the driver's published argv; never pass a program argument through a shell. */
export function nilProjectInvocation(project: NilProjectDescription, tools: NyToolchain, action: 'check' | 'build' | 'run', target: NilProjectTarget = 'vm', programArgs: string[] = []): NilProjectInvocation {
  if (tools.family !== 'nil' || !tools.builder || !tools.compiler) throw new Error('Select a current NIL Framework SDK with nilbuild and nilcompiler.');
  if (!['check', 'build', 'run'].includes(action) || !['vm', 'native'].includes(target)) throw new Error('Choose a supported NIL project action and target.');
  if (!Array.isArray(programArgs) || programArgs.length > 256 || programArgs.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) throw new Error('Program arguments must be bounded strings without NUL bytes.');
  if (target === 'vm' && action === 'run' && !tools.interpreter) throw new Error('The selected SDK does not contain nilinterpreter.');
  const args = [action, '--project', project.projectFile, '--target', target, '--compiler', tools.compiler];
  if (tools.interpreter) args.push('--interpreter', tools.interpreter);
  // describe has already resolved a configured SDK override or the manifest's SDK.
  if (project.sdkPath) args.push('--sdk', project.sdkPath);
  if (action === 'run' && programArgs.length) args.push('--', ...programArgs);
  return { command: tools.builder, args, cwd: project.projectDirectory, label: `${project.name} · ${action} (${target === 'vm' ? 'NIL VM' : 'native'})` };
}

export function nilProjectCompileArgs(project: NilProjectDescription, output: string, tools: NyToolchain, options: { debugInfo?: boolean } = {}): string[] {
  return nyCompileArgs(project.entry, output, { ...options, sdkPath: project.sdkPath ?? tools.sdkPath ?? undefined, includePaths: project.includePaths });
}

/** Check/build never execute the program. nilbuild checks first and publishes an artifact only on success. */
export async function buildNilProject(root: string, sourcePath: string | undefined, mode: 'check' | 'build', options: NyToolchainOptions = {}, signal?: AbortSignal, target: NilProjectTarget = 'vm'): Promise<NyBuildResult> {
  root = realpathSync(root);
  const project = await describeNilProject(root, sourcePath, options, signal);
  if (!project) throw new Error('No NIL project manifest (nil.project.nildata, .json, .yaml or .yml) was found in this workspace. Create a NIL Framework project first.');
  const invocation = nilProjectInvocation(project, toolsForProject(root, options), mode, target);
  const result = await executeTool(invocation.command, invocation.args, invocation.cwd, signal);
  if (signal?.aborted) throw new Error('NIL project operation cancelled.');
  const output = result.output || (result.code === 0 ? `Project ${mode} completed.` : `nilbuild ${mode} exited ${result.code}.`);
  const diagnostics = result.output.trim() ? parseNyDiagnostics(result.output, root, project.entry, result.code !== 0) : [];
  if (result.code !== 0) return { success: false, output, diagnostics, artifact: null };
  let artifact: string | null = null;
  if (mode === 'build') {
    artifact = workspacePath(root, target === 'vm' ? project.vmOutput : project.nativeOutput, 'Project artifact');
    if (!existsSync(artifact) || !lstatSync(artifact).isFile()) throw new Error('nilbuild succeeded without producing a regular artifact.');
  }
  return { success: true, output, diagnostics, artifact };
}

const nyMain = 'fn main() -> i32\n    println("Hello from Ny")\n    return 0\nend fn\n';
const matrixMain = 'book application\n\nmain returns override integer begin paragraph\n    say "Hello from Matrix"\n    give 0\nend paragraph\n';
const mixedMain = 'book application\n\nread everything from greeting\n\nmain returns override integer begin paragraph\n    say greeting with "Ny and Matrix"\n    give 0\nend paragraph\n';

/** Ordinary, inspectable project files matching the installed driver's nil.project.v1 contract. */
export function createNilProject(parent: string, name: string, language: NilProjectLanguage = 'ny'): NyProjectResult {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/.test(name) || name.trim() !== name) throw new Error('Use a project name with letters, numbers, spaces, hyphens, or underscores.');
  if (!['ny', 'matrix', 'mixed'].includes(language)) throw new Error('Choose Ny, Matrix, or a mixed project.');
  const directory = realpathSync(parent);
  if (!statSync(directory).isDirectory()) throw new Error('Choose a parent directory.');
  const root = join(directory, name); const entry = `src/main.${language === 'ny' ? 'ny' : 'matrix'}`;
  const artifactName = name.replace(/ +/g, '-');
  mkdirSync(root);
  try {
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, entry), language === 'ny' ? nyMain : language === 'matrix' ? matrixMain : mixedMain, { flag: 'wx' });
    if (language === 'mixed') writeFileSync(join(root, 'src/greeting.ny'), 'module greeting\n\npub fn greeting(name: text) -> text\n    return "Hello from " + name\nend fn\n', { flag: 'wx' });
    writeFileSync(join(root, starterManifestName), JSON.stringify({ schema: 'nil.project.v1', name: artifactName, entry, includePaths: ['src'], outputDirectory: 'build', analysis: { disabledRules: [], warningsAsErrors: false } }, null, 2) + '\n', { flag: 'wx' });
    writeFileSync(join(root, 'tests/smoke.ny'), 'fn main() -> i32\n    let value: i32 = 2 + 2\n    if value != 4 then\n        return 1\n    end if\n    println("Smoke test passed")\n    return 0\nend fn\n', { flag: 'wx' });
    writeFileSync(join(root, 'tests/nil.project.json'), JSON.stringify({ schema: 'nil.project.v1', name: `${artifactName}-smoke`, entry: 'smoke.ny', includePaths: ['../src'], outputDirectory: '../build/tests' }, null, 2) + '\n', { flag: 'wx' });
    writeFileSync(join(root, '.gitignore'), 'build/\n.antimatter/build/\n', { flag: 'wx' });
    writeFileSync(join(root, 'README.md'), `# ${name}\n\nOpen this folder in Antimatter's Code workspace. Select a current NIL Framework SDK, then Check project, Build project, Run project, or Debug project. The entrypoint is ${entry}; click the editor gutter to set a source breakpoint.\n\nThe project uses nil.project.json and the same analyzer policy and import roots in the IDE and CLI. Build and Run require a successful check; Run rebuilds first. The smoke test is an explicit second project, because nilbuild does not provide test discovery.\n\nWith the SDK tools on PATH:\n\n\x60\x60\x60sh\nnilbuild check\nnilbuild build\nnilbuild run\nnilbuild run --project tests/nil.project.json\n\x60\x60\x60\n\nVM debugging compiles fresh source-mapped NIL and uses nildebugger --dap. Native builds require an LLVM-enabled SDK and host C++ linker; native debugging is not configured by this starter.\n`, { flag: 'wx' });
    return { root, entry };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
