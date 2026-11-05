import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedExternalUrl } from '../src/main/externalLinks';

test('external links permit only web and email protocols', () => {
  for (const url of [
    'https://example.test/docs',
    'http://127.0.0.1:6768/v1/models',
    'mailto:hello@example.test',
    'HTTPS://EXAMPLE.TEST',
  ]) {
    assert.equal(isAllowedExternalUrl(url), true, url);
  }

  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hello',
    'ssh://example.test',
    'vscode://file/tmp/project',
    '/relative/path',
    'not a URL',
  ]) {
    assert.equal(isAllowedExternalUrl(url), false, url);
  }
});
