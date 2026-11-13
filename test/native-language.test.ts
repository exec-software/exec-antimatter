import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import test from 'node:test';
import { NativeLanguageServices, nativeCompletionItems } from '../src/main/environment/nativeLanguageServer';
import type { NativeTools } from '../src/api/nativeProject';

const SERVER = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
let input=Buffer.alloc(0); const documents=new Map();
const log=value=>fs.appendFileSync(process.env.LSP_TEST_LOG,JSON.stringify(value)+'\n');
const send=value=>{const body=Buffer.from(JSON.stringify(value));const packet=Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'),body]);process.stdout.write(packet.subarray(0,19));process.stdout.write(packet.subarray(19));};
const result=(id,value)=>send({jsonrpc:'2.0',id,result:value});
function message(m){
 log(m);
 if(m.method==='initialize'){
  send({jsonrpc:'2.0',id:700,method:'workspace/configuration',params:{items:[{section:'rust-analyzer.cargo'}]}});
  result(m.id,{capabilities:{positionEncoding:'utf-16'}});
 } else if(m.method==='textDocument/didOpen'||m.method==='textDocument/didChange'){
  const d=m.params.textDocument;const text=d.text??m.params.contentChanges[0].text;documents.set(d.uri,{text,version:d.version});
  if(!process.env.LSP_TEST_QUIET)setTimeout(()=>send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:d.uri,version:d.version,diagnostics:[{range:{start:{line:0,character:0},end:{line:0,character:1}},message:'diagnostic '+text,severity:2}]}}),d.version===1?50:10);
 } else if(m.method==='textDocument/completion'){
  send({jsonrpc:'2.0',id:701,method:'workspace/applyEdit',params:{edit:{changes:{'file:///outside':[]}}}});
  result(m.id,{items:[{label:'café',kind:3,insertText:'café()',textEdit:{replace:{start:{line:0,character:0},end:{line:0,character:1}},insert:{start:{line:0,character:0},end:{line:0,character:0}},newText:'café()'}},{label:42}]});
 } else if(m.method==='textDocument/hover')result(m.id,{contents:{kind:'markdown',value:'**safe** <script>never execute</script>'}});
 else if(m.method==='textDocument/definition')result(m.id,[{targetUri:m.params.textDocument.uri,targetSelectionRange:{start:{line:0,character:0},end:{line:0,character:1}}},{uri:'file:///outside.rs',range:{start:{line:0,character:0},end:{line:0,character:1}}}]);
}
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(true){const i=input.indexOf('\r\n\r\n');if(i<0)return;const n=Number(input.subarray(0,i).toString().split(':')[1]);if(input.length<i+4+n)return;const m=JSON.parse(input.subarray(i+4,i+4+n));input=input.subarray(i+4+n);message(m);}});
`;

function fixture(t: { after(fn: () => void): void }, quiet = false) {
  const directory = mkdtempSync(join(tmpdir(), 'native-lsp-'));
  const root = join(directory, 'project');
  mkdirSync(root);
  const server = join(directory, 'server.cjs');
  const log = join(directory, 'messages.jsonl');
  writeFileSync(server, SERVER, { mode: 0o700 });
  const tools: NativeTools = { cargo: null, rustc: null, cmake: null, ctest: null, cpp: null, debugger: null, rustAnalyzer: server, clangd: server };
  const services = new NativeLanguageServices(root, join(directory, 'cache'), { tools, requestTimeoutMs: 1500, diagnosticTimeoutMs: 200,
    environment: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`, LSP_TEST_LOG: log, ...(quiet ? { LSP_TEST_QUIET: '1' } : {}) } });
  t.after(() => { services.dispose(); rmSync(directory, { recursive: true, force: true }); });
  return { root, directory, services, messages: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) };
}

test('native LSP initializes UTF-16, synchronizes overlays, handles fragmented UTF-8 and refuses server writes', async (t) => {
  const { services, messages } = fixture(t);
  const document = { path: 'main.rs', text: 'c', line: 0, character: 1, documents: [{ path: 'lib.rs', text: 'fn helper() {}' }] };
  const items = await services.completion(document);
  assert.equal(items.length, 1); assert.equal(items[0].label, 'café'); assert.equal(items[0].textEdit?.newText, 'café()');
  const hover = await services.hover(document); assert.match(JSON.stringify(hover), /never execute/);
  const locations = await services.definition(document); assert.equal(locations.length, 1); assert.equal(locations[0].path, 'main.rs');
  const log = messages();
  assert.deepEqual(log.find((message) => message.method === 'initialize').params.capabilities.general.positionEncodings, ['utf-16']);
  assert.equal(log.find((message) => message.id === 701 && !message.method).result.applied, false);
  assert.equal(log.find((message) => message.id === 700 && !message.method).result[0].buildScripts.enable, false);
  assert.ok(log.some((message) => message.method === 'textDocument/didOpen' && message.params.textDocument.uri.endsWith('/lib.rs')));
});

test('diagnostics wait for the correct document version and recover after restarting tools', async (t) => {
  const { services } = fixture(t);
  await services.completion({ path: 'main.cpp', text: 'old', line: 0, character: 1 });
  const diagnostics = await services.diagnostics({ path: 'main.cpp', text: 'new', line: 0, character: 1 });
  assert.equal(diagnostics[0].message, 'diagnostic new');
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal((await services.diagnostics({ path: 'main.cpp', text: 'new' }))[0].message, 'diagnostic new');
  await services.restart(); assert.equal((await services.completion({ path: 'main.rs', text: 'x' }))[0].label, 'café');
  services.dispose(); await assert.rejects(services.completion({ path: 'main.rs', text: 'x' }), /closed/);
});

test('path escapes, symlinks, invalid UTF-16 positions and oversize overlays fail before spawning', async (t) => {
  const { services, root, directory } = fixture(t);
  mkdirSync(join(directory, 'outside')); symlinkSync(join(directory, 'outside'), join(root, 'linked'));
  for (const document of [{ path: '../outside/main.rs', text: 'x' }, { path: 'linked/main.rs', text: 'x' }, { path: 'main.rs', text: 'x', character: 2 }, { path: 'main.rs', text: 'x', line: -1 }, { path: 'file.js', text: 'x' }, { path: 'main.rs', text: 'x'.repeat(1024 * 1024 + 1) }, { path: 'main.rs', text: 'x', documents: [{ path: '../outside/a.rs', text: 'x' }] }]) {
    await assert.rejects(services.completion(document));
  }
});

test('diagnostics time out instead of inventing an empty successful analysis', async (t) => {
  const { services } = fixture(t, true);
  await assert.rejects(services.diagnostics({ path: 'main.rs', text: 'x' }), /still running/);
});

test('completion normalization accepts bounded edits but discards commands and malformed results', () => {
  const [item] = nativeCompletionItems([{ label: 'safe', command: { command: 'execute' }, textEdit: { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, newText: 'safe()' }, additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'use safe;\n' }] }]);
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'command'), false);
  assert.equal(item.additionalTextEdits?.length, 1);
  assert.deepEqual(nativeCompletionItems([{ label: null }, null, { label: 'x'.repeat(513) }]), []);
});
