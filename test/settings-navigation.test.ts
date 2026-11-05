import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingSource, SETTINGS_SECTIONS } from '../renderer/src/components/settings/navigation';

test('settings groups have stable unique routes and human-facing labels', () => {
  assert.deepEqual(SETTINGS_SECTIONS.map((section) => section.id), ['general', 'models', 'voice', 'devices', 'vault', 'application', 'experimental']);
  assert.equal(new Set(SETTINGS_SECTIONS.map((section) => section.label)).size, SETTINGS_SECTIONS.length);
  assert.ok(SETTINGS_SECTIONS.every((section) => section.description.length > 0));
});

test('existing source endpoints ignore trailing slashes and URL-normalized default ports', () => {
  const sources = [{ id: 'local', baseUrl: 'http://127.0.0.1:6768/v1/' }, { id: 'cloud', baseUrl: 'https://api.example.test:443/v1' }];
  assert.equal(matchingSource(sources, 'http://127.0.0.1:6768/v1')?.id, 'local');
  assert.equal(matchingSource(sources, 'https://api.example.test/v1/')?.id, 'cloud');
});

test('different source hosts, paths, ports, transport, and queries are not deduplicated', () => {
  const sources = [{ baseUrl: 'http://127.0.0.1:6768/v1' }];
  for (const endpoint of ['http://localhost:6768/v1', 'http://127.0.0.1:6767/v1', 'https://127.0.0.1:6768/v1', 'http://127.0.0.1:6768/v2', 'http://127.0.0.1:6768/v1?mode=test']) {
    assert.equal(matchingSource(sources, endpoint), undefined, endpoint);
  }
});
