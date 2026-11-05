import assert from 'node:assert/strict';
import test from 'node:test';
import { revealToolWindow } from '../renderer/src/plugins/layout';

/**
 * A layout that records what was asked of it.
 *
 * `float` is spied on deliberately even though `revealToolWindow` cannot see it through its
 * parameter type: floating a docked console on every command is the behaviour these tests exist to
 * keep out, so the assertion is worth making against the object that would receive the call.
 */
const stub = (open: boolean) => {
  const calls: string[] = [];
  const layout = {
    isOpen: () => open,
    toggle: (id: string) => void calls.push(`toggle:${id}`),
    focus: (id: string) => void calls.push(`focus:${id}`),
    float: (id: string) => void calls.push(`float:${id}`),
  };
  return { calls, layout };
};

test('a console already showing is raised where it is, not moved', () => {
  // True for a docked console and for a floating one alike, which is the point: a command a model
  // runs reveals the console without deciding where the console should live.
  const { calls, layout } = stub(true);
  revealToolWindow(layout, 'terminal.shell');
  assert.deepEqual(calls, ['focus:terminal.shell']);
});

test('a console that was put away comes back at its own anchor', () => {
  const { calls, layout } = stub(false);
  revealToolWindow(layout, 'terminal.shell');
  // `toggle` re-opens it at the anchor its definition names. Nothing here floats it, so a console
  // that was docked before it was minimised comes back docked.
  assert.deepEqual(calls, ['toggle:terminal.shell']);
});

test('nothing is ever floated on the way to showing it', () => {
  for (const open of [true, false]) {
    const { calls, layout } = stub(open);
    revealToolWindow(layout, 'terminal.shell');
    assert.equal(
      calls.some((call) => call.startsWith('float:')),
      false
    );
  }
});
