import assert from 'node:assert/strict';
import test from 'node:test';
import { displayReleaseVersion } from '../src/api/releaseVersion';
import { createAboutInfo } from '../src/api/about';

test('Execute release labels hide compatibility padding without changing legacy identities', () => {
  assert.equal(displayReleaseVersion('2.0.0'), 'v2');
  assert.equal(displayReleaseVersion('12.0.0'), 'v12');
  for (const version of ['1.0.0', '0.1.0-alpha.2', '2.1.0', 'v2']) {
    assert.equal(displayReleaseVersion(version), version);
  }
  assert.equal(displayReleaseVersion(null), '');
});

test('About exposes public and compatibility release identities separately', () => {
  const info = createAboutInfo(
    { name: 'Antimatter', version: '2.0.0', releaseVersion: 'v2' },
    { versions: {}, platform: 'linux', architecture: 'x64' },
  );
  assert.equal(info.version, '2.0.0');
  assert.equal(info.releaseVersion, 'v2');
});
