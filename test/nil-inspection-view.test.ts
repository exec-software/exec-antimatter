import assert from 'node:assert/strict';
import test from 'node:test';
import type { NyInspectedFunction, NyModuleInspection } from '../src/api/nyInspector';
import { nilByteSize, nilMatchingFunctions, nilMatchingInstructions, nilSourceFiles, nilValuePreview } from '../renderer/src/environment/nilInspectionView';

const fn: NyInspectedFunction = {
  name: 'demo.main', parameters: ['count:i32'], generics: [], returnType: 'i32', inline: false, test: false, annotations: ['@doc("Main")'], declarationLine: 1,
  instructions: [
    { offset: 0, opcode: 'PUSH', operands: ['42'], debugLine: 3, source: { path: '/original/src/main.ny', workspacePath: 'src/main.ny', line: 3 } },
    { offset: 1, opcode: 'LOAD_LOCAL', operands: ['%slot0'], debugLine: 4, source: { path: '/original/src/main.ny', workspacePath: 'src/main.ny', line: 4 }, locals: [{ name: 'answer', storage: '%slot0', type: 'i32', depth: 1 }] },
    { offset: 2, opcode: 'RET', operands: [], debugLine: 5 },
  ],
};
const module: NyModuleInspection = {
  path: '.ny-build/main.nil', modified: 1, format: 'binary', version: 5, flags: 0, byteLength: 256, moduleName: 'demo', library: false, debugInfo: true,
  functions: [fn, { ...fn, name: 'helper', instructions: [{ offset: 0, opcode: 'RET', operands: [], debugLine: 1, source: { path: '/external/helper.ny', line: 1 } }] }],
  constants: [], types: [], tests: [], embeddedSources: [], dependencies: [], warnings: [],
};

test('NIL search matches functions, opcode/operand/source text and lexical locals without renumbering instructions', () => {
  assert.deepEqual(nilMatchingFunctions(module, 'slot0').map((fn) => fn.name), ['demo.main']);
  assert.deepEqual(nilMatchingInstructions(fn, ' ANSWER ').map((instruction) => instruction.offset), [1]);
  assert.deepEqual(nilMatchingInstructions(fn, 'load_local').map((instruction) => instruction.offset), [1]);
  assert.equal(nilMatchingInstructions(fn, 'main.ny').length, 2);
  assert.equal(nilMatchingInstructions(fn, 'demo.main').length, 3);
  assert.equal(nilMatchingFunctions(module, 'absent').length, 0);
});

test('NIL source grouping preserves validated workspace links and keeps external metadata non-navigable', () => {
  const sources = nilSourceFiles(module);
  assert.equal(sources.length, 2);
  assert.deepEqual(sources[0], { path: '/original/src/main.ny', workspacePath: 'src/main.ny', line: 3, instructionCount: 2 });
  assert.equal(sources[1].workspacePath, undefined);
  assert.equal(sources[1].path, '/external/helper.ny');
});

test('Large NIL constants preview a bounded window around a searched value', () => {
  const value = 'before'.repeat(2000) + 'UNIQUE VALUE' + 'after'.repeat(2000);
  const preview = nilValuePreview(value, 'unique value');
  assert.ok(preview.includes('UNIQUE VALUE'));
  assert.ok(preview.length <= 514);
  assert.ok(preview.startsWith('…') && preview.endsWith('…'));
  assert.equal(nilValuePreview('<script>literal</script>', ''), '<script>literal</script>');
  assert.equal(nilByteSize(512), '512 B');
  assert.equal(nilByteSize(2048), '2.0 KiB');
});
