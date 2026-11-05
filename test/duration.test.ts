import assert from 'node:assert/strict';
import test from 'node:test';
import { formatElapsedMilliseconds, formatElapsedSeconds } from '../renderer/src/lib/duration';
import { formatSeconds } from '../renderer/src/lib/telemetry';

test('elapsed duration moves from seconds to minutes and hours', () => {
  assert.equal(formatElapsedSeconds(59.9), '59s');
  assert.equal(formatElapsedSeconds(60), '1m');
  assert.equal(formatElapsedSeconds(72), '1m 12s');
  assert.equal(formatElapsedSeconds(3599), '59m 59s');
  assert.equal(formatElapsedSeconds(3600), '1h');
  assert.equal(formatElapsedSeconds(3840), '1h 4m');
  assert.equal(formatElapsedSeconds(436), '7m 16s');
});

test('elapsed duration clamps unusable input and accepts milliseconds', () => {
  assert.equal(formatElapsedSeconds(-12), '0s');
  assert.equal(formatElapsedSeconds(Number.NaN), '0s');
  assert.equal(formatElapsedSeconds(Number.POSITIVE_INFINITY), '0s');
  assert.equal(formatElapsedMilliseconds(72_999), '1m 12s');
});

test('telemetry keeps sub-minute precision and uses readable long durations', () => {
  assert.equal(formatSeconds(4.25), '4.3s');
  assert.equal(formatSeconds(436), '7m 16s');
  assert.equal(formatSeconds(3840), '1h 4m');
});
