import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_AUTO_CONTINUE,
  MAX_CONTINUES_CEILING,
  normalizeAutoContinue,
  shouldAutoContinue,
  stoppedMidWork,
  type AutoContinueSettings,
} from '../src/main/autoContinue';

const on: AutoContinueSettings = { enabled: true, maxContinues: 3, onRoundLimit: true };
const working = { used: 0, executedToolCalls: 4 };

test('a reply that ends on the step it is about to take reads as stopped, not finished', () => {
  for (const text of [
    'Wired the processor up.\n\nNow let me create the controller:',
    "I'll now add the parameter definitions.",
    'Next, I will run the build.',
    'Continuing with the MIDI export:',
    'Reading the header.\n\nLet me check what the SDK actually exposes',
  ]) {
    assert.equal(stoppedMidWork(text), true, text);
  }
});

test('a reply that reports finished work is left alone', () => {
  for (const text of [
    'Done. The plugin builds and loads in the DAW.',
    '## Complete\n\n- Audio analysis\n- MIDI export\n\nRun `make` to build it.',
    'Let me know if you want the pattern generator tuned differently.',
    "I'll let you know how the build goes.",
    'Tell me which drum kit you want and I will map it.',
    // The same words, but as an account of something already done rather than a closing line.
    "Let me check the header, I said — and it turned out to define the ids.\n\nThat is everything.",
  ]) {
    assert.equal(stoppedMidWork(text), false, text);
  }
});

test('an unclosed code fence or an empty reply is a turn cut short', () => {
  assert.equal(stoppedMidWork('Here is the processor:\n\n```cpp\nvoid process() {'), true);
  assert.equal(stoppedMidWork('   '), true);
  assert.equal(stoppedMidWork('Here it is:\n\n```cpp\nvoid process() {}\n```'), false);
});

test('a turn that never used a tool was never mid-work', () => {
  assert.equal(
    shouldAutoContinue(on, {
      reason: 'stopped-mid-work',
      used: 0,
      executedToolCalls: 0,
      content: 'Now let me explain:',
    }),
    false
  );
});

test('the allowance bounds one turn and is off by default', () => {
  const nudge = { reason: 'stopped-mid-work' as const, ...working, content: 'Now let me build it:' };
  assert.equal(shouldAutoContinue(DEFAULT_AUTO_CONTINUE, nudge), false);
  assert.equal(shouldAutoContinue(on, nudge), true);
  assert.equal(shouldAutoContinue(on, { ...nudge, used: 3 }), false);
  assert.equal(shouldAutoContinue({ ...on, maxContinues: 0 }, nudge), false);
});

test('the round ceiling is carried on only when that is asked for, whatever the reply said', () => {
  const ceiling = { reason: 'round-limit' as const, ...working, content: 'Done for now.' };
  assert.equal(shouldAutoContinue(on, ceiling), true);
  assert.equal(shouldAutoContinue({ ...on, onRoundLimit: false }, ceiling), false);
});

test('a stored or remote value cannot turn one turn into an unbounded series', () => {
  assert.deepEqual(normalizeAutoContinue({ enabled: true, maxContinues: 5_000, onRoundLimit: false }), {
    enabled: true,
    maxContinues: MAX_CONTINUES_CEILING,
    onRoundLimit: false,
  });
  assert.deepEqual(normalizeAutoContinue({ enabled: 'yes', maxContinues: -4 }), {
    enabled: false,
    maxContinues: 0,
    onRoundLimit: true,
  });
  assert.deepEqual(normalizeAutoContinue(null), DEFAULT_AUTO_CONTINUE);
});
