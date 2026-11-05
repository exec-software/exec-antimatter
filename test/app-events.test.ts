import assert from 'node:assert/strict';
import test from 'node:test';
import { AppEventBus } from '../src/main/appEvents';

test('app event listeners are isolated and can unsubscribe', () => {
  const bus = new AppEventBus();
  const seen: string[] = [];
  bus.subscribe(() => {
    throw new Error('broken adapter');
  });
  const unsubscribe = bus.subscribe(({ channel }) => seen.push(channel));

  bus.publish('turn.delta', { content: 'hello' });
  unsubscribe();
  bus.publish('turn.finished', {});

  assert.deepEqual(seen, ['turn.delta']);
  assert.equal(bus.listenerCount(), 1);
});
