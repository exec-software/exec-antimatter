import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../releases/model-manifest.json';
import { WORKLOADS, downloadWorkload, listWorkloads, renderWorkloadPreset, workloadBytes, workloadById, workloadFiles } from '../src/main/workloads';
import { groupVariants } from '../src/main/hub/api';
import type { DownloadRecord, HubVariant } from '../src/main/hub/types';

test('consumer workload uses the exact installer model and every catalog set is complete and pinned', () => {
  const qwen = workloadById('qwen3-coder-30b-q8');
  assert.equal(qwen.repoId, manifest.source.repository);
  assert.equal(qwen.revision, manifest.source.revision);
  assert.deepEqual(qwen.files, [{ path: manifest.source.filename, size: manifest.bytes, sha256: manifest.sha256 }]);
  for (const workload of WORKLOADS) {
    assert.match(workload.revision, /^[0-9a-f]{40}$/);
    for (const file of workload.files) { assert.match(file.sha256, /^[0-9a-f]{64}$/); assert.ok(file.size > 0); }
    const variants = groupVariants(workload.files);
    assert.equal(variants.length, 1);
    assert.equal(variants[0].key, workload.variantKey);
    assert.equal(variants[0].complete, true);
    assert.equal(variants[0].quant, workload.quantization);
    assert.ok(workload.contextTokens > workload.maxOutputTokens);
    // A projector is pinned as strictly as the weights and must group as its own
    // `projector` variant, which is how the download queue will carry it.
    if (workload.projector) {
      assert.match(workload.projector.file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(workload.projector.file.size > 0);
      const projector = groupVariants([workload.projector.file]);
      assert.equal(projector.length, 1);
      assert.equal(projector[0].role, 'projector');
      assert.equal(projector[0].key, workload.projector.variantKey);
      assert.equal(projector[0].complete, true);
      assert.equal(workloadFiles(workload).length, workload.files.length + 1);
      assert.equal(workloadBytes(workload), workload.files.reduce((sum, file) => sum + file.size, 0) + workload.projector.file.size);
    } else {
      assert.deepEqual(workloadFiles(workload), workload.files);
    }
  }
});

test('catalog download only enqueues reviewed files and preserves normal queue ownership', () => {
  let queued: { repoId: string; revision: string; variant: HubVariant } | undefined;
  const downloads = { enqueue(input: { repoId: string; revision: string; variant: HubVariant }) { queued = input; return {} as DownloadRecord; }, list: () => [] };
  const catalog = downloadWorkload(downloads, 'deepseek-v4-flash-0731-q2');
  assert.equal(queued?.variant.files.length, 3);
  assert.equal(queued?.variant.bytes, 96832508352);
  assert.equal(queued?.revision, 'fbbb5b93fb787c21338159b0af3318bb3f4d9768');
  assert.equal(catalog.length, WORKLOADS.length);
  assert.throws(() => downloadWorkload(downloads, { id: 'deepseek-v4-flash-0731-q2', files: [] }), /catalog/);
  assert.throws(() => downloadWorkload(downloads, '../custom'), /catalog/);
  catalog[0].files[0].sha256 = 'changed';
  assert.equal(listWorkloads(downloads)[0].files[0].sha256, manifest.sha256);
});

test('download state matches exact revisions, not a similarly named model', () => {
  const workload = workloadById('qwen3-coder-30b-q8');
  const record = { id: 'download', repoId: workload.repoId, revision: 'wrong', variantKey: workload.variantKey, state: 'ready', bytesDone: 42, error: null, path: '/model.gguf' } as DownloadRecord;
  assert.equal(listWorkloads({ list: () => [record] })[0].download, null);
  record.revision = workload.revision;
  assert.equal(listWorkloads({ list: () => [record] })[0].download?.path, '/model.gguf');
});

test('presets are lazy, keep context promises, and reject path or peer injection', () => {
  const preset = renderWorkloadPreset('qwen3-coder-30b-q8', '/cache/model.gguf');
  assert.match(preset, /load-on-startup = false/);
  assert.match(preset, /ctx-size = 32768/);
  assert.match(preset, /fit-ctx = 32768/);
  assert.match(preset, /^fit = on$/m);
  assert.match(preset, /^device = Vulkan0$/m);
  assert.match(preset, /parallel = 1/);
  assert.throws(() => renderWorkloadPreset('qwen3-coder-30b-q8', 'relative.gguf'), /absolute/);
  assert.throws(() => renderWorkloadPreset('qwen3-coder-30b-q8', '/cache/model.gguf\nrpc = bad:1'), /absolute/);
  assert.throws(() => renderWorkloadPreset('mimo-v26-flash-mxfp4', '/cache/model.gguf'), /peers/);
  assert.match(renderWorkloadPreset('mimo-v26-flash-mxfp4', '/cache/model.gguf', ['gpu-box:50052', '[::1]:50052']), /rpc = gpu-box:50052,\[::1\]:50052/);
  for (const peer of ['bad:0', 'bad:65536', 'bad:22\nmodel=/elsewhere', 'http://host:1234', 'user@host:22']) {
    assert.throws(() => renderWorkloadPreset('mimo-v26-flash-mxfp4', '/cache/model.gguf', [peer]), /host:port/);
  }
});

test('Qwen with RPC peers keeps adaptive placement across local and remote devices', () => {
  const preset = renderWorkloadPreset('qwen3-coder-30b-q8', '/cache/model.gguf', ['gpu-box:50052']);
  assert.match(preset, /^rpc = gpu-box:50052$/m);
  assert.match(preset, /^fit = on$/m);
  assert.match(preset, /^fit-ctx = 32768$/m);
  assert.doesNotMatch(preset, /^device\s*=/m);
  assert.doesNotMatch(preset, /^n-gpu-layers\s*=/m, 'adaptive fitting keeps the offload count unset');
  assert.equal(workloadById('qwen3-coder-30b-q8').engine, 'llama.cpp Vulkan');
});

test('a projector workload downloads, verifies, and serves both of its files', () => {
  const omni = workloadById('qwen3-omni-30b-q8');
  assert.equal(omni.contextTokens, 65536, 'the served window matches the converted checkpoint');
  assert.deepEqual(omni.modalities, ['images', 'audio']);
  assert.equal(workloadBytes(omni), 33809513856);

  const queued: { repoId: string; revision: string; variant: HubVariant }[] = [];
  const downloads = {
    enqueue(input: { repoId: string; revision: string; variant: HubVariant }) { queued.push(input); return {} as DownloadRecord; },
    list: () => [],
  };
  downloadWorkload(downloads, 'qwen3-omni-30b-q8');
  assert.equal(queued.length, 2, 'weights and projector are separate resumable records');
  assert.deepEqual(queued.map((item) => item.variant.role), ['model', 'projector']);
  assert.equal(queued[1].variant.key, omni.projector?.variantKey);
  assert.equal(queued[1].variant.files.length, 1);
  assert.equal(queued[1].variant.bytes, 1325020224);
  // Both records are pinned to the one reviewed revision.
  assert.ok(queued.every((item) => item.revision === omni.revision));

  // A single-file workload still enqueues exactly one record.
  const single: { repoId: string; revision: string; variant: HubVariant }[] = [];
  downloadWorkload({ enqueue(input: { repoId: string; revision: string; variant: HubVariant }) { single.push(input); return {} as DownloadRecord; }, list: () => [] }, 'qwen3-coder-30b-q8');
  assert.equal(single.length, 1);
});

test('a projector preset carries mmproj and refuses a mismatched file set', () => {
  const preset = renderWorkloadPreset('qwen3-omni-30b-q8', '/cache/omni.gguf', [], '/cache/mmproj-omni.gguf');
  assert.match(preset, /^mmproj = \/cache\/mmproj-omni\.gguf$/m);
  assert.match(preset, /^model = \/cache\/omni\.gguf$/m);
  assert.match(preset, /^ctx-size = 65536$/m);
  assert.match(preset, /^fit-ctx = 65536$/m);
  // The 30B workloads fit adaptively so a smaller card spills rather than failing outright.
  assert.match(preset, /^fit = on$/m);
  assert.match(preset, /^device = Vulkan0$/m);
  assert.match(preset, /load-on-startup = false/);

  // A projector workload may not be configured without its projector, and a text-only
  // workload may not be handed one.
  assert.throws(() => renderWorkloadPreset('qwen3-omni-30b-q8', '/cache/omni.gguf'), /projector file path/);
  assert.throws(() => renderWorkloadPreset('qwen3-coder-30b-q8', '/cache/model.gguf', [], '/cache/mmproj.gguf'), /no projector/);
  // The projector path is held to the same injection rules as the model path.
  for (const bad of ['relative.gguf', '/cache/mmproj.gguf\nrpc = bad:1', '/cache/mmproj\u0000.gguf']) {
    assert.throws(() => renderWorkloadPreset('qwen3-omni-30b-q8', '/cache/omni.gguf', [], bad), /absolute projector path/);
  }
});

test('a projector workload is only as ready as its weakest file', () => {
  const omni = workloadById('qwen3-omni-30b-q8');
  const record = (variantKey: string, state: string, bytesDone: number) => ({
    id: `download-${variantKey}`, repoId: omni.repoId, revision: omni.revision, variantKey,
    state, bytesDone, error: null, path: '/cache/omni.gguf',
  } as DownloadRecord);
  const view = (records: DownloadRecord[]) =>
    listWorkloads({ list: () => records }).find((item) => item.id === 'qwen3-omni-30b-q8');

  // Weights verified while the projector is still arriving is not a ready workload.
  assert.equal(view([record(omni.variantKey, 'ready', 32484493632)])?.download?.state, 'downloading');
  assert.equal(view([
    record(omni.variantKey, 'ready', 32484493632),
    record(omni.projector!.variantKey, 'downloading', 1000),
  ])?.download?.state, 'downloading');
  // Both verified is ready, and progress is the sum of the parts.
  const complete = view([
    record(omni.variantKey, 'ready', 32484493632),
    record(omni.projector!.variantKey, 'ready', 1325020224),
  ]);
  assert.equal(complete?.download?.state, 'ready');
  assert.equal(complete?.download?.bytesDone, 33809513856);
  assert.equal(complete?.bytes, 33809513856);
  // A failure on either part is the state of the whole, and its error is surfaced.
  const failed = view([
    record(omni.variantKey, 'ready', 32484493632),
    { ...record(omni.projector!.variantKey, 'failed', 10), error: 'checksum mismatch' },
  ]);
  assert.equal(failed?.download?.state, 'failed');
  assert.equal(failed?.download?.error, 'checksum mismatch');
  assert.equal(view([])?.download, null);
});

test('the 80B coder is pinned as a four-shard Q4_K_M set and serves its native window', () => {
  const workload = workloadById('qwen3-coder-next-80b-q4');
  assert.equal(workload.files.length, 4);
  assert.equal(workloadBytes(workload), 48410992032);
  // The shard set must collapse to exactly the variant key the queue will look for. A shard
  // naming change would otherwise leave a catalog entry that downloads and never matches.
  const variants = groupVariants(workload.files);
  assert.equal(variants.length, 1);
  assert.equal(variants[0].key, 'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M');
  assert.equal(variants[0].shards, 4);
  assert.equal(variants[0].complete, true);
  assert.equal(variants[0].quant, 'Q4_K_M');
  assert.equal(workload.requiresPeers, false);

  // 262,144 is the card's native window and the ceiling both serving modes divide up. Serving
  // more would be YaRN territory, which the card validates only to 131,072.
  const preset = renderWorkloadPreset('qwen3-coder-next-80b-q4', '/models/coder-next-00001-of-00004.gguf');
  assert.match(preset, /ctx-size = 262144/);
  assert.match(preset, /fit-ctx = 262144/);
  assert.match(preset, /load-on-startup = false/);
});

test('adaptive placement follows active parameters, not download size', () => {
  // A 3B-active MoE may spill to CPU: the answer gets slower, not useless. The big checkpoints
  // must keep demanding a full offload, so this pairing is asserted rather than left to a
  // comment — renaming an id would otherwise silently move a workload between the two.
  for (const id of ['qwen3-coder-30b-q8', 'qwen3-omni-30b-q8', 'qwen3-coder-next-80b-q4']) {
    const projector = id === 'qwen3-omni-30b-q8' ? '/models/mmproj.gguf' : undefined;
    const preset = renderWorkloadPreset(id, '/models/model.gguf', [], projector);
    assert.match(preset, /^fit = on$/m, id);
    assert.match(preset, /^device = Vulkan0$/m, id);
    assert.doesNotMatch(preset, /n-gpu-layers/, id);
  }
  assert.match(renderWorkloadPreset('deepseek-v4-flash-0731-q2', '/models/model.gguf'), /^n-gpu-layers = 999$/m);
  assert.match(renderWorkloadPreset('mimo-v26-flash-mxfp4', '/models/model.gguf', ['box:50052']), /^n-gpu-layers = 999$/m);
});
