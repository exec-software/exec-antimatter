import assert from 'node:assert/strict';
import test from 'node:test';
import { modelsAgree, substitutionWarning } from '../src/main/servedModel';

test('an engine alias for the requested model is not a substitution', () => {
  // Both observed on the same beholdd: a configuration id goes in, an engine alias comes back.
  assert.equal(modelsAgree('mimo-v26-flash', 'MiMo-V2.6-Flash-RL-MXFP4'), true);
  assert.equal(modelsAgree('nemotron-nano-4b', 'nemotron-nano-4b-q8'), true);
  assert.equal(modelsAgree('qwen3-coder-30b', 'qwen3-coder-30b-instruct'), true);
});

test('an id that names the build agrees with the alias that build answers under', () => {
  // beholdd takes llama-server's instance name from the GGUF basename rather than from the id it
  // was asked for, so this box's DeepSeek V4 answers as `DeepSeek-V4-Flash-0731-UD-Q2_K_XL`
  // whichever id reached it (measured 2026-09-27). Its configured id is spelled the same way for
  // that reason: containment is checked on letters and digits, and a build tag missing from the
  // middle of the id — `deepseek-v4-flash-ud-q2_k_xl`, without the 0731 — is neither a substring
  // of the answer nor a superstring of it, so every correct turn would carry a warning.
  assert.equal(modelsAgree('deepseek-v4-flash-0731-ud-q2_k_xl', 'DeepSeek-V4-Flash-0731-UD-Q2_K_XL'), true);

  // The unqualified id this replaced agrees too, which is why it served without complaint. What
  // it cannot do is tell two builds of one checkpoint apart: the 139 GB MXFP4_MOE answers it
  // exactly as well as the q2 does, so a conversation labelled `deepseek-v4-flash` is evidence of
  // the checkpoint and not of the file. Naming the build in the id is what gives this check the
  // second one to compare.
  assert.equal(modelsAgree('deepseek-v4-flash', 'DeepSeek-V4-Flash-0731-UD-Q2_K_XL'), true);
  assert.equal(modelsAgree('deepseek-v4-flash', 'DeepSeek-V4-Flash-MXFP4_MOE'), true);
  assert.equal(modelsAgree('deepseek-v4-flash-0731-ud-q2_k_xl', 'DeepSeek-V4-Flash-MXFP4_MOE'), false);
});

test('the default model answering for an unrecognised id is caught', () => {
  // The reported bug: MiMo selected, Nemotron served, every other signal still saying MiMo.
  assert.equal(modelsAgree('mimo-v26-flash', 'NVIDIA-Nemotron-3-Super-120B-A12B-Q8_0'), false);
});

test('two models of the same family but a different size disagree', () => {
  assert.equal(modelsAgree('qwen3-coder-30b', 'qwen3-coder-480b'), false);
  assert.equal(modelsAgree('openmythos-q4', 'openmythos-27b'), false);
});

test('a path id is compared on its checkpoint name, not the directories above it', () => {
  assert.equal(
    modelsAgree(
      '/mnt/weights/unsloth/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF/Q8_0/NVIDIA-Nemotron-3-Super-120B-A12B-Q8_0-00001-of-00004.gguf',
      'NVIDIA-Nemotron-3-Super-120B-A12B-Q8_0'
    ),
    true
  );
  assert.equal(
    modelsAgree('/mnt/weights/mimo/MiMo-V2.6-Flash-RL-MXFP4-00001-of-00002.gguf', 'NVIDIA-Nemotron-3-Super-120B-A12B-Q8_0'),
    false
  );
});

test('silence is not evidence of substitution', () => {
  // A server that sends no model field, or an unusable one, must not raise a warning.
  assert.equal(modelsAgree('mimo-v26-flash', undefined), true);
  assert.equal(modelsAgree('mimo-v26-flash', ''), true);
  assert.equal(modelsAgree('mimo-v26-flash', '   '), true);
  assert.equal(modelsAgree('', 'NVIDIA-Nemotron-3-Super-120B-A12B-Q8_0'), true);
});

test('an id too short to compare is left alone rather than guessed at', () => {
  assert.equal(modelsAgree('m', 'MiMo-V2.6-Flash-RL-MXFP4'), true);
  assert.equal(modelsAgree('gpt-oss-120b-fable5', 'v2'), true);
});

test('the warning names both models and says nothing else will report it', () => {
  const warning = substitutionWarning('mimo-v26-flash', 'NVIDIA-Nemotron-3-Super-120B-A12B-Q8_0');
  assert.match(warning, /mimo-v26-flash/);
  assert.match(warning, /NVIDIA-Nemotron-3-Super-120B-A12B-Q8_0/);
  assert.match(warning, /nothing else will report this/);
});
