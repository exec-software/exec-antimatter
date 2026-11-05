import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { externalTerminalEnvironment, terminalDirectory, terminalLaunches } from '../src/main/externalTerminal';
import { canAcceptSuggestion, followUpSuggestion } from '../renderer/src/lib/followUpSuggestion';

test('terminal paths are argv data, never executable shell expressions', () => {
  const cwd = '/project/a; echo danger $(whoami)';
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const plans = terminalLaunches(platform, cwd);
    assert.ok(plans.length);
    for (const plan of plans) {
      assert.ok(!plan.args.includes('-c'));
      assert.ok(!plan.args.includes('/c'));
      assert.ok(plan.args.every((arg) => !arg.includes(cwd) || arg === cwd));
    }
  }
});

test('terminal requires a real directory and rejects control characters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antimatter-terminal-'));
  try {
    assert.equal(terminalDirectory(dir), dir);
    writeFileSync(join(dir, 'file'), '');
    assert.throws(() => terminalDirectory(join(dir, 'file')));
    for (const input of [null, '.', '--option', '/tmp/\ncommand', join(dir, 'missing')]) assert.throws(() => terminalDirectory(input));
    mkdirSync(join(dir, 'hidden\ncontrol'));
    symlinkSync(join(dir, 'hidden\ncontrol'), join(dir, 'ordinary-name'));
    assert.throws(() => terminalDirectory(join(dir, 'ordinary-name')), /control characters/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('an external terminal keeps the user session but not Electron or launcher control variables', () => {
  assert.deepEqual(externalTerminalEnvironment({ PATH: '/usr/bin', SSH_AUTH_SOCK: '/agent', DISPLAY: ':0',
    ELECTRON_RUN_AS_NODE: '1', ELECTRON_OVERRIDE_DIST_PATH: '/electron', CODEX_HOST_CONTROL: 'private', CODEX_HOME: '/host' }),
  { PATH: '/usr/bin', SSH_AUTH_SOCK: '/agent', DISPLAY: ':0' });
});

test('follow-up is offered only after a completed assistant response', () => {
  const message = { id: 'answer', role: 'assistant' as const, content: 'The answer.' };
  assert.equal(followUpSuggestion([message], false)?.text, 'Explain that in more detail.');
  assert.equal(followUpSuggestion([message], true), null);
  assert.equal(followUpSuggestion([{ ...message, meta: { failed: true, createdAt: 0 } }], false), null);
  assert.equal(followUpSuggestion([{ ...message, role: 'user' }], false), null);
});

test('accepting a suggestion never overwrites text or an attachment', () => {
  const suggestion = { messageId: 'answer', text: 'Explain that in more detail.' };
  assert.ok(canAcceptSuggestion({ text: '', attachments: [] }, suggestion, false));
  assert.ok(!canAcceptSuggestion({ text: ' ', attachments: [] }, suggestion, false));
  assert.ok(!canAcceptSuggestion({ text: '', attachments: [{ id: 'a', name: 'a', size: 0, content: '' }] }, suggestion, false));
  assert.ok(!canAcceptSuggestion({ text: '', attachments: [] }, suggestion, true));
});
