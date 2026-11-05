import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectNyModule, MAX_NY_INSPECTION_BYTES, nyModulePath, parseNyModule } from '../src/main/environment/nyInspector';
import { resolveNyToolchain } from '../src/main/environment/ny';
import * as files from '../src/main/environment/files';

const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const u64 = (value: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
const str = (value: string | Buffer) => { const bytes = typeof value === 'string' ? Buffer.from(value) : value; return Buffer.concat([u32(bytes.length), bytes]); };
const list = (...values: string[]) => Buffer.concat([u32(values.length), ...values.map(str)]);
function artifact(version = 3, flags = 0, overrides: Record<number, Buffer> = {}): Buffer {
  const sections: Record<number, Buffer> = {
    1: version >= 3 ? Buffer.concat([u32(0), u32(0)]) : u32(0),
    2: Buffer.concat([u32(1), str('main'), list(), list(), str('i32'), ...(version >= 3 ? [u32(0), u32(1), list()] : []),
      u32(2), str('PUSH_CONST'), list('7'), u32(2), str('RET'), list(), u32(2)]),
    3: Buffer.concat([u32(1), str('opaque'), str(Buffer.from([255, 0, 128]))]),
    4: u32(0), 5: Buffer.concat([str('sample'), list('main')]),
    ...(flags === 1 ? { 6: Buffer.concat([u32(1), str('library.ny'), str('module sample'), list('dependency')]) } : {}),
    ...(version >= 4 ? { 7: u32(0) } : {}),
    ...(version === 5 ? { 8: Buffer.concat([u32(1), u32(2), str('src/main.ny'), u32(0), str('src/main.ny'), u32(1), str('value'), str('$ny.local.1'), str('i32'), u32(1)]) } : {}),
    ...overrides,
  };
  let offset = 16 + Object.keys(sections).length * 20;
  const entries = Object.entries(sections).map(([type, bytes]) => { const entry = Buffer.concat([u32(Number(type)), u64(offset), u64(bytes.length)]); offset += bytes.length; return entry; });
  return Buffer.concat([Buffer.from('NIL\0'), u32(version), u32(flags), u32(entries.length), ...entries, ...Object.values(sections)]);
}
function fixture(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-nil-inspection-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}

test('NIL binary versions retain functions, opaque constants, library interfaces and v5 source maps', () => {
  for (const [version, flags] of [[1, 0], [2, 1], [3, 0], [4, 0], [4, 1], [5, 0]]) {
    const parsed = parseNyModule(artifact(version, flags));
    assert.equal(parsed.format, 'binary'); assert.equal(parsed.version, version); assert.equal(parsed.moduleName, 'sample');
    assert.equal(parsed.library, flags === 1); assert.equal(parsed.debugInfo, version === 5);
    assert.deepEqual(parsed.functions[0].instructions.map(item => [item.offset, item.opcode, item.operands]), [[0, 'PUSH_CONST', ['7']], [1, 'RET', []]]);
    assert.deepEqual(parsed.constants[0], { name: 'opaque', value: 'ff0080', encoding: 'hex', byteLength: 3 });
    if (flags) { assert.deepEqual(parsed.embeddedSources, [{ path: 'library.ny', byteLength: 13 }]); assert.deepEqual(parsed.dependencies, ['dependency']); }
    if (version === 5) assert.deepEqual(parsed.functions[0].instructions[1].locals, [{ name: 'value', storage: '$ny.local.1', type: 'i32', depth: 1 }]);
  }
});

test('NIL text inspection preserves escaped strings, schemas, annotations, nested signatures and mapped locals', () => {
  const source = `# NIL Textual Module
module demo
const message = "hello\\n\\0\\\\world"
struct Point
    x: i32
end struct
enum Choice
    None
    Some: i32
end enum
class Parent 1
    method read - "Parent" "i32" 1 1 0
end class
# function_annotation "@ai_context(\\\"hello\\nworld\\\")"
# declaration_line 4
function main(callback: fn(i32, i32) -> i32, point: ref<Point>) -> i32:
    # source_debug 0 "/project/main.ny" 1 "value" "$ny.local.1" "i32" 1
    PUSH_CONST 7 ; line 5
    RET ; line 6
end function
@test main
`;
  const parsed = parseNyModule(Buffer.from(source));
  assert.equal(parsed.constants[0].value, 'hello\n\0\\world');
  assert.deepEqual(parsed.types.map(type => type.kind), ['struct', 'enum', 'class']);
  assert.equal(parsed.types[2].methods![0].abstract, true);
  const fn = parsed.functions[0]; assert.equal(fn.declarationLine, 4);
  assert.deepEqual(fn.parameters, ['callback: fn(i32, i32) -> i32', 'point: ref<Point>']);
  assert.equal(fn.annotations[0], '@ai_context("hello\nworld")');
  assert.equal(fn.instructions[0].source?.path, '/project/main.ny');
  assert.equal(fn.instructions[0].source?.line, 5); assert.equal(fn.instructions[1].source, undefined);
  assert.deepEqual(parsed.tests, ['main']);
});

test('NIL rejects truncated, overlapping, duplicate, future and malformed binary records', () => {
  const valid = artifact(5);
  for (const size of [1, 3, 4, 15, 16, 30, valid.length - 1]) assert.throws(() => parseNyModule(valid.subarray(0, size)));
  const future = Buffer.from(valid); future.writeUInt32LE(99, 4); assert.throws(() => parseNyModule(future), /unsupported binary version 99/);
  const flags = Buffer.from(valid); flags.writeUInt32LE(1, 8); assert.throws(() => parseNyModule(flags), /unsupported flags/);
  const overlap = Buffer.from(valid); overlap.writeBigUInt64LE(0n, 20); assert.throws(() => parseNyModule(overlap), /overlap/);
  const duplicate = Buffer.from(valid); duplicate.writeUInt32LE(1, 36); assert.throws(() => parseNyModule(duplicate), /duplicate/);
  const oversized = Buffer.from(valid); oversized.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 20); assert.throws(() => parseNyModule(oversized), /offset/);
  assert.throws(() => parseNyModule(Buffer.concat([valid, Buffer.from([0])])), /trailing/);
  assert.throws(() => parseNyModule(artifact(3, 0, { 4: u32(1) })), /reserved/);
  assert.throws(() => parseNyModule(artifact(3, 0, { 2: u32(999999) })), /limit/);
  assert.throws(() => parseNyModule(artifact(5, 0, { 8: u32(0) })), /count mismatch/);
});

test('NIL rejects nonmodules, unknown instructions, orphan metadata and truncated text', () => {
  for (const source of ['', 'not a NIL module', 'module test\nfunction main -> i32:\nPUSH_CONST 1\n',
    'module test\n# declaration_line 4\n', 'module test\nfunction main:\nUNKNOWN_VM_OPCODE\nend function\n',
    'module test\nfunction main:\n# source_debug 0 "a.ny" 0\nend function\n', 'module test\nconst a = "unterminated\n',
    'module test\nfunction main:\n# source_debug 1 "a.ny" 0\nRET\nend function\n']) assert.throws(() => parseNyModule(Buffer.from(source)));
  assert.throws(() => parseNyModule(Buffer.alloc(MAX_NY_INSPECTION_BYTES + 1)), /16 MiB/);
});

test('NIL source links use only existing mapped workspace Ny and Matrix sources and block symlink escapes', async (t) => {
  const root = fixture(t), outside = fixture(t);
  writeFileSync(join(root, 'main.ny'), 'fn main()\nend fn\n'); writeFileSync(join(outside, 'outside.ny'), 'private');
  const source = (path: string) => `module sample\nfunction main:\n# source_debug 0 ${JSON.stringify(path)} 0\nRET ; line 2\nend function\n`;
  const file = join(root, 'program.nil'); writeFileSync(file, source(join(root, 'main.ny')));
  let parsed = await inspectNyModule(root, 'program.nil'); assert.equal(parsed.path, 'program.nil'); assert.ok(parsed.modified > 0);
  assert.equal(parsed.functions[0].instructions[0].source?.workspacePath, 'main.ny');
  for (const path of ['source.matrix', 'source.mat', 'UPPER.MATRIX']) {
    writeFileSync(join(root, path), 'main returns number begin paragraph\n    give 0\nend paragraph\n');
    writeFileSync(file, source(join(root, path)));
    parsed = await inspectNyModule(root, 'program.nil');
    assert.equal(parsed.functions[0].instructions[0].source?.workspacePath, path);
  }
  writeFileSync(join(root, 'plain.txt'), 'text');
  writeFileSync(file, source(join(root, 'plain.txt')));
  parsed = await inspectNyModule(root, 'program.nil');
  assert.equal(parsed.functions[0].instructions[0].source?.workspacePath, undefined);
  for (const path of [join(outside, 'outside.ny'), join(root, 'missing.ny')]) {
    writeFileSync(file, source(path)); parsed = await inspectNyModule(root, 'program.nil'); assert.equal(parsed.functions[0].instructions[0].source?.workspacePath, undefined);
  }
  symlinkSync(join(outside, 'outside.ny'), join(root, 'link.ny'));
  writeFileSync(file, source('link.ny')); parsed = await inspectNyModule(root, 'program.nil'); assert.equal(parsed.functions[0].instructions[0].source?.workspacePath, undefined);
  writeFileSync(join(outside, 'outside.nil'), artifact()); symlinkSync(join(outside, 'outside.nil'), join(root, 'escape.nil'));
  assert.throws(() => nyModulePath(root, 'escape.nil'), /inside this project/);
  assert.throws(() => nyModulePath(root, join(outside, 'outside.nil')), /inside this project/);
});

test('editor opens NIL as read-only metadata above the text limit without decoding its bytes', (t) => {
  const root = fixture(t); files.useRoot(root);
  const path = join(root, 'large.nil'), descriptor = openSync(path, 'w');
  ftruncateSync(descriptor, 5 * 1024 * 1024); closeSync(descriptor);
  const content = files.read('large.nil'); assert.equal(content.binary, true); assert.equal(content.text, ''); assert.equal(content.size, 5 * 1024 * 1024);
  assert.throws(() => parseNyModule(readFileSync(path)), /Cannot inspect NIL/);
  const links = fixture(t), alias = join(links, 'project'); symlinkSync(root, alias, 'dir'); files.useRoot(alias);
  assert.equal(files.read(path).path, 'large.nil', 'canonical artifact paths work when the chosen project root is a symlink');
  assert.equal(files.read('large.nil').path, 'large.nil');
});

test('source navigation bounds filesystem lookups while retaining every map record', async (t) => {
  const root = fixture(t);
  const instructions = Array.from({ length: 1026 }, (_, index) => `# source_debug ${index} "missing-${index}.ny" 0\nNOP ; line 1\n`).join('');
  writeFileSync(join(root, 'maps.nil'), `module maps\nfunction main:\n${instructions}end function\n`);
  const parsed = await inspectNyModule(root, 'maps.nil');
  assert.equal(parsed.functions[0].instructions.length, 1026);
  assert.ok(parsed.warnings.some(warning => warning.includes('1,024')));
  assert.equal(parsed.functions[0].instructions[1025].source?.path, 'missing-1025.ny');
});

const sdk = resolveNyToolchain(process.cwd(), { sdkPath: process.env.ANTIMATTER_NY_TEST_SDK });
test('actual Ny SDK text, class-bearing binary, source-debug binary and library builds produce readable inspector data', { skip: !sdk.compiler }, async (t) => {
  const root = fixture(t), source = join(root, 'main.ny');
  writeFileSync(source, 'class Counter\n    value: i32\n    pub fn read(self) -> i32\n        return self.value\n    end fn\nend class\nfn main() -> i32\n    let counter = Counter { value: 7 }\n    println("NIL inspection")\n    return counter.read()\nend fn\n');
  const variants = [{ name: 'text', args: ['--debug-info'], version: null }, { name: 'binary', args: ['--emit-binary-nil'], version: 4 }, { name: 'debug', args: ['--emit-binary-nil', '--debug-info'], version: 5 }];
  for (const variant of variants) {
    const path = join(root, `${variant.name}.nil`);
    execFileSync(sdk.compiler!, ['--no-bundle', '--quiet', '--no-stdlib', ...variant.args, '--output', path, source]);
    const parsed = await inspectNyModule(root, path);
    assert.equal(parsed.version, variant.version); assert.ok(parsed.functions.some(fn => fn.name === 'main'));
    assert.ok(parsed.types.some(type => type.kind === 'class' && type.name === 'Counter'));
    assert.ok(parsed.constants.some(value => value.value === 'NIL inspection'));
    const instructions = parsed.functions.find(fn => fn.name === 'main')!.instructions;
    assert.ok(instructions.some(item => item.opcode === 'CALL_METHOD'));
    if (variant.name !== 'binary') assert.ok(instructions.some(item => item.source?.workspacePath === 'main.ny'));
  }
  const library = join(root, 'library.ny'); writeFileSync(library, 'module sample\npub fn answer() -> i32\n    return 42\nend fn\n');
  execFileSync(sdk.compiler!, ['--no-bundle', '--quiet', '--no-stdlib', '--emit-binary-nil', '--emit-library', '--output', join(root, 'library.nil'), library]);
  const parsed = await inspectNyModule(root, 'library.nil'); assert.equal(parsed.version, 2); assert.equal(parsed.library, true); assert.equal(parsed.moduleName, 'sample');
  assert.ok(parsed.embeddedSources.length); assert.ok(parsed.functions.some(fn => fn.name.includes('answer')));
});
