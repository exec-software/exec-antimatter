import { constants, realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { NyInspectedConstant, NyInspectedFunction, NyInspectedInstruction, NyInspectedLocal, NyInspectedType, NyModuleInspection } from '../../api/nyInspector';

export const MAX_NY_INSPECTION_BYTES = 16 * 1024 * 1024;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_RECORDS = 200_000;
const MAX_INSTRUCTIONS = 50_000;
const MAX_FUNCTIONS = 5000;
const MAX_SOURCE_LOOKUPS = 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
// Ny v1's named opcode table. Inspection decodes structure, not VM execution semantics.
const OPCODES = new Set(`PUSH_CONST_STR PUSH_CONST PUSH_FN_PTR POP LOAD_LOCAL STORE_LOCAL REF_LOCAL LOAD_GLOBAL STORE_GLOBAL CALL RET NOP JMP_IF_NOT JMP JMP_IF LABEL CMP_EQ CMP_NE CMP_LT CMP_LE CMP_GT CMP_GE NOT ADD SUB MUL DIV MOD NEG BIT_AND BIT_OR BIT_XOR SHL SHR ALLOC FREE READ_PTR WRITE_PTR NEW_STRUCT GET_FIELD SET_FIELD SET_FIELD_PTR NEW_ARRAY GET_INDEX SET_INDEX LEN NEW_VARIANT IS_VARIANT UNWRAP_VARIANT NEW_ARRAY_LITERAL STR_CONCAT TO_STRING CAST STRLEN INTEROP_CALL MATH_SIN MATH_COS MATH_TAN MATH_ASIN MATH_ACOS MATH_ATAN MATH_ATAN2 MATH_SQRT MATH_POW MATH_EXP MATH_LOG MATH_LOG10 MATH_ABS MATH_FLOOR MATH_CEIL MATH_ROUND MATH_TRUNC MATH_CBRT MATH_MIN MATH_MAX CONSOLE_WRITE CONSOLE_WRITELN TIME_NOW TIME_SLEEP PTR_ADD PTR_SUB INLINE_ASM FAULT_ENTER FAULT_LEAVE FAULT_RAISE FAULT_SAVE FAULT_MATCH FAULT_BIND FAULT_DROP FAULT_RESUME FAULT_RETHROW CLASS_UPCAST CALL_METHOD PARALLEL_MAP OWN_ENTER OWN_LEAVE OWN_BIND OWN_MOVE OWN_ALLOC`.split(' '));
const invalid = (detail: string): never => { throw new Error(`Cannot inspect NIL: ${detail}`); };
const utf8 = (bytes: Buffer): string => { try { return decoder.decode(bytes); } catch { return invalid('invalid UTF-8 metadata.'); } };
const number = (value: string, maximum = 2147483647): number => {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) return invalid('invalid numeric metadata.');
  return Number(value);
};
class Budget {
  records = 0;
  instructions = 0;
  take(count: number, maximum = 65_536): number {
    if (count > maximum || (this.records += count) > MAX_RECORDS) invalid('module exceeds the inspector record limit.');
    return count;
  }
  instruction(): void { this.take(1); if (++this.instructions > MAX_INSTRUCTIONS) invalid('module exceeds the 50,000-instruction inspection limit.'); }
}
class Cursor {
  constructor(readonly bytes: Buffer, public position: number, readonly end: number, readonly budget: Budget) {}
  need(length: number): void { if (length > this.end - this.position) invalid('truncated binary record.'); }
  u32(): number { this.need(4); const value = this.bytes.readUInt32LE(this.position); this.position += 4; return value; }
  u64(): number { this.need(8); const value = this.bytes.readBigUInt64LE(this.position); this.position += 8; if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid('binary offset exceeds the supported range.'); return Number(value); }
  count(maximum = 65_536): number { return this.budget.take(this.u32(), maximum); }
  data(): Buffer { const length = this.u32(); if (length > MAX_STRING_BYTES) invalid('a string exceeds the 1 MiB inspection limit.'); this.need(length); const data = this.bytes.subarray(this.position, this.position + length); this.position += length; return data; }
  string(): string { const value = utf8(this.data()); if (value.includes('\0')) invalid('NUL in a metadata string.'); return value; }
  strings(): string[] { return Array.from({ length: this.count() }, () => this.string()); }
  done(): void { if (this.position !== this.end) invalid('unconsumed bytes in a binary section.'); }
}
const freshFunction = (name: string): NyInspectedFunction => ({ name, parameters: [], generics: [], returnType: '', inline: false, test: false, declarationLine: 0, annotations: [], instructions: [] });
const emptyModule = (bytes: number): NyModuleInspection => ({ path: '', modified: 0, format: 'text', version: null, flags: 0, byteLength: bytes,
  moduleName: '', library: false, debugInfo: false, functions: [], constants: [], types: [], tests: [], embeddedSources: [], dependencies: [],
  warnings: ['Structural inspection only; compiler and runtime validation remain authoritative.'] });
function constant(name: string, bytes: Buffer): NyInspectedConstant {
  try { return { name, value: decoder.decode(bytes), byteLength: bytes.length, encoding: 'utf8' }; }
  catch { return { name, value: bytes.toString('hex'), byteLength: bytes.length, encoding: 'hex' }; }
}
function opcode(name: string): string { if (!OPCODES.has(name)) invalid(`unsupported opcode "${name.slice(0, 100)}". This artifact may require a newer inspector.`); return name; }
function debugMetadata(path: string, locals: NyInspectedLocal[]): void {
  const names = new Set<string>(), storage = new Set<string>();
  const checked = (value: string, empty = false) => { if ((!empty && !value) || Buffer.byteLength(value) > 16384 || /[\x00-\x1f\x7f]/.test(value)) invalid('invalid source-debug string.'); };
  checked(path, true);
  if ((!path && locals.length) || locals.length > 1024) invalid('invalid source-debug local count.');
  for (const local of locals) {
    checked(local.name); checked(local.storage); checked(local.type);
    if (local.depth > 1024 || names.has(local.name) || storage.has(local.storage)) invalid('invalid or duplicate source-debug binding.');
    names.add(local.name); storage.add(local.storage);
  }
}

function binary(bytes: Buffer, result: NyModuleInspection, budget: Budget): void {
  const header = new Cursor(bytes, 4, bytes.length, budget);
  const version = header.u32(), flags = header.u32(), count = header.count(8);
  if (![1, 2, 3, 4, 5].includes(version)) invalid(`unsupported binary version ${version}. Supported versions are 1–5.`);
  const library = flags === 1 && (version === 2 || version === 4);
  if ((!library && flags !== 0) || (version === 2 && !library)) invalid(`unsupported flags ${flags} for binary version ${version}.`);
  const required = [1, 2, 3, 4, 5, ...(library ? [6] : []), ...(version >= 4 ? [7] : []), ...(version === 5 ? [8] : [])];
  if (count !== required.length) invalid('unexpected binary section count.');
  const sections = new Map<number, { offset: number; size: number }>();
  for (let index = 0; index < count; index++) {
    const type = header.u32(), offset = header.u64(), size = header.u64();
    if (!required.includes(type) || sections.has(type)) invalid('unknown or duplicate binary section.');
    if (!size || offset > bytes.length || size > bytes.length - offset) invalid('binary section lies outside the file.');
    sections.set(type, { offset, size });
  }
  let end = header.position;
  for (const section of [...sections.values()].sort((a, b) => a.offset - b.offset)) {
    if (section.offset !== end) invalid('binary sections overlap or leave unclaimed bytes.');
    end += section.size;
  }
  if (end !== bytes.length) invalid('trailing bytes after binary sections.');
  const section = (type: number) => { const found = sections.get(type)!; return new Cursor(bytes, found.offset, found.offset + found.size, budget); };
  Object.assign(result, { format: 'binary', version, flags, library });
  let cursor = section(1);
  if (version < 3) { if (cursor.u32() !== 0) invalid('legacy binary schema records are unsupported.'); }
  else for (const kind of ['struct', 'enum'] as const) {
    const count = cursor.count(MAX_FUNCTIONS);
    for (let index = 0; index < count; index++) {
      const type: NyInspectedType = { kind, name: cursor.string(), members: [] };
      for (let member = cursor.count(); member > 0; member--) type.members.push({ name: cursor.string(), type: cursor.string() });
      result.types.push(type);
    }
  }
  cursor.done();
  cursor = section(2);
  for (let count = cursor.count(MAX_FUNCTIONS); count > 0; count--) {
    const fn = freshFunction(cursor.string());
    if (!fn.name) invalid('empty function name.');
    fn.parameters = cursor.strings(); fn.generics = cursor.strings(); fn.returnType = cursor.string();
    if (version >= 3) {
      const flags = cursor.u32(); if (flags > 3) invalid('unknown function flags.');
      fn.inline = !!(flags & 1); fn.test = !!(flags & 2); fn.declarationLine = cursor.u32();
      if (fn.declarationLine > 2147483647) invalid('invalid declaration line.');
      fn.annotations = cursor.strings();
      if (fn.annotations.some(value => !value.startsWith('@'))) invalid('invalid function annotation.');
    }
    for (let count = cursor.count(MAX_INSTRUCTIONS); count > 0; count--) {
      budget.instruction();
      const instruction: NyInspectedInstruction = { offset: fn.instructions.length, opcode: opcode(cursor.string()), operands: cursor.strings(), debugLine: cursor.u32() };
      if (instruction.debugLine > 2147483647) invalid('invalid instruction line.');
      fn.instructions.push(instruction);
    }
    result.functions.push(fn);
  }
  cursor.done();
  cursor = section(3);
  for (let count = cursor.count(); count > 0; count--) result.constants.push(constant(cursor.string(), cursor.data()));
  cursor.done(); cursor = section(4); if (cursor.u32() !== 0) invalid('nonzero reserved symbol section.'); cursor.done();
  cursor = section(5); result.moduleName = cursor.string(); result.tests = cursor.strings(); cursor.done();
  if (library) {
    cursor = section(6);
    for (let count = cursor.count(10_000); count > 0; count--) result.embeddedSources.push({ path: cursor.string(), byteLength: cursor.data().length });
    result.dependencies = cursor.strings(); cursor.done();
    result.warnings.push('Library source interfaces are metadata; inspection does not extract or execute them.');
  }
  if (version >= 4) {
    cursor = section(7);
    for (let count = cursor.count(MAX_FUNCTIONS); count > 0; count--) {
      const type: NyInspectedType = { kind: 'class', name: cursor.string(), members: [], methods: [] };
      const abstract = cursor.u32(); if (abstract > 1) invalid('invalid class flags.'); type.abstract = abstract === 1;
      type.bases = cursor.strings();
      for (let count = cursor.count(); count > 0; count--) {
        const name = cursor.string(), implementation = cursor.string(), receiverType = cursor.string(), returnType = cursor.string(), flags = cursor.u32();
        if (flags > 3) invalid('unknown method flags.');
        type.methods!.push({ name, implementation, receiverType, returnType, virtual: !!(flags & 1), abstract: !!(flags & 2), parameters: cursor.strings() });
      }
      result.types.push(type);
    }
    cursor.done();
  }
  if (version === 5) {
    cursor = section(8);
    if (cursor.u32() !== result.functions.length) invalid('source-debug function count mismatch.');
    for (const fn of result.functions) {
      if (cursor.u32() !== fn.instructions.length) invalid('source-debug instruction count mismatch.');
      for (const instruction of fn.instructions) {
        const path = cursor.string(), locals: NyInspectedLocal[] = [];
        for (let count = cursor.count(1024); count > 0; count--) locals.push({ name: cursor.string(), storage: cursor.string(), type: cursor.string(), depth: cursor.u32() });
        debugMetadata(path, locals);
        if (path) { result.debugInfo = true; instruction.source = { path, line: instruction.debugLine }; instruction.locals = locals; }
      }
    }
    cursor.done();
  }
}

/** NIL escapes differ from JSON: unknown escapes remain literal, and \0 is supported. */
function tokens(text: string): { values: string[]; comment: string } {
  const values: string[] = []; let position = 0;
  while (position < text.length) {
    while (/[ \t]/.test(text[position] ?? '') && position < text.length) position++;
    if (position >= text.length) break;
    if (text[position] === ';') return { values, comment: text.slice(position + 1).trim() };
    let value = '';
    if (text[position] === '"') {
      position++; let closed = false;
      while (position < text.length) {
        const char = text[position++]; if (char === '"') { closed = true; break; }
        if (char === '\\' && position < text.length) {
          const escaped = text[position++]; const known: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0', '\\': '\\', '"': '"' };
          value += known[escaped] ?? `\\${escaped}`;
        } else value += char;
      }
      if (!closed) invalid('unterminated quoted text.');
      if (position < text.length && !/[ \t,;]/.test(text[position])) invalid('unexpected text after a quoted string.');
      if (text[position] === ',') position++;
    } else {
      const start = position; while (position < text.length && !/[ \t;]/.test(text[position])) position++;
      value = text.slice(start, position).replace(/,$/, '');
    }
    if (Buffer.byteLength(value) > MAX_STRING_BYTES || values.length >= 65536) invalid('text record exceeds the inspection limit.');
    values.push(value);
  }
  return { values, comment: '' };
}
function parameters(text: string): string[] {
  const result: string[] = []; const stack: string[] = []; let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if ('(<['.includes(char)) stack.push(char);
    else if (')>]'.includes(char) && !(char === '>' && text[index - 1] === '-')) {
      if (stack.pop() !== { ')': '(', '>': '<', ']': '[' }[char]) invalid('unbalanced function parameter type.');
    } else if (char === ',' && !stack.length) { result.push(text.slice(start, index).trim()); start = index + 1; }
  }
  if (stack.length) invalid('unbalanced function parameter type.');
  if (text.trim()) result.push(text.slice(start).trim());
  if (result.some(value => !value)) invalid('empty function parameter.');
  return result;
}
function functionHeader(line: string): NyInspectedFunction {
  if (!line.endsWith(':')) invalid('function header must end with a colon.');
  const header = line.slice(9, -1).trim(), open = header.indexOf('('), arrow = header.indexOf('->');
  let name = '', params: string[] = [], tail = '';
  if (open !== -1 && (arrow === -1 || open < arrow)) {
    name = header.slice(0, open).trim(); let depth = 1, close = open + 1;
    for (; close < header.length && depth; close++) { if (header[close] === '(') depth++; if (header[close] === ')') depth--; }
    if (depth) invalid('unterminated function parameter list.');
    params = parameters(header.slice(open + 1, close - 1)); tail = header.slice(close).trim();
  } else { name = (arrow < 0 ? header : header.slice(0, arrow)).trim(); tail = arrow < 0 ? '' : header.slice(arrow).trim(); }
  if (!name || /\s/.test(name) || (tail && (!tail.startsWith('->') || !tail.slice(2).trim()))) invalid('invalid function signature.');
  return { ...freshFunction(name), parameters: params, returnType: tail ? tail.slice(2).trim() : '' };
}

function textual(bytes: Buffer, result: NyModuleInspection, budget: Budget): void {
  const text = utf8(bytes); if (text.includes('\0')) invalid('unexpected NUL in text NIL.');
  let fn: NyInspectedFunction | undefined, type: NyInspectedType | undefined, annotations: string[] = [], declaration: number | undefined;
  let source: { path: string; locals: NyInspectedLocal[] } | undefined;
  let seenModule = false;
  const lines = text.split('\n');
  if (lines.length > MAX_RECORDS) invalid('text module exceeds the line limit.');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim(); if (!line) continue;
    if (Buffer.byteLength(line) > MAX_STRING_BYTES) invalid(`line ${index + 1} exceeds the inspection limit.`);
    try {
      if (line.startsWith('#')) {
        const record = line.slice(1).trim(), { values, comment } = tokens(record);
        if (values[0] === 'source_debug') {
          if (!fn || source || comment || values.length < 4 || number(values[1]) !== fn.instructions.length || !values[2]) invalid('invalid or orphan source-debug record.');
          const count = number(values[3], 1024); if (values.length !== 4 + count * 4) invalid('source-debug local count mismatch.');
          const locals: NyInspectedLocal[] = []; budget.take(count);
          for (let n = 0; n < count; n++) { const offset = 4 + n * 4; locals.push({ name: values[offset], storage: values[offset + 1], type: values[offset + 2], depth: number(values[offset + 3], 1024) }); }
          debugMetadata(values[2], locals); source = { path: values[2], locals };
        } else if (values[0] === 'declaration_line') {
          if (fn || type || declaration !== undefined || values.length !== 2 || comment) invalid('invalid or orphan declaration-line record.');
          declaration = number(values[1]);
        } else if (values[0] === 'function_annotation') {
          if (fn || type || declaration !== undefined || values.length !== 2 || !values[1].startsWith('@') || values[1].includes('\0') || comment) invalid('invalid function annotation.');
          annotations.push(values[1]); budget.take(1);
        }
        continue;
      }
      if (fn) {
        if (line === 'end function') { if (source) invalid('orphan source-debug record.'); fn = undefined; continue; }
        const { values, comment } = tokens(line); budget.take(values.length); budget.instruction();
        const debug = /^line\s+(\S+)/.exec(comment);
        if (comment.startsWith('line') && !debug) invalid('invalid instruction line metadata.');
        const instruction: NyInspectedInstruction = { offset: fn.instructions.length, opcode: opcode(values[0]), operands: values.slice(1), debugLine: debug ? number(debug[1]) : 0 };
        if (source) { instruction.source = { path: source.path, line: instruction.debugLine }; instruction.locals = source.locals; source = undefined; result.debugInfo = true; }
        fn.instructions.push(instruction); continue;
      }
      if (type) {
        if (line === `end ${type.kind}`) { type = undefined; continue; }
        if (type.kind === 'class') {
          const { values, comment } = tokens(line); budget.take(values.length);
          if (comment) invalid('unexpected class metadata comment.');
          if (values[0] === 'base' && values.length === 2) type.bases!.push(values[1]);
          else if (values[0] === 'method' && values.length >= 8 && number(values[5], 1) <= 1 && number(values[6], 1) <= 1 && number(values[7], 65536) === values.length - 8) {
            type.methods!.push({ name: values[1], implementation: values[2] === '-' ? '' : values[2], receiverType: values[3], returnType: values[4], virtual: values[5] === '1', abstract: values[6] === '1', parameters: values.slice(8) });
          } else invalid('invalid class metadata.');
        } else {
          const colon = line.indexOf(':'); const name = (colon < 0 ? line : line.slice(0, colon)).trim(), value = colon < 0 ? '' : line.slice(colon + 1).trim();
          if (!name || (type.kind === 'struct' && !value) || /\s/.test(name)) invalid('invalid schema member.');
          type.members.push({ name, type: value }); budget.take(1);
        }
        continue;
      }
      if ((annotations.length || declaration !== undefined) && !line.startsWith('function ') && !line.startsWith('@')) invalid('orphan function metadata.');
      if (line.startsWith('module ')) {
        if (seenModule || !line.slice(7).trim()) invalid('invalid or duplicate module declaration.');
        result.moduleName = line.slice(7).trim(); seenModule = true;
      } else if (line.startsWith('const ')) {
        const match = /^const\s+(\S+)\s*=\s*(".*")$/.exec(line); if (!match) invalid('malformed constant.');
        const parsed = tokens(match![2]); if (parsed.values.length !== 1 || parsed.comment) invalid('malformed constant.');
        result.constants.push(constant(match![1], Buffer.from(parsed.values[0]))); budget.take(1);
      } else if (/^(struct|enum|class) /.test(line)) {
        const { values } = tokens(line), kind = values[0] as NyInspectedType['kind'];
        if (values.length !== (kind === 'class' ? 3 : 2)) invalid('invalid type declaration.');
        type = { name: values[1], kind, members: [] };
        if (kind === 'class') { type.abstract = number(values[2], 1) === 1; type.bases = []; type.methods = []; }
        result.types.push(type); budget.take(1);
      } else if (line.startsWith('@test ')) { result.tests.push(line.slice(6).trim()); budget.take(1); }
      else if (line.startsWith('@')) { if (declaration !== undefined) invalid('annotation follows declaration metadata.'); annotations.push(line); budget.take(1); }
      else if (line.startsWith('function ')) {
        if (result.functions.length >= MAX_FUNCTIONS) invalid('module exceeds the 5,000-function inspection limit.');
        fn = functionHeader(line); fn.annotations = annotations; annotations = []; fn.declarationLine = declaration ?? 0; declaration = undefined;
        fn.inline = fn.annotations.some(value => value.startsWith('@inline')); fn.test = fn.annotations.some(value => value.startsWith('@test'));
        result.functions.push(fn); budget.take(fn.parameters.length + 1);
      } else invalid(`unexpected record "${line.slice(0, 80)}".`);
    } catch (error) { throw new Error(`${(error as Error).message} (text line ${index + 1})`); }
  }
  if (fn || type || source || annotations.length || declaration !== undefined) invalid('truncated text module or orphan metadata.');
  if (!seenModule && !result.functions.length && !result.types.length && !result.constants.length) invalid('file has no NIL module records.');
}

/** Decode structure only; no module code, embedded source, or annotation is executed. */
export function parseNyModule(bytes: Buffer): NyModuleInspection {
  if (!bytes.length || bytes.length > MAX_NY_INSPECTION_BYTES) invalid('choose a nonempty NIL module up to 16 MiB.');
  const result = emptyModule(bytes.length), budget = new Budget();
  if (bytes.subarray(0, 4).equals(Buffer.from('NIL\0')) || bytes.subarray(0, 4).equals(Buffer.from('MIL\0'))) {
    if (bytes[0] === 77) result.warnings.push('Legacy MIL binary identity; records are decoded using the NIL layout.');
    binary(bytes, result, budget);
  } else textual(bytes, result, budget);
  if (new Set(result.functions.map(fn => fn.name)).size !== result.functions.length) invalid('duplicate function names.');
  if (!result.debugInfo) result.warnings.push('No source map is present. Rebuild with --debug-info for source navigation; instruction line hints alone are not source locations.');
  return result;
}

export function nyModulePath(root: string, path: string): string {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw new Error('Choose a NIL module.');
  const base = realpathSync(root), file = realpathSync(resolve(base, path)), local = relative(base, file);
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || extname(file).toLowerCase() !== '.nil') throw new Error('Choose a .nil module inside this project.');
  const stat = statSync(file);
  if (!stat.isFile() || !stat.size || stat.size > MAX_NY_INSPECTION_BYTES) throw new Error('NIL inspection supports regular files up to 16 MiB.');
  return file;
}

export async function inspectNyModule(root: string, path: string): Promise<NyModuleInspection> {
  const base = realpathSync(root), file = nyModulePath(base, path);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let result: NyModuleInspection;
  try {
    const stat = await handle.stat(); if (!stat.isFile() || !stat.size || stat.size > MAX_NY_INSPECTION_BYTES) throw new Error('NIL inspection supports regular files up to 16 MiB.');
    const data = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < data.length) { const read = await handle.read(data, length, data.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat();
    if (length !== stat.size || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) throw new Error('The NIL module changed while inspecting it. Refresh and try again.');
    result = parseNyModule(data.subarray(0, length));
    result.path = relative(base, file).split(sep).join('/'); result.modified = stat.mtimeMs;
  } finally { await handle.close(); }
  const mapped = new Map<string, string | undefined>();
  let lookups = 0, sourceLimitReached = false;
  for (const fn of result.functions) for (const instruction of fn.instructions) {
    if (!instruction.source) continue;
    const { path: source, line } = instruction.source;
    if (!mapped.has(source)) {
      let workspacePath: string | undefined;
      try {
        const candidate = resolve(base, source), lexical = relative(base, candidate);
        if (lexical && !isAbsolute(lexical) && lexical !== '..' && !lexical.startsWith(`..${sep}`) && /\.(?:ny|matrix|mat)$/i.test(candidate)) {
          if (lookups >= MAX_SOURCE_LOOKUPS) sourceLimitReached = true;
          else {
            lookups++;
            const target = realpathSync(candidate), local = relative(base, target);
            if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && /\.(?:ny|matrix|mat)$/i.test(target) && statSync(target).isFile()) workspacePath = local.split(sep).join('/');
          }
        }
      } catch { /* Metadata is not authority to read missing or external source files. */ }
      mapped.set(source, workspacePath);
    }
    if (line > 0 && mapped.get(source)) instruction.source.workspacePath = mapped.get(source);
  }
  if (sourceLimitReached) result.warnings.push('Source navigation is limited to the first 1,024 distinct workspace source paths. All source-map metadata remains visible.');
  return result;
}
