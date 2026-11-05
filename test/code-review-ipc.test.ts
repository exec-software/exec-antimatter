import assert from 'node:assert/strict';
import test from 'node:test';
import { registerCodeReviewIpc } from '../src/main/codeReview/ipc';

function fixture() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const calls: unknown[][] = [];
  const store = Object.fromEntries(['list', 'read', 'create', 'mutate'].map((name) => [name, (...args: unknown[]) => { calls.push([name, ...args]); return 'ok'; }]));
  registerCodeReviewIpc({ handle: ((name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler)) as any }, {
    store: store as any,
    requireSender: (event) => { if (!(event as any).main) throw new Error('Not the main frame'); },
    author: () => ({ kind: 'human', label: 'Reviewer' }),
  });
  return { handlers, calls };
}

test('review IPC authorizes every operation before accessing private snapshots', () => {
  const { handlers, calls } = fixture();
  assert.equal(handlers.size, 4);
  for (const handler of handlers.values()) assert.throws(() => handler({}, '/project', 'review', 1, {}), /main frame/);
  assert.deepEqual(calls, []);
});

test('human review actions use host attribution, never caller identity', () => {
  const { handlers, calls } = fixture();
  const input = { title: 'Review', scope: { kind: 'changes' }, author: { kind: 'agent', label: 'Forged' } };
  handlers.get('code-review:create')!({ main: true }, '/project', input);
  handlers.get('code-review:mutate')!({ main: true }, '/project', 'review', 7, { kind: 'decision', decision: 'approved' });
  assert.deepEqual(calls[0].at(-1), { kind: 'human', label: 'Reviewer' });
  assert.deepEqual(calls[1].at(-1), { kind: 'human', label: 'Reviewer' });
  assert.equal(calls[1][3], 7, 'passes expected revision without replacing it with current state');
});
