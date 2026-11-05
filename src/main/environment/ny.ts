import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

export type NyTool = 'compiler' | 'interpreter' | 'lsp' | 'debugger' | 'builder';
export interface NyToolchainOptions {
  sdkPath?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  /** Antimatter's application directory, for a sibling Ny checkout. */
  appDirectory?: string;
}
export interface NyToolchain {
  sdkPath: string | null;
  compiler: string | null;
  interpreter: string | null;
  lsp: string | null;
  debugger: string | null;
  builder: string | null;
  family: 'nil' | 'ny' | null;
  source: string | null;
  error: string | null;
}
const names: Record<NyTool, string> = { compiler: 'nilcompiler', interpreter: 'nilinterpreter', lsp: 'nillsp', debugger: 'nildebugger', builder: 'nilbuild' };
const legacyNames = { compiler: 'nycompiler', interpreter: 'nyinterpreter', lsp: 'nylsp', debugger: 'nydebugger' };
const toolNames = Object.keys(names) as NyTool[];

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

function expandPath(value: string, root: string, home: string): string {
  const expanded = value.trim().replace(/\$\{workspaceFolder\}/g, root);
  return resolve(expanded === '~' ? home : /^[~][/\\]/.test(expanded) ? join(home, expanded.slice(2)) : isAbsolute(expanded) ? expanded : join(root, expanded));
}

function layouts(root: string): string[] {
  // v1 ships a flat SDK. Older development/install layouts remain discoverable.
  return [root, join(root, 'build', 'sdk'), join(root, 'sdk'), join(root, 'bin'), join(root, 'build', 'cmake', 'bin'), join(root, 'build', 'sdk', 'bin')];
}

function ancestors(path: string): string[] {
  const result: string[] = [];
  for (let current = resolve(path), depth = 0; depth < 8; depth++) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

/** Resolve a single coherent SDK, never splice compiler/runtime versions from different installs. */
export function resolveNyToolchain(root: string, options: NyToolchainOptions = {}): NyToolchain {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const configured = options.sdkPath?.trim() || environment.NIL_SDK_PATH?.trim() || environment.NIL_SDK_DIR?.trim() || environment.NIL_HOME?.trim()
    || environment.NY_SDK_PATH?.trim() || environment.NY_SDK_DIR?.trim() || environment.NY_HOME?.trim();
  const candidates: { directory: string; source: string }[] = [];
  if (configured) {
    candidates.push(...layouts(expandPath(configured, root, home)).map((directory) => ({ directory, source: 'configured' })));
  } else {
    candidates.push(...layouts(resolve(root)).map((directory) => ({ directory, source: 'workspace' })));
    const pathValue = environment.PATH ?? environment.Path ?? '';
    candidates.push(...pathValue.split(delimiter).filter(Boolean).map((directory) => ({ directory: resolve(directory), source: 'path' })));
    const bases = new Set([...ancestors(root), ...ancestors(options.appDirectory ?? process.cwd())]);
    for (const base of bases) {
      for (const checkout of [join(base, 'exec-nil-framework'), join(base, 'Projects', 'exec-nil-framework'), join(base, 'exec-lang-ny'), join(base, 'Projects', 'exec-lang-ny')]) {
        candidates.push(...layouts(checkout).map((directory) => ({ directory, source: 'sibling' })));
      }
    }
  }
  const visited = new Set<string>();
  let partial: NyToolchain | null = null;
  for (const { directory, source } of candidates) {
    if (visited.has(directory)) continue;
    visited.add(directory);
    for (const family of ['nil', 'ny'] as const) {
      const selected = family === 'nil' ? names : legacyNames;
      const required = Object.keys(selected) as NyTool[];
      const tools = Object.fromEntries(toolNames.map((tool) => {
        const name = selected[tool as keyof typeof selected];
        const path = name ? join(directory, name + suffix) : null;
        return [tool, path && executable(path) ? path : null];
      })) as Pick<NyToolchain, NyTool>;
      if (!required.some((tool) => tools[tool])) continue;
      const missing = required.filter((tool) => !tools[tool]).map((tool) => selected[tool as keyof typeof selected]);
      const found: NyToolchain = { ...tools, family, sdkPath: directory, source, error: missing.length ? `NIL Framework SDK is missing ${missing.join(', ')}. Choose a complete SDK folder.` : null };
      if (!missing.length) return found;
      partial ??= found;
    }
  }
  return partial ?? {
    sdkPath: null, compiler: null, interpreter: null, lsp: null, debugger: null, builder: null, family: null, source: null,
    error: configured ? `No NIL Framework tools were found at the configured SDK path: ${configured}. Choose the SDK folder containing nilcompiler.` : 'NIL Framework SDK was not found. Choose an SDK folder or set NIL_SDK_PATH (legacy NY_SDK_PATH is also supported).',
  };
}

export function requireNyTool(root: string, tool: NyTool, options: NyToolchainOptions = {}): string {
  const tools = resolveNyToolchain(root, options);
  if (!tools[tool]) throw new Error(tools.error ?? `${names[tool]} is unavailable. Choose the complete Ny SDK folder.`);
  return tools[tool];
}

/** Argument vectors: source paths, including spaces and shell metacharacters, remain literal. */
export function nyCompileArgs(source: string, output: string, options: { debugInfo?: boolean; sdkPath?: string; noStdlib?: boolean; includePaths?: readonly string[] } = {}): string[] {
  return ['--no-bundle', '--quiet', ...(options.debugInfo ? ['--debug-info'] : []),
    ...(options.noStdlib ? ['--no-stdlib'] : []), ...(options.sdkPath ? ['--sdk-path', options.sdkPath] : []),
    ...(options.includePaths ?? []).flatMap(path => ['-I', path]), '--output', output, source];
}
