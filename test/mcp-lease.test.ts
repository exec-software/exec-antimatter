import assert from 'node:assert/strict';
import test from 'node:test';

import { withMcpControl } from '../src/main/mcpLease';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a cancelled MCP lease waiter exits promptly without passing the active owner', async () => {
  let releaseFirst!: () => void;
  const first = withMcpControl(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      })
  );
  await flush();

  let cancelledRan = false;
  const controller = new AbortController();
  const cancelled = withMcpControl(async () => {
    cancelledRan = true;
  }, controller.signal);
  let thirdRan = false;
  const third = withMcpControl(async () => {
    thirdRan = true;
  });

  controller.abort();
  await assert.rejects(cancelled, /cancelled while waiting for tool access/);
  await flush();
  assert.equal(cancelledRan, false);
  assert.equal(thirdRan, false);

  releaseFirst();
  await Promise.all([first, third]);
  assert.equal(thirdRan, true);
});
