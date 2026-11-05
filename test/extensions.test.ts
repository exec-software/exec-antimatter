import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExtensionRegistry } from '../src/main/extensions/registry';
import { MAX_RESOURCE_BYTES, resourceList } from '../src/main/extensions/files';
import { withSkills, SKILLS_SERVER_ID } from '../src/main/extensions/tools';
import type { ToolRuntime } from '../src/main/toolLoop';
import { PluginPermissionSummary } from '../renderer/src/components/extensions/ExtensionsPage';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-extensions-'));
  const workspace = join(root, 'workspace');
  const personal = join(root, 'personal');
  const plugin = join(root, 'plugin');
  const storePath = join(root, 'state', 'plugins.json');
  mkdirSync(workspace); mkdirSync(personal); mkdirSync(plugin);
  const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  const skill = (root: string, name: string) => write(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: Guidance for ${name}.\n---\n\n# ${name}\nRead references/details.md only as needed.\n`);
  const registry = () => new ExtensionRegistry({ storePath, personalSkillsRoot: personal });
  const manifest = (value: Record<string, unknown> = {}) => write(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'Sample plugin', skills: './skills/', ...value }));
  return { root, workspace, personal, plugin, storePath, write, skill, registry, manifest, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('an empty registry is inert and project/personal skills are discovered progressively', () => {
  const f = fixture();
  try {
    const registry = f.registry();
    assert.deepEqual(registry.catalog(f.workspace).skills, []);
    assert.deepEqual(registry.mcpServers(), []);
    assert.equal(registry.promptMetadata(f.workspace), null);
    const projectSkill = join(f.workspace, '.agents', 'skills', 'testing');
    f.skill(projectSkill, 'testing'); f.write(join(projectSkill, 'references', 'details.md'), 'RESOURCE_BODY_ONLY_ON_DEMAND');
    f.skill(join(f.personal, 'notes'), 'notes');
    const catalog = registry.catalog(f.workspace);
    assert.deepEqual(catalog.skills.map((skill) => skill.source), ['project', 'personal']);
    const prompt = registry.promptMetadata(f.workspace)!;
    assert.match(prompt, /Guidance for testing/);
    assert.doesNotMatch(prompt, /Read references\/details.md|RESOURCE_BODY_ONLY_ON_DEMAND/);
    const document = registry.readSkill(f.workspace, catalog.skills[0].id);
    assert.match(document.content, /Read references\/details.md/);
    assert.deepEqual(document.resources, ['references/details.md', 'SKILL.md'].sort());
    assert.equal(registry.readSkill(f.workspace, catalog.skills[0].id, 'references/details.md').content, 'RESOURCE_BODY_ONLY_ON_DEMAND');
    assert.equal(existsSync(f.storePath), false, 'discovery creates no registry or processes');
  } finally { f.close(); }
});

test('plugin import is disabled and contains no secret env values; enable requires exact reviewed fingerprint', () => {
  const f = fixture();
  try {
    f.skill(join(f.plugin, 'skills', 'sample'), 'sample'); f.manifest({ hooks: './hooks.json' });
    f.write(join(f.plugin, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node', args: ['${PLUGIN_ROOT}/server.js'], env: { API_KEY: 'VERY_PRIVATE_VALUE' } } } }));
    const registry = f.registry();
    const imported = registry.importPlugin(f.plugin);
    assert.equal(imported.enabled, false);
    assert.deepEqual(registry.mcpServers(), []);
    assert.equal(registry.catalog(f.workspace).skills[0].enabled, false);
    assert.throws(() => registry.setPluginEnabled(imported.id, true), /review/i);
    assert.throws(() => registry.setPluginEnabled(imported.id, true, 'wrong'), /changed/);
    const reviewed = registry.catalog(f.workspace).plugins[0];
    assert.deepEqual(reviewed.servers[0].envNames, ['API_KEY']);
    assert.doesNotMatch(JSON.stringify(reviewed), /VERY_PRIVATE_VALUE/);
    assert.doesNotMatch(readFileSync(f.storePath, 'utf8'), /VERY_PRIVATE_VALUE/);
    const markup = renderToStaticMarkup(createElement(PluginPermissionSummary, { plugin: reviewed }));
    assert.match(markup, /not sandboxed/); assert.match(markup, /API_KEY/); assert.doesNotMatch(markup, /VERY_PRIVATE_VALUE/);
    registry.setPluginEnabled(imported.id, true, reviewed.fingerprint);
    const servers = registry.mcpServers();
    assert.equal(servers.length, 1);
    assert.match(servers[0].id, /^plugin\.plugin-[a-f\d]{24}\.local$/);
    assert.equal(servers[0].env.API_KEY, 'VERY_PRIVATE_VALUE');
    assert.equal(servers[0].args[0], join(f.plugin, 'server.js'));
    assert.equal(servers[0].fingerprint, reviewed.fingerprint);
    assert.equal(f.registry().mcpServers().length, 1, 'approval survives restart only with matching declarations');
    assert.match(reviewed.warnings[0], /Hooks are not supported/);
  } finally { f.close(); }
});

test('changed manifests, config removal, and invalid config disable a previously approved plugin', () => {
  for (const tamper of ['manifest', 'remove-config', 'invalid-config']) {
    const f = fixture();
    try {
      f.skill(join(f.plugin, 'skills', 'sample'), 'sample'); f.manifest();
      f.write(join(f.plugin, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node', args: [] } } }));
      const registry = f.registry(); const imported = registry.importPlugin(f.plugin);
      registry.setPluginEnabled(imported.id, true, imported.fingerprint);
      if (tamper === 'manifest') f.manifest({ description: 'changed' });
      if (tamper === 'remove-config') rmSync(join(f.plugin, '.mcp.json'));
      if (tamper === 'invalid-config') f.write(join(f.plugin, '.mcp.json'), '{invalid secret-value');
      assert.deepEqual(registry.mcpServers(), [], tamper);
      assert.equal(registry.catalog(null).plugins[0].enabled, false, tamper);
      assert.equal(f.registry().mcpServers().length, 0, 'disabled state persisted');
      assert.doesNotMatch(JSON.stringify(registry.catalog(null)), /secret-value/);
    } finally { f.close(); }
  }
});

test('reads reject traversal, absolute paths, symlink files/directories, binary files, and oversized resources', () => {
  const f = fixture();
  try {
    const root = join(f.personal, 'safe'); f.skill(root, 'safe');
    f.write(join(f.root, 'outside.txt'), 'outside-secret');
    symlinkSync(join(f.root, 'outside.txt'), join(root, 'link.txt'));
    symlinkSync(f.root, join(root, 'linked-directory'));
    f.write(join(root, 'huge.txt'), 'x'.repeat(MAX_RESOURCE_BYTES + 1));
    f.write(join(root, 'binary.txt'), 'binary\0content');
    const registry = f.registry(); const id = registry.catalog(null).skills[0].id;
    for (const path of ['../outside.txt', join(f.root, 'outside.txt'), 'link.txt', 'linked-directory/outside.txt', 'huge.txt', 'binary.txt', '..\\outside.txt']) {
      assert.throws(() => registry.readSkill(null, id, path), /safely read/, path);
    }
    const listing = registry.readSkill(null, id).resources;
    assert.ok(!listing.some((path) => path.includes('link')));
  } finally { f.close(); }
});

test('symlink discovery and plugin resource escape never expose outside skills', () => {
  const f = fixture();
  try {
    const outside = join(f.root, 'outside'); f.skill(outside, 'outside');
    symlinkSync(outside, join(f.personal, 'aliased'));
    assert.deepEqual(f.registry().catalog(null).skills, []);
    f.manifest({ skills: '../outside' });
    assert.throws(() => f.registry().importPlugin(f.plugin), /could not be read|resource/i);
    f.manifest({ skills: './aliased' }); symlinkSync(outside, join(f.plugin, 'aliased'));
    assert.throws(() => f.registry().importPlugin(f.plugin), /could not be read/);
  } finally { f.close(); }
});

test('portable root manifests, skill arrays, and bounded resource lists work without running scripts', () => {
  const f = fixture();
  try {
    const skillRoot = join(f.plugin, 'one'); f.skill(skillRoot, 'one');
    f.write(join(f.plugin, 'plugin.json'), JSON.stringify({ name: 'Portable', skills: ['one'] }));
    f.write(join(skillRoot, 'scripts', 'run.sh'), 'touch SHOULD_NEVER_EXIST');
    for (let index = 0; index < 270; index++) f.write(join(skillRoot, 'references', `${index}.md`), String(index));
    const registry = f.registry(); const imported = registry.importPlugin(f.plugin);
    registry.setPluginEnabled(imported.id, true, imported.fingerprint);
    const listing = resourceList(skillRoot);
    assert.equal(listing.resources.length, 256);
    assert.equal(listing.truncated, true);
    assert.equal(existsSync(join(f.plugin, 'SHOULD_NEVER_EXIST')), false);
  } finally { f.close(); }
});

test('activation errors cannot expose configured secrets and invalid registry is never overwritten', () => {
  const f = fixture();
  try {
    f.skill(join(f.plugin, 'skills', 'sample'), 'sample'); f.manifest();
    const registry = f.registry(); const imported = registry.importPlugin(f.plugin);
    registry.setActivationError(imported.id, 'Connection failed: PASSWORD=secret');
    assert.doesNotMatch(JSON.stringify(registry.catalog(null)), /PASSWORD=secret/);
    assert.match(registry.catalog(null).plugins[0].activationError!, /could not connect/);
    f.write(f.storePath, '{unreadable');
    const broken = f.registry();
    assert.ok(broken.catalog(null).errors.length);
    assert.throws(() => broken.importPlugin(f.plugin), /registry/);
    assert.equal(readFileSync(f.storePath, 'utf8'), '{unreadable');
  } finally { f.close(); }
});

test('skill runtime is read-only, bound to the run workspace, and refuses disabled plugin skills', async () => {
  const f = fixture();
  try {
    const root = join(f.workspace, '.agents', 'skills', 'project'); f.skill(root, 'project');
    const registry = f.registry(); const calls: string[] = [];
    const base: ToolRuntime = { enabledTools: () => [], callTool: async (server, tool) => { calls.push(`${server}/${tool}`); return { ok: true, attempted: true, text: 'delegated' }; } };
    const runtime = withSkills(base, registry, f.workspace);
    assert.equal(runtime.enabledTools()[0].serverId, SKILLS_SERVER_ID);
    const skill = registry.catalog(f.workspace).skills[0];
    assert.equal((await runtime.callTool(SKILLS_SERVER_ID, 'read_skill', { id: skill.id })).ok, true);
    assert.equal((await runtime.callTool(SKILLS_SERVER_ID, 'execute_skill', { id: skill.id })).attempted, false);
    assert.equal((await runtime.callTool(SKILLS_SERVER_ID, 'read_skill', { id: skill.id, resource: '../escape' })).ok, false);
    assert.equal((await withSkills(base, registry, null).callTool(SKILLS_SERVER_ID, 'read_skill', { id: skill.id })).ok, false);
    await runtime.callTool('other', 'tool', {}); assert.deepEqual(calls, ['other/tool']);
    f.skill(join(f.plugin, 'skills', 'sample'), 'sample'); f.manifest(); const imported = registry.importPlugin(f.plugin);
    const pluginSkill = registry.catalog(f.workspace).skills.find((entry) => entry.pluginId === imported.id)!;
    assert.equal((await runtime.callTool(SKILLS_SERVER_ID, 'read_skill', { id: pluginSkill.id })).ok, false);
  } finally { f.close(); }
});
