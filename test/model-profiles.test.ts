import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createWorkload, listWorkloads, resolve, resolveSourceProfile, setOverride, useConfigPath, withEngineContext } from '../src/main/modelProfiles';
import { promptBudget } from '../src/main/context';

const scratch = (t: { after(fn: () => unknown): void }) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-model-profiles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  useConfigPath(join(root, 'model-profiles.json'));
};

test('a smaller engine profile leaves room for project prompts and restores the original reply budget', (t) => {
  scratch(t);
  const modelId = 'DeepSeek-V4-Flash-0731-UD-Q2_K_XL';
  setOverride('deepseek', modelId, { contextTokens: 131072, maxOutputTokens: 32768, thinkingLevel: 'high' });
  const original = resolve({ providerId: 'deepseek', modelId, serverContextTokens: 131072 });
  const orchestration = withEngineContext(original, 32768);
  assert.equal(orchestration.contextTokens, 32768);
  assert.equal(orchestration.maxOutputTokens, 8192);
  assert.ok(promptBudget(orchestration, []) > 20000, 'output must not reserve the entire smaller context window');
  assert.equal(orchestration.thinkingLevel, original.thinkingLevel);
  const saved = resolve({ providerId: 'deepseek', modelId, serverContextTokens: 131072 });
  assert.deepEqual(saved, original, 'applying a runtime cap never rewrites model preferences');
  assert.deepEqual(withEngineContext(saved, 131072), original, 'Straight shot restores its complete original budget');
});

test('the published window table answers for a model no server has been asked about', (t) => {
  scratch(t);

  // 65536 is `qwen3vlmoe.context_length` in the checkpoint itself. The table is ordered, and
  // the general `qwen3` rule that follows this one would have claimed 131072 — double the
  // real window, which does not fail loudly: the prompt is built to fill it and the server
  // drops the far end, so a long turn quietly loses its oldest messages.
  const omni = resolve({ providerId: 'beholdd', modelId: 'qwen3-omni-30b' });
  assert.equal(omni.contextTokens, 65_536);
  assert.equal(omni.contextSource, 'known');

  // ...and the omni line must not have shadowed the coder sitting below it.
  assert.equal(resolve({ providerId: 'beholdd', modelId: 'qwen3-coder-30b' }).contextTokens, 262_144);

  // DeepSeek V4 matched no line at all before it was given one: the `v?[23]` rule cannot see a
  // v4 id, so the widest window in this table collapsed onto the 8192 default — understating it
  // by a factor of 128. The id here is the one this box now serves: beholdd's entry names the
  // build — `deepseek-v4-flash-0731-ud-q2_k_xl` — so the rule has to match past a quant suffix
  // and not only a bare family name. The v3 rule underneath must still answer for its own
  // generation.
  const flash = resolve({ providerId: 'beholdd', modelId: 'deepseek-v4-flash-0731-ud-q2_k_xl' });
  assert.equal(flash.contextTokens, 1_048_576);
  assert.equal(flash.contextSource, 'known');
  assert.equal(resolve({ providerId: 'beholdd', modelId: 'deepseek-v4-flash' }).contextTokens, 1_048_576);
  assert.equal(resolve({ providerId: 'beholdd', modelId: 'deepseek-v3.1' }).contextTokens, 131_072);
});

test('a window the server reported is believed over the published one', (t) => {
  scratch(t);

  // The table is what a model documents; what a given server will accept is the fact. beholdd
  // serves omni at its own configured context, which may be below the checkpoint's maximum.
  const served = resolve({
    providerId: 'beholdd',
    modelId: 'qwen3-omni-30b',
    serverContextTokens: 32_768,
  });
  assert.equal(served.contextTokens, 32_768);
  assert.equal(served.contextSource, 'server');
});

test('a fixed C128 execution cap bounds the model window and reserves a quarter for output', (t) => {
  scratch(t);

  const profile = resolve({
    providerId: 'beholdd',
    modelId: 'qwen3-0.6b',
    serverMaxEvaluatedTokens: 128,
  });
  assert.equal(profile.maxEvaluatedTokens, 128);
  assert.equal(profile.contextTokens, 128);
  assert.equal(profile.contextSource, 'server');
  assert.equal(profile.maxOutputTokens, 32);
  assert.equal(profile.outputSource, 'server');
});

test('context and output overrides cannot enlarge the execution cap', (t) => {
  scratch(t);
  const input = { providerId: 'beholdd', modelId: 'qwen3-0.6b', serverMaxEvaluatedTokens: 128 };

  setOverride(input.providerId, input.modelId, { contextTokens: 8_192, maxOutputTokens: 4_096 });
  const bounded = resolve({ ...input, serverContextTokens: 32_768 });
  assert.equal(bounded.contextTokens, 128);
  assert.equal(bounded.maxOutputTokens, 128);
  assert.equal(bounded.contextSource, 'server');
  assert.equal(bounded.outputSource, 'server');
  assert.equal(bounded.maxEvaluatedTokens, 128);

  setOverride(input.providerId, input.modelId, { contextTokens: 64, maxOutputTokens: 8 });
  const narrower = resolve(input);
  assert.equal(narrower.contextTokens, 64);
  assert.equal(narrower.maxOutputTokens, 8);
  assert.equal(narrower.contextSource, 'override');
  assert.equal(narrower.outputSource, 'override');
  assert.equal(narrower.maxEvaluatedTokens, 128, 'a smaller preference does not erase the server limit');

  setOverride(input.providerId, input.modelId, null);
  assert.equal(resolve({ ...input, serverContextTokens: 64 }).contextTokens, 64);
});

test('execution caps admit exact positive safe integers without rounding or coercion', (t) => {
  scratch(t);
  const input = { providerId: 'beholdd', modelId: 'unknown', serverContextTokens: 128 };
  const original = resolve(input);
  assert.equal(original.maxOutputTokens, 128, 'uncapped small-window behavior is unchanged');
  assert.ok(!('maxEvaluatedTokens' in original));
  for (const invalid of [undefined, null, 0, -1, 0.5, 128.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '128', true, {}]) {
    assert.deepEqual(resolve({ ...input, serverMaxEvaluatedTokens: invalid as number | null | undefined }), original);
  }
  for (const capacity of [1, 2, 4, 128, Number.MAX_SAFE_INTEGER]) {
    const profile = resolve({ ...input, serverMaxEvaluatedTokens: capacity });
    assert.equal(profile.maxEvaluatedTokens, capacity);
    assert.equal(profile.contextTokens, Math.min(128, capacity));
    assert.ok(profile.maxOutputTokens >= 1 && profile.maxOutputTokens <= profile.contextTokens);
  }
});

test('execution limits stay source-scoped and absent limits preserve existing defaults', (t) => {
  scratch(t);
  const modelId = 'qwen3-0.6b';
  const limited = resolve({ providerId: 'hag', modelId, serverMaxEvaluatedTokens: 128 });
  const unlimited = resolve({ providerId: 'cpu', modelId });
  assert.equal(limited.contextTokens, 128);
  assert.equal(unlimited.contextTokens, 131_072);
  assert.equal(unlimited.maxOutputTokens, 32_768);
  assert.ok(!('maxEvaluatedTokens' in unlimited));
  assert.deepEqual(resolve({ providerId: 'cpu', modelId, serverMaxEvaluatedTokens: null }), unlimited);
});

test('execution caps bound the selected workload without rewriting saved settings', (t) => {
  scratch(t);
  const input = { providerId: 'hag', modelId: 'qwen3-0.6b', serverContextTokens: 131_072 };
  createWorkload(input.providerId, input.modelId, {
    name: 'Default', settings: { contextTokens: 32_768, maxOutputTokens: 8_192 },
  });
  createWorkload(input.providerId, input.modelId, {
    name: 'Review', settings: {
      contextTokens: 65_536, maxOutputTokens: 64, maxToolCallsPerMessage: 3,
      instructions: 'Review the supplied change.', thinkingLevel: 'high', compaction: 'drop',
    },
  });
  const saved = listWorkloads(input.providerId, input.modelId);
  const selected = { ...input, workloadId: 'review' };
  const profile = resolve({ ...selected, serverMaxEvaluatedTokens: 2_048 });
  assert.equal(profile.contextTokens, 2_048);
  assert.equal(profile.contextSource, 'server');
  assert.equal(profile.maxOutputTokens, 64, 'the selected workload keeps its smaller reply ceiling');
  assert.equal(profile.maxToolCallsPerMessage, 3);
  assert.equal(profile.instructions, 'Review the supplied change.');
  assert.equal(profile.thinkingLevel, 'high');
  assert.equal(profile.compaction, 'drop');
  assert.deepEqual(listWorkloads(input.providerId, input.modelId), saved);
  assert.equal(resolve(selected).contextTokens, 65_536, 'saved preferences remain available without the runtime cap');
  assert.equal(resolve({ ...selected, serverMaxEvaluatedTokens: null }).contextTokens, 65_536);
  assert.equal(resolve(input).contextTokens, 32_768, 'resolving another workload does not change the default');
});

test('local engine and server execution limits both bound the effective workload', (t) => {
  scratch(t);
  const input = { providerId: 'hag', modelId: 'qwen3-0.6b', serverContextTokens: 131_072 };
  const bounded = resolve({ ...input, serverMaxEvaluatedTokens: 2_048 });
  assert.equal(bounded.maxOutputTokens, 512);
  assert.equal(promptBudget(bounded, []), 1_382);
  assert.deepEqual(withEngineContext(bounded, 32_768), bounded, 'a larger local allocation cannot widen the execution cap');
  const smallerEngine = withEngineContext(bounded, 1_024);
  assert.equal(smallerEngine.contextTokens, 1_024);
  assert.equal(smallerEngine.maxEvaluatedTokens, 2_048, 'the separate server observation remains intact');
  assert.equal(smallerEngine.maxOutputTokens, 256);
  assert.equal(promptBudget(smallerEngine, []), 691);
  assert.equal(withEngineContext(resolve(input), 32_768).contextTokens, 32_768,
    'clearing the server observation still respects the current local engine allocation');
});

test('effective source profiles keep observed limits separate from curated metadata and other models', (t) => {
  scratch(t);
  const modelId = 'qwen3-0.6b';
  const models = [
    { id: modelId, name: modelId, contextWindow: 131_072, contextWindowCurated: true, maxEvaluatedTokens: 2_048 },
    { id: 'other', name: 'Other model', contextWindow: 8_192 },
  ];
  assert.equal(resolveSourceProfile(models, 'hag', modelId).contextTokens, 2_048);
  assert.equal(resolveSourceProfile(models, 'hag', 'other').contextTokens, 8_192);
  const otherSource = resolveSourceProfile([{ id: modelId, name: modelId }], 'cpu', modelId);
  assert.equal(otherSource.contextTokens, 131_072);
  assert.equal(otherSource.maxEvaluatedTokens, undefined);
  assert.equal(resolveSourceProfile([], 'hag', modelId).maxEvaluatedTokens, undefined);
  assert.equal(models[0].contextWindow, 131_072, 'effective resolution never replaces curated context metadata');
});

test('a model that floods its batches gets a narrower one than the default', (t) => {
  scratch(t);

  // MiMo twice emitted a degenerate batch — 1,306 read_file calls on one reply, 433 on another —
  // and each of those was decoded at the price of any other token. Sixteen is well above what
  // its healthy rounds asked for and cuts a runaway in about half a minute.
  const mimo = resolve({ providerId: 'beholdd', modelId: 'mimo-v26-flash' });
  assert.equal(mimo.maxToolCallsPerMessage, 16);
  assert.equal(mimo.toolCallSource, 'known');

  const other = resolve({ providerId: 'beholdd', modelId: 'qwen3-coder-30b' });
  assert.equal(other.maxToolCallsPerMessage, 32);
  assert.equal(other.toolCallSource, 'default');
});

test('a batch cap set by hand wins, and a nonsensical one is refused', (t) => {
  scratch(t);

  setOverride('beholdd', 'mimo-v26-flash', { maxToolCallsPerMessage: 4 });
  const narrowed = resolve({ providerId: 'beholdd', modelId: 'mimo-v26-flash' });
  assert.equal(narrowed.maxToolCallsPerMessage, 4);
  assert.equal(narrowed.toolCallSource, 'override');

  // Above the point where a cap stops protecting anything, and below one call, are both the
  // failure the cap exists to prevent rather than a preference.
  setOverride('beholdd', 'mimo-v26-flash', { maxToolCallsPerMessage: 100_000 });
  assert.equal(resolve({ providerId: 'beholdd', modelId: 'mimo-v26-flash' }).maxToolCallsPerMessage, 128);

  setOverride('beholdd', 'mimo-v26-flash', { maxToolCallsPerMessage: 0 });
  assert.equal(resolve({ providerId: 'beholdd', modelId: 'mimo-v26-flash' }).maxToolCallsPerMessage, 16);
});

test('a model whose thinking is billed as output gets a shorter reply than the share allows', (t) => {
  scratch(t);

  // Reserving a quarter of a 131,072 window hits the 32,768 lid, and MiMo spends it: measured at
  // 16 tok/s, one turn ran thirty-four minutes. The reservation is taken out of the same window
  // the prompt lives in, so it also decided how soon the conversation started compacting.
  //
  // 16,384 rather than the 12,288 tried first, which sat level with the largest round measured
  // instead of above it and was duly hit — see KNOWN_OUTPUT.
  const mimo = resolve({ providerId: 'beholdd', modelId: 'mimo-v26-flash', serverContextTokens: 131_072 });
  assert.equal(mimo.maxOutputTokens, 16_384);
  assert.equal(mimo.outputSource, 'known');

  // A model with no entry still gets the share, up to the lid.
  const other = resolve({ providerId: 'beholdd', modelId: 'openmythos-27b', serverContextTokens: 131_072 });
  assert.equal(other.maxOutputTokens, 32_768);
  assert.notEqual(other.outputSource, 'known');
});

test('the per-model cap is a ceiling on the share, never a floor under it', (t) => {
  scratch(t);

  // A quarter of 16,384 is 4,096. The table exists to shorten a reply, so it must not lengthen
  // one on a window that cannot afford it.
  const small = resolve({ providerId: 'beholdd', modelId: 'mimo-small', serverContextTokens: 16_384 });
  assert.equal(small.maxOutputTokens, 4_096);

  // And a cap set by hand still wins over the table.
  setOverride('beholdd', 'mimo-v26-flash', { maxOutputTokens: 20_000 });
  const raised = resolve({ providerId: 'beholdd', modelId: 'mimo-v26-flash', serverContextTokens: 131_072 });
  assert.equal(raised.maxOutputTokens, 20_000);
  assert.equal(raised.outputSource, 'override');
});

test('a coder that does not think aloud keeps its window instead of reserving it', (t) => {
  scratch(t);

  // Across 319 rounds of qwen3-coder-30b on this box the largest reply was 5,473 tokens: it
  // writes an answer and its tool arguments and nothing else. Reserving the full 32,768 share
  // for output it never produces costs the conversation ~14,700 tokens of prompt budget.
  const coder = resolve({ providerId: 'beholdd', modelId: 'qwen3-coder-30b', serverContextTokens: 131_072 });
  assert.equal(coder.maxOutputTokens, 16_384);
  assert.equal(coder.outputSource, 'known');

  // Its batches are not MiMo's problem — 290 of 354 were a single call and the cap never fired —
  // so it keeps the ordinary allowance.
  assert.equal(coder.maxToolCallsPerMessage, 32);
  assert.equal(coder.toolCallSource, 'default');
});
