import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { NY_MAX_DOCUMENT_BYTES, NyLanguageServer } from '../src/main/environment/nyLanguageServer';
import { resolveNyToolchain } from '../src/main/environment/ny';

function fixture(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-ny-lsp-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
const fakeLsp = `#!${process.execPath}
let buffer = Buffer.alloc(0), documents = new Map(), languages = new Map();
const send = value => { const data = Buffer.from(JSON.stringify(value)); process.stdout.write('Content-Length: ' + data.length + '\\r\\n\\r\\n'); process.stdout.write(data.subarray(0, 3)); process.stdout.write(data.subarray(3)); };
process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); while (true) {
  const end = buffer.indexOf('\\r\\n\\r\\n'); if (end < 0) return;
  const size = Number(buffer.subarray(0,end).toString().split(':')[1]); if (buffer.length < end + 4 + size) return;
  const message = JSON.parse(buffer.subarray(end+4,end+4+size)); buffer = buffer.subarray(end+4+size);
  const doc = message.params?.textDocument;
  if (message.method === 'textDocument/didOpen') { documents.set(doc.uri, doc.text); languages.set(doc.uri, doc.languageId); }
  if (message.method === 'textDocument/didChange') documents.set(doc.uri, message.params.contentChanges[0].text);
  if (message.method === 'textDocument/didClose') documents.delete(doc.uri);
  if (message.id) {
    const text = documents.get(doc?.uri);
    if (documents.size > 64) { send({jsonrpc:'2.0',id:message.id,error:{message:'Document limit exceeded without didClose'}}); continue; }
    if (text === 'language-id') { send({jsonrpc:'2.0',id:message.id,result:languages.get(doc.uri)}); continue; }
    if (text === 'crash') process.exit(9);
    if (text === 'malformed') { process.stdout.write('Content-Length: -1\\r\\n\\r\\n'); continue; }
    if (text === 'huge') { process.stdout.write('Content-Length: 999999999\\r\\n\\r\\n'); continue; }
    send({jsonrpc:'2.0',id:message.id,result:message.method === 'initialize' ? {capabilities:{}} : {items:[{label:text}]}});
  }
}});
`;
function fake(t: test.TestContext): { root: string; service: NyLanguageServer } {
  const root = fixture(t), directory = join(root, 'sdk'); mkdirSync(directory);
  const path = join(directory, 'nylsp'); writeFileSync(path, fakeLsp); chmodSync(path, 0o755);
  const service = new NyLanguageServer(root, { sdkPath: directory }); t.after(() => service.dispose());
  return { root, service };
}

test('Ny LSP full-document updates are serialized with queries and never return another buffer version', { skip: process.platform === 'win32' }, async (t) => {
  const { service } = fake(t);
  const results = await Promise.all(['first', 'second', 'third'].map((text) => service.query('completion', { path: 'a.ny', text, line: 0, character: 0 })));
  assert.deepEqual(results, ['first', 'second', 'third'].map((label) => ({ items: [{ label }] })));
  await service.close('a.ny');
  assert.deepEqual(await service.query('completion', { path: 'a.ny', text: 'reopened' }), { items: [{ label: 'reopened' }] });
});

test('Ny LSP rejects invalid paths, oversized buffers, and invalid coordinates before spawning', async (t) => {
  const { service } = fake(t);
  for (const document of [{ path: '../outside.ny', text: '' }, { path: 'a.js', text: '' },
    { path: 'a.ny', text: 'x'.repeat(NY_MAX_DOCUMENT_BYTES + 1) }, { path: 'a.ny', text: '', line: -1 }, { path: 'a.ny', text: '', character: 1.5 }]) {
    await assert.rejects(service.query('completion', document));
  }
  assert.deepEqual(await service.diagnostics({ path: 'main.ny', text: 'incomplete code' }), []);
  service.dispose(); await assert.rejects(service.query('completion', { path: 'a.ny', text: '' }), /closed/);
});

test('Ny LSP closes oldest documents at its bound and reopens evicted files with their current text', { skip: process.platform === 'win32' }, async (t) => {
  const { service } = fake(t);
  // The fake server also enforces the bound, so dropping only the local cache is insufficient.
  for (let index = 0; index < 70; index++) {
    assert.deepEqual(await service.query('completion', { path: `file-${index}.ny`, text: `original-${index}` }), { items: [{ label: `original-${index}` }] });
  }
  assert.deepEqual(await service.query('completion', { path: 'file-0.ny', text: 'edited while evicted' }), { items: [{ label: 'edited while evicted' }] });
  assert.deepEqual(await service.query('completion', { path: 'file-69.ny', text: 'latest retained edit' }), { items: [{ label: 'latest retained edit' }] });
});

for (const [text, expected] of [['crash', /exited/], ['malformed', /invalid framing/], ['huge', /invalid packet size/]] as const) {
  test(`Ny LSP fails pending requests cleanly on ${text}`, { skip: process.platform === 'win32' }, async (t) => {
    const { service } = fake(t);
    await assert.rejects(service.query('completion', { path: 'a.ny', text }), expected);
    await assert.rejects(service.query('hover', { path: 'a.ny', text: 'replacement' }), expected);
  });
}

test('Ny LSP bounds queued requests and disposal rejects work without orphan rejections', { skip: process.platform === 'win32' }, async (t) => {
  const { service } = fake(t);
  const queries = Array.from({ length: 64 }, () => service.query('completion', { path: 'a.ny', text: 'x' }));
  await assert.rejects(service.query('completion', { path: 'a.ny', text: 'overflow' }), /busy/);
  service.dispose();
  const results = await Promise.allSettled(queries); assert.ok(results.every((result) => result.status === 'rejected'));
});

const installed = resolveNyToolchain(process.cwd(), { sdkPath: process.env.ANTIMATTER_NY_TEST_SDK });
test('installed Ny v1 LSP supplies real member completion, hover, definition, and updated local symbols through Antimatter', { skip: !installed.lsp }, async (t) => {
  const root = fixture(t), service = new NyLanguageServer(root, { sdkPath: installed.sdkPath! }); t.after(() => service.dispose());
  const text = 'struct Point\n    x: i32\n    y: i32\nend struct\nfn main() -> i32\n    let point: Point\n    point.\n    return 0\nend fn\n';
  const completed = await service.query('completion', { path: 'main.ny', text, line: 6, character: 10 }) as { items: { label: string }[] };
  assert.deepEqual(completed.items.map((item) => item.label).sort(), ['x', 'y']);
  const corrected = text.replace('point.\n', 'point.x\n');
  const location = await service.query('definition', { path: 'main.ny', text: corrected, line: 6, character: 10 }) as { uri: string; range: { start: { line: number } } } | Array<{ uri: string; range: { start: { line: number } } }>;
  const first = Array.isArray(location) ? location[0] : location; assert.equal(first.range.start.line, 1);
  const hover = await service.query('hover', { path: 'main.ny', text: corrected, line: 6, character: 10 }); assert.ok(hover);
  const symbols = await service.query('documentSymbol', { path: 'main.ny', text: 'fn replacement()\nend fn\n' }) as { name: string }[];
  assert.deepEqual(symbols.map((symbol) => symbol.name), ['replacement']);
  assert.deepEqual(await service.diagnostics({ path: 'main.ny', text: 'fn incomplete()\n' }), []);
  const structural = await service.diagnostics({ path: 'main.ny', text: 'fn incomplete()\n' }, { structural: true });
  assert.ok(structural.some((item) => item.message.includes('Unclosed')));
  assert.ok(resolve(root));
});

test('NIL LSP opens Ny and both Matrix extensions with the actual language ID', { skip: process.platform === 'win32' }, async (t) => {
  const { service } = fake(t);
  for (const [path, language] of [['main.ny', 'ny'], ['main.matrix', 'matrix'], ['MAIN.MAT', 'matrix']]) {
    assert.equal(await service.query('completion', { path, text: 'language-id' }), language);
  }
});

test('installed NIL LSP supplies Matrix hyphenated completion, hover, definition and paragraph outline', { skip: !installed.lsp || installed.family !== 'nil' }, async (t) => {
  const root = fixture(t), service = new NyLanguageServer(root, { sdkPath: installed.sdkPath! }); t.after(() => service.dispose());
  const text = 'main begin paragraph\n value local-count as number is 4\n say local-\nend paragraph\n';
  const result = await service.query('completion', { path: 'main.mat', text, line: 2, character: 11 }) as { items: Array<{ label: string }> };
  assert.deepEqual(result.items.map((item) => item.label), ['local-count']);
  const complete = text.replace('say local-', 'say local-count');
  const locations = await service.query('definition', { path: 'main.mat', text: complete, line: 2, character: 10 }) as Array<{ range: { start: { line: number } } }>;
  assert.equal(locations[0].range.start.line, 1);
  const hover = await service.query('hover', { path: 'main.mat', text: complete, line: 2, character: 10 }) as { contents: { value: string } };
  assert.match(hover.contents.value, /matrix/);
  const symbols = await service.query('documentSymbol', { path: 'main.mat', text: complete }) as Array<{ name: string; children: Array<{ name: string }> }>;
  assert.equal(symbols[0].name, 'main');
  assert.ok(symbols[0].children.some((item) => item.name === 'local-count'));
});
