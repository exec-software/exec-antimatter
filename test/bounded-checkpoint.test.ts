import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoundedCheckpoint, type CheckpointClock } from '../renderer/src/lib/boundedCheckpoint';

class FakeClock implements CheckpointClock<number> {
  private current = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  now = () => this.current;

  set = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.current + delayMs, callback });
    return id;
  };

  clear = (timer: number) => {
    this.tasks.delete(timer);
  };

  advance(milliseconds: number): void {
    const target = this.current + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.current = task.at;
      task.callback();
    }
    this.current = target;
  }
}

test('continuous updates checkpoint at the maximum wait instead of postponing forever', () => {
  const clock = new FakeClock();
  let latest = 0;
  const saved: number[] = [];
  const checkpoint = createBoundedCheckpoint(
    () => saved.push(latest),
    { quietMs: 400, maxWaitMs: 1_200 },
    clock
  );

  latest = 1;
  checkpoint.schedule();
  for (const value of [2, 3, 4]) {
    clock.advance(300);
    latest = value;
    checkpoint.schedule();
  }

  clock.advance(299);
  assert.deepEqual(saved, []);
  clock.advance(1);
  assert.deepEqual(saved, [4]);
});

test('quiet changes remain coalesced into one trailing checkpoint', () => {
  const clock = new FakeClock();
  let latest = 'first';
  const saved: string[] = [];
  const checkpoint = createBoundedCheckpoint(
    () => saved.push(latest),
    { quietMs: 400, maxWaitMs: 1_500 },
    clock
  );

  checkpoint.schedule();
  clock.advance(250);
  latest = 'latest';
  checkpoint.schedule();
  clock.advance(399);
  assert.deepEqual(saved, []);
  clock.advance(1);
  assert.deepEqual(saved, ['latest']);
  clock.advance(2_000);
  assert.deepEqual(saved, ['latest']);
});

test('flush writes the latest pending snapshot once and cancels its timer', () => {
  const clock = new FakeClock();
  let writes = 0;
  const checkpoint = createBoundedCheckpoint(
    () => {
      writes += 1;
    },
    { quietMs: 400, maxWaitMs: 1_500 },
    clock
  );

  checkpoint.schedule();
  clock.advance(100);
  checkpoint.flush();
  assert.equal(writes, 1);
  clock.advance(2_000);
  assert.equal(writes, 1);

  checkpoint.flush(true);
  assert.equal(writes, 2);
});
