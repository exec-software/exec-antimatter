import assert from 'node:assert/strict';
import test from 'node:test';
import { matchingShell, terminalLabel, terminalTail } from '../renderer/src/plugins/terminal/replay';
import type { TerminalSessionInfo } from '../renderer/src/types';

const entry = (id: string, patch: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo => ({ id, shell: '/bin/bash', cwd: '/work', cols: 80, rows: 24, startedAt: 1, exit: null, ...patch });

test('manual adoption selects only a live manual shell in the requested directory', () => {
  const entries = [entry('command', { kind: 'command', startedAt: 9 }), entry('other', { cwd: '/other' }), entry('exited', { exit: { code: 0 } }), entry('shell'), entry('newer', { startedAt: 5 })];
  assert.equal(matchingShell(entries, '/work')?.id, 'newer');
  assert.equal(matchingShell(entries, '/missing'), undefined);
  assert.equal(matchingShell(entries, null), undefined);
});

test('history replay discards duplicate chunks and retains only bytes beyond the snapshot', () => {
  assert.deepEqual(terminalTail({ data: 'already replayed', offset: 15 }, 20), { data: '', offset: 20 });
  assert.deepEqual(terminalTail({ data: 'abcdef', offset: 24 }, 20), { data: 'cdef', offset: 24 });
  assert.deepEqual(terminalTail({ data: 'next', offset: 28 }, 24), { data: 'next', offset: 28 });
});

test('terminal offsets agree with UTF-16 and tolerate legacy unsequenced events', () => {
  assert.deepEqual(terminalTail({ data: '🙂ok', offset: 9 }, 7), { data: 'ok', offset: 9 });
  assert.deepEqual(terminalTail({ data: 'live' }, 9), { data: 'live', offset: 13 });
});

test('session labels distinguish commands from shells and retain exited commands', () => {
  assert.match(terminalLabel(entry('command', { kind: 'command', command: 'sudo\n example', exit: { code: 2 } })), /^Command · sudo example · exited 2$/);
  assert.equal(terminalLabel(entry('shell')), 'Shell · /work');
});
