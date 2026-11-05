import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NyBuildResult, NyDiagnostic, NyProjectResult } from '../../api/ny';
import { nyCompileArgs, resolveNyToolchain, type NyToolchainOptions } from './ny';

export function nySourcePath(root: string, path: string): string {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw new Error('Choose a Ny or Matrix source file.');
  const base = realpathSync(root); const file = realpathSync(resolve(base, path));
  if (file === base || !file.startsWith(base + sep) || !/\.(ny|matrix|mat)$/i.test(file)) throw new Error('Choose a .ny, .matrix, or .mat file inside this project.');
  if (!statSync(file).isFile() || statSync(file).size > 4 * 1024 * 1024) throw new Error('The source is not a supported text file.');
  return file;
}

export function parseNyDiagnostics(output: string, root: string, source: string, fallback = true): NyDiagnostic[] {
  const diagnostics: NyDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const local = line.match(/^\s*line (\d+):\s*(.+)$/);
    const match = line.match(/^\s*(.+\.(?:ny|matrix|mat)):(\d+)(?::(\d+))?:\s*(.+)$/i) ?? (local ? ['', source, local[1], '', local[2]] : null);
    if (!match) continue;
    const target = resolve(root, match[1]); const path = relative(root, target).split(sep).join('/');
    if (path === '..' || path.startsWith('../') || isAbsolute(path)) continue;
    const row = Math.max(0, Number(match[2]) - 1); const col = Math.max(0, Number(match[3] ?? 1) - 1);
    diagnostics.push({ path, message: match[4], severity: /^warning\b/i.test(match[4]) ? 2 : 1, source: 'nilcompiler', range: { start: { line: row, character: col }, end: { line: row, character: col + 1 } } });
  }
  if (!diagnostics.length && fallback && output.trim()) diagnostics.push({ path: relative(root, source).split(sep).join('/'), message: output.trim().slice(0, 4000), severity: 1,
    source: 'nilcompiler', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });
  return diagnostics;
}

/** Compile only: checking never executes the user's program. All arguments remain an argv. */
export async function buildNyFile(root: string, path: string, mode: 'check' | 'build', options: NyToolchainOptions = {}, signal?: AbortSignal): Promise<NyBuildResult> {
  root = realpathSync(root); const source = nySourcePath(root, path);
  const tools = resolveNyToolchain(root, options);
  if (extname(source).toLowerCase() !== '.ny' && tools.family !== 'nil') throw new Error('Matrix requires a current NIL Framework SDK containing nilcompiler.');
  if (!tools.compiler) throw new Error(tools.error || 'Select a Ny SDK containing nycompiler.');
  const temporary = mkdtempSync(join(tmpdir(), 'antimatter-ny-build-'));
  const outputFile = join(temporary, 'program.nil');
  try {
    const result = await new Promise<{ code: number; output: string }>((resolveResult, reject) => {
      if (signal?.aborted) { reject(new Error('Ny build cancelled.')); return; }
      const child = spawn(tools.compiler!, nyCompileArgs(source, outputFile, { sdkPath: tools.sdkPath ?? undefined, debugInfo: mode === 'build' }), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = ''; let failure: Error | null = null; let forceKill: ReturnType<typeof setTimeout> | undefined;
      const terminate = (error: Error) => {
        failure ??= error; child.kill();
        forceKill ??= setTimeout(() => child.kill('SIGKILL'), 1000);
      };
      const abort = () => terminate(new Error('Ny build cancelled.'));
      const timer = setTimeout(() => terminate(new Error('Ny compiler exceeded its 60-second deadline.')), 60_000);
      signal?.addEventListener('abort', abort, { once: true });
      const collect = (data: Buffer) => { if (output.length + data.length > 2 * 1024 * 1024) terminate(new Error('Ny compiler output exceeded its limit.')); else output += data.toString('utf8'); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.once('error', error => { failure = error; });
      child.once('close', code => { clearTimeout(timer); clearTimeout(forceKill); signal?.removeEventListener('abort', abort); if (failure) reject(failure); else resolveResult({ code: code ?? 1, output }); });
    });
    if (signal?.aborted) throw new Error('Ny build cancelled.');
    if (result.code !== 0) return { success: false, output: result.output || `Ny compiler exited ${result.code}.`, diagnostics: parseNyDiagnostics(result.output || `Ny compiler exited ${result.code}.`, root, source), artifact: null };
    if (!existsSync(outputFile)) throw new Error('Ny compiler succeeded without producing NIL.');
    let artifact: string | null = null;
    if (mode === 'build') {
      let target = root;
      for (const name of ['.antimatter', 'build']) {
        target = join(target, name);
        if (!existsSync(target)) mkdirSync(target);
        if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) throw new Error('Ny build output must be a directory inside the project.');
      }
      artifact = join(target, `${basename(source, '.ny')}-${createHash('sha256').update(relative(root, source)).digest('hex').slice(0, 10)}.nil`);
      // Publish bytes atomically on the same filesystem; replacing a symlink never follows it.
      const staging = mkdtempSync(join(target, '.publish-'));
      try { const staged = join(staging, 'program.nil'); writeFileSync(staged, readFileSync(outputFile), { flag: 'wx' }); renameSync(staged, artifact); }
      finally { rmSync(staging, { recursive: true, force: true }); }
    }
    return { success: true, output: result.output || (mode === 'check' ? 'Ny check passed.' : 'Ny build completed.'), diagnostics: [], artifact };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** A deliberately ordinary source project; Ny v1 does not ship a package-manager CLI. */
export function createNyProject(parent: string, name: string): NyProjectResult {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/.test(name) || name.trim() !== name) throw new Error('Use a project name with letters, numbers, spaces, hyphens, or underscores.');
  const directory = realpathSync(parent);
  if (!statSync(directory).isDirectory()) throw new Error('Choose a parent directory.');
  const root = join(directory, name);
  mkdirSync(root); // Exclusive: never overwrite an existing project, even if it is empty.
  try {
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'src/main.ny'), 'fn main() -> i32\n    println("Hello from Ny")\n    return 0\nend fn\n', { flag: 'wx' });
    writeFileSync(join(root, 'tests/smoke.ny'), 'fn main() -> i32\n    let value: i32 = 2 + 2\n    if value != 4 then\n        return 1\n    end if\n    println("Smoke test passed")\n    return 0\nend fn\n', { flag: 'wx' });
    writeFileSync(join(root, '.gitignore'), '.antimatter/build/\n*.nil\n', { flag: 'wx' });
    writeFileSync(join(root, 'README.md'), `# ${name}\n\nOpen src/main.ny in Antimatter. Select your Ny SDK using the Ny tools panel, then Check, Build, Run, or Debug. Click the editor gutter to set a source breakpoint.\n\nOpen tests/smoke.ny and Run to execute the standalone smoke test. Ny programs use exit code 0 for success.\n\nThe supported execution path is Ny source → nycompiler → NIL → nyinterpreter. Antimatter compiles fresh NIL before running. Debug uses nydebugger --dap with source-mapped NIL.\n\nWith the SDK tools on PATH, from this project directory:\n\n\x60\x60\x60sh\nnycompiler --no-bundle --output main.nil src/main.ny\nnyinterpreter main.nil\n\x60\x60\x60\n\nNy v1 has no shipped nypm CLI; this starter requires no package manager.\n`, { flag: 'wx' });
    return { root, entry: 'src/main.ny' };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
