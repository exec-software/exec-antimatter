import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_GUARDRAILS,
  MAX_GUARDRAIL_LIMIT,
  normalizeGuardrails,
  resolveGuardrails,
} from '../src/main/guardrails';

test('an absent or unreadable stored value is the shipped behaviour', () => {
  for (const stored of [undefined, null, 'off', 42, []]) {
    assert.deepEqual(normalizeGuardrails(stored), DEFAULT_GUARDRAILS, `${JSON.stringify(stored)} should fall back`);
  }
});

test('a rail is on unless the stored value says otherwise', () => {
  // `enabled !== false`, so a half-written entry reads as on. The rails are the safe default and
  // a file someone edited by hand must not turn one off by omission.
  const rails = normalizeGuardrails({ repeatedCalls: { limit: 7 }, duplicateReads: {} });
  assert.equal(rails.repeatedCalls.enabled, true);
  assert.equal(rails.repeatedCalls.limit, 7);
  assert.equal(rails.duplicateReads.enabled, true);
});

test('a limit below one, or not a number, keeps its default rather than disabling the rail', () => {
  // Zero and negatives are the shapes that would silently make a threshold unreachable while the
  // page still showed the rail as on. Saying off is the switch's job.
  for (const limit of [0, -3, 0.5, Number.NaN, 'three', null]) {
    const rails = normalizeGuardrails({ repeatedCalls: { enabled: true, limit } });
    assert.equal(rails.repeatedCalls.limit, DEFAULT_GUARDRAILS.repeatedCalls.limit, `limit ${String(limit)}`);
    assert.equal(rails.repeatedCalls.enabled, true);
  }
  assert.equal(normalizeGuardrails({ turnBudget: { enabled: true, limit: 12.9 } }).turnBudget.limit, 12);
});

test('a limit past the ceiling is clamped, so an edited file cannot pose as a rail', () => {
  const rails = normalizeGuardrails({ turnBudget: { enabled: true, limit: 10_000_000 } });
  assert.equal(rails.turnBudget.limit, MAX_GUARDRAIL_LIMIT);
});

test('a disabled stop condition resolves to a threshold nothing reaches', () => {
  const rails = resolveGuardrails(normalizeGuardrails({
    turnBudget: { enabled: false, limit: 2048 },
    repeatedCalls: { enabled: false, limit: 3 },
    batchOverrun: { enabled: false, limit: 3 },
  }));
  assert.equal(rails.callBudget, Number.POSITIVE_INFINITY);
  assert.equal(rails.repeatedCalls, Number.POSITIVE_INFINITY);
  assert.equal(rails.batchOverrun, Number.POSITIVE_INFINITY);
  // And the bookkeeping behind the repeat detector stops with it: an unreachable threshold would
  // still grow its window for the whole turn to feed a comparison that can never be true.
  assert.equal(rails.trackRepeats, false);
});

test('a disabled retry resolves to no attempts rather than endless ones', () => {
  // Read as a threshold, `enabled: false` on a retry would mean infinite retries — the opposite
  // of what the switch says. Retries count attempts, so off is zero.
  const rails = resolveGuardrails(normalizeGuardrails({
    thinkingRetries: { enabled: false, limit: 2 },
    thinkingOnlyRetries: { enabled: false, limit: 2 },
  }));
  assert.equal(rails.thinkingRetries, 0);
  assert.equal(rails.thinkingOnlyRetries, 0);
});

test('no argument resolves to the shipped behaviour, which is what every caller had before', () => {
  assert.deepEqual(resolveGuardrails(), resolveGuardrails(DEFAULT_GUARDRAILS));
  assert.deepEqual(resolveGuardrails(null), resolveGuardrails(DEFAULT_GUARDRAILS));
  const shipped = resolveGuardrails();
  assert.equal(shipped.callBudget, 2048);
  assert.equal(shipped.repeatedCalls, 3);
  assert.equal(shipped.thinkingRetries, 2);
  assert.equal(shipped.duplicateReads, true);
});
