import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NyCompletionItem, NyDiagnostic, NyDocument, NyLocation, NyPosition, NyRange } from '../../api/ny';
import { resolveNyToolchain, type NyToolchainOptions } from './ny';
import { nySourcePath } from './nyProjects';

const MAX_SOURCE = 1024 * 1024;
const MAX_WORKSPACE = 8 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_JOBS = 32;
export interface NilAnalysisContext {
  sdkPath?: string; includePaths?: string[]; disabledRules?: string[]; warningsAsErrors?: boolean; noStdlib?: boolean;
}
export class NilAnalysisUnavailableError extends Error { constructor(message: string) { super(message); this.name = 'NilAnalysisUnavailableError'; } }
interface Source { path: string; text: string }
interface Span { path: string; start: number; length: number }
interface Symbol extends Span { id: number; kind: string; name: string; type: string }
interface Semantic { sources: Source[]; symbols: Symbol[]; references: Array<Span & { symbol_id: number }> }
interface Completion { path: string; cursor: number; start: number; length: number; sources: Source[]; items: Array<{ name: string; kind: string; type: string; insert_text: string }> }
interface Diagnostic { path: string | null; code: string; message: string; hint: string; severity: string; start: number | null; length: number | null }
interface Analysis { source: string; language: 'ny' | 'matrix'; success: boolean; sources: Source[]; diagnostics: Diagnostic[]; semantic?: Semantic; completion?: Completion }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validText = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0') && Buffer.from(value).toString('utf8') === value;
const sourceLanguage = (path: string) => /\.(?:matrix|mat)$/i.test(path) ? 'matrix' : 'ny';
const localPath = (root: string, path: string) => relative(root, path).split(sep).join('/');

/** UTF-8 compiler spans become exact UTF-16 editor coordinates, never rounded scalar bytes. */
function rangeMapper(text: string): (start: number, length: number) => NyRange | null {
  const boundaries = new Uint32Array(Buffer.byteLength(text) + 1), lines = [0];
  let bytes = 0, units = 0; boundaries[0] = 1;
  for (const scalar of text) {
    bytes += Buffer.byteLength(scalar); units += scalar.length; boundaries[bytes] = units + 1;
    if (scalar === '\n') lines.push(units);
  }
  const position = (offset: number): NyPosition => {
    let low = 0, high = lines.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (lines[middle] <= offset) low = middle; else high = middle; }
    return { line: low, character: offset - lines[low] };
  };
  return (start, length) => {
    if (!integer(start) || !integer(length) || !Number.isSafeInteger(start + length) || start + length >= boundaries.length) return null;
    const first = boundaries[start], last = boundaries[start + length];
    return first && last ? { start: position(first - 1), end: position(last - 1) } : null;
  };
}
export function nilByteRange(text: string, start: number, length: number): NyRange | null { return rangeMapper(text)(start, length); }
function byteOffset(text: string, document: NyDocument): number {
  const line = document.line ?? 0, character = document.character ?? 0;
  const lines = text.split('\n');
  if (!integer(line) || !integer(character) || line >= lines.length || character > lines[line].replace(/\r$/, '').length) throw new Error('Invalid NIL editor position.');
  const before = lines.slice(0, line).join('\n') + (line ? '\n' : '') + lines[line].slice(0, character);
  if (character > 0 && /[\uD800-\uDBFF]/.test(lines[line][character - 1]) && /[\uDC00-\uDFFF]/.test(lines[line][character] ?? '')) throw new Error('NIL editor position splits a Unicode character.');
  return Buffer.byteLength(before);
}
function parseSources(value: unknown): Source[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('Invalid NIL analysis sources.');
  const paths = new Set<string>();
  return value.map((item) => {
    if (!record(item) || !validText(item.path) || !isAbsolute(item.path) || !validText(item.text) || Buffer.byteLength(item.text) > MAX_SOURCE || paths.has(normalize(item.path))) throw new Error('Invalid NIL analysis source snapshot.');
    paths.add(normalize(item.path)); return { path: normalize(item.path), text: item.text };
  });
}
function sourceMappers(sources: Source[]): Map<string, ReturnType<typeof rangeMapper>> {
  return new Map(sources.map((source) => [source.path, rangeMapper(source.text)]));
}
function validSpan(value: Record<string, unknown>, sources: Map<string, ReturnType<typeof rangeMapper>>): boolean {
  return validText(value.path) && integer(value.start) && integer(value.length) && !!sources.get(normalize(value.path))?.(value.start, value.length);
}
export function parseNilAnalysis(output: string, expected: Source, code: number): Analysis {
  if (Buffer.byteLength(output) > MAX_OUTPUT) throw new Error('NIL analysis output exceeded 8 MiB.');
  let data: unknown;
  try { data = JSON.parse(output); } catch { throw new Error('NIL compiler did not return valid analysis JSON.'); }
  if (!record(data) || data.schema !== 'nil.analysis.v1' || data.source !== expected.path || data.language !== sourceLanguage(expected.path) ||
      typeof data.success !== 'boolean' || ![0, 1].includes(code) || data.success !== (code === 0) || !Array.isArray(data.diagnostics) || data.diagnostics.length > 10000) throw new Error('Invalid NIL analysis result.');
  const sources = data.sources === undefined ? [] : parseSources(data.sources);
  if (sources.some((source) => source.path === expected.path)) throw new Error('NIL imported snapshots repeat the primary source.');
  const diagnostics: Diagnostic[] = data.diagnostics.map((item) => {
    if (!record(item) || typeof item.code !== 'string' || typeof item.message !== 'string' || typeof item.hint !== 'string' ||
        typeof item.severity !== 'string' || !['error', 'warning', 'note', 'help'].includes(item.severity) ||
        (item.path !== null && (!validText(item.path) || !isAbsolute(item.path))) ||
        !((item.start === null && item.length === null) || (integer(item.start) && integer(item.length))) || (data.success && item.severity === 'error')) throw new Error('Invalid NIL analysis diagnostic.');
    return item as unknown as Diagnostic;
  });
  const result: Analysis = { source: expected.path, language: data.language as Analysis['language'], success: data.success, sources, diagnostics };
  if (data.semantic != null) {
    const index = data.semantic;
    if (!record(index) || index.schema !== 'nil.semantic.v1' || index.partial !== true || !data.success || !Array.isArray(index.symbols) || index.symbols.length > 32768 || !Array.isArray(index.references) || index.references.length > 131072) throw new Error('Invalid NIL semantic index.');
    const semanticSources = parseSources(index.sources), maps = sourceMappers(semanticSources), ids = new Set<number>();
    for (const symbol of index.symbols) {
      if (!record(symbol) || !integer(symbol.id) || ids.has(symbol.id) || !validSpan(symbol, maps) || !validText(symbol.name) || !symbol.name || !validText(symbol.kind) || !validText(symbol.type)) throw new Error('Invalid NIL semantic symbol.');
      ids.add(symbol.id);
    }
    for (const reference of index.references) if (!record(reference) || !integer(reference.symbol_id) || !ids.has(reference.symbol_id) || !validSpan(reference, maps)) throw new Error('Invalid NIL semantic reference.');
    result.semantic = { sources: semanticSources, symbols: index.symbols as Symbol[], references: index.references as Semantic['references'] };
  }
  if (data.completion != null) {
    const completion = data.completion;
    if (!record(completion) || completion.schema !== 'nil.completion.v1' || completion.partial !== true || completion.path !== expected.path || !integer(completion.cursor) || !integer(completion.start) || !integer(completion.length) ||
        !completion.length || completion.cursor < completion.start || completion.cursor > completion.start + completion.length || !Array.isArray(completion.items) || completion.items.length > 4096) throw new Error('Invalid NIL completion result.');
    const completionSources = parseSources(completion.sources);
    if (!validSpan(completion, sourceMappers(completionSources)) || !nilByteRange(expected.text, completion.cursor, 0)) throw new Error('Invalid NIL completion range.');
    for (const item of completion.items) if (!record(item) || !validText(item.name) || !item.name || !validText(item.type) || !validText(item.insert_text) || !item.insert_text || /[\r\n]/.test(item.name + item.insert_text) || !['function', 'variable', 'parameter', 'field', 'method'].includes(String(item.kind))) throw new Error('Invalid NIL completion item.');
    result.completion = { ...completion, sources: completionSources } as unknown as Completion;
  }
  for (const snapshots of [result.semantic?.sources, result.completion?.sources]) {
    if (snapshots && snapshots.find((item) => item.path === expected.path)?.text !== expected.text) throw new Error('NIL analysis primary snapshot does not match the editor buffer.');
  }
  return result;
}

/** Serial compiler analysis of unsaved buffers. No temporary source or project files are written. */
export class NilAnalysisService {
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private controllers = new Map<string, AbortController>();
  private queued = 0;
  private readonly root: string;
  constructor(root: string, private readonly options: NyToolchainOptions = {}, private readonly context: NilAnalysisContext = {}) { this.root = realpathSync(root); }
  dispose(): void { this.closed = true; for (const controller of this.controllers.values()) controller.abort(); this.controllers.clear(); }

  async diagnostics(document: NyDocument, signal?: AbortSignal): Promise<NyDiagnostic[]> {
    const { result, primary, inputs } = await this.analyze('diagnostics', document, signal);
    const snapshots = [primary, ...result.sources];
    const maps = sourceMappers(snapshots);
    const current = new Map(snapshots.map((source) => [source.path, this.snapshotCurrent(source, inputs)]));
    return result.diagnostics.flatMap((item) => {
      const path = item.path ? normalize(item.path) : primary.path;
      const source = snapshots.find((value) => value.path === path);
      if (!source || !current.get(path)) return [];
      const range = item.start === null ? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } : maps.get(path)!(item.start, item.length!);
      if (!range) return [];
      return [{ path: localPath(this.root, path), range, severity: item.severity === 'error' ? 1 : item.severity === 'warning' ? 2 : 3,
        source: 'nilcompiler', message: `${item.code ? `${item.code}: ` : ''}${item.message}${item.hint ? `\n${item.hint}` : ''}` }];
    }).slice(0, 1000);
  }
  async completion(document: NyDocument, signal?: AbortSignal): Promise<NyCompletionItem[]> {
    const { result, primary, inputs, cursor } = await this.analyze('completion', document, signal);
    const completion = result.completion;
    if (!completion) return [];
    if (completion.cursor !== cursor || !completion.sources.every((source) => this.snapshotCurrent(source, inputs, true))) throw new Error('NIL completion describes stale source.');
    const range = nilByteRange(primary.text, completion.start, completion.length)!;
    const kinds: Record<string, number> = { function: 3, method: 2, variable: 6, parameter: 6, field: 5 };
    return completion.items.map((item) => ({ label: item.name, kind: kinds[item.kind], detail: item.type, textEdit: { range, newText: item.insert_text } }));
  }
  async definition(document: NyDocument, signal?: AbortSignal): Promise<NyLocation[]> {
    const { result, primary, inputs, cursor } = await this.analyze('definition', document, signal);
    const index = result.semantic;
    if (!index) return [];
    if (!index.sources.every((source) => this.snapshotCurrent(source, inputs, true))) throw new Error('NIL definitions describe stale source.');
    const matches = [...index.references.map((item) => ({ ...item, id: item.symbol_id })), ...index.symbols]
      .filter((item) => normalize(item.path) === primary.path && item.start <= cursor && cursor <= item.start + item.length);
    const ids = new Set(matches.map((item) => item.id));
    if (ids.size !== 1) return [];
    const symbol = index.symbols.find((item) => item.id === matches[0].id)!;
    let path: string;
    try { path = nySourcePath(this.root, symbol.path); } catch { return []; }
    const text = index.sources.find((item) => item.path === normalize(symbol.path))!.text;
    const range = nilByteRange(text, symbol.start, symbol.length)!;
    return [{ path: localPath(this.root, path), uri: pathToFileURL(path).href, range }];
  }
  private snapshotCurrent(source: Source, inputs: Source[], allowExternal = false): boolean {
    const input = inputs.find((item) => item.path === source.path);
    if (input) return input.text === source.text;
    if (!allowExternal) {
      try { if (nySourcePath(this.root, source.path) !== source.path) return false; } catch { return false; }
    }
    let fd: number | undefined;
    try {
      // Snapshot paths come from a bounded local compiler result; navigation remains workspace-only.
      fd = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const expected = Buffer.byteLength(source.text), stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== expected) return false;
      const buffer = Buffer.alloc(expected + 1); let count = 0;
      while (count < buffer.length) { const size = readSync(fd, buffer, count, buffer.length - count, count); if (!size) break; count += size; }
      return count === expected && buffer.subarray(0, count).toString('utf8') === source.text;
    } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
  }
  private analyze(kind: 'diagnostics' | 'completion' | 'definition', document: NyDocument, signal?: AbortSignal): Promise<{ result: Analysis; primary: Source; inputs: Source[]; cursor: number }> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('NIL analysis cancelled.'));
    if (!document || !validText(document.text) || Buffer.byteLength(document.text) > MAX_SOURCE) return Promise.reject(new Error('NIL analysis requires a valid source buffer of at most 1 MiB.'));
    let primary: Source, inputs: Source[], input: string, cursor: number;
    try {
      primary = { path: nySourcePath(this.root, document.path), text: document.text };
      const sources = document.documents ?? [];
      if (!Array.isArray(sources) || sources.length > 256) throw new Error('NIL analysis supports at most 256 open source buffers.');
      const byPath = new Map<string, Source>();
      for (const source of sources) {
        if (!source || !validText(source.text) || Buffer.byteLength(source.text) > MAX_SOURCE) throw new Error('Invalid NIL analysis overlay.');
        const path = nySourcePath(this.root, source.path);
        if (byPath.has(path)) throw new Error('Duplicate NIL analysis overlay path.');
        byPath.set(path, { path, text: source.text });
      }
      byPath.set(primary.path, primary); inputs = [...byPath.values()];
      if (inputs.length > 256) throw new Error('NIL analysis supports at most 256 open source buffers.');
      input = JSON.stringify({ schema: 'nil.analysis.workspace.v1', sources: inputs });
      if (Buffer.byteLength(input) > MAX_WORKSPACE) throw new Error('NIL analysis workspace exceeds 8 MiB.');
      cursor = byteOffset(primary.text, document);
    } catch (error) { return Promise.reject(error); }
    if (this.queued >= MAX_JOBS) return Promise.reject(new Error('NIL analysis is busy; retry shortly.'));
    const key = `${kind}:${primary.path}`;
    this.controllers.get(key)?.abort();
    const controller = new AbortController(); this.controllers.set(key, controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    this.queued++;
    const operation = this.queue.catch(() => undefined).then(async () => {
      if (this.closed || controller.signal.aborted) throw new Error('NIL analysis cancelled.');
      const tools = resolveNyToolchain(this.root, this.options);
      if (!tools.compiler || tools.family !== 'nil') throw new NilAnalysisUnavailableError('Live analysis requires a current NIL Framework SDK with nilcompiler.');
      const args = ['--analyze', '--workspace-stdin', primary.path, ...(kind === 'completion' ? ['--completion-at', String(cursor)] : kind === 'definition' ? ['--semantic-index'] : [])];
      if (this.context.noStdlib) args.push('--no-stdlib');
      for (const rule of this.context.disabledRules ?? []) args.push('--disable-rule', rule);
      if (this.context.warningsAsErrors) args.push('--warnings-as-errors');
      const roots = new Set([...(this.context.includePaths ? [] : [dirname(primary.path)]), ...((this.context.sdkPath ?? tools.sdkPath) ? [this.context.sdkPath ?? tools.sdkPath!] : []), ...(this.context.includePaths ?? [this.root])]);
      for (const root of roots) args.push('-I', resolve(this.root, root));
      const result = await new Promise<Analysis>((done, reject) => {
        const child = execFile(tools.compiler!, args, { cwd: this.root, encoding: 'utf8', windowsHide: true, env: this.options.environment ?? process.env,
          timeout: 10000, maxBuffer: MAX_OUTPUT, killSignal: 'SIGKILL', signal: controller.signal }, (error, stdout, stderr) => {
          if (controller.signal.aborted) { reject(new Error('NIL analysis cancelled.')); return; }
          if (error && (error.code !== 1 || error.killed || error.signal)) { reject(new Error(`NIL analysis failed: ${error.message}${stderr ? `\n${stderr.slice(0, 1000)}` : ''}`)); return; }
          try { done(parseNilAnalysis(stdout, primary, error ? 1 : 0)); } catch (failure) { reject(failure); }
        });
        child.stdin?.on('error', () => undefined); child.stdin?.end(input, 'utf8');
      });
      if (this.closed || controller.signal.aborted) throw new Error('NIL analysis cancelled.');
      return { result, primary, inputs, cursor };
    });
    this.queue = operation.finally(() => {
      this.queued--; signal?.removeEventListener('abort', abort);
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
    });
    void this.queue.catch(() => undefined);
    return operation;
  }
}
