import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedUnattended, decide, denialReason, isTrustedTool, tierOf } from '../src/main/toolPolicy';

const VAULT = 'antimatter.vault';

/**
 * How the Vault's two tools are permitted.
 *
 * The asymmetry is the point and is easy to lose in a later edit: the catalogue holds no secrets
 * and may be read in any mode, while spending a credential is a decision no permission level can
 * make in advance.
 */
test('reading the Vault catalogue is a read, in every access mode', () => {
  assert.equal(tierOf('vault_list', VAULT), 'read');
  for (const mode of ['read', 'ask', 'full'] as const) {
    assert.equal(decide('vault_list', { mode, serverId: VAULT }), 'allow', mode);
  }
  // Without the catalogue a model asks the person for a credential in chat, which is the exact
  // thing the Vault exists to stop.
  assert.equal(decide('vault_list', { mode: 'read', serverId: VAULT, workspaceConfirmed: false }), 'allow');
});

test('spending a credential always asks, including under Full access', () => {
  for (const mode of ['read', 'ask', 'full'] as const) {
    assert.equal(decide('vault_use', { mode, serverId: VAULT }), 'ask', mode);
  }
  // A credential is not a file in the project, so an unnominated working directory neither
  // permits it nor stands in the way of asking about it.
  assert.equal(decide('vault_use', { mode: 'full', serverId: VAULT, workspaceConfirmed: false }), 'ask');
  assert.notEqual(tierOf('vault_use', VAULT), 'read');
});

test('an unattended run gets no Vault at all, catalogue included', () => {
  // There is nobody to approve a use, and a catalogue it cannot act on is only a prompt to try.
  assert.equal(allowedUnattended('vault_list', VAULT), false);
  assert.equal(allowedUnattended('vault_use', VAULT), false);
});

test('only the app’s own runtime may serve these names', () => {
  assert.equal(isTrustedTool('vault_use', VAULT), true);
  assert.equal(isTrustedTool('vault_use', 'antimatter'), false);
  for (const server of ['antimatter', 'plugin.something', 'beholder.security']) {
    assert.equal(decide('vault_use', { mode: 'full', serverId: server }), 'deny', server);
    assert.equal(decide('vault_list', { mode: 'full', serverId: server }), 'deny', server);
  }
  assert.match(denialReason('vault_use'), /keyring/);
  assert.match(denialReason('vault_use'), /Nothing was unsealed/);
});
