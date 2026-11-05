import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { filterNyOutline, nyOutlineItems } from '../renderer/src/environment/nyOutlineModel';
import { NyLanguageServer } from '../src/main/environment/nyLanguageServer';
import { resolveNyToolchain } from '../src/main/environment/ny';

const range = (line: number, from: number, to: number) => ({ start: { line, character: from }, end: { line, character: to } });
const symbol = (name: string, line: number, from: number, to: number, kind = 12) => ({ name, kind, range: range(line, from, to), selectionRange: range(line, from, to) });

test('outline validates UTF-16 navigation and preserves hierarchy when filtering members', () => {
  const text = 'struct Record\n    first: i32\n    second: i32\nend struct\n// 😀 fn tail\n';
  const record = { ...symbol('Record', 0, 7, 13, 23), range: { start: { line: 0, character: 0 }, end: { line: 3, character: 10 } },
    children: [symbol('first', 1, 4, 9, 8), symbol('second', 2, 4, 10, 8)] };
  const tail = symbol('tail', 4, 9, 13);
  const items = nyOutlineItems([record, tail], text);
  assert.deepEqual(items.map(({ name, line, column }) => [name, line, column]), [['Record', 1, 8], ['first', 2, 5], ['second', 3, 5], ['tail', 5, 10]]);
  assert.equal(items[1].parentId, items[0].id);
  assert.equal(items[1].container, 'Record');
  assert.deepEqual(filterNyOutline(items, 'SECOND').map((item) => item.name), ['Record', 'second']);
  assert.deepEqual(filterNyOutline(items, 'record').map((item) => item.name), ['Record', 'first', 'second']);
  assert.deepEqual(filterNyOutline(items, 'missing'), []);
});

test('outline rejects invalid or out-of-buffer positions instead of creating wrong navigation targets', () => {
  const valid = symbol('<script> safe text', 0, 3, 7);
  const values = [null, [], {}, valid, { ...valid, selectionRange: range(8, 0, 1) },
    { ...valid, selectionRange: range(0, -1, 1) }, { ...valid, selectionRange: range(0, 4, 99) },
    { ...valid, selectionRange: range(0, 6, 4) }, { ...valid, selectionRange: range(0, 0, 2) }];
  const result = nyOutlineItems(values, 'fn main()');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, '<script> safe text');
  assert.equal(result[0].line, 1);
  assert.equal(result[0].column, 4);
});

test('outline bounds large or recursive hierarchies', () => {
  const item: any = symbol('name', 0, 0, 4);
  item.children = [item];
  assert.ok(nyOutlineItems([item], 'name').length <= 33);
  assert.equal(nyOutlineItems(Array.from({ length: 3000 }, () => symbol('name', 0, 0, 4)), 'name').length, 2000);
});

const installed = resolveNyToolchain(process.cwd(), { sdkPath: process.env.ANTIMATTER_NY_TEST_SDK });
test('installed Ny SDK: outline reads nested declarations and updates unsaved buffers without modifying disk', { skip: !installed.lsp }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'antimatter-ny-outline-'));
  const disk = 'fn original()\nend fn\n';
  const source = 'module app\nstruct Record { value: i32 }\nfn main(argument: Record)\n let local = 1\nend fn\n';
  await writeFile(join(root, 'main.ny'), disk);
  const service = new NyLanguageServer(root, { sdkPath: installed.sdkPath! });
  try {
    const result = nyOutlineItems(await service.query('documentSymbol', { path: 'main.ny', text: source }), source);
    assert.deepEqual(result.map((item) => item.name), ['app', 'Record', 'value', 'main', 'argument', 'local']);
    assert.equal(result.find((item) => item.name === 'local')?.container, 'app › main');
    assert.equal(result.find((item) => item.name === 'main')?.line, 3);
    const changed = 'fn renamed()\nend fn\n';
    const fresh = nyOutlineItems(await service.query('documentSymbol', { path: 'main.ny', text: changed }), changed);
    assert.deepEqual(fresh.map((item) => item.name), ['renamed']);
    assert.equal(await readFile(join(root, 'main.ny'), 'utf8'), disk);
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
