import assert from 'node:assert/strict';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { FeatureStore } from '../src/main/features/store';
import { FeatureService } from '../src/main/features/service';
const execFile = promisify(execFileCallback);

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(process.env.ANTIMATTER_TEST_ARTIFACTS || tmpdir(), 'antimatter-features-'));
  const file = join(directory, 'state.json'), store = new FeatureStore(file), service = new FeatureService(store);
  t.after(async () => { await service.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, store, service };
}
function call(endpoint: string, request: string): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const socket = createConnection(endpoint); let output = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Fixture timed out')); });
    socket.on('error', reject); socket.on('data', (chunk) => { output += chunk; });
    socket.on('end', () => resolveResult(output)); socket.once('connect', () => socket.write(request));
  });
}

test('persistent feature defaults and overrides use revision checks and bounded audit', (t) => {
  const f = fixture(t);
  let current = f.store.update(0, { kind: 'application', id: 'demo', name: 'Demo' });
  current = f.store.update(current.revision, { kind: 'declare', application: 'demo', key: 'preview', description: 'Preview', defaultEnabled: false });
  current = f.store.update(current.revision, { kind: 'override', application: 'demo', key: 'preview', value: true });
  assert.equal(current.applications[0].features[0].enabled, true);
  current = f.store.update(current.revision, { kind: 'declare', application: 'demo', key: 'preview', description: 'Agent cannot erase title', defaultEnabled: false }, 'sdk');
  assert.equal(current.applications[0].features[0].description, 'Preview');
  assert.equal(current.applications[0].features[0].enabled, true);
  current = f.store.update(current.revision, { kind: 'override', application: 'demo', key: 'preview', value: null });
  assert.equal(current.applications[0].features[0].enabled, false);
  assert.deepEqual(new FeatureStore(f.file).read(), current);
  assert.throws(() => f.store.update(0, { kind: 'application', id: 'other', name: 'Other' }), /changed/);
  assert.throws(() => f.store.update(current.revision, { kind: 'application', id: '../bad', name: 'Bad' }));
  assert.throws(() => f.store.update(current.revision, { kind: 'application', id: 'agent', name: 'Agent' }, 'sdk'), /Antimatter/);
});

test('real local transport requires opt-in, a registered app and well-formed requests', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t);
  f.store.update(0, { kind: 'application', id: 'demo', name: 'Demo' });
  assert.equal(f.service.get().api.endpoint, null);
  assert.throws(() => f.service.protocol('1\tGET\tdemo\tpreview'), /disabled/);
  const started = await f.service.configureApi(true), endpoint = started.api.endpoint!;
  assert.equal(statSync(endpoint).mode & 0o777, 0o600);
  assert.equal(await call(endpoint, '1\tDECLARE\tdemo\tpreview\t0\n'), 'OK\t0\n');
  assert.equal(await call(endpoint, '1\tSET\tdemo\tpreview\t1\n'), 'OK\t1\n');
  assert.equal(await call(endpoint, '1\tGET\tdemo\tpreview\n'), 'OK\t1\n');
  assert.match(await call(endpoint, '1\tDECLARE\tunregistered\tpreview\t1\n'), /^ERR/);
  assert.match(await call(endpoint, '1\tSET\tdemo\tpreview\tinvalid\n'), /^ERR/);
  assert.match(await call(endpoint, '1\tGET\tdemo\tpreview\n1\tGET\tdemo\tpreview\n'), /^ERR/);
  assert.deepEqual(JSON.parse((await call(endpoint, '1\tLIST\tdemo\n')).slice(3)), f.store.read().applications[0].features);
  await f.service.configureApi(false);
  await assert.rejects(call(endpoint, '1\tGET\tdemo\tpreview\n'));
  assert.equal(f.store.read().applications[0].features[0].enabled, true, 'disabling transport preserves flags');
});

test('C ABI compiles with strict warnings and controls a real desktop service', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t), sdk = resolve('sdk/features');
  f.store.update(0, { kind: 'application', id: 'fixture', name: 'Fixture' });
  const endpoint = (await f.service.configureApi(true)).api.endpoint!;
  const main = join(f.directory, 'client.c'), binary = join(f.directory, 'client');
  writeFileSync(main, `#include "antimatter_features.h"
#include <stdio.h>
int main(int argc,char **argv) {
  char list[2048]; if(argc!=2) return 1;
  if(antimatter_feature_declare(argv[1],"fixture","preview",0)!=0) return 2;
  if(antimatter_feature_set(argv[1],"fixture","preview",1)!=1) return 3;
  if(antimatter_feature_declare(argv[1],"fixture","preview",0)!=1) return 4;
  if(antimatter_feature_get(argv[1],"fixture","preview")!=1) return 5;
  if(antimatter_feature_set(argv[1],"fixture","preview",-1)!=0) return 6;
  if(antimatter_feature_get(argv[1],"fixture","missing")!=-1) return 7;
  if(antimatter_feature_set(argv[1],"fixture","preview",2)!=-1) return 8;
  if(antimatter_feature_get(argv[1],"fixture\\ninjected","preview")!=-1) return 9;
  if(antimatter_features_list(argv[1],"fixture",list,sizeof(list))<0) return 10;
  puts(list); return 0;
}
`);
  execFileSync(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', sdk, join(sdk, 'antimatter_features.c'), main, '-o', binary], { timeout: 20_000 });
  const result = await execFile(binary, [endpoint], { timeout: 20_000 });
  assert.equal(JSON.parse(result.stdout)[0].enabled, false);
});

test('failed persistence and corrupt files never erase feature configuration', (t) => {
  const f = fixture(t);
  f.store.update(0, { kind: 'application', id: 'demo', name: 'Demo' });
  const before = readFileSync(f.file, 'utf8'), failing = new FeatureStore(f.file, () => { throw new Error('Disk full'); });
  assert.throws(() => failing.update(1, { kind: 'remove-application', id: 'demo' }), /Disk full/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  writeFileSync(f.file, 'broken');
  assert.throws(() => f.store.update(0, { kind: 'application', id: 'demo', name: 'Demo' }));
  assert.equal(readFileSync(f.file, 'utf8'), 'broken');
});

test('Matrix host bindings link and execute against the C API', { skip: !process.env.ANTIMATTER_NIL_SDK || process.platform !== 'linux' }, async (t) => {
  const f = fixture(t), sdk = resolve('sdk/features'), nil = process.env.ANTIMATTER_NIL_SDK!;
  f.store.update(0, { kind: 'application', id: 'matrix_test', name: 'Matrix fixture' });
  const endpoint = (await f.service.configureApi(true)).api.endpoint!;
  assert.match(endpoint, /^[a-zA-Z0-9/_.-]+$/, 'fixture path can be represented by a Matrix literal');
  const source = join(f.directory, 'example.matrix'), object = join(f.directory, 'example.o');
  writeFileSync(source, `book feature.example
read everything from antimatter.features
main returns number begin paragraph
    value endpoint as text is "${endpoint}"
    value first as number is antimatter_feature_declare with endpoint being endpoint, application being "matrix_test", key being "preview", default_enabled being 0
    when first does not equal 0 then give 1 end when
    value enabled as number is antimatter_feature_set with endpoint being endpoint, application being "matrix_test", key being "preview", override_value being 1
    when enabled does not equal 1 then give 2 end when
    value readback as number is antimatter_feature_get with endpoint being endpoint, application being "matrix_test", key being "preview"
    when readback does not equal 1 then give 3 end when
    give 0
end paragraph
`);
  execFileSync(join(nil, 'nilcompiler'), ['--no-stdlib', '--no-bundle', '-o', join(f.directory, 'example.nil'), join(sdk, 'antimatter_features.matrix'), source], { timeout: 30_000 });
  execFileSync(join(nil, 'nilassembler'), ['--unmanaged', '--freestanding', '-o', object, join(f.directory, 'example.nil')], { timeout: 30_000 });
  const driver = join(f.directory, 'driver.c'), binary = join(f.directory, 'matrix-example');
  writeFileSync(driver, '#include <stdint.h>\nextern int64_t __ny_entry(void);\nint main(void) { return (int)__ny_entry(); }\n');
  execFileSync(process.env.CC || 'cc', ['-no-pie', '-I', sdk, driver, object, join(sdk, 'antimatter_features.c'), join(nil, 'nillib/native/libnilruntime_freestanding.a'), '-o', binary], { timeout: 30_000 });
  await execFile(binary, [], { timeout: 10_000 });
  assert.equal(f.store.read().applications[0].features[0].enabled, true);
});
