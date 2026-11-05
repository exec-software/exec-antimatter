import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DownloadRecord } from '../src/main/hub/types';
import { snapshotPath } from '../src/main/hub/cache';
import { WorkloadDeployments, workloadSourceId } from '../src/main/workloadDeployment';
import { workloadById } from '../src/main/workloads';
import { thinkingSupport } from '../src/api/thinking';

const QWEN = 'qwen3-coder-30b-q8';
const MIMO = 'mimo-v26-flash-mxfp4';
const scratch = (t: { after(callback: () => void): void }) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-workload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const recordFor = (id: string, root: string): DownloadRecord => {
  const workload = workloadById(id);
  return {
    id: `download-${id}`, repoId: workload.repoId, revision: workload.revision, variantKey: workload.variantKey,
    label: workload.name, role: 'model', files: workload.files.map((file) => ({ ...file, done: true })),
    bytesDone: workload.files.reduce((sum, file) => sum + file.size, 0), bytesTotal: workload.files.reduce((sum, file) => sum + file.size, 0),
    state: 'ready', phase: null, error: null, root, createdAt: 1, startedAt: 1, finishedAt: 2,
    path: null, architecture: null, contextLength: null, modelId: id, registrations: [],
  };
};

/** Sparse files exercise actual filesystem size checks without allocating or downloading weights. */
const materialize = (record: DownloadRecord) => {
  for (const file of record.files) {
    const path = snapshotPath(record.root, record.repoId, record.revision, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    truncateSync(path, file.size);
  }
};

test('configuration requires a ready download for the exact pinned manifest and verified shards', (t) => {
  const root = scratch(t);
  let record = recordFor(QWEN, join(root, 'cache'));
  const deployments = new WorkloadDeployments(join(root, 'state'), { list: () => [record] });
  for (const patch of [ { state: 'downloading' as const }, { revision: '0'.repeat(40) }, { variantKey: 'different' } ]) {
    record = { ...recordFor(QWEN, record.root), ...patch };
    assert.throws(() => deployments.configure(QWEN, []), /Finish downloading/);
  }
  for (const patch of [{ done: false }, { sha256: '0'.repeat(64) }, { size: 1 }]) {
    record = recordFor(QWEN, record.root);
    Object.assign(record.files[0], patch);
    assert.throws(() => deployments.configure(QWEN, []), /unverified model shard/);
  }
  record = recordFor(QWEN, record.root);
  assert.throws(() => deployments.configure(QWEN, []), /missing or changed/);
  const path = snapshotPath(record.root, record.repoId, record.revision, record.files[0].path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'incomplete');
  assert.throws(() => deployments.configure(QWEN, []), /missing or changed/);
});

test('every shard is checked and peers are validated before a deployment is saved', (t) => {
  const root = scratch(t);
  const record = recordFor(MIMO, join(root, 'cache'));
  const deployments = new WorkloadDeployments(join(root, 'state'), { list: () => [record] });
  materialize(record);
  const second = snapshotPath(record.root, record.repoId, record.revision, record.files[1].path);
  rmSync(second);
  assert.throws(() => deployments.configure(MIMO, ['gpu:50052']), /missing or changed/);
  materialize(record);
  for (const peers of [[], ['gpu:0'], ['gpu:70000'], ['gpu:50052\nmodel = /injected']]) {
    assert.throws(() => deployments.configure(MIMO, peers), /peers/);
  }
  assert.equal(deployments.list().find((entry) => entry.id === MIMO)?.deployment, undefined);
  const peers = ['gpu:50052'];
  const configured = deployments.configure(MIMO, peers);
  peers[0] = 'changed:50052';
  assert.equal(configured.source.models[0].deployment, 'distributed');
  assert.deepEqual(deployments.list().find((entry) => entry.id === MIMO)?.deployment?.peers, ['gpu:50052']);
  assert.match(deployments.runtime(workloadSourceId(MIMO)).preset, /rpc = gpu:50052/);
});

test('a configured workload restores from disk with matching context, source identity, and private files', (t) => {
  const root = scratch(t);
  const record = recordFor(QWEN, join(root, 'cache'));
  materialize(record);
  const downloads = { list: () => [record] };
  const first = new WorkloadDeployments(join(root, 'state'), downloads);
  const configured = first.configure(QWEN, []);
  assert.equal(configured.contextTokens, workloadById(QWEN).contextTokens);
  assert.equal(configured.source.models[0].contextWindow, configured.contextTokens);
  assert.equal(configured.source.models[0].deployment, 'local');
  const missingSource = new WorkloadDeployments(join(root, 'state'), downloads, () => false);
  assert.equal(missingSource.list().find((entry) => entry.id === QWEN)?.deployment, undefined);
  const presentSource = new WorkloadDeployments(join(root, 'state'), downloads, (sourceId) => sourceId === workloadSourceId(QWEN));
  assert.equal(presentSource.list().find((entry) => entry.id === QWEN)?.deployment?.sourceId, workloadSourceId(QWEN));
  const restored = new WorkloadDeployments(join(root, 'state'), downloads);
  const runtime = restored.runtime(configured.source.id);
  assert.equal(runtime.modelId, QWEN);
  assert.match(runtime.preset, new RegExp(`ctx-size = ${configured.contextTokens}`));
  assert.match(runtime.preset, new RegExp(`fit-ctx = ${configured.contextTokens}`));
  assert.equal(statSync(join(root, 'state/workload-deployments.json')).mode & 0o777, 0o600);
  assert.throws(() => restored.runtime(`xxxxxxxxx${QWEN}`), /managed workload/);
  rmSync(runtime.modelPath);
  assert.throws(() => restored.runtime(configured.source.id), /missing or changed/);
});

test('failure writing a preset preserves the previously committed deployment settings', (t) => {
  const root = scratch(t);
  const record = recordFor(QWEN, join(root, 'cache'));
  materialize(record);
  const state = join(root, 'state');
  const deployments = new WorkloadDeployments(state, { list: () => [record] });
  deployments.configure(QWEN, []);
  const before = readFileSync(join(state, 'workload-deployments.json'), 'utf8');
  rmSync(join(state, 'workload-deployments'), { recursive: true });
  writeFileSync(join(state, 'workload-deployments'), 'occupied by a file');
  assert.throws(() => deployments.configure(QWEN, ['gpu:50052']));
  assert.equal(readFileSync(join(state, 'workload-deployments.json'), 'utf8'), before);
});

test('known reasoning workload aliases retain a supported thinking selector', () => {
  for (const id of [MIMO, 'deepseek-v4-flash-0731-q2', 'openmythos-27b']) {
    assert.equal(thinkingSupport({ kind: 'llama-cpp', protocol: 'openai-chat' }, id).mechanism, 'llama-budget');
  }
});

test('malformed persisted deployment values fail before reaching the renderer or runtime', (t) => {
  const root = scratch(t);
  const deployments = new WorkloadDeployments(root, { list: () => [] });
  for (const stored of [
    [],
    { [QWEN]: [] },
    { [QWEN]: null },
    { [QWEN]: { peers: 'gpu:50052' } },
    { [QWEN]: { peers: [123] } },
    { [QWEN]: { peers: ['gpu:65536'] } },
    { [MIMO]: { peers: [] } },
    { unknown: { peers: [] } },
  ]) {
    writeFileSync(join(root, 'workload-deployments.json'), JSON.stringify({ version: 1, deployments: stored }));
    assert.throws(() => deployments.list(), /Workload settings could not be read/);
    assert.throws(() => deployments.runtime(workloadSourceId(QWEN)), /Workload settings could not be read/);
  }
});
