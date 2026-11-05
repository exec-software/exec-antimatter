import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isVaultActivity, VaultActivityCard } from '../renderer/src/components/chat/VaultActivityCard';
import { VaultPanel } from '../renderer/src/components/settings/VaultPanel';
import { toolActivitySummary } from '../renderer/src/lib/transcript';
import type { ToolActivity } from '../renderer/src/types';

const activity = (over: Partial<ToolActivity> = {}): ToolActivity => ({
  callId: 'call-1',
  requestId: 'run-1',
  serverId: 'antimatter.vault',
  serverName: 'Vault',
  toolName: 'vault_use',
  tier: 'danger',
  args: JSON.stringify({ tag: 'sudo', purpose: 'install the build dependencies' }),
  status: 'pending',
  ...over,
});

const render = (over: Partial<ToolActivity> = {}, isActive = true) =>
  renderToStaticMarkup(createElement(VaultActivityCard, { activity: activity(over), isActive }));

test('only the app’s own Vault server gets the Vault card', () => {
  assert.equal(isVaultActivity(activity()), true);
  // A plugin advertising a familiar name must not borrow the card that asserts the guarantee.
  assert.equal(isVaultActivity(activity({ serverId: 'plugin.lookalike' })), false);
  assert.equal(isVaultActivity(activity({ serverId: 'antimatter', toolName: 'run_command' })), false);
});

test('a pending approval names the credential, the reason, and the guarantee', () => {
  const markup = render({ awaitingApproval: true });
  assert.match(markup, /Vault/);
  assert.match(markup, /sudo/);
  assert.match(markup, /install the build dependencies/, 'the stated purpose is shown in full, not truncated away');
  assert.match(markup, /not shown here, not sent to the model/);
  assert.match(markup, /Your approval needed/);
  assert.match(markup, />Use sudo once</);
  assert.match(markup, />Decline</);
  // There is no such control, and its absence is the feature.
  assert.doesNotMatch(markup, /show value|reveal/i);
});

test('a finished use reports the variable and never the value', () => {
  const markup = render({
    status: 'done',
    result: 'The user approved using "sudo" (This box).\nIts value is now set as $ANTIMATTER_VAULT_SUDO for run_command calls in this turn.',
  });
  assert.match(markup, /Credential used/);
  assert.match(markup, /ANTIMATTER_VAULT_SUDO/);
  assert.match(markup, /What the model was told/);
  assert.doesNotMatch(markup, />Use sudo once</, 'an answered call offers no buttons');
});

test('the card shows nothing a secret could hide in', () => {
  // The transcript's own copy of a Vault call: arguments carry a tag and a sentence, nothing more.
  const markup = render({ status: 'done', result: 'approved' });
  assert.doesNotMatch(markup, /type="password"/);
  assert.doesNotMatch(markup, /hunter2/);
  // The ordinary card prints raw arguments; this one never does, because a Vault call's arguments
  // are not where the interesting information is and a dump invites pasting secrets into them.
  assert.doesNotMatch(markup, /Arguments/);
});

test('a turn that died while waiting says so rather than offering a dead prompt', () => {
  const markup = render({ awaitingApproval: true }, false);
  assert.match(markup, /Interrupted/);
  assert.match(markup, /Nothing was unsealed/);
  assert.doesNotMatch(markup, />Use sudo once</);
});

test('listing the Vault reads as a look, not a use', () => {
  const markup = renderToStaticMarkup(createElement(VaultActivityCard, {
    activity: activity({ toolName: 'vault_list', args: '{}', status: 'done', result: '1 credential in the Vault.' }),
    isActive: true,
  }));
  assert.match(markup, /Looked at which credentials you keep/);
  assert.match(markup, /No secret was read or sent/);
  assert.match(markup, /Listed/);
});

test('the transcript summary names the credential without the reason', () => {
  assert.equal(toolActivitySummary(activity()), 'Use the sudo credential');
  assert.equal(toolActivitySummary(activity({ args: '{}' })), 'Use a Vault credential');
  assert.equal(toolActivitySummary(activity({ toolName: 'vault_list', args: '{}' })), 'List Vault credentials');
});

test('the Vault settings page renders and asks for nothing before it has read the store', () => {
  // The status arrives from an effect, so this is the first paint: it must not claim the Vault is
  // off, and it must not put a secret field on screen before anyone asked to add one.
  const markup = renderToStaticMarkup(createElement(VaultPanel));
  assert.match(markup, /Reading the Vault/);
  assert.doesNotMatch(markup, /type="password"/);
});
