import assert from 'node:assert/strict';
import test from 'node:test';

import { CREATE_ONLY_TOOL_ARGUMENT } from '../src/api/toolArguments';
import { childEnvironment, connectEnabledServers, readTools, toolArgumentsForTransport } from '../src/main/mcp';

test('create-only execution metadata is sent only to the bundled write tool', () => {
  const args = { path: 'new.txt', content: 'partial\n' };
  assert.deepEqual(toolArgumentsForTransport('antimatter', 'write_file', args, true), {
    ...args,
    [CREATE_ONLY_TOOL_ARGUMENT]: true,
  });
  assert.equal(toolArgumentsForTransport('third-party', 'write_file', args, true), args);
  assert.equal(toolArgumentsForTransport('antimatter', 'read_file', args, true), args);
  assert.equal(toolArgumentsForTransport('antimatter', 'write_file', args, false), args);
});

test('workspace retargeting visits every enabled MCP server, including existing sessions', async () => {
  const calls: Array<{ id: string; workspace: string | undefined }> = [];

  await connectEnabledServers(
    [
      { id: 'already-connected', enabled: true },
      { id: 'new-server', enabled: true },
      { id: 'disabled', enabled: false },
    ],
    '/workspaces/next',
    async (id, workspace) => {
      calls.push({ id, workspace });
    }
  );

  assert.deepEqual(calls, [
    { id: 'already-connected', workspace: '/workspaces/next' },
    { id: 'new-server', workspace: '/workspaces/next' },
  ]);
});

test('tool discovery follows every MCP pagination cursor', async () => {
  const cursors: Array<string | undefined> = [];
  const tools = await readTools({
    async listTools(params?: { cursor?: string }) {
      cursors.push(params?.cursor);
      return params?.cursor === 'page-2'
        ? {
            tools: [{ name: 'write_file', description: 'write', inputSchema: { type: 'object' } }],
          }
        : {
            tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
            nextCursor: 'page-2',
          };
    },
  } as Parameters<typeof readTools>[0]);

  assert.deepEqual(cursors, [undefined, 'page-2']);
  assert.deepEqual(tools.map((tool) => tool.name), ['read_file', 'write_file']);
});

test('tool discovery rejects a server that repeats its pagination cursor', async () => {
  await assert.rejects(
    readTools({
      async listTools() {
        return { tools: [], nextCursor: 'same' };
      },
    } as Parameters<typeof readTools>[0]),
    /repeated cursor "same"/
  );
});

test('third-party MCP children receive only safe and explicitly configured environment values', () => {
  const parent = {
    DISPLAY: ':0',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.socket',
    HTTPS_PROXY: 'http://proxy.test:8080',
    VIRTUAL_ENV: '/workspace/.venv',
    CUDA_VISIBLE_DEVICES: '0',
    CODEX_THREAD_ID: 'host-only-control-state',
    ELECTRON_OVERRIDE_DIST_PATH: '/host/electron',
    UNRELATED_API_KEY: 'do-not-forward',
  };
  const safe = { HOME: '/home/test', PATH: '/usr/bin' };

  const thirdParty = childEnvironment(
    { builtin: false, env: { MCP_TOKEN: 'explicit' } },
    '/workspace',
    parent,
    safe
  );
  assert.equal(thirdParty.UNRELATED_API_KEY, undefined);
  assert.equal(thirdParty.DISPLAY, undefined);
  assert.equal(thirdParty.MCP_TOKEN, 'explicit');
  assert.equal(thirdParty.ANTIMATTER_WORKSPACE, '/workspace');

  const builtin = childEnvironment(
    { builtin: true, env: { ELECTRON_RUN_AS_NODE: '1' } },
    '/workspace',
    parent,
    safe
  );
  assert.equal(builtin.DISPLAY, ':0');
  assert.equal(builtin.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
  assert.equal(builtin.SSH_AUTH_SOCK, '/run/user/1000/ssh-agent.socket');
  assert.equal(builtin.HTTPS_PROXY, 'http://proxy.test:8080');
  assert.equal(builtin.VIRTUAL_ENV, '/workspace/.venv');
  assert.equal(builtin.CUDA_VISIBLE_DEVICES, '0');
  assert.equal(builtin.UNRELATED_API_KEY, 'do-not-forward');
  assert.equal(builtin.CODEX_THREAD_ID, undefined);
  assert.equal(builtin.ELECTRON_OVERRIDE_DIST_PATH, undefined);
  // Explicit launch configuration is applied after sanitizing the inherited parent.
  assert.equal(builtin.ELECTRON_RUN_AS_NODE, '1');
});
