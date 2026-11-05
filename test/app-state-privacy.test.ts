import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as agents from '../src/main/agents/registry';
import * as modelProfiles from '../src/main/modelProfiles';

const permissions = (path: string): number => statSync(path).mode & 0o777;

// sourceStore and mcpStore import Electron only to locate userData (and, for sourceStore, use
// safeStorage). The Node test runner does not boot Electron, so install the narrow API surface
// these stores need before loading them.
const userData = { path: '' };
let encryptionAvailable = false;
let decryptionFails = false;
let selectedStorageBackend = 'unknown';
const electron = {
  app: {
    getPath: (name: string) => {
      assert.equal(name, 'userData');
      return userData.path;
    },
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    getSelectedStorageBackend: () => selectedStorageBackend,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => {
      if (decryptionFails) throw new Error('temporary keyring failure');
      return value.toString('utf8');
    },
  },
};
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const nodeModule = require('node:module') as { _load: ModuleLoader };
const originalLoad = nodeModule._load;
nodeModule._load = function load(request, parent, isMain) {
  return request === 'electron' ? electron : originalLoad.call(this, request, parent, isMain);
};
const sourceStore = require('../src/main/sourceStore') as typeof import('../src/main/sourceStore');
const mcpStore = require('../src/main/mcpStore') as typeof import('../src/main/mcpStore');
nodeModule._load = originalLoad;

test('profile and agent stores migrate legacy state and keep new writes private', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'antimatter-private-app-stores-'));
  const previousProfiles = modelProfiles.storeLocation();
  const previousAgents = agents.location();
  t.after(() => {
    modelProfiles.useConfigPath(previousProfiles);
    agents.useRoot(previousAgents);
    rmSync(base, { recursive: true, force: true });
  });

  const profileRoot = join(base, 'profiles');
  const profileFile = join(profileRoot, 'model-profiles.json');
  mkdirSync(profileRoot, { mode: 0o755 });
  writeFileSync(profileFile, JSON.stringify({ version: 1, overrides: {} }), { mode: 0o644 });
  chmodSync(profileRoot, 0o755);
  chmodSync(profileFile, 0o644);
  modelProfiles.useConfigPath(profileFile);
  assert.deepEqual(modelProfiles.overrides(), {});
  assert.equal(permissions(profileRoot), 0o700);
  assert.equal(permissions(profileFile), 0o600);

  modelProfiles.setOverride('local', 'coder', {
    contextTokens: 32_768,
    instructions: 'Prefer small, reviewable patches.',
  });
  assert.equal(
    modelProfiles.resolve({ providerId: 'local', modelId: 'coder' }).instructions,
    'Prefer small, reviewable patches.'
  );
  assert.equal(permissions(profileFile), 0o600);

  const agentRoot = join(base, 'agents');
  const existingAgent = join(agentRoot, 'existing.yaml');
  const marker = join(agentRoot, '.seeded');
  mkdirSync(agentRoot, { mode: 0o755 });
  writeFileSync(existingAgent, 'id: existing\nname: Existing\naccess: read\n', { mode: 0o644 });
  writeFileSync(marker, 'legacy\n', { mode: 0o644 });
  chmodSync(agentRoot, 0o755);
  chmodSync(existingAgent, 0o644);
  chmodSync(marker, 0o644);
  agents.useRoot(agentRoot);
  assert.equal(agents.list().length, 1);
  assert.equal(permissions(agentRoot), 0o700);
  assert.equal(permissions(existingAgent), 0o600);
  assert.equal(permissions(marker), 0o600);

  const saved = agents.save({
    id: 'private-agent',
    name: 'Private agent',
    description: 'Contains private instructions',
    tags: [],
    provider: null,
    model: null,
    tools: [],
    maxRounds: 2,
    access: 'read',
    prompt: 'Keep this prompt private.',
  });
  assert.equal(permissions(saved.path), 0o600);
  assert.deepEqual(
    readdirSync(agentRoot).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('source and MCP stores migrate userData and replace files atomically at 0600', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'antimatter-private-electron-stores-'));
  encryptionAvailable = false;
  decryptionFails = false;
  selectedStorageBackend = 'unknown';
  t.after(() => {
    encryptionAvailable = false;
    decryptionFails = false;
    selectedStorageBackend = 'unknown';
    rmSync(base, { recursive: true, force: true });
  });
  userData.path = join(base, 'user-data');
  mkdirSync(userData.path, { mode: 0o755 });

  const sourceFile = join(userData.path, 'sources.json');
  const mcpFile = join(userData.path, 'mcp-servers.json');
  writeFileSync(sourceFile, JSON.stringify({ version: 1, sources: [] }), { mode: 0o644 });
  writeFileSync(mcpFile, JSON.stringify({ version: 1, servers: [] }), { mode: 0o644 });
  chmodSync(userData.path, 0o755);
  chmodSync(sourceFile, 0o644);
  chmodSync(mcpFile, 0o644);

  assert.deepEqual(sourceStore.list(), []);
  assert.deepEqual(mcpStore.list(), []);
  assert.equal(permissions(userData.path), 0o700);
  assert.equal(permissions(sourceFile), 0o600);
  assert.equal(permissions(mcpFile), 0o600);

  chmodSync(userData.path, 0o755);
  chmodSync(sourceFile, 0o644);
  const privateSource = sourceStore.save({
    id: 'private-source',
    name: 'Private source',
    apiKey: 'plain-fallback-secret',
    baseUrl: 'http://127.0.0.1:6768/v1',
    models: [
      {
        id: 'declared',
        name: 'Declared',
        architecture: 'qwen3moe',
        quantization: 'Q8_0',
        contextWindow: 131_072,
        vision: false,
        manuallyDeclared: true,
      },
    ],
    supportsStreaming: true,
    kind: 'beholdd',
    protocol: 'openai-chat',
    createdAt: 1,
  });
  assert.equal(sourceStore.find('private-source')?.apiKey, 'plain-fallback-secret');
  const publicSource = sourceStore.publicSource(privateSource);
  assert.equal(publicSource.credentialConfigured, true);
  assert.equal(publicSource.protocol, 'openai-chat');
  assert.equal('apiKey' in publicSource, false);
  assert.deepEqual(publicSource.models[0], {
    id: 'declared',
    name: 'Declared',
    architecture: 'qwen3moe',
    quantization: 'Q8_0',
    contextWindow: 131_072,
    vision: false,
    manuallyDeclared: true,
    deployment: 'local',
  });
  const publicList = sourceStore.listPublic();
  assert.equal(publicList[0]?.credentialConfigured, true);
  assert.equal('apiKey' in publicList[0]!, false);
  assert.doesNotMatch(JSON.stringify(publicList), /plain-fallback-secret/);

  encryptionAvailable = true;
  selectedStorageBackend = 'gnome_libsecret';
  decryptionFails = true;
  const rotated = sourceStore.replaceCredential('private-source', 'rotated-encrypted-secret');
  assert.equal(rotated?.apiKey, 'rotated-encrypted-secret');
  assert.equal(rotated?.id, privateSource.id);
  assert.deepEqual(rotated?.models, privateSource.models);
  decryptionFails = false;
  assert.equal(sourceStore.find('private-source')?.apiKey, 'rotated-encrypted-secret');
  assert.equal(sourceStore.keysAreEncrypted(), true);
  const storedAfterRotation = readFileSync(sourceFile, 'utf8');
  assert.doesNotMatch(storedAfterRotation, /plain-fallback-secret|rotated-encrypted-secret/);
  const rotatedPublic = sourceStore.listPublic();
  assert.equal(rotatedPublic[0]?.credentialConfigured, true);
  assert.doesNotMatch(JSON.stringify(rotatedPublic), /plain-fallback-secret|rotated-encrypted-secret/);

  if (process.platform === 'linux') {
    selectedStorageBackend = 'basic_text';
    assert.equal(sourceStore.keysAreEncrypted(), false, 'basic_text is not reported as OS-keyring encryption');
    assert.equal(
      sourceStore.find('private-source')?.apiKey,
      'rotated-encrypted-secret',
      'legacy cipher blobs remain readable after the stricter gate',
    );
    sourceStore.replaceCredential('private-source', 'basic-text-fallback-secret');
    const basicTextStored = JSON.parse(readFileSync(sourceFile, 'utf8')) as {
      sources: Array<{ id: string; apiKeyCipher?: string; apiKeyPlain?: string }>;
    };
    const basicTextSource = basicTextStored.sources.find((source) => source.id === 'private-source');
    assert.equal(basicTextSource?.apiKeyCipher, undefined);
    assert.equal(basicTextSource?.apiKeyPlain, 'basic-text-fallback-secret');
    assert.equal(sourceStore.find('private-source')?.apiKey, 'basic-text-fallback-secret');

    selectedStorageBackend = 'gnome_libsecret';
    assert.equal(
      sourceStore.keysAreEncrypted(),
      false,
      'a key written through the plaintext fallback is not relabeled when a keyring later appears',
    );
    sourceStore.replaceCredential('private-source', 'reencrypted-secret');
    assert.equal(sourceStore.keysAreEncrypted(), true);
  }

  const legacyBaseUrl =
    'https://legacy-user:legacy-password@example.test/v1?api_key=query-secret#fragment-secret';
  sourceStore.save({
    ...privateSource,
    id: 'legacy-credential-url',
    apiKey: '',
    baseUrl: legacyBaseUrl,
  });
  assert.equal(sourceStore.find('legacy-credential-url')?.baseUrl, legacyBaseUrl);
  const legacyPublic = sourceStore
    .listPublic()
    .find((source) => source.id === 'legacy-credential-url');
  assert.equal(legacyPublic?.baseUrl, 'https://example.test/v1');
  assert.doesNotMatch(
    JSON.stringify(legacyPublic),
    /legacy-user|legacy-password|query-secret|fragment-secret/
  );
  assert.equal(permissions(userData.path), 0o700);
  assert.equal(permissions(sourceFile), 0o600);

  chmodSync(userData.path, 0o755);
  chmodSync(mcpFile, 0o644);
  mcpStore.save({
    id: 'private-mcp',
    name: 'Private MCP',
    command: '/bin/true',
    args: [],
    env: { PRIVATE_TOKEN: 'secret' },
    enabled: false,
    createdAt: 1,
  });
  assert.equal(permissions(userData.path), 0o700);
  assert.equal(permissions(mcpFile), 0o600);
  assert.deepEqual(
    readdirSync(userData.path).filter((name) => name.endsWith('.tmp')),
    []
  );
});
