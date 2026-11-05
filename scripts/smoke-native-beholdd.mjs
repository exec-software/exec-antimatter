#!/usr/bin/env node
/** Cross-project protocol smoke: a disposable native server, no checkpoint loading or inference. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/smoke-native-beholdd.mjs --binary /absolute/path/to/beholdd\nStarts only this binary on a random loopback port with temporary config and a nonexistent checkpoint.\nVerifies native identity, capability discovery, and idempotent unload without performing inference.');
  process.exit(0);
}
assert.equal(process.argv[2], '--binary');
assert.equal(process.argv.length, 4);
assert.ok(path.isAbsolute(process.argv[3]), 'Pass an absolute native binary path.');
const binary = process.argv[3];
assert.ok((await fs.stat(binary)).isFile());
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-native-beholdd-'));
console.log(`Native Beholdd smoke: ${temporary}`);
await build({
  entryPoints: [path.join(root, 'src/main/beholddProtocol.ts'), path.join(root, 'src/main/residency.ts')],
  outdir: temporary, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
});
const { probeNativeBeholdd } = await import(pathToFileURL(path.join(temporary, 'beholddProtocol.mjs')).href);
const { readResidency, unloadModel } = await import(pathToFileURL(path.join(temporary, 'residency.mjs')).href);
const modelId = 'native-smoke/idle model';
const config = path.join(temporary, 'config.yaml');
await fs.writeFile(config, `models:\n  - id: '${modelId}'\n    path: './deliberately-absent.gguf'\n`);
// The CLI rejects port zero. Choose an unused loopback port; if another process wins the
// bind race, the child fails and no request is sent (we require this child's ready message).
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolve);
});
const port = reservation.address().port;
await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
const child = spawn(binary, ['serve', '--config', config, '--host', '127.0.0.1', '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BEHOLDD_HOME: temporary },
});
const exited = new Promise((resolve) => child.once('exit', resolve));
let output = '';
const verify = async () => {
  const baseUrl = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`Native fixture exited early (${code ?? signal}): ${output}`)));
    const accept = (data) => {
      output = `${output}${data}`.slice(-32_768);
      const match = output.match(/beholdd v2 listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { resolve(`http://127.0.0.1:${match[1]}/v1`); }
    };
    child.stdout.on('data', accept);
    child.stderr.on('data', accept);
  });
  const info = await probeNativeBeholdd(baseUrl);
  assert.equal(info?.runtime, 'native');
  assert.deepEqual(info.execution_backends, ['cpu']);
  assert.deepEqual(info.architectures, ['qwen3', 'qwen3moe']);
  assert.equal(info.operations.unload, true);
  const source = { id: 'isolated-native-fixture', kind: 'beholdd', baseUrl };
  const report = await readResidency(source);
  assert.equal(report.supported, true);
  assert.equal(report.canUnload, true);
  assert.equal(report.unloadRequiresIdle, true);
  assert.deepEqual(report.models, []);
  assert.equal(report.error, undefined);
  await unloadModel(source, modelId);
  await unloadModel(source, modelId);
  await assert.rejects(unloadModel(source, 'not-configured'), /404/);
  const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(2_000) });
  assert.equal(response.status, 200);
  const models = await response.json();
  assert.equal(models.data.length, 1);
  assert.equal(models.data[0].id, modelId);
  assert.equal(models.data[0].loaded, false);
  assert.equal(models.data[0].compatibility, 'unverified');
  assert.deepEqual(models.data[0].capabilities, []);
  console.log('Native Beholdd smoke passed: real server identity, Antimatter capability discovery, encoded-ID idempotent unload, unknown-ID refusal, no model load or inference.');
};
let deadline;
try {
  await Promise.race([
    verify(),
    new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('Native smoke timed out.')), 20_000);
    }),
  ]);
} finally {
  clearTimeout(deadline);
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    await exited;
    clearTimeout(force);
  }
}
