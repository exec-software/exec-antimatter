import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MachineWidePanel } from '../renderer/src/components/developer/MachineWidePanel';

/**
 * The switch that lets a command change the machine without being asked.
 *
 * What a worse version of this control would get wrong is telling you it is on when it is not,
 * or being impossible to turn off. Both matter more here than on an ordinary setting, because
 * what it governs — a root command, a system package install — is not undone by an edit, and
 * someone checking whether they left it on reads this checkbox and nothing else.
 */
const render = (value: { withoutAsking: boolean }, disabled = false) =>
  renderToStaticMarkup(createElement(MachineWidePanel, { value, onChange: () => {}, disabled }));

test('the control shows the stored answer rather than a default', () => {
  assert.match(render({ withoutAsking: true }), /checked=""/);
  assert.doesNotMatch(render({ withoutAsking: false }), /checked=""/);
});

test('the control says what it gives up, and that the other questions remain', () => {
  const markup = render({ withoutAsking: false });
  // Full access is the only mode it touches: someone reading this must not conclude that
  // "Ask first" has quietly stopped asking.
  assert.match(markup, /Under Full access only/);
  // Named, because the person deciding needs to know which calls stop being shown to them.
  assert.match(markup, /root/);
  assert.match(markup, /package/);
  // The reason it is worth a decision at all: outside the project, nothing undoes it.
  assert.match(markup, /outside a virtual environment/);
  assert.match(markup, /every program you run/);
  // And the standing answers it does not give: the screen, and an image leaving the machine.
  assert.match(markup, /screen captures/);
  assert.match(markup, /vision source/);
});

test('a control that cannot be changed yet is disabled rather than lying', () => {
  // Before main has answered — or against a main process that has no such setting — the
  // checkbox must not accept a click it cannot store. MachineWideSection names that case in
  // words beside it; what is checked here is that nothing is clickable in the meantime.
  assert.match(render({ withoutAsking: false }, true), /disabled=""/);
  assert.doesNotMatch(render({ withoutAsking: false }, false), /disabled=""/);
});
