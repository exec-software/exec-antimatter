import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NilAnalysisService, NilAnalysisUnavailableError, nilByteRange, parseNilAnalysis } from '../src/main/environment/nilAnalysis';

function fixture(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-nil-analysis-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
const compiler = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{
 const args=process.argv.slice(2),source=args[2],workspace=JSON.parse(input),primary=workspace.sources.find(x=>x.path===source),text=primary.text;
 const result={schema:'nil.analysis.v1',source,language:/\\.(matrix|mat)$/i.test(source)?'matrix':'ny',success:true,diagnostics:[],reflection:{},sources:workspace.sources.filter(x=>x.path!==source)};
 fs.writeFileSync(path.join(path.dirname(source),'invocation.json'),JSON.stringify({args,workspace}));
 const send=()=>{process.stdout.write(JSON.stringify(result));};
 if(text==='slow'){setTimeout(send,10000);return;}
 if(text==='malformed'){process.stdout.write('garbage');return;}
 if(text.includes('bad')){result.success=false;result.diagnostics=[{code:'MX0001',severity:'error',message:'Bad name',path:source,start:Buffer.byteLength(text.slice(0,text.indexOf('bad'))),length:3,hint:'Use a known name',fix:null}];process.exitCode=1;}
 if(text==='related'){const dep=result.sources[0];result.diagnostics=[{code:'NIL1001',severity:'warning',message:'Unused name',path:dep.path,start:0,length:3,hint:'',fix:null}];}
 if(args.includes('--completion-at')){result.completion={schema:'nil.completion.v1',partial:true,path:source,cursor:Number(args[args.indexOf('--completion-at')+1]),start:0,length:Buffer.byteLength(text),sources:workspace.sources,items:[{name:'hello',kind:'function',type:'() -> i32',insert_text:'hello'}]};}
 if(args.includes('--semantic-index')){const target=workspace.sources.find(x=>x.path!==source)||primary;result.semantic={schema:'nil.semantic.v1',partial:true,sources:workspace.sources,symbols:[{id:1,path:target.path,start:0,length:3,name:'hello',kind:'function',type:'() -> i32'}],references:[{symbol_id:1,path:source,start:0,length:3}]};}
 send();
});
`;
function fake(t: test.TestContext) {
  const root = fixture(t), sdkPath = join(root, 'sdk'); mkdirSync(sdkPath);
  const executable = join(sdkPath, 'nilcompiler'); writeFileSync(executable, compiler); chmodSync(executable, 0o755);
  writeFileSync(join(root, 'main.ny'), 'unchanged'); writeFileSync(join(root, 'main.matrix'), 'unchanged'); writeFileSync(join(root, 'helper.ny'), 'old');
  const service = new NilAnalysisService(root, { sdkPath, environment: {} }, { noStdlib: true, includePaths: [root], disabledRules: ['NIL1002'], warningsAsErrors: false }); t.after(() => service.dispose());
  return { root, service, sdkPath };
}
test('compiler byte positions map exact UTF-8 scalar boundaries into UTF-16 lines', () => {
  const text = '😀 café\r\nβeta';
  assert.deepEqual(nilByteRange(text, 0, 4), { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } });
  assert.deepEqual(nilByteRange(text, Buffer.byteLength('😀 café\r\n'), 2), { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } });
  for (const [start, length] of [[1, 1], [0, 1], [-1, 1], [100, 0], [0, Number.MAX_SAFE_INTEGER]]) assert.equal(nilByteRange(text, start, length), null);
});
test('analysis protocol rejects malformed, wrong-language, inconsistent and out-of-snapshot data', () => {
  const primary = { path: '/work/main.matrix', text: 'hello' };
  const valid = { schema: 'nil.analysis.v1', source: primary.path, language: 'matrix', success: true, diagnostics: [], reflection: {} };
  assert.equal(parseNilAnalysis(JSON.stringify(valid), primary, 0).language, 'matrix');
  for (const value of ['garbage', JSON.stringify({ ...valid, language: 'ny' }), JSON.stringify({ ...valid, source: '/elsewhere/main.matrix' }), JSON.stringify({ ...valid, success: false }), JSON.stringify({ ...valid, sources: [primary] }), JSON.stringify({ ...valid, semantic: { schema: 'nil.semantic.v1', partial: true, sources: [primary], symbols: [{ id: 1, path: primary.path, start: 100, length: 3, name: 'bad', kind: 'variable', type: 'number' }], references: [] } })]) {
    assert.throws(() => parseNilAnalysis(value, primary, 0));
  }
});
test('live compiler lint uses unsaved primary/import overlays with exact spans and preserves disk', { skip: process.platform === 'win32' }, async (t) => {
  const { root, service } = fake(t);
  const diagnostics = await service.diagnostics({ path: 'main.matrix', text: '😀bad' });
  assert.deepEqual(diagnostics, [{ path: 'main.matrix', range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, severity: 1, source: 'nilcompiler', message: 'MX0001: Bad name\nUse a known name' }]);
  const related = await service.diagnostics({ path: 'main.ny', text: 'related', documents: [{ path: 'helper.ny', text: 'new buffer' }] });
  assert.equal(related[0].path, 'helper.ny');
  assert.equal(related[0].severity, 2);
  assert.equal(readFileSync(join(root, 'main.matrix'), 'utf8'), 'unchanged');
  assert.equal(readFileSync(join(root, 'helper.ny'), 'utf8'), 'old');
  const invocation = JSON.parse(readFileSync(join(root, 'invocation.json'), 'utf8'));
  assert.equal(invocation.workspace.schema, 'nil.analysis.workspace.v1');
  assert.equal(invocation.workspace.sources.find((source: { path: string }) => source.path.endsWith('helper.ny')).text, 'new buffer');
  assert.ok(invocation.args.includes('--no-stdlib'));
  assert.ok(invocation.args.includes('--disable-rule'));
});
test('compiler completion and definitions use returned bindings, byte spans and unsaved target snapshots', { skip: process.platform === 'win32' }, async (t) => {
  const { service } = fake(t);
  const completions = await service.completion({ path: 'main.matrix', text: 'hel', line: 0, character: 3 });
  assert.equal(completions[0].label, 'hello');
  assert.deepEqual(completions[0].textEdit, { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'hello' });
  const definitions = await service.definition({ path: 'main.ny', text: 'hel', line: 0, character: 1, documents: [{ path: 'helper.ny', text: 'hello' }] });
  assert.equal(definitions[0].path, 'helper.ny');
  assert.equal(definitions[0].range.start.line, 0);
});
test('analysis refuses path escapes, duplicate overlays, malformed text and oversized work before compiling', { skip: process.platform === 'win32' }, async (t) => {
  const { root, service } = fake(t), outside = fixture(t); writeFileSync(join(outside, 'outside.ny'), 'hello'); symlinkSync(join(outside, 'outside.ny'), join(root, 'linked.ny'));
  for (const document of [
    { path: '../outside.ny', text: 'ok' }, { path: 'linked.ny', text: 'ok' }, { path: 'main.ny', text: '\uD800' }, { path: 'main.ny', text: 'x'.repeat(1024 * 1024 + 1) },
    { path: 'main.ny', text: 'hello', documents: [{ path: 'helper.ny', text: 'a' }, { path: 'helper.ny', text: 'b' }] },
    { path: 'main.ny', text: 'hello', documents: [{ path: join(outside, 'outside.ny'), text: 'a' }] },
  ]) await assert.rejects(service.diagnostics(document));
  await assert.rejects(service.completion({ path: 'main.ny', text: '😀', character: 1 }), /Unicode/);
  await assert.rejects(service.diagnostics({ path: 'main.ny', text: 'malformed' }), /JSON/);
});
test('superseding analysis cancels its compiler and serially serves the latest buffer; disposal retires work', { skip: process.platform === 'win32' }, async (t) => {
  const { service } = fake(t);
  const first = service.diagnostics({ path: 'main.ny', text: 'slow' });
  const firstResult = assert.rejects(first, /cancelled/);
  const next = service.diagnostics({ path: 'main.ny', text: 'good' });
  await firstResult; assert.deepEqual(await next, []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.diagnostics({ path: 'main.ny', text: 'good' }, controller.signal), /cancelled/);
  const pending = service.diagnostics({ path: 'main.ny', text: 'slow' }); const cancelled = assert.rejects(pending, /cancelled/); service.dispose(); await cancelled;
});
test('legacy Ny SDK explicitly reports compiler analysis unavailable for safe LSP fallback', { skip: process.platform === 'win32' }, async (t) => {
  const root = fixture(t), sdkPath = join(root, 'sdk'); mkdirSync(sdkPath); writeFileSync(join(root, 'main.ny'), '');
  writeFileSync(join(sdkPath, 'nycompiler'), compiler); chmodSync(join(sdkPath, 'nycompiler'), 0o755);
  const service = new NilAnalysisService(root, { sdkPath }); t.after(() => service.dispose());
  await assert.rejects(service.diagnostics({ path: 'main.ny', text: '' }), NilAnalysisUnavailableError);
});

const sdkPath = process.env.ANTIMATTER_NY_TEST_SDK;
test('actual NIL SDK analyzes Ny and Matrix dirty imports and resolves compiler bindings without saving', { skip: !sdkPath }, async (t) => {
  const root = fixture(t), helper = 'module helper\npub fn answer() -> i32\n    return 42\nend fn\n';
  const ny = 'module app\nimport helper\nfn main() -> i32\n    return answer()\nend fn\n';
  const matrix = 'book app\nread helper\nmain returns number begin paragraph\n    give answer with nothing\nend paragraph\n';
  writeFileSync(join(root, 'helper.ny'), 'module helper\n');
  writeFileSync(join(root, 'main.ny'), ny); writeFileSync(join(root, 'main.matrix'), matrix);
  const service = new NilAnalysisService(root, { sdkPath }, { noStdlib: true }); t.after(() => service.dispose());
  for (const [path, text, character] of [['main.ny', ny, 12], ['main.matrix', matrix, 10]] as const) {
    const documents = [{ path: 'helper.ny', text: helper }];
    const diagnostics = await service.diagnostics({ path, text, documents });
    assert.ok(!diagnostics.some((item) => item.severity === 1), JSON.stringify(diagnostics));
    const locations = await service.definition({ path, text, documents, line: 3, character });
    assert.ok(locations.some((item) => item.path === 'helper.ny' && item.range.start.line === 1), JSON.stringify(locations));
    const invalid = text.replace('answer', 'missing_name');
    const errors = await service.diagnostics({ path, text: invalid, documents });
    assert.ok(errors.some((item) => item.severity === 1), JSON.stringify(errors));
  }
  assert.equal(readFileSync(join(root, 'helper.ny'), 'utf8'), 'module helper\n');
});
