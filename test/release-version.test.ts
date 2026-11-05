import assert from 'node:assert/strict';
import test from 'node:test';
import { compareReleaseVersions, isReleaseIdentity, parseRollingVersion, rollingPackageVersion } from '../scripts/lib/release-version.mjs';

test('rolling identities are positive safe integers with one canonical spelling', () => {
  assert.equal(parseRollingVersion('v2'), 2);
  assert.equal(rollingPackageVersion('v2'), '2.0.0');
  for (const bad of ['v0', 'v01', 'v2.0.0', '2', ' v2', 'v2\n', 'v9007199254740992', null, 2]) {
    assert.equal(parseRollingVersion(bad), null);
    assert.equal(rollingPackageVersion(bad), null);
  }
  assert.equal(parseRollingVersion('v9007199254740991'), Number.MAX_SAFE_INTEGER);
});

test('rolling manifest metadata binds stable compatibility identity without rejecting legacy releases', () => {
  const stable = { version: '2.0.0', tag: 'v2.0.0', channel: 'stable' };
  assert.equal(isReleaseIdentity(stable), true);
  assert.equal(isReleaseIdentity({ ...stable, releaseVersion: 'v2' }), true);
  assert.equal(isReleaseIdentity({ version: '0.1.0-alpha.2', tag: 'v0.1.0-alpha.2', channel: 'alpha' }), true);
  for (const invalid of [
    null, {}, { ...stable, releaseVersion: 'v3' }, { ...stable, releaseVersion: null },
    { ...stable, releaseVersion: 'v2', tag: 'v2' }, { ...stable, channel: 'alpha' },
    { version: '2.0.0-alpha.1', tag: 'v2.0.0-alpha.1', channel: 'alpha', releaseVersion: 'v2' },
  ]) assert.equal(isReleaseIdentity(invalid), false);
  assert.ok(compareReleaseVersions(rollingPackageVersion('v2'), '1.0.0') > 0);
  assert.ok(compareReleaseVersions(rollingPackageVersion('v3'), rollingPackageVersion('v2')) > 0);
});
