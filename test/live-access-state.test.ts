import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveAccess } from '../src/main/liveAccess';

test('permission changes wake only listeners for the named live run', () => {
  const access = new LiveAccess();
  access.begin('one', 'ask'); access.begin('two', 'read');
  const seen: string[] = [];
  access.subscribe('one', () => seen.push(`one:${access.get('one')}`));
  access.subscribe('two', () => seen.push(`two:${access.get('two')}`));
  assert.equal(access.update('one', 'full'), true);
  assert.deepEqual(seen, ['one:full']);
  assert.equal(access.get('two'), 'read');
  access.update('one', 'full');
  assert.deepEqual(seen, ['one:full'], 'unchanged mode must not churn approvals');
  access.update('one', 'read');
  assert.deepEqual(seen, ['one:full', 'one:read']);
});

test('permission subscriptions detach and cannot leak into a later run', () => {
  const access = new LiveAccess(); let calls = 0;
  access.begin('run', 'ask');
  const remove = access.subscribe('run', () => calls++);
  remove(); access.update('run', 'full'); assert.equal(calls, 0);
  access.subscribe('run', () => calls++);
  assert.throws(() => access.begin('run', 'read'), /already initialized/);
  access.end('run'); assert.equal(access.update('run', 'full'), false);
  assert.equal(access.get('run'), undefined);
  access.begin('run', 'ask'); access.update('run', 'full'); assert.equal(calls, 0);
  const absent = access.subscribe('missing', () => calls++);
  access.begin('missing', 'ask'); access.update('missing', 'full'); absent(); assert.equal(calls, 0);
});

test('a failed subscriber cannot reject an applied change or strand another gate', () => {
  const errors: unknown[] = [];
  const access = new LiveAccess((error) => errors.push(error));
  access.begin('run', 'ask');
  access.subscribe('run', () => { throw new Error('broken observer'); });
  let notified = false;
  access.subscribe('run', () => { notified = true; });
  assert.equal(access.update('run', 'full'), true);
  assert.equal(access.get('run'), 'full');
  assert.equal(notified, true);
  assert.equal(errors.length, 1);
});
