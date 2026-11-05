import assert from 'node:assert/strict';
import test from 'node:test';
import { createAboutInfo } from '../src/api/about';

test('About information comes from the packaged application and the running runtime', () => {
  assert.deepEqual(
    createAboutInfo(
      { name: 'fallback-name', desktopName: 'Antimatter', description: 'Multi-model assistant', version: '1.2.3' },
      { versions: { electron: '44.3.0', chrome: '142.0', node: '22.12.0' }, platform: 'linux', architecture: 'x64' },
      new Date('2031-06-14T12:00:00Z')
    ),
    {
      name: 'Antimatter',
      description: 'Multi-model assistant',
      version: '1.2.3',
      copyrightYear: 2031,
      electron: '44.3.0',
      chrome: '142.0',
      node: '22.12.0',
      platform: 'linux',
      architecture: 'x64',
    }
  );
});

test('About information has safe fallbacks for optional package and runtime fields', () => {
  const info = createAboutInfo(
    { name: 'antimatter', version: '0.1.0-alpha.1' },
    { versions: {}, platform: 'linux', architecture: 'arm64' },
    new Date('2026-01-01T00:00:00Z')
  );
  assert.equal(info.name, 'antimatter');
  assert.equal(info.description, '');
  assert.equal(info.electron, 'unknown');
  assert.equal(info.chrome, 'unknown');
  assert.equal(info.node, 'unknown');
});
