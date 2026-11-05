import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverPensievePaths, parsePensieveSettings, PensieveExperimental, runPensieveBridge,
  type PensieveBridgeInput, type PensieveExperimentalOptions } from '../src/main/pensieveExperimental';

const corpus = { id: 'corpus-123', entryCount: 2, languages: ['matrix', 'ny'], sdkVersion: 'sdk-123' };
const status = { corpus, events: 2, experiences: 1, repairs: 0 };
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-pensieve-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'runtime'); const directory = join(root, 'private'); const project = join(root, 'project');
  mkdirSync(join(runtimeRoot, 'pensieve'), { recursive: true }); mkdirSync(project);
  writeFileSync(join(runtimeRoot, 'pensieve', 'bridge.py'), '# fixture');
  const curriculumPath = join(runtimeRoot, 'curriculum.json');
  writeFileSync(curriculumPath, JSON.stringify({ schema_version: 1, id: corpus.id, sdk: { source_revision: corpus.sdkVersion },
    entries: [{ language: 'matrix' }, { language: 'ny' }] }));
  const calls: PensieveBridgeInput[] = [];
  const options: PensieveExperimentalOptions = { directory, runtimeRoot, curriculumPath,
    bridge: async (input) => { calls.push(input); return input.request.op === 'status' ? status : { event_id: 3, indexed: true }; } };
  return { root, project, calls, options, instance: new PensieveExperimental(options) };
}

test('Pensieve is off by default, and status or disabled invocations never start its bridge', async (t) => {
  const f = fixture(t);
  assert.equal(f.instance.enabled, false); assert.equal(f.instance.state().status, 'disabled');
  assert.equal(f.instance.state().available, true); assert.deepEqual(f.instance.state().corpus, corpus);
  await assert.rejects(f.instance.invoke(f.project, { op: 'status' }), /disabled/);
  assert.equal(f.calls.length, 0); assert.equal(existsSync(f.options.directory), false);
});

test('malformed and unsupported settings fail closed', (t) => {
  for (const input of [null, {}, true, 'enabled', { enabled: true }, { version: 2, enabled: true }, { version: 1, enabled: 'true' }]) {
    assert.deepEqual(parsePensieveSettings(input), { version: 1, enabled: false });
  }
  const f = fixture(t); mkdirSync(f.options.directory); writeFileSync(join(f.options.directory, 'settings.json'), '{broken');
  assert.equal(new PensieveExperimental(f.options).enabled, false);
  assert.deepEqual(parsePensieveSettings({ version: 1, enabled: true, unexpected: 'discard' }), { version: 1, enabled: true });
});

test('enable validates the pinned corpus before persisting, and disable preserves memories', async (t) => {
  const f = fixture(t); await f.instance.enable();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].request, { op: 'status' });
  assert.equal(f.instance.enabled, true); assert.equal(f.instance.state().status, 'ready');
  await f.instance.invoke(f.project, { op: 'status' });
  const store = f.calls[1].store;
  writeFileSync(store, 'durable memory');
  assert.deepEqual(f.instance.state().statistics, { events: 2, experiences: 1, repairs: 0 });
  await f.instance.disable();
  assert.equal(readFileSync(store, 'utf8'), 'durable memory');
  assert.equal(new PensieveExperimental(f.options).enabled, false);
  if (process.platform !== 'win32') {
    assert.equal(statSync(f.options.directory).mode & 0o777, 0o700);
    assert.equal(statSync(store).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.options.directory, 'settings.json')).mode & 0o777, 0o600);
  }
});

test('persisted opt-in survives restart without spawning during initialization', async (t) => {
  const f = fixture(t); await f.instance.enable(); f.calls.length = 0;
  const reopened = new PensieveExperimental(f.options);
  assert.equal(reopened.enabled, true); assert.equal(reopened.state().status, 'enabled'); assert.equal(f.calls.length, 0);
  await reopened.invoke(f.project, { op: 'status' }); assert.equal(f.calls.length, 1);
});

test('missing runtime and mismatched bridge curriculum cannot silently enable memory', async (t) => {
  const f = fixture(t);
  f.options.bridge = async () => ({ ...status, corpus: { ...corpus, id: 'wrong' } });
  const invalid = new PensieveExperimental(f.options);
  await assert.rejects(invalid.enable(), /pinned curriculum/);
  assert.equal(invalid.enabled, false); assert.equal(invalid.state().status, 'error');
  assert.match(invalid.state().error!, /pinned curriculum/);
  assert.equal(new PensieveExperimental(f.options).enabled, false);
  rmSync(join(f.options.runtimeRoot, 'pensieve', 'bridge.py'));
  const missing = new PensieveExperimental(f.options);
  assert.equal(missing.state().available, false); await assert.rejects(missing.enable(), /unavailable/);
});

test('an opt-in that outlived its bundle stands the experiment down instead of failing turns', async (t) => {
  // vendor/pensieve/ is gitignored apart from its manifest, because the corpus is not
  // distributable. So a checkout routinely carries the setting still switched on from an earlier
  // run with no bridge.py to honour it, and `enabled` alone was enough to attach the runtime to
  // every turn: each one then died with "Pensieve bundle unavailable: ENOENT ...", on every model,
  // since the bundle has nothing to do with which model answers. Callers must gate on both.
  const f = fixture(t);
  await f.instance.enable();
  assert.equal(f.instance.enabled, true);

  rmSync(join(f.options.runtimeRoot, 'pensieve', 'bridge.py'));
  const restarted = new PensieveExperimental(f.options);
  assert.equal(restarted.enabled, true, 'the persisted opt-in is still the user\u2019s preference');
  assert.equal(restarted.available, false, 'but there is nothing to run, so no turn may depend on it');
  assert.equal(restarted.state().status, 'error');
  assert.match(restarted.state().unavailableReason!, /bundle unavailable/);

  // And the reason is reported rather than thrown at whatever happened to be running.
  assert.equal(f.instance.available, true);
});

test('canonical project paths share memory across aliases and isolate separate projects', async (t) => {
  const f = fixture(t); const alias = join(f.root, 'alias'); const second = join(f.root, 'second');
  symlinkSync(f.project, alias, 'dir'); mkdirSync(second); await f.instance.enable();
  await f.instance.invoke(f.project, { op: 'status' }); await f.instance.invoke(alias, { op: 'status' });
  await f.instance.invoke(second, { op: 'status' });
  assert.equal(f.calls[1].store, f.calls[2].store); assert.notEqual(f.calls[1].store, f.calls[3].store);
  assert.match(f.calls[1].store, /projects[/\\][a-f0-9]{64}[/\\]memory\.pensieve$/);
  await assert.rejects(f.instance.invoke(f.root, { op: 'status' }), /outside the project/);
});

test('disabling interrupts an active operation and prevents queued calls from running', async (t) => {
  const f = fixture(t); let started!: () => void; const reached = new Promise<void>((resolve) => { started = resolve; });
  const bridge = f.options.bridge!;
  f.options.bridge = async (input) => {
    if (input.request.op === 'status') return bridge(input);
    f.calls.push(input); started();
    await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () =>
      reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
    return {};
  };
  const instance = new PensieveExperimental(f.options); await instance.enable();
  const active = instance.invoke(f.project, { op: 'capture', session: 's', id: 'a', actor: 'user', kind: 'message', content: 'a' });
  const queued = instance.invoke(f.project, { op: 'status' });
  const first = assert.rejects(active, { name: 'AbortError' }); const second = assert.rejects(queued, { name: 'AbortError' });
  await reached; await instance.disable(); await first; await second;
  assert.equal(instance.state().status, 'disabled'); assert.equal(instance.state().error, null); assert.equal(f.calls.length, 2);
});

test('packaged runtime discovery precedes repo vendor; only explicit environment overrides paths', (t) => {
  const f = fixture(t); const appPath = join(f.root, 'app'); const resourcesPath = join(f.root, 'resources');
  for (const root of [appPath, resourcesPath]) {
    mkdirSync(join(root, 'vendor', 'pensieve', 'pensieve'), { recursive: true });
    writeFileSync(join(root, 'vendor', 'pensieve', 'pensieve', 'bridge.py'), '# fixture');
  }
  assert.equal(discoverPensievePaths({ appPath, resourcesPath, environment: {} }).runtimeRoot, join(resourcesPath, 'vendor', 'pensieve'));
  assert.deepEqual(discoverPensievePaths({ appPath, resourcesPath, environment: {
    ANTIMATTER_PENSIEVE_RUNTIME: f.options.runtimeRoot, ANTIMATTER_PENSIEVE_CURRICULUM: f.options.curriculumPath,
    ANTIMATTER_PENSIEVE_PYTHON: '/explicit/interpreter',
  } }), { runtimeRoot: f.options.runtimeRoot, curriculumPath: f.options.curriculumPath, python: '/explicit/interpreter' });
});

function processFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t); const python = join(f.root, 'bridge-fixture');
  writeFileSync(python, `#!${process.execPath}\nlet input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{ const request=JSON.parse(input); switch(request.content) { case 'hang': setInterval(()=>{},1000); break; case 'overflow': process.stdout.write('x'.repeat(5000)); break; case 'malformed': process.stdout.write('unstructured log\\n{}'); break; case 'failure': process.stdout.write(JSON.stringify({ok:false,error:'fixture refused'})); break; case 'exit': process.stderr.write('fixture crashed'); process.exitCode=3; break; default: process.stdout.write(JSON.stringify({ok:true,result:{request,args:process.argv.slice(2),cwd:process.cwd(),pythonPath:process.env.PYTHONPATH,userSite:process.env.PYTHONNOUSERSITE}})); } });\n`);
  chmodSync(python, 0o700);
  const input: PensieveBridgeInput = { runtimeRoot: f.options.runtimeRoot, curriculumPath: f.options.curriculumPath,
    store: join(f.root, 'store.pensieve'), request: { op: 'status' }, python, timeoutMs: 2000 };
  return { ...f, input };
}

test('bridge subprocess uses the pinned module path and JSON stdin with no shell interpolation', async (t) => {
  const f = processFixture(t); const request = { op: 'capture' as const, session: 's', id: 'a', actor: 'user', kind: 'message', content: '`touch /never`; $(false)\n世界' };
  const result = await runPensieveBridge({ ...f.input, request }) as any;
  assert.deepEqual(result.request, request); assert.equal(result.cwd, f.options.runtimeRoot);
  assert.equal(result.pythonPath, f.options.runtimeRoot); assert.equal(result.userSite, '1');
  assert.deepEqual(result.args, ['-s', '-m', 'pensieve.bridge', '--store', f.input.store, '--curriculum', f.options.curriculumPath]);
});

test('bridge errors, malformed protocol, failed processes and oversized output are explicit', async (t) => {
  const f = processFixture(t);
  for (const [content, expected] of [['failure', /fixture refused/], ['malformed', /invalid JSON/], ['exit', /code 3.*fixture crashed/], ['overflow', /output exceeded/]] as const) {
    await assert.rejects(runPensieveBridge({ ...f.input, maxOutputBytes: 1024,
      request: { op: 'capture', session: 's', id: content, actor: 'user', kind: 'message', content } }), expected);
  }
  await assert.rejects(runPensieveBridge({ ...f.input, python: join(f.root, 'missing-python') }), /Could not start/);
});

test('bridge timeout and cancellation terminate outstanding work', async (t) => {
  const f = processFixture(t); const request = { op: 'capture' as const, session: 's', id: 'hang', actor: 'user', kind: 'message', content: 'hang' };
  await assert.rejects(runPensieveBridge({ ...f.input, request, timeoutMs: 100 }), /timed out/);
  const controller = new AbortController(); const pending = runPensieveBridge({ ...f.input, request, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(runPensieveBridge({ ...f.input, signal: controller.signal }), { name: 'AbortError' });
});
