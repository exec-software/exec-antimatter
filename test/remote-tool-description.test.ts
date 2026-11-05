import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRemoteTool } from '../src/main/remote/toolDescription';

test('remote tool descriptions identify command execution without forwarding shell text', () => {
  const described = describeRemoteTool('run_command', JSON.stringify({
    command: 'API_TOKEN=super-secret curl https://alice:hunter2@example.com/deploy?token=also-secret',
    cwd: '/workspace/app',
  }));
  const serialized = JSON.stringify(described);
  assert.equal(described.summary, 'Run command');
  assert.match(described.argumentsPreview, /\/workspace\/app/);
  assert.match(described.argumentsPreview, /command: \[\d+ characters withheld\]/);
  assert.doesNotMatch(serialized, /super-secret|hunter2|also-secret|alice/);
});

test('remote command descriptions fail closed for header, basic-auth, and positional secrets', () => {
  const commands = [
    "curl -H 'X-API-Key: x-api-secret' https://example.test/deploy",
    'curl -u admin:basic-secret https://example.test/deploy',
    'deploy production positional-secret',
  ];

  for (const command of commands) {
    const described = describeRemoteTool('coding_run_command', JSON.stringify({ command, cwd: '/workspace/app' }));
    const serialized = JSON.stringify(described);
    assert.equal(described.summary, 'Run command');
    assert.match(described.argumentsPreview, /command: \[\d+ characters withheld\]/);
    assert.doesNotMatch(serialized, /x-api-secret|basic-secret|positional-secret|admin/);
  }
});

test('remote tool descriptions expose a write target and size, never file contents', () => {
  const described = describeRemoteTool('write_file', JSON.stringify({
    path: 'src/main.ts',
    content: 'private source text that must not cross the host boundary',
    append: false,
  }));
  assert.equal(described.summary, 'Write src/main.ts');
  assert.match(described.approvalDetails, /content: \[57 characters withheld\]/);
  assert.doesNotMatch(JSON.stringify(described), /private source text/);
});

test('remote tool descriptions bound arbitrary unknown arguments', () => {
  const described = describeRemoteTool('plugin__dangerous_action', JSON.stringify({
    target: 'production',
    password: 'do-not-send',
    payload: 'x'.repeat(20_000),
    nested: { arbitrary: 'not serialized' },
  }));
  assert.ok(described.argumentsPreview.length <= 480);
  assert.ok(described.approvalDetails.length <= 960);
  assert.match(described.argumentsPreview, /target: production/);
  assert.match(described.argumentsPreview, /password: \[redacted\]/);
  assert.match(described.argumentsPreview, /payload: \[20000 characters withheld\]/);
  assert.doesNotMatch(JSON.stringify(described), /do-not-send|not serialized|x{20}/);
});

test('remote tool descriptions redact camelCase, PascalCase, acronym and separated credential keys', () => {
  const described = describeRemoteTool('plugin__authenticate', JSON.stringify({
    accessToken: 'access-value',
    refreshToken: 'refresh-value',
    clientSecret: 'client-value',
    APIKey: 'api-value',
    sshPrivateKey: 'private-value',
    'session-token': 'session-value',
    authorization: 'Bearer authorization-value',
    target: 'staging',
  }));
  const serialized = JSON.stringify(described);

  for (const key of ['accessToken', 'refreshToken', 'clientSecret', 'APIKey', 'sshPrivateKey', 'session-token', 'authorization']) {
    assert.match(described.argumentsPreview, new RegExp(`${key}: \\[redacted\\]`));
  }
  assert.match(described.argumentsPreview, /target: staging/);
  assert.doesNotMatch(
    serialized,
    /access-value|refresh-value|client-value|api-value|private-value|session-value|authorization-value/
  );
});
